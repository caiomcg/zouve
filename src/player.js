/**
 * One voice channel's player: the bot in that channel's room, its queue, and
 * the song playing. The audio goes yt-dlp → ffmpeg → 48 kHz stereo PCM → a
 * LiveKit audio source published as the bot's microphone, so everyone hears
 * it as they hear someone in voice, at the volume they chose for it.
 */

import { spawn } from 'node:child_process';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

import { Queue } from './queue.js';
import { streamAudio } from './ytdlp.js';

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
/** 20 ms frames: what WebRTC sends at a time. */
export const FRAME_SAMPLES = SAMPLE_RATE / 50;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
/** How long the bot stays after the queue runs out, in case someone queues more. */
const IDLE_MS = 90_000;

/** Joins a room as the bot and publishes an audio source as its microphone. */
export async function connectRoom(url, token) {
  const room = new Room();
  await room.connect(url, token, { autoSubscribe: false, dynacast: false });
  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('zouve', source);
  await room.localParticipant.publishTrack(
    track,
    new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
      // Music, not speech: no silence suppression, a bitrate for music.
      dtx: false,
      audioEncoding: { maxBitrate: 128_000n },
    }),
  );
  return {
    source,
    onClose(callback) {
      room.on(RoomEvent.Disconnected, callback);
    },
    async close() {
      await source.close().catch(() => {});
      await room.disconnect().catch(() => {});
    },
  };
}

/** Decodes whatever yt-dlp sends to raw PCM, as fast as it is read. */
export function decode(input) {
  const ffmpeg = spawn(
    process.env.FFMPEG_BIN ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ac',
      String(CHANNELS),
      '-ar',
      String(SAMPLE_RATE),
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  input.pipe(ffmpeg.stdin);
  // Killing either end breaks the pipe; that is how a song is stopped.
  ffmpeg.stdin.on('error', () => {});
  input.on('error', () => {});
  return ffmpeg;
}

/** Scales 16-bit samples in place by `gain`, clipping. */
export function applyGain(samples, gain) {
  if (gain === 1) return samples;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.round(samples[i] * gain);
    samples[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return samples;
}

/**
 * @param {object} options
 * @param {string} options.channel the voice channel's id
 * @param {() => Promise<{ token: string, wsUrl: string }>} options.token a fresh voice token
 * @param {string | null} options.livekitUrl where LiveKit is from inside the container
 * @param {ReturnType<import('./resolver.js').createResolver>} options.resolver
 * @param {() => number} options.volume 0 to 100, read for every frame
 * @param {(event: string, track: object, detail?: string) => void} options.onEvent
 */
export function createPlayer({
  channel,
  token,
  livekitUrl,
  resolver,
  volume,
  maxQueue = 100,
  onEvent,
  onIdle,
  connect = connectRoom,
  stream = streamAudio,
  logger = console,
}) {
  const queue = new Queue({ max: maxQueue });
  let connection = null;
  let running = false;
  let paused = false;
  let resume = null;
  /** The song playing: its processes, and how to stop it. */
  let playing = null;
  let idleTimer = null;

  async function ensureConnected() {
    if (connection) return connection;
    const issued = await token();
    connection = await connect(livekitUrl || issued.wsUrl, issued.token);
    connection.onClose?.(() => {
      connection = null;
    });
    return connection;
  }

  async function leave() {
    clearTimeout(idleTimer);
    const closing = connection;
    connection = null;
    await closing?.close();
    onIdle?.();
  }

  /** Plays one track to its end, or until it is skipped. Resolves either way. */
  async function playOne(track) {
    const { source } = await ensureConnected();
    const ytdlp = stream(track.url);
    const ffmpeg = decode(ytdlp.stdout);
    let stopped = false;
    let errors = '';
    ytdlp.stderr.on('data', (d) => (errors = `${errors}${d}`.slice(-2000)));
    playing = {
      stop() {
        stopped = true;
        ytdlp.kill('SIGKILL');
        ffmpeg.kill('SIGKILL');
        resume?.();
      },
    };

    let pending = Buffer.alloc(0);
    let frames = 0;
    try {
      for await (const chunk of ffmpeg.stdout) {
        if (stopped) break;
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= FRAME_BYTES) {
          if (paused) await new Promise((r) => (resume = r));
          if (stopped) break;
          // Copied out: an Int16Array needs aligned memory, and the frame keeps it.
          const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
          Buffer.from(samples.buffer).set(pending.subarray(0, FRAME_BYTES));
          pending = pending.subarray(FRAME_BYTES);
          applyGain(samples, Math.max(0, Math.min(100, volume())) / 100);
          // Waits while LiveKit's queue is full: this is what paces the song.
          await source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
          frames += 1;
        }
      }
    } catch (err) {
      if (!stopped) logger.warn(`[player] ${channel}: ${err.message}`);
    } finally {
      playing = null;
      ytdlp.kill('SIGKILL');
      ffmpeg.kill('SIGKILL');
    }
    if (!stopped && frames === 0) {
      onEvent('failed', track, errors.trim().split('\n').pop() || 'no audio');
    }
  }

  async function loop() {
    if (running) return;
    running = true;
    clearTimeout(idleTimer);
    try {
      for (;;) {
        const next = queue.next();
        if (!next) break;
        const track = await resolver.ready(next).catch(() => null);
        if (!track) {
          onEvent('missing', next);
          continue;
        }
        queue.current = track;
        try {
          await ensureConnected();
        } catch (err) {
          logger.error(`[player] ${channel}: could not join: ${err.message}`);
          onEvent('unjoinable', track, err.message);
          queue.clear();
          break;
        }
        onEvent('playing', track);
        await playOne(track);
      }
    } finally {
      running = false;
      queue.current = null;
      paused = false;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void leave(), IDLE_MS);
      idleTimer.unref?.();
    }
  }

  return {
    channel,
    queue,
    get paused() {
      return paused;
    },
    get current() {
      return queue.current;
    },

    /** Queues tracks and starts playing if nothing is. Returns how many were queued. */
    enqueue(tracks) {
      const added = queue.add(tracks);
      void loop();
      return added;
    },

    /** Pauses, or resumes when paused. Returns whether it is paused now. */
    togglePause() {
      if (!queue.current) return false;
      paused = !paused;
      if (!paused) {
        resume?.();
        resume = null;
      }
      return paused;
    },

    resume() {
      if (!paused) return false;
      paused = false;
      resume?.();
      resume = null;
      return true;
    },

    /** Stops the song; the next one starts. */
    skip() {
      const was = queue.current;
      paused = false;
      playing?.stop();
      return was;
    },

    shuffle: () => queue.shuffle(),

    /** Empties the queue, stops the song and leaves the channel. */
    async stop() {
      queue.clear();
      paused = false;
      playing?.stop();
      await leave();
    },
  };
}

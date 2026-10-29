/**
 * The player: the bot in one voice channel's room, its queue, and the song
 * playing. Audio is yt-dlp downloading → ffmpeg → 48 kHz stereo PCM → a
 * LiveKit audio source published as the bot's microphone, so everyone hears
 * it as they hear someone in voice, at the volume they chose for it.
 *
 * yt-dlp downloads from the read of the song's page made when it was found,
 * so it starts in a few seconds; while a song plays, the next one is found
 * and read, so it starts as soon as this one ends. Should a read have gone
 * stale, the song is downloaded from its page, which reads it again first.
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
import { fresh, streamAudio } from './ytdlp.js';

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
/** 20 ms frames: what WebRTC sends at a time. */
export const FRAME_SAMPLES = SAMPLE_RATE / 50;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
/** How long the bot stays after the queue runs out, in case someone queues more. */
const IDLE_MS = 90_000;

const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg';
const TO_PCM = ['-f', 's16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1'];

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

/** Decodes what yt-dlp downloads of a track: from its read when it has one, else its page. */
export function decode(track, options) {
  const ytdlp = streamAudio(track, options);
  const ffmpeg = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...TO_PCM], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  ytdlp.stdout.pipe(ffmpeg.stdin);
  // Killing either end breaks the pipe; that is how a song is stopped.
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.on('error', () => {});
  return { ffmpeg, ytdlp };
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
 * @param {(url: string) => Promise<object>} options.lookup reads a link in full, to download from
 * @param {() => number} options.volume 0 to 100, read for every frame
 * @param {(event: string, track?: object, detail?: string) => void} options.onEvent
 */
export function createPlayer({
  channel,
  token,
  livekitUrl,
  resolver,
  lookup,
  volume,
  maxQueue = 100,
  onEvent,
  onIdle,
  connect = connectRoom,
  decodeTrack = decode,
  logger = console,
}) {
  const queue = new Queue({ max: maxQueue });
  let connection = null;
  let leaving = false;
  let running = false;
  let paused = false;
  let resume = null;
  /** The song playing: how to stop it. */
  let playing = null;
  let idleTimer = null;

  async function ensureConnected() {
    if (connection) return connection;
    const issued = await token();
    const joined = await connect(livekitUrl || issued.wsUrl, issued.token);
    connection = joined;
    // Taken out of the room by someone else (an admin, the server): it stops
    // here and does not come back with the next song.
    joined.onClose?.(() => {
      if (connection !== joined) return;
      connection = null;
      if (leaving) return;
      queue.clear();
      paused = false;
      playing?.stop();
      onEvent('removed');
      void leave();
    });
    return joined;
  }

  async function leave() {
    clearTimeout(idleTimer);
    leaving = true;
    const closing = connection;
    connection = null;
    await closing?.close();
    onIdle?.();
  }

  /** A track found and its address read, ready to start at once; null when it cannot be. */
  async function prepare(track) {
    const found = await resolver.ready(track).catch(() => null);
    if (!found) return null;
    if (fresh(found)) return found;
    try {
      const read = await lookup(found.url);
      return { ...found, stream: read.stream, title: found.title || read.title };
    } catch (err) {
      logger.warn(`[player] could not read ${found.url}: ${err.message}`);
      // No address: the slow way will try when its turn comes.
      return found;
    }
  }

  /** Readies the next song in the background, in place in the queue. */
  function prefetch() {
    const next = queue.upcoming[0];
    if (!next || next.preparing || fresh(next)) return;
    next.preparing = prepare(next).then((ready) => {
      const at = queue.upcoming.indexOf(next);
      if (ready && at !== -1) queue.upcoming[at] = ready;
      return ready;
    });
  }

  /** Feeds one decoder's PCM to LiveKit until it ends or is stopped. Returns frames sent. */
  async function pump(decoder, source, state) {
    let pending = Buffer.alloc(0);
    let frames = 0;
    for await (const chunk of decoder.ffmpeg.stdout) {
      if (state.stopped) break;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= FRAME_BYTES) {
        if (paused) await new Promise((r) => (resume = r));
        if (state.stopped) break;
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
    return frames;
  }

  /** Plays one track to its end, or until it is skipped. Resolves either way. */
  async function playOne(track) {
    const { source } = await ensureConnected();
    const state = { stopped: false };
    let decoder = null;
    let errors = '';
    const kill = () => {
      decoder?.ffmpeg.kill('SIGKILL');
      decoder?.ytdlp?.kill('SIGKILL');
    };
    playing = {
      stop() {
        state.stopped = true;
        kill();
        resume?.();
      },
    };

    const attempts = [
      ...(track.stream ? [() => decodeTrack(track)] : []),
      () => decodeTrack({ ...track, stream: null }),
      // Last, yt-dlp's own clients: slower, but what works when ours do not.
      () => decodeTrack({ ...track, stream: null }, { plain: true }),
    ];
    let frames = 0;
    for (const attempt of attempts) {
      if (state.stopped) break;
      decoder = attempt();
      decoder.ffmpeg.stderr.on('data', (d) => (errors = `${errors}${d}`.slice(-2000)));
      decoder.ytdlp?.stderr.on('data', (d) => (errors = `${errors}${d}`.slice(-2000)));
      try {
        frames = await pump(decoder, source, state);
      } catch (err) {
        if (!state.stopped) logger.warn(`[player] ${channel}: ${err.message}`);
      } finally {
        kill();
      }
      // It played: done. Nothing came out: try the next way.
      if (frames > 0) break;
    }
    playing = null;
    if (!state.stopped && frames === 0) {
      onEvent('failed', track, errors.trim().split('\n').pop() || 'no audio');
    }
  }

  async function loop() {
    if (running) return;
    running = true;
    leaving = false;
    clearTimeout(idleTimer);
    try {
      for (;;) {
        const next = queue.next();
        if (!next) break;
        // Readied while the last one played; else found now, and downloaded
        // straight from its page: one read, not one to find it and one to play.
        const track = next.preparing
          ? await next.preparing
          : await resolver.ready(next).catch(() => null);
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
        prefetch();
        await playOne(track);
      }
    } finally {
      running = false;
      queue.current = null;
      paused = false;
      clearTimeout(idleTimer);
      if (!leaving) {
        idleTimer = setTimeout(() => void leave(), IDLE_MS);
        idleTimer.unref?.();
      }
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
    /** Playing, or with songs waiting: someone is using it. */
    get busy() {
      return Boolean(queue.current) || queue.size > 0;
    },

    /** Queues tracks and starts playing if nothing is. Returns how many were queued. */
    enqueue(tracks) {
      const added = queue.add(tracks);
      if (running) prefetch();
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

    shuffle() {
      const count = queue.shuffle();
      prefetch();
      return count;
    },

    /** Takes songs out of what is to come; see Queue.remove. Returns them. */
    remove(from, to) {
      const removed = queue.remove(from, to);
      prefetch();
      return removed;
    },

    /** Empties the queue, stops the song and leaves the channel. */
    async stop() {
      queue.clear();
      paused = false;
      playing?.stop();
      await leave();
    },
  };
}

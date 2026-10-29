/**
 * yt-dlp, for searching YouTube Music and YouTube, reading a link, and
 * finding where a song's audio is. The binary is in the image; tests pass `run`.
 *
 * Reading a YouTube page is the slow part, about five seconds each on Zoia's
 * one CPU, so it is done once per song: the same read gives the song's
 * details and what yt-dlp needs to download it, which is kept and handed back
 * to yt-dlp to play from (`--load-info-json`) instead of reading the page
 * again. YouTube refuses its audio's address to anyone but yt-dlp, so ffmpeg
 * cannot fetch it itself. Searches are flat (titles only, two seconds), and
 * results are read in full one at a time, only until one is good enough.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.YTDLP_BIN ?? 'yt-dlp';

/** Common flags: quiet, no config of anyone's, caches where the image may write. */
const BASE = ['--ignore-config', '--no-warnings', '--quiet', '--cache-dir', '/tmp/yt-dlp'];

/** How long a read is trusted to download from; YouTube's addresses last about six hours. */
export const STREAM_TTL_MS = 60 * 60_000;

/** Runs yt-dlp and gives its output, or throws with what it said. */
export function runYtdlp(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, [...BASE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
    });
  });
}

/**
 * One entry of yt-dlp's JSON, as a candidate. A full read (`--dump-single-json`
 * with a format chosen) also keeps that JSON, to download from without
 * reading the page again.
 */
function candidate(entry, source, raw = null, now = Date.now()) {
  const id = entry.id;
  const page =
    entry.webpage_url ??
    (entry.url?.startsWith('http') && !entry.format_id
      ? entry.url
      : `https://www.youtube.com/watch?v=${id}`);
  const stream = entry.format_id && raw ? { info: raw, at: now } : null;
  return {
    url: page,
    title: entry.track ?? entry.title ?? '',
    artist: entry.artists?.join(', ') ?? entry.artist ?? entry.uploader ?? entry.channel ?? '',
    durationSec: entry.duration ? Math.round(entry.duration) : null,
    source,
    // Read in full: its artist and length are known, not guessed from a title.
    full: Boolean(entry.format_id),
    ...(stream ? { stream } : {}),
  };
}

/** Whether a track's audio address may still be used. */
export const fresh = (track, now = Date.now()) =>
  Boolean(track?.stream && now - track.stream.at < STREAM_TTL_MS);

export function createYtdlp({ run = runYtdlp } = {}) {
  const list = async (args, source) => {
    const data = JSON.parse(await run(['--flat-playlist', '--dump-single-json', ...args]));
    return (data.entries ?? []).filter((e) => e?.id).map((e) => candidate(e, source));
  };

  /** One link read in full: its details and its best audio's address. */
  const info = async (url) => {
    const raw = await run(['--no-playlist', '-f', 'bestaudio/best', '--dump-single-json', url]);
    return candidate(
      JSON.parse(raw),
      url.includes('music.youtube.com') ? 'ytmusic' : 'youtube',
      raw,
    );
  };

  return {
    /** YouTube Music's songs for a query, titles only: the official recordings. */
    searchMusic: (query, limit = 3) =>
      list(
        [
          '--playlist-end',
          String(limit),
          `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`,
        ],
        'ytmusic',
      ),

    /** YouTube's videos for a query, with their channel and length. */
    searchVideos: (query, limit = 5) => list([`ytsearch${limit}:${query}`], 'youtube'),

    /** A YouTube playlist's entries. */
    playlist: (url, limit = 50) => list(['--playlist-end', String(limit), url], 'youtube'),

    info,
  };
}

/**
 * A song's best audio, as yt-dlp downloads it, on stdout. From a read kept
 * in the track when there is one, which starts in a few seconds; from the
 * page otherwise, which reads it again first.
 */
export function streamAudio(track) {
  const output = ['-f', 'bestaudio/best', '--no-part', '-o', '-'];
  if (!track.stream?.info) {
    return spawn(BIN, [...BASE, '--no-playlist', ...output, track.url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  // Only for yt-dlp to read, and gone when it is done.
  const file = join(tmpdir(), `zouve-${randomUUID()}.json`);
  writeFileSync(file, track.stream.info, { mode: 0o600 });
  const child = spawn(BIN, [...BASE, '--load-info-json', file, ...output], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('close', () => rmSync(file, { force: true }));
  return child;
}

/**
 * yt-dlp, for searching YouTube Music and YouTube, reading a link, and
 * streaming a song's audio. The binary is in the image; tests pass `run`.
 */

import { spawn } from 'node:child_process';

const BIN = process.env.YTDLP_BIN ?? 'yt-dlp';

/** Common flags: quiet, no config of anyone's, caches where the image may write. */
const BASE = ['--ignore-config', '--no-warnings', '--quiet', '--cache-dir', '/tmp/yt-dlp'];

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

/** One entry of yt-dlp's JSON, as a candidate. */
function candidate(entry, source) {
  const id = entry.id;
  const url =
    entry.webpage_url ??
    (entry.url?.startsWith('http') ? entry.url : `https://www.youtube.com/watch?v=${id}`);
  return {
    url,
    title: entry.track ?? entry.title ?? '',
    artist: entry.artists?.join(', ') ?? entry.artist ?? entry.uploader ?? entry.channel ?? '',
    durationSec: entry.duration ? Math.round(entry.duration) : null,
    source,
  };
}

export function createYtdlp({ run = runYtdlp } = {}) {
  const list = async (args, source) => {
    const data = JSON.parse(await run(['--flat-playlist', '--dump-single-json', ...args]));
    return (data.entries ?? []).filter((e) => e?.id).map((e) => candidate(e, source));
  };

  const info = async (url) => {
    const entry = JSON.parse(await run(['--no-playlist', '--dump-single-json', url]));
    return candidate(entry, url.includes('music.youtube.com') ? 'ytmusic' : 'youtube');
  };

  return {
    /**
     * YouTube Music's songs for a query: the official recordings. Its search
     * gives titles alone, so the first few are looked up in full, at once,
     * for their artist and length; one that fails keeps its title.
     */
    async searchMusic(query, limit = 3) {
      const found = await list(
        [
          '--playlist-end',
          String(limit),
          `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`,
        ],
        'ytmusic',
      );
      return Promise.all(found.map((c) => info(c.url).catch(() => c)));
    },

    /** YouTube's videos for a query. */
    searchVideos: (query, limit = 5) => list([`ytsearch${limit}:${query}`], 'youtube'),

    /** A YouTube playlist's entries. */
    playlist: (url, limit = 50) => list(['--playlist-end', String(limit), url], 'youtube'),

    /** What one YouTube link is. */
    info,
  };
}

/**
 * The best audio of a link, as it downloads, on stdout. The caller decodes it
 * and kills it to stop.
 */
export function streamAudio(url) {
  return spawn(
    BIN,
    [...BASE, '-f', 'bestaudio/best', '--no-playlist', '--no-part', '-o', '-', url],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

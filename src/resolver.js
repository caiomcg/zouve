/**
 * From what was typed after !play to what can be played.
 *
 * - A YouTube or YouTube Music link plays as it is; a playlist, each of its videos.
 * - A Spotify, Apple Music or Deezer link is read for its song, or songs, and each
 *   is found on YouTube Music, by ISRC first, then by artist and title, then on
 *   YouTube: whichever answers first with a good enough match.
 * - Any other link is tried as it is (yt-dlp reads many sites); failing that, refused.
 * - Words are searched on YouTube Music, then YouTube, and the best match is kept.
 *
 * A track found from a list is only looked up when its turn comes, so a
 * fifty-song playlist starts playing at once.
 *
 * @typedef {{ title: string, artist: string, durationSec: number | null, isrc?: string | null,
 *   url: string | null, source: string }} Track
 */

import { classify, isUrl } from './links.js';
import { songsOf } from './metadata.js';
import { bestMatch, score } from './match.js';

/** How many of a search's results may be read in full, one at a time. */
const READ_AT_MOST = 3;

export class NotFound extends Error {}

/** Every search failed, rather than found nothing: something is broken, not missing. */
export class SearchFailed extends Error {}

/**
 * @param {object} options
 * @param {() => object} options.spotify the Spotify client as the settings are now
 */
export function createResolver({ ytdlp, spotify, deezer, fetchImpl = fetch, logger = console }) {
  /**
   * YouTube Music's results, in its own order, read in full one at a time
   * (its search gives titles alone), stopping at the first that is `good`:
   * each read is seconds, so the usual case is one. The best read is kept
   * when none is good, if it is at least `floor`.
   */
  async function choose(results, wanted, { good, floor }) {
    let best = null;
    let bestScore = -Infinity;
    for (const result of results.slice(0, READ_AT_MOST)) {
      const read = result.full ? result : await ytdlp.info(result.url).catch(() => result);
      const s = score(read, wanted);
      if (s >= good) return read;
      if (s > bestScore) {
        best = read;
        bestScore = s;
      }
    }
    return bestScore >= floor ? best : null;
  }

  /** Every search we may try for a song, in order, each failing on its own. */
  async function findSong(song) {
    // Title, artist and a length within seconds: it is the recording.
    const good = 7;
    const attempts = [];
    if (song.isrc) {
      attempts.push(async () =>
        choose(await ytdlp.searchMusic(song.isrc), song, { good, floor: 3 }),
      );
    }
    const named = song.artist ? `${song.artist} ${song.title}` : song.title;
    attempts.push(async () => choose(await ytdlp.searchMusic(named), song, { good, floor: 3 }));
    // Videos come with their channel and length: no reading needed to judge them.
    attempts.push(async () =>
      bestMatch(
        await ytdlp.searchVideos(song.artist ? `${song.artist} - ${song.title}` : named),
        song,
      ),
    );
    for (const attempt of attempts) {
      try {
        const found = await attempt();
        if (found) return found;
      } catch (err) {
        logger.warn(`[resolve] a search failed, trying the next: ${err.message}`);
      }
    }
    return null;
  }

  /** Words, as someone types them: "artist song" or just "song". */
  async function search(text) {
    const wanted = { title: text, artist: '', durationSec: null };
    const errors = [];
    let music = null;
    try {
      music = await choose(await ytdlp.searchMusic(text), wanted, { good: 4, floor: 1.5 });
      // A good enough song from YouTube Music needs no video search.
      if (music && score(music, wanted) >= 4) return music;
    } catch (err) {
      logger.warn(`[resolve] a search failed: ${err.message}`);
      errors.push(err.message);
    }
    let videos = [];
    try {
      videos = await ytdlp.searchVideos(text);
    } catch (err) {
      logger.warn(`[resolve] a search failed: ${err.message}`);
      errors.push(err.message);
    }
    if (errors.length === 2) throw new SearchFailed(errors.at(-1));
    return bestMatch([...(music ? [music] : []), ...videos], wanted, { threshold: 1.5 });
  }

  const asTrack = (c) => ({ ...c });
  const pending = (song) => ({ ...song, url: null, source: 'pending' });

  return {
    /**
     * The tracks `input` is, the first one ready to play.
     * @returns {Promise<Track[]>}
     */
    async resolve(input) {
      const text = input.trim();
      if (!isUrl(text)) {
        const found = await search(text);
        if (!found) throw new NotFound(text);
        return [asTrack(found)];
      }

      const link = classify(text);
      if (link.service === 'youtube') {
        if (link.kind === 'playlist') {
          const entries = await ytdlp.playlist(text);
          if (entries.length === 0) throw new NotFound(text);
          return entries.map(asTrack);
        }
        return [asTrack(await ytdlp.info(text))];
      }

      let songs;
      try {
        songs = await songsOf(text, { spotify: spotify(), deezer, fetchImpl });
      } catch (err) {
        logger.warn(`[resolve] could not read ${link.service}: ${err.message}`);
        throw new NotFound(text);
      }
      if (songs) {
        if (songs.length === 0) throw new NotFound(text);
        const first = await findSong(songs[0]);
        if (!first) throw new NotFound(`${songs[0].artist} ${songs[0].title}`);
        return [asTrack(first), ...songs.slice(1).map(pending)];
      }

      // Somewhere else: yt-dlp may know it (SoundCloud, Bandcamp, …).
      try {
        return [asTrack(await ytdlp.info(text))];
      } catch {
        throw new NotFound(text);
      }
    },

    /** Looks a pending track up, when its turn comes; null if it cannot be found. */
    async ready(track) {
      if (track.url) return track;
      const found = await findSong(track);
      return found ? asTrack(found) : null;
    },
  };
}

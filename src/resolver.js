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
import { bestMatch } from './match.js';

export class NotFound extends Error {}

/**
 * @param {object} options
 * @param {() => object} options.spotify the Spotify client as the settings are now
 */
export function createResolver({ ytdlp, spotify, deezer, fetchImpl = fetch, logger = console }) {
  /** Every search we may try for a song, in order, each failing on its own. */
  async function findSong(song) {
    const attempts = [];
    if (song.isrc) attempts.push(() => ytdlp.searchMusic(song.isrc));
    const named = song.artist ? `${song.artist} ${song.title}` : song.title;
    attempts.push(() => ytdlp.searchMusic(named));
    attempts.push(() => ytdlp.searchVideos(song.artist ? `${song.artist} - ${song.title}` : named));
    for (const attempt of attempts) {
      try {
        const found = bestMatch(await attempt(), song);
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
    const candidates = [];
    for (const attempt of [() => ytdlp.searchMusic(text), () => ytdlp.searchVideos(text)]) {
      try {
        candidates.push(...(await attempt()));
      } catch (err) {
        logger.warn(`[resolve] a search failed: ${err.message}`);
      }
      // A good enough song from YouTube Music needs no video search.
      const found = bestMatch(candidates, wanted, { threshold: 4 });
      if (found) return found;
    }
    return bestMatch(candidates, wanted, { threshold: 1.5 });
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

/**
 * What song a Spotify, Apple Music or Deezer link is: title, artist, length,
 * and the ISRC when the service says it, which finds the same recording
 * anywhere. Each from the service's own public API.
 *
 * @typedef {{ title: string, artist: string, durationSec: number | null, isrc: string | null }} Song
 */

import { classify } from './links.js';

/** Most songs read from one album or playlist link. */
export const LIST_MAX = 50;

const json = async (fetchImpl, url, init = {}) => {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
};

/**
 * Spotify's Web API needs an app of your own: a client id and secret from
 * developer.spotify.com, in Zouve's settings. Without them, a track link is
 * read from its oEmbed, which has the title only.
 */
export function createSpotify({ clientId, clientSecret, fetchImpl = fetch }) {
  let token = null;
  let expires = 0;

  async function auth() {
    if (token && Date.now() < expires - 60_000) return token;
    const res = await json(fetchImpl, 'https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    token = res.access_token;
    expires = Date.now() + res.expires_in * 1000;
    return token;
  }

  const api = async (path) =>
    json(fetchImpl, `https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${await auth()}` },
    });

  /** @returns {Song} */
  const song = (t) => ({
    title: t.name,
    artist: (t.artists ?? []).map((a) => a.name).join(', '),
    durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
    isrc: t.external_ids?.isrc ?? null,
  });

  return {
    configured: Boolean(clientId && clientSecret),
    async track(id) {
      return song(await api(`/tracks/${id}`));
    },
    async album(id) {
      const album = await api(`/albums/${id}?market=US`);
      // An album's tracks carry no ISRC; the name and artist find them well.
      return album.tracks.items.slice(0, LIST_MAX).map(song);
    },
    async playlist(id) {
      const page = await api(`/playlists/${id}/tracks?limit=${LIST_MAX}`);
      return page.items
        .map((i) => i.track)
        .filter((t) => t?.name)
        .map(song);
    },
    /** A track's title without an app, from the public oEmbed. */
    async oembed(url) {
      const data = await json(
        fetchImpl,
        `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
      );
      return { title: data.title, artist: '', durationSec: null, isrc: null };
    },
  };
}

/** Apple's iTunes Search API: no key. It gives no ISRC. */
export async function appleTrack(id, country = 'us', fetchImpl = fetch) {
  const data = await json(
    fetchImpl,
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}&entity=song`,
  );
  const songs = (data.results ?? []).filter((r) => r.wrapperType === 'track');
  return songs.map((r) => ({
    title: r.trackName,
    artist: r.artistName,
    durationSec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
    isrc: null,
  }));
}

/** Deezer's public API: no key, and ISRCs on tracks. */
export function createDeezer(fetchImpl = fetch) {
  const api = (path) => json(fetchImpl, `https://api.deezer.com${path}`);
  /** @returns {Song} */
  const song = (t) => ({
    title: t.title,
    artist: t.artist?.name ?? '',
    durationSec: t.duration ?? null,
    isrc: t.isrc ?? null,
  });
  return {
    async track(id) {
      const t = await api(`/track/${id}`);
      if (t.error) throw new Error(t.error.message ?? 'Deezer refused');
      return song(t);
    },
    async album(id) {
      return (await api(`/album/${id}/tracks?limit=${LIST_MAX}`)).data.map(song);
    },
    async playlist(id) {
      return (await api(`/playlist/${id}/tracks?limit=${LIST_MAX}`)).data.map(song);
    },
  };
}

/** Where a short link (deezer.page.link) leads. */
async function follow(url, fetchImpl) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  return res.url;
}

/**
 * The songs a Spotify, Apple Music or Deezer link is, or null when it is
 * none of those. Throws when the service could not be read.
 *
 * @returns {Promise<Song[] | null>}
 */
export async function songsOf(link, { spotify, deezer, fetchImpl = fetch }) {
  let found = classify(link);
  if (found.service === 'deezer' && found.kind === 'unknown') {
    found = classify(await follow(link, fetchImpl));
  }
  const { service, kind, id, country } = found;
  if (service === 'spotify' && id) {
    if (!spotify.configured) return kind === 'track' ? [await spotify.oembed(link)] : null;
    if (kind === 'track') return [await spotify.track(id)];
    if (kind === 'album') return spotify.album(id);
    return spotify.playlist(id);
  }
  if (service === 'apple' && id) {
    const songs = await appleTrack(id, country, fetchImpl);
    return kind === 'track' ? songs.slice(0, 1) : songs.slice(0, LIST_MAX);
  }
  if (service === 'deezer' && id) {
    if (kind === 'track') return [await deezer.track(id)];
    if (kind === 'album') return deezer.album(id);
    return deezer.playlist(id);
  }
  return null;
}

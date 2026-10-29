/**
 * What a link is: which service, and what on it. Pure, so it can be tested
 * without the network.
 *
 * Only YouTube and YouTube Music are played from. Spotify, Apple Music and
 * Deezer stream DRM-protected audio to their own apps alone, so a link to them
 * is read for what song it is, and that song is found on YouTube Music.
 */

/** @typedef {'youtube' | 'spotify' | 'apple' | 'deezer' | 'other'} Service */

/**
 * @returns {{ service: Service, kind: 'track' | 'album' | 'playlist' | 'video' | 'unknown',
 *   id: string | null, country?: string }}
 */
export function classify(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { service: 'other', kind: 'unknown', id: null };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { service: 'other', kind: 'unknown', id: null };
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') return { service: 'youtube', kind: 'video', id: parts[0] ?? null };
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const list = url.searchParams.get('list');
    const video = url.searchParams.get('v') ?? (parts[0] === 'shorts' ? parts[1] : null);
    if (video) return { service: 'youtube', kind: 'video', id: video };
    if (list) return { service: 'youtube', kind: 'playlist', id: list };
    return { service: 'youtube', kind: 'unknown', id: null };
  }

  if (host === 'open.spotify.com') {
    // A locale may come first: /intl-pt/track/…
    const rest = parts[0]?.startsWith('intl-') ? parts.slice(1) : parts;
    const [kind, id] = rest;
    if (['track', 'album', 'playlist'].includes(kind) && id)
      return { service: 'spotify', kind, id };
    return { service: 'spotify', kind: 'unknown', id: null };
  }

  if (host === 'music.apple.com') {
    // /br/album/name/123?i=456 is a song on an album; /br/song/name/456 a song.
    const [country, kind] = parts;
    const song = url.searchParams.get('i');
    if (kind === 'album' && song) return { service: 'apple', kind: 'track', id: song, country };
    if (kind === 'song') return { service: 'apple', kind: 'track', id: parts.at(-1), country };
    if (kind === 'album') return { service: 'apple', kind: 'album', id: parts.at(-1), country };
    return { service: 'apple', kind: 'unknown', id: null };
  }

  if (host === 'deezer.com' || host === 'deezer.page.link' || host === 'link.deezer.com') {
    const rest = /^[a-z]{2}$/.test(parts[0] ?? '') ? parts.slice(1) : parts;
    const [kind, id] = rest;
    if (['track', 'album', 'playlist'].includes(kind) && id) return { service: 'deezer', kind, id };
    // Short links are followed to where they lead.
    return { service: 'deezer', kind: 'unknown', id: null };
  }

  return { service: 'other', kind: 'unknown', id: null };
}

export const isUrl = (text) => /^https?:\/\//i.test(text.trim());

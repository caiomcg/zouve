/**
 * YouTube Music's own search, as its web app asks it: one request, under a
 * second, with each song's title, artists and length. yt-dlp's search gives
 * titles alone, so judging a result meant reading its page, seconds each.
 *
 * It is the site's internal API, not a promised one: when it fails or
 * changes shape, the resolver falls back to yt-dlp's search.
 */

const ENDPOINT = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
/** What the web app says it is. Old enough versions keep working for years. */
const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20251020.01.00', hl: 'en' };
/** The "Songs" filter: official recordings, not videos or uploads. */
const SONGS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';

const ARTIST = 'MUSIC_PAGE_TYPE_ARTIST';
const LENGTH = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/;

/** "3:20" or "1:02:03" in seconds, or null. */
export function seconds(text) {
  const m = LENGTH.exec(text ?? '');
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const runsOf = (column) => column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
const pageOf = (run) =>
  run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
    ?.browseEndpointContextMusicConfig?.pageType;

/** Every song in a search response, as candidates the matcher can judge as they are. */
export function parseSearch(json) {
  const items = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.musicResponsiveListItemRenderer) items.push(node.musicResponsiveListItemRenderer);
    for (const value of Object.values(node)) walk(value);
  })(json);

  const songs = [];
  for (const item of items) {
    const [first, second] = item.flexColumns ?? [];
    const titleRun = runsOf(first)[0];
    const id =
      item.playlistItemData?.videoId ?? titleRun?.navigationEndpoint?.watchEndpoint?.videoId;
    if (!id || !titleRun?.text) continue;
    const details = runsOf(second);
    const artists = details.filter((r) => pageOf(r) === ARTIST).map((r) => r.text);
    const length = details.map((r) => seconds(r.text)).find((s) => s !== null) ?? null;
    songs.push({
      url: `https://music.youtube.com/watch?v=${id}`,
      title: titleRun.text,
      artist: artists.join(', ') || details[0]?.text || '',
      durationSec: length,
      source: 'ytmusic',
      // Artist and length are known: it can be judged without reading its page.
      full: true,
    });
  }
  return songs;
}

/** YouTube Music's songs for a query, best first. */
export async function searchSongs(query, { limit = 5, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { client: CLIENT }, query, params: SONGS }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`YouTube Music search answered ${res.status}`);
  const songs = parseSearch(await res.json()).slice(0, limit);
  if (songs.length === 0) throw new Error('YouTube Music search gave nothing it could read');
  return songs;
}

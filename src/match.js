/**
 * Picking the best of a search's results for a song, or for what someone
 * typed. Pure, so it can be tested.
 *
 * @typedef {{ url: string, title: string, artist: string, durationSec: number | null,
 *   source: 'ytmusic' | 'youtube' }} Candidate
 */

/** Versions nobody asked for, unless they did. */
const UNWANTED = [
  'live',
  'cover',
  'karaoke',
  'instrumental',
  'remix',
  'sped up',
  'slowed',
  'reverb',
  '8d',
  'nightcore',
  'reaction',
  'tutorial',
  'lyrics',
];

export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const words = (s) => new Set(fold(s).split(' ').filter(Boolean));

/** How much of `wanted` is in `got`, 0 to 1. */
function covered(wanted, got) {
  const w = words(wanted);
  if (w.size === 0) return 0;
  const g = words(got);
  let hit = 0;
  for (const word of w) if (g.has(word)) hit += 1;
  return hit / w.size;
}

/**
 * A score for how well a candidate is the wanted song: its title and artist
 * found in the candidate's, its length close, no unasked-for version, and
 * YouTube Music's own songs over uploads.
 */
export function score(candidate, wanted) {
  const text = `${candidate.title} ${candidate.artist}`;
  const asked = fold(`${wanted.title} ${wanted.artist ?? ''}`);
  // A song is its title and its artist; typed words may be either, or both.
  let total = wanted.artist
    ? covered(wanted.title, candidate.title) * 4 + covered(wanted.artist, text) * 3
    : covered(wanted.title, text) * 5;
  if (wanted.durationSec && candidate.durationSec) {
    const off = Math.abs(wanted.durationSec - candidate.durationSec);
    total += off <= 3 ? 2 : off <= 10 ? 1 : off > 60 ? -3 : 0;
  }
  // Whole words: "live" is not in "Alive" or "Oliveira".
  const said = ` ${fold(text)} `;
  const wantedWords = ` ${asked} `;
  for (const word of UNWANTED) {
    if (said.includes(` ${word} `) && !wantedWords.includes(` ${word} `)) total -= 2;
  }
  if (candidate.source === 'ytmusic') total += 0.5;
  // Hour-long mixes are not a song.
  if (candidate.durationSec && candidate.durationSec > 20 * 60) total -= 3;
  return total;
}

/** The best candidate for the wanted song, or null when none is near enough. */
export function bestMatch(candidates, wanted, { threshold = 3 } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const s = score(candidate, wanted);
    if (s > bestScore) {
      best = candidate;
      bestScore = s;
    }
  }
  return bestScore >= threshold ? best : null;
}

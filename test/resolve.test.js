/**
 * Finding what to play: which service a link is, which search result is the
 * song, and falling back from one source to the next. No network: searches
 * and the services' APIs are stand-ins.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../src/links.js';
import { bestMatch, score } from '../src/match.js';
import { createResolver, NotFound, SearchFailed } from '../src/resolver.js';
import { createDeezer, appleTrack, songsOf } from '../src/metadata.js';

const quiet = { info() {}, warn() {}, error() {} };

describe('links', () => {
  test('YouTube and YouTube Music videos and playlists', () => {
    assert.deepEqual(classify('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1'), {
      service: 'youtube',
      kind: 'video',
      id: 'dQw4w9WgXcQ',
    });
    assert.equal(classify('https://youtu.be/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
    assert.equal(classify('https://music.youtube.com/watch?v=abc').service, 'youtube');
    assert.equal(classify('https://www.youtube.com/playlist?list=PL1').kind, 'playlist');
    assert.equal(classify('https://www.youtube.com/shorts/xyz').id, 'xyz');
  });

  test('Spotify, with or without a locale', () => {
    assert.deepEqual(classify('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x'), {
      service: 'spotify',
      kind: 'track',
      id: '4uLU6hMCjMI75M1A2tKUQC',
    });
    assert.equal(classify('https://open.spotify.com/intl-pt/album/1').kind, 'album');
    assert.equal(classify('https://open.spotify.com/playlist/2').kind, 'playlist');
  });

  test('Apple Music songs, on an album or on their own', () => {
    assert.deepEqual(classify('https://music.apple.com/br/album/x/1440857781?i=1440857786'), {
      service: 'apple',
      kind: 'track',
      id: '1440857786',
      country: 'br',
    });
    assert.equal(classify('https://music.apple.com/us/song/x/123').id, '123');
  });

  test('Deezer, with a language or without', () => {
    assert.deepEqual(classify('https://www.deezer.com/pt/track/3135556'), {
      service: 'deezer',
      kind: 'track',
      id: '3135556',
    });
    assert.equal(classify('https://deezer.page.link/abc').kind, 'unknown');
  });

  test('anything else is other', () => {
    assert.equal(classify('never gonna give you up').service, 'other');
    assert.equal(classify('ftp://example.com/x').service, 'other');
    assert.equal(classify('https://soundcloud.com/a/b').service, 'other');
  });
});

describe('matching', () => {
  const wanted = { title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 213 };
  const song = {
    url: 'a',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    durationSec: 214,
    source: 'ytmusic',
  };

  test('the recording beats a cover, a live take and an hour-long mix', () => {
    const others = [
      { ...song, url: 'cover', title: 'Never Gonna Give You Up (Cover)', artist: 'Someone' },
      { ...song, url: 'live', title: 'Never Gonna Give You Up (Live)', durationSec: 260 },
      { ...song, url: 'mix', title: 'Never Gonna Give You Up 1 hour', durationSec: 3600 },
    ];
    assert.equal(bestMatch([...others, song], wanted).url, 'a');
  });

  test('a live take wins when it was asked for', () => {
    const live = {
      ...song,
      url: 'live',
      title: 'Never Gonna Give You Up (Live)',
      durationSec: 260,
    };
    const askedLive = { ...wanted, title: 'Never Gonna Give You Up Live', durationSec: 260 };
    assert.ok(score(live, askedLive) > score(song, askedLive));
  });

  test('a word is only unwanted whole: "Alive" is not a live take', () => {
    const alive = {
      url: 'x',
      title: 'Alive',
      artist: 'Pearl Jam',
      durationSec: 340,
      source: 'ytmusic',
    };
    const wantedAlive = { title: 'Alive', artist: 'Pearl Jam', durationSec: 341 };
    const plain = score(alive, wantedAlive);
    assert.equal(score({ ...alive, title: 'Alive (Live)' }, wantedAlive) < plain, true);
    assert.ok(plain >= 9, `scored ${plain}`);
  });

  test('nothing near enough is no match', () => {
    const unrelated = { ...song, title: 'Cooking pasta', artist: 'Chef', durationSec: 600 };
    assert.equal(bestMatch([unrelated], wanted), null);
  });

  test('accents and case do not matter', () => {
    const typed = { title: 'Águas de Março', artist: 'Elis Regina', durationSec: null };
    const found = {
      url: 'x',
      title: 'aguas de marco',
      artist: 'ELIS REGINA',
      durationSec: 210,
      source: 'ytmusic',
    };
    assert.ok(bestMatch([found], typed));
  });
});

/** yt-dlp, answering from tables, and saying which searches were made. */
function fakeYtdlp({ music = {}, videos = {}, info = {}, failMusic = false } = {}) {
  const asked = [];
  return {
    asked,
    async searchMusic(q) {
      asked.push(`music:${q}`);
      if (failMusic) throw new Error('YouTube Music is down');
      return music[q] ?? [];
    },
    async searchVideos(q) {
      asked.push(`videos:${q}`);
      return videos[q] ?? [];
    },
    async playlist(url) {
      asked.push(`playlist:${url}`);
      return info[url] ?? [];
    },
    async info(url) {
      asked.push(`info:${url}`);
      if (!info[url]) throw new Error('unsupported');
      return info[url];
    },
  };
}

const track = (title, artist, extra = {}) => ({
  url: `https://music.youtube.com/watch?v=${title.length}`,
  title,
  artist,
  durationSec: 200,
  source: 'ytmusic',
  ...extra,
});

describe('resolving', () => {
  const noSpotify = () => ({ configured: false, oembed: async () => ({}) });

  test('words are searched on YouTube Music first', async () => {
    const ytdlp = fakeYtdlp({
      music: { 'rick astley never gonna': [track('Never Gonna Give You Up', 'Rick Astley')] },
    });
    const resolver = createResolver({
      ytdlp,
      spotify: noSpotify,
      deezer: createDeezer(),
      logger: quiet,
    });
    const [found] = await resolver.resolve('rick astley never gonna');
    assert.equal(found.artist, 'Rick Astley');
    assert.deepEqual(ytdlp.asked, ['music:rick astley never gonna']);
  });

  test('when YouTube Music fails, YouTube is searched instead', async () => {
    const video = track('Never Gonna Give You Up', 'Rick Astley', { source: 'youtube' });
    const ytdlp = fakeYtdlp({ failMusic: true, videos: { 'never gonna give you up': [video] } });
    const resolver = createResolver({
      ytdlp,
      spotify: noSpotify,
      deezer: createDeezer(),
      logger: quiet,
    });
    const [found] = await resolver.resolve('never gonna give you up');
    assert.equal(found.source, 'youtube');
  });

  test('nothing found anywhere says so', async () => {
    const resolver = createResolver({
      ytdlp: fakeYtdlp(),
      spotify: noSpotify,
      deezer: createDeezer(),
      logger: quiet,
    });
    await assert.rejects(resolver.resolve('zzzz qqqq'), NotFound);
  });

  test('when every search errors, it says searching is broken, not that nothing was found', async () => {
    const broken = {
      searchMusic: async () => {
        throw new Error('libz.so.1: failed to map segment');
      },
      searchVideos: async () => {
        throw new Error('libz.so.1: failed to map segment');
      },
    };
    const resolver = createResolver({
      ytdlp: broken,
      spotify: noSpotify,
      deezer: createDeezer(),
      logger: quiet,
    });
    await assert.rejects(resolver.resolve('linkin park lost'), SearchFailed);
  });

  test('a YouTube link plays as it is', async () => {
    const url = 'https://www.youtube.com/watch?v=abc';
    const ytdlp = fakeYtdlp({ info: { [url]: track('A', 'B', { url }) } });
    const resolver = createResolver({
      ytdlp,
      spotify: noSpotify,
      deezer: createDeezer(),
      logger: quiet,
    });
    assert.equal((await resolver.resolve(url))[0].url, url);
  });

  test('a Deezer track is found by its ISRC first', async () => {
    const deezer = {
      track: async () => ({
        title: 'Song',
        artist: 'Band',
        durationSec: 200,
        isrc: 'GBARL9300135',
      }),
    };
    const found = track('Song', 'Band');
    const ytdlp = fakeYtdlp({ music: { GBARL9300135: [found] } });
    const resolver = createResolver({ ytdlp, spotify: noSpotify, deezer, logger: quiet });
    const [first] = await resolver.resolve('https://www.deezer.com/track/1');
    assert.equal(first.url, found.url);
    assert.deepEqual(ytdlp.asked, ['music:GBARL9300135']);
  });

  test('without an ISRC match, by artist and title, then on YouTube', async () => {
    const deezer = {
      track: async () => ({ title: 'Song', artist: 'Band', durationSec: 200, isrc: 'X' }),
    };
    const video = track('Song', 'Band', {
      source: 'youtube',
      url: 'https://youtube.com/watch?v=v',
    });
    const ytdlp = fakeYtdlp({ videos: { 'Band - Song': [video] } });
    const resolver = createResolver({ ytdlp, spotify: noSpotify, deezer, logger: quiet });
    const [first] = await resolver.resolve('https://www.deezer.com/track/1');
    assert.equal(first.url, video.url);
    assert.deepEqual(ytdlp.asked, ['music:X', 'music:Band Song', 'videos:Band - Song']);
  });

  test('a list starts with its first song found; the rest are looked up later', async () => {
    const deezer = {
      album: async () => [
        { title: 'One', artist: 'Band', durationSec: 200, isrc: null },
        { title: 'Two', artist: 'Band', durationSec: 200, isrc: null },
      ],
    };
    const ytdlp = fakeYtdlp({
      music: { 'Band One': [track('One', 'Band')], 'Band Two': [track('Two', 'Band')] },
    });
    const resolver = createResolver({ ytdlp, spotify: noSpotify, deezer, logger: quiet });
    const tracks = await resolver.resolve('https://www.deezer.com/album/9');
    assert.equal(tracks.length, 2);
    assert.ok(tracks[0].url);
    assert.equal(tracks[1].url, null);
    assert.equal(ytdlp.asked.includes('music:Band Two'), false, 'not yet');
    assert.ok((await resolver.ready(tracks[1])).url);
  });

  test('another site is tried as it is, then refused', async () => {
    const resolver = createResolver({
      ytdlp: fakeYtdlp(),
      spotify: noSpotify,
      deezer: createDeezer(),
      logger: quiet,
    });
    await assert.rejects(resolver.resolve('https://example.com/song'), NotFound);
  });
});

describe('the services’ APIs', () => {
  const answer = (routes) => async (url) => {
    const path = Object.keys(routes).find((p) => url.startsWith(p));
    return path ? Response.json(routes[path]) : new Response('', { status: 404 });
  };

  test('Deezer gives the title, artist, length and ISRC', async () => {
    const deezer = createDeezer(
      answer({
        'https://api.deezer.com/track/3135556': {
          title: 'Harder, Better, Faster, Stronger',
          artist: { name: 'Daft Punk' },
          duration: 224,
          isrc: 'GBDUW0000059',
        },
      }),
    );
    assert.deepEqual(await deezer.track('3135556'), {
      title: 'Harder, Better, Faster, Stronger',
      artist: 'Daft Punk',
      durationSec: 224,
      isrc: 'GBDUW0000059',
    });
  });

  test('Apple Music is read from the iTunes lookup, in the link’s country', async () => {
    let asked;
    const fetchImpl = async (url) => {
      asked = url;
      return Response.json({
        results: [
          { wrapperType: 'track', trackName: 'Song', artistName: 'Band', trackTimeMillis: 200500 },
        ],
      });
    };
    const [song] = await appleTrack('123', 'br', fetchImpl);
    assert.match(asked, /country=br/);
    assert.deepEqual(song, { title: 'Song', artist: 'Band', durationSec: 201, isrc: null });
  });

  test('a Spotify album without an app of our own is not read', async () => {
    const spotify = { configured: false };
    assert.equal(
      await songsOf('https://open.spotify.com/album/1', { spotify, deezer: createDeezer() }),
      null,
    );
  });
});

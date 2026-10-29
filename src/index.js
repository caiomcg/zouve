/**
 * Starts Zouve in its container, with what Zoia's addon host put in its
 * environment, and keeps it connected: when the event stream ends (Zoia
 * restarting, the addon turned off), it waits and connects again.
 */

import { createZoia } from './zoia.js';
import { createZouve } from './zouve.js';
import { createResolver } from './resolver.js';
import { createYtdlp } from './ytdlp.js';
import { createDeezer, createSpotify } from './metadata.js';
import { createPlayer } from './player.js';

const { ZOIA_URL, ZOIA_ADDON_TOKEN, ZOIA_LIVEKIT_URL } = process.env;
if (!ZOIA_URL || !ZOIA_ADDON_TOKEN) {
  console.error('ZOIA_URL and ZOIA_ADDON_TOKEN are set by Zoia’s addon host; run Zouve there.');
  process.exit(1);
}

const RETRY_MS = 5_000;

const zoia = createZoia({ url: ZOIA_URL, token: ZOIA_ADDON_TOKEN });
let settings = {};

// Spotify's app is in the settings, which the super admin may change at any
// time; one client per pair of credentials, so its token is reused.
let spotify = null;
const spotifyNow = () => {
  const { spotifyClientId: clientId = '', spotifyClientSecret: clientSecret = '' } = settings;
  if (!spotify || spotify.key !== `${clientId}:${clientSecret}`) {
    spotify = {
      key: `${clientId}:${clientSecret}`,
      client: createSpotify({ clientId, clientSecret }),
    };
  }
  return spotify.client;
};

const resolver = createResolver({
  ytdlp: createYtdlp(),
  deezer: createDeezer(),
  // Read at each use, so a change of settings applies to the next !play.
  spotify: spotifyNow,
});

const zouve = createZouve({
  zoia,
  resolver,
  makePlayer: (options) =>
    createPlayer({ ...options, livekitUrl: ZOIA_LIVEKIT_URL ?? null, resolver }),
});

const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    stop.abort();
    await zouve.stopAll();
    process.exit(0);
  });
}
zouve.startWatching(stop.signal);

while (!stop.signal.aborted) {
  try {
    await zouve.start();
    settings = (await zoia.me()).settings ?? {};
    await zoia.listen((event, data) => {
      if (event === 'settings') settings = data.settings ?? settings;
      zouve.handle(event, data);
    }, stop.signal);
    console.warn('[zouve] the event stream ended; connecting again');
  } catch (err) {
    if (stop.signal.aborted) break;
    console.warn(`[zouve] ${err.message}; trying again in ${RETRY_MS / 1000}s`);
  }
  await new Promise((r) => setTimeout(r, RETRY_MS));
}

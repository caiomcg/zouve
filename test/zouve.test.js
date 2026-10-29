/**
 * The commands, against a stand-in Zoia and stand-in players: who may do
 * what, what is said back, and the queue they work on.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createZouve } from '../src/zouve.js';
import { Queue } from '../src/queue.js';
import { NotFound } from '../src/resolver.js';
import { applyGain } from '../src/player.js';
import { say } from '../src/messages.js';

const quiet = { info() {}, warn() {}, error() {} };

let said;
let zoia;
let made;
let zouve;

/** A player that plays nothing, keeping its queue as the real one does. */
function fakePlayer(options) {
  const queue = new Queue({ max: options.maxQueue, random: () => 0 });
  let paused = false;
  const player = {
    channel: options.channel,
    queue,
    stopped: false,
    get current() {
      return queue.current;
    },
    enqueue(tracks) {
      const added = queue.add(tracks);
      if (!queue.current) {
        queue.next();
        options.onEvent('playing', queue.current);
      }
      return added;
    },
    togglePause() {
      paused = !paused;
      return paused;
    },
    resume() {
      if (!paused) return false;
      paused = false;
      return true;
    },
    skip() {
      const was = queue.current;
      queue.next();
      return was;
    },
    shuffle: () => queue.shuffle(),
    async stop() {
      player.stopped = true;
      queue.clear();
    },
  };
  made.push({ options, player });
  return player;
}

const resolver = {
  async resolve(input) {
    if (input === 'nothing') throw new NotFound(input);
    if (input === 'album') {
      return [1, 2, 3].map((n) => ({ title: `Song ${n}`, artist: 'Band', url: `u${n}` }));
    }
    return [{ title: input, artist: 'Band', url: `u:${input}` }];
  },
};

const command = (name, args = '', voice = 'geral') => ({
  chatId: 'chat',
  messageId: `m-${name}`,
  author: { id: 'ana', name: 'Ana' },
  command: name,
  name,
  args,
  voice: voice ? { channel: voice } : null,
});

beforeEach(async () => {
  said = [];
  made = [];
  zoia = {
    async me() {
      return {
        settings: { volume: 40, language: 'en' },
        commands: { play: 'p', pause: 'pause' },
        bots: [],
      };
    },
    async createBot(name) {
      return { id: 'bot1', name };
    },
    async say(chatId, bot, body, replyTo) {
      said.push({ chatId, bot, body, replyTo });
    },
    async voiceToken() {
      return { token: 't', wsUrl: 'wss://sfu' };
    },
    async channels() {
      return [{ id: 'geral', people: [{ voice: true, bot: false }] }];
    },
  };
  zouve = createZouve({ zoia, resolver, makePlayer: fakePlayer, logger: quiet });
  await zouve.start();
});

const last = () => said.at(-1)?.body;

describe('playing', () => {
  test('makes its bot once, and plays in the channel of whoever asked', async () => {
    assert.equal(zouve.bot.id, 'bot1');
    await zouve.onCommand(command('play', 'lofi'));
    assert.equal(made.length, 1);
    assert.equal(made[0].options.channel, 'geral');
    assert.match(last(), /Now playing: \*\*Band – lofi\*\*/);
    assert.equal(said[0].bot, 'bot1');
  });

  test('outside voice, it asks to join first, naming the command as typed here', async () => {
    await zouve.onCommand(command('play', 'lofi', null));
    assert.equal(made.length, 0);
    assert.match(last(), /!p what you want/);
  });

  test('a second song is queued, with its place', async () => {
    await zouve.onCommand(command('play', 'one'));
    await zouve.onCommand(command('play', 'two'));
    assert.match(last(), /Queued \*\*Band – two\*\*, 1 in line/);
  });

  test('an album is queued whole', async () => {
    await zouve.onCommand(command('play', 'album'));
    assert.match(last(), /Queued 3 songs/);
  });

  test('nothing found says so', async () => {
    await zouve.onCommand(command('play', 'nothing'));
    assert.match(last(), /could not find “nothing”/);
  });

  test('each channel has a player of its own', async () => {
    await zouve.onCommand(command('play', 'one', 'geral'));
    await zouve.onCommand(command('play', 'two', 'jogos'));
    assert.deepEqual(
      made.map((m) => m.options.channel),
      ['geral', 'jogos'],
    );
  });

  test('the volume is the setting, as it changes', async () => {
    await zouve.onCommand(command('play', 'one'));
    assert.equal(made[0].options.volume(), 40);
    zouve.handle('settings', { settings: { volume: 90 } });
    assert.equal(made[0].options.volume(), 90);
  });
});

describe('controlling', () => {
  beforeEach(() => zouve.onCommand(command('play', 'one')));

  test('pause toggles, and play with nothing after it resumes', async () => {
    await zouve.onCommand(command('pause'));
    assert.match(last(), /Paused/);
    await zouve.onCommand(command('play'));
    assert.match(last(), /Playing again/);
  });

  test('skip names what it skipped', async () => {
    await zouve.onCommand(command('skip'));
    assert.match(last(), /Skipped \*\*Band – one\*\*/);
  });

  test('shuffle needs two songs to shuffle', async () => {
    await zouve.onCommand(command('shuffle'));
    assert.match(last(), /nothing in the queue/);
    await zouve.onCommand(command('play', 'album'));
    await zouve.onCommand(command('shuffle'));
    assert.match(last(), /Shuffled 3 songs/);
  });

  test('queue lists what plays now and next', async () => {
    await zouve.onCommand(command('play', 'two'));
    await zouve.onCommand(command('queue'));
    assert.match(last(), /Now:\*\* Band – one\n\*\*Next:\*\*\n1\. Band – two/);
  });

  test('stop empties it and leaves', async () => {
    await zouve.onCommand(command('stop'));
    assert.equal(made[0].player.stopped, true);
    assert.equal(zouve.players.size, 0);
  });

  test('from another channel, nothing here to control', async () => {
    await zouve.onCommand(command('skip', '', 'jogos'));
    assert.match(last(), /Nothing is playing/);
  });
});

test('it leaves a channel nobody is listening in', async () => {
  await zouve.onCommand(command('play', 'one'));
  zoia.channels = async () => [{ id: 'geral', people: [{ voice: true, bot: true }] }];
  await zouve.watch();
  assert.equal(made[0].player.stopped, true);
  assert.equal(zouve.players.size, 0);
});

test('a bot replies in the language set, and command names follow the server', () => {
  assert.equal(say('pt', 'paused', {}, { pause: 'pausa', play: 'tocar' }).includes('!pausa'), true);
  assert.equal(say('xx', 'nothing'), 'Nothing is playing.');
});

test('the queue holds no more than its limit', () => {
  const queue = new Queue({ max: 2 });
  assert.equal(queue.add([1, 2, 3]), 2);
  assert.equal(queue.next(), 1);
  assert.equal(queue.size, 1);
});

test('volume scales samples, clipping at the edges', () => {
  assert.deepEqual([...applyGain(Int16Array.from([1000, -1000, 30000]), 0.5)], [500, -500, 15000]);
  assert.deepEqual([...applyGain(Int16Array.from([30000, -30000]), 2)], [32767, -32768]);
});

/**
 * Zouve: answers the music commands in the chats it is bound to, and runs a
 * player in each voice channel someone asked it to play in.
 *
 * A command is only obeyed from someone in voice, for the channel they are
 * in: nobody outside a channel changes what it hears.
 */

import { NotFound } from './resolver.js';
import { nameOf, say } from './messages.js';

/** The bot's name, made unique by Zoia if it is taken. */
const BOT_NAME = 'Zouve';
/** How often channels are checked for anyone left to listen. */
const WATCH_MS = 30_000;
/** Songs listed by !queue. */
const QUEUE_SHOWN = 10;

export function createZouve({ zoia, resolver, makePlayer, logger = console }) {
  let bot = null;
  let settings = {};
  let commands = {};
  /** @type {Map<string, ReturnType<import('./player.js').createPlayer> & { chatId?: string }>} */
  const players = new Map();

  const language = () => settings.language ?? 'en';
  const text = (key, vars) => say(language(), key, vars, commands);

  async function reply(chatId, body, replyTo) {
    try {
      await zoia.say(chatId, bot.id, body, replyTo);
    } catch (err) {
      logger.warn(`[zouve] could not write in ${chatId}: ${err.message}`);
    }
  }

  /** Reads who it is and what it was told; makes its bot the first time. */
  async function start() {
    const me = await zoia.me();
    settings = me.settings ?? {};
    commands = me.commands ?? {};
    bot = me.bots.find((b) => b.name.startsWith(BOT_NAME)) ?? me.bots[0] ?? null;
    if (!bot) bot = await zoia.createBot(BOT_NAME);
    logger.info(`[zouve] playing as ${bot.name} (${bot.id})`);
  }

  function playerFor(channel, chatId) {
    let player = players.get(channel);
    if (!player) {
      player = makePlayer({
        channel,
        token: () => zoia.voiceToken(bot.id, channel),
        volume: () => Number(settings.volume ?? 60),
        maxQueue: Number(settings.maxQueue ?? 100),
        onEvent: (event, track, why) => {
          const where = players.get(channel)?.chatId;
          if (!where) return;
          if (event === 'playing' && settings.announce !== false) {
            void reply(where, text('nowPlaying', { track: nameOf(track) }));
          } else if (event === 'failed' || event === 'unjoinable') {
            void reply(where, text(event, { track: nameOf(track), why }));
          } else if (event === 'missing') {
            void reply(where, text('missing', { track: nameOf(track) }));
          }
        },
        onIdle: () => {
          if (players.get(channel) === player) players.delete(channel);
        },
      });
      players.set(channel, player);
    }
    // Announcements go where it was last told something.
    player.chatId = chatId;
    return player;
  }

  async function onCommand(c) {
    const answer = (body) => reply(c.chatId, body, c.messageId);
    const channel = c.voice?.channel ?? null;
    if (!channel) {
      // Asked from outside voice: nothing to play to, and no channel to control.
      return answer(players.size > 0 ? text('elsewhere') : text('joinFirst'));
    }
    const player = players.get(channel);

    switch (c.command) {
      case 'play': {
        if (!c.args) {
          if (player?.resume()) return answer(text('resumed'));
          return answer(text('usage'));
        }
        let tracks;
        try {
          tracks = await resolver.resolve(c.args);
        } catch (err) {
          if (!(err instanceof NotFound)) logger.warn(`[zouve] resolving: ${err.message}`);
          return answer(text('notFound', { query: c.args.slice(0, 100) }));
        }
        const target = playerFor(channel, c.chatId);
        const wasIdle = !target.current;
        const before = target.queue.size;
        const added = target.enqueue(tracks.map((t) => ({ ...t, by: c.author.name })));
        if (added === 0) return answer(text('queueFull', { max: target.queue.max }));
        if (added > 1)
          return answer(text('queuedMany', { count: added, track: nameOf(tracks[0]) }));
        // Starting from nothing, "now playing" says it.
        if (!wasIdle) {
          return answer(text('queued', { track: nameOf(tracks[0]), position: before + 1 }));
        }
        return undefined;
      }
      case 'pause': {
        if (!player?.current) return answer(text('nothing'));
        return answer(player.togglePause() ? text('paused') : text('resumed'));
      }
      case 'skip': {
        if (!player?.current) return answer(text('nothing'));
        const was = player.skip();
        return answer(text('skipped', { track: nameOf(was) }));
      }
      case 'shuffle': {
        const count = player?.shuffle() ?? 0;
        return answer(count > 1 ? text('shuffled', { count }) : text('shuffledNone'));
      }
      case 'queue': {
        if (!player?.current) return answer(text('queueEmpty'));
        const lines = [text('queueNow', { track: nameOf(player.current) })];
        const upcoming = player.queue.upcoming;
        if (upcoming.length > 0) {
          lines.push(text('queueNext'));
          upcoming.slice(0, QUEUE_SHOWN).forEach((t, i) => lines.push(`${i + 1}. ${nameOf(t)}`));
          if (upcoming.length > QUEUE_SHOWN) {
            lines.push(text('queueMore', { count: upcoming.length - QUEUE_SHOWN }));
          }
        }
        return answer(lines.join('\n'));
      }
      case 'stop': {
        if (!player) return answer(text('nothing'));
        players.delete(channel);
        await player.stop();
        return answer(text('stopped'));
      }
      default:
        return undefined;
    }
  }

  /** Leaves channels nobody is listening in any more. */
  async function watch() {
    if (players.size === 0) return;
    let channels;
    try {
      channels = await zoia.channels();
    } catch {
      return;
    }
    for (const [id, player] of players) {
      const channel = channels.find((c) => c.id === id);
      const listening = channel?.people.some((p) => p.voice && !p.bot);
      if (!listening) {
        players.delete(id);
        await player.stop();
      }
    }
  }

  return {
    start,
    onCommand,
    watch,
    players,
    get bot() {
      return bot;
    },

    /** One event from Zoia's stream. */
    handle(event, data) {
      if (event === 'command') {
        void onCommand(data).catch((err) =>
          logger.error(`[zouve] !${data?.name ?? '?'}: ${err.message}`),
        );
      } else if (event === 'settings') {
        settings = data.settings ?? settings;
      } else if (event === 'commands') {
        commands = data.commands ?? commands;
      }
    },

    /** Runs the watch until `signal` aborts. */
    startWatching(signal) {
      const timer = setInterval(() => void watch(), WATCH_MS);
      timer.unref?.();
      signal?.addEventListener('abort', () => clearInterval(timer));
    },

    async stopAll() {
      for (const player of players.values()) await player.stop();
      players.clear();
    },
  };
}

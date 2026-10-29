/**
 * Zouve: answers the music commands in the chats it is bound to, and plays
 * in one voice channel at a time, for whoever asked from that channel.
 *
 * A command is only obeyed from someone in that channel: nobody outside it
 * changes what it hears. Asked from another channel while songs are playing
 * or waiting, it says where it is; once nothing is, it moves.
 */

import { NotFound, SearchFailed } from './resolver.js';
import { nameOf, say } from './messages.js';

/** The bot's name, made unique by Zoia if it is taken. */
const BOT_NAME = 'Zouve';
/** How often its channel is checked for anyone left to listen. */
const WATCH_MS = 30_000;
/** Songs listed by !queue. */
const QUEUE_SHOWN = 10;

export function createZouve({ zoia, resolver, makePlayer, logger = console }) {
  let bot = null;
  let settings = {};
  let commands = {};
  /** @type {(ReturnType<import('./player.js').createPlayer> & { chatId?: string }) | null} */
  let player = null;

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

  /** The player for `channel`, made if there is none. */
  function playerIn(channel, chatId) {
    if (!player) {
      const made = makePlayer({
        channel,
        token: () => zoia.voiceToken(bot.id, channel),
        volume: () => Number(settings.volume ?? 60),
        maxQueue: Number(settings.maxQueue ?? 100),
        onEvent: (event, track, why) => {
          const where = made.chatId;
          if (!where) return;
          if (event === 'playing' && settings.announce !== false) {
            void reply(where, text('nowPlaying', { track: nameOf(track) }));
          } else if (event === 'failed' || event === 'unjoinable') {
            void reply(where, text(event, { track: nameOf(track), why }));
          } else if (event === 'missing') {
            void reply(where, text('missing', { track: nameOf(track) }));
          } else if (event === 'removed') {
            void reply(where, text('removed'));
          }
        },
        onIdle: () => {
          if (player === made) player = null;
        },
      });
      player = made;
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
      return answer(player ? text('elsewhere') : text('joinFirst'));
    }
    // Its channel, or none: the one it is in belongs to the people there.
    const here = player?.channel === channel ? player : null;
    if (player && !here && (c.command !== 'play' || player.busy)) {
      return answer(text('elsewhere'));
    }

    switch (c.command) {
      case 'play': {
        if (!c.args) {
          if (here?.resume()) return answer(text('resumed'));
          return answer(text('usage'));
        }
        let tracks;
        try {
          tracks = await resolver.resolve(c.args);
        } catch (err) {
          if (err instanceof SearchFailed) return answer(text('broken'));
          if (!(err instanceof NotFound)) logger.warn(`[zouve] resolving: ${err.message}`);
          return answer(text('notFound', { query: c.args.slice(0, 100) }));
        }
        // Idle in another channel: it moves here.
        if (player && player.channel !== channel) {
          const old = player;
          player = null;
          await old.stop();
        }
        const target = playerIn(channel, c.chatId);
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
        if (!here?.current) return answer(text('nothing'));
        return answer(here.togglePause() ? text('paused') : text('resumed'));
      }
      case 'skip': {
        if (!here?.current) return answer(text('nothing'));
        const was = here.skip();
        return answer(text('skipped', { track: nameOf(was) }));
      }
      case 'shuffle': {
        const count = here?.shuffle() ?? 0;
        return answer(count > 1 ? text('shuffled', { count }) : text('shuffledNone'));
      }
      case 'queue': {
        if (!here?.current) return answer(text('queueEmpty'));
        const lines = [text('queueNow', { track: nameOf(here.current) })];
        const upcoming = here.queue.upcoming;
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
        if (!here) return answer(text('nothing'));
        player = null;
        await here.stop();
        return answer(text('stopped'));
      }
      default:
        return undefined;
    }
  }

  /** Leaves its channel when nobody is left in voice to hear it. */
  async function watch() {
    if (!player) return;
    let channels;
    try {
      channels = await zoia.channels();
    } catch {
      return;
    }
    const channel = channels.find((c) => c.id === player?.channel);
    const listening = channel?.people.some((p) => p.voice && !p.bot);
    if (!listening && player) {
      const old = player;
      player = null;
      await old.stop();
    }
  }

  return {
    start,
    onCommand,
    watch,
    get player() {
      return player;
    },
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
      const old = player;
      player = null;
      await old?.stop();
    },
  };
}

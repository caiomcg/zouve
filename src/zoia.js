/**
 * Zoia's addon API, as Zouve uses it: a JSON call, and the event stream.
 * See https://github.com/caiomcg/zoia/blob/main/docs/addons/api.md.
 */

export class ZoiaError extends Error {
  constructor(status, code, path) {
    super(`${path}: ${status} ${code ?? ''}`.trim());
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {string} options.url ZOIA_URL
 * @param {string} options.token ZOIA_ADDON_TOKEN
 */
export function createZoia({ url, token, fetchImpl = fetch }) {
  const base = `${url.replace(/\/+$/, '')}/api/addon/v1`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ZoiaError(res.status, data.error, path);
    return data;
  }

  return {
    me: () => call('GET', '/me'),
    channels: () => call('GET', '/channels').then((r) => r.channels),
    createBot: (name) => call('POST', '/bots', { name }).then((r) => r.bot),
    say: (chatId, bot, body, replyTo) =>
      call('POST', `/chats/${chatId}/messages`, { bot, body, ...(replyTo ? { replyTo } : {}) }),
    voiceToken: (bot, channel) => call('POST', '/voice/token', { bot, channel }),
    leaveVoice: (bot, channel) => call('POST', '/voice/leave', { bot, channel }),

    /**
     * Reads the event stream until it ends or `signal` aborts, handing each
     * event to `onEvent`. Server-sent events: frames end in a blank line,
     * and lines starting with `:` are the server saying it is alive.
     */
    async listen(onEvent, signal) {
      const res = await fetchImpl(`${base}/events`, { headers, signal });
      if (!res.ok) throw new ZoiaError(res.status, null, '/events');
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) onEvent(event, JSON.parse(data));
        }
      }
    },
  };
}

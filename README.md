# Zouve

A [Zoia](https://github.com/caiomcg/zoia) addon that plays music in voice. Type in a chat
it is bound to:

| Command                        | Does                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `!play <link, song or artist>` | Plays it in your voice channel, or adds it to the queue. Alone, carries on after a pause. |
| `!pause`                       | Pauses, or carries on.                                                                    |
| `!resume`                      | Carries on after a pause.                                                                 |
| `!skip`                        | Skips to the next song.                                                                   |
| `!shuffle`                     | Shuffles what is still to come.                                                           |
| `!remove <n> [last]`           | Takes song `n` (as `!queue` numbers them) out of the queue; with two numbers, a range.    |
| `!queue`                       | Shows what plays now and next.                                                            |
| `!stop`                        | Empties the queue and leaves the channel.                                                 |
| `!clean`                       | Deletes, now, the commands typed to it and what it answered.                              |

The super admin can rename any of them for everyone (`!play` to `!p`), and the chat offers
them as you type `!`.

## Where music comes from

- **YouTube and YouTube Music** links play as they are; a playlist, song by song.
- **Spotify, Apple Music and Deezer** links are read for which song they are, and that song
  is played from YouTube Music. Those services stream DRM-protected audio to their own apps
  only, so the audio cannot come from them. Deezer gives each song's ISRC, which finds the
  exact recording; the others are found by artist, title and length.
- **Words** are searched on YouTube Music, then YouTube, and the best match is kept:
  the official recording over a cover, a live take, or an hour-long loop, unless you asked
  for one.
- When a source fails, the next is tried.

Albums and playlists are read up to 50 songs. Spotify albums and playlists need a Spotify
app's client ID and secret in Zouve's settings (free, from
[developer.spotify.com](https://developer.spotify.com/dashboard)); without them, a single
Spotify track is still found by its title.

Zouve plays only in the voice channel of whoever asked, and only someone in that channel
controls it. It leaves when the queue has been empty for a minute and a half, or when
nobody is left in voice to hear it.

## Settings

| Setting                      |                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Language                     | What Zouve writes in: English, Português or Español.                                           |
| Volume                       | 0 to 100. Everyone can still turn Zouve down for themselves, as anyone in voice.               |
| Longest queue                | Songs that may wait in one channel.                                                            |
| Say what is playing          | Writes "Now playing" at each song.                                                             |
| Clean up the chat            | When Zouve leaves voice, deletes the commands typed to it and what it answered. On by default. |
| Spotify client ID and secret | For Spotify albums and playlists.                                                              |

## Installing

In Zoia, the super admin opens **Settings › Addons**, enters `caiomcg/zouve`, reads what it
asks for, and installs it. Then they bind it to a chat.

It asks to: write in its chats as its bot, answer its commands and delete them once
answered, have a bot, play audio in voice as that bot, and see who is in each channel (to
leave an empty one).

## Cleaning up

Zouve keeps its chat tidy. When it leaves voice (`!stop`, the queue running out, nobody
left listening, or an admin taking it out) it deletes, ten seconds later, the commands typed
to it during that session and everything it answered. What it says while in no channel
(such as "join a voice channel first") goes a minute later. Turn it off with **Clean up the
chat** in its settings. `!clean` does the same at once, in the chat it is typed in, whether
it is playing or not.

A deleted message disappears for everyone at once. On the server, its space is freed about
an hour later, at the next compaction (Zoia's ADR 0042). Deleting someone's command needs
Zoia's `commands.delete` permission, which only covers commands as they are typed on the
server; Zouve can delete nothing else anyone wrote.

## How it works

Zoia runs Zouve in a container of its own, limited and with no access to Zoia's data. Zouve
talks to Zoia through the [addon API](https://github.com/caiomcg/zoia/blob/main/docs/addons/api.md):
it hears commands on Zoia's event stream, writes in the chat as its bot, and gets a LiveKit
token to join a channel's room as that bot. The audio goes yt-dlp → ffmpeg → 48 kHz stereo
→ [`@livekit/rtc-node`](https://www.npmjs.com/package/@livekit/rtc-node), published as the
bot's microphone, so it sounds and behaves like someone in voice.

See [docs/adr](docs/adr) for why it is built this way.

## Developing

```bash
npm install
npm test
npm run lint
```

Running it for real needs a Zoia server with the addon installed: set `ZOIA_URL`,
`ZOIA_ADDON_TOKEN` and, inside Zoia's addon host, `ZOIA_LIVEKIT_URL`, and have `yt-dlp`,
`ffmpeg` and `deno` on the path.

Commits follow [Conventional Commits](https://www.conventionalcommits.org). A release is a
`vX.Y.Z` tag: the release workflow builds the image to ghcr.io and attaches
`zoia-addon.json` to the GitHub release, which is what Zoia installs.

**yt-dlp follows YouTube, which changes often.** When playing stops working, bump
`YTDLP_VERSION` in the Dockerfile to the latest yt-dlp and tag a release.

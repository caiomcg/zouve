# 1. Every song is played from YouTube Music or YouTube

- **Status:** accepted
- **Date:** 2026-10-29

## Context

People share music as links to whatever they use: YouTube, YouTube Music, Spotify, Apple
Music, Deezer. Or they type a name. Zouve has to play all of it.

Spotify, Apple Music and Deezer only stream to their own apps, encrypted (DRM). Their public
APIs give what a song is (title, artist, length; Spotify and Deezer an ISRC) and, for
Deezer and Apple, a 30-second preview. There is no way to play a whole song from them.

YouTube has nearly every recording, and YouTube Music lists the official ones as songs,
apart from uploads. yt-dlp reads both. Extracting audio from YouTube is against its terms
of service, as it is for every music bot in a chat app; the super admin installing Zouve
takes that on.

## Decision

**The audio always comes from YouTube Music or YouTube, through yt-dlp.** A Spotify, Apple
Music or Deezer link is read, through that service's API, for which song it is; the song is
then found:

1. by its **ISRC** on YouTube Music, when the service gives one;
2. by **artist and title** on YouTube Music;
3. by **artist and title** on YouTube.

Typed words go straight to 2 and 3. At each step the results are scored (title and artist
found, length close, no cover, live take or loop that was not asked for, YouTube Music's
own songs first), and the first good enough match plays. A failed search moves on to the
next step.

Songs from an album or playlist are looked up only when their turn comes, so a long one
starts at once.

## Consequences

- Most songs play as the recording linked. A song YouTube does not have, or has only as
  covers, is skipped, and the chat is told.
- Previews (30 seconds) are never played: a third of a song is worse than the next song.
- yt-dlp has to keep up with YouTube. It is pinned in the image and bumped with each
  release; when YouTube changes, Zouve needs a release.
- YouTube sees the server's address fetching each song.

# 2. Zouve is a bot in voice, playing as its microphone

- **Status:** accepted
- **Date:** 2026-10-29

## Context

Everyone in a Zoia voice channel should hear the music, at a volume each of them chooses,
and stop hearing it when they deafen. Zoia's addon API (its ADR 0041) lets an addon's bot
join a channel's room with a token that publishes a microphone, and nothing else.

## Decision

**Zouve joins the channel's room as its bot, with `@livekit/rtc-node`, and publishes the
music as the bot's microphone.** yt-dlp downloads the best audio, ffmpeg decodes it to
48 kHz stereo PCM, and Zouve feeds it to a LiveKit audio source in 20 ms frames. Waiting on
the source's queue paces it: a frame is decoded only when one has been sent.

The track is published for music: no silence suppression (DTX), 128 kbps. Volume is
applied to the samples, from the setting, as they go out.

There is one player per channel, each with its own queue, so two channels can play
different things at once with one bot.

## Consequences

- Each listener hears Zouve as they hear anyone in voice: with its own volume slider, muted
  when they deafen, and on Android too, with no change to any app.
- It never counts as a broadcast, and takes no broadcast slot.
- Pausing stops reading from ffmpeg. A long pause may let YouTube drop the connection, in
  which case the song ends when resumed and the next one plays.
- The image is Debian, not Alpine: rtc-node's native library is built for glibc.

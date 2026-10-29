# Zouve's image. Debian rather than Alpine: @livekit/rtc-node ships its native
# library for glibc only.
#
# Zoia runs it with a read-only root and a writable /tmp, so every cache —
# yt-dlp's, Deno's, the onefile binary's own unpacking — is pointed there.
FROM node:22-bookworm-slim

# yt-dlp follows YouTube, which changes often: bump it with every release of
# Zouve, and release Zouve when YouTube breaks it. Deno is the JavaScript
# runtime yt-dlp needs to read YouTube's player.
ARG YTDLP_VERSION=2026.10.21
ARG DENO_VERSION=v2.9.7

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
  && curl -fsSL -o /usr/local/bin/yt-dlp \
    "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/SHA2-256SUMS" \
    | grep ' yt-dlp_linux$' | sed 's| yt-dlp_linux$| /usr/local/bin/yt-dlp|' | sha256sum -c - \
  && chmod 755 /usr/local/bin/yt-dlp \
  && curl -fsSL -o /tmp/deno.zip \
    "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
  && unzip -q /tmp/deno.zip -d /usr/local/bin \
  && rm /tmp/deno.zip \
  && apt-get purge -y curl unzip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /addon
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src

ENV NODE_ENV=production \
  HOME=/tmp \
  TMPDIR=/tmp \
  XDG_CACHE_HOME=/tmp/cache \
  DENO_DIR=/tmp/deno

USER node
CMD ["node", "src/index.js"]

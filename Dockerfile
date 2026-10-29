# Zouve's image. Debian rather than Alpine: @livekit/rtc-node ships its native
# library for glibc only.
#
# Zoia runs it with a read-only root and a writable /tmp that nothing may run
# from, so every cache — yt-dlp's, Deno's — is pointed there, and yt-dlp is
# its Python zipapp, not the one-file binary: that one unpacks its libraries
# into /tmp and loads them from there, which the mount refuses.
FROM node:22-bookworm-slim

# yt-dlp follows YouTube, which changes often: bump it with every release of
# Zouve, and release Zouve when YouTube breaks it. Deno is the JavaScript
# runtime yt-dlp needs to read YouTube's player.
ARG YTDLP_VERSION=2026.10.21
ARG DENO_VERSION=v2.9.7

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl unzip \
  && curl -fsSL -o /usr/local/bin/yt-dlp \
    "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/SHA2-256SUMS" \
    | grep ' yt-dlp$' | sed 's| yt-dlp$| /usr/local/bin/yt-dlp|' | sha256sum -c - \
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
  DENO_DIR=/tmp/deno \
  PYTHONDONTWRITEBYTECODE=1

USER node
CMD ["node", "src/index.js"]

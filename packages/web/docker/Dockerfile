# ework all-in-one: ework + ework-daemon + opencode (single container)
#
# Build context must be the parent of this repo so both ework/ and ework-daemon/
# are COPY-able. Use docker/build.sh from this repo's root, or:
#   docker build -f docker/Dockerfile -t ework-aio .. \
#     --build-arg OPENCODE_BIN=/path/to/opencode-linux-x64/bin/opencode
#
# Base image is Ubuntu (not alpine) because opencode ships as a glibc binary;
# alpine musl would require a separate musl build of opencode.

FROM ubuntu:24.04

# ── 1. System deps ─────────────────────────────────────────────────────────
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip git sqlite3 supervisor \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Bun runtime ─────────────────────────────────────────────────────────
# Vendor the binary from the build context (staged by docker/build.sh) instead
# of curling bun.sh: the install script pulls from github.com which is blocked
# in some environments (e.g. this dev host). Binary is glibc-linked so it runs
# on ubuntu:24.04. Version is whatever the host has — newer bun is fine for
# ework/ework-daemon (no API breakage between 1.2.x and 1.3.x).
ARG BUN_BIN=ework/docker/build-context/bun/bin/bun
COPY ${BUN_BIN} /usr/local/bin/bun
RUN chmod +x /usr/local/bin/bun && bun --version

# ── 3. opencode binary (glibc linux-x64) ───────────────────────────────────
# COPY from a path inside the build context. Use docker/build.sh to stage it.
ARG OPENCODE_BIN=ework/docker/build-context/opencode-linux-x64/bin/opencode
COPY ${OPENCODE_BIN} /usr/local/bin/opencode
RUN chmod +x /usr/local/bin/opencode && opencode --version

# ── 4. App sources ─────────────────────────────────────────────────────────
WORKDIR /app

# Copy package manifests first for layer caching
COPY ework/package.json ework/bun.lock* ./ework/
COPY ework-daemon/package.json ework-daemon/bun.lock* ./ework-daemon/

# Install production deps for both
RUN cd ework && bun install --production --frozen-lockfile || bun install --production
RUN cd ework-daemon && bun install --production --frozen-lockfile || bun install --production

# Copy source (skip node_modules via .dockerignore)
COPY ework/src ./ework/src
COPY ework/scripts ./ework/scripts
COPY ework-daemon/src ./ework-daemon/src

# ── 4b. opencode-ework plugin (baked into image) ───────────────────────────
# Plugin source lives in a sibling repo (opencode-ework/) — COPY into /opt so
# it survives image rebuilds and stays decoupled from /root/.config state.
# opencode 1.14 plugin loader reads `plugin` from opencode.json (written by
# entrypoint.sh at first boot) and resolves `/opt/opencode-ework` via its
# package.json main field → loads src/index.ts. The plugin's hooks register
# the issue/comments/floor/reply/search tools that the daemon's spawned
# `opencode run` uses to reply on issues.
COPY opencode-ework/package.json opencode-ework/bun.lock* /opt/opencode-ework/
RUN cd /opt/opencode-ework && (bun install --production --frozen-lockfile || bun install --production)
COPY opencode-ework/src /opt/opencode-ework/src

# ── 5. Supervisor config ───────────────────────────────────────────────────
COPY ework/docker/supervisord.conf /etc/supervisor/conf.d/ework.conf
COPY ework/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── 6. Runtime ─────────────────────────────────────────────────────────────
# /data holds all mutable state (DBs, attachments, opencode workdir) — mount as volume.
RUN mkdir -p /data
VOLUME ["/data"]

# ework :3002 (web UI + Gitea-compat API)
# ework-daemon :3101 (webhook receiver + issue poller)
EXPOSE 3002 3101

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]

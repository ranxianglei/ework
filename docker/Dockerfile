# ework all-in-one container — npm-driven, bundles the user's full runtime:
#   ework-web + ework-daemon + ework-router (platform)
#   opencode-stable (runtime binary, installs as `opencode`)
#   opencode-acp + omo-stable (plugins, wired into the daemon's opencode config)
#
# Build from the monorepo root (or straight from GitHub):
#   docker build -t ework -f docker/Dockerfile .
#   docker build -t ework -f docker/Dockerfile https://github.com/ranxianglei/ework.git
#
# No build context staging required: everything installs from npm at build
# time (the old packages/web/docker flow COPY'd sources + staged binaries —
# that layout broke with the monorepo move; this one is context-independent).
#
# Base is Ubuntu (glibc): opencode ships glibc binaries; alpine/musl would
# need a separate musl build.

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

# ── 1. System deps ─────────────────────────────────────────────────────────
# nodejs+npm install the platform services; sqlite3 for ops/debugging inside
# the container; supervisor supervises web+daemon+router; ripgrep is used by
# opencode's grep tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl openssl git sqlite3 supervisor ripgrep \
        nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Bun runtime ─────────────────────────────────────────────────────────
# The services are Bun programs (Bun.serve / bun:sqlite). Vendor a pinned bun
# from npm (works even where bun.sh is blocked) via the official npm package.
RUN npm install -g --unsafe-perm bun@1.3.14 && bun --version

# ── 3. Platform + runtime from npm ─────────────────────────────────────────
# Pin nothing here by default: `latest` images track the npm releases, which
# is the deployment contract for this stack. Override any pin with a build
# arg (e.g. --build-arg EWORK_WEB_VERSION=0.10.135).
ARG EWORK_WEB_VERSION=latest
ARG EWORK_DAEMON_VERSION=latest
ARG EWORK_ROUTER_VERSION=latest
ARG OPENCODE_STABLE_VERSION=latest
ARG OPENCODE_EWORK_VERSION=latest

RUN npm install -g --unsafe-perm \
        ework-web@${EWORK_WEB_VERSION} \
        ework-daemon@${EWORK_DAEMON_VERSION} \
        ework-router@${EWORK_ROUTER_VERSION} \
        opencode-stable@${OPENCODE_STABLE_VERSION} \
        opencode-ework@${OPENCODE_EWORK_VERSION}

# Smoke the runtime at build time: this both validates the install and warms
# any first-run download opencode-stable's launcher performs.
RUN opencode --version

# opencode-acp + omo-stable are referenced by name ("@latest") in the
# daemon's opencode config; opencode installs them into its config-dir
# node_modules on first load (cached in /data thereafter). Pre-warming them
# globally keeps the absolute-path fallback available for offline boots.
RUN npm install -g --unsafe-perm opencode-acp@latest omo-stable@latest || \
    echo "WARN: plugin pre-install failed; they will install on first boot"

# ── 4. Supervisord + entrypoint ────────────────────────────────────────────
COPY docker/supervisord.conf /etc/supervisor/conf.d/ework.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── 5. Runtime ─────────────────────────────────────────────────────────────
# /data holds all mutable state (web DB, daemon DB, attachments, opencode
# workdirs, opencode config + plugins) — mount as a volume.
RUN mkdir -p /data
VOLUME ["/data"]

# ework-web :3002 (web UI + Gitea-compat API)
# ework-daemon :3101 (webhook receiver + engine)
# ework-router :3104 (optional multi-daemon router)
EXPOSE 3002 3101 3104

ENV HOME=/data
ENTRYPOINT ["/entrypoint.sh"]

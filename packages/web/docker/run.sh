#!/usr/bin/env bash
# Launch the ework all-in-one container.
#
# Prereqs: docker/.env.docker exists (cp docker/.env.docker.example).
# Image ework-aio:latest exists (./docker/build.sh).
#
# Defaults publish on host ports 3002/3101. Override with env vars if those
# are taken (e.g. on this dev box systemd already owns 3002/3101):
#   HOST_PORT_WEB=13002 HOST_PORT_DAEMON=13101 ./docker/run.sh
#
# Container restarts automatically unless explicitly stopped
# (docker stop ework-aio && docker rm ework-aio).
set -euo pipefail

TAG="${1:-ework-aio:latest}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/docker/.env.docker"

CONTAINER_NAME="${CONTAINER_NAME:-ework-aio}"
VOLUME_NAME="${VOLUME_NAME:-ework-data}"
HOST_PORT_WEB="${HOST_PORT_WEB:-3002}"
HOST_PORT_DAEMON="${HOST_PORT_DAEMON:-3101}"
# Bind address for published ports. Default 127.0.0.1 (loopback only).
# Set HOST_BIND_ADDR=0.0.0.0 to expose on all interfaces (LAN/Tailscale).
HOST_BIND_ADDR="${HOST_BIND_ADDR:-127.0.0.1}"

[[ -f "$ENV_FILE" ]] || {
  echo "ERROR: $ENV_FILE not found." >&2
  echo "  cp docker/.env.docker.example docker/.env.docker" >&2
  echo "  (then edit WORK_TOKEN / WORK_COOKIE_SECRET / GITEA_WEBHOOK_SECRET)" >&2
  exit 1
}

docker image inspect "$TAG" >/dev/null 2>&1 || {
  echo "ERROR: image $TAG not found. Run ./docker/build.sh first." >&2
  exit 1
}

# Recreate container if it exists (so re-running run.sh picks up env changes).
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "stopping+removing existing container $CONTAINER_NAME"
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

docker volume create "$VOLUME_NAME" >/dev/null 2>&1 || true

echo "launching $CONTAINER_NAME from $TAG"
echo "  web:    http://${HOST_BIND_ADDR}:$HOST_PORT_WEB"
echo "  daemon: http://${HOST_BIND_ADDR}:$HOST_PORT_DAEMON/webhook/gitea"

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_BIND_ADDR}:${HOST_PORT_WEB}:3002" \
  -p "${HOST_BIND_ADDR}:${HOST_PORT_DAEMON}:3101" \
  -v "${VOLUME_NAME}:/data" \
  --env-file "$ENV_FILE" \
  "$TAG"

echo
echo "=== $CONTAINER_NAME launched ==="
echo "logs:     docker logs -f $CONTAINER_NAME"
echo "status:   docker ps --filter name=$CONTAINER_NAME"
echo "stop:     docker stop $CONTAINER_NAME"
echo "restart:  docker restart $CONTAINER_NAME"

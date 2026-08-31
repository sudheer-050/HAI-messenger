#!/usr/bin/env bash
# Mika fast-path deploy (MYAG-197)
#
# Tags the currently-running backend image as "last-good" BEFORE building and
# deploying the new one, so rollback.sh always has something known-working to
# restore to. Only ever touches the `backend` service -- this pipeline is
# scoped to docker-compose.yml / deploy tooling, not the app's source files.
#
# TARGET_COMPOSE_DIR defaults to the current repo checkout so local/CI runs
# are safe by default. Pointing this at the real production compose
# directory on the home server is a separate, explicit operational step --
# see README.md.
set -euo pipefail

COMPOSE_DIR="${TARGET_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SERVICE="${MIKA_FASTPATH_SERVICE:-backend}"
IMAGE_NAME="${MIKA_FASTPATH_IMAGE:-hurricane-backend}"

cd "$COMPOSE_DIR"

echo "[deploy] tagging current $SERVICE image as ${IMAGE_NAME}:last-good"
CURRENT_ID="$(docker compose images -q "$SERVICE" 2>/dev/null || true)"
if [ -n "$CURRENT_ID" ]; then
    docker tag "$CURRENT_ID" "${IMAGE_NAME}:last-good"
else
    echo "[deploy] no currently-running $SERVICE image found -- first deploy, nothing to preserve for rollback"
fi

echo "[deploy] building and starting $SERVICE"
docker compose build "$SERVICE"
docker compose up -d "$SERVICE"

echo "[deploy] waiting for container to report healthy/running"
for i in $(seq 1 15); do
    STATE="$(docker compose ps -q "$SERVICE" | xargs -r docker inspect -f '{{.State.Status}}' || true)"
    if [ "$STATE" = "running" ]; then
        echo "[deploy] $SERVICE is running"
        exit 0
    fi
    sleep 1
done

echo "[deploy] $SERVICE did not reach running state in time" >&2
exit 1

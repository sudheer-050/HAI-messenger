#!/usr/bin/env bash
# Mika fast-path rollback (MYAG-197)
#
# Restores the backend service to the image tagged "last-good" by deploy.sh
# immediately before the fast-path deploy. Fails loudly (non-zero exit) if
# there is no last-good image to restore -- silently doing nothing would look
# like a successful rollback when it isn't.
set -euo pipefail

COMPOSE_DIR="${TARGET_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SERVICE="${MIKA_FASTPATH_SERVICE:-backend}"
IMAGE_NAME="${MIKA_FASTPATH_IMAGE:-hurricane-backend}"

cd "$COMPOSE_DIR"

if ! docker image inspect "${IMAGE_NAME}:last-good" > /dev/null 2>&1; then
    echo "[rollback] no ${IMAGE_NAME}:last-good image found -- cannot roll back" >&2
    exit 1
fi

echo "[rollback] restoring $SERVICE to ${IMAGE_NAME}:last-good"
docker tag "${IMAGE_NAME}:last-good" "${IMAGE_NAME}:latest"
docker compose up -d --no-build "$SERVICE"

for i in $(seq 1 15); do
    STATE="$(docker compose ps -q "$SERVICE" | xargs -r docker inspect -f '{{.State.Status}}' || true)"
    if [ "$STATE" = "running" ]; then
        echo "[rollback] $SERVICE restored and running"
        exit 0
    fi
    sleep 1
done

echo "[rollback] $SERVICE did not reach running state after rollback" >&2
exit 1

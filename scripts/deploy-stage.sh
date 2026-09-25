#!/usr/bin/env bash
# Stage deployment. Runs on the stage host: the deploy_stage CI job streams it over
# SSH (`bash -s`). It automates the documented manual procedure and changes nothing
# about it: the same checkout, compose files and env file. Never prints secrets.
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/var/www/html/bt-erp-replica-api}
CONFIG_DIR="$HOME/.config/bt-erp-replica-api"
CONTAINER=bt-erp-replica-api-api-1
COMPOSE=(
    docker compose
    -f compose.yaml
    -f "$CONFIG_DIR/compose.staging.yaml"
    --env-file "$CONFIG_DIR/staging.env"
)

trap 'echo "Stage deployment failed (line $LINENO)." >&2' ERR

for path in "$CONFIG_DIR/compose.staging.yaml" "$CONFIG_DIR/staging.env"; do
    if [[ ! -r $path ]]; then
        echo "Required staging file is not readable: $path" >&2
        exit 1
    fi
done

cd "$APP_DIR"

echo "Updating checkout..."
git fetch origin
git switch master
git pull --ff-only origin master
echo "Deploying commit $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

echo "Building and starting containers..."
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps

# The server checks replica connectivity before it listens, so "running" alone can
# precede an exit. Wait until the process answers /health inside the container.
echo "Waiting for $CONTAINER to serve /health..."
for _ in $(seq 1 30); do
    status=$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
    if [[ $status != running && $status != created && $status != restarting ]]; then
        echo "Container $CONTAINER is not running (state: $status)." >&2
        "${COMPOSE[@]}" logs --tail 50 api >&2 || true
        exit 1
    fi
    if [[ $status == running ]] && docker exec "$CONTAINER" node -e \
        "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
        echo "Container $CONTAINER is running and healthy."
        exit 0
    fi
    sleep 2
done

echo "Container $CONTAINER did not become healthy within 60 seconds." >&2
"${COMPOSE[@]}" ps >&2 || true
"${COMPOSE[@]}" logs --tail 50 api >&2 || true
exit 1

#!/usr/bin/env bash
# Stage smoke test. Runs on the stage host: the smoke_stage CI job streams it over
# SSH (`bash -s -- <base-url>`) and checks the published API address.
# Uses no token: /health is public, and an unauthenticated /vehicles request must be
# rejected with 401 before any replica access. Response bodies are never printed.
set -Eeuo pipefail

BASE_URL=${1:?Usage: smoke-stage.sh <base-url>}
BASE_URL=${BASE_URL%/}

if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required on the stage host." >&2
    exit 1
fi

healthy=false
for _ in $(seq 1 15); do
    if body=$(curl --fail --silent --show-error --max-time 5 "$BASE_URL/health" 2>/dev/null) \
        && [[ $body =~ \"status\"[[:space:]]*:[[:space:]]*\"ok\" ]]; then
        healthy=true
        break
    fi
    sleep 2
done
if [[ $healthy != true ]]; then
    echo "Smoke failed: $BASE_URL/health did not return status ok." >&2
    exit 1
fi
echo "OK   GET /health -> 200 {\"status\":\"ok\"}"

status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$BASE_URL/vehicles?per_page=1" || true)
if [[ $status != 401 ]]; then
    echo "Smoke failed: unauthenticated GET /vehicles returned HTTP $status, expected 401." >&2
    exit 1
fi
echo "OK   GET /vehicles without token -> 401 (authentication enforced)"
echo "Stage smoke test passed: $BASE_URL"

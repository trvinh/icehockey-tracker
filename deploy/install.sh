#!/usr/bin/env bash
# Build/restart Hockey Log and publish it with Tailscale Funnel on https://<host>.ts.net:8443/
# Usage: deploy/install.sh            (safe to re-run after `git pull`)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
fi
if ! grep -qE '^HOCKEY_TOKEN=.{20,}' .env; then
  token=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
  sed -i "s|^HOCKEY_TOKEN=.*|HOCKEY_TOKEN=${token}|" .env
  echo "Generated a sync password in .env (HOCKEY_TOKEN). Enter it in the app under Settings → Sync password."
fi
grep -qE '^GOOGLE_MAPS_KEY=.+' .env || echo "Note: GOOGLE_MAPS_KEY is empty in .env; distance lookups will not work until it is set."

set -a; source .env; set +a
mkdir -p "${HOCKEY_DATA_DIR:-./data}"

docker compose up -d --build
for i in {1..20}; do
  curl -fsS "http://127.0.0.1:${HOCKEY_HOST_PORT:-8090}/api/health" >/dev/null && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${HOCKEY_HOST_PORT:-8090}/api/health" && echo

# Public HTTPS via Funnel on port 8443 (Funnel allows 443, 8443 and 10000; 443 is used by Jellyfin serve).
if sudo tailscale funnel --bg --https=8443 "http://127.0.0.1:${HOCKEY_HOST_PORT:-8090}"; then
  echo "Hockey Log: https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'):8443/"
else
  echo "Funnel could not be enabled. Allow Funnel for this device in the Tailscale admin console (Access controls → nodeAttrs 'funnel'), then re-run." >&2
  exit 1
fi

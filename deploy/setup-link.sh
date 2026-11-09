#!/usr/bin/env bash
# Print a one-time setup link that stores the sync password in the app (open it once per browser).
# The password is in the part after '#', which browsers never send to the server.
# Run it yourself in a terminal; do not paste the output into chats.
set -euo pipefail
cd "$(dirname "$0")/.."
token=$(grep '^HOCKEY_TOKEN=' .env | cut -d= -f2- | tr -d '\r\n"'"'")
host=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo "https://${host}:8443/#token=${token}"

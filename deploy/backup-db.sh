#!/usr/bin/env bash
# Write a consistent copy of the Hockey Log database (safe while the app is running).
# Usage: deploy/backup-db.sh <destination-file>
set -euo pipefail
dest=${1:?usage: backup-db.sh <destination-file>}
mkdir -p "$(dirname "$dest")"
docker exec hockeylog python -c "import sqlite3; s=sqlite3.connect('/data/hockey.db'); d=sqlite3.connect('/data/.backup.db'); s.backup(d); d.close()"
cd "$(dirname "$0")/.."
set -a; source .env; set +a
mv "${HOCKEY_DATA_DIR:-./data}/.backup.db" "$dest"

# Hockey Log

A personal web app (PWA) for logging ice hockey game days: date, type (league / tournament / friendly),
competition, rink, and for each opponent that day the player's goals and assists. Stats count game days:
goals, assists, per-opponent table with team logos, per-rink table, total driving distance
(Google Routes API, cached once per rink) and a map with curved home → rink arrows labelled with km.

Plain HTML/CSS/JS, no build step. Only dependency: Leaflet 1.9.4 (vendored in `vendor/leaflet`, BSD-2) with OpenStreetMap tiles. Data is stored in the browser's localStorage on the phone.

## Files
- `index.html`, `style.css`, `app.js` – the app
- `manifest.webmanifest`, `icons/` – Home Screen install
- `sw.js` – offline cache (bump `VERSION` after changing any file)
- `vendor/leaflet/` – map library

## Hosting (needs HTTPS for install + offline)
**GitHub Pages:** create a repo (e.g. `hockey-log`), push these files to `main`,
then Settings → Pages → Deploy from branch `main` / root. URL: `https://<user>.github.io/hockey-log/`.

Local test: `python3 -m http.server 8000` in this folder, open http://localhost:8000.

## Install on iPhone
Open the URL in Safari → Share → **Add to Home Screen**. Open it from the icon from then on
(the Home Screen app keeps its own data, separate from the Safari tab).

## Google Maps distances
1. Google Cloud Console → create a project, enable billing (monthly free credit covers this use).
2. Enable **Routes API**.
3. Credentials → Create API key → restrict it:
   - Application restriction: *Websites*, add `https://<user>.github.io/*`
   - API restriction: *Routes API* only
4. Paste the key and your home address into the app's Settings.

Each rink is looked up once when created (one-way km and coordinates for the map, shown in Rinks).
Rinks with a hand-typed distance have no coordinates and are left off the map until looked up. A trip = one game day at one
rink; totals count round trips by default (toggle in Settings). Distances can also be typed manually.

## Backup
Settings → Export data saves a JSON file (save it to iCloud Drive). Import replaces all data.
iOS may clear website data under storage pressure, so export now and then.
Team logos (scaled to 96 px PNG) are part of the export. Old v1 exports are converted on import.
The JSON format (schema version 2) is also the planned import format for a future vinh-hp sync backend.

## Home server with sync (vinh-hp)

The same code also runs as a small self-hosted server: `server/server.py` (Python standard library + SQLite)
serves the app and a sync API. When the app is opened from the server, it syncs game days, teams, rinks and
shared settings between devices (offline-first; last write wins per record). Opened from GitHub Pages it
stays local-only.

```bash
git clone https://github.com/trvinh/icehockey-tracker /home/vinh/projects/icehockey-tracker
cd /home/vinh/projects/icehockey-tracker
deploy/install.sh        # creates .env with a random HOCKEY_TOKEN, builds, starts, enables Funnel on :8443
```

- Public URL: `https://<machine>.ts.net:8443/` via Tailscale Funnel. All `/api/*` calls need the sync password
  (`HOCKEY_TOKEN` in `.env`); enter it once per device under Settings → Sync password.
- `GOOGLE_MAPS_KEY` in `.env` lets the server do distance lookups (key restricted to the Routes API).
- Data: SQLite in `HOCKEY_DATA_DIR` (default `./data`). Consistent backup: `deploy/backup-db.sh <dest-file>`.
- Update: `git pull && deploy/install.sh`. Tests: `python3 -m unittest discover -s tests`.
- Moving from GitHub Pages: Settings → Export in the old app, then Settings → Import in the server app.

# Hockey Log

A personal web app (PWA) for logging ice hockey games: date, type (league / tournament / friendly),
competition, rink, opponent, score, goals and assists. Stats: game days, games, points, per-opponent
and per-rink tables, and total driving distance (Google Routes API, cached once per rink).

Plain HTML/CSS/JS, no build step, no dependencies. Data is stored in the browser's localStorage on the phone.

## Files
- `index.html`, `style.css`, `app.js` – the app
- `manifest.webmanifest`, `icons/` – Home Screen install
- `sw.js` – offline cache (bump `VERSION` after changing any file)

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

Each rink is looked up once when created (one-way km, shown in Rinks). A trip = one game day at one
rink; totals count round trips by default (toggle in Settings). Distances can also be typed manually.

## Backup
Settings → Export data saves a JSON file (save it to iCloud Drive). Import replaces all data.
iOS may clear website data under storage pressure, so export now and then.
The JSON format (schema version 1) is also the planned import format for a future vinh-hp sync backend.

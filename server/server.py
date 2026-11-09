"""Hockey Log sync server.

Serves the static PWA and a tiny sync API backed by SQLite. Python standard library only.

API (JSON):
  GET  /api/health                 -> {"ok": true, "routes": bool}
  GET  /api/changes?since=<seq>    -> {"seq": int, "records": [record, ...]}
  POST /api/push  {"records": [...]} -> {"seq": int, "applied": int}
  POST /api/route {"from": str, "to": str} -> {"km", "minutes", "from": {lat,lng}, "to": {lat,lng}}

A record is {"kind": "day"|"team"|"stadium"|"settings", "id": str, "data": obj|null,
"updatedAt": ISO-8601 str, "deleted": bool}. Conflicts are last-write-wins per record on updatedAt.

Environment:
  HOCKEY_DB        path to the SQLite file (default /data/hockey.db)
  HOCKEY_WEB_DIR   directory with the static app (default: repo root next to this file)
  HOCKEY_PORT      listen port (default 8090), HOCKEY_HOST (default 0.0.0.0 inside the container)
  HOCKEY_TOKEN     required (min. 20 chars): /api/* needs "Authorization: Bearer <token>".
                   Set HOCKEY_ALLOW_NO_AUTH=1 to run without it (only for local testing).
  GOOGLE_MAPS_KEY  optional; enables /api/route (Google Routes API, server-side key)
"""

from __future__ import annotations

import hmac
import json
import logging
import mimetypes
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

KINDS = {"day", "team", "stadium", "settings"}
MAX_BODY = 20 * 1024 * 1024  # logos are small, but a first push carries everything
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"

log = logging.getLogger("hockeylog")


class FailureLimiter:
    """Slows down wrong passwords: after `limit` failures within `window` s, each further failure waits.

    It never blocks the correct password (a hard lockout let one device with an empty or wrong
    password lock out every device). The token is long and random, so guessing is not feasible
    anyway; this keeps scanners slow and the logs quiet.
    """

    def __init__(self, limit: int = 20, window: float = 60.0):
        self.limit, self.window = limit, window
        self._times: list[float] = []
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        self._times = [t for t in self._times if now - t < self.window]

    def penalty(self) -> float:
        with self._lock:
            self._prune(time.monotonic())
            return 1.0 if len(self._times) >= self.limit else 0.0

    def record(self) -> None:
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            self._times.append(now)


FAILS = FailureLimiter()


class Store:
    """SQLite record store with a global change sequence for incremental pulls."""

    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS records (
              kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT,
              updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
              seq INTEGER NOT NULL, PRIMARY KEY (kind, id));
            CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            INSERT OR IGNORE INTO meta VALUES ('seq', 0);
            """
        )

    def _next_seq(self) -> int:
        self._db.execute("UPDATE meta SET value = value + 1 WHERE key = 'seq'")
        return self._db.execute("SELECT value FROM meta WHERE key = 'seq'").fetchone()[0]

    def current_seq(self) -> int:
        return self._db.execute("SELECT value FROM meta WHERE key = 'seq'").fetchone()[0]

    def push(self, records: list[dict]) -> int:
        applied = 0
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                for r in records:
                    row = self._db.execute(
                        "SELECT updated_at FROM records WHERE kind = ? AND id = ?", (r["kind"], r["id"])
                    ).fetchone()
                    seq = self._next_seq()
                    if row and row[0] > r["updatedAt"]:
                        # Stored version is newer: re-announce it so the pusher pulls it back.
                        self._db.execute("UPDATE records SET seq = ? WHERE kind = ? AND id = ?", (seq, r["kind"], r["id"]))
                        continue
                    self._db.execute(
                        "INSERT INTO records (kind, id, data, updated_at, deleted, seq) VALUES (?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, "
                        "deleted = excluded.deleted, seq = excluded.seq",
                        (r["kind"], r["id"], None if r["deleted"] else json.dumps(r["data"], separators=(",", ":")),
                         r["updatedAt"], int(r["deleted"]), seq),
                    )
                    applied += 1
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
        return applied

    def changes(self, since: int) -> tuple[int, list[dict]]:
        with self._lock:
            seq = self.current_seq()
            rows = self._db.execute(
                "SELECT kind, id, data, updated_at, deleted FROM records WHERE seq > ? AND seq <= ? ORDER BY seq",
                (since, seq),
            ).fetchall()
        return seq, [
            {"kind": k, "id": i, "data": json.loads(d) if d else None, "updatedAt": u, "deleted": bool(x)}
            for k, i, d, u, x in rows
        ]


def validate_records(payload) -> list[dict]:
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise ValueError("expected {\"records\": [...]}")
    out = []
    for r in payload["records"]:
        if not isinstance(r, dict):
            raise ValueError("record must be an object")
        kind, rid, upd = r.get("kind"), r.get("id"), r.get("updatedAt")
        deleted = bool(r.get("deleted"))
        if kind not in KINDS or not isinstance(rid, str) or not rid or len(rid) > 100:
            raise ValueError(f"bad record kind/id: {kind!r} {rid!r}")
        if not isinstance(upd, str) or len(upd) < 20 or len(upd) > 40:
            raise ValueError(f"bad updatedAt for {kind}/{rid}")
        if not deleted and not isinstance(r.get("data"), dict):
            raise ValueError(f"missing data for {kind}/{rid}")
        out.append({"kind": kind, "id": rid, "data": r.get("data"), "updatedAt": upd, "deleted": deleted})
    return out


def google_route(key: str, origin: str, destination: str) -> dict:
    body = json.dumps({"origin": {"address": origin}, "destination": {"address": destination}, "travelMode": "DRIVE"}).encode()
    req = urllib.request.Request(ROUTES_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.legs.startLocation,routes.legs.endLocation",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.load(res)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error", {}).get("message")
        except Exception:  # noqa: BLE001 - best effort error text
            msg = None
        raise ValueError(msg or f"Google returned HTTP {e.code}") from e
    route = (data.get("routes") or [None])[0]
    if not route or route.get("distanceMeters") is None:
        raise ValueError("No driving route found for this address")
    leg = (route.get("legs") or [{}])[0]

    def ll(loc):
        p = (loc or {}).get("latLng")
        return {"lat": p["latitude"], "lng": p["longitude"]} if p else None

    dur = route.get("duration")
    return {
        "km": route["distanceMeters"] / 1000,
        "minutes": round(int(dur.rstrip("s")) / 60) if dur else None,
        "from": ll(leg.get("startLocation")),
        "to": ll(leg.get("endLocation")),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "HockeyLog/1"
    store: Store
    web_dir: Path
    token: str | None
    maps_key: str | None

    def log_message(self, fmt, *args):  # route through logging, without query strings
        log.info("%s %s", self.address_string(), fmt % args)

    def _json(self, status: int, obj) -> None:
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not self.token:
            return True
        got = self.headers.get("Authorization", "").strip()
        ok = hmac.compare_digest(got.encode(), f"Bearer {self.token}".encode())
        if not ok:
            FAILS.record()
            log.warning("rejected request: %s password", "missing" if not got else "wrong")
            time.sleep(FAILS.penalty())
        return ok

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("missing or too large request body")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            if url.path == "/api/health":
                return self._json(200, {"ok": True, "routes": bool(self.maps_key), "auth": bool(self.token)})
            if not self._authorized():
                return self._json(401, {"error": "unauthorized"})
            if url.path == "/api/changes":
                try:
                    since = int(parse_qs(url.query).get("since", ["0"])[0])
                except ValueError:
                    return self._json(400, {"error": "bad since"})
                seq, records = self.store.changes(since)
                return self._json(200, {"seq": seq, "records": records})
            return self._json(404, {"error": "not found"})
        self._static(url.path)

    def do_POST(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return self._json(405, {"error": "method not allowed"})
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        try:
            payload = self._read_json()
            if url.path == "/api/push":
                applied = self.store.push(validate_records(payload))
                return self._json(200, {"seq": self.store.current_seq(), "applied": applied})
            if url.path == "/api/route":
                if not self.maps_key:
                    return self._json(503, {"error": "GOOGLE_MAPS_KEY is not set on the server"})
                origin, dest = payload.get("from"), payload.get("to")
                if not isinstance(origin, str) or not origin.strip() or not isinstance(dest, str) or not dest.strip():
                    return self._json(400, {"error": "from and to addresses are required"})
                return self._json(200, google_route(self.maps_key, origin.strip(), dest.strip()))
            return self._json(404, {"error": "not found"})
        except (ValueError, json.JSONDecodeError) as e:
            return self._json(400, {"error": str(e)})
        except Exception:  # noqa: BLE001 - never leak internals to the client
            log.exception("request failed")
            return self._json(500, {"error": "server error"})

    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (self.web_dir / rel).resolve()
        if not target.is_relative_to(self.web_dir) or not target.is_file() or any(p.startswith(".") for p in Path(rel).parts):
            target = None
        if target is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # App files change on deploy; the service worker provides offline copies.
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def make_server(db_path: str, web_dir: str, host: str, port: int, token: str | None, maps_key: str | None):
    handler = type("BoundHandler", (Handler,), {
        "store": Store(db_path), "web_dir": Path(web_dir).resolve(), "token": token or None, "maps_key": maps_key or None,
    })
    return ThreadingHTTPServer((host, port), handler)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    default_web = Path(__file__).resolve().parent.parent
    token = os.environ.get("HOCKEY_TOKEN", "").strip().strip('"').strip("'")
    if len(token) < 20 and os.environ.get("HOCKEY_ALLOW_NO_AUTH") != "1":
        sys.exit("HOCKEY_TOKEN must be set to a random string of at least 20 characters "
                 "(e.g. `python3 -c 'import secrets; print(secrets.token_urlsafe(24))'`).")
    srv = make_server(
        db_path=os.environ.get("HOCKEY_DB", "/data/hockey.db"),
        web_dir=os.environ.get("HOCKEY_WEB_DIR", str(default_web)),
        host=os.environ.get("HOCKEY_HOST", "0.0.0.0"),
        port=int(os.environ.get("HOCKEY_PORT", "8090")),
        token=token.strip().strip('"').strip("'") or None,
        maps_key=os.environ.get("GOOGLE_MAPS_KEY"),
    )
    log.info("Hockey Log listening on %s:%s (routes=%s, auth=%s)", *srv.server_address[:2],
             bool(os.environ.get("GOOGLE_MAPS_KEY")), bool(token))
    srv.serve_forever()


if __name__ == "__main__":
    main()

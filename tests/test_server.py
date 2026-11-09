"""Unit tests for the sync server (stdlib unittest). Run: python3 -m unittest discover -s tests"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import server  # noqa: E402

TOKEN = "t" * 24


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        web = Path(self.tmp.name, "web"); web.mkdir()
        (web / "index.html").write_text("<h1>hi</h1>")
        (web / ".secret").write_text("no")
        server.FAILS = server.FailureLimiter(limit=3, window=60)
        self.srv = server.make_server(str(Path(self.tmp.name, "db", "h.db")), str(web), "127.0.0.1", 0, TOKEN, None)
        self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close(); self.tmp.cleanup()

    def call(self, path, body=None, token=TOKEN):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers,
                                     method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e) if e.headers.get_content_type() == "application/json" else None

    def rec(self, rid, upd, name="A", deleted=False):
        return {"kind": "team", "id": rid, "data": None if deleted else {"id": rid, "name": name}, "updatedAt": upd, "deleted": deleted}

    def test_auth_required(self):
        self.assertEqual(self.call("/api/health", token=None)[0], 200)
        self.assertEqual(self.call("/api/changes?since=0", token=None)[0], 401)
        self.assertEqual(self.call("/api/changes?since=0", token="wrong-token-wrong-token")[0], 401)

    def test_lockout_after_failures(self):
        for _ in range(3):
            self.call("/api/changes?since=0", token="bad")
        self.assertEqual(self.call("/api/changes?since=0")[0], 401)  # even the right token waits out the window

    def test_push_pull_and_incremental(self):
        st, res = self.call("/api/push", {"records": [self.rec("1", "2026-11-09T10:00:00.000Z")]})
        self.assertEqual((st, res["applied"]), (200, 1))
        st, res = self.call("/api/changes?since=0")
        self.assertEqual([r["id"] for r in res["records"]], ["1"])
        seq = res["seq"]
        self.assertEqual(self.call(f"/api/changes?since={seq}")[1]["records"], [])

    def test_last_write_wins_and_reannounce(self):
        self.call("/api/push", {"records": [self.rec("1", "2026-11-09T12:00:00.000Z", "new")]})
        seq = self.call("/api/changes?since=0")[1]["seq"]
        _, res = self.call("/api/push", {"records": [self.rec("1", "2026-11-09T11:00:00.000Z", "old")]})
        self.assertEqual(res["applied"], 0)
        recs = self.call(f"/api/changes?since={seq}")[1]["records"]
        self.assertEqual(recs[0]["data"]["name"], "new")  # stale pusher gets the winner back

    def test_delete_tombstone(self):
        self.call("/api/push", {"records": [self.rec("1", "2026-11-09T10:00:00.000Z")]})
        self.call("/api/push", {"records": [self.rec("1", "2026-11-09T10:05:00.000Z", deleted=True)]})
        recs = self.call("/api/changes?since=0")[1]["records"]
        self.assertTrue(recs[0]["deleted"])
        self.assertIsNone(recs[0]["data"])

    def test_validation(self):
        self.assertEqual(self.call("/api/push", {"records": [{"kind": "evil", "id": "1"}]})[0], 400)
        self.assertEqual(self.call("/api/push", {"nope": 1})[0], 400)

    def test_route_without_key(self):
        self.assertEqual(self.call("/api/route", {"from": "a", "to": "b"})[0], 503)

    def test_static_and_traversal(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(b"hi", r.read())
        for bad in ["/.secret", "/../db/h.db", "/%2e%2e/db/h.db"]:
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(self.base + bad)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""
LeetCode Tracker - a local dashboard for everything you've solved.

Runs a small web server on your machine, keeps a SQLite database of your
solved problems, and polls LeetCode in the background so the list stays
up to date as you keep solving.

Usage:
    python leetcode_tracker.py            # start the dashboard
    python leetcode_tracker.py sync       # one-off sync, no server
    python leetcode_tracker.py catalog    # rebuild the problem catalog
    python leetcode_tracker.py export     # dump solved.csv and quit

Only the Python standard library is used - nothing to pip install.
"""

import csv
import io
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "tracker.db")
CONFIG_PATH = os.path.join(HERE, "config.json")
SECRETS_PATH = os.path.join(HERE, "secrets.json")

GRAPHQL = "https://leetcode.com/graphql"

DEFAULTS = {
    "username": "",
    "port": 8765,
    "poll_minutes": 10,
    "catalog_refresh_days": 7,
    "open_browser": True,
    # Days until a problem is due for review again, keyed by confidence 1-5.
    "review_intervals": {"1": 1, "2": 3, "3": 7, "4": 16, "5": 35},
}

# How far a problem with no confidence rating drifts before we nag about it.
DEFAULT_REVIEW_DAYS = 10


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------

def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)


def load_secrets():
    """Session cookie, if the user set one up. Never leaves this machine."""
    if os.path.exists(SECRETS_PATH):
        try:
            with open(SECRETS_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, OSError):
            return {}
    env = os.environ.get("LEETCODE_SESSION")
    return {"LEETCODE_SESSION": env} if env else {}


CONFIG = load_config()


# --------------------------------------------------------------------------
# database
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS catalog (
    slug        TEXT PRIMARY KEY,
    qid         INTEGER,
    title       TEXT,
    difficulty  TEXT,
    paid_only   INTEGER DEFAULT 0,
    ac_rate     REAL,
    topics      TEXT DEFAULT '[]',
    updated_at  INTEGER
);
CREATE TABLE IF NOT EXISTS solved (
    slug          TEXT PRIMARY KEY,
    first_ac      INTEGER,
    last_ac       INTEGER,
    ac_count      INTEGER DEFAULT 0,
    source        TEXT,
    discovered_at INTEGER
);
CREATE TABLE IF NOT EXISTS submissions (
    id   TEXT PRIMARY KEY,
    slug TEXT,
    ts   INTEGER
);
CREATE TABLE IF NOT EXISTS notes (
    slug         TEXT PRIMARY KEY,
    status       TEXT DEFAULT 'new',
    confidence   INTEGER DEFAULT 0,
    last_revised TEXT,
    revise_count INTEGER DEFAULT 0,
    note         TEXT DEFAULT '',
    starred      INTEGER DEFAULT 0,
    snooze_until TEXT,
    updated_at   INTEGER
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_submissions_slug ON submissions(slug);
"""


def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with db() as conn:
        conn.executescript(SCHEMA)


def meta_get(key, default=None):
    with db() as conn:
        row = conn.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
    return row["v"] if row else default


def meta_set(key, value):
    with db() as conn:
        conn.execute(
            "INSERT INTO meta(k, v) VALUES(?, ?) "
            "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (key, str(value)),
        )


# --------------------------------------------------------------------------
# leetcode client
# --------------------------------------------------------------------------

class LeetCode:
    def __init__(self, username, secrets=None):
        self.username = username
        self.secrets = secrets or {}

    def _headers(self):
        headers = {
            "Content-Type": "application/json",
            "Referer": "https://leetcode.com/problemset/",
            "Origin": "https://leetcode.com",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
        }
        session = self.secrets.get("LEETCODE_SESSION")
        if session:
            csrf = self.secrets.get("csrftoken", "")
            cookie = f"LEETCODE_SESSION={session}"
            if csrf:
                cookie += f"; csrftoken={csrf}"
                headers["x-csrftoken"] = csrf
            headers["Cookie"] = cookie
        return headers

    @property
    def authenticated(self):
        return bool(self.secrets.get("LEETCODE_SESSION"))

    def query(self, query, variables=None, retries=3):
        payload = json.dumps(
            {"query": query, "variables": variables or {}}
        ).encode("utf-8")
        last_error = None
        for attempt in range(retries):
            req = urllib.request.Request(
                GRAPHQL, data=payload, headers=self._headers(), method="POST"
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                if "errors" in body:
                    raise RuntimeError(body["errors"][0].get("message", "GraphQL error"))
                return body["data"]
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                # LeetCode throttles bursts; back off rather than hammering.
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"LeetCode request failed: {last_error}")

    # -- individual queries -------------------------------------------------

    def profile(self):
        data = self.query(
            """
            query($u: String!) {
              matchedUser(username: $u) {
                username
                profile { realName userAvatar ranking }
                submitStatsGlobal { acSubmissionNum { difficulty count } }
              }
            }
            """,
            {"u": self.username},
        )
        user = data.get("matchedUser")
        if not user:
            raise RuntimeError(f"No LeetCode user named '{self.username}'")
        counts = {
            item["difficulty"]: item["count"]
            for item in user["submitStatsGlobal"]["acSubmissionNum"]
        }
        return {
            "username": user["username"],
            "real_name": (user.get("profile") or {}).get("realName") or "",
            "avatar": (user.get("profile") or {}).get("userAvatar") or "",
            "ranking": (user.get("profile") or {}).get("ranking"),
            "total": counts.get("All", 0),
            "easy": counts.get("Easy", 0),
            "medium": counts.get("Medium", 0),
            "hard": counts.get("Hard", 0),
        }

    def calendar(self, year=None):
        year = year or date.today().year
        data = self.query(
            """
            query($u: String!, $y: Int) {
              matchedUser(username: $u) {
                userCalendar(year: $y) {
                  streak
                  totalActiveDays
                  submissionCalendar
                }
              }
            }
            """,
            {"u": self.username, "y": year},
        )
        cal = ((data.get("matchedUser") or {}).get("userCalendar")) or {}
        raw = cal.get("submissionCalendar") or "{}"
        try:
            days = json.loads(raw)
        except json.JSONDecodeError:
            days = {}
        return {
            "streak": cal.get("streak", 0),
            "active_days": cal.get("totalActiveDays", 0),
            "days": days,
        }

    def recent_accepted(self, limit=20):
        data = self.query(
            """
            query($u: String!, $l: Int) {
              recentAcSubmissionList(username: $u, limit: $l) {
                id title titleSlug timestamp
              }
            }
            """,
            {"u": self.username, "l": limit},
        )
        return data.get("recentAcSubmissionList") or []

    def problemset_page(self, skip, limit=100):
        data = self.query(
            """
            query problemsetQuestionListV2(
              $filters: QuestionFilterInput, $limit: Int,
              $skip: Int, $categorySlug: String
            ) {
              problemsetQuestionListV2(
                filters: $filters, limit: $limit,
                skip: $skip, categorySlug: $categorySlug
              ) {
                questions {
                  titleSlug title questionFrontendId
                  paidOnly difficulty acRate status
                  topicTags { name slug }
                }
                totalLength
                hasMore
              }
            }
            """,
            {
                "categorySlug": "all-code-essentials",
                "filters": {"filterCombineType": "ALL"},
                "limit": limit,
                "skip": skip,
            },
        )
        return data["problemsetQuestionListV2"]

    def question(self, slug):
        data = self.query(
            """
            query($s: String!) {
              question(titleSlug: $s) {
                questionFrontendId title difficulty isPaidOnly
                topicTags { name slug }
              }
            }
            """,
            {"s": slug},
        )
        return data.get("question")


# --------------------------------------------------------------------------
# sync
# --------------------------------------------------------------------------

SYNC_STATE = {
    "running": False,
    "message": "idle",
    "progress": 0,
    "last_sync": None,
    "last_error": None,
}
SYNC_LOCK = threading.Lock()


def _now():
    return int(time.time())


def _norm_difficulty(value):
    if not value:
        return "Unknown"
    return {"EASY": "Easy", "MEDIUM": "Medium", "HARD": "Hard"}.get(
        value.upper(), value.capitalize()
    )


def upsert_catalog(conn, rows):
    conn.executemany(
        """
        INSERT INTO catalog(slug, qid, title, difficulty, paid_only, ac_rate,
                            topics, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            qid=excluded.qid, title=excluded.title,
            difficulty=excluded.difficulty, paid_only=excluded.paid_only,
            ac_rate=excluded.ac_rate, topics=excluded.topics,
            updated_at=excluded.updated_at
        """,
        rows,
    )


def mark_solved(conn, slug, ts=None, source="recent"):
    """Record a slug as solved, keeping the earliest timestamp we've seen."""
    row = conn.execute("SELECT * FROM solved WHERE slug=?", (slug,)).fetchone()
    if row is None:
        # ac_count starts at 0; sync_recent increments it per newly seen
        # submission id, so it never double-counts the first one.
        conn.execute(
            "INSERT INTO solved(slug, first_ac, last_ac, ac_count, source, "
            "discovered_at) VALUES(?, ?, ?, 0, ?, ?)",
            (slug, ts, ts, source, _now()),
        )
        conn.execute(
            "INSERT OR IGNORE INTO notes(slug, updated_at) VALUES(?, ?)",
            (slug, _now()),
        )
        return True
    if ts:
        first = min(x for x in (row["first_ac"], ts) if x)
        last = max(x for x in (row["last_ac"] or 0, ts))
        conn.execute(
            "UPDATE solved SET first_ac=?, last_ac=? WHERE slug=?",
            (first, last, slug),
        )
    return False


def sync_catalog(client, force=False, report=None):
    """Pull the full problem list (titles, difficulty, topic tags).

    When a session cookie is configured, this also carries your AC status
    for every problem, which is how the full backfill happens.
    """
    report = report or (lambda msg, pct: None)
    last = meta_get("catalog_synced_at")
    age_days = CONFIG.get("catalog_refresh_days", 7)
    with db() as conn:
        count = conn.execute("SELECT COUNT(*) c FROM catalog").fetchone()["c"]
    if not force and count and last:
        if _now() - int(last) < age_days * 86400:
            return {"skipped": True, "problems": count, "solved_found": 0}

    skip, total, solved_found, seen = 0, None, 0, 0
    while True:
        page = client.problemset_page(skip=skip, limit=100)
        total = page["totalLength"]
        questions = page["questions"]
        if not questions:
            break
        rows = []
        ac_slugs = []
        for q in questions:
            topics = json.dumps([t["name"] for t in (q.get("topicTags") or [])])
            rows.append(
                (
                    q["titleSlug"],
                    int(q["questionFrontendId"]) if str(q["questionFrontendId"]).isdigit() else 0,
                    q["title"],
                    _norm_difficulty(q["difficulty"]),
                    1 if q.get("paidOnly") else 0,
                    q.get("acRate") or 0.0,
                    topics,
                    _now(),
                )
            )
            # LeetCode has used both "AC" and "SOLVED" for this field.
            if (q.get("status") or "").upper() in ("AC", "SOLVED", "ACCEPTED"):
                ac_slugs.append(q["titleSlug"])
        with db() as conn:
            upsert_catalog(conn, rows)
            for slug in ac_slugs:
                if mark_solved(conn, slug, ts=None, source="backfill"):
                    solved_found += 1
        seen += len(questions)
        pct = int(seen / total * 100) if total else 0
        report(f"Catalog {seen}/{total} problems", pct)
        if not page.get("hasMore"):
            break
        skip += 100
        time.sleep(0.35)  # be polite to the API

    meta_set("catalog_synced_at", _now())
    return {"skipped": False, "problems": seen, "solved_found": solved_found}


def sync_recent(client, limit=20):
    """Pick up newly accepted submissions (public, no cookie needed)."""
    subs = client.recent_accepted(limit=limit)
    new = 0
    with db() as conn:
        for sub in subs:
            ts = int(sub["timestamp"])
            slug = sub["titleSlug"]
            existing = conn.execute(
                "SELECT 1 FROM submissions WHERE id=?", (sub["id"],)
            ).fetchone()
            conn.execute(
                "INSERT OR IGNORE INTO submissions(id, slug, ts) VALUES(?, ?, ?)",
                (sub["id"], slug, ts),
            )
            if mark_solved(conn, slug, ts=ts, source="recent"):
                new += 1
            if not existing:
                conn.execute(
                    "UPDATE solved SET ac_count = ac_count + 1 WHERE slug=?", (slug,)
                )
    return new


def fill_missing_catalog(client, report=None):
    """Fetch metadata for solved problems missing from the catalog."""
    report = report or (lambda msg, pct: None)
    with db() as conn:
        missing = [
            r["slug"]
            for r in conn.execute(
                "SELECT s.slug FROM solved s "
                "LEFT JOIN catalog c ON c.slug = s.slug WHERE c.slug IS NULL"
            )
        ]
    for i, slug in enumerate(missing):
        try:
            q = client.question(slug)
        except RuntimeError:
            continue
        if not q:
            continue
        with db() as conn:
            upsert_catalog(
                conn,
                [
                    (
                        slug,
                        int(q["questionFrontendId"]) if str(q["questionFrontendId"]).isdigit() else 0,
                        q["title"],
                        _norm_difficulty(q["difficulty"]),
                        1 if q.get("isPaidOnly") else 0,
                        0.0,
                        json.dumps([t["name"] for t in (q.get("topicTags") or [])]),
                        _now(),
                    )
                ],
            )
        report(f"Filling metadata {i + 1}/{len(missing)}", 0)
        time.sleep(0.3)
    return len(missing)


def run_sync(full=False):
    """Full sync pass. Safe to call from any thread."""
    with SYNC_LOCK:
        if SYNC_STATE["running"]:
            return SYNC_STATE
        SYNC_STATE.update(running=True, message="Starting...", progress=0,
                          last_error=None)

    def report(msg, pct):
        SYNC_STATE.update(message=msg, progress=pct)

    secrets = load_secrets()
    client = LeetCode(CONFIG["username"], secrets)
    try:
        report("Fetching profile...", 5)
        profile = client.profile()
        meta_set("profile", json.dumps(profile))

        report("Checking recent submissions...", 15)
        sync_recent(client)

        cat = sync_catalog(client, force=full, report=report)

        report("Filling gaps...", 92)
        fill_missing_catalog(client, report=report)

        try:
            report("Fetching streak...", 96)
            meta_set("calendar", json.dumps(client.calendar()))
        except RuntimeError:
            pass  # calendar is a nice-to-have, never fail the sync over it

        meta_set("last_sync", _now())
        SYNC_STATE.update(
            message=(
                "Synced"
                if cat.get("skipped")
                else f"Synced - catalog refreshed ({cat['problems']} problems)"
            ),
            progress=100,
            last_sync=_now(),
        )
    except Exception as exc:  # noqa: BLE001 - surface any failure in the UI
        SYNC_STATE.update(message=f"Sync failed: {exc}", last_error=str(exc))
    finally:
        SYNC_STATE["running"] = False
    return SYNC_STATE


def poll_loop():
    """Background thread: keep the database fresh while the server runs."""
    time.sleep(2)
    run_sync()
    while True:
        time.sleep(max(60, CONFIG.get("poll_minutes", 10) * 60))
        try:
            run_sync()
        except Exception:  # noqa: BLE001 - a bad poll must not kill the thread
            pass


# --------------------------------------------------------------------------
# read model
# --------------------------------------------------------------------------

def _is_unrated(status, confidence, last_revised, first_ac):
    """True when we have nothing to schedule from.

    Backfilled problems arrive with no solve date (LeetCode only dates recent
    submissions). Inventing a due date for all of them would dump the entire
    history into the review queue on the same day, so they wait in an
    "unrated" bucket until you give them a confidence score or revise them.
    """
    return not first_ac and not last_revised and not confidence and status == "new"


def _next_review(row_status, confidence, last_revised, first_ac, snooze_until):
    """Date a problem should next be looked at, as an ISO string."""
    if snooze_until:
        return snooze_until
    if row_status == "solid" and confidence >= 5:
        return None
    if _is_unrated(row_status, confidence, last_revised, first_ac):
        return None
    intervals = CONFIG.get("review_intervals", DEFAULTS["review_intervals"])
    days = int(intervals.get(str(confidence), DEFAULT_REVIEW_DAYS)) if confidence else DEFAULT_REVIEW_DAYS
    if row_status == "revisit":
        days = min(days, 2)
    elif row_status == "revise":
        days = min(days, 5)
    if last_revised:
        try:
            base = date.fromisoformat(last_revised)
        except ValueError:
            base = date.today()
    elif first_ac:
        base = datetime.fromtimestamp(first_ac, tz=timezone.utc).date()
    else:
        base = date.today()
    return (base + timedelta(days=days)).isoformat()


def build_rows():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT s.slug, s.first_ac, s.last_ac, s.ac_count, s.source,
                   s.discovered_at,
                   c.qid, c.title, c.difficulty, c.topics, c.paid_only, c.ac_rate,
                   n.status, n.confidence, n.last_revised, n.revise_count,
                   n.note, n.starred, n.snooze_until
            FROM solved s
            LEFT JOIN catalog c ON c.slug = s.slug
            LEFT JOIN notes   n ON n.slug = s.slug
            """
        ).fetchall()

    today = date.today().isoformat()
    out = []
    for r in rows:
        status = r["status"] or "new"
        confidence = r["confidence"] or 0
        nxt = _next_review(
            status, confidence, r["last_revised"], r["first_ac"], r["snooze_until"]
        )
        out.append(
            {
                "slug": r["slug"],
                "qid": r["qid"] or 0,
                "title": r["title"] or r["slug"].replace("-", " ").title(),
                "url": f"https://leetcode.com/problems/{r['slug']}/",
                "difficulty": r["difficulty"] or "Unknown",
                "topics": json.loads(r["topics"] or "[]"),
                "paid_only": bool(r["paid_only"]),
                "ac_rate": round((r["ac_rate"] or 0) * 100, 1),
                "first_ac": r["first_ac"],
                "last_ac": r["last_ac"],
                "ac_count": r["ac_count"] or 0,
                "dated": bool(r["first_ac"]),
                "status": status,
                "confidence": confidence,
                "last_revised": r["last_revised"],
                "revise_count": r["revise_count"] or 0,
                "note": r["note"] or "",
                "starred": bool(r["starred"]),
                "next_review": nxt,
                "due": bool(nxt and nxt <= today),
                "unrated": _is_unrated(
                    status, confidence, r["last_revised"], r["first_ac"]
                ),
            }
        )
    out.sort(key=lambda x: (x["first_ac"] or 0, x["qid"]), reverse=True)
    return out


def build_state():
    rows = build_rows()
    profile = json.loads(meta_get("profile") or "{}")
    calendar = json.loads(meta_get("calendar") or "{}")
    last_sync = meta_get("last_sync")
    with db() as conn:
        catalog_count = conn.execute("SELECT COUNT(*) c FROM catalog").fetchone()["c"]

    by_diff = {"Easy": 0, "Medium": 0, "Hard": 0, "Unknown": 0}
    for row in rows:
        by_diff[row["difficulty"]] = by_diff.get(row["difficulty"], 0) + 1

    topics = sorted({t for row in rows for t in row["topics"]})
    return {
        "profile": profile,
        "calendar": {"streak": calendar.get("streak", 0),
                     "active_days": calendar.get("active_days", 0)},
        "problems": rows,
        "topics": topics,
        "stats": {
            "tracked": len(rows),
            "reported": profile.get("total", 0),
            "by_difficulty": by_diff,
            "due": sum(1 for r in rows if r["due"]),
            "starred": sum(1 for r in rows if r["starred"]),
            "revisit": sum(1 for r in rows if r["status"] == "revisit"),
            "unrated": sum(1 for r in rows if r["unrated"]),
            "catalog": catalog_count,
        },
        "sync": dict(SYNC_STATE, last_sync=int(last_sync) if last_sync else None),
        "authenticated": bool(load_secrets().get("LEETCODE_SESSION")),
        "username": CONFIG.get("username", ""),
        "poll_minutes": CONFIG.get("poll_minutes", 10),
    }


# --------------------------------------------------------------------------
# writes
# --------------------------------------------------------------------------

EDITABLE = {
    "status": str,
    "confidence": int,
    "note": str,
    "starred": int,
    "last_revised": str,
    "snooze_until": str,
    "revise_count": int,
}
VALID_STATUS = {"new", "solid", "revise", "revisit"}


def update_note(slug, patch):
    fields, values = [], []
    for key, caster in EDITABLE.items():
        if key not in patch:
            continue
        value = patch[key]
        if value is None or value == "":
            value = None if key in ("last_revised", "snooze_until") else caster()
        else:
            value = caster(value)
        if key == "status" and value not in VALID_STATUS:
            continue
        if key == "confidence":
            value = max(0, min(5, value))
        fields.append(f"{key}=?")
        values.append(value)
    if not fields:
        return
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO notes(slug, updated_at) VALUES(?, ?)",
            (slug, _now()),
        )
        conn.execute(
            f"UPDATE notes SET {', '.join(fields)}, updated_at=? WHERE slug=?",
            (*values, _now(), slug),
        )


def mark_revised(slug):
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO notes(slug, updated_at) VALUES(?, ?)",
            (slug, _now()),
        )
        conn.execute(
            "UPDATE notes SET last_revised=?, revise_count=revise_count+1, "
            "snooze_until=NULL, updated_at=? WHERE slug=?",
            (date.today().isoformat(), _now(), slug),
        )


def add_manual(entries):
    """Mark problems solved by hand. Accepts slugs or full LeetCode URLs."""
    added = 0
    slugs = []
    for raw in entries:
        raw = raw.strip()
        if not raw:
            continue
        if "leetcode.com" in raw:
            parts = [p for p in raw.split("/") if p]
            if "problems" in parts:
                idx = parts.index("problems")
                if idx + 1 < len(parts):
                    raw = parts[idx + 1]
        slugs.append(raw.lower().replace(" ", "-"))
    with db() as conn:
        for slug in slugs:
            if mark_solved(conn, slug, ts=None, source="manual"):
                added += 1
    return added, slugs


def export_csv():
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        ["#", "Title", "URL", "Difficulty", "Topics", "Solved On", "Times AC",
         "Status", "Confidence", "Last Revised", "Times Revised", "Next Review",
         "Starred", "Notes"]
    )
    for r in build_rows():
        solved_on = (
            datetime.fromtimestamp(r["first_ac"], tz=timezone.utc).strftime("%Y-%m-%d")
            if r["first_ac"] else ""
        )
        writer.writerow(
            [r["qid"], r["title"], r["url"], r["difficulty"], "; ".join(r["topics"]),
             solved_on, r["ac_count"], r["status"], r["confidence"] or "",
             r["last_revised"] or "", r["revise_count"], r["next_review"] or "",
             "yes" if r["starred"] else "", r["note"]]
        )
    return buf.getvalue()


# --------------------------------------------------------------------------
# http server
# --------------------------------------------------------------------------

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep the console clean

    def _send(self, code, body, content_type="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj), "application/json; charset=utf-8")

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in STATIC:
            name, ctype = STATIC[path]
            full = os.path.join(HERE, name)
            if not os.path.exists(full):
                return self._send(404, "missing " + name, "text/plain")
            with open(full, "rb") as fh:
                return self._send(200, fh.read(), ctype)
        if path == "/api/state":
            return self._json(build_state())
        if path == "/api/export.csv":
            body = export_csv().encode("utf-8-sig")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header(
                "Content-Disposition", 'attachment; filename="leetcode-solved.csv"'
            )
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._body()
        if path == "/api/note":
            slug = body.get("slug")
            if not slug:
                return self._json({"error": "slug required"}, 400)
            update_note(slug, body)
            return self._json({"ok": True})
        if path == "/api/revised":
            slug = body.get("slug")
            if not slug:
                return self._json({"error": "slug required"}, 400)
            mark_revised(slug)
            return self._json({"ok": True})
        if path == "/api/sync":
            full = bool(body.get("full"))
            threading.Thread(target=run_sync, args=(full,), daemon=True).start()
            return self._json({"ok": True, "started": True})
        if path == "/api/manual":
            added, slugs = add_manual(body.get("entries") or [])
            threading.Thread(
                target=lambda: fill_missing_catalog(
                    LeetCode(CONFIG["username"], load_secrets())
                ),
                daemon=True,
            ).start()
            return self._json({"ok": True, "added": added, "slugs": slugs})
        if path == "/api/settings":
            for key in ("poll_minutes", "username"):
                if key in body:
                    CONFIG[key] = body[key]
            save_config(CONFIG)
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


def serve():
    port = int(CONFIG.get("port", 8765))
    url = f"http://localhost:{port}/"
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=poll_loop, daemon=True).start()
    print("\n  LeetCode Tracker")
    print(f"  Dashboard : {url}")
    print(f"  User      : {CONFIG.get('username') or '(not set)'}")
    print(f"  Database  : {DB_PATH}")
    print(f"  Auto-sync : every {CONFIG.get('poll_minutes', 10)} min")
    print("\n  Press Ctrl+C to stop.\n")
    if CONFIG.get("open_browser"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        server.shutdown()


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def main():
    init_db()
    if not CONFIG.get("username"):
        print("Set your LeetCode username in config.json first.")
        return 1

    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "serve":
        serve()
    elif cmd == "sync":
        state = run_sync()
        print(state["message"])
        stats = build_state()["stats"]
        print(f"Tracked {stats['tracked']} of {stats['reported']} solved.")
    elif cmd == "catalog":
        state = run_sync(full=True)
        print(state["message"])
    elif cmd == "export":
        out = os.path.join(HERE, "solved.csv")
        with open(out, "w", encoding="utf-8-sig", newline="") as fh:
            fh.write(export_csv())
        print(f"Wrote {out}")
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

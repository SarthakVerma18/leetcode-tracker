# LeetCode Tracker

A self-updating log of every LeetCode problem I've solved, with revision
tracking on top: mark a problem **Revise** or **Revisit**, rate your confidence,
and it schedules when to come back to it.

Two pieces, one database:

| | What it is | Where it runs |
|---|---|---|
| **Local tracker** | Full read/write dashboard — notes, status, confidence, review queue | `localhost:8765` on my machine |
| **Public page** | Read-only snapshot of solved problems and stats | GitHub Pages, refreshed by CI |

Free-text notes never leave the local machine.

## Quick start

```bash
python leetcode_tracker.py
```

Opens <http://localhost:8765>. On Windows you can double-click `start.bat`
instead. No dependencies — standard library only, Python 3.9+.

## How it stays up to date

LeetCode has no official API, so this uses the same undocumented GraphQL
endpoint the website itself calls (`https://leetcode.com/graphql`).

- **Public data** (no login): profile stats, streak, and your **last 20**
  accepted submissions. The background poller checks this every 10 minutes, so
  anything you solve shows up on its own.
- **Full history** (needs your session cookie): the complete solved list, since
  LeetCode doesn't expose it publicly. This is a one-time backfill.

### Setting up the cookie

Put it in `secrets.json` (git-ignored, never committed):

```json
{ "LEETCODE_SESSION": "paste-value-here" }
```

Get it from a signed-in browser: **F12 → Application → Cookies →
`https://leetcode.com` → `LEETCODE_SESSION` → Value**.

It's a full login token, so treat it like a password. It expires every few
weeks — re-paste it when the solved count stops matching your profile.

## Commands

```bash
python leetcode_tracker.py           # dashboard + background auto-sync
python leetcode_tracker.py sync      # one-off sync, no server
python leetcode_tracker.py catalog   # force a full catalog + backfill refresh
python leetcode_tracker.py export    # write solved.csv
python build_site.py                 # sync, then rebuild docs/ for Pages
python build_site.py --no-sync       # rebuild docs/ from the local database
```

## Tracking model

Each solved problem carries:

- **Status** — New, Solid, Revise, or Revisit
- **Confidence** — 0–5, which drives the review interval
  (1→1 day, 2→3, 3→7, 4→16, 5→35; tunable in `config.json`)
- **Notes** — free text, local only
- **Starred**, **last revised**, **times revised**

**Next review** is computed from confidence and the last revision date.
`Revisit` caps the interval at 2 days and `Revise` at 5, so shaky problems
resurface fast. Confidence 5 + Solid means no review is scheduled.

Problems imported by backfill have no solve date (LeetCode only dates recent
submissions), so they sit in an **Unrated** bucket rather than all becoming due
on the same day. Give one a confidence score and it joins the schedule.

## The public page

`build_site.py` writes `docs/`, which GitHub Pages serves. A scheduled Action
(`.github/workflows/sync.yml`) reruns it every 6 hours using `LEETCODE_SESSION`
stored as an encrypted repository secret.

Two files carry state between local and CI:

- `docs/data.json` — the published snapshot. **Never contains notes.**
- `annotations.json` — status / confidence / starred, committed so CI can
  refresh the solved list without discarding review progress. Regenerated
  locally by `python build_site.py`; CI treats it as read-only truth.

To publish local changes:

```bash
python build_site.py && git add -A && git commit -m "update" && git push
```

## Config

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `username` | — | LeetCode username |
| `port` | `8765` | Local dashboard port |
| `poll_minutes` | `10` | Background sync interval |
| `catalog_refresh_days` | `7` | How often to re-pull the 4,000-problem catalog |
| `publish_notes` | `false` | Include free-text notes in the public build |
| `review_intervals` | see above | Days per confidence level |

## Files

```
leetcode_tracker.py   local server, sync engine, SQLite store
index.html/app.js     local dashboard (read/write)
site/                 public page template (read-only)
build_site.py         generates docs/ from the database
docs/                 generated — served by GitHub Pages
tracker.db            local data (git-ignored)
secrets.json          session cookie (git-ignored)
```

## Caveats

The LeetCode API used here is undocumented and can change without notice — the
`status` field, for one, has been both `AC` and `SOLVED`. Requests are spaced
out to stay polite; don't lower the poll interval much.

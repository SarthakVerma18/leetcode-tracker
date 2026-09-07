#!/usr/bin/env python3
"""
Build the public, read-only version of the tracker into docs/ for GitHub Pages.

    python build_site.py            # sync from LeetCode, then build
    python build_site.py --no-sync  # build from whatever is already in the DB
    python build_site.py --ci       # for GitHub Actions: annotations.json wins

Two files matter here:

  docs/data.json     the published snapshot (public - never contains notes)
  annotations.json   your status / confidence / starred flags, committed so a
                     scheduled CI run can refresh the solved list without
                     throwing your review progress away

Free-text notes live only in tracker.db on your machine and are never written
to either file.
"""

import json
import os
import shutil
import sys
import time

import leetcode_tracker as lt

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.path.join(HERE, "site")
DOCS_DIR = os.path.join(HERE, "docs")
ANNOTATIONS = os.path.join(HERE, "annotations.json")

# Per-problem fields that describe how well you know it. Safe to publish -
# unlike `note`, which is free text and stays local.
ANNOTATION_FIELDS = (
    "status", "confidence", "starred", "last_revised", "revise_count",
    "snooze_until",
)


def export_annotations():
    """Pull annotations out of the local database (notes excluded)."""
    with lt.db() as conn:
        rows = conn.execute(
            f"SELECT slug, {', '.join(ANNOTATION_FIELDS)} FROM notes"
        ).fetchall()
    out = {}
    for r in rows:
        vals = {f: r[f] for f in ANNOTATION_FIELDS}
        # Skip untouched rows so the file stays small and readable.
        if vals["status"] in (None, "new") and not vals["confidence"] \
                and not vals["starred"] and not vals["last_revised"]:
            continue
        out[r["slug"]] = vals
    return out


def import_annotations(data):
    """Write annotations into the database (used by CI on a fresh clone)."""
    with lt.db() as conn:
        for slug, vals in data.items():
            conn.execute(
                "INSERT OR IGNORE INTO notes(slug, updated_at) VALUES(?, ?)",
                (slug, int(time.time())),
            )
            sets = ", ".join(f"{f}=?" for f in ANNOTATION_FIELDS)
            conn.execute(
                f"UPDATE notes SET {sets} WHERE slug=?",
                (*[vals.get(f) for f in ANNOTATION_FIELDS], slug),
            )


def build_payload():
    state = lt.build_state()
    publish_notes = lt.CONFIG.get("publish_notes", False)

    problems = []
    for r in state["problems"]:
        row = dict(r)
        if not publish_notes:
            row.pop("note", None)
        else:
            row["note"] = r.get("note", "")
        problems.append(row)

    return {
        "generated_at": int(time.time()),
        "username": state["username"],
        "profile": {
            k: state["profile"].get(k)
            for k in ("username", "ranking", "total", "easy", "medium", "hard")
        },
        "calendar": state["calendar"],
        "stats": state["stats"],
        "topics": state["topics"],
        "has_notes": publish_notes,
        "problems": problems,
    }


def copy_assets():
    os.makedirs(DOCS_DIR, exist_ok=True)
    for name in ("index.html", "app.js"):
        shutil.copyfile(os.path.join(SITE_DIR, name), os.path.join(DOCS_DIR, name))
    shutil.copyfile(os.path.join(HERE, "styles.css"),
                    os.path.join(DOCS_DIR, "styles.css"))
    # Stop GitHub Pages running the output through Jekyll.
    open(os.path.join(DOCS_DIR, ".nojekyll"), "w").close()


def main():
    args = set(sys.argv[1:])
    ci = "--ci" in args
    lt.init_db()

    if ci and os.path.exists(ANNOTATIONS):
        # Fresh checkout: the committed annotations are the only copy there is.
        with open(ANNOTATIONS, "r", encoding="utf-8") as fh:
            import_annotations(json.load(fh))
        print("Loaded committed annotations")

    if "--no-sync" not in args:
        if not lt.load_secrets().get("LEETCODE_SESSION"):
            print("! No session cookie found - only recent solves will import.")
        state = lt.run_sync(full=ci)
        print(state["message"])

    copy_assets()
    payload = build_payload()
    with open(os.path.join(DOCS_DIR, "data.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    if not ci:
        # Local run: the database is the source of truth, so refresh the file
        # that CI will read next time.
        with open(ANNOTATIONS, "w", encoding="utf-8") as fh:
            json.dump(export_annotations(), fh, indent=2, sort_keys=True)

    s = payload["stats"]
    print(f"Built docs/ - {s['tracked']} problems "
          f"({s['by_difficulty']['Easy']}E / {s['by_difficulty']['Medium']}M / "
          f"{s['by_difficulty']['Hard']}H)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

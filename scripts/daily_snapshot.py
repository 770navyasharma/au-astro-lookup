#!/usr/bin/env python3
"""
Daily snapshot runner.

Runs the 14 Pinot queries + calls Yukti scraper for a given date (default: yesterday IST),
writes data/YYYY-MM-DD.json, and updates data/index.json.

Usage:
    python scripts/daily_snapshot.py                    # yesterday IST
    python scripts/daily_snapshot.py --date 2026-11-17  # specific date
    python scripts/daily_snapshot.py --range 2026-11-01 2026-11-17   # backfill range
"""
import os
import sys
import json
import argparse
import datetime as dt
import traceback
from pathlib import Path

# make sibling modules importable regardless of cwd
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pinot_client import run_query, PinotError  # noqa: E402
from pinot_queries import build_queries  # noqa: E402
from pull_yukti import fetch_yukti_day, YuktiError  # noqa: E402

ROOT = HERE.parent
DATA_DIR = ROOT / "data"


def ist_yesterday() -> str:
    """Return yesterday's date in IST as 'YYYY-MM-DD'."""
    now_utc = dt.datetime.now(dt.timezone.utc)
    ist = now_utc + dt.timedelta(hours=5, minutes=30)
    y = ist.date() - dt.timedelta(days=1)
    return y.isoformat()


def run_pinot_for_date(date: str) -> dict:
    """Run every Pinot query for one date. Collect results and any errors."""
    results = {}
    errors = {}
    queries = build_queries(date)
    for qid, spec in queries.items():
        try:
            rows = run_query(spec["sql"], multi_stage=spec["multi_stage"])
            # for single-row aggregate queries, flatten to a dict; keep lists for group-by
            if len(rows) == 1 and qid != "smoke":
                results[qid] = rows[0]
            else:
                results[qid] = rows
            print(f"  ✓ {qid}: {len(rows)} row(s)")
        except Exception as e:
            errors[qid] = str(e)
            results[qid] = None
            print(f"  ✗ {qid}: {e}")
    return {"results": results, "errors": errors}


def run_yukti_for_date(date: str) -> dict:
    """Pull Yukti astrologer+platform table and duration metrics for a date."""
    try:
        data = fetch_yukti_day(date)
        print(f"  ✓ yukti: {len(data.get('astrologers', []))} astrologer rows")
        return {"data": data, "error": None}
    except YuktiError as e:
        print(f"  ✗ yukti: {e}")
        return {"data": None, "error": str(e)}
    except Exception as e:
        print(f"  ✗ yukti (unexpected): {e}")
        traceback.print_exc()
        return {"data": None, "error": f"unexpected: {e}"}


def snapshot(date: str) -> dict:
    print(f"\n=== Snapshot for {date} ===")
    print("Pinot:")
    pinot = run_pinot_for_date(date)
    print("Yukti:")
    yukti = run_yukti_for_date(date)

    return {
        "date": date,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "pinot": pinot["results"],
        "pinot_errors": pinot["errors"],
        "yukti": yukti["data"],
        "yukti_error": yukti["error"],
    }


def save_snapshot(snap: dict) -> Path:
    DATA_DIR.mkdir(exist_ok=True)
    p = DATA_DIR / f"{snap['date']}.json"
    with open(p, "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=2, ensure_ascii=False)
    print(f"Saved: {p}")
    return p


def rebuild_index() -> None:
    """Scan data/ and regenerate index.json listing all available dates."""
    DATA_DIR.mkdir(exist_ok=True)
    files = sorted([p.stem for p in DATA_DIR.glob("*.json") if p.stem != "index"])
    index = {
        "available_dates": files,
        "latest": files[-1] if files else None,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    with open(DATA_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
    print(f"Index updated: {len(files)} date(s), latest = {index['latest']}")


def daterange(start: str, end: str):
    s = dt.date.fromisoformat(start)
    e = dt.date.fromisoformat(end)
    cur = s
    while cur <= e:
        yield cur.isoformat()
        cur += dt.timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="Specific date YYYY-MM-DD (default: yesterday IST)")
    ap.add_argument("--range", nargs=2, metavar=("START", "END"), help="Backfill range YYYY-MM-DD YYYY-MM-DD")
    args = ap.parse_args()

    if args.range:
        for d in daterange(*args.range):
            save_snapshot(snapshot(d))
    else:
        date = args.date or ist_yesterday()
        save_snapshot(snapshot(date))

    rebuild_index()


if __name__ == "__main__":
    main()

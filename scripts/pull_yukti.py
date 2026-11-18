"""
Yukti scraper for astrologer × platform table + avg call duration.

HOW IT WORKS
    1. Login via POST with username+password -> session cookie
    2. GET conversations for a date range -> list of {astrologer, platform, duration_seconds, type}
    3. Aggregate into:
       - astrologers: [{name, platform, calls, chats}]
       - avg_duration: {web, app, overall}  (in seconds)

TODO MARKERS
    Yukti's exact login and conversations endpoints need the yukti_probe.js output
    to be filled in. The scaffolding below handles the common shape; adjust the
    three constants marked "# TODO verify" after running the probe once.

ENV VARS
    YUKTI_BASE_URL     default https://yukti-ui.amarujala.com
    YUKTI_USERNAME     required
    YUKTI_PASSWORD     required
"""
import os
import json
import requests
from typing import Any

BASE_URL = os.environ.get("YUKTI_BASE_URL", "https://yukti-ui.amarujala.com")
USERNAME = os.environ.get("YUKTI_USERNAME", "")
PASSWORD = os.environ.get("YUKTI_PASSWORD", "")

# TODO verify after running yukti_probe.js — these are the standard shapes
LOGIN_PATH = "/api/auth/login"                   # TODO verify
CONVERSATIONS_PATH = "/api/conversations"        # TODO verify
PLATFORM_FIELD = "platform"                      # TODO verify (one of: platform, source, channel)
ASTROLOGER_FIELD = "agent_name"                  # TODO verify (one of: agent_name, astrologer, agent)
DURATION_FIELD = "duration_seconds"              # TODO verify
TYPE_FIELD = "type"                              # TODO verify (call / chat)


class YuktiError(Exception):
    pass


def _session() -> requests.Session:
    """Create a logged-in Yukti session."""
    if not USERNAME or not PASSWORD:
        raise YuktiError("YUKTI_USERNAME / YUKTI_PASSWORD env vars not set")

    s = requests.Session()
    s.headers.update({"User-Agent": "au-astro-lookup/1.0"})
    r = s.post(
        BASE_URL + LOGIN_PATH,
        json={"username": USERNAME, "password": PASSWORD},
        timeout=30,
    )
    if r.status_code >= 400:
        raise YuktiError(f"Login failed: {r.status_code} {r.text[:200]}")
    return s


def _fetch_conversations(session: requests.Session, date: str) -> list[dict]:
    """
    Fetch raw conversations for one date.
    Yukti's conversations endpoint accepts a date filter; we fetch a single day.
    """
    # TODO verify — probe output will reveal whether it's date / from / date_from and whether paged
    params = {"date_from": date, "date_to": date, "limit": 5000}
    r = session.get(BASE_URL + CONVERSATIONS_PATH, params=params, timeout=60)
    if r.status_code >= 400:
        raise YuktiError(f"Conversations fetch failed: {r.status_code} {r.text[:200]}")

    data = r.json()
    # Response shape may be either a bare list or wrapped {data: [...], total: N}
    if isinstance(data, dict):
        return data.get("data") or data.get("conversations") or data.get("results") or []
    return data


def _normalize_platform(raw: Any) -> str:
    """Map whatever Yukti returns to one of 'web' / 'app'."""
    if not raw:
        return "unknown"
    s = str(raw).lower()
    if s in ("web", "mweb", "mobile_web", "desktop", "mobile-web"):
        return "web"
    if s in ("app", "android", "ios", "mobile"):
        return "app"
    return "unknown"


def _aggregate(convs: list[dict]) -> dict:
    """
    Aggregate raw conversations into dashboard-ready structures:
      astrologers: [{name, platform, calls, chats}]
      avg_duration: {web, app, overall}  seconds
      totals: {web_calls, web_chats, app_calls, app_chats}
    """
    # astrologer × platform → {calls, chats}
    tbl: dict[tuple[str, str], dict[str, int]] = {}
    # for duration averages — call type only
    durations_by_platform: dict[str, list[int]] = {"web": [], "app": []}

    for c in convs:
        name = c.get(ASTROLOGER_FIELD) or "Unknown"
        plat = _normalize_platform(c.get(PLATFORM_FIELD))
        ctype = (c.get(TYPE_FIELD) or "").lower()
        duration = c.get(DURATION_FIELD) or 0

        key = (name, plat)
        row = tbl.setdefault(key, {"calls": 0, "chats": 0})
        if "call" in ctype:
            row["calls"] += 1
            if plat in durations_by_platform and duration > 0:
                durations_by_platform[plat].append(int(duration))
        elif "chat" in ctype:
            row["chats"] += 1

    astrologers = [
        {"name": name, "platform": plat, "calls": v["calls"], "chats": v["chats"]}
        for (name, plat), v in sorted(tbl.items())
    ]

    def avg(lst: list[int]) -> float:
        return round(sum(lst) / len(lst), 1) if lst else 0.0

    all_calls = durations_by_platform["web"] + durations_by_platform["app"]
    avg_duration = {
        "web": avg(durations_by_platform["web"]),
        "app": avg(durations_by_platform["app"]),
        "overall": avg(all_calls),
    }

    totals = {
        "web_calls": sum(a["calls"] for a in astrologers if a["platform"] == "web"),
        "web_chats": sum(a["chats"] for a in astrologers if a["platform"] == "web"),
        "app_calls": sum(a["calls"] for a in astrologers if a["platform"] == "app"),
        "app_chats": sum(a["chats"] for a in astrologers if a["platform"] == "app"),
    }

    return {
        "astrologers": astrologers,
        "avg_duration": avg_duration,
        "totals": totals,
        "raw_count": len(convs),
    }


def fetch_yukti_day(date: str) -> dict:
    """Public entry: fetch one day's Yukti data, return aggregated dict."""
    session = _session()
    convs = _fetch_conversations(session, date)
    return _aggregate(convs)


if __name__ == "__main__":
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else "2026-11-17"
    try:
        out = fetch_yukti_day(d)
        print(json.dumps(out, indent=2))
    except YuktiError as e:
        print(f"YuktiError: {e}")
        print("Check env vars (YUKTI_USERNAME, YUKTI_PASSWORD) and TODO-verify constants in this file.")

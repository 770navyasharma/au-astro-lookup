"""
Yukti scraper — Full mode (B).

Pulls everything date-filtered by paginating the /api/dashboard/conversations
endpoint. Top-line stats come from the response's `stats` block (already
date-filtered). Per-astrologer chat/call/duration split is aggregated from
the `recent` array across ALL pages because the `agents` block is lifetime,
not date-filtered.

ENV VARS
    YUKTI_BASE_URL   default https://yukti-ui.amarujala.com
    AU_PROPERTY_ID   default 57398d264f1c1b0016ac7a02
    YUKTI_COOKIE     optional — only if API ever starts requiring auth
"""
import os
import time
import requests
from collections import defaultdict

BASE_URL = os.environ.get("YUKTI_BASE_URL", "https://yukti-ui.amarujala.com")
PROPERTY_ID = os.environ.get("AU_PROPERTY_ID", "57398d264f1c1b0016ac7a02")
COOKIE = os.environ.get("YUKTI_COOKIE", "")

CONVERSATIONS_PATH = "/api/dashboard/conversations"
PER_PAGE = 100  # bigger page = fewer requests; API accepts this


class YuktiError(Exception):
    pass


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": "au-astro-lookup/1.0",
        "Referer": f"{BASE_URL}/dashboard/conversations",
    })
    if COOKIE:
        s.headers["Cookie"] = COOKIE
    return s


def _fetch_page(session: requests.Session, date: str, page: int) -> dict:
    params = {
        "page": page,
        "per_page": PER_PAGE,
        "property": PROPERTY_ID,
        "platform": "app",
        "date_from": date,
        "date_to": date,
    }
    r = session.get(BASE_URL + CONVERSATIONS_PATH, params=params, timeout=60)
    if r.status_code >= 400:
        raise YuktiError(f"page {page}: {r.status_code} {r.text[:200]}")
    return r.json()


def _normalize_platform(raw) -> str:
    if not raw:
        return "unknown"
    s = str(raw).lower()
    if s in ("web", "mweb", "mobile_web", "desktop"):
        return "web"
    if s in ("app", "android", "ios", "mobile"):
        return "app"
    return "unknown"


def fetch_yukti_day(date: str) -> dict:
    """Pull one day's full Yukti data with per-astrologer breakdown."""
    session = _session()

    # Page 1 — gives us stats + pagination info
    first = _fetch_page(session, date, page=1)
    stats = first.get("stats", {}) or {}
    pagination = first.get("pagination", {}) or {}
    total_pages = pagination.get("total_pages", 1)

    # Aggregate per-astrologer × type from the `recent` array across all pages
    per_astro: dict[tuple[str, str, str], dict] = defaultdict(
        lambda: {"calls": 0, "chats": 0, "call_duration_total": 0, "chat_duration_total": 0}
    )

    def ingest(convs: list):
        for c in convs:
            name = c.get("agent_name") or "Unknown"
            plat = _normalize_platform(c.get("platform"))
            ctype = (c.get("conv_type") or "").lower()
            duration = c.get("duration") or 0
            prop = c.get("property_name") or ""
            key = (name, plat, prop)
            row = per_astro[key]
            if ctype == "call":
                row["calls"] += 1
                row["call_duration_total"] += int(duration)
            elif ctype == "chat":
                row["chats"] += 1
                row["chat_duration_total"] += int(duration)

    ingest(first.get("recent", []))

    # Remaining pages
    for p in range(2, total_pages + 1):
        try:
            page_data = _fetch_page(session, date, p)
            ingest(page_data.get("recent", []))
            time.sleep(0.15)  # be nice to the server
        except YuktiError as e:
            print(f"  warning: skipping page {p}: {e}")

    # Build astrologers list
    astrologers = []
    for (name, plat, prop), v in sorted(per_astro.items()):
        total = v["calls"] + v["chats"]
        astrologers.append({
            "name": name,
            "platform": plat,
            "property": prop,
            "calls": v["calls"],
            "chats": v["chats"],
            "avg_call_duration": round(v["call_duration_total"] / v["calls"], 1) if v["calls"] else 0,
            "avg_chat_duration": round(v["chat_duration_total"] / v["chats"], 1) if v["chats"] else 0,
            "total": total,
        })

    # Platform-level duration averages (across astros)
    web_calls = sum(a["calls"] for a in astrologers if a["platform"] == "web")
    app_calls = sum(a["calls"] for a in astrologers if a["platform"] == "app")
    web_call_dur = sum(a["avg_call_duration"] * a["calls"] for a in astrologers if a["platform"] == "web")
    app_call_dur = sum(a["avg_call_duration"] * a["calls"] for a in astrologers if a["platform"] == "app")

    avg_duration = {
        "web": round(web_call_dur / web_calls, 1) if web_calls else 0,
        "app": round(app_call_dur / app_calls, 1) if app_calls else 0,
        "overall": round((web_call_dur + app_call_dur) / (web_calls + app_calls), 1) if (web_calls + app_calls) else 0,
    }

    totals = {
        "web_calls": web_calls, "app_calls": app_calls,
        "web_chats": sum(a["chats"] for a in astrologers if a["platform"] == "web"),
        "app_chats": sum(a["chats"] for a in astrologers if a["platform"] == "app"),
    }

    return {
        "stats": stats,  # total_users, total_conversations, repeat_percentage, etc.
        "astrologers": astrologers,
        "avg_duration": avg_duration,
        "totals": totals,
        "raw_count": pagination.get("total_count", 0),
        "pages_fetched": total_pages,
    }


if __name__ == "__main__":
    import sys, json
    d = sys.argv[1] if len(sys.argv) > 1 else "2026-11-17"
    out = fetch_yukti_day(d)
    print(json.dumps(out, indent=2, ensure_ascii=False))

"""Reusable Pinot REST client with auth, retries, and multi-stage engine support."""
import os
import time
import json
import requests
from requests.auth import HTTPBasicAuth

PINOT_URL = os.environ.get("PINOT_URL", "http://46.62.191.123:9000/sql")
PINOT_USER = os.environ.get("PINOT_USER", "analyst")
PINOT_PASSWORD = os.environ.get("PINOT_PASSWORD", "")


class PinotError(Exception):
    pass


def run_query(sql: str, multi_stage: bool = False, timeout_ms: int = 60_000, retries: int = 2) -> list[dict]:
    """
    Execute a Pinot SQL query and return rows as list of dicts.
    multi_stage=True is required for subqueries (used by our cohort funnels).
    """
    if not PINOT_PASSWORD:
        raise PinotError("PINOT_PASSWORD env var is not set")

    body: dict = {"sql": sql, "queryOptions": f"timeoutMs={timeout_ms}"}
    if multi_stage:
        body["queryOptions"] = f"useMultistageEngine=true;timeoutMs={timeout_ms}"

    last_err = None
    for attempt in range(retries + 1):
        try:
            r = requests.post(
                PINOT_URL,
                json=body,
                auth=HTTPBasicAuth(PINOT_USER, PINOT_PASSWORD),
                timeout=120,
            )
            r.raise_for_status()
            data = r.json()

            if data.get("exceptions"):
                raise PinotError(f"Query exception: {data['exceptions']}")

            rt = data.get("resultTable")
            if not rt:
                return []

            cols = rt.get("dataSchema", {}).get("columnNames", [])
            rows = rt.get("rows", [])
            return [dict(zip(cols, r)) for r in rows]
        except (requests.RequestException, PinotError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(2 ** attempt)  # 1, 2, 4
                continue
            raise PinotError(f"Query failed after {retries + 1} attempts: {e}") from e

    raise PinotError(f"Unexpected failure: {last_err}")


def ping() -> bool:
    """Quick health check."""
    try:
        rows = run_query("SELECT COUNT(*) FROM events WHERE event_date_ist = '1900-01-01'")
        return True
    except Exception as e:
        print(f"ping failed: {e}")
        return False


if __name__ == "__main__":
    print("Testing Pinot connection…")
    if ping():
        print("✓ Pinot reachable, auth OK")
    else:
        print("✗ Pinot unreachable or auth failed")

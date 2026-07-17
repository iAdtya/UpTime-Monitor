"""Async URL pinging — the core health-check logic.

Uses coroutines (asyncio + httpx) so a whole batch of URLs is checked
concurrently in a single event loop, no threads involved.
"""
import asyncio
import time
from datetime import datetime, timezone

import httpx

# How long we wait for a single URL before calling it "down".
REQUEST_TIMEOUT = 10


async def ping(client: httpx.AsyncClient, url: str) -> dict:
    """Ping one URL and return a check result.

    The result always contains the three fields the assignment asks us to
    store — status_code, response_time_ms, checked_at (timestamp) — plus a
    derived `up` boolean.
    """
    checked_at = datetime.now(timezone.utc).isoformat()
    start = time.perf_counter()
    try:
        resp = await client.get(url, timeout=REQUEST_TIMEOUT, follow_redirects=True)
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        return {
            "checked_at": checked_at,
            "status_code": resp.status_code,
            "response_time_ms": elapsed_ms,
            "up": resp.status_code < 400,
        }
    except Exception as exc:  # noqa: BLE001 — any failure means "down"
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        return {
            "checked_at": checked_at,
            "status_code": None,
            "response_time_ms": elapsed_ms,
            "up": False,
            "error": type(exc).__name__,
        }


async def ping_all(urls: list[dict]) -> dict[str, dict]:
    """Ping every registered URL concurrently.

    `urls` is the list of records from storage. Returns a mapping of
    url_id -> check result so the caller can write each result to its log.
    """
    if not urls:
        return {}
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*[ping(client, u["url"]) for u in urls])
    return {u["id"]: result for u, result in zip(urls, results)}

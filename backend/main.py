"""FastAPI app: the uptime-monitor backend.

Responsibilities:
- Expose a small REST API to register / list / delete monitored URLs and
  read their check history.
- Run an in-process scheduler (a plain asyncio task) that pings every
  registered URL once a minute and appends the results to file logs.

CORS is wide open so the vanilla HTML/CSS/JS frontend can call it directly
from the browser.
"""
import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

import storage
from monitor import ping, ping_all

# Seconds between full sweeps of all registered URLs.
CHECK_INTERVAL = 60


class URLIn(BaseModel):
    url: str

    @field_validator("url")
    @classmethod
    def must_be_http(cls, v: str) -> str:
        v = v.strip()
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("URL must start with http:// or https://")
        return v


async def monitor_loop() -> None:
    """Ping all URLs every CHECK_INTERVAL seconds, forever.

    Runs as a background asyncio task for the lifetime of the app. Each
    iteration also prunes logs past the retention window.
    """
    while True:
        try:
            urls = storage.load_urls()
            results = await ping_all(urls)
            for url_id, result in results.items():
                storage.write_check(url_id, result)
            storage.cleanup_old_logs()
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            print(f"[monitor] sweep failed: {type(exc).__name__}: {exc}")
        await asyncio.sleep(CHECK_INTERVAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(monitor_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Uptime Monitor", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    """Liveness probe for this service itself (not a monitored URL)."""
    return {"status": "ok"}


@app.get("/urls")
async def list_urls() -> list[dict]:
    """List registered URLs, each with its latest check result attached.

    This is what the dashboard polls to render up/down + response time.
    """
    out = []
    for rec in storage.load_urls():
        out.append({**rec, "latest": storage.latest_check(rec["id"])})
    return out


@app.post("/urls", status_code=201)
async def register_url(body: URLIn) -> dict:
    rec, created = storage.add_url(body.url)
    if not created:
        raise HTTPException(status_code=409, detail="URL already registered")
    # Run one check immediately so the dashboard shows a status right away
    # instead of waiting up to a minute for the next sweep.
    async with httpx.AsyncClient() as client:
        result = await ping(client, rec["url"])
    storage.write_check(rec["id"], result)
    return {**rec, "latest": result}


@app.delete("/urls/{url_id}", status_code=204)
async def remove_url(url_id: str) -> None:
    if not storage.delete_url(url_id):
        raise HTTPException(status_code=404, detail="URL not found")


@app.get("/urls/{url_id}/logs")
async def get_logs(url_id: str, limit: int = 100) -> list[dict]:
    if not storage.url_exists(url_id):
        raise HTTPException(status_code=404, detail="URL not found")
    return storage.read_logs(url_id, limit)

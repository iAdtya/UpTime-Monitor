"""File-based persistence — no database.

- The registered URL list lives in a single JSON file (`data/urls.json`).
- Each URL's check history lives in `logs/<url_id>/<YYYY-MM-DD>.jsonl`,
  one JSON object per line (append-only). Splitting by day makes the
  1-day retention cleanup a simple "delete old files" operation.
"""
import json
import shutil
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
URLS_FILE = DATA_DIR / "urls.json"
LOGS_DIR = BASE_DIR / "logs"

# Keep log files for this many days, then delete them.
RETENTION_DAYS = 1

# Guards read-modify-write on the URL list so a request handler and the
# scheduler loop can't clobber each other's writes.
_lock = threading.Lock()


def _ensure_dirs() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    LOGS_DIR.mkdir(exist_ok=True)


# --------------------------------------------------------------------------- #
# URL list
# --------------------------------------------------------------------------- #
def load_urls() -> list[dict]:
    _ensure_dirs()
    if not URLS_FILE.exists():
        return []
    try:
        with open(URLS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _save_urls(urls: list[dict]) -> None:
    _ensure_dirs()
    # Write to a temp file then atomically replace, so a crash mid-write
    # can never leave a half-written urls.json behind.
    tmp = URLS_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(urls, f, indent=2)
    tmp.replace(URLS_FILE)


def add_url(url: str) -> tuple[dict, bool]:
    """Register a URL. Returns (record, created).

    `created` is False if the URL was already registered (no duplicate added).
    """
    with _lock:
        urls = load_urls()
        for rec in urls:
            if rec["url"] == url:
                return rec, False
        rec = {
            "id": uuid.uuid4().hex[:8],
            "url": url,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        urls.append(rec)
        _save_urls(urls)
        return rec, True


def delete_url(url_id: str) -> bool:
    """Remove a URL and its logs. Returns False if the id wasn't found."""
    with _lock:
        urls = load_urls()
        remaining = [u for u in urls if u["id"] != url_id]
        if len(remaining) == len(urls):
            return False
        _save_urls(remaining)
    shutil.rmtree(LOGS_DIR / url_id, ignore_errors=True)
    return True


def url_exists(url_id: str) -> bool:
    return any(u["id"] == url_id for u in load_urls())


# --------------------------------------------------------------------------- #
# Check logs
# --------------------------------------------------------------------------- #
def write_check(url_id: str, result: dict) -> None:
    """Append one check result to today's log file for this URL."""
    _ensure_dirs()
    url_dir = LOGS_DIR / url_id
    url_dir.mkdir(exist_ok=True)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with open(url_dir / f"{day}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(result) + "\n")


def read_logs(url_id: str, limit: int = 100) -> list[dict]:
    """Return the most recent `limit` checks for a URL, newest first."""
    url_dir = LOGS_DIR / url_id
    if not url_dir.exists():
        return []
    out: list[dict] = []
    # Newest day file first; within a file, newest line is at the bottom.
    for fp in sorted(url_dir.glob("*.jsonl"), reverse=True):
        with open(fp, "r", encoding="utf-8") as f:
            lines = f.readlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
            if len(out) >= limit:
                return out
    return out


def latest_check(url_id: str) -> dict | None:
    """Return the single most recent check for a URL, or None."""
    recent = read_logs(url_id, limit=1)
    return recent[0] if recent else None


def cleanup_old_logs() -> None:
    """Delete log files older than the retention window."""
    if not LOGS_DIR.exists():
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).date()
    for url_dir in LOGS_DIR.iterdir():
        if not url_dir.is_dir():
            continue
        for fp in url_dir.glob("*.jsonl"):
            try:
                file_date = datetime.strptime(fp.stem, "%Y-%m-%d").date()
            except ValueError:
                continue
            if file_date < cutoff:
                fp.unlink(missing_ok=True)

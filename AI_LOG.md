# AI Collaboration Log

A peek behind the curtain at how this uptime monitor was built in collaboration
with AI — the tools used, the prompts that shipped each layer, the engineering
decisions we landed on, and the course corrections along the way.

---

## The AI tech stack

| Tool | Underlying LLM | Used for |
|------|----------------|----------|
| **Claude Code** (Anthropic's CLI agent) | **Claude Opus 4.8** | Design review, generating the backend, generating the frontend, writing/running verification, containerization, and docs |

---

## Workflow: design first, then build in layers

I started not by asking for code, but by sharing my **system-design board** (a
whiteboard sketch of functional/non-functional requirements, core entities, API
routes, and an HLD) and asking the assistant to critique it against the actual
assignment. From there we built in deliberate layers — **backend → seed data →
frontend → containerization → docs** — verifying each layer before moving on.

---

## The prompts that shipped it

These are the actual prompts (lightly cleaned) that drove the core layers.

### Framing / design review

> "can you read the pdf? and check is my system design decent enough?"

This produced a gap analysis against the assignment and the realization that the
design was strong on requirements but thin on the *pinging loop* (the real core).

### The backend

> "just for now focus on backend … we will use threadpoolexec for coroutine ops
> sending requests to all the urls, we will store them in a list … for logs we
> will create a logs folder … no db required … talk about docker compose and
> scheduler — is this a time scheduler or something else?"

followed by the decision:

> "use co routines and pure files … also we will be using html css js for
> frontend so keep that in mind. implement the backend for my system design"

This generated `main.py` (FastAPI app + in-process scheduler), `monitor.py`
(async pinging), and `storage.py` (file-based persistence).

### The seed data

> "give me at least 4 working urls (i don't like google.com) and 2–4 broken urls
> to test it. create the urls.json file in the data folder"

### The frontend

> "great now finally implement a clean and simple ui for it — you can create
> separate css and js files in the frontend folder"

This generated `index.html`, `style.css`, and `app.js` (a vanilla dashboard that
polls `GET /urls`).

### Containerization

> "let's work on the docker compose file … install a light version of the
> container, i don't have a lot of space available"

This produced the `Dockerfile`, `.dockerignore`, and `docker-compose.yml`, with a
conscious choice to keep the image footprint small.

---

## Decisions we took

The board gave the shape; these are the choices made — with the assistant — while
turning it into a clean, working MVP:

| # | Design point | Decision & why |
|---|--------------|----------------|
| 1 | **Concurrency** | Used **coroutines** (`asyncio` + `httpx.AsyncClient` + `asyncio.gather`) rather than a thread pool. FastAPI is async-native, and a few dozen URLs check concurrently in one event loop with no thread-safety overhead. |
| 2 | **Storage — "no DB"** | Kept the design's file-based intent: the URL list is a single `data/urls.json`; each URL's checks live in `logs/<id>/<YYYY-MM-DD>.jsonl`. No database server to run. |
| 3 | **Scheduler** | An **in-process** interval scheduler (a plain `asyncio` task on a 60s loop) instead of a separate scheduler container. Simplest thing that meets "every minute" at MVP scale. |
| 4 | **Persistence of the URL list** | Persisted to JSON (atomic temp-file write + a lock) rather than a pure in-memory list, so registrations **survive restarts**. |
| 5 | **1-day log retention** | Splitting logs into per-day files makes retention a trivial "delete files older than 1 day" — run every sweep. |
| 6 | **Up/down semantics** | `up = status_code < 400`. Unreachable hosts (DNS fail, connection refused, timeout) store `status_code: null` plus the error type; a reachable-but-unhealthy host records its real code (e.g. `503`). |
| 7 | **API route refinements** | Moved the URL into the **POST body** (not `/register?url=`), split `/health` (our own liveness) from the monitored health checks, and added `GET /urls` + `DELETE /urls/{id}` that the dashboard needs. |
| 8 | **Frontend** | Vanilla **HTML/CSS/JS**, no framework/build step. Polls `GET /urls` every 10s to stay live. Runs a first check immediately on register so a new row isn't blank. |
| 9 | **Container footprint** | Backend builds on `python:3.12-slim`; the frontend **reuses that same image** to serve static files — one image pulled total, no nginx/node, small on disk. |

---

## The course corrections

The interesting part — where the AI got something wrong, or where verification
caught a bad assumption, and how we resolved it.

### 1. "ThreadPoolExecutor for coroutine ops" — a conceptual mix-up

My first backend sketch said we'd "use ThreadPoolExecutor for coroutine ops."
The assistant flagged that this conflates **two different concurrency models**:
`ThreadPoolExecutor` is OS threads with a *blocking* client (`requests`), whereas
coroutines are `asyncio` with an *async* client (`httpx`) — you don't mix the
terms. It laid out both options and recommended coroutines since FastAPI is
async-native. **Resolution:** we went with `asyncio` + `httpx` + `asyncio.gather`,
which also sidestepped the thread-safety concern of the scheduler and API mutating
the shared URL list at the same time.

### 2. The HLD had the data flow backwards

My original board drew the high-level design as
`client ◄─ GET /health-check ─► server`. The assistant pointed out that this
misses the actual heart of the system: it isn't the client polling the server —
it's the **server (an in-process scheduler) polling the registered target URLs
every minute** and recording the results. **Resolution:** the architecture
diagram in the README was redrawn to show the scheduler → ping → file-log loop as
the core, with the frontend as a thin poller on top.

"""
Gunicorn configuration for the SpeciesNet web interface.

Run with:
    gunicorn -c gunicorn.conf.py wsgi:app

=============================================================================
IMPORTANT: THIS APP MUST RUN AS A SINGLE WORKER PROCESS.
=============================================================================

This is not a tuning preference — multiple worker processes would break the
app in three separate ways:

1. DUPLICATE JOB QUEUES. app.py starts the background queue worker at import
   time (`worker_thread.start()`), so every worker process would start its
   own. Four workers means four jobs running MegaDetector/SpeciesNet at once
   instead of the one-at-a-time FIFO the queue exists to enforce — which is
   exactly what would exhaust GPU/CPU memory on a shared machine.

2. DIVERGENT IN-MEMORY STATE. `jobs`, `videos`, `locations` and
   `ocr_configs` are module-level dicts held in memory and mirrored to JSON.
   Separate processes don't share memory, so a species correction made on
   one worker would be invisible to the others, and each would serve its own
   stale copy of the library.

3. LOST WRITES. Those same dicts are rewritten wholesale to JSON on save.
   Two processes saving concurrently means one silently overwrites the
   other's changes.

app.py's own module docstring already flags this for the Flask reloader, for
the same reason. Concurrency here comes from THREADS (shared memory, and the
existing threading.Lock guards around each store), never from processes.

If you outgrow a single worker, the fix is architectural rather than a config
change: move state into a shared store (SQLite/Postgres/Redis) and the job
queue into a separate process (Celery/RQ), so the web workers become
stateless. Bumping `workers` without doing that will corrupt data.
"""

import multiprocessing  # noqa: F401  (kept so the single-worker choice below reads as deliberate)
import os

# ---------------------------------------------------------------------------
# Server socket
# ---------------------------------------------------------------------------
# Override the port without editing this file:
#     PORT=8000 gunicorn -c gunicorn.conf.py wsgi:app
#
# Worth knowing on macOS: since Monterey, the AirPlay Receiver service binds
# port 5000 system-wide, which shows up as "Address already in use" even with
# nothing of yours running. Either disable it (System Settings > General >
# AirDrop & Handoff > AirPlay Receiver) or set PORT to something else.
# To see what currently holds a port:  lsof -nP -iTCP:5000 -sTCP:LISTEN
bind = f"{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '5000')}"

# ---------------------------------------------------------------------------
# Worker processes — see the warning above before changing `workers`.
# ---------------------------------------------------------------------------
workers = 1

# Threads give concurrency WITHOUT the separate-memory problem, so the UI
# stays responsive while a slow request is in flight. The gthread worker
# class is what makes `threads` take effect.
worker_class = "gthread"
threads = 8

# Several requests legitimately outlast Gunicorn's 30s default:
#   - /api/ocr-wizard/first-frame decodes a frame from a large video
#   - /api/pick-folder blocks on a native folder dialog until the user
#     actually picks something (or cancels)
# Killing those mid-flight would look like a random failure to the user.
timeout = 300
graceful_timeout = 30

# Recycling a worker would kill the in-flight job queue and drop all
# in-memory state, so it stays off.
max_requests = 0

# ---------------------------------------------------------------------------
# Logging — to stdout/stderr so systemd/Docker/journalctl can capture it.
# ---------------------------------------------------------------------------
accesslog = "-"
errorlog = "-"
loglevel = "info"

# ---------------------------------------------------------------------------
# Fail loudly instead of corrupting data.
# ---------------------------------------------------------------------------


def on_starting(server):
    """
    Refuse to boot with more than one worker rather than letting the app
    start and silently corrupt its own state. A hard stop at startup is far
    easier to diagnose than duplicated jobs and vanishing edits later.
    """
    configured = server.cfg.workers
    if configured != 1:
        raise RuntimeError(
            f"Refusing to start: workers={configured}, but this app requires "
            "exactly 1 (see the comment at the top of gunicorn.conf.py). "
            "Use `threads` for concurrency instead of `workers`."
        )

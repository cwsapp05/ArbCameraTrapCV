"""
Production server for Windows.

Gunicorn cannot run on Windows — it imports the Unix-only `pwd`/`grp`
modules and calls os.fork(). Waitress is the standard pure-Python
alternative and, conveniently, matches this app's hard requirement exactly:
ONE process, with threads for concurrency.

That single-process constraint is not a preference. app.py starts the
background job-queue worker at import time and keeps jobs/videos/locations
in module-level dicts, so a second process would run a second copy of the
queue and diverge from the first. See gunicorn.conf.py for the full
explanation.

Run:
    python serve_windows.py

Environment:
    HOST        default 127.0.0.1 — localhost only, because Cloudflare
                Tunnel connects from this same machine. Do NOT set this to
                0.0.0.0 unless you intend the app to be reachable from your
                local network directly; the tunnel does not need it.
    PORT        default 5000
    THREADS     default 8
    MEDIA_ROOT  folder containing sub-folders of trail cam footage
"""

import os

from waitress import serve

from app import app

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    threads = int(os.environ.get("THREADS", "8"))

    print(f"Serving on http://{host}:{port}  (threads={threads})")
    print(f"MEDIA_ROOT = {os.environ.get('MEDIA_ROOT', '<default: ./media>')}")
    serve(
        app,
        host=host,
        port=port,
        threads=threads,
        # Long uploads/reads shouldn't be cut off mid-flight.
        channel_timeout=300,
    )

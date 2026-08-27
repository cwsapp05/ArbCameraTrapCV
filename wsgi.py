"""
WSGI entry point for running the SpeciesNet web interface under Gunicorn.

    gunicorn -c gunicorn.conf.py wsgi:app

Importing `app` from app.py is all that's needed: app.py starts its
background job-queue worker at import time, so the queue comes up with the
server. That import-time start is also precisely why this app must run as a
SINGLE Gunicorn worker — see the warning in gunicorn.conf.py.

`python app.py` still works for local development (Flask's built-in server).
Gunicorn is for production; Flask's own server is explicitly not intended
for it.
"""

from app import app

# Gunicorn looks up `app` in this module (the `wsgi:app` argument above).
__all__ = ["app"]

"""
SpeciesNet Web Interface — Flask backend.

Core model: each SUBMITTED FOLDER becomes a job that's queued and run through
run_md_and_speciesnet. Every VIDEO inside that folder becomes a persistent
library entry — tagged animal/species/blank by the AI, correctable by staff,
favoritable as a shared team collection, and searchable by species. The
uploaded video itself is never moved or deleted; it's served in place from
wherever it was submitted from.

Run with:
    python app.py
Then open http://localhost:5000 in a browser.

Install:
    pip install flask speciesnet megadetector

IMPORTANT: this app is NOT run with the Flask debug reloader. The reloader
spawns a second process that would re-import this module and start a SECOND
queue worker, causing two jobs to run at once — exactly what the queue
exists to prevent. If you need debug/auto-reload during development, restart
manually after edits instead.
"""

import collections
import hashlib
import json
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory, abort

import bar_ocr

app = Flask(__name__)

BASE_DIR = Path(__file__).parent.resolve()
RUNS_DIR = BASE_DIR / "runs"
RUNS_DIR.mkdir(exist_ok=True)
BAR_CROPS_DIR = RUNS_DIR / "bar_crops"
BAR_CROPS_DIR.mkdir(exist_ok=True)
JOBS_INDEX_FILE = RUNS_DIR / "jobs_index.json"
VIDEOS_INDEX_FILE = RUNS_DIR / "videos_index.json"
SPECIES_LIST_FILE = RUNS_DIR / "species_list.json"

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".m4v", ".wmv"}

# ---------------------------------------------------------------------------
# In-memory state, each mirrored to its own JSON file so everything survives
# a restart. Three separate locks since jobs/videos/species are independent
# and there's no invariant that requires locking all three together.
# ---------------------------------------------------------------------------
jobs = {}
jobs_lock = threading.Lock()

videos = {}  # video_id -> record
videos_lock = threading.Lock()

canonical_species = []  # full taxonomy the classifier can produce, incl. "blank"
species_lock = threading.Lock()

_seq_counter = 0  # monotonic; started_at's second-level precision isn't enough
                   # to order jobs submitted within the same second


def _next_seq():
    global _seq_counter
    _seq_counter += 1
    return _seq_counter


job_queue = collections.deque()
queue_cv = threading.Condition()

# job_id -> subprocess.Popen, only while that job is actively running. This
# is what makes cancellation of a RUNNING job possible — subprocess.run()
# blocks until completion with no way to interrupt it, so we use Popen and
# keep a handle around instead.
running_processes = {}
running_processes_lock = threading.Lock()


def load_json(path, default):
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return default


def save_jobs_index():
    with jobs_lock:
        with open(JOBS_INDEX_FILE, "w") as f:
            json.dump(jobs, f, indent=2)


def save_videos_index():
    with videos_lock:
        with open(VIDEOS_INDEX_FILE, "w") as f:
            json.dump(videos, f, indent=2)


def save_species_list():
    with species_lock:
        with open(SPECIES_LIST_FILE, "w") as f:
            json.dump(canonical_species, f, indent=2)


jobs = load_json(JOBS_INDEX_FILE, {})
videos = load_json(VIDEOS_INDEX_FILE, {})
canonical_species = load_json(SPECIES_LIST_FILE, [])

# Videos created before Date/Time/Location/Count/Notes/Diel Period existed
# won't have these keys — fill in defaults so the UI doesn't break on them.
_NEW_FIELD_DEFAULTS = {
    "date": None, "time": None, "location": None, "diel_period": None,
    "temperature": None,
    "count": 1, "notes": "", "display_filename": None, "metadata_edited": False,
    "has_bar_crop": False,
}
for _v in videos.values():
    for _key, _default in _NEW_FIELD_DEFAULTS.items():
        _v.setdefault(_key, _v.get("filename") if _key == "display_filename" else _default)

if jobs:
    _seq_counter = max((j.get("seq", 0) for j in jobs.values()), default=0)

# Anything stuck "running"/"queued" from a previous server instance is stale —
# nothing is actually processing it — so re-queue it in original order rather
# than losing submitted work silently.
for _job in sorted(jobs.values(), key=lambda j: j.get("seq", 0)):
    if _job["status"] in ("running", "queued"):
        _job["status"] = "queued"
        job_queue.append(_job["id"])


def run_bar_ocr_safe(folder, filename):
    """
    Wraps bar_ocr's pipeline for one video file. Never raises — a single
    unreadable clip or OCR hiccup shouldn't take down the whole job's sync;
    it just gets blank date/time/location/diel_period/temperature, correctable by hand.
    """
    defaults = {"date": None, "time": None, "location": None, "diel_period": None, "temperature": None}
    try:
        video_path = Path(folder) / filename
        if not video_path.is_file():
            return defaults
        frame = bar_ocr.extract_first_frame(video_path)

        raw_date = bar_ocr.ocr_field(frame, bar_ocr.CROP_BOXES["date"], whitelist="0123456789/-")
        raw_time = bar_ocr.ocr_field(frame, bar_ocr.CROP_BOXES["time"], whitelist="0123456789:APM ")
        location = bar_ocr.ocr_field(frame, bar_ocr.CROP_BOXES["location"])
        raw_temperature = bar_ocr.ocr_field(frame, bar_ocr.CROP_BOXES["temperature"], whitelist="0123456789°CF ")

        parsed_date = bar_ocr.parse_date(raw_date)
        parsed_time = bar_ocr.parse_time(raw_time)

        result = dict(defaults)
        result["location"] = location or None
        result["temperature"] = raw_temperature or None
        if parsed_date:
            result["date"] = parsed_date.isoformat()
        if parsed_time:
            result["time"] = f"{parsed_time[0]:02d}:{parsed_time[1]:02d}:{parsed_time[2]:02d}"
        if parsed_date and parsed_time:
            dt = datetime.combine(parsed_date, datetime.min.time()).replace(
                hour=parsed_time[0], minute=parsed_time[1], second=parsed_time[2]
            )
            result["diel_period"] = bar_ocr.diel_period(dt, bar_ocr.ARBORETUM_LAT, bar_ocr.ARBORETUM_LON)
        return result
    except Exception as e:
        print(f"OCR failed for {folder}/{filename}: {e}")
        return defaults


def save_bar_crop_safe(folder, filename, video_id):
    """
    Saves the full info-bar QA crop for one video to BAR_CROPS_DIR, named by
    video_id. Never raises — same reasoning as run_bar_ocr_safe: one bad clip
    shouldn't take down the whole job's sync. Returns True/False for whether
    it succeeded (used to decide whether the "show crop" button should exist).
    """
    try:
        video_path = Path(folder) / filename
        if not video_path.is_file():
            return False
        output_path = BAR_CROPS_DIR / f"{video_id}.png"
        bar_ocr.save_bar_crop(video_path, output_path)
        return True
    except Exception as e:
        print(f"Bar crop save failed for {folder}/{filename}: {e}")
        return False


def video_id_for(job_id, filename):
    return hashlib.sha1(f"{job_id}:{filename}".encode()).hexdigest()[:16]


def sync_videos_from_job(job_id):
    """
    After a job finishes successfully, read its predictions.json and create/
    update one library entry per video: species tag (from SpeciesNet), plus
    Date/Time/Location/Diel Period (from OCR on the video's info bar, via
    bar_ocr.py) and Count/Notes/File Name (user-editable, defaulted here).
    Existing favorited/corrected_species/manually-edited fields on a
    re-synced video are preserved — this never overwrites human input, only
    the AI/OCR-derived fields.
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return
    output_json = Path(job["output_json"])
    if not output_json.exists():
        return

    with open(output_json) as f:
        data = json.load(f)

    class_cats = data.get("classification_categories", {})

    # classification_categories is the classifier's FULL fixed taxonomy,
    # present in every job's output regardless of what that batch contained —
    # so any one job is enough to learn the complete species list.
    with species_lock:
        changed = False
        for label in class_cats.values():
            if label not in canonical_species:
                canonical_species.append(label)
                changed = True
    if changed:
        canonical_species.sort()
        save_species_list()

    for img in data.get("images", []):
        filename = img.get("file", "?")
        dets = img.get("detections", [])

        species_best = {}  # label -> (classifier_conf, detector_conf)
        for d in dets:
            if "classifications" not in d:
                continue
            cls_idx, cls_conf = d["classifications"][0]
            label = class_cats.get(cls_idx, cls_idx)
            if label == "blank":
                continue
            if label not in species_best or cls_conf > species_best[label][0]:
                species_best[label] = (cls_conf, d.get("conf", 0))

        ai_species, ai_conf, ai_det_conf = None, None, None
        if species_best:
            ai_species, (ai_conf, ai_det_conf) = max(
                species_best.items(), key=lambda kv: kv[1][0]
            )

        vid = video_id_for(job_id, filename)
        has_bar_crop = save_bar_crop_safe(job["folder"], filename, vid)

        with videos_lock:
            existing = videos.get(vid, {})

            # Date/Time/Location/Diel Period come from OCR — UNLESS a human
            # has already edited any of them, in which case ALL FOUR stay
            # frozen at their current values. (Freezing all four together,
            # not per-field, avoids a confusing half-OCR/half-manual mix if
            # this job ever gets re-run.)
            if existing.get("metadata_edited"):
                ocr_fields = {
                    "date": existing.get("date"),
                    "time": existing.get("time"),
                    "location": existing.get("location"),
                    "temperature": existing.get("temperature"),
                    "diel_period": existing.get("diel_period"),
                }
            else:
                ocr_fields = run_bar_ocr_safe(job["folder"], filename)

            videos[vid] = {
                "id": vid,
                "job_id": job_id,
                "folder": job["folder"],
                "filename": filename,
                "ai_species": ai_species,          # None means blank
                "ai_classifier_conf": round(ai_conf, 2) if ai_conf is not None else None,
                "ai_detector_conf": round(ai_det_conf, 2) if ai_det_conf is not None else None,
                "corrected_species": existing.get("corrected_species"),
                "favorited": existing.get("favorited", False),
                "corrected_at": existing.get("corrected_at"),
                **ocr_fields,
                "count": existing.get("count", 1),
                "notes": existing.get("notes", ""),
                "display_filename": existing.get("display_filename", filename),
                "metadata_edited": existing.get("metadata_edited", False),
                "has_bar_crop": has_bar_crop,
            }
    save_videos_index()


def display_species(video):
    """The species search/filter/display should use: human correction wins."""
    if video.get("corrected_species"):
        return video["corrected_species"]
    return video.get("ai_species") or "blank"


def worker_loop():
    while True:
        with queue_cv:
            while not job_queue:
                queue_cv.wait()
            job_id = job_queue.popleft()
        _execute_job(job_id)


def _execute_job(job_id):
    with jobs_lock:
        job = jobs[job_id]
        job["status"] = "running"
        job["started_running_at"] = datetime.now().isoformat(timespec="seconds")
        cmd = job["cmd"]
        log_file = Path(job["log_file"])
    save_jobs_index()

    try:
        with open(log_file, "w") as log:
            log.write("Running: " + " ".join(cmd) + "\n\n")
            log.flush()
            proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
            with running_processes_lock:
                running_processes[job_id] = proc
            returncode = proc.wait()
        with running_processes_lock:
            running_processes.pop(job_id, None)

        with jobs_lock:
            was_cancelling = jobs[job_id]["status"] == "cancelling"
        status = "cancelled" if was_cancelling else ("done" if returncode == 0 else "error")
    except Exception as e:
        with running_processes_lock:
            running_processes.pop(job_id, None)
        status = "error"
        with open(log_file, "a") as log:
            log.write(f"\nException while running job: {e}\n")

    with jobs_lock:
        jobs[job_id]["status"] = status
        jobs[job_id]["finished_at"] = datetime.now().isoformat(timespec="seconds")
    save_jobs_index()

    if status == "done":
        sync_videos_from_job(job_id)


def _terminate_then_kill(proc):
    """SIGTERM first (graceful), escalate to SIGKILL if it doesn't die soon —
    some subprocesses (PyTorch/CUDA cleanup, etc.) can take a moment or
    ignore SIGTERM outright."""
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    except Exception:
        pass


def queue_position(job_id):
    """1-indexed position among QUEUED jobs only — position 1 means 'next up'."""
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job["status"] != "queued":
            return 0
        ahead = sum(
            1 for j in jobs.values()
            if j["status"] == "queued" and j["seq"] < job["seq"]
        )
    return ahead + 1


worker_thread = threading.Thread(target=worker_loop, daemon=True)
worker_thread.start()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/pick-folder", methods=["POST"])
def pick_folder():
    """
    Launches a native folder-selection dialog on the machine running this
    server (tkinter, in a subprocess — dialogs need to own a main thread,
    which doesn't mix well with Flask's request-handling threads).
    """
    script = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk()\n"
        "root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        "path = filedialog.askdirectory(title='Select folder of trail cam videos/images')\n"
        "print(path)\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Folder picker timed out"}), 500

    folder = result.stdout.strip()
    if not folder:
        return jsonify({"folder": None})  # user cancelled the dialog
    return jsonify({"folder": folder})


@app.route("/api/run", methods=["POST"])
def run_job():
    data = request.get_json(force=True)
    folder = (data.get("folder") or "").strip()
    country = (data.get("country") or "").strip()
    state = (data.get("state") or "").strip()

    if not folder:
        return jsonify({"error": "No folder provided"}), 400
    if not Path(folder).is_dir():
        return jsonify({"error": f"Folder not found: {folder}"}), 400

    job_id = uuid.uuid4().hex[:12]
    job_dir = RUNS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    output_json = job_dir / "predictions.json"
    log_file = job_dir / "log.txt"

    cmd = [
        sys.executable, "-m", "megadetector.detection.run_md_and_speciesnet",
        folder, str(output_json),
    ]
    if country:
        cmd += ["--country", country]
    if state:
        cmd += ["--state", state]

    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "folder": folder,
            "country": country,
            "state": state,
            "status": "queued",
            "seq": _next_seq(),
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "started_running_at": None,
            "finished_at": None,
            "output_json": str(output_json),
            "log_file": str(log_file),
            "cmd": cmd,
        }
    save_jobs_index()

    with queue_cv:
        job_queue.append(job_id)
        queue_cv.notify()

    return jsonify({"job_id": job_id, "queue_position": queue_position(job_id)})


@app.route("/api/status/<job_id>")
def job_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Unknown job"}), 404

    return jsonify({**job, "log_tail": _log_tail_for(job), "queue_position": queue_position(job_id)})


def _log_tail_for(job):
    log_path = Path(job["log_file"])
    if not log_path.exists():
        return ""
    lines = log_path.read_text(errors="replace").splitlines()
    return "\n".join(lines[-40:])


@app.route("/api/queue")
def get_queue():
    """
    Current queue state for the Upload-tab queue panel. Running jobs include
    their log tail directly — the frontend shows 'whatever is running right
    now,' not 'the job this browser tab happened to submit,' so the log never
    disappears just because someone (including you) queues another job.
    """
    with jobs_lock:
        # "cancelling" still occupies the worker thread, so it's shown
        # alongside "running" rather than disappearing from the panel.
        running = [j for j in jobs.values() if j["status"] in ("running", "cancelling")]
        queued = sorted(
            (j for j in jobs.values() if j["status"] == "queued"),
            key=lambda j: j["seq"],
        )
    running_with_logs = [{**j, "log_tail": _log_tail_for(j)} for j in running]
    return jsonify({"running": running_with_logs, "queued": queued})


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def cancel_job(job_id):
    """
    Cancels a queued job outright (just removes it from the line — it never
    started), or asks a running job to stop (SIGTERM, escalating to SIGKILL
    if it doesn't exit within 5s — see _terminate_then_kill). Useful when the
    wrong folder got submitted by mistake.
    """
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({"error": "Unknown job"}), 404
        status = job["status"]

    if status == "queued":
        with queue_cv:
            try:
                job_queue.remove(job_id)
            except ValueError:
                pass  # worker already picked it up between our check and now — fall through below

        with jobs_lock:
            still_queued = jobs[job_id]["status"] == "queued"
            if still_queued:
                jobs[job_id]["status"] = "cancelled"
                jobs[job_id]["finished_at"] = datetime.now().isoformat(timespec="seconds")
            else:
                status = jobs[job_id]["status"]  # it started running in the meantime — fall through below

        if still_queued:
            save_jobs_index()  # called AFTER releasing jobs_lock — save_jobs_index acquires it itself
            return jsonify({"status": "cancelled"})

    if status == "running":
        with running_processes_lock:
            proc = running_processes.get(job_id)
        if proc is None:
            return jsonify({"error": "Job is running but has no process handle (may be finishing up)"}), 409
        with jobs_lock:
            jobs[job_id]["status"] = "cancelling"
        save_jobs_index()
        threading.Thread(target=_terminate_then_kill, args=(proc,), daemon=True).start()
        return jsonify({"status": "cancelling"})

    return jsonify({"error": f"Job is already '{status}' — nothing to cancel"}), 400


@app.route("/api/jobs")
def list_jobs():
    """All submitted jobs, most recent first — powers the Upload tab's history list."""
    with jobs_lock:
        job_list = sorted(jobs.values(), key=lambda j: j["seq"], reverse=True)
    return jsonify(job_list)


@app.route("/api/species")
def list_species():
    """Full taxonomy plus how many current videos display as each species."""
    with videos_lock:
        counts = collections.Counter(display_species(v) for v in videos.values())
    with species_lock:
        species = list(canonical_species)
    if "blank" not in species:
        species.append("blank")
    return jsonify([
        {"label": s, "count": counts.get(s, 0)}
        for s in sorted(species)
    ])


@app.route("/api/videos")
def list_videos():
    """
    Library listing. Query params:
      species=<label>   filter to one display species (or 'blank'); omit for all
      favorites_only=1   restrict to favorited videos
    """
    species_filter = request.args.get("species")
    favorites_only = request.args.get("favorites_only") in ("1", "true", "True")

    with videos_lock:
        vids = list(videos.values())

    result = []
    for v in vids:
        disp = display_species(v)
        if species_filter and disp != species_filter:
            continue
        if favorites_only and not v.get("favorited"):
            continue
        result.append({**v, "display_species": disp})

    result.sort(key=lambda v: (v["job_id"], v["filename"]), reverse=True)
    return jsonify(result)


@app.route("/api/videos/<video_id>/favorite", methods=["POST"])
def set_favorite(video_id):
    data = request.get_json(force=True)
    favorited = bool(data.get("favorited"))
    with videos_lock:
        if video_id not in videos:
            return jsonify({"error": "Unknown video"}), 404
        videos[video_id]["favorited"] = favorited
        record = dict(videos[video_id])
    save_videos_index()
    return jsonify({**record, "display_species": display_species(record)})


@app.route("/api/videos/<video_id>/correct", methods=["POST"])
def correct_species(video_id):
    data = request.get_json(force=True)
    species = (data.get("species") or "").strip()

    with species_lock:
        valid = set(canonical_species) | {"blank"}
    if species and species not in valid:
        return jsonify({"error": f"'{species}' isn't a recognized species label"}), 400

    with videos_lock:
        if video_id not in videos:
            return jsonify({"error": "Unknown video"}), 404
        # empty string clears the correction, reverting to the AI's own tag
        videos[video_id]["corrected_species"] = species or None
        videos[video_id]["corrected_at"] = datetime.now().isoformat(timespec="seconds")
        record = dict(videos[video_id])
    save_videos_index()
    return jsonify({**record, "display_species": display_species(record)})


@app.route("/api/videos/<video_id>/update", methods=["POST"])
def update_video_metadata(video_id):
    """
    Edits Date, Time, Location, Diel Period, Temperature, Count, Notes, and/or
    File Name. Any subset of these can be sent — only the provided keys are
    changed. Editing date/time/location/diel_period/temperature marks the
    video as manually edited, which freezes ALL FIVE against being
    overwritten by OCR if this job is ever re-synced (see sync_videos_from_job).
    """
    data = request.get_json(force=True)
    allowed_fields = {"date", "time", "location", "diel_period", "temperature", "count", "notes", "display_filename"}
    updates = {k: v for k, v in data.items() if k in allowed_fields}

    if "count" in updates:
        try:
            count = int(updates["count"])
        except (TypeError, ValueError):
            return jsonify({"error": "Count must be a whole number"}), 400
        if count < 0:
            return jsonify({"error": "Count can't be negative"}), 400
        updates["count"] = count

    with videos_lock:
        if video_id not in videos:
            return jsonify({"error": "Unknown video"}), 404
        record = videos[video_id]

        if any(f in updates for f in ("date", "time", "location", "diel_period", "temperature")):
            record["metadata_edited"] = True

        record.update(updates)
        result = dict(record)
    save_videos_index()
    return jsonify({**result, "display_species": display_species(result)})


@app.route("/api/videos/<video_id>/delete", methods=["POST"])
def delete_video(video_id):
    """
    Removes a video from the library's metadata only. The actual file on
    disk is never touched — this just forgets the entry (species tag,
    favorite, notes, etc.). If the same job folder is ever re-processed,
    the video will simply reappear as a fresh, unedited entry. The saved
    bar-crop QA image (our own generated artifact, not the user's file) IS
    cleaned up, since there's no reason to leave it orphaned on disk.
    """
    with videos_lock:
        if video_id not in videos:
            return jsonify({"error": "Unknown video"}), 404
        del videos[video_id]
    save_videos_index()

    crop_path = BAR_CROPS_DIR / f"{video_id}.png"
    crop_path.unlink(missing_ok=True)

    return jsonify({"deleted": video_id})


@app.route("/api/videos/<video_id>/bar-crop")
def serve_bar_crop(video_id):
    """Serves the saved full-info-bar QA crop for one video, generated at
    upload time (see save_bar_crop_safe in sync_videos_from_job)."""
    with videos_lock:
        record = videos.get(video_id)
    if not record:
        abort(404)
    crop_path = BAR_CROPS_DIR / f"{video_id}.png"
    if not crop_path.is_file():
        abort(404)
    return send_from_directory(str(BAR_CROPS_DIR), f"{video_id}.png")


@app.route("/media/<video_id>")
def serve_media(video_id):
    with videos_lock:
        record = videos.get(video_id)
    if not record:
        abort(404)
    folder = Path(record["folder"])
    filename = record["filename"]
    if ".." in filename:  # defense in depth; filenames come from our own scan
        abort(400)
    full_path = folder / filename
    if not full_path.is_file():
        abort(404)
    return send_from_directory(str(folder), filename)


if __name__ == "__main__":
    # use_reloader=False is deliberate — see module docstring.
    app.run(port=5000, use_reloader=False)

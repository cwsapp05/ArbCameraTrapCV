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

from flask import Flask, jsonify, render_template, request, send_from_directory, abort, Response
import cv2

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
OCR_CONFIGS_FILE = RUNS_DIR / "ocr_configs.json"
LOCATIONS_FILE = RUNS_DIR / "locations.json"

# Reserved dropdown values that are never real saved config names.
SKIP_OCR_VALUE = "__skip_ocr__"
CONFIGURE_NEW_VALUE = "__configure_new__"

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".m4v", ".wmv"}
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif"}


def media_type_for_filename(filename):
    """"photo" or "video" based on file extension — defaults to "video" for
    anything unrecognized, matching this system's original video-only
    behavior for any file type not explicitly known as a photo."""
    return "photo" if Path(filename).suffix.lower() in PHOTO_EXTENSIONS else "video"

# ---------------------------------------------------------------------------
# In-memory state, each mirrored to its own JSON file so everything survives
# a restart. Three separate locks since jobs/videos/species are independent
# and there's no invariant that requires locking all three together.
# ---------------------------------------------------------------------------
jobs = {}
jobs_lock = threading.Lock()

videos = {}  # video_id -> record
videos_lock = threading.Lock()

locations = {}  # location name -> {"lat": float, "lon": float} — only locations with confirmed coordinates
locations_lock = threading.Lock()

canonical_species = []  # full taxonomy the classifier can produce, incl. "blank"
species_lock = threading.Lock()

# Named OCR crop-box presets. Each config: {"bar_box": [l,t,r,b] or None,
# "date_box": ..., "time_box": ..., "location_box": ...} — any box can be
# None if that field was skipped in the wizard, meaning it's never OCR'd for
# jobs run with that config. Temperature is NOT part of this system — it
# stays on bar_ocr.py's own single global CROP_BOXES["temperature"],
# unaffected by which config is selected (the wizard only covers Date/Time/
# Location, per how it was specified).
ocr_configs = {}
ocr_last_used = None
ocr_configs_lock = threading.Lock()

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


def save_locations():
    with locations_lock:
        with open(LOCATIONS_FILE, "w") as f:
            json.dump(locations, f, indent=2)


def save_ocr_configs():
    with ocr_configs_lock:
        with open(OCR_CONFIGS_FILE, "w") as f:
            json.dump({"configs": ocr_configs, "last_used": ocr_last_used}, f, indent=2)


def load_ocr_configs():
    """
    Loads saved OCR configs. If none have been saved yet, starts with NO
    configs at all — the default is "Skip OCR" until someone actually goes
    through the wizard. (An earlier version auto-seeded a "Default" config
    from bar_ocr.py's old hardcoded CROP_BOXES, but silently reusing
    unverified legacy pixel values as a real default risks exactly the kind
    of misaligned-crop bug already found in practice — better to start from
    nothing and make configuration explicit.)
    """
    global ocr_configs, ocr_last_used
    loaded = load_json(OCR_CONFIGS_FILE, None)
    if loaded is not None:
        ocr_configs = loaded.get("configs", {})
        ocr_last_used = loaded.get("last_used")
        return

    ocr_configs = {}
    ocr_last_used = SKIP_OCR_VALUE
    save_ocr_configs()


jobs = load_json(JOBS_INDEX_FILE, {})
videos = load_json(VIDEOS_INDEX_FILE, {})
locations = load_json(LOCATIONS_FILE, {})
canonical_species = load_json(SPECIES_LIST_FILE, [])
load_ocr_configs()

# Videos created before Date/Time/Location/Count/Notes/Diel Period existed
# won't have these keys — fill in defaults so the UI doesn't break on them.
_NEW_FIELD_DEFAULTS = {
    "date": None, "time": None, "location": None, "diel_period": None,
    "temperature": None,
    "count": 1, "notes": "", "display_filename": None, "metadata_edited": False,
    "has_bar_crop": False, "media_type": "video",
}
for _v in videos.values():
    for _key, _default in _NEW_FIELD_DEFAULTS.items():
        _v.setdefault(_key, _v.get("filename") if _key == "display_filename" else _default)
    # marked_for_review is a new, independent flag (see /api/videos/<id>/correct
    # and /update) — existing entries default based on their CURRENT reviewed
    # status (matches what the unreviewed bubble already showed for them)
    # rather than a flat value, so this migration doesn't suddenly flag every
    # already-confirmed video as needing review again.
    _v.setdefault("marked_for_review", not bool(_v.get("corrected_species")))

if jobs:
    _seq_counter = max((j.get("seq", 0) for j in jobs.values()), default=0)

# Anything stuck "running"/"queued" from a previous server instance is stale —
# nothing is actually processing it — so re-queue it in original order rather
# than losing submitted work silently.
for _job in sorted(jobs.values(), key=lambda j: j.get("seq", 0)):
    if _job["status"] in ("running", "queued"):
        _job["status"] = "queued"
        job_queue.append(_job["id"])


def _scale_box(box, ref_width, ref_height, frame_width, frame_height):
    """
    Scales a crop box from the resolution it was CALIBRATED against
    (ref_width/ref_height — the sample frame's actual size when the wizard
    drew it) to whatever resolution THIS particular video's frame is.
    Without this, a fixed-pixel box only lines up correctly for clips that
    happen to match the exact resolution of the one sample used during
    calibration — if even one clip in a batch has a different resolution (a
    genuinely common trail-cam scenario: settings changed mid-deployment, a
    swapped camera unit, etc.), the box silently misaligns for that clip,
    typically truncating text at one edge while working fine elsewhere.

    Configs saved before this existed (no ref_width/ref_height stored) skip
    scaling entirely and behave exactly as before — no regression for
    already-working setups.
    """
    if not ref_width or not ref_height:
        return box
    if ref_width == frame_width and ref_height == frame_height:
        return box
    scale_x = frame_width / ref_width
    scale_y = frame_height / ref_height
    left, top, right, bottom = box
    return (
        int(round(left * scale_x)), int(round(top * scale_y)),
        int(round(right * scale_x)), int(round(bottom * scale_y)),
    )


def _resolve_ocr_config(ocr_config_name):
    """
    Looks up a named OCR config with sensible fallback: the given name, else
    the last-used one, else any config that exists. Returns None if
    ocr_config_name is exactly SKIP_OCR_VALUE (OCR skipped entirely for this
    job) or if no configs exist at all — both callers (run_bar_ocr_safe and
    the bar-crop QA image) treat None the same way: nothing to go on, so
    that piece of work just doesn't happen for this video.
    """
    if ocr_config_name == SKIP_OCR_VALUE:
        return None
    with ocr_configs_lock:
        return (
            ocr_configs.get(ocr_config_name)
            or ocr_configs.get(ocr_last_used)
            or next(iter(ocr_configs.values()), None)
        )


def run_bar_ocr_safe(folder, filename, ocr_config_name=None):
    """
    Wraps bar_ocr's pipeline for one video file. Never raises — a single
    unreadable clip or OCR hiccup shouldn't take down the whole job's sync;
    it just gets blank fields, correctable by hand.

    ocr_config_name selects which saved bar region to use (see ocr_configs).
    Rather than cropping separate Date/Time/Temperature/Location boxes, the
    WHOLE bar is OCR'd as one string and split apart by PATTERN, not
    position (see bar_ocr.parse_bar_text) — this is what makes Location
    immune to Temperature's varying width (1 vs. 2-digit Celsius, a
    negative sign, etc.) shifting where it lands, since nothing is cropped
    based on an assumed fixed position for it anymore.

    Passing SKIP_OCR_VALUE — or having no configs saved at all — skips
    everything; every field stays blank. Diel Period stays blank too if
    EITHER date or time couldn't be read from that reading.

    The bar box is scaled from the config's calibration resolution to THIS
    video's actual frame size (see _scale_box) — this is what keeps a
    single config working correctly across a batch where clips don't all
    share the exact same resolution.
    """
    defaults = {"date": None, "time": None, "location": None, "diel_period": None, "temperature": None}
    try:
        video_path = Path(folder) / filename
        if not video_path.is_file():
            return defaults
        frame = bar_ocr.extract_first_frame(video_path)
        frame_height, frame_width = frame.shape[:2]

        result = dict(defaults)

        config = _resolve_ocr_config(ocr_config_name)
        if not config or not config.get("bar_box"):
            return result  # Skip OCR selected, or no usable config — every field stays blank

        bar_box = _scale_box(
            tuple(config["bar_box"]), config.get("ref_width"), config.get("ref_height"),
            frame_width, frame_height,
        )
        raw_bar_text = bar_ocr.ocr_field(frame, bar_box, whitelist=bar_ocr.BAR_WHITELIST, psm=7)
        parsed = bar_ocr.parse_bar_text(raw_bar_text)

        parsed_date = bar_ocr.parse_date(parsed["raw_date"]) if parsed["raw_date"] else None
        parsed_time = bar_ocr.parse_time(parsed["raw_time"]) if parsed["raw_time"] else None

        if parsed_date:
            result["date"] = parsed_date.isoformat()
        if parsed_time:
            result["time"] = f"{parsed_time[0]:02d}:{parsed_time[1]:02d}:{parsed_time[2]:02d}"
        result["temperature"] = parsed["raw_temperature"]
        result["location"] = parsed["location"]

        if parsed_date and parsed_time:
            dt = datetime.combine(parsed_date, datetime.min.time()).replace(
                hour=parsed_time[0], minute=parsed_time[1], second=parsed_time[2]
            )
            result["diel_period"] = bar_ocr.diel_period(dt, bar_ocr.ARBORETUM_LAT, bar_ocr.ARBORETUM_LON)
        return result
    except Exception as e:
        print(f"OCR failed for {folder}/{filename}: {e}")
        return defaults


def save_bar_crop_safe(folder, filename, video_id, bar_box, ref_width=None, ref_height=None):
    """
    Saves the full info-bar QA crop for one video to BAR_CROPS_DIR, using
    the given bar_box (the active job's OCR config, or None for Skip OCR /
    no configs at all), scaled to this specific video's actual resolution
    via _scale_box — same reasoning as run_bar_ocr_safe. Never raises: one
    bad clip shouldn't take down the whole job's sync. Returns True/False
    for whether it succeeded — used to decide whether the Spreadsheet's
    "show cropped info bar" arrow exists for this video at all. With no
    bar_box (Skip OCR was used), there's genuinely nothing to crop, so this
    returns False rather than falling back to some other camera's region
    and showing a meaningless image.
    """
    if not bar_box:
        return False
    try:
        video_path = Path(folder) / filename
        if not video_path.is_file():
            return False
        frame = bar_ocr.extract_first_frame(video_path)
        frame_height, frame_width = frame.shape[:2]
        left, top, right, bottom = _scale_box(tuple(bar_box), ref_width, ref_height, frame_width, frame_height)
        output_path = BAR_CROPS_DIR / f"{video_id}.png"
        cv2.imwrite(str(output_path), frame[top:bottom, left:right])
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
        job_ocr_config = _resolve_ocr_config(job.get("ocr_config"))
        bar_box = job_ocr_config.get("bar_box") if job_ocr_config else None
        ref_width = job_ocr_config.get("ref_width") if job_ocr_config else None
        ref_height = job_ocr_config.get("ref_height") if job_ocr_config else None
        has_bar_crop = save_bar_crop_safe(job["folder"], filename, vid, bar_box, ref_width, ref_height)

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
                ocr_fields = run_bar_ocr_safe(job["folder"], filename, job.get("ocr_config"))

            videos[vid] = {
                "id": vid,
                "job_id": job_id,
                "folder": job["folder"],
                "filename": filename,
                "media_type": media_type_for_filename(filename),
                "ai_species": ai_species,          # None means blank
                "ai_classifier_conf": round(ai_conf, 2) if ai_conf is not None else None,
                "ai_detector_conf": round(ai_det_conf, 2) if ai_det_conf is not None else None,
                "corrected_species": existing.get("corrected_species"),
                "favorited": existing.get("favorited", False),
                "marked_for_review": existing.get("marked_for_review", True),
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
    ocr_config = (data.get("ocr_config") or "").strip()

    if not folder:
        return jsonify({"error": "No folder provided"}), 400
    if not Path(folder).is_dir():
        return jsonify({"error": f"Folder not found: {folder}"}), 400
    if ocr_config == CONFIGURE_NEW_VALUE:
        return jsonify({"error": "Finish configuring OCR settings before starting processing"}), 400

    global ocr_last_used
    if ocr_config:
        with ocr_configs_lock:
            ocr_last_used = ocr_config
        save_ocr_configs()

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
            "ocr_config": ocr_config,
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


@app.route("/api/ocr-configs")
def list_ocr_configs():
    """Named OCR presets for the Upload tab's dropdown, plus which was used last (the default selection)."""
    with ocr_configs_lock:
        names = sorted(ocr_configs.keys())
        last_used = ocr_last_used
    return jsonify({"configs": names, "last_used": last_used})


@app.route("/api/ocr-configs", methods=["POST"])
def save_ocr_config():
    """Saves a new named OCR preset (or overwrites one with the same name) from the wizard's final step."""
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    if name in (SKIP_OCR_VALUE, CONFIGURE_NEW_VALUE):
        return jsonify({"error": "That name is reserved"}), 400

    def clean_box(box):
        if not box or not (isinstance(box, list) and len(box) == 4):
            return None
        try:
            return [int(round(x)) for x in box]
        except (TypeError, ValueError):
            return None

    def clean_dim(value):
        try:
            value = int(value)
            return value if value > 0 else None
        except (TypeError, ValueError):
            return None

    bar_box = clean_box(data.get("bar_box"))
    if not bar_box:
        return jsonify({"error": "A bar region is required"}), 400

    global ocr_last_used
    with ocr_configs_lock:
        ocr_configs[name] = {
            "bar_box": bar_box,
            # The sample frame's actual size when this box was drawn — lets
            # OCR scale it correctly for any other video whose resolution
            # doesn't exactly match (see _scale_box).
            "ref_width": clean_dim(data.get("ref_width")),
            "ref_height": clean_dim(data.get("ref_height")),
        }
        ocr_last_used = name
    save_ocr_configs()
    return jsonify({"name": name})


@app.route("/api/ocr-configs/<name>", methods=["DELETE"])
def delete_ocr_config(name):
    """Removes a saved OCR preset. If it was the most-recently-used one, the
    default falls back to 'None' (Skip OCR) rather than pointing at a config
    that no longer exists."""
    global ocr_last_used
    with ocr_configs_lock:
        if name not in ocr_configs:
            return jsonify({"error": "Unknown preset"}), 404
        del ocr_configs[name]
        if ocr_last_used == name:
            ocr_last_used = SKIP_OCR_VALUE
    save_ocr_configs()
    return jsonify({"deleted": name})


def list_media_candidates_in_folder(folder):
    folder_path = Path(folder)
    return sorted(
        p for p in folder_path.iterdir()
        if p.is_file() and p.suffix.lower() in (VIDEO_EXTENSIONS | PHOTO_EXTENSIONS)
    )


@app.route("/api/ocr-wizard/first-frame")
def ocr_wizard_first_frame():
    """
    Returns a sample frame for the OCR-config wizard to draw crop boxes on.
    Tries each photo/video in the folder in order (alphabetically) until one
    actually produces a readable frame — a single corrupted file (often the
    very first one, alphabetically) shouldn't block calibration entirely.
    Which file ended up being used is reported via the X-Sample-Filename
    response header, so the review step can be pointed at that EXACT same
    file rather than independently re-picking "the first file" again (which
    could pick a different, unrelated file if the true first one failed
    here but the folder's contents changed, or just for consistency).
    """
    folder = request.args.get("folder", "")
    if not folder or not Path(folder).is_dir():
        return jsonify({"error": "Folder not found"}), 400

    candidates = list_media_candidates_in_folder(folder)
    if not candidates:
        return jsonify({"error": "No photo or video files found in this folder"}), 400

    frame = None
    used_path = None
    last_error = None
    for candidate in candidates:
        try:
            frame = bar_ocr.extract_first_frame(candidate)
            used_path = candidate
            break
        except Exception as e:
            last_error = e
            continue

    if frame is None:
        return jsonify({
            "error": f"Could not read a usable frame from any of the {len(candidates)} file(s) in this folder "
                     f"(last error: {last_error})"
        }), 500

    ok, encoded = cv2.imencode(".png", frame)
    if not ok:
        return jsonify({"error": "Failed to encode the frame as an image"}), 500

    response = Response(encoded.tobytes(), mimetype="image/png")
    response.headers["X-Sample-Filename"] = used_path.name
    return response


@app.route("/api/ocr-wizard/preview-readings", methods=["POST"])
def ocr_wizard_preview_readings():
    """
    Runs the SAME whole-bar-OCR-and-parse the real pipeline uses (see
    run_bar_ocr_safe) against the sample frame used to draw the bar region
    — no resolution scaling needed here, since this IS the calibration
    frame. Lets the wizard show "here's what this region actually reads"
    before saving, so a misaligned or too-tight bar box is obvious
    immediately instead of discovered days later across a whole batch.

    Expects the EXACT filename the first-frame endpoint actually used (see
    its X-Sample-Filename header) — falls back to re-picking the first
    readable candidate only if the caller doesn't provide one, but that
    fallback risks landing on a DIFFERENT file than whatever the bar region
    was actually drawn against if the true first file is unreadable.
    """
    data = request.get_json(force=True)
    folder = data.get("folder", "")
    if not folder or not Path(folder).is_dir():
        return jsonify({"error": "Folder not found"}), 400

    filename = data.get("filename")
    if filename:
        if "/" in filename or "\\" in filename or ".." in filename:
            return jsonify({"error": "Invalid filename"}), 400
        media_path = Path(folder) / filename
        if not media_path.is_file():
            return jsonify({"error": f"{filename} no longer exists in this folder"}), 400
    else:
        candidates = list_media_candidates_in_folder(folder)
        if not candidates:
            return jsonify({"error": "No photo or video files found in this folder"}), 400
        media_path = candidates[0]

    bar_box = data.get("bar_box")
    if not bar_box or not (isinstance(bar_box, list) and len(bar_box) == 4):
        return jsonify({"error": "No bar region provided"}), 400

    try:
        frame = bar_ocr.extract_first_frame(media_path)
    except Exception as e:
        return jsonify({"error": f"Could not read a frame from {media_path.name}: {e}"}), 500

    try:
        box = tuple(int(round(x)) for x in bar_box)
        raw_bar_text = bar_ocr.ocr_field(frame, box, whitelist=bar_ocr.BAR_WHITELIST, psm=7)
        parsed = bar_ocr.parse_bar_text(raw_bar_text)
    except Exception as e:
        return jsonify({"error": f"OCR failed: {e}"}), 500

    return jsonify({
        "raw_bar_text": raw_bar_text,
        "date": parsed["raw_date"],
        "time": parsed["raw_time"],
        "temperature": parsed["raw_temperature"],
        "location": parsed["location"],
    })


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


def prune_unused_locations():
    """
    Removes any location from the locations database that no video
    currently references — e.g. after the last video pointing to it was
    deleted, or had its Location field edited to something else. Runs on
    read (see list_locations/list_missing_locations) rather than being
    hooked into every place a video's location can change (delete, manual
    edit, bulk merge, etc.) — self-heals regardless of how the reference
    disappeared, instead of relying on catching every mutation site.
    """
    with videos_lock:
        used = {v["location"] for v in videos.values() if v.get("location")}
    with locations_lock:
        orphaned = [name for name in locations if name not in used]
        for name in orphaned:
            del locations[name]
    if orphaned:
        save_locations()


@app.route("/api/locations")
def list_locations():
    """Every location that has confirmed coordinates — name -> {lat, lon}."""
    prune_unused_locations()
    with locations_lock:
        return jsonify(locations)


@app.route("/api/locations/missing")
def list_missing_locations():
    """
    Location names currently used by at least one video but with no
    confirmed coordinates yet — what the Track tab checks on open to decide
    whether to prompt for coordinates.
    """
    prune_unused_locations()
    with videos_lock:
        used = {v["location"] for v in videos.values() if v.get("location")}
    with locations_lock:
        known = set(locations.keys())
    return jsonify({"missing": sorted(used - known)})


@app.route("/api/locations/merge", methods=["POST"])
def merge_locations():
    """
    One endpoint covers all three location-editing actions from the Track
    tab's setup popup, since they're really the same operation at different
    scales:
      - Add coordinates to an existing name: source_names=[name], target_name=name
      - Rename a location:                   source_names=[old],  target_name=new
      - Merge several into one:              source_names=[a,b,c], target_name=merged
    Every video whose location matches any of source_names is updated to
    target_name, and the locations database is updated to reflect only the
    target name with the given coordinates — source names other than the
    target are removed from it.
    """
    data = request.get_json(force=True)
    source_names = data.get("source_names")
    target_name = (data.get("target_name") or "").strip()
    lat = data.get("lat")
    lon = data.get("lon")

    if not isinstance(source_names, list) or not source_names:
        return jsonify({"error": "At least one source location is required"}), 400
    if not target_name:
        return jsonify({"error": "Target name is required"}), 400
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return jsonify({"error": "Valid latitude and longitude are required"}), 400
    if not (-90 <= lat <= 90):
        return jsonify({"error": "Latitude must be between -90 and 90"}), 400
    if not (-180 <= lon <= 180):
        return jsonify({"error": "Longitude must be between -180 and 180"}), 400

    source_set = set(source_names)
    with videos_lock:
        updated_count = 0
        for v in videos.values():
            if v.get("location") in source_set:
                v["location"] = target_name
                updated_count += 1
    save_videos_index()

    with locations_lock:
        for name in source_set:
            if name != target_name:
                locations.pop(name, None)
        locations[target_name] = {"lat": lat, "lon": lon}
    save_locations()

    return jsonify({
        "target_name": target_name, "lat": lat, "lon": lon,
        "videos_updated": updated_count,
    })


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
        if species:
            # Confirming a species is itself an act of reviewing — clears the
            # mark. Clearing a correction (empty species) is more of an
            # "undo" than a review, so it deliberately leaves the mark as-is.
            videos[video_id]["marked_for_review"] = False
        record = dict(videos[video_id])
    save_videos_index()
    return jsonify({**record, "display_species": display_species(record)})


@app.route("/api/videos/<video_id>/update", methods=["POST"])
def update_video_metadata(video_id):
    """
    Edits Date, Time, Location, Diel Period, Temperature, Count, Notes,
    File Name, and/or the Marked-for-review flag. Any subset of these can be
    sent — only the provided keys are changed. Editing
    date/time/location/diel_period/temperature marks the video as manually
    edited, which freezes ALL FIVE against being overwritten by OCR if this
    job is ever re-synced (see sync_videos_from_job).
    """
    data = request.get_json(force=True)
    allowed_fields = {
        "date", "time", "location", "diel_period", "temperature", "count", "notes",
        "display_filename", "marked_for_review",
    }
    updates = {k: v for k, v in data.items() if k in allowed_fields}

    if "count" in updates:
        try:
            count = int(updates["count"])
        except (TypeError, ValueError):
            return jsonify({"error": "Count must be a whole number"}), 400
        if count < 0:
            return jsonify({"error": "Count can't be negative"}), 400
        updates["count"] = count

    if "marked_for_review" in updates:
        updates["marked_for_review"] = bool(updates["marked_for_review"])

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


@app.route("/api/videos/clear-all-marks", methods=["POST"])
def clear_all_review_marks():
    """Clears marked_for_review on every video at once — the Settings tab's
    bulk 'clear all marked for review' action."""
    with videos_lock:
        cleared_count = sum(1 for v in videos.values() if v.get("marked_for_review"))
        for v in videos.values():
            v["marked_for_review"] = False
    save_videos_index()
    return jsonify({"cleared_count": cleared_count})


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

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
import csv
import hashlib
import io
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

THUMBNAILS_DIR = RUNS_DIR / "thumbnails"
THUMBNAILS_DIR.mkdir(exist_ok=True)
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
ocr_disabled = False
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
            json.dump({"configs": ocr_configs, "last_used": ocr_last_used, "disabled": ocr_disabled}, f, indent=2)


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
    global ocr_configs, ocr_last_used, ocr_disabled
    loaded = load_json(OCR_CONFIGS_FILE, None)
    if loaded is not None:
        ocr_configs = loaded.get("configs", {})
        ocr_last_used = loaded.get("last_used")
        ocr_disabled = loaded.get("disabled", False)
        return

    ocr_configs = {}
    ocr_last_used = SKIP_OCR_VALUE
    ocr_disabled = False
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
    "has_bar_crop": False, "media_type": "video", "has_thumbnail": False,
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
    Rather than cropping separate Date/Time/Temperature boxes, the WHOLE bar
    is OCR'd as one string and split apart by PATTERN, not position (see
    bar_ocr.parse_bar_text) — so each field is found wherever it actually
    sits, immune to Temperature's varying width (1 vs. 2-digit Celsius, a
    negative sign, etc.) shifting the others along.

    Location is NOT read here — it's selected by the user at upload time
    and applied to every video in the job (see sync_videos_from_job).

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


def save_best_frame_thumbnail(video_path, video_id, frame_number):
    """
    Saves ONE specific frame from a video as a JPEG thumbnail to
    THUMBNAILS_DIR — used by the Library/Favorites grid so cards can show a
    still image instead of rendering an actual <video> element for every
    card at once. frame_number is a 0-based frame index to seek directly
    to (see run_bar_ocr_safe's caller in sync_videos_from_job: this is
    normally the exact frame that produced the highest-confidence
    classification for the video's predicted species, taken straight from
    predictions.json's per-detection frame_number field — no need to
    re-scan the video ourselves to find it).

    Never raises — one bad clip shouldn't take down the whole job's sync.
    Returns True/False for whether it succeeded.
    """
    try:
        video_path = Path(video_path)
        if not video_path.is_file():
            return False
        cap = cv2.VideoCapture(str(video_path))
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_number))
        ok, frame = cap.read()
        cap.release()
        if not ok:
            return False
        output_path = THUMBNAILS_DIR / f"{video_id}.jpg"
        cv2.imwrite(str(output_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return True
    except Exception as e:
        print(f"Thumbnail extraction failed for {video_path}: {e}")
        return False


def video_id_for(job_id, filename):
    return hashlib.sha1(f"{job_id}:{filename}".encode()).hexdigest()[:16]


def _bbox_touches_edge(bbox, margin=0.02):
    """
    True if a normalized [x, y, width, height] detection bounding box
    touches or extends past the video frame's edge (within a small
    tolerance margin, to allow for minor detection imprecision right at
    the boundary without being overly strict). Used when picking a
    thumbnail frame — a detection like this means the animal is partially
    cut off in that particular frame.
    """
    x, y, w, h = bbox
    return x <= margin or y <= margin or (x + w) >= (1.0 - margin) or (y + h) >= (1.0 - margin)


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

        species_best = {}  # label -> (classifier_conf, detector_conf, frame_number) — determines the predicted species/confidence, unchanged by the thumbnail logic below
        species_frame_candidates = {}  # label -> [(classifier_conf, frame_number, bbox), ...] — every detection, used only to pick a well-framed thumbnail
        for d in dets:
            if "classifications" not in d:
                continue
            cls_idx, cls_conf = d["classifications"][0]
            label = class_cats.get(cls_idx, cls_idx)
            if label == "blank":
                continue
            if label not in species_best or cls_conf > species_best[label][0]:
                species_best[label] = (cls_conf, d.get("conf", 0), d.get("frame_number"))
            species_frame_candidates.setdefault(label, []).append(
                (cls_conf, d.get("frame_number"), d.get("bbox"))
            )

        ai_species, ai_conf, ai_det_conf, best_frame_number = None, None, None, None
        if species_best:
            ai_species, (ai_conf, ai_det_conf, best_frame_number) = max(
                species_best.items(), key=lambda kv: kv[1][0]
            )

            # For the THUMBNAIL specifically (not the species/confidence
            # above, which stay exactly as computed), prefer a frame where
            # the animal is fully within the video frame. Classification
            # confidence alone doesn't capture framing — a detection whose
            # box touches the edge (animal partially cut off) can still
            # score marginally higher than a fully-in-frame alternative a
            # few frames later (e.g. slightly less motion blur, or a
            # tighter close-up of just-visible fur/features), even though
            # it makes a visibly worse thumbnail. Falls back to the
            # highest-confidence frame if every candidate is edge-clipped.
            candidates = species_frame_candidates.get(ai_species, [])
            fully_in_frame = [c for c in candidates if c[2] and not _bbox_touches_edge(c[2])]
            pool = fully_in_frame if fully_in_frame else candidates
            if pool:
                _, best_frame_number, _ = max(pool, key=lambda c: c[0])

        vid = video_id_for(job_id, filename)
        job_ocr_config = _resolve_ocr_config(job.get("ocr_config"))
        bar_box = job_ocr_config.get("bar_box") if job_ocr_config else None
        ref_width = job_ocr_config.get("ref_width") if job_ocr_config else None
        ref_height = job_ocr_config.get("ref_height") if job_ocr_config else None
        has_bar_crop = save_bar_crop_safe(job["folder"], filename, vid, bar_box, ref_width, ref_height)

        # Thumbnails only apply to videos — a photo already IS a single
        # still image, cheap to display directly with no need to extract
        # anything from it. Prefer the frame that produced the winning
        # species classification (best_frame_number, from predictions.json);
        # fall back to the first frame when there was no confident
        # detection at all (a "blank" clip), so every video still gets
        # SOME thumbnail rather than none.
        has_thumbnail = False
        if media_type_for_filename(filename) == "video":
            frame_for_thumbnail = best_frame_number if best_frame_number is not None else 0
            video_path = Path(job["folder"]) / filename
            has_thumbnail = save_best_frame_thumbnail(video_path, vid, frame_for_thumbnail)

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
                # Location is chosen by the user at upload time, not read by
                # OCR — every video in this job shares the same, deliberately
                # selected location.
                ocr_fields["location"] = job.get("location")

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
                "has_thumbnail": has_thumbnail,
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
    ocr_config = (data.get("ocr_config") or "").strip()
    location = (data.get("location") or "").strip()

    if not folder:
        return jsonify({"error": "No folder provided"}), 400
    if not Path(folder).is_dir():
        return jsonify({"error": f"Folder not found: {folder}"}), 400
    if not location:
        return jsonify({"error": "A location is required"}), 400
    with locations_lock:
        known_location = location in locations
    if not known_location:
        return jsonify({"error": f"Unknown location: {location}"}), 400
    if ocr_config == CONFIGURE_NEW_VALUE:
        return jsonify({"error": "Finish configuring OCR settings before starting processing"}), 400

    global ocr_last_used
    with ocr_configs_lock:
        disabled = ocr_disabled
    if disabled:
        # OCR is globally disabled (Settings tab) — enforced here rather
        # than trusting the frontend to have hidden the dropdown, so a
        # stale page or a direct API call can't bypass it.
        ocr_config = SKIP_OCR_VALUE
    elif ocr_config:
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

    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "folder": folder,
            "ocr_config": ocr_config,
            "location": location,
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
    """Named OCR presets for the Upload tab's dropdown, which was used last (the default selection), and whether OCR is globally disabled."""
    with ocr_configs_lock:
        names = sorted(ocr_configs.keys())
        last_used = ocr_last_used
        disabled = ocr_disabled
    return jsonify({"configs": names, "last_used": last_used, "disabled": disabled})


@app.route("/api/ocr-configs/disabled", methods=["POST"])
def set_ocr_disabled():
    """
    Toggles OCR globally on/off (the Settings tab's "Disable OCR" switch).
    When disabled, every new job is submitted with OCR skipped regardless
    of what the Upload tab's dropdown would otherwise select — see
    run_job, which enforces this server-side rather than trusting the
    frontend to have hidden the dropdown.
    """
    data = request.get_json(force=True)
    global ocr_disabled
    with ocr_configs_lock:
        ocr_disabled = bool(data.get("disabled"))
    save_ocr_configs()
    return jsonify({"disabled": ocr_disabled})


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
    No-op, kept so existing call sites stay valid.

    This used to delete any location no video referenced, back when
    locations were derived implicitly from OCR text and an unreferenced
    entry really did mean stale data. That's no longer true: locations are
    now a deliberately curated list the user maintains in Settings and
    picks from at upload time, so an unused location is a legitimately
    pre-registered camera site — often one added minutes before its first
    footage is even processed.

    Auto-pruning actively broke that flow: a newly added location has no
    videos by definition, so it was saved and then silently deleted on the
    very next read, making it look like adding a location did nothing.
    """
    return


@app.route("/api/locations")
def list_locations():
    """
    Every known location name -> {lat, lon}. lat/lon may be null if the
    name has been registered (via a rename/merge saved without
    coordinates, or "Add new location") but coordinates haven't been added
    yet.
    """
    prune_unused_locations()
    with locations_lock:
        return jsonify(locations)


@app.route("/api/locations/missing")
def list_missing_locations():
    """
    Location names referenced by a video but absent from the curated
    locations list — normally only legacy entries from before locations
    were chosen explicitly at upload time, since every location saved now
    requires coordinates. What the Track tab checks to decide whether to
    show its missing-coordinates overlay.
    """
    with videos_lock:
        used = {v["location"] for v in videos.values() if v.get("location")}
    with locations_lock:
        known = set(locations.keys())
    return jsonify({"missing": sorted(used - known)})


@app.route("/api/locations/delete", methods=["POST"])
def delete_location():
    """
    Removes a location from the curated list.

    Videos already tagged with it KEEP their location text — deleting a
    location means "stop offering this for new uploads", not "rewrite
    history on footage already filed under it". Those videos then show up
    via /api/locations/missing (a name in use but not in the list), so
    nothing silently loses its location; it just needs re-adding or
    correcting if you want it back on the map.

    The response reports how many videos still reference the name so the
    frontend can warn before deleting one that's actually in use.
    """
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "A name is required"}), 400

    with locations_lock:
        if name not in locations:
            return jsonify({"error": f"Unknown location: {name}"}), 404
        del locations[name]
    save_locations()

    with videos_lock:
        still_referencing = sum(1 for v in videos.values() if v.get("location") == name)

    return jsonify({"deleted": name, "videos_still_referencing": still_referencing})


@app.route("/api/locations/merge", methods=["POST"])
def merge_locations():
    """
    One endpoint covers three location-editing actions from the Settings
    tab's location manager, since they're really the same operation at
    different scales:
      - Create a brand-new location: source_names=[],     target_name=new
      - Update an existing location: source_names=[name], target_name=name
      - Rename a location:           source_names=[old],  target_name=new
    Every video whose location matches any of source_names is updated to
    target_name, and the locations database is updated to reflect only the
    target name — source names other than the target are removed from it.

    Name, latitude, and longitude are ALL required to save a location.
    """
    data = request.get_json(force=True)
    source_names = data.get("source_names")
    target_name = (data.get("target_name") or "").strip()
    lat_raw = data.get("lat")
    lon_raw = data.get("lon")

    if not isinstance(source_names, list):
        return jsonify({"error": "source_names must be a list (can be empty for a brand-new location)"}), 400
    if not target_name:
        return jsonify({"error": "A name is required"}), 400
    if lat_raw is None or lat_raw == "" or lon_raw is None or lon_raw == "":
        return jsonify({"error": "Latitude and longitude are required"}), 400
    try:
        lat = float(lat_raw)
        lon = float(lon_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "Latitude and longitude must be numbers"}), 400
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


def _parse_locations_csv(content):
    """
    Parses CSV content into (valid_rows, skipped, error). valid_rows is a
    list of {"name", "lat", "lon"} dicts — nothing is written to the
    locations database here. Shared by the preview and commit endpoints;
    commit re-parses/re-validates rather than trusting rows handed back by
    the client, since that request is raw JSON rather than a freshly
    re-uploaded file.
    """
    reader = csv.DictReader(io.StringIO(content))
    if not reader.fieldnames:
        return None, None, "The file appears to be empty"

    field_map = {(f or "").strip().lower(): f for f in reader.fieldnames}
    name_col = field_map.get("name")
    lat_col = field_map.get("lat") or field_map.get("latitude")
    lon_col = field_map.get("lon") or field_map.get("lng") or field_map.get("longitude")

    missing_cols = [
        label for label, col in [("name", name_col), ("lat/latitude", lat_col), ("lon/lng/longitude", lon_col)]
        if not col
    ]
    if missing_cols:
        return None, None, f"Missing required column(s): {', '.join(missing_cols)}"

    valid_rows = []
    skipped = []
    for row_num, row in enumerate(reader, start=2):  # row 1 is the header
        name = (row.get(name_col) or "").strip()
        lat_raw = (row.get(lat_col) or "").strip()
        lon_raw = (row.get(lon_col) or "").strip()

        if not name:
            skipped.append({"row": row_num, "reason": "missing name"})
            continue
        try:
            lat = float(lat_raw)
            lon = float(lon_raw)
        except ValueError:
            skipped.append({"row": row_num, "name": name, "reason": "latitude/longitude not numeric"})
            continue
        if not (-90 <= lat <= 90):
            skipped.append({"row": row_num, "name": name, "reason": "latitude out of range (-90 to 90)"})
            continue
        if not (-180 <= lon <= 180):
            skipped.append({"row": row_num, "name": name, "reason": "longitude out of range (-180 to 180)"})
            continue

        valid_rows.append({"name": name, "lat": lat, "lon": lon})

    return valid_rows, skipped, None


@app.route("/api/locations/import-csv/preview", methods=["POST"])
def preview_locations_csv():
    """
    Parses and validates an uploaded CSV WITHOUT writing anything, and
    flags any row whose name already has coordinates in the locations
    database as a "conflict" (old value alongside the new one) — the
    frontend shows these for confirmation before committing, since
    importing directly would otherwise silently overwrite existing
    coordinates with no warning.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "No file selected"}), 400

    try:
        content = file.read().decode("utf-8-sig")  # utf-8-sig strips a BOM, common in Excel-exported CSVs
    except UnicodeDecodeError:
        return jsonify({"error": "Could not read the file as text — make sure it's a plain CSV"}), 400

    valid_rows, skipped, error = _parse_locations_csv(content)
    if error:
        return jsonify({"error": error}), 400

    conflicts = []
    new_count = 0
    with locations_lock:
        for row in valid_rows:
            existing = locations.get(row["name"])
            if existing:
                conflicts.append({"name": row["name"], "existing": existing, "new": {"lat": row["lat"], "lon": row["lon"]}})
            else:
                new_count += 1

    return jsonify({
        "valid_rows": valid_rows,  # the full set (new + conflicting) — commit uses this as-is if confirmed
        "new_count": new_count,
        "conflicts": conflicts,
        "skipped": skipped,
    })


@app.route("/api/locations/import-csv/commit", methods=["POST"])
def commit_locations_csv():
    """
    Actually writes a previously-previewed set of rows into the locations
    database (see preview_locations_csv). Re-validates every row rather
    than trusting the client, since this accepts raw JSON, not a freshly
    re-uploaded file.
    """
    data = request.get_json(force=True)
    rows = data.get("rows")
    if not isinstance(rows, list) or not rows:
        return jsonify({"error": "No rows to import"}), 400

    imported_names = []
    skipped = []
    for i, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            skipped.append({"row": i, "reason": "malformed row"})
            continue
        name = (row.get("name") or "").strip()
        if not name:
            skipped.append({"row": i, "reason": "missing name"})
            continue
        try:
            lat = float(row.get("lat"))
            lon = float(row.get("lon"))
        except (TypeError, ValueError):
            skipped.append({"row": i, "name": name, "reason": "latitude/longitude not numeric"})
            continue
        if not (-90 <= lat <= 90):
            skipped.append({"row": i, "name": name, "reason": "latitude out of range (-90 to 90)"})
            continue
        if not (-180 <= lon <= 180):
            skipped.append({"row": i, "name": name, "reason": "longitude out of range (-180 to 180)"})
            continue

        with locations_lock:
            locations[name] = {"lat": lat, "lon": lon}
        imported_names.append(name)

    if imported_names:
        save_locations()

    return jsonify({
        "imported_count": len(imported_names),
        "imported_names": imported_names,
        "skipped": skipped,
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


@app.route("/api/videos/<video_id>/thumbnail")
def serve_thumbnail(video_id):
    """Serves the saved best-frame thumbnail for one video (see
    save_best_frame_thumbnail in sync_videos_from_job) — the Library/
    Favorites grid uses this instead of rendering an actual <video> element
    for every card at once."""
    with videos_lock:
        record = videos.get(video_id)
    if not record:
        abort(404)
    thumb_path = THUMBNAILS_DIR / f"{video_id}.jpg"
    if not thumb_path.is_file():
        abort(404)
    return send_from_directory(str(THUMBNAILS_DIR), f"{video_id}.jpg")


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

# ArbCameraTrapCV

A trail camera triage tool built for the UCF Arboretum, combining automated
species detection with metadata extraction to turn raw camera trap footage
into a searchable, taggable, spreadsheet-ready dataset — without ever moving
or duplicating the original video files.

## Why this exists

The Arboretum's trail cameras generate far more footage than a small team can
realistically review by hand — most of it blank or repetitive. This tool
exists to cut that manual burden down to what actually matters: confirming
and correcting AI-generated species tags, rather than watching every clip
from scratch. It's meant for a small team (student workers, interns, research
staff) to jointly process, tag, and curate footage, with results that plug
directly into ecological recordkeeping and outreach/marketing use.

## What it does

**Detection & metadata, automatically:**
- Runs each uploaded folder of clips through [SpeciesNet](https://github.com/google/cameratrapai) (via MegaDetector) to detect and classify wildlife per video.
- Reads the camera's burned-in info bar (via OCR) to pull **Date**, **Time**, and **Location Name** directly off each clip's first frame.
- Computes **Diel Period** (Day / Night / Dawn / Dusk) from the extracted date/time and the Arboretum's coordinates, using actual sunrise/sunset/twilight times rather than a fixed clock cutoff.

**A processing queue you can actually see and control:**
- Jobs run one at a time (protects the GPU from multiple simultaneous SpeciesNet runs).
- Live log output for whatever's currently processing.
- Cancel a queued or in-progress job if the wrong folder gets submitted.

**A library that stays in sync with your files, not a copy of them:**
- Videos are served directly from wherever they were uploaded from — never copied or moved.
- Every video gets a persistent record: species tag, Date/Time/Location/Diel Period, a manual Count, free-text Notes, and a favorite flag.
- Human corrections (species, metadata, count, notes) always win over AI/OCR output and are never silently overwritten on reprocessing.

**Three ways to work with the data:**
- **Library** — browse and filter all footage by species, correct wrong AI tags (with a searchable species picker covering the full SpeciesNet taxonomy, including species with zero clips so far).
- **Favorites** — a shared, team-wide curated collection for media/marketing use.
- **Spreadsheet** — every video as a row (Date, Time, Location, Species, Count, Notes, File Name, Diel Period), click any cell to edit inline, and copy a row straight into Excel with one click.

## How it works

```
Upload tab → folder submitted → job queued → single worker thread:
    1. run_md_and_speciesnet (MegaDetector + SpeciesNet) → predictions.json
    2. per video: OCR the first frame's info bar → Date/Time/Location → Diel Period
    3. results merged into a persistent per-video library record
```

- **Backend:** Flask (`app.py`), single background worker thread processing a FIFO job queue.
- **Detection:** Google's [MegaDetector + SpeciesNet](https://github.com/google/cameratrapai) pipeline, run as a subprocess per submitted folder.
- **OCR:** `bar_ocr.py` — Tesseract OCR on cropped regions of each camera model's fixed info-bar layout, tuned specifically against this Arboretum's camera footage (see "Calibration" below).
- **Storage:** all metadata lives in `runs/` as JSON (`jobs_index.json`, `videos_index.json`, `species_list.json`) — no database. Videos themselves are never touched; only the metadata pointing at them is stored.
- **Frontend:** vanilla HTML/CSS/JS, no build step.

## Setup

```bash
pip install flask speciesnet megadetector opencv-python pytesseract astral
```

You'll also need the Tesseract OCR binary itself (the `pytesseract` package is
just a Python wrapper around it):
- **macOS:** `brew install tesseract`
- **Windows:** [UB-Mannheim build](https://github.com/UB-Mannheim/tesseract/wiki)
- **Linux:** `apt install tesseract-ocr`

Run the app:
```bash
python app.py
```
Then open **http://localhost:5000**.

> **Note:** the app deliberately runs with Flask's debug auto-reloader
> disabled. The reloader spawns a second process, which would start a
> second job-processing worker — exactly what the single-worker queue
> exists to prevent. Restart manually after any code changes.

## Calibration (one-time, per camera model)

`bar_ocr.py`'s `CROP_BOXES` define the exact pixel regions for Date, Time,
and Location on the info bar — these are specific to camera model and video
resolution. If you add a new camera model:

1. Run against a sample clip with `--preview` to dump its first frame.
2. Note the pixel coordinates for each field (as `left, top, right, bottom`) — leave a few pixels of margin on every side; a crop that clips a character's edge can cause misreads.
3. Update `CROP_BOXES` accordingly.
4. Update `ARBORETUM_LAT` / `ARBORETUM_LON` once, if not already set — used for Diel Period calculation, shared across all camera sites on the property.

## Project structure

```
app.py               Flask backend: job queue, video library, all API routes
bar_ocr.py           OCR pipeline for the camera's burned-in info bar
templates/index.html Single-page frontend (Upload / Library / Favorites / Spreadsheet tabs)
static/script.js     All frontend logic
static/style.css     Styling
runs/                Per-job outputs + the video/species/job metadata stores (gitignored)
```

## Known limitations

- OCR accuracy depends on the crop boxes being correctly calibrated per camera model — a too-tight crop is the most common cause of misreads.
- The processing queue is single-worker by design (GPU memory safety); a large batch of folders will process sequentially, not in parallel.
- Deleting a video from the library only removes its metadata — if the same folder is ever reprocessed, it reappears as a fresh, unedited entry.
- Species correction and OCR-derived fields are validated against the SpeciesNet taxonomy and basic type-checking respectively, but there's no review/approval workflow beyond direct edits — anyone with access can edit any record.

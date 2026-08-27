# ArbCameraTrapCV

A trail camera triage tool built for the UCF Arboretum, combining automated
species detection with metadata extraction to turn raw camera trap footage
into a searchable, taggable, mappable dataset — without ever moving or
duplicating the original media files.

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
- Runs each uploaded folder through [SpeciesNet](https://github.com/google/cameratrapai) (via MegaDetector) to detect and classify wildlife. Handles both **video and still photos**.
- Reads the camera's burned-in info bar via OCR to pull **Date**, **Time**, and **Temperature** off each clip's first frame.
- Computes **Diel Period** (Day / Night / Dawn / Dusk) from the extracted date/time and the Arboretum's coordinates, using actual sunrise/sunset/twilight times rather than a fixed clock cutoff.
- Extracts a **thumbnail** per video from the frame that produced the highest-confidence species classification, preferring frames where the animal isn't clipped at the edge. Cards show these stills instead of loading every video at once.

**Location is chosen, not guessed.** You pick the camera site from a dropdown
when submitting a folder, and every clip in that batch is tagged with it.
Locations are a curated list (name + latitude + longitude) managed in
Settings, so map data stays clean instead of depending on OCR reading a
camera label correctly.

**A processing queue you can see and control:**
- Jobs run one at a time (protects the GPU from multiple simultaneous SpeciesNet runs).
- Live log output for whatever's currently processing.
- Cancel a queued or in-progress job if the wrong folder gets submitted.
- Queued jobs survive a restart — they're rebuilt from disk on startup.

**A library that stays in sync with your files, not a copy of them:**
- Media is served directly from wherever it was uploaded from — never copied or moved.
- Every entry gets a persistent record: species tag, Date/Time/Location/Diel Period/Temperature, a manual Count, free-text Notes, a favorite flag, and a marked-for-review flag.
- Human corrections always win over AI/OCR output and are never silently overwritten on reprocessing.

## The tabs

- **Upload** — pick a folder, pick a location, pick an OCR preset, submit. Queue and live log sit below.
- **Review** — a one-at-a-time queue of everything marked for review. Confirm or correct the species and fill in metadata without hunting through the library.
- **Library** — browse by species group. Click any card's image to expand it alongside a panel for Count, Notes, favoriting, review-marking, and deleting. Correct wrong AI tags with a searchable picker covering the full SpeciesNet taxonomy.
- **Favorites** — a shared, team-wide curated collection for media/outreach use.
- **Spreadsheet** — every entry as a row (Date, Time, Location, Species, Count, Notes, File Name, Diel Period, Temperature). Click any cell to edit inline, sort on stacked criteria, search across all fields, and export to CSV.
- **Track** — an interactive map of camera locations built on [Waymark JS](https://www.ogis.org/waymark-js/) (basemap switching, marker clustering, overlay filtering), with a chronological card list beside it. Filter by date range, species, and which locations to show; the map markers and the cards always reflect the same filters.
- **Settings** — hidden species groups, temperature units (°F/°C), OCR presets, a global OCR on/off switch, bulk-clear review marks, and full location management.

### The review-mark system

"Marked for review" is tracked independently of whether a species has been
confirmed. New entries start marked; you can unmark something without
confirming its species, or re-mark an already-confirmed entry to take another
look. The badge counts in the top bar and on each species card reflect this
flag, as does the Review tab's queue.

Within a species group, marked entries sort to the top — but the order is
frozen while you're working in that group, so reviewing a card doesn't make
the grid reshuffle under you. It re-sorts next time you enter.

## OCR configuration

OCR is configured **through the UI, not by editing code**. When you submit a
folder without a saved preset, a wizard opens: draw a box around the info bar
on a sample frame, confirm the parsed Date/Time/Temperature readings, name
the preset, and processing starts with it.

The whole bar is read as one string and split by **pattern** rather than
position, so fields are found wherever they sit. A varying-width temperature
(1 vs. 2 digit Celsius, a minus sign) can't shift the other fields out of
alignment. Presets store the bar region relative to the sample's resolution,
so they scale to other resolutions in the same batch.

OCR can be turned off entirely in Settings, in which case Date/Time/
Temperature/Diel Period are filled in by hand in the Spreadsheet tab.

## Location management

Managed in **Settings → Manage Locations**. A location needs a name,
latitude, and longitude. You can add them one at a time, add one inline while
uploading, or bulk-import from CSV (`name,lat,lon` — headers are matched
case-insensitively and accept `latitude`/`longitude`/`lng`). CSV import shows
a preview first and asks before overwriting any location that already has
coordinates. Renaming a location updates every entry tagged with it.

## How it works

```
Upload tab → folder + location submitted → job queued → single worker thread:
    1. run_md_and_speciesnet (MegaDetector + SpeciesNet) → predictions.json
    2. per file: OCR the info bar → Date/Time/Temperature → Diel Period
                 extract best-frame thumbnail (videos only)
                 apply the location chosen at upload
    3. results merged into a persistent per-entry library record
```

- **Backend:** Flask (`app.py`), single background worker thread processing a FIFO job queue.
- **Detection:** Google's [MegaDetector + SpeciesNet](https://github.com/google/cameratrapai) pipeline, run as a subprocess per submitted folder.
- **OCR:** `bar_ocr.py` — Tesseract on the info-bar region defined by the active preset.
- **Storage:** JSON under `runs/` — no database. Media files themselves are never touched; only the metadata pointing at them.
- **Frontend:** vanilla HTML/CSS/JS, no build step.

## Setup

```bash
pip install -r requirements.txt
```

You'll also need the Tesseract OCR binary itself (`pytesseract` is just a
Python wrapper around it):
- **macOS:** `brew install tesseract`
- **Windows:** [UB-Mannheim build](https://github.com/UB-Mannheim/tesseract/wiki)
- **Linux:** `apt install tesseract-ocr`

### Running

Development:
```bash
python app.py
```

Production:
```bash
gunicorn -c gunicorn.conf.py wsgi:app
```

> **This app must run as a single process.** The Flask reloader is disabled,
> and Gunicorn is pinned to `workers = 1` (with a startup guard that refuses
> to boot otherwise). A second process would start a second job-queue worker
> and keep its own copy of the in-memory state. Concurrency comes from
> threads instead — a single worker comfortably serves the whole team. See
> the comment at the top of `gunicorn.conf.py`.

## Project structure

```
app.py                Flask backend: job queue, library, all API routes
bar_ocr.py            OCR pipeline for the camera's burned-in info bar
wsgi.py               WSGI entry point for Gunicorn
gunicorn.conf.py      Production server config (see the single-worker warning)
requirements.txt      Python dependencies
templates/index.html  Single-page frontend
static/script.js      All frontend logic
static/style.css      Styling
runs/                 Job outputs + metadata stores (gitignored):
                        jobs_index.json, videos_index.json,
                        species_list.json, locations.json,
                        ocr_configs.json, bar_crops/, thumbnails/
```

## Known limitations

- **The "Browse…" button only works on the machine running the server.** It opens a native folder dialog on the *server*, so a remote user clicking it sees nothing happen. Fine when the app is used on the machine it runs on; a blocker for genuine remote use.
- **No authentication or per-user accounts.** Everyone sees and edits the same library, and simultaneous edits to the same record are last-write-wins.
- OCR accuracy depends on the bar region being drawn accurately in the wizard — leave a few pixels of margin, since a crop clipping a character's edge is the most common cause of misreads.
- The processing queue is single-worker by design (GPU memory safety); a large batch of folders processes sequentially.
- Deleting an entry only removes its metadata — if the same folder is reprocessed, it reappears as a fresh, unedited entry.
- **JSON storage scales to roughly 10,000 entries.** Every save rewrites the whole file while holding a lock, so edits slow noticeably past that (~150ms at 10k, ~800ms at 50k), and the frontend refetches the full list on several actions. Moving the metadata to SQLite is the fix when it starts to bite.

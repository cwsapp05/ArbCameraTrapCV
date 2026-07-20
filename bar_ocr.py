"""
Extract Date, Time, and Location Name from the burned-in info bar on the
first frame of Bushnell trail cam clips, then compute Diel Period
(Day/Night/Dawn/Dusk) from the date/time + camera coordinates.

This does NOT require training a model. Bushnell's info bar is a fixed
digital overlay (consistent font, consistent position for a given camera
model/resolution) — plain OCR on cropped sub-regions is usually enough.

Install:
    pip install opencv-python pytesseract astral
    # + install the Tesseract binary itself (not just the Python wrapper):
    #   Windows: https://github.com/UB-Mannheim/tesseract/wiki
    #   Mac:     brew install tesseract
    #   Linux:   apt install tesseract-ocr

STEP 0 (do this once per camera model/resolution):
    Run `python bar_ocr.py --preview path/to/clip.mov` to dump the first
    frame as an image. Open it, note the pixel box (left, top, right,
    bottom) around the Date, Time, and Location Name text specifically —
    they're very likely NOT all one box; crop each separately for much
    better OCR accuracy than reading the whole bar as one string and
    parsing it apart. Fill in CROP_BOXES below with what you find.

STEP 0b (do this once, not per camera):
    Fill in ARBORETUM_LAT / ARBORETUM_LON below with the property's actual
    coordinates. Location Name itself is just recorded as whatever text the
    OCR reads off the bar — it's a label, not looked up anywhere.
"""

import argparse
import re
from datetime import datetime, date
from pathlib import Path

import cv2
import pytesseract
from astral import LocationInfo
from astral.sun import sun

# --------------------------------------------------------------------------
# EDIT THIS: pixel crop boxes (left, top, right, bottom) for each field,
# specific to your camera model + video resolution. Use --preview to find
# these values by trial and error against a real frame.
# --------------------------------------------------------------------------
CROP_BOXES = {
    "date": (289, 1012, 545, 1064),       # TODO: fill in L, T, R, B
    "time": (546, 1012, 727, 1064),       # TODO: fill in
    "location": (913, 1012, 1163, 1064),
    "temperature": (750, 1012, 850, 1064),  # TODO: fill in
}

# All cameras are within the same property, so sunrise/sunset/dawn/dusk
# won't meaningfully differ between sites (a shift of a few hundred meters to
# a couple km changes dawn/dusk by  well under a minute) — one fixed
# lat/long for the whole Arboretum is used for every clip, regardless of
# which camera/location name it came from. Location Name itself is just
# recorded as the raw text off the bar; it's a label, not a coordinate lookup.
ARBORETUM_LAT = 0.0   # TODO: fill in the Arboretum's coordinates
ARBORETUM_LON = 0.0   # TODO: fill in the Arboretum's coordinates


def extract_first_frame(video_path):
    cap = cv2.VideoCapture(str(video_path))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError(f"Could not read a frame from {video_path}")
    return frame


# The FULL info bar strip (Date + Time + Location all together), used for
# visual QA in the web app — lets someone glance at what the camera actually
# printed, side by side with what OCR extracted, without opening the video.
BAR_QA_CROP_BOX = (288, 1012, 1307, 1064)  # left, top, right, bottom


def save_bar_crop(video_path, output_path):
    """Extract the first frame, crop to the full info bar, and save as a PNG."""
    frame = extract_first_frame(video_path)
    left, top, right, bottom = BAR_QA_CROP_BOX
    crop = frame[top:bottom, left:right]
    cv2.imwrite(str(output_path), crop)


def preprocess_for_ocr(crop):
    """Grayscale + threshold + upscale — this kind of high-contrast digital
    overlay text OCRs far better after this than as raw color pixels."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return thresh


def ocr_field(frame, box, whitelist=None):
    left, top, right, bottom = box
    crop = frame[top:bottom, left:right]
    processed = preprocess_for_ocr(crop)
    # --psm 8 (treat as a single word/token) tested 15/15 correct against a
    # randomized-degradation stress test of your actual "21:07:16" crop,
    # vs. 8/15 for the previous --psm 7 (single line) — psm 7 was the real
    # source of the "91" misread, not font/threshold polarity.
    config = "--psm 8"
    if whitelist:
        config += f" -c tessedit_char_whitelist={whitelist}"
    return pytesseract.image_to_string(processed, config=config).strip()


DATE_RE = re.compile(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})")
TIME_RE = re.compile(r"(\d{1,2}):(\d{2}):?(\d{2})?\s*([AP]M)?", re.IGNORECASE)


def parse_date(raw):
    m = DATE_RE.search(raw)
    if not m:
        return None
    mm, dd, yy = m.groups()
    yy = int(yy)
    if yy < 100:
        yy += 2000
    return date(yy, int(mm), int(dd))


def parse_time(raw):
    m = TIME_RE.search(raw)
    if not m:
        return None
    hh, mm, ss, ampm = m.groups()
    hh, mm = int(hh), int(mm)
    ss = int(ss) if ss else 0
    if ampm:
        ampm = ampm.upper()
        if ampm == "PM" and hh != 12:
            hh += 12
        if ampm == "AM" and hh == 12:
            hh = 0
    # OCR garbage (e.g. a stray digit from an adjacent temperature reading
    # bleeding into the crop) can produce something that matches the regex
    # but isn't a real time — validate before trusting it, rather than
    # letting datetime() raise later with a confusing traceback.
    if not (0 <= hh <= 23 and 0 <= mm <= 59 and 0 <= ss <= 59):
        return None
    return hh, mm, ss


def diel_period(dt, lat, lon):
    """
    Day/Night/Dawn/Dusk from a datetime + coordinates, using civil twilight
    (astral's default) as the dawn/dusk boundary. dt must be timezone-naive
    LOCAL time matching the camera's own clock.
    """
    loc = LocationInfo(latitude=lat, longitude=lon)
    s = sun(loc.observer, date=dt.date())

    if s["dawn"] <= dt.replace(tzinfo=s["dawn"].tzinfo) < s["sunrise"]:
        return "Dawn"
    if s["sunrise"].replace(tzinfo=None) <= dt < s["sunset"].replace(tzinfo=None):
        return "Day"
    if s["sunset"] <= dt.replace(tzinfo=s["sunset"].tzinfo) < s["dusk"]:
        return "Dusk"
    return "Night"


def process_clip(video_path):
    if any(box == (0, 0, 0, 0) for box in CROP_BOXES.values()):
        print(
            "WARNING: CROP_BOXES still contains an unfilled (0, 0, 0, 0) placeholder. "
            "Run with --preview first, find real pixel coordinates for each field, "
            "and fill them in — OCR on an empty/zero-size crop will produce garbage.\n"
        )

    frame = extract_first_frame(video_path)

    raw_date = ocr_field(frame, CROP_BOXES["date"], whitelist="0123456789/-")
    raw_time = ocr_field(frame, CROP_BOXES["time"], whitelist="0123456789:APM ")
    location = ocr_field(frame, CROP_BOXES["location"])  # free text, no whitelist
    raw_temperature = ocr_field(frame, CROP_BOXES["temperature"], whitelist="0123456789°CF ")

    parsed_date = parse_date(raw_date)
    parsed_time = parse_time(raw_time)

    result = {
        "file": str(video_path),
        "raw_date_text": raw_date,
        "raw_time_text": raw_time,
        "date": parsed_date.isoformat() if parsed_date else None,
        "location": location,
        "temperature": raw_temperature,
        "diel_period": None,
    }

    if parsed_date and parsed_time:
        dt = datetime.combine(parsed_date, datetime.min.time()).replace(
            hour=parsed_time[0], minute=parsed_time[1], second=parsed_time[2]
        )
        result["time"] = dt.strftime("%H:%M:%S")
        result["diel_period"] = diel_period(dt, ARBORETUM_LAT, ARBORETUM_LON)

    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", help="Path to a trail cam clip")
    parser.add_argument("--preview", action="store_true",
                         help="Just dump the first frame as an image for you to inspect crop boxes")
    args = parser.parse_args()

    if args.preview:
        frame = extract_first_frame(Path(args.video))
        out_path = Path(args.video).with_suffix(".first_frame.png")
        cv2.imwrite(str(out_path), frame)
        print(f"Saved first frame to {out_path} — open it and note pixel boxes for CROP_BOXES.")
        return

    result = process_clip(Path(args.video))
    for k, v in result.items():
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()

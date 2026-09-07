#!/usr/bin/env python3
"""
Checks every dependency this app actually needs — both the Python packages
(imported directly, or shelled out to as a subprocess) and the Tesseract
system binary that pytesseract itself depends on.

Run with the SAME `python3` you use to launch app.py:
    python3 check_dependencies.py
"""

import importlib
import importlib.metadata
import shutil
import subprocess
import sys

# (import name, pip package name, why it's needed)
PYTHON_PACKAGES = [
    ("flask", "flask", "web framework — app.py"),
    ("cv2", "opencv-python", "video/image processing — app.py, bar_ocr.py"),
    ("pytesseract", "pytesseract", "OCR of the info bar — bar_ocr.py"),
    ("astral", "astral", "dawn/dusk/day/night calculation — bar_ocr.py"),
]

# These are invoked via subprocess (python -m megadetector.detection.run_md_and_speciesnet),
# not imported directly by app.py — but still need to be installed in this
# same interpreter for that subprocess call to work.
SUBPROCESS_PACKAGES = [
    ("speciesnet", "speciesnet", "the actual classification pipeline"),
    ("megadetector", "megadetector", "the actual detection pipeline"),
]


def check_import(import_name, pip_name):
    try:
        importlib.import_module(import_name)
        try:
            version = importlib.metadata.version(pip_name)
        except importlib.metadata.PackageNotFoundError:
            version = None
        return True, version
    except ImportError as e:
        return False, str(e)


def main():
    print(f"Checking with interpreter: {sys.executable}\n")

    missing = []

    print("-- Directly imported by app.py / bar_ocr.py --")
    for import_name, pip_name, why in PYTHON_PACKAGES:
        ok, info = check_import(import_name, pip_name)
        if ok:
            version_str = f" (v{info})" if info else ""
            print(f"  OK   {pip_name}{version_str} — {why}")
        else:
            print(f"  MISSING   {pip_name} — {why}")
            missing.append(pip_name)

    print("\n-- Used via subprocess (python -m megadetector.detection.run_md_and_speciesnet) --")
    for import_name, pip_name, why in SUBPROCESS_PACKAGES:
        ok, info = check_import(import_name, pip_name)
        if ok:
            version_str = f" (v{info})" if info else ""
            print(f"  OK   {pip_name}{version_str} — {why}")
        else:
            print(f"  MISSING   {pip_name} — {why}")
            missing.append(pip_name)

    print("\n-- Tesseract OCR engine (system binary, not a Python package) --")
    tesseract_path = shutil.which("tesseract")
    if tesseract_path:
        try:
            result = subprocess.run(
                ["tesseract", "--version"], capture_output=True, text=True, timeout=5
            )
            first_line = result.stdout.splitlines()[0] if result.stdout else "(version unknown)"
            print(f"  OK   found at {tesseract_path} — {first_line}")
        except Exception as e:
            print(f"  WARNING   found at {tesseract_path} but couldn't run it: {e}")
    else:
        print("  MISSING   tesseract binary not found on PATH")
        print("            macOS:   brew install tesseract")
        print("            Linux:   apt install tesseract-ocr")
        print("            Windows: https://github.com/UB-Mannheim/tesseract/wiki")

    print()
    if missing:
        print(f"Missing {len(missing)} package(s): {', '.join(missing)}")
        print(f"Install with:\n  {sys.executable} -m pip install {' '.join(missing)}")
    else:
        print("All Python packages import correctly in this interpreter.")

    if not tesseract_path:
        print("Tesseract binary is still missing — see instructions above (not a pip install).")


if __name__ == "__main__":
    main()

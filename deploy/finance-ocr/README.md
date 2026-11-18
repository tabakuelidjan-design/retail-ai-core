# Finance staging with the OCR engine

Scanned supplier invoices (PNG / JPEG without a text layer) are read by `tools/finance-ocr/ocr.py` (RapidOCR on ONNX Runtime). The Railpack build of Finance is Node only, so the engine is
NOT in it. This image adds it. It is used by **one** service only; every other service keeps its current build.

## What it contains
- `node:24-bookworm-slim` (Debian 12) running `node src/service-start.js` (same program as every Nordla service; `NORDLA_SERVICE=finance` selects Finance).
- Python 3.12 copied from `python:3.12-slim-bookworm` (same Debian release, same glibc) + a virtual environment `/opt/ocr` with the packages of `tools/finance-ocr/requirements.txt`
  (every package pinned, installed with `--no-deps`). RapidOCR 1.4.4 supports Python up to 3.12 only, and Debian 12 ships 3.11: that is why Python is copied from a second stage.
- `opencv-python-headless` replaces `opencv-python` (the slim image has no libGL). `pip check` therefore reports that one name; it is expected.
- **Not included: PyMuPDF** (reads PDF scans) - AGPL-3.0 or an Artifex commercial licence. A scanned PDF without text stays a manual entry. PDFs with text never need OCR.

## Staging switch (owner, Railway > finance-staging only)
1. Settings > Build > Dockerfile Path = `deploy/finance-ocr/Dockerfile` (or the variable `RAILWAY_DOCKERFILE_PATH`), branch `feature/finance-ocr-build` or the branch it is merged into.
2. Variable `FINANCE_OCR_COMMAND` = `/opt/ocr/bin/python tools/finance-ocr/ocr.py`
   (no shell, arguments split on spaces, no space in any path, working directory `/app`).
3. Redeploy. Rollback: remove the Dockerfile Path and the variable, redeploy (back to Railpack, OCR off: images become manual entries again).

## What was verified (local Docker, Linux, the image built from this Dockerfile)
- the image builds; size about 1.15 GB;
- `/opt/ocr/bin/python tools/finance-ocr/ocr.py` reads a fictitious invoice PNG (JSON `lines`), through the real Node extractor (`runOcrCommand`), as the unprivileged `node` user;
- about 11 s for the first image (models loaded), about 466 MB peak memory in a separate run;
- the Finance app module loads in the image.

## NOT verified
- the Railway build itself (no Railway access from the repository session): size limits, build time and memory of the staging service are unknown;
- hosted start with the real environment; PDF scans (PyMuPDF is not installed).

## Reading rules (src/finance/ocr-scan.js)
Every field carries a confidence; below 0.8 it is flagged `FIELD_UNCERTAIN:<field>`; an unread field is `FIELD_UNREAD:<field>`; `OCR_UNVERIFIED` is always present; totals that do
not add up give `TOTALS_DO_NOT_ADD_UP`. The supplier name (confidence 0.5) is always flagged. A person validates the draft; the original stays attached.

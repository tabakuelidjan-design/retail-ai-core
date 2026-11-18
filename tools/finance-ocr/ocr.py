"""OCR command for Nordla Finance scans (optional, local operator tool).

stdin : JSON {"contentType": "application/pdf" | "image/png" | "image/jpeg", "base64": "..."}
stdout: JSON {"lines": ["...", ...]}  (text lines, top to bottom, page after page)

Requires: rapidocr_onnxruntime, pymupdf (only for PDFs). Set FINANCE_OCR_COMMAND to
"python /path/to/tools/finance-ocr/ocr.py" to enable scan reading. Nothing is stored; the input is read from stdin.
"""
import base64
import json
import sys


def pages_as_png(content_type, raw):
    if content_type == "application/pdf":
        import pymupdf  # PyMuPDF
        doc = pymupdf.open(stream=raw, filetype="pdf")
        for page in doc:
            yield page.get_pixmap(dpi=200, colorspace=pymupdf.csGRAY).tobytes("png")
    else:
        yield raw


def main():
    req = json.loads(sys.stdin.read())
    raw = base64.b64decode(req["base64"])
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    lines = []
    for png in pages_as_png(req.get("contentType", "application/pdf"), raw):
        result, _ = engine(png)
        for box, text, _score in sorted(result or [], key=lambda r: (round(r[0][0][1] / 12), r[0][0][0])):
            lines.append(text)
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps({"lines": lines}, ensure_ascii=False))


if __name__ == "__main__":
    main()

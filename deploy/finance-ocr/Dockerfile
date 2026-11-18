# Nordla Finance runtime image WITH the OCR engine (Node 24 + Python 3.12 copied from python:3.12-slim). Used ONLY by the Finance service that must read scanned images.
# Kept under deploy/finance-ocr/ ON PURPOSE (same rule as deploy/sourcing/): a Dockerfile at the repository root would be picked up by Railway
# for EVERY service and replace the Railpack build. Select it per service: Railway > finance-staging > Settings > Build > Dockerfile Path
# = deploy/finance-ocr/Dockerfile (or the variable RAILWAY_DOCKERFILE_PATH). Removing that setting returns the service to the Railpack build.
# Same program as every Nordla service: `node src/service-start.js`, which runs Finance only when NORDLA_SERVICE=finance. No secret is baked in.
# OCR: FINANCE_OCR_COMMAND=/opt/ocr/bin/python tools/finance-ocr/ocr.py  (no shell, space-separated, paths without spaces; cwd = /app).
# Python packages: exact versions in tools/finance-ocr/requirements.txt (every transitive package pinned, installed with --no-deps).
# PyMuPDF (PDF scans, AGPL-3.0) is NOT installed: a scanned PDF without text stays a manual entry. PDFs WITH text never need OCR.

# Stage 1 - the OCR engine. rapidocr-onnxruntime 1.4.4 supports Python 3.6-3.12 ONLY (not 3.13) and node:24-bookworm-slim (Debian bookworm) ships 3.11, so the interpreter
# and the packages are built on python:3.12-slim-bookworm (SAME Debian release: the copied libpython needs the same glibc) and copied into the Node image below.
FROM python:3.12-slim-bookworm AS ocr
COPY tools/finance-ocr/requirements.txt /tmp/finance-ocr-requirements.txt
RUN python -m venv /opt/ocr \
 && /opt/ocr/bin/pip install --no-cache-dir --no-deps -r /tmp/finance-ocr-requirements.txt

# Stage 2 - the service.
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=ocr /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=ocr /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=ocr /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
COPY --from=ocr /opt/ocr /opt/ocr
# the venv points at /usr/local/bin/python3 (a symlink to python3.12 in the Python image)
RUN ln -s python3.12 /usr/local/bin/python3 && ln -s python3.12 /usr/local/bin/python && ldconfig

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY config ./config
COPY resources ./resources
COPY vendor ./vendor
COPY schemas ./schemas
COPY tools/finance-ocr/ocr.py ./tools/finance-ocr/ocr.py

COPY deploy/sourcing/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN mkdir -p /app/data/local && chown -R node:node /app/data && chmod 755 /app/docker-entrypoint.sh
# Same entrypoint as the Sourcing image (starts as root only to hand /app/data to `node`, then runs the service unprivileged).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/service-start.js"]

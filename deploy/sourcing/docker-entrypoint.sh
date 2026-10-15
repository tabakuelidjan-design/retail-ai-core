#!/bin/sh
# Start as root ONLY to hand the data directories of the mounted volume to the unprivileged user, then run the service as `node`.
# Why: Railway (and most hosts) mount a volume owned by root, so an image that starts directly as `node` cannot create its data
# directory (EACCES at start - reproduced). Nothing outside /app/data is touched; only entries not already owned by node are changed
# (nothing is deleted, no content is modified). If the container is already started as a non-root user, it just runs the command.
set -eu
if [ "$(id -u)" = "0" ]; then
  for d in /app/data "${SOURCING_DATA_DIR:-/app/data/sourcing}" "${SOURCING_BACKUP_DIR:-/app/data/sourcing-backups}"; do
    case "$d" in /app/data|/app/data/*) ;; *) echo "entrypoint: refusing to prepare $d (outside /app/data)" >&2; exit 1 ;; esac
    mkdir -p "$d"
    if [ "$d" = /app/data ]; then chown node:node /app/data; else find "$d" ! -user node -exec chown node:node {} +; fi
  done
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"
fi
exec "$@"

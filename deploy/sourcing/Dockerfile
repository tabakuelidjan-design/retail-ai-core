# Nordla runtime image (Node 24). Kept under deploy/sourcing/ ON PURPOSE: a Dockerfile at the repository root would be picked up by Railway
# automatically and replace the Railpack build of the existing Finance / Analytics services. Build: docker compose (context = repository root).
# One image for every service:
#   - default command: src/service-start.js, which refuses to start unless NORDLA_SERVICE names the service (core, finance, analytics, core-once);
#   - China Sourcing (hosted, see deploy/sourcing/): the compose file runs src/sourcing/server/index.js with SOURCING_HOSTED=1.
# No secret is baked in: every credential comes from the environment at run time. Data lives in a volume (/app/data/local), never in the image.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY config ./config
COPY resources ./resources
COPY vendor ./vendor
COPY schemas ./schemas
COPY tools/sourcing-backup.mjs ./tools/sourcing-backup.mjs

COPY deploy/sourcing/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN mkdir -p /app/data/local && chown -R node:node /app/data && chmod 755 /app/docker-entrypoint.sh
# No `USER node` here: a host volume mounted on /app/data is owned by root, and the service could not create its directories (EACCES,
# reproduced). The entrypoint gives /app/data to `node`, then runs the service as `node` with no capability (setpriv). A start command
# that bypasses the entrypoint must call it: /app/docker-entrypoint.sh node src/service-start.js
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/service-start.js"]

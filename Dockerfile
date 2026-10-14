# Nordla runtime image (Node 24, the repository's runtime since the Core P0). One image for every service:
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

RUN mkdir -p /app/data/local && chown -R node:node /app/data
USER node

CMD ["node", "src/service-start.js"]

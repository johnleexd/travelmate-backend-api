# syntax=docker/dockerfile:1
# Includes CA certificates and OpenSSL without a build-time Debian mirror download.
FROM node:22-bookworm AS base
WORKDIR /app

FROM base AS builder
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY data ./data
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM base AS runner
ENV NODE_ENV=production PORT=5000
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./
COPY --from=builder --chown=node:node /app/data ./data
COPY --chown=node:node scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER node
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "dist/server.js"]

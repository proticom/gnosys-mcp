# ─── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# ─── Stage 2: Runtime ────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Runtime needs git for history/rollback features (busybox provides wget for the healthcheck)
RUN apk add --no-cache git

# Copy built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# v5.12: the brain lives on a host-local volume (/data). NEVER back this with an
# SMB/NFS share — network filesystems corrupt SQLite under gnosys's many small
# writes. GNOSYS_LOCAL_ONLY keeps this server authoritative (no remote hop).
ENV NODE_ENV=production \
    GNOSYS_HOME=/data \
    GNOSYS_LOCAL_ONLY=1

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 7777

# Set GNOSYS_SERVE_TOKEN at runtime to require `Authorization: Bearer <token>`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7777/health || exit 1

# Network-hosted MCP. Binds 0.0.0.0 INSIDE the container (isolated); control
# external access with the host firewall / Tailscale + a bearer token.
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--transport", "http", "--host", "0.0.0.0", "--port", "7777"]

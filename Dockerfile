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

# Runtime needs git for history/rollback features
RUN apk add --no-cache git

# Copy built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create a default working directory for .gnosys vault
RUN mkdir -p /data

WORKDIR /data

# Default: start the MCP server (stdio mode)
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve"]

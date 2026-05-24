# syntax=docker/dockerfile:1.7
#
# Build context MUST be the repo root, not bridge/.  The bridge package
# lives in a pnpm workspace at the repo root; we need pnpm-workspace.yaml
# and the workspace pnpm-lock.yaml to install bridge's deps reproducibly.
#
# In the GHCR publish workflow:
#   docker buildx build --context . --file bridge/Dockerfile ...

# ---- Builder stage ----
FROM node:20-slim AS builder

WORKDIR /repo

# tini for PID-1 signal handling in the runtime stage.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (pinned to repo's packageManager field).
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy the whole workspace once. .dockerignore prunes node_modules,
# .git, build artifacts, tests, docs, and the stale bridge-local
# package-lock.json.
COPY . .

# Install bridge's deps + transitive workspace deps (frozen lockfile
# guarantees parity with CI). Cache the pnpm content-addressed store
# across builds.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store/v3 \
    pnpm install --frozen-lockfile --filter @postergully/lolly-mcp...

# Build the bridge bundle (dist/index.js).
RUN pnpm --filter @postergully/lolly-mcp build

# Produce a self-contained pruned tree at /out for the runtime stage.
RUN pnpm --filter @postergully/lolly-mcp deploy --prod /out

# ---- Runtime stage ----
FROM node:20-slim AS runtime

ARG VERSION=dev

# OCI image labels
LABEL org.opencontainers.image.title="lolly-mcp" \
      org.opencontainers.image.description="Lolly MCP bridge (OpenClaw ERP agent) — production deployment" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/Postergully/lolly-claude-plugin" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.freema/openclaw-mcp"

# tini binary from builder
COPY --from=builder /usr/bin/tini /usr/bin/tini

WORKDIR /app

# Pruned bridge bundle: dist/, node_modules/, package.json.
COPY --from=builder /out/dist/         dist/
COPY --from=builder /out/node_modules/ node_modules/
COPY --from=builder /out/package.json  package.json

ENV NODE_ENV=production
ENV OPENCLAW_URL=http://openclaw:18789

RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw r.status}).then(()=>process.exit(0)).catch(()=>process.exit(1))"

# ENTRYPOINT runs node via tini for PID-1 signal handling. CMD provides
# the default transport flags so `docker run ... <image> --transport http
# --port 3000` overrides Just Work in production.
ENTRYPOINT ["tini", "--", "node", "dist/index.js"]
CMD ["--transport", "sse"]

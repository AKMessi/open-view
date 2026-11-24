# Stage 1: Build Rust/WASM TA, Pine VM & Backtester + Web Frontend
FROM node:24-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --target wasm32-unknown-unknown

ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /app

COPY package.json tsconfig.base.json vitest.config.ts ./
COPY scripts ./scripts
COPY config ./config
COPY crates ./crates
COPY packages ./packages
COPY apps ./apps

RUN npm install --no-audit --no-fund \
  && npm run bootstrap:wasm \
  && npm run build:wasm \
  && npm --workspace @openview/web run build

# Stage 2: Minimal Hardened Production Runtime (Node 24 + SQLite WAL + Static Web UI)
FROM node:24-bookworm-slim AS runtime

RUN groupadd -r openview && useradd -r -g openview -m openview
WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=builder /app/config ./config
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/server ./apps/server
COPY --from=builder /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/.data && chown -R openview:openview /app/.data

USER openview
ENV NODE_ENV=production
ENV OPENVIEW_HOST=0.0.0.0
ENV OPENVIEW_PORT=4001
ENV OPENVIEW_BRIDGE_MODE=self_hosted

EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]

# OpenView — Free, Open-Source, Clean-Room TradingView Alternative (Web)

**OpenView** is a 100% clean-room, MIT-licensed, high-performance web charting, scripting, orderflow, backtesting, paper trading, alerting, and screening workbench engineered from scratch for **4 global financial markets**:

1. **Crypto** (`Spot`, `USD-M Perpetuals`, `L2 Depth`) — Zero-key live streams via Binance `.vision` + automatic failover (`Hyperliquid` / `Coinbase`)
2. **Forex, Precious Metals & Energy** (`EUR/USD`, `XAU/USD`, `XAG/USD`, `USD/INR`) — DST-aware NY-Close (`17:00 America/New_York`) candles via Tiingo FX, OANDA v20, Dukascopy/Stooq
3. **US Equities & ETFs** (`NYSE`, `NASDAQ`) — Alpaca v2 (`IEX` / `SIP`), Massive, Finnhub, Stooq EOD
4. **Indian NSE, BSE & MCX** (`NIFTY`, `BANKNIFTY`, Equities, Continuous Front-Month Futures `1!`, F&O, MCX Gold/Crude) — IST `09:15–15:30` session-anchored candles, dynamic 2025–2026 NSE tick sizes, Upstox v3, Fyers v3, DhanHQ v2, Kite, Yahoo delayed fallback

---

## Core Architecture

```text
+-----------------------------------------------------------------------------+
|  @openview/web  (React 19 + Tailwind CSS v4 + Vite 7 · < 160 KB gzipped)    |
|  - Strict 2-Canvas-Per-Tile Chart Core (<= 16 canvases on 4x2 grid)         |
|  - 53 Vector Drawing Tools + Magnet + Undo/Redo + Multi-Chart SyncBus       |
|  - Lazy Drawers: Pine v5/v6 & TS Editor · Backtester · Option Chain · Scan  |
|  - Automatic Zero-Backend Static Mode Fallback when Local Bridge is offline |
+------------------------------------+----------------------------------------+
                                     | Authenticated HTTP + Single-Use Ticket /ws
                                     | (Host + Origin anti-CSWSH gate)
+------------------------------------v----------------------------------------+
|  @openview/server  (Fastify 5 + ws + Node 24 Local/Self-Hosted Bridge)      |
|  - AES-256-GCM Credential Vault (Windows DPAPI native / RAM scrypt)         |
|  - Off-Main-Thread Worker (node:worker_threads + node:sqlite WAL)           |
|  - 4-Market Router + Token-Bucket Limiter + Corporate-Action Cache Guard    |
|  - 24/7 Alerts Engine (Price/Trendline + SSRF-Guarded HMAC Webhooks)        |
|  - Tiered Multi-Market WASM Screener + SEBI Apr 2026 Execution Airlock      |
+------------------------------------+----------------------------------------+
                                     | Shared Rust -> WebAssembly Binary
+------------------------------------v----------------------------------------+
|  crates/openview-wasm (Rust -> wasm32-unknown-unknown)                      |
|  - BarArena (48-byte incremental live delta updates)                        |
|  - 18+ TradingView-Parity TA Indicators (Wilder RMA/RSI/ATR, ddof=0 BB...)  |
|  - Clean-Room Pine v5/v6 Compiler, Repainting Linter & var/varip Arena VM   |
|  - Deterministic Gap-Open-Realistic Strategy Backtester                     |
+-----------------------------------------------------------------------------+
```

## Quick Start (Local Development)

**Prerequisites:** Node.js `>= 24.0.0` and Rust (`rustup target add wasm32-unknown-unknown`).

```bash
# 1. Install workspace dependencies
npm install

# 2. Download verified wasm-bindgen CLI (pinned SHA-256) & compile Rust/WASM
npm run bootstrap:wasm
npm run build:wasm

# 3. Launch secured Local Bridge (127.0.0.1:4001) + Vite Web UI (127.0.0.1:5173)
npm run dev
```

Open **http://127.0.0.1:5173** in your browser. Click **Providers** in the top-right toolbar to store optional BYOK API keys locally inside your encrypted Credential Vault (`Windows DPAPI` on Windows, `AES-256-GCM` passphrase sealing on Linux/Docker).

## Self-Hosted Docker Deployment

```bash
OPENVIEW_VAULT_PASSPHRASE="your-strong-secret-passphrase" docker compose up -d --build
```

Then open **http://localhost:4001** (persists SQLite WAL cache, workspaces, alerts, and encrypted vault inside the `openview_data` volume).

## Verification Suite

```bash
npm run test:rust    # Rust unit tests (TA parity, Backtester gap-open realism, Pine VM var/varip rollback)
npm run typecheck    # Strict TypeScript check across all 10 workspaces
npm run test         # Vitest suite (P0 Security, Chart Engine, Datafeeds, Drawings, Replay, Broker, Chart Types, Alerts, Screener)
npm run build        # Full Rust/WASM + Vite production build
```

## Built-In Safety & Compliance Guarantees

- **Zero Browser Key Exposure:** Provider API keys live solely in the encrypted local vault on the Bridge and are never returned to the browser.
- **Anti-CSWSH & Anti-SSRF:** Every `/ws` upgrade enforces strict `Host` + `Origin` + single-use cryptographic ticket validation. Outbound alert webhooks resolve DNS first and block loopback, RFC1918 private networks, link-local cloud metadata (`169.254.169.254`), and IPv4-mapped IPv6 addresses.
- **SEBI April 2026 Indian Retail Algo Airlock:** Execution defaults strictly to `PAPER`. Arming `LIVE` requires an explicit confirmation phrase + risk caps; Indian NSE/MCX live orders additionally enforce pre-flight Static IPv4 verification, daily IST 2FA health checks, automatic Market Price Protection (MPP) limit conversion, and an `8 orders/sec` hard client rate limiter.
- **Clean-Room & Legal Compliance:** OpenView is 100% clean-room MIT code. It does not bundle proprietary charting libraries, does not scrape unauthorized exchange endpoints, and never redistributes regulated exchange feeds from a central server.

## License

MIT — see [LICENSE](./LICENSE).

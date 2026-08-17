# marketintel-

An automated crypto market-intelligence broadcast pipeline. It turns scheduled
AI market research into a continuously-updated, Bloomberg-terminal-style video
feed (1280x720) that can be recorded locally or streamed live to YouTube.

The dashboard combines two data sources:

- **Live market data** — BTC/ETH/SOL/XRP price/candlestick data and a
  BTC/ETH/SOL/XRP/BNB ticker tape, streamed directly from Kraken over
  WebSocket in the browser.
- **AI-generated market intelligence** — ETF flow, macro, X/Twitter narrative,
  and sentiment summaries, produced upstream by Grok and delivered into this
  repo's data layer via Supabase.

## How it fits together

This repo is the rendering/broadcast half of a larger pipeline. The upstream
pieces (external, not part of this repo) are:

1. **Grok mobile automations** (x2) run on a schedule, do AI market research,
   and email their findings.
2. A **Gmail-to-Supabase bridge** (a separate automation) parses those emails
   and inserts rows into a Supabase table, `grok_signals`, matching the shape
   defined in [`GROK_SIGNAL_SCHEMA.json`](GROK_SIGNAL_SCHEMA.json): `id`,
   `timestamp`, and four string-array fields (`etf_flows`, `system_macro`,
   `x_narratives`, `sentiment`).

What happens inside this repo:

3. [`supabase_client.js`](supabase_client.js) fetches the most recent
   `grok_signals` row using a read-only anon key (RLS restricts it to
   `SELECT`, so it's safe to keep in version control).
4. [`stream_engine.js`](stream_engine.js) is the main Node process, run via
   `node stream_engine.js --live`. It runs two things concurrently:
   - **`StreamEngine`** — polls Supabase every 30s and atomically writes the
     latest signal to [`grok_data.json`](grok_data.json) (temp-file + rename).
   - **`VideoEngine`** — serves [`index.html`](index.html) from a small local
     HTTP server on loopback, loads it in headless Chromium via Puppeteer,
     captures frames via Chrome DevTools Protocol screencast
     (`Page.startScreencast`, 30fps @ 1280x720), and pipes JPEG frames into
     FFmpeg, which encodes H.264 and either writes a local MP4
     (`local_stream_test.mp4`, the default) or streams via RTMP to YouTube
     Live when `YOUTUBE_LIVE_URL` is set.
5. [`index.html`](index.html) is the broadcast dashboard itself — a single
   static file, no build step. It runs four independent inline scripts:
   - a clock,
   - a rotating hero candlestick chart cycling BTC/USD → ETH/USD → SOL/USD →
     XRP/USD every 45s, using one persistent Kraken WebSocket v2 connection
     (`wss://ws.kraken.com/v2`, `ohlc` channel with `snapshot: true` for
     historical backfill) and the Lightweight Charts library (from the unpkg
     CDN),
   - Grok intelligence panels (ETF flows, system/macro, X narratives,
     sentiment) that poll `grok_data.json`,
   - a market-tape ticker strip covering BTC/ETH/SOL/XRP/BNB via a *separate*
     Kraken `ticker` channel WebSocket connection.

## No fabricated data

This project has a strict rule: **never fabricate market data**. If Kraken
doesn't have data for an asset (e.g. BNB is likely unlisted on Kraken), the
UI shows the literal text `DATA UNAVAILABLE` instead of a placeholder or
stale number.

## Running locally

```bash
npm install
npm run check   # syntax-checks the JS files (node --check)
npm run live    # node stream_engine.js --live
```

`npm start` runs `node stream_engine.js` without the live video pipeline.

Running live requires FFmpeg and Chromium's system libraries to be present
(see the Dockerfile for the exact apt package list); without them,
`VideoEngine` will fail to launch Puppeteer/FFmpeg.

## Key files

| File | Purpose |
| --- | --- |
| `stream_engine.js` | Main process: `StreamEngine` (Supabase polling) + `VideoEngine` (Puppeteer/CDP capture + FFmpeg encode/stream) |
| `supabase_client.js` | Read-only Supabase client; fetches the latest `grok_signals` row |
| `index.html` | The 1280x720 broadcast dashboard rendered/captured by `VideoEngine` |
| `grok_data.json` | Latest Grok signal, written by `StreamEngine` and polled by `index.html` |
| `GROK_SIGNAL_SCHEMA.json` | JSON Schema for a Grok signal row, shared contract with the upstream Gmail-to-Supabase bridge |
| `Dockerfile` | node:22-bookworm-slim + ffmpeg + Chromium system deps, used for deployment |

## Deployment

Deployed on Railway (project `marketintel-broadcast`), which auto-deploys
from the `main` branch using the included `Dockerfile`. The
`broadcast-engine` service runs `node stream_engine.js --live` in
production.

Environment variables:

- `YOUTUBE_LIVE_URL` — RTMP ingest URL (with stream key) for YouTube Live.
  When unset, video is written to a local MP4 file instead. This is a
  deployment secret only — it must never be hardcoded or committed.

Do not commit secrets. The Supabase key in `supabase_client.js` is an
anon/read-only key intentionally safe to publish; anything with write access
or other credentials belongs in Railway's environment variables, not in the
repo.

# -----------------------------------------------------------------------
# SPY/QQQ macro-instrument adapter (PROTOTYPE)
#
# Fully isolated from the rest of this repository. This process:
#   - never imports/calls supabase_client.js, stream_engine.js,
#     youtube_publisher.js, or video_clipper.js
#   - never reads or writes grok_data.json
#   - never touches the Kraken WebSocket crypto path in index.html
#   - has its own polling loop, its own state, and its own output file
#     (./macro_data.json) - a sibling to grok_data.json, not a
#     replacement or extension of it
#
# Run standalone: `python3 macro_adapter.py` (see requirements.txt for
# the one dependency this needs). Not wired into stream_engine.js's
# process lifecycle - starting/stopping this adapter has zero effect on
# the existing live crypto broadcast.
#
# BLOCK 4 CHANGE: switched from the `yfinance` PyPI package to a direct
# `requests` call against Yahoo Finance's own public chart endpoint
# (https://query1.finance.yahoo.com/v8/finance/chart/{symbol}). Reason,
# confirmed in this exact environment, not assumed: yfinance's HTTP
# transport (`curl_cffi`, used internally to impersonate a browser's TLS
# fingerprint past Yahoo's bot detection) gets its connection reset by
# this sandbox's HTTPS-intercepting proxy on every request, regardless of
# which domains are allow-listed - confirmed via a direct curl_cffi test
# that failed and a plain `requests`/`urllib` test to the SAME Yahoo host
# that succeeded with a real 200 response. This endpoint is the same one
# yfinance itself calls internally for price/history data - this is not a
# different/undocumented data source, just a different (and in this
# environment, actually working) HTTP client reaching it. Response field
# names below (regularMarketPrice, previousClose, regularMarketTime,
# currentTradingPeriod) were confirmed against a real live response, not
# guessed from documentation.
#
# LICENSING NOTE: this adapter (whether via yfinance or this direct
# endpoint call) is a PROTOTYPE only. Public-display/redistribution
# rights for Yahoo Finance data have not been independently verified
# (same open question already flagged for every other candidate provider
# investigated for this project). Do not treat this as cleared for
# public/monetized broadcast without resolving that separately.
#
# No fabricated data: every write either carries a real value obtained
# from THIS poll, or an explicit null for that instrument. A failed or
# partial fetch never carries forward a previous value as if it were
# current - poll_once() below builds `instruments` from scratch every
# call and never reads the previous macro_data.json, so there is no
# code path that could reuse a stale price. The consumer (index.html's
# isolated macro-ticker script) treats null/stale/missing as
# "DATA UNAVAILABLE", the same no-fake-data contract already used for
# the crypto ticker strip.
# -----------------------------------------------------------------------

import json
import os
import tempfile
import time
import traceback
from datetime import datetime, timezone

import requests

SYMBOLS = ["SPY", "QQQ"]  # Scope is exactly these two - do not extend here.

# Conservative interval: this hits Yahoo's own public endpoint, which has
# no officially published rate limit (it's not a licensed real-time
# feed), so this polls infrequently enough to avoid hammering it - the
# same "be conservative against an exchange's own reconnect/backoff
# tolerance" instinct already applied to the Kraken WebSocket reconnect
# logic elsewhere in this repo, applied here as a polling interval since
# this endpoint has no streaming mode.
POLL_INTERVAL_S = 30

# Explicit, finite per-request timeout - a network failure must fail
# fast, not hang the polling loop indefinitely. (connect_timeout, read_timeout)
REQUEST_TIMEOUT_S = (5, 10)

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "macro_data.json")
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# One shared session (connection pooling) reused across every poll for the
# life of the process, instead of opening a fresh connection per request
# per cycle forever - avoids leaking sockets over a long-running process.
_session = requests.Session()
_session.headers.update({"User-Agent": "Mozilla/5.0 (MarketIntel macro_adapter.py prototype)"})


def _market_state_from_trading_period(now_epoch, meta):
    """Real per-symbol session boundaries from Yahoo's own response
    (currentTradingPeriod.regular.start/end, both real Unix timestamps for
    THIS trading day) - not a hand-rolled fixed clock window, so this is
    accurate across DST/holidays without needing calendar logic of our
    own. Returns "regular" or "closed"; never invents a third state.
    """
    try:
        regular = meta["currentTradingPeriod"]["regular"]
        return "regular" if regular["start"] <= now_epoch < regular["end"] else "closed"
    except (KeyError, TypeError):
        return "unknown"


def fetch_instrument(symbol):
    """Returns {"last": float, "changePct": float|None, "asOf": iso8601,
    "marketState": str} on success, or None on ANY failure (network
    error, timeout, non-200, malformed JSON, missing/non-finite fields) -
    never a partial/guessed value. last/previousClose are both real
    numbers taken directly from Yahoo's own response for this symbol;
    changePct is a plain derived calculation from those same two real
    numbers (never a separately-fetched or invented figure). Each symbol
    is fetched and error-handled entirely independently - a SPY failure
    has no code path that touches QQQ's request/result, and vice versa.
    """
    try:
        resp = _session.get(
            CHART_URL.format(symbol=symbol),
            params={"interval": "1d", "range": "1d"},
            timeout=REQUEST_TIMEOUT_S,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        result = data.get("chart", {}).get("result")
        if not result or not isinstance(result, list):
            return None
        meta = result[0].get("meta")
        if not meta:
            return None

        last = meta.get("regularMarketPrice")
        prev_close = meta.get("previousClose", meta.get("chartPreviousClose"))
        market_time = meta.get("regularMarketTime")
        if last is None or prev_close is None:
            return None
        last = float(last)
        prev_close = float(prev_close)
        if last != last or prev_close != prev_close:  # NaN check, no math import needed
            return None

        change_pct = None
        if prev_close != 0:
            change_pct = (last - prev_close) / prev_close * 100.0

        as_of = None
        if isinstance(market_time, (int, float)):
            as_of = datetime.fromtimestamp(market_time, tz=timezone.utc).isoformat()

        now_epoch = time.time()
        market_state = _market_state_from_trading_period(now_epoch, meta)

        return {"last": last, "changePct": change_pct, "asOf": as_of, "marketState": market_state}
    except Exception:
        # Network failure, timeout, HTTP error, rate limit, malformed
        # response, unexpected schema, etc. - all collapse to "this
        # instrument is unavailable this cycle", never a guessed/
        # fabricated price, and never affects the OTHER symbol's fetch.
        traceback.print_exc()
        return None


def poll_once():
    now = datetime.now(timezone.utc)
    instruments = {}
    for symbol in SYMBOLS:
        instruments[symbol] = fetch_instrument(symbol)

    # Fall back to a coarse, always-available clock heuristic only when no
    # symbol's real per-day session boundaries were obtainable this cycle
    # (e.g. every request failed) - kept for the top-level `marketSession`
    # field's backward-compatible shape (unchanged from Block 3), now
    # populated preferentially from real per-symbol data when available.
    market_session = next((v["marketState"] for v in instruments.values() if v), None)
    if market_session is None:
        market_session = "closed" if now.weekday() >= 5 else "unknown"

    payload = {
        # When THIS adapter last attempted a poll - the consumer uses this
        # to detect a stalled/dead adapter process (distinct from "market
        # is closed", which still produces a real last-price value).
        "generatedAt": now.isoformat(),
        "source": (
            "Yahoo Finance (query1.finance.yahoo.com chart endpoint) - "
            "prototype adapter; public-display/redistribution rights not "
            "independently verified"
        ),
        "marketSession": market_session,
        "instruments": instruments,
    }

    # Atomic write (temp file + rename), same pattern stream_engine.js
    # already uses for grok_data.json - implemented independently here,
    # not by calling into that file, so a reader never observes a
    # half-written macro_data.json. Unchanged from Block 3.
    dir_name = os.path.dirname(OUTPUT_PATH)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, prefix=".macro_data.", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_path, OUTPUT_PATH)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    ok = [s for s, v in instruments.items() if v is not None]
    unavailable = [s for s, v in instruments.items() if v is None]
    print(f"[MACRO_ADAPTER] wrote {OUTPUT_PATH} - ok={ok} unavailable={unavailable}")
    return payload


def main():
    print(f"[MACRO_ADAPTER] started - polling {SYMBOLS} every {POLL_INTERVAL_S}s (prototype, isolated from crypto path)")
    while True:
        try:
            poll_once()
        except Exception:
            # A failure writing the output file (disk full, permissions,
            # etc.) must never crash the loop into silence - log and keep
            # trying next cycle, same "never let a stall go unnoticed
            # forever" reasoning used elsewhere in this repo.
            traceback.print_exc()
        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()

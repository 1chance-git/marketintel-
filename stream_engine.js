import { writeFile, rename, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";
import { fetchLatestGrokSignal } from "./supabase_client.js";

const POLL_INTERVAL_MS = 30_000;
const OUTPUT_PATH = path.resolve("./grok_data.json");

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSignal(signal) {
  return {
    id: signal.id,
    timestamp: signal.timestamp,
    etf_flows: normalizeArray(signal.etf_flows),
    system_macro: normalizeArray(signal.system_macro),
    x_narratives: normalizeArray(signal.x_narratives),
    sentiment: normalizeArray(signal.sentiment),
  };
}

async function writeSignalAtomically(signal) {
  const tmpPath = `${OUTPUT_PATH}.${process.pid}.${Date.now()}.tmp`;
  const contents = JSON.stringify(signal, null, 2);

  try {
    await writeFile(tmpPath, contents, "utf8");
    await rename(tmpPath, OUTPUT_PATH);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export class StreamEngine {
  constructor({ pollIntervalMs = POLL_INTERVAL_MS } = {}) {
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
    this.running = false;
    this.lastSignalId = null;
    this.lastSignalTimestamp = null;
  }

  hasChanged(signal) {
    return signal.id !== this.lastSignalId || signal.timestamp !== this.lastSignalTimestamp;
  }

  async pollOnce() {
    let signal;
    try {
      signal = await fetchLatestGrokSignal();
    } catch (err) {
      console.error(`[SUPABASE] Poll failed: ${err.message}`);
      return;
    }

    if (!signal) {
      console.log("[SUPABASE] No new signal");
      return;
    }

    if (!this.hasChanged(signal)) {
      console.log("[SUPABASE] No new signal");
      return;
    }

    console.log(`[SUPABASE] New signal detected (id=${signal.id}, timestamp=${signal.timestamp})`);

    const normalized = normalizeSignal(signal);

    try {
      await writeSignalAtomically(normalized);
      this.lastSignalId = signal.id;
      this.lastSignalTimestamp = signal.timestamp;
      console.log("[SUPABASE] Poll successful");
    } catch (err) {
      console.error(`[SUPABASE] Poll failed: failed to write grok_data.json (${err.message})`);
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    console.log("[STREAM_ENGINE] Starting");

    this.pollOnce();

    this.timer = setInterval(() => {
      this.pollOnce();
    }, this.pollIntervalMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop() {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[STREAM_ENGINE] Shutdown");
  }
}

// ---------------------------------------------------------------------------
// Video capture / encode engine (Block 7)
//
// index.html --(Puppeteer, 1280x720, ~30fps PNG screenshots)--> FFmpeg stdin
//   --(libx264, yuv420p, 30fps)--> local_stream_test.mp4
//
// This is deliberately independent of StreamEngine (the Supabase poller)
// above. It is not started by default; run with:
//   node stream_engine.js --capture-test [durationSeconds]
// ---------------------------------------------------------------------------

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const CAPTURE_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / CAPTURE_FPS;

// ---------------------------------------------------------------------------
// YouTube RTMP output adapter (Block 8)
//
// This is the ONLY thing that switches the video pipeline's output
// destination. It is read from the YOUTUBE_LIVE_URL environment variable —
// never hardcoded here, never committed to this repository. The real value
// (rtmp://a.rtmp.youtube.com/live2/<STREAM_KEY>) should only ever be set as
// a deployment secret (e.g. Railway's service Variables tab) after YouTube
// Live activation is complete, once the real stream key is in hand.
//
//   YOUTUBE_LIVE_URL unset/empty      -> MODE 1: encode to local_stream_test.mp4
//   YOUTUBE_LIVE_URL === "rtmp://..." -> MODE 2: stream out via FFmpeg FLV/RTMP
//
// Railway does not support interpolating a ${{reference}} inside a larger
// literal string - a variable's value must be either a pure reference or
// pure literal text, never a mix. So if the full rtmp:// URL isn't set
// directly as YOUTUBE_LIVE_URL, fall back to building it from separate
// Stream_URL + Stream_Key variables (also never hardcoded/committed here).
// ---------------------------------------------------------------------------
// Structural-only shape report for a raw candidate value - reports length,
// whether it starts with "rtmp://" (safe to check/log: that's the fixed,
// non-secret protocol prefix, never the key), whether it contains any
// "://" scheme at all (catches e.g. an http:// URL pasted by mistake),
// and whether it has leading/trailing/embedded whitespace (a common
// copy-paste mistake) - never the value itself.
function describeShape(value) {
  if (!value) return "unset";
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
  return (
    `length=${value.length} startsWithRtmp=${value.startsWith("rtmp://")} ` +
    `hasAnyScheme=${hasScheme} ` +
    `hasLeadingOrTrailingWhitespace=${value !== value.trim()} ` +
    `hasEmbeddedWhitespace=${/\s/.test(value.trim())}`
  );
}

function resolveYoutubeLiveUrlSource() {
  const direct = process.env.YOUTUBE_LIVE_URL || null;
  const streamUrl = process.env.Stream_URL || null;
  const streamKey = process.env.Stream_Key || null;

  console.log(`[VIDEO_ENGINE] YOUTUBE_LIVE_URL shape: ${describeShape(direct)}`);
  console.log(`[VIDEO_ENGINE] Stream_URL shape: ${describeShape(streamUrl)}`);
  console.log(`[VIDEO_ENGINE] Stream_Key shape: ${describeShape(streamKey)}`);

  if (direct) {
    if (direct.startsWith("rtmp://")) {
      return { url: direct, source: "YOUTUBE_LIVE_URL" };
    }
    return { url: null, source: "none (YOUTUBE_LIVE_URL set but not rtmp://)" };
  }

  if (streamUrl && streamKey) {
    if (streamUrl.startsWith("rtmp://")) {
      return { url: `${streamUrl.replace(/\/+$/, "")}/${streamKey}`, source: "Stream_URL+Stream_Key" };
    }
    return { url: null, source: "none (Stream_URL set but not rtmp://)" };
  }
  if (streamUrl || streamKey) {
    return { url: null, source: `none (only ${streamUrl ? "Stream_URL" : "Stream_Key"} set)` };
  }

  return { url: null, source: "none (nothing set)" };
}

const { url: YOUTUBE_LIVE_URL, source: YOUTUBE_LIVE_URL_SOURCE } = resolveYoutubeLiveUrlSource();

console.log(`[VIDEO_ENGINE] YOUTUBE_LIVE_URL resolved: source=${YOUTUBE_LIVE_URL_SOURCE} configured=${!!YOUTUBE_LIVE_URL}`);

function startLocalServer(rootDir) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const relPath = urlPath === "/" ? "/index.html" : urlPath;
      const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(rootDir, safePath);

      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end();
        return;
      }

      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      res.end(body);
    } catch (err) {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  const host = "127.0.0.1";
  const port = 0;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      console.log(`[VIDEO_ENGINE] Local HTTP server listening on http://${host}:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

// Matches FFmpeg stderr lines worth surfacing for RTMP connection
// diagnostics (handshake/connect/auth/error/close events), while
// excluding the high-frequency "frame=... fps=... bitrate=..." progress
// line that FFmpeg prints continuously during normal operation.
const RTMP_STATUS_LINE_PATTERN = /connect|handshak|auth|refused|reset|timed? ?out|forbidden|unauthoriz|reject|fail|error|closing|opening/i;

function redactStreamSecrets(line) {
  let sanitized = line;
  if (YOUTUBE_LIVE_URL) {
    sanitized = sanitized.split(YOUTUBE_LIVE_URL).join("[REDACTED]");
  }
  // Defense in depth: strip any rtmp:// URL even if it doesn't match the
  // configured destination exactly (e.g. a differently-cased echo).
  return sanitized.replace(/rtmp:\/\/\S+/gi, "rtmp://[REDACTED]");
}

function resolveOutputTarget(localOutputPath) {
  if (YOUTUBE_LIVE_URL) {
    return { destination: YOUTUBE_LIVE_URL, mode: "rtmp" };
  }
  return { destination: localOutputPath, mode: "local" };
}

function spawnFfmpeg({ destination, mode }) {
  const encodingArgs = [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-r", String(CAPTURE_FPS),
    "-s", `${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`,
    // Without an explicit bitrate, libx264 falls back to CRF-based rate
    // control, which adapts *down* to whatever the content needs - this
    // dashboard is mostly static black background with sparse text/chart
    // updates, so CRF alone produced ~100Kbps, far under YouTube's 2500Kbps
    // recommendation for 720p30. -b:v/-maxrate alone only caps the ceiling
    // and still lets the encoder drop far below it on simple content
    // (verified: a 5s all-black test clip measured ~10Kbps actual output
    // even with -b:v/-maxrate/-bufsize set). nal-hrd=cbr forces libx264 to
    // insert filler data so the stream actually pads up to the target
    // rate regardless of scene complexity (same test measured ~2400Kbps
    // actual output with this flag added) - matching YouTube's
    // recommendation requires this, not just a nominal -b:v value.
    // force-cfr=1 keeps frame timing constant, which CBR padding requires.
    // -g/-keyint_min set a keyframe every 2s, which YouTube Live also
    // expects for stable ingest.
    "-b:v", "2500k",
    "-maxrate", "2500k",
    "-minrate", "2500k",
    "-bufsize", "5000k",
    "-x264-params", "nal-hrd=cbr:force-cfr=1",
    "-g", String(CAPTURE_FPS * 2),
    "-keyint_min", String(CAPTURE_FPS),
  ];

  const args = ["-y"];

  if (mode === "rtmp") {
    // Nothing else in this pipeline throttles output to real time - only
    // how fast frames get written to stdin does. FFmpeg's RTMP/flv muxer
    // pushes encoded data to YouTube as fast as it's produced, with no
    // built-in real-time pacing of its own. Verified locally: piping a
    // 5s burst of frames with no -readrate produced 5s of declared video
    // in ~1.06s wall-clock (YouTube's "sending faster than realtime"
    // error, matching the observed report almost exactly); the same
    // burst with -readrate 1 (FFmpeg 5.0+, confirmed present: this image
    // runs 5.1.9) took ~4.62s, correctly paced to ~1x. -readrate throttles
    // FFmpeg's own reads/encoding to wall-clock speed regardless of how
    // bursty the upstream frame writes are (Node timer jitter, stdin
    // backpressure catch-up, etc.), so it's a strictly more robust fix
    // than trying to perfectly pace the writer side.
    args.push("-readrate", "1");
  }

  // FFmpeg logs "Thread message queue blocking; consider raising the
  // thread_queue_size option (current value: 8)" on every run - the
  // demuxer's default 8-frame internal buffer is too small for CDP
  // screencast frames arriving in bursts (observed ~56-59fps arrival vs
  // the fixed 30fps write rate), causing brief stalls that undershoot the
  // real 30fps encode rate. That undershoot used to get masked because
  // FFmpeg would just race ahead to catch up once the pipe unblocked -
  // which is exactly the behavior -readrate above now prevents (by
  // design, to stop overshooting real-time and triggering YouTube's
  // "sending faster than realtime" error). With overshoot no longer
  // absorbing any shortfall, an undersized queue could otherwise let a
  // real encode-rate deficit compound into a growing live-stream delay
  // over time instead of staying bounded. Raising the queue removes the
  // stalls at the source.
  args.push(
    "-thread_queue_size", "512",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-framerate", String(CAPTURE_FPS),
    "-i", "-",
  );

  if (mode === "rtmp") {
    // YouTube Live's ingest expects an audio track alongside video - a
    // video-only RTMP stream can connect and encode without any FFmpeg
    // error, but YouTube never surfaces it as a receiving/healthy stream.
    // There's no real audio source in this pipeline (it's a rendered
    // dashboard, not a capture with sound), so generate silence rather
    // than fabricate/omit audio.
    // -readrate on the audio input too, so both streams stay paced
    // together rather than the (infinite) silent-audio generator running
    // ahead of the real-time-throttled video input.
    args.push("-readrate", "1", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    args.push(
      "-map", "0:v:0",
      "-map", "1:a:0",
      ...encodingArgs,
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
    );
    // RTMP requires an FLV container; the destination is an RTMP URL, not a file path.
    args.push("-f", "flv", destination);
  } else {
    args.push(...encodingArgs, destination);
  }

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  return ffmpeg;
}

export class VideoEngine {
  constructor({
    durationMs = 60_000, // null/undefined-safe: pass null explicitly for continuous (no fixed end) capture
    outputPath = path.resolve("./local_stream_test.mp4"),
    rootDir = path.resolve("."),
  } = {}) {
    this.durationMs = durationMs ?? null;
    this.outputPath = outputPath;
    this.rootDir = rootDir;
    this.outputTarget = resolveOutputTarget(this.outputPath);

    this.server = null;
    this.browser = null;
    this.page = null;
    this.ffmpeg = null;

    this.capturing = false;
    this.shuttingDown = false;
    this.frameCount = 0;
    this.startTime = null;
    this.captureTimer = null;
    this.latestFrameBuffer = null;
    this.freshFrameCount = 0;
    this.statsTimer = null;
  }

  async run() {
    console.log("[VIDEO_ENGINE] Starting");

    try {
      const { server, port } = await startLocalServer(this.rootDir);
      this.server = server;

      this.browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (err) {
      console.error(`[VIDEO_ENGINE] Startup failed: ${err.message}`);
      await this.shutdown(1);
      return;
    }

    this.browser.on("disconnected", () => {
      if (!this.shuttingDown) {
        console.error("[VIDEO_ENGINE] Browser disconnected unexpectedly");
        this.shutdown(1);
      }
    });

    try {
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });

      this.page.on("pageerror", (err) => {
        console.error(`[VIDEO_ENGINE] Page error: ${err.message}`);
      });
      this.page.on("error", (err) => {
        console.error(`[VIDEO_ENGINE] Page crashed: ${err.message}`);
        this.shutdown(1);
      });

      const port = this.server.address().port;
      await this.page.goto(`http://127.0.0.1:${port}/index.html`, {
        waitUntil: "networkidle0",
        timeout: 30_000,
      });

      // The market-tape and hero-chart WebSocket connections aren't
      // established yet when goto() resolves - Kraken's WS round-trip
      // (TCP+TLS+subscribe+first message) is slower than page load, and
      // networkidle0 doesn't wait on persistent connections. Without this,
      // capture used to start almost immediately and the first several
      // seconds of frames showed the static "DATA UNAVAILABLE" HTML default
      // for every asset - not a real data outage, just a startup race. Give
      // the feeds a bounded window to connect before capture begins.
      await this.page
        .waitForFunction(
          () => {
            const el = document.getElementById("mb-price-BTC");
            return !!el && el.textContent !== "DATA UNAVAILABLE";
          },
          { timeout: 8_000 }
        )
        .catch(() => {
          console.error("[VIDEO_ENGINE] BTC market data not confirmed within 8s of page load; starting capture anyway");
        });
    } catch (err) {
      console.error(`[VIDEO_ENGINE] Failed to open dashboard: ${err.message}`);
      await this.shutdown(1);
      return;
    }

    try {
      this.ffmpeg = spawnFfmpeg(this.outputTarget);
    } catch (err) {
      console.error(`[VIDEO_ENGINE] FFmpeg startup failed: ${err.message}`);
      await this.shutdown(1);
      return;
    }

    let ffmpegReady = true;
    this.ffmpeg.once("error", (err) => {
      ffmpegReady = false;
      console.error(`[VIDEO_ENGINE] FFmpeg process error: ${err.message}`);
      this.shutdown(1);
    });

    // FFmpeg's stderr is where RTMP connection status/errors show up
    // (handshake, auth rejection, connection reset, etc.) - normally
    // swallowed entirely, but for RTMP that means no way to ever confirm a
    // real connection from logs. Kept as a rolling buffer of the last few
    // lines (never the constant frame=/fps= progress spam) so that if
    // FFmpeg exits abnormally, whatever it said right before dying can be
    // flushed even if it didn't end in a newline - the stream URL/key is
    // stripped before anything is logged, as defense in depth on top of
    // never logging this.outputTarget.destination directly.
    let stderrBuffer = "";
    const recentStderrLines = [];
    let startupLinesLogged = 0;
    if (this.outputTarget.mode === "rtmp") {
      this.ffmpeg.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = stderrBuffer.indexOf("\n")) !== -1) {
          const line = stderrBuffer.slice(0, newlineIndex);
          stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
          recentStderrLines.push(line);
          if (recentStderrLines.length > 20) recentStderrLines.shift();
          // Unconditionally surface the first ~30 lines regardless of
          // keyword match - this is FFmpeg's startup banner (input/output
          // stream mapping for BOTH the video and audio tracks, codec
          // negotiation, the "Opening '<dest>' for writing" line), which
          // confirms whether it actually attempted the RTMP publish
          // handshake at all. 15 lines cut off before the audio stream
          // mapping/"Output #0" lines ever printed, making it impossible
          // to confirm from logs alone whether audio was actually mapped
          // into the output - 30 comfortably covers both input banners
          // plus the full output stream mapping. After that, only
          // connection/error-relevant lines are logged, so the constant
          // frame=/fps= progress spam doesn't flood the log.
          if (startupLinesLogged < 30) {
            startupLinesLogged += 1;
            console.log(`[VIDEO_ENGINE] FFmpeg RTMP (startup): ${redactStreamSecrets(line)}`);
          } else if (RTMP_STATUS_LINE_PATTERN.test(line)) {
            console.log(`[VIDEO_ENGINE] FFmpeg RTMP: ${redactStreamSecrets(line)}`);
          }
        }
      });
    } else {
      this.ffmpeg.stderr.on("data", () => {
        // FFmpeg logs progress/diagnostics to stderr; swallow unless debugging.
      });
    }

    this.ffmpegExitPromise = new Promise((resolve) => {
      this.ffmpeg.once("close", (code) => {
        if (!this.shuttingDown && code !== 0) {
          console.error(`[VIDEO_ENGINE] FFmpeg terminated unexpectedly (code=${code})`);
          if (this.outputTarget.mode === "rtmp") {
            // Flush anything still sitting in the buffer (the final chunk
            // often has no trailing newline) plus the last few complete
            // lines, so a crash-time RTMP error isn't silently dropped.
            if (stderrBuffer.trim()) recentStderrLines.push(stderrBuffer);
            recentStderrLines.slice(-10).forEach((line) => {
              console.error(`[VIDEO_ENGINE] FFmpeg RTMP (at exit): ${redactStreamSecrets(line)}`);
            });
          }
        } else {
          console.log(`[VIDEO_ENGINE] FFmpeg process closed (code=${code})`);
        }
        resolve(code);
      });
    });

    if (!ffmpegReady) {
      return;
    }

    // Never log the RTMP destination — it embeds the YouTube stream key.
    const destinationLabel = this.outputTarget.mode === "rtmp"
      ? "YouTube RTMP (destination redacted)"
      : this.outputTarget.destination;
    const durationLabel = this.durationMs === null ? "continuously (until stopped)" : `for ${this.durationMs / 1000}s`;

    try {
      await this.startScreencast();
    } catch (err) {
      console.error(`[VIDEO_ENGINE] Failed to start screencast: ${err.message}`);
      await this.shutdown(1);
      return;
    }

    console.log(`[VIDEO_ENGINE] Capturing at ${CAPTURE_FPS}fps ${durationLabel} -> ${destinationLabel}`);
    this.capturing = true;
    this.startTime = Date.now();
    this.scheduleEncodeTick();
    this.startStatsLogger();
  }

  // Periodic (not per-frame) throughput summary: how often CDP actually
  // delivers a fresh repainted frame, vs. the fixed CAPTURE_FPS rate we
  // encode at regardless. Useful for judging real capture performance
  // without spamming logs on every single frame.
  startStatsLogger() {
    let lastCount = 0;
    const STATS_INTERVAL_MS = 10_000;
    this.statsTimer = setInterval(() => {
      const delta = this.freshFrameCount - lastCount;
      lastCount = this.freshFrameCount;
      const fps = (delta / (STATS_INTERVAL_MS / 1000)).toFixed(1);
      console.log(`[VIDEO_ENGINE] Stats: ${delta} fresh frames in ${STATS_INTERVAL_MS / 1000}s (~${fps}fps arrival), ${this.frameCount} total encoded`);
    }, STATS_INTERVAL_MS);
    if (typeof this.statsTimer.unref === "function") {
      this.statsTimer.unref();
    }
  }

  // Uses the Chrome DevTools Protocol's native screencast instead of
  // repeated page.screenshot() calls. CDP pushes a frame whenever Chromium
  // actually repaints, at near-zero overhead compared to round-tripping a
  // full-page PNG capture on every tick. Frame *arrival* (bursty, driven by
  // page repaints) is deliberately decoupled from frame *encoding* (steady
  // CAPTURE_FPS, driven by scheduleEncodeTick): we only keep the latest
  // decoded frame around and let the encode tick pull from it, so FFmpeg
  // always receives a smooth fixed-rate stream regardless of how often the
  // page actually changes.
  async startScreencast() {
    this.cdpSession = await this.page.target().createCDPSession();
    this.latestFrameBuffer = null;

    this.cdpSession.on("Page.screencastFrame", async ({ data, sessionId }) => {
      this.latestFrameBuffer = Buffer.from(data, "base64");
      this.freshFrameCount += 1;
      try {
        await this.cdpSession.send("Page.screencastFrameAck", { sessionId });
      } catch (err) {
        // Session may already be closing; safe to ignore.
      }
    });

    await this.cdpSession.send("Page.startScreencast", {
      // JPEG encodes considerably faster in Chromium than PNG per frame,
      // which is the actual bottleneck on frame *arrival* rate now that
      // screenshot() polling is gone. Quality 90 keeps visible artifacting
      // minimal for a dashboard of mostly text/UI, not photographic detail.
      format: "jpeg",
      quality: 90,
      maxWidth: CAPTURE_WIDTH,
      maxHeight: CAPTURE_HEIGHT,
      everyNthFrame: 1,
    });
  }

  scheduleEncodeTick() {
    if (!this.capturing) return;

    if (this.durationMs !== null) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= this.durationMs) {
        this.finishCapture();
        return;
      }
    }
    // durationMs === null means continuous capture: no elapsed-time check,
    // runs until finishCapture()/shutdown() is triggered externally (e.g.
    // SIGINT/SIGTERM, or a fatal error elsewhere in the pipeline).

    this.captureTimer = setTimeout(() => {
      this.encodeTick();
    }, FRAME_INTERVAL_MS);
  }

  async encodeTick() {
    if (!this.capturing) return;

    if (!this.latestFrameBuffer || !this.ffmpeg || this.ffmpeg.stdin.destroyed) {
      // No frame arrived yet (e.g. very first tick) or ffmpeg unavailable —
      // skip this slot rather than write nothing or block.
      this.scheduleEncodeTick();
      return;
    }

    try {
      const canWriteMore = this.ffmpeg.stdin.write(this.latestFrameBuffer);
      this.frameCount += 1;

      if (!canWriteMore) {
        // Respect stdin backpressure: wait for drain before scheduling the
        // next tick so frames don't pile up in memory.
        await new Promise((resolve) => this.ffmpeg.stdin.once("drain", resolve));
      }
    } catch (err) {
      console.error(`[VIDEO_ENGINE] Failed to write frame to FFmpeg stdin: ${err.message}`);
      this.finishCapture();
      return;
    }

    this.scheduleEncodeTick();
  }

  finishCapture() {
    if (!this.capturing) return;
    this.capturing = false;
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.cdpSession) {
      this.cdpSession.send("Page.stopScreencast").catch(() => {});
    }
    console.log(`[VIDEO_ENGINE] Capture complete: ${this.frameCount} frames encoded`);
    this.shutdown(0);
  }

  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.capturing = false;

    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    console.log("[VIDEO_ENGINE] Shutting down");

    if (this.ffmpeg && !this.ffmpeg.stdin.destroyed) {
      try {
        this.ffmpeg.stdin.end();
      } catch (err) {
        // stdin may already be closed if ffmpeg exited early; safe to ignore.
      }
    }

    if (this.ffmpegExitPromise) {
      await Promise.race([
        this.ffmpegExitPromise,
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
    }

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }

    console.log("[VIDEO_ENGINE] Shutdown complete");

    if (typeof exitCode === "number" && isMainModule()) {
      // Puppeteer's CDP transport can leave a handle open even after
      // browser.close() resolves, so the event loop may not drain on its
      // own. Force a clean exit once all our own resources are released.
      process.exit(exitCode);
    }
  }
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const args = process.argv.slice(2);

  if (args.includes("--capture-test")) {
    const durationArgIndex = args.indexOf("--capture-test") + 1;
    const durationSeconds = Number(args[durationArgIndex]);
    const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds * 1000
      : 60_000;

    const videoEngine = new VideoEngine({ durationMs });

    const shutdown = () => {
      videoEngine.shutdown(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    videoEngine.run();
  } else if (args.includes("--live")) {
    // Production broadcast mode: Supabase polling and continuous video
    // capture run together in one process, so a single process supervisor
    // (pm2/systemd/Docker restart policy) keeps the whole pipeline alive.
    console.log("[STREAM_ENGINE] Live mode: starting Supabase poller + continuous video capture");

    const engine = new StreamEngine();
    engine.start();

    const videoEngine = new VideoEngine({ durationMs: null });

    const shutdown = () => {
      engine.stop();
      videoEngine.shutdown(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    videoEngine.run();
  } else {
    const engine = new StreamEngine();
    engine.start();

    const shutdown = () => {
      engine.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

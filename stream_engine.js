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

function startLocalServer(rootDir, port = 0) {
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

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      console.log(`[VIDEO_ENGINE] Local HTTP server listening on http://127.0.0.1:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

function spawnFfmpeg(outputPath) {
  const args = [
    "-y",
    "-f", "image2pipe",
    "-framerate", String(CAPTURE_FPS),
    "-i", "-",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-r", String(CAPTURE_FPS),
    "-s", `${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`,
    outputPath,
  ];

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  return ffmpeg;
}

export class VideoEngine {
  constructor({
    durationMs = 60_000,
    outputPath = path.resolve("./local_stream_test.mp4"),
    rootDir = path.resolve("."),
  } = {}) {
    this.durationMs = durationMs;
    this.outputPath = outputPath;
    this.rootDir = rootDir;

    this.server = null;
    this.browser = null;
    this.page = null;
    this.ffmpeg = null;

    this.capturing = false;
    this.shuttingDown = false;
    this.frameCount = 0;
    this.startTime = null;
    this.captureTimer = null;
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
    } catch (err) {
      console.error(`[VIDEO_ENGINE] Failed to open dashboard: ${err.message}`);
      await this.shutdown(1);
      return;
    }

    try {
      this.ffmpeg = spawnFfmpeg(this.outputPath);
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

    this.ffmpeg.stderr.on("data", () => {
      // FFmpeg logs progress/diagnostics to stderr; swallow unless debugging.
    });

    this.ffmpegExitPromise = new Promise((resolve) => {
      this.ffmpeg.once("close", (code) => {
        if (!this.shuttingDown && code !== 0) {
          console.error(`[VIDEO_ENGINE] FFmpeg terminated unexpectedly (code=${code})`);
        } else {
          console.log(`[VIDEO_ENGINE] FFmpeg process closed (code=${code})`);
        }
        resolve(code);
      });
    });

    if (!ffmpegReady) {
      return;
    }

    console.log(`[VIDEO_ENGINE] Capturing at ${CAPTURE_FPS}fps for ${this.durationMs / 1000}s -> ${this.outputPath}`);
    this.capturing = true;
    this.startTime = Date.now();
    this.scheduleNextFrame();
  }

  scheduleNextFrame() {
    if (!this.capturing) return;

    const elapsed = Date.now() - this.startTime;
    if (elapsed >= this.durationMs) {
      this.finishCapture();
      return;
    }

    this.captureTimer = setTimeout(() => {
      this.captureFrame();
    }, FRAME_INTERVAL_MS);
  }

  async captureFrame() {
    if (!this.capturing) return;
    const frameStart = Date.now();

    let buffer;
    try {
      buffer = await this.page.screenshot({ type: "png" });
    } catch (err) {
      console.error(`[VIDEO_ENGINE] Screenshot failed, skipping frame: ${err.message}`);
      this.scheduleNextFrame();
      return;
    }

    if (!this.capturing || !this.ffmpeg || this.ffmpeg.stdin.destroyed) {
      return;
    }

    try {
      const canWriteMore = this.ffmpeg.stdin.write(buffer);
      this.frameCount += 1;

      if (!canWriteMore) {
        // Respect stdin backpressure: wait for drain before scheduling the
        // next capture so frames don't pile up in memory.
        await new Promise((resolve) => this.ffmpeg.stdin.once("drain", resolve));
      }
    } catch (err) {
      console.error(`[VIDEO_ENGINE] Failed to write frame to FFmpeg stdin: ${err.message}`);
      this.finishCapture();
      return;
    }

    const frameElapsed = Date.now() - frameStart;
    if (frameElapsed > FRAME_INTERVAL_MS * 2) {
      console.warn(`[VIDEO_ENGINE] Frame ${this.frameCount} took ${frameElapsed}ms (target ${FRAME_INTERVAL_MS.toFixed(1)}ms)`);
    }

    this.scheduleNextFrame();
  }

  finishCapture() {
    if (!this.capturing) return;
    this.capturing = false;
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    console.log(`[VIDEO_ENGINE] Capture complete: ${this.frameCount} frames captured`);
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

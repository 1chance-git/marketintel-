import { writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
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

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const engine = new StreamEngine();
  engine.start();

  const shutdown = () => {
    engine.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

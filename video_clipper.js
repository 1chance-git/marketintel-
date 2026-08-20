// ---------------------------------------------------------------------------
// Short-form vertical clip generator (Block 10)
//
// Renders a short (~12s) 1080x1920 vertical MP4 from the live dashboard,
// with punchy text overlays pulled directly from the real Grok/Supabase
// signal that triggered it - never fabricated/placeholder marketing copy.
// Runs as its own isolated Puppeteer + FFmpeg pipeline (separate local
// server instance, separate browser) so it never contends with or
// interferes with the main continuous RTMP broadcast in stream_engine.js.
//
// Font note: the spec that prompted this asked for "fonts-impact", but no
// such Debian/apt package exists (verified: apt-cache search returns
// nothing) and the real Impact TrueType font isn't freely redistributable
// via apt. Uses LiberationSans-Bold instead, already installed by the
// existing Dockerfile via fonts-liberation - no Dockerfile change needed.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import { startLocalServer } from "./stream_engine.js";
import { uploadShort } from "./youtube_publisher.js";

const SOURCE_WIDTH = 1280;
const SOURCE_HEIGHT = 720;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const CLIP_FPS = 15; // lower than the main broadcast's 30fps - a 12s still-dashboard clip doesn't need more, and it halves render time
const FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";

// Matches the terminal layout's panel positions: ETF/Institutional Flow
// (top-right), BTC chart (left half), Narrative Shift (mid-right),
// Direction/Market State (upper-right). Color is a per-panel accent (green
// for the two "flow/direction" indicator panels, white elsewhere) - purely
// styling, not tied to whatever the live text on a given panel actually
// says.
const KEYFRAMES = [
  { start: 0, end: 3, crop: "w='iw*0.5':h='ih*0.5':x='iw*0.5':y='ih*0.15'", color: "#00FF00" },
  { start: 3, end: 5, crop: "w='iw*0.6':h='ih*0.6':x=0:y='ih*0.2'", color: "#FFFFFF" },
  { start: 5, end: 8, crop: "w='iw*0.5':h='ih*0.5':x='iw*0.5':y='ih*0.35'", color: "#FFFFFF" },
  { start: 8, end: 11, crop: "w='iw*0.5':h='ih*0.5':x='iw*0.5':y='ih*0.1'", color: "#00FF00" },
];
const CLIP_DURATION_S = KEYFRAMES[KEYFRAMES.length - 1].end;

// Real signal text, not fabricated copy: same "Label: detail" convention
// index.html's splitLabelValue() already relies on for these fields - take
// the detail half, drop an overlong label prefix, truncate for on-screen
// legibility, and fall back to a neutral (non-claim) line if a field is
// genuinely empty rather than inventing content.
function deriveLine(items, fallback) {
  const raw = Array.isArray(items) ? items.find((s) => typeof s === "string" && s.trim()) : null;
  if (!raw) return fallback;
  const idx = raw.indexOf(":");
  const text = (idx !== -1 && idx <= 40) ? raw.slice(idx + 1).trim() : raw.trim();
  // Verified against real ffmpeg drawtext output (via the bbox filter) at
  // fontsize=58 on the 1080px-wide canvas: text past ~28-30 uppercase
  // characters overflows the frame horizontally and gets clipped at the
  // edges. 30 chars leaves a safe margin.
  const truncated = text.length > 30 ? `${text.slice(0, 27)}...` : text;
  return truncated.toUpperCase();
}

// One line per KEYFRAMES panel, in the same order: ETF/Institutional Flow,
// BTC chart, Narrative Shift, Direction/Market State.
function deriveOverlayText(signal) {
  return [
    deriveLine(signal.etf_flows, "ETF FLOW UPDATE"),
    deriveLine(signal.system_macro, "MARKET UPDATE"),
    deriveLine(signal.x_narratives, "NARRATIVE PULSE"),
    deriveLine(signal.sentiment, "MARKET STATE"),
  ];
}

// Inside a single-quoted FFmpeg filter argument, backslash is NOT an
// escape character in the intuitive sense - `\'` does not reliably embed a
// literal apostrophe. Verified directly against this container's real
// ffmpeg (6.1.1) with the actual multi-drawtext filter_complex this module
// builds: the textbook "close quote, escaped literal quote, reopen quote"
// technique (`'\''`) - correct in isolation per FFmpeg's own docs - was
// tried first here and PROVED BROKEN in practice: once a drawtext's `text`
// value contains that sequence, FFmpeg's option parser desyncs and
// corrupts every *later* quoted clause in the same filter_complex, most
// dangerously the enable='between(t,...)' clause on this drawtext and
// every drawtext after it (they silently stop being time-gated, or their
// params leak into the rendered text) - exactly the "corrupted filter
// graph" risk this function exists to prevent, just triggered by the
// textbook fix instead of the naive one. Plain `\'` alone (no reopen) does
// at least parse safely (verified: no corruption of later clauses), but
// silently swallows the apostrophe with no visible trace, so there is no
// reliable way to make FFmpeg render a literal apostrophe here - dropping
// it outright is simpler, equally safe, and just as legible on a vertical
// short's overlay text. Backslash and colon (drawtext's own key/value
// separator) still need real backslash-escaping. `%` is deliberately NOT
// escaped here - see buildFilterComplex's `expansion=none`, which disables
// drawtext's %{...} text_expansion entirely (the actual DoS/expression-
// evaluation surface) so unescaped `%` is always literal and safe.
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "");
}

function buildFilterComplex(overlayText) {
  // Single filter chain: time-varying crop (via between() in the crop
  // expression's own enable-equivalent - crop doesn't have `enable`, so
  // each segment's w/h/x/y is itself a conditional expression selecting
  // based on `t`) -> scale to fit within the vertical canvas -> pad the
  // remainder with black (matches the requested #000000 background) ->
  // one drawtext per keyframe segment, each only visible in its own time
  // window via `enable='between(t,start,end)'`.
  // crop filter needs a single w/h/x/y expression, not per-segment - build
  // one nested if() chain per dimension from the keyframe list.
  const nestedIf = (getter) =>
    KEYFRAMES.reduceRight(
      (acc, k, i) => (i === KEYFRAMES.length - 1 ? getter(k) : `if(between(t,${k.start},${k.end}),${getter(k)},${acc})`),
      ""
    );
  const parseCropField = (crop, field) => {
    const m = crop.match(new RegExp(`${field}='?([^:']+)'?`));
    return m ? m[1] : field === "x" || field === "y" ? "0" : "iw";
  };
  const wExpr = nestedIf((k) => parseCropField(k.crop, "w"));
  const hExpr = nestedIf((k) => parseCropField(k.crop, "h"));
  const xExpr = nestedIf((k) => parseCropField(k.crop, "x"));
  const yExpr = nestedIf((k) => parseCropField(k.crop, "y"));

  const cropStage = `crop=w='${wExpr}':h='${hExpr}':x='${xExpr}':y='${yExpr}':exact=1`;
  const scaleStage = `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease:eval=frame`;
  const padStage = `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`;

  const drawtextStages = KEYFRAMES.map((k, i) => {
    const text = escapeDrawtext(overlayText[i]);
    // expansion=none turns off drawtext's %{...}/strftime text_expansion
    // outright, rather than relying on escaping % to survive it - signal
    // text is untrusted (external Gmail->Supabase bridge), and expansion
    // is the actual mechanism that would evaluate an expression embedded
    // in it, not just a display quirk. With it off, a raw `%` is always
    // literal, so no % escaping is needed (or attempted) in escapeDrawtext.
    // Top-centered: x centers horizontally, y is a fixed offset from the
    // top of the 1920px-tall canvas rather than the previous bottom-anchor.
    return `drawtext=fontfile=${FONT_PATH}:text='${text}':expansion=none:fontcolor=${k.color}:fontsize=58:borderw=3:bordercolor=black:x=(w-text_w)/2:y=120:enable='between(t,${k.start},${k.end})'`;
  });

  return [cropStage, scaleStage, padStage, ...drawtextStages].join(",");
}

async function captureFrames(frameDir) {
  const { server, port } = await startLocalServer(path.resolve("."));
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle0", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1500)); // let live data connections settle, same rationale as VideoEngine.run()

    const totalFrames = CLIP_DURATION_S * CLIP_FPS;
    for (let i = 0; i < totalFrames; i++) {
      const frameNum = String(i).padStart(5, "0");
      await page.screenshot({ path: path.join(frameDir, `frame_${frameNum}.jpg`), type: "jpeg", quality: 85 });
      await new Promise((r) => setTimeout(r, 1000 / CLIP_FPS));
    }
  } finally {
    await browser.close();
    server.close();
  }
}

function renderVideo(frameDir, outputPath, overlayText) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-framerate", String(CLIP_FPS),
      "-i", path.join(frameDir, "frame_%05d.jpg"),
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-filter_complex", `[0:v]${buildFilterComplex(overlayText)}[vout]`,
      "-map", "[vout]", "-map", "1:a:0", "-shortest",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-t", String(CLIP_DURATION_S),
      outputPath,
    ];
    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.once("error", (err) => {
      // ENOENT here means the ffmpeg binary itself is missing from PATH -
      // the "graceful error handling if FFmpeg binary is missing"
      // requirement this module needs to satisfy.
      reject(new Error(`FFmpeg failed to start (binary missing?): ${err.message}`));
    });
    ffmpeg.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

// Module-level in-flight guard: onNewSignal in stream_engine.js fires this
// fire-and-forget on every new Supabase signal with no rate limit of its
// own, so if signals arrive faster than one full capture+render+upload
// cycle (30-60s+: ~12s of real-time frame capture, FFmpeg render, network
// upload), overlapping runs would each spin up their own Chromium+FFmpeg
// pair competing with the main broadcast's own Puppeteer+FFmpeg for CPU in
// the same container - this is the exact CPU-contention pattern that
// caused the earlier production "buffering"/stuck-ingest incident fixed by
// switching the main broadcast to the "ultrafast" x264 preset (see
// stream_engine.js's spawnFfmpeg). A module-level flag is enough here since
// this process only ever runs one generateAndUploadClip at a time by design.
let clipGenerationInFlight = false;

// Generates a short vertical clip from the given normalized Grok signal
// (same shape stream_engine.js already writes to grok_data.json) and
// uploads it to YouTube as an unlisted Short for manual review. Never
// throws past this function's own logging - a failure here must not take
// down the caller (the main broadcast pipeline).
export async function generateAndUploadClip(signal) {
  if (clipGenerationInFlight) {
    console.log("[CLIPPER] Skipped: a previous clip generation is still in progress");
    return null;
  }

  // Same "log once, no-op" pattern youtube_publisher.js uses for its own
  // OAuth env vars - checked here, before any Puppeteer/FFmpeg work starts,
  // so a signal doesn't burn a full capture+render cycle only to have
  // uploadShort() reject it at the very end because publishing was never
  // configured.
  if (!process.env.YOUTUBE_OAUTH_CLIENT_ID || !process.env.YOUTUBE_OAUTH_CLIENT_SECRET || !process.env.YOUTUBE_OAUTH_REFRESH_TOKEN) {
    console.log("[CLIPPER] Skipped: YOUTUBE_OAUTH_CLIENT_ID/YOUTUBE_OAUTH_CLIENT_SECRET/YOUTUBE_OAUTH_REFRESH_TOKEN not fully configured - nothing to upload the clip to");
    return null;
  }

  clipGenerationInFlight = true;
  console.log("[CLIPPER STARTED]");

  let frameDir;
  try {
    if (!signal || typeof signal !== "object") {
      throw new Error("corrupted or missing signal input");
    }

    frameDir = await mkdtemp(path.join(tmpdir(), "clip-frames-"));
    await captureFrames(frameDir);

    const overlayText = deriveOverlayText(signal);
    const outputPath = path.join(frameDir, "clip.mp4");
    await renderVideo(frameDir, outputPath, overlayText);
    console.log("[RENDER COMPLETE]");

    const videoBuffer = await readFile(outputPath);
    if (videoBuffer.length === 0) {
      throw new Error("rendered clip buffer is empty/corrupted");
    }

    console.log("[UPLOADING TO YOUTUBE]");
    const watchUrl = await uploadShort(videoBuffer, { signal, overlayText });
    console.log(`[REVIEW URL GENERATED] ${watchUrl}`);
    return watchUrl;
  } catch (err) {
    console.error(`[CLIPPER] Failed: ${err.message}`);
    return null;
  } finally {
    if (frameDir) {
      await rm(frameDir, { recursive: true, force: true }).catch(() => {});
    }
    clipGenerationInFlight = false;
  }
}

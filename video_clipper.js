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
// 30fps: the downstream enhancement/upscale tool the user runs on these
// clips after upload rejects anything below 24fps outright, and the
// user's own "Master Recipe" export spec calls for 30 or 60fps (never
// 720p/below-24fps) on data videos specifically, so numbers stay legible.
const CLIP_FPS = 30;
const FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";

// Crop fractions below are measured directly from the real rendered layout
// via getBoundingClientRect() at the 1280x720 capture viewport (not
// eyeballed) - #card-rotator sits at x:870-1280,y:84-549 and #chart-pane at
// x:0-870,y:84-681. Earlier hand-guessed fractions cropped well outside
// those bounds, capturing mostly blank background and cutting the actual
// panel text off at the frame edges after scale+pad (reported as "can't
// read the text, it's clipped" - confirmed by rendering a real frame and
// comparing against the measured DOM rects).
//
// There are only two physically distinct regions on screen at any moment -
// the chart and the rotating intel card - not four. #card-rotator itself
// cycles through 5 categories (ETF/Macro/Narrative/Sentiment/WhatNow) on a
// 10s timer that's longer than this whole clip, so left alone it would
// never naturally reach "Narrative"/"Direction" within an ~11s clip.
// rotatorSlideAt (used by captureFrames) forces the intended category into
// view at each keyframe's start time via the window.__mktRotatorGoTo hook
// index.html exposes, instead of relying on real-time auto-rotation.
// Zoomed in vertically from the full-panel crop (was h*0.646/h*0.829) to
// skip the empty gap between each panel's title and its actual content,
// matching a reference clip's tighter, more magnified framing. Width is
// kept at the panel's full real width, NOT narrowed - verified by
// rendering: narrowing the width cut off real text mid-word at the right
// edge ("SELECTIV...", "FE...") because these panels' text genuinely wraps
// across their full width, so the crop needs to keep all of it.
const ROTATOR_CROP = "w='iw*0.32':h='ih*0.50':x='iw*0.68':y='ih*0.117'";
// The candle chart itself was dropped from this beat - even once it was
// rendering correctly (confirmed via production pixel-sampling), it read
// as a visually empty/uninformative panel to an actual viewer, since 10
// short 1-minute candles barely register at this zoom. Replaced with a
// tight crop on the dashboard's own TREND/VOLUME badges and EMA/VWAP
// legend instead - the same real-evidence numbers already backing
// buildChartLine's overlay text, just showing the source pixels for them
// too.
//
// A first attempt centered this crop on #chart-badges/#chart-legend's own
// container rects (full-width flex rows) and caught only empty flex space
// plus the header's right-aligned price bleeding in from above - those
// containers' rects aren't where the left-aligned text actually sits.
// __mktChartDebug now unions the real .chart-badge-label/.chart-badge-
// value/.legend-item elements' own getBoundingClientRect()s, which
// returned {x:14, y:162.5, width:145, height:29.5} in production on the
// 1280x720 source - i.e. the text spans x:14-159, y:162.5-192. This crop
// is that real bbox plus ~18px padding on each side (x:0-177, y:144.5-210),
// converted to iw*/ih* fractions.
const INFO_CROP = "w='iw*0.1383':h='ih*0.091':x=0:y='ih*0.2007'";

// Also doubles as a 4-beat narrative arc (setup -> turning point ->
// confirmation -> outcome), matching the pacing style of a reference clip -
// but unlike that reference, the text filling each beat is always derived
// live below (deriveNarrativeArc), never fixed/fabricated copy.
const KEYFRAMES = [
  { start: 0, end: 2.7, crop: ROTATOR_CROP, rotatorSlide: 0 }, // ETF / Institutional Flow
  { start: 2.7, end: 5.5, crop: INFO_CROP, rotatorSlide: null }, // TREND/VOLUME + EMA/VWAP legend - not rotator content
  { start: 5.5, end: 8.2, crop: ROTATOR_CROP, rotatorSlide: 2 }, // Narrative Shift
  { start: 8.2, end: 11.0, crop: ROTATOR_CROP, rotatorSlide: 3 }, // Market Sentiment / Direction
];
const CLIP_DURATION_S = KEYFRAMES[KEYFRAMES.length - 1].end;

// Color is derived from the real text's own sentiment, not a fixed
// per-panel assignment - a bearish line never gets painted green just
// because it landed in the "outcome" beat. Keyword lists are intentionally
// small/conservative (only clear, common directional terms already used in
// this dashboard's own vocabulary - see index.html's FEAR/GREED, TREND,
// DIRECTION indicators) so this doesn't become its own source of invented
// claims; anything ambiguous stays white.
const BULLISH_WORDS = /\b(bullish|risk-on|inflow|inflows|accumulation|rally|surge|breakout|upgrade|outperform)\b/i;
const BEARISH_WORDS = /\b(bearish|risk-off|outflow|outflows|selloff|sell-off|decline|downgrade|underperform|dump)\b/i;

function deriveColor(text) {
  if (BULLISH_WORDS.test(text)) return "#00FF00";
  if (BEARISH_WORDS.test(text)) return "#FF4444";
  return "#FFFFFF";
}

// fontsize was 58 originally; real signal text (e.g. "RECENT OUTFLOWS ON
// BTC, SELECTIVE ETH INFLOWS") needed truncating well before the 30-char
// width limit, and a flat character-count cut landed mid-word ("...SEL...")
// which reads as broken, not just short - that's what "the overlay is
// still clipped" meant (not literal off-canvas clipping - the bbox-verified
// 30-char limit did keep text on-canvas - but an ugly mid-word cut looks
// exactly like clipping to a viewer). Fixed two ways: dropped fontsize to
// 42 for real headroom (verified via ffmpeg's bbox filter: real signal
// text up to ~40 chars fits with margin at this size, vs ~30 at 58), and
// truncateForOverlay now backs up to the last whole word instead of
// cutting mid-word.
const OVERLAY_FONTSIZE = 42;
const OVERLAY_MAX_CHARS = 36;
const OVERLAY_FADE_S = 0.25; // fade-in duration at each beat's entrance, not its own trim/hold time

function truncateForOverlay(text) {
  const upper = text.toUpperCase();
  if (upper.length <= OVERLAY_MAX_CHARS) return upper;
  const cut = upper.slice(0, OVERLAY_MAX_CHARS - 3);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back up to the last word if that doesn't throw away most of the
  // budget (e.g. one long hyphenless word) - otherwise a hard cut is less
  // jarring than truncating down to just a couple of words.
  const base = lastSpace > OVERLAY_MAX_CHARS * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${base}...`;
}

// Real signal text, not fabricated copy: same "Label: detail" convention
// index.html's splitLabelValue() already relies on for these fields - take
// the detail half, drop an overlong label prefix, and fall back to a
// neutral (non-claim) line if a field is genuinely empty rather than
// inventing content.
function deriveLine(items, fallback) {
  const raw = Array.isArray(items) ? items.find((s) => typeof s === "string" && s.trim()) : null;
  if (!raw) return fallback;
  const idx = raw.indexOf(":");
  const text = (idx !== -1 && idx <= 40) ? raw.slice(idx + 1).trim() : raw.trim();
  return truncateForOverlay(text);
}

// The BTC-chart and Direction beats used to be an arbitrary truncated line
// from system_macro/sentiment - often not about BTC's price action at all,
// and disconnected from what the cropped panel actually showed at that
// moment. Both are now built from the exact numbers/labels visible
// on-screen in that frame (see readOnScreenEvidence below), so the caption
// is always evidence the viewer can see for themselves, not a
// paraphrase of an unrelated sentence.
//
// Framed explicitly as the price's own reaction (this beat sits right
// after the ETF-flow beat in the arc) - but deliberately says "reacts",
// not "reacts to [ETF flows]" or any other implied cause. Whether that
// specific price move was actually driven by the ETF flow, the narrative,
// or something else entirely isn't something this pipeline computes or
// verifies, so it must not claim it. Color comes directly from the real
// sign of changeNum (more precise than deriveColor's keyword matching,
// which was built for free-text signal lines, not a number we already
// have authoritatively) - green/red only when there's an actual real
// number to back it, white when price data isn't available.
function buildChartLine(evidence) {
  if (!evidence.btcPrice || evidence.btcPrice === "DATA UNAVAILABLE") {
    return { text: "BTC/USD LIVE CHART", color: "#FFFFFF" };
  }
  const changeNum = parseFloat(evidence.btcChange);
  const hasChange = Number.isFinite(changeNum);
  const changeText = hasChange ? `${changeNum >= 0 ? "UP" : "DOWN"} ${Math.abs(changeNum).toFixed(2)}%` : null;
  const trend = evidence.trend && evidence.trend !== "—" ? evidence.trend.toUpperCase() : null;
  const parts = ["BTC REACTS", changeText, trend ? `· ${trend}` : null].filter(Boolean);
  const color = hasChange ? (changeNum >= 0 ? "#00FF00" : "#FF4444") : "#FFFFFF";
  return { text: truncateForOverlay(parts.join(" ")), color };
}

function buildDirectionLine(evidence) {
  if (!evidence.direction) return "MARKET STATE";
  return truncateForOverlay(`DIRECTION: ${evidence.direction}`);
}

// One {text, color} beat per KEYFRAMES panel, in the same order: ETF/
// Institutional Flow, TREND/VOLUME info panel, Narrative Shift, Direction/
// Market State - also read top-to-bottom as a 4-beat arc (setup -> price
// reaction -> confirmation -> outcome). The ETF and Narrative beats come
// from the real Grok signal text (already the exact evidence that panel
// displays), each colored via deriveColor's keyword match; the info-panel
// beat comes from buildChartLine, which already picks its own color from
// the real price sign (see its comment - more precise than keyword
// matching for a number we already have exactly); Direction comes from
// buildDirectionLine's DOM read, colored via deriveColor same as the text
// beats.
function deriveNarrativeArc(signal, evidence) {
  const etfText = deriveLine(signal.etf_flows, "ETF FLOW UPDATE");
  const narrativeText = deriveLine(signal.x_narratives, "NARRATIVE PULSE");
  const directionText = buildDirectionLine(evidence);
  return [
    { text: etfText, color: deriveColor(etfText) },
    buildChartLine(evidence),
    { text: narrativeText, color: deriveColor(narrativeText) },
    { text: directionText, color: deriveColor(directionText) },
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

function buildFilterComplex(arc) {
  // Per-keyframe branch, not a single time-varying crop: verified locally
  // (real ffmpeg 5.1.9 render, not assumed) that ffmpeg's crop filter only
  // evaluates its OWN OUTPUT w/h once at filter init - x/y can vary per
  // frame via between(t,...), but w/h stay frozen at whichever keyframe's
  // dimensions happened to evaluate first (KEYFRAMES[0], the rotator
  // crop). Every later keyframe with a *different* crop size (the chart
  // beat's CHART_CROP) silently got the rotator's frozen size instead of
  // its own - this is why the chart segment never showed real candles no
  // matter how correct its coordinates were: the crop filter itself
  // couldn't apply them. Fix: split the input into one branch per
  // keyframe, trim each to its own time window, crop/scale/pad each at
  // its own fixed size, then concat back into one continuous stream -
  // concat reconstructs continuous PTS across segments, so a single
  // downstream between(t,...) drawtext pass still works unmodified.
  const branchLabels = KEYFRAMES.map((_, i) => `seg${i}`);
  const splitStage = `split=${KEYFRAMES.length}${KEYFRAMES.map((_, i) => `[s${i}]`).join("")}`;
  // blur_fill background instead of solid black pad: whenever a crop's
  // aspect ratio doesn't match the 1080x1920 output (which is most of the
  // time - none of ROTATOR_CROP/INFO_CROP are 9:16), the remaining space
  // is filled with a blurred, edge-to-edge cover-scaled copy of that same
  // crop rather than flat black bars. Verified locally: variance sampled
  // off a real rendered frame confirmed the background region is smoothly
  // blurred (near-zero local variance) while the sharp foreground content
  // sits centered on top at full detail.
  const branchStages = KEYFRAMES.map((k, i) => {
    const crop = k.crop.replace(/:exact=1$/, "");
    return (
      `[s${i}]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS,` +
      `crop=${crop}:exact=1,split=2[c${i}fg][c${i}bg];` +
      `[c${i}bg]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},gblur=sigma=20[c${i}bgblur];` +
      `[c${i}fg]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[c${i}fgscaled];` +
      `[c${i}bgblur][c${i}fgscaled]overlay=(W-w)/2:(H-h)/2,setsar=1[${branchLabels[i]}]`
    );
  });
  const concatStage = `${branchLabels.map((l) => `[${l}]`).join("")}concat=n=${KEYFRAMES.length}:v=1:a=0[vconcat]`;

  const drawtextStages = KEYFRAMES.map((k, i) => {
    const text = escapeDrawtext(arc[i].text);
    // expansion=none turns off drawtext's %{...}/strftime text_expansion
    // outright, rather than relying on escaping % to survive it - signal
    // text is untrusted (external Gmail->Supabase bridge), and expansion
    // is the actual mechanism that would evaluate an expression embedded
    // in it, not just a display quirk. With it off, a raw `%` is always
    // literal, so no % escaping is needed (or attempted) in escapeDrawtext.
    // Top-centered: x centers horizontally, y is a fixed offset from the
    // top of the 1920px-tall canvas rather than the previous bottom-anchor.
    // Color comes from this beat's own derived sentiment (arc[i].color),
    // not a fixed per-panel value.
    //
    // alpha ramps 0->1 over the first OVERLAY_FADE_S of each beat's own
    // window (verified locally: real ffmpeg render, brightness ramps
    // 0->102->203->255 across the fade then holds) so text fades in at
    // scene entrance rather than hard-cutting in; enable='between(t,...)'
    // still gates visibility to exactly the beat's own start/end, so the
    // overlay's duration continues to match the scene's duration exactly.
    const alphaExpr = `if(lt(t-${k.start},${OVERLAY_FADE_S}),(t-${k.start})/${OVERLAY_FADE_S},1)`;
    return `drawtext=fontfile=${FONT_PATH}:text='${text}':expansion=none:fontcolor=${arc[i].color}:fontsize=${OVERLAY_FONTSIZE}:borderw=3:bordercolor=black:x=(w-text_w)/2:y=120:alpha='${alphaExpr}':enable='between(t,${k.start},${k.end})'`;
  });

  const drawtextChain = drawtextStages.length ? `[vconcat]${drawtextStages.join(",")}[vout]` : "[vconcat]copy[vout]";

  return [`[0:v]${splitStage}`, ...branchStages, concatStage, drawtextChain].join(";\n");
}

// Reads the exact numbers/labels the dashboard itself has already computed
// and rendered - BTC price/change (market-board ticker), trend (chart
// header badge), and DIRECTION (Market Sentiment's own classifyDirection()
// output, term-direction-value - present in the DOM even while that
// rotator slide is hidden, since ROTATION_SLIDES only toggles the `hidden`
// attribute, never removes the content). This is what makes buildChartLine/
// buildDirectionLine "evidence", not invention - it's a direct read of
// numbers already on screen, not a new computation.
async function readOnScreenEvidence(page) {
  return page.evaluate(() => ({
    btcPrice: document.getElementById("mb-price-BTC")?.textContent?.trim() || null,
    btcChange: document.getElementById("mb-change-BTC")?.textContent?.trim().replace(/[+%]/g, "") || null,
    trend: document.getElementById("trend-value")?.textContent?.trim() || null,
    direction: document.querySelector(".term-direction-value")?.textContent?.trim() || null,
  }));
}

async function captureFrames(frameDir) {
  const { server, port } = await startLocalServer(path.resolve("."));
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    // Forward browser-console output (e.g. index.html's own caught
    // "[CHART] candleSeries.setData failed" logs) into Railway logs - the
    // headless page's console is otherwise invisible to us, so a silently
    // caught chart render error would look identical to "no error at all"
    // from here.
    page.on("console", (msg) => console.log(`[CLIPPER PAGE CONSOLE] ${msg.text()}`));
    page.on("pageerror", (err) => console.error(`[CLIPPER PAGE ERROR] ${err.message}`));
    await page.setViewport({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle0", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1500)); // let live data connections settle, same rationale as VideoEngine.run()

    // Confirmed in production: the flat 1500ms wait above isn't long enough
    // for the Kraken WebSocket feed to deliver real OHLC candle data
    // (separate from the market-board ticker). The info panel's TREND/
    // VOLUME badges are also computed from that same candleData, so they'd
    // otherwise still show "—" placeholders here even though the candle
    // canvas itself is no longer in frame. #chart-fallback is hidden via
    // style.display="none" only once candleData[ticker] actually has
    // candles (see index.html) - wait on that same signal VideoEngine.run()
    // already uses (via mb-price-BTC) for the market board.
    await page
      .waitForFunction(
        () => document.getElementById("chart-fallback")?.style.display === "none",
        { timeout: 8_000 }
      )
      .catch(() => {
        console.error("[CLIPPER] BTC candle data not confirmed within 8s of page load; capturing anyway");
      });

    const chartDebug = await page.evaluate(() => window.__mktChartDebug?.() ?? null);
    console.log(`[CLIPPER] Chart debug at capture time: ${JSON.stringify(chartDebug)}`);

    const evidence = await readOnScreenEvidence(page);

    // showRotatorSlide(0) already runs on page load, matching KEYFRAMES[0]'s
    // rotatorSlide - only need to force it for the later keyframes.
    const pendingRotatorCues = KEYFRAMES
      .filter((k) => k.rotatorSlide !== null && k.start > 0)
      .map((k) => ({ atSecond: k.start, slide: k.rotatorSlide }));

    const totalFrames = CLIP_DURATION_S * CLIP_FPS;
    for (let i = 0; i < totalFrames; i++) {
      const elapsedS = i / CLIP_FPS;
      while (pendingRotatorCues.length && elapsedS >= pendingRotatorCues[0].atSecond) {
        const cue = pendingRotatorCues.shift();
        await page.evaluate((slide) => window.__mktRotatorGoTo?.(slide), cue.slide);
      }
      const frameNum = String(i).padStart(5, "0");
      await page.screenshot({ path: path.join(frameDir, `frame_${frameNum}.jpg`), type: "jpeg", quality: 85 });
      await new Promise((r) => setTimeout(r, 1000 / CLIP_FPS));
    }
    return evidence;
  } finally {
    await browser.close();
    server.close();
  }
}

function renderVideo(frameDir, outputPath, arc) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-framerate", String(CLIP_FPS),
      "-i", path.join(frameDir, "frame_%05d.jpg"),
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-filter_complex", buildFilterComplex(arc),
      "-map", "[vout]", "-map", "1:a:0", "-shortest",
      // tune=stillimage + a lower CRF (higher quality/bitrate) for
      // graphics-first rendering - this content is flat-color dashboard
      // panels and text, not natural video, so x264's motion-focused psy
      // optimizations buy nothing here and stillimage tuning keeps edges/
      // text sharper instead. Verified locally that -tune stillimage is
      // accepted by this ffmpeg/libx264 build.
      "-c:v", "libx264", "-preset", "fast", "-tune", "stillimage", "-crf", "16", "-pix_fmt", "yuv420p",
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
    const evidence = await captureFrames(frameDir);

    const arc = deriveNarrativeArc(signal, evidence);
    const outputPath = path.join(frameDir, "clip.mp4");
    await renderVideo(frameDir, outputPath, arc);
    console.log("[RENDER COMPLETE]");

    const videoBuffer = await readFile(outputPath);
    if (videoBuffer.length === 0) {
      throw new Error("rendered clip buffer is empty/corrupted");
    }

    console.log("[UPLOADING TO YOUTUBE]");
    // uploadShort/buildShortMetadata only need the plain text (for the
    // title/description) - the per-beat color is purely a video-render
    // concern, not relevant to the upload metadata.
    const watchUrl = await uploadShort(videoBuffer, { signal, overlayText: arc.map((beat) => beat.text) });
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

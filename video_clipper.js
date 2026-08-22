// ---------------------------------------------------------------------------
// Short-form vertical clip generator (Block 10)
//
// Renders a short (~12s) 1080x1920 vertical MP4 from the live dashboard,
// narrated by an ElevenLabs voiceover built from the real Grok/Supabase
// signal that triggered it - never fabricated/placeholder marketing copy.
// No on-screen caption text - tried and reverted twice: even after fixing
// every sync dimension found (per-beat timing, caption/narration color
// match, institution-name match, audio/video concat drift), captions
// still didn't reliably match the narration in production, and the
// remaining gap is almost certainly ElevenLabs' own per-segment lead-in
// silence before speech starts, which caption timing (tied to the audio
// FILE's start, not word-level speech timestamps) can't correct for.
// Runs as its own isolated Puppeteer + FFmpeg pipeline (separate local
// server instance, separate browser) so it never contends with or
// interferes with the main continuous RTMP broadcast in stream_engine.js.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
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

// A ~8% tighter, re-centered version of the same real crop region -
// alternated in every other beat (see buildKeyframes) as a cheap "pattern
// interrupt": the visual framing punches in slightly on a beat change so
// the shot isn't perfectly static for the whole clip, without any new
// capture/timing machinery (same DOM pixels, same evidence, just a
// different centered crop of them) and without reopening the per-beat
// caption/sync problems this project already tried and reverted twice.
// Center point is preserved algebraically from ROTATOR_CROP/INFO_CROP's
// own real x/y/w/h (new_w = w*0.92, new_x = x + w*0.04, etc.) - not a
// separately eyeballed region.
const ROTATOR_CROP_ZOOM = "w='iw*0.2944':h='ih*0.46':x='iw*0.6928':y='ih*0.137'";
const INFO_CROP_ZOOM = "w='iw*0.127236':h='ih*0.08372':x='iw*0.005532':y='ih*0.20434'";

// Fallback timing only - used when narration isn't available/fails
// entirely (see synthesizeNarrationSegments's all-or-nothing behavior), so
// a themed clip still has a sensible pace with no real audio driving it.
// Each themed clip has 1-3 beats (one per real bullet found, see
// buildFieldNarration) rather than a fixed 4, so this is sized for the max.
const DEFAULT_BEAT_DURATIONS_S = [3.2, 3.2, 3.2];

// Builds the KEYFRAMES array for one themed clip from real per-beat
// narration durations (or the DEFAULT_BEAT_DURATIONS_S fallback). Every
// beat stays on the same rotator slide/data category (unlike the old
// 4-beat arc, which cut between panels) but alternates between the normal
// crop and its punched-in zoom variant beat-to-beat for a bit of visual
// movement.
function buildKeyframes(beatDurations, crop, zoomCrop, rotatorSlide) {
  let t = 0;
  return beatDurations.map((duration, i) => {
    const start = t;
    t += duration;
    return { start, end: t, crop: i % 2 === 0 ? crop : zoomCrop, rotatorSlide };
  });
}

// Color is derived from the real text's own sentiment, not a fixed
// per-panel assignment - a bearish line never gets painted green just
// because it landed in the "outcome" beat. Keyword lists are intentionally
// small/conservative (only clear, common directional terms already used in
// this dashboard's own vocabulary - see index.html's FEAR/GREED, TREND,
// DIRECTION indicators) so this doesn't become its own source of invented
// claims; anything ambiguous stays white.
const BULLISH_WORDS = /\b(bullish|risk-on|inflow|inflows|accumulation|rally|surge|breakout|upgrade|outperform)\b/i;
const BEARISH_WORDS = /\b(bearish|risk-off|outflow|outflows|selloff|sell-off|decline|downgrade|underperform|dump)\b/i;

// Classifies real text by which sentiment direction has MORE keyword
// matches (not just "bullish checked first"), so a real mixed-sentiment
// line like "BTC outflows offset by selective ETH inflows" is classified
// by which side actually dominates the text rather than always winning on
// whichever regex happens to be tested first. Ties (including zero/zero)
// stay neutral - simple, deterministic keyword counting, no fuzzy matching.
function classifySentiment(text) {
  const bullishCount = (text.match(new RegExp(BULLISH_WORDS.source, "gi")) || []).length;
  const bearishCount = (text.match(new RegExp(BEARISH_WORDS.source, "gi")) || []).length;
  if (bullishCount > bearishCount) return "bullish";
  if (bearishCount > bullishCount) return "bearish";
  return "neutral";
}

function deriveColor(text) {
  const sentiment = classifySentiment(text);
  if (sentiment === "bullish") return "#00FF00";
  if (sentiment === "bearish") return "#FF4444";
  return "#FFFFFF";
}

// Six focused single-topic clips instead of one multi-beat arc - each
// stays on one real data category the whole time (one crop/rotator-slide
// for all its beats): institutional/ETF flow, macro/Fear&Greed, technical
// indicators, narrative/catalyst, overall sentiment, and "what matters
// now". rotatorSlide indices match index.html's own rotator order (etf=0,
// macro=1, narrative=2, sentiment=3, whatnow=4); technical-analysis has no
// rotator slide of its own - it's the TREND/VOLUME/EMA/VWAP info panel,
// which is visible independent of rotator state.
const HOOK_MAX_CHARS = 24;
function truncateForHook(text) {
  const upper = text.toUpperCase();
  if (upper.length <= HOOK_MAX_CHARS) return upper;
  const cut = upper.slice(0, HOOK_MAX_CHARS - 3);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > HOOK_MAX_CHARS * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${base}...`;
}

// Narration-length truncation (not the on-screen hook's tight 24-char cap) -
// word-boundary safe, generous enough that ElevenLabs still reads a full,
// natural clause rather than a fragment.
const SPEECH_MAX_CHARS = 220;
function truncateForSpeech(text) {
  if (text.length <= SPEECH_MAX_CHARS) return text;
  const cut = text.slice(0, SPEECH_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > SPEECH_MAX_CHARS * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

// Real signal bullets, spoken close to verbatim - deliberately NOT run
// through stripNumbers. Unlike the old single-clip narration (which never
// spoke raw numbers, by design), these themed clips exist specifically to
// call out real figures a viewer asked for ("$517M+ BTC ETF inflows",
// "BlackRock's $285M IBIT dominance") - the numbers are real, sourced
// directly from the Grok/Supabase signal text, never invented, so
// speaking them verbatim is still within the no-fabrication rule; it's a
// different stylistic choice for a different kind of clip, not a
// loosening of what's allowed to be said.
function buildFieldNarration(items, categoryLabel) {
  const real = Array.isArray(items) ? items.filter((s) => typeof s === "string" && s.trim()) : [];
  if (!real.length) {
    return [`No notable ${categoryLabel} data is available in this signal.`];
  }
  return real.slice(0, 3).map((raw) => {
    const idx = raw.indexOf(":");
    const cleaned = (idx !== -1 && idx <= 40) ? raw.slice(idx + 1).trim() : raw.trim();
    return truncateForSpeech(cleaned);
  });
}

function formatUsd(n) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Technical-analysis narration - built entirely from evidence.technical
// (real EMA20/EMA50/VWAP/price/trend/volume, read fresh off the chart's
// own indicator computation via __mktChartDebug - see readOnScreenEvidence
// and index.html). Every sentence restates a real computed number; nothing
// here is invented or estimated. Support/resistance levels were considered
// for this clip but dropped - the dashboard has no real support/resistance
// computation anywhere (only a current-price line), and inventing levels
// would violate the no-fabrication rule.
function buildTechnicalNarration(evidence) {
  const t = evidence.technical;
  if (!t || !Number.isFinite(t.price)) {
    return ["No technical indicator data is available for this signal."];
  }
  const segments = [];
  segments.push(`${t.ticker} is trading around ${formatUsd(t.price)}, with the trend reading ${(t.trend || "neutral").toLowerCase()}.`);
  if (Number.isFinite(t.ema20) && Number.isFinite(t.ema50)) {
    const relation = t.ema20 > t.ema50 ? "sitting above" : t.ema20 < t.ema50 ? "sitting below" : "converging with";
    segments.push(`The twenty-period moving average is ${relation} the fifty-period average, at ${formatUsd(t.ema20)} versus ${formatUsd(t.ema50)}.`);
  }
  if (Number.isFinite(t.vwap)) {
    const relation = t.price > t.vwap ? "above" : t.price < t.vwap ? "below" : "right at";
    segments.push(`Price is trading ${relation} the volume-weighted average price of ${formatUsd(t.vwap)}.`);
  }
  if (t.volume && t.volume !== "—") {
    segments.push(`Volume is currently reading ${t.volume.toLowerCase()}.`);
  }
  return segments;
}

// "What Matters Now" narration - one sentence per real row already shown
// on that panel (see readOnScreenEvidence's comment: TOP NARRATIVE/TOP
// SIGNAL/OVERALL BIAS, computed by index.html's own renderWhatNow() from
// the first real x_narratives/sentiment entries). Speaks each row's real
// value close to verbatim, same as buildFieldNarration's other themed
// clips - nothing here is a new judgment call, just the panel's own
// real text read aloud.
function buildWhatNowNarration(signal, evidence) {
  const rows = evidence.whatNowRows || [];
  if (!rows.length) {
    return ["No notable market-intelligence summary is available in this signal."];
  }
  return rows.map((row) => `${row.label}: ${truncateForSpeech(row.value)}.`);
}

const CLIP_TEMPLATES = [
  {
    id: "etf-flows",
    label: "INSTITUTIONAL FLOWS",
    rotatorSlide: 0,
    crop: ROTATOR_CROP,
    zoomCrop: ROTATOR_CROP_ZOOM,
    buildScripts: (signal) => buildFieldNarration(signal.etf_flows, "ETF / institutional flow"),
  },
  {
    id: "macro-sentiment",
    label: "MACRO PULSE",
    rotatorSlide: 1,
    crop: ROTATOR_CROP,
    zoomCrop: ROTATOR_CROP_ZOOM,
    buildScripts: (signal) => buildFieldNarration(signal.system_macro, "macro"),
  },
  {
    id: "technical-analysis",
    label: "TECHNICAL READ",
    rotatorSlide: null,
    crop: INFO_CROP,
    zoomCrop: INFO_CROP_ZOOM,
    buildScripts: (signal, evidence) => buildTechnicalNarration(evidence),
  },
  {
    id: "narrative-catalyst",
    label: "NARRATIVE PULSE",
    rotatorSlide: 2,
    crop: ROTATOR_CROP,
    zoomCrop: ROTATOR_CROP_ZOOM,
    buildScripts: (signal) => buildFieldNarration(signal.x_narratives, "narrative"),
  },
  {
    id: "daily-snapshot",
    label: "SENTIMENT CHECK",
    rotatorSlide: 3,
    crop: ROTATOR_CROP,
    zoomCrop: ROTATOR_CROP_ZOOM,
    buildScripts: (signal) => buildFieldNarration(signal.sentiment, "sentiment"),
  },
  {
    id: "what-matters-now",
    label: "WHAT MATTERS NOW",
    rotatorSlide: 4,
    crop: ROTATOR_CROP,
    zoomCrop: ROTATOR_CROP_ZOOM,
    buildScripts: (signal, evidence) => buildWhatNowNarration(signal, evidence),
  },
];

// Bold hook title for a themed clip's first 3 seconds - the template's own
// fixed label (a real category name, not fabricated data) colored by the
// real sentiment of what that clip actually says, via the same
// classifySentiment keyword match used elsewhere.
function buildHookTitle(template, scripts) {
  return { text: truncateForHook(template.label), color: deriveColor(scripts.join(" ")) };
}

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
// "Adam" - a public ElevenLabs premade voice with a clear, professional,
// mid-register male tone (news/narration style), matching the "News,
// Narration" voice tags called for by the spec. Not user-uploaded/cloned,
// so no extra account setup beyond the API key itself.
const ELEVENLABS_VOICE_ID = "pNInz6obpgDQGcFmaJgB";
const TTS_FETCH_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = TTS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Returns an mp3 Buffer, or null if narration isn't configured/fails - a
// TTS outage must never take down clip generation, since the rest of the
// pipeline (real dashboard capture + overlays) is fully functional without
// it. Errors are logged, not thrown.
async function synthesizeVoiceover(script) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.log("[CLIPPER] ELEVENLABS_API_KEY not configured - skipping voiceover narration");
    return null;
  }
  try {
    const res = await fetchWithTimeout(`${ELEVENLABS_TTS_URL}/${ELEVENLABS_VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: script,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[CLIPPER] ElevenLabs TTS request failed (${res.status}): ${body.slice(0, 300)}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`[CLIPPER] ElevenLabs TTS request errored: ${err.message}`);
    return null;
  }
}

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath];
    const proc = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.once("error", (err) => reject(new Error(`ffprobe failed to start: ${err.message}`)));
    proc.once("close", (code) => {
      const val = parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(val)) resolve(val);
      else reject(new Error(`ffprobe exited ${code} or gave unparseable duration: ${stderr.slice(-500)}`));
    });
  });
}

// Synthesizes one narration segment per beat and measures each real audio
// duration via ffprobe, so each beat's on-screen window (buildKeyframes)
// can be driven by that beat's actual spoken length rather than a fixed
// guess. All-or-nothing: if ElevenLabs isn't configured or ANY segment
// fails, returns null so the caller falls back to DEFAULT_BEAT_DURATIONS_S
// with no narration - a partial mix of narrated and silent beats would be
// a more confusing result than either fully-narrated or fully-silent.
async function synthesizeNarrationSegments(scripts, frameDir) {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.log("[CLIPPER] ELEVENLABS_API_KEY not configured - skipping per-scene voiceover narration");
    return null;
  }
  const segments = [];
  for (let i = 0; i < scripts.length; i++) {
    const audio = await synthesizeVoiceover(scripts[i]);
    if (!audio) return null; // synthesizeVoiceover already logged its own error
    const segPath = path.join(frameDir, `narration_seg${i}.mp3`);
    await writeFile(segPath, audio);
    let duration;
    try {
      duration = await ffprobeDuration(segPath);
    } catch (err) {
      console.error(`[CLIPPER] Failed to measure narration segment ${i} duration: ${err.message}`);
      return null;
    }
    segments.push({ path: segPath, duration });
  }
  return segments;
}

// Stream-copy concat (concat demuxer + -c copy), NOT the filter_complex
// concat filter this used previously. Verified locally with real ffmpeg:
// decoding each segment through the concat FILTER and re-encoding the
// result measurably shrinks total duration (a real test: four 2.351020s
// segments, summing to 9.40408s, re-encoded down to 9.247347s - LAME
// encoder delay/padding being resolved away during decode+re-encode).
// Since buildKeyframes sizes each beat's on-screen window from the
// pre-concat individual segment durations, that shrinkage meant narration
// increasingly started slightly BEFORE its matching visual crop/caption,
// worst on the last beat - the exact "text overlay should match narrative"
// sync this pipeline is supposed to guarantee. Stream-copy concat doesn't
// decode/re-encode at all, so it doesn't introduce that discrepancy: the
// same test measured 9.404082s for the concatenated file, matching the
// pre-concat sum to within a millisecond.
function concatAudioSegments(segments, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = path.join(path.dirname(outputPath), "narration_concat_list.txt");
    const listContent = segments.map((s) => `file '${s.path.replace(/'/g, "'\\''")}'`).join("\n");
    writeFile(listPath, listContent)
      .then(() => {
        const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath];
        const proc = spawn("ffmpeg", args);
        let stderr = "";
        proc.stderr.on("data", (c) => (stderr += c.toString()));
        proc.once("error", (err) => reject(new Error(`ffmpeg audio concat failed to start: ${err.message}`)));
        proc.once("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg audio concat exited ${code}: ${stderr.slice(-500)}`));
        });
      })
      .catch((err) => reject(new Error(`Failed to write concat list file: ${err.message}`)));
  });
}

// Inside a single-quoted FFmpeg filter argument, backslash is NOT an
// escape character in the intuitive sense, and the textbook "close quote,
// escaped literal quote, reopen quote" technique was previously verified
// (real ffmpeg render, when this pipeline still had per-beat drawtext) to
// corrupt every later quoted clause in the same filter_complex. Dropping
// the apostrophe outright is simpler and equally safe. `%` is deliberately
// NOT escaped - expansion=none disables drawtext's %{...} text_expansion
// entirely, so a raw `%` is always literal.
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "");
}

// The real signal timestamp (Supabase's own value, not the current
// wall-clock time) formatted for an unobtrusive corner stamp - a viewer
// has no other way to tell when a clip's data is from once all other
// on-screen text was removed. Returns null (no overlay at all) rather
// than a fabricated/placeholder date if the real timestamp is missing or
// unparseable.
function formatClipDate(isoTimestamp) {
  if (!isoTimestamp) return null;
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const datePart = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const timePart = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
  return `${datePart.toUpperCase()} · ${timePart}`;
}

function buildFilterComplex(keyframes, dateText, hookTitle) {
  // Per-keyframe branch, not a single time-varying crop: verified locally
  // (real ffmpeg 5.1.9 render, not assumed) that ffmpeg's crop filter only
  // evaluates its OWN OUTPUT w/h once at filter init - x/y can vary per
  // frame via between(t,...), but w/h stay frozen at whichever keyframe's
  // dimensions happened to evaluate first (keyframes[0], the rotator
  // crop). Every later keyframe with a *different* crop size (the chart
  // beat's CHART_CROP) silently got the rotator's frozen size instead of
  // its own - this is why the chart segment never showed real candles no
  // matter how correct its coordinates were: the crop filter itself
  // couldn't apply them. Fix: split the input into one branch per
  // keyframe, trim each to its own time window, crop/scale/pad each at
  // its own fixed size, then concat back into one continuous stream -
  // concat reconstructs continuous PTS across segments, so a single
  // downstream between(t,...) drawtext pass still works unmodified.
  const branchLabels = keyframes.map((_, i) => `seg${i}`);
  const splitStage = `split=${keyframes.length}${keyframes.map((_, i) => `[s${i}]`).join("")}`;
  // blur_fill background instead of solid black pad: whenever a crop's
  // aspect ratio doesn't match the 1080x1920 output (which is most of the
  // time - none of ROTATOR_CROP/INFO_CROP are 9:16), the remaining space
  // is filled with a blurred, edge-to-edge cover-scaled copy of that same
  // crop rather than flat black bars. Verified locally: variance sampled
  // off a real rendered frame confirmed the background region is smoothly
  // blurred (near-zero local variance) while the sharp foreground content
  // sits centered on top at full detail.
  const branchStages = keyframes.map((k, i) => {
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
  const concatStage = `${branchLabels.map((l) => `[${l}]`).join("")}concat=n=${keyframes.length}:v=1:a=0[vconcat0]`;

  // No per-beat on-screen captions - tried and reverted twice this project:
  // even after fixing every sync dimension found (dynamic per-beat timing,
  // caption/narration color match, caption/narration institution-name
  // match, audio/video concat drift), captions still didn't reliably match
  // the narration in production. The remaining gap is almost certainly
  // structural, not a code bug - ElevenLabs' TTS audio for each segment
  // very likely has its own internal lead-in silence before speech
  // actually starts, which a caption timed to the segment FILE's start
  // (not to word-level speech timestamps, which ElevenLabs doesn't expose
  // here) can't account for. Narration alone carries the same real
  // information reliably; the one exception kept is the small persistent
  // date stamp below, which has no per-beat timing to get wrong.
  // Bold, high-contrast hook title for the first 3 seconds only
  // (enable='lte(t,3)') - a static overlay with no per-beat timing to get
  // wrong, unlike the per-beat captions above that were tried and reverted
  // twice. box=1 draws an opaque black backing behind the text so it stays
  // legible regardless of what's under it (bright chart lines, light UI
  // panels, etc.), on top of the usual white-fill/black-border combo.
  const hookStage = hookTitle
    ? `[vconcat0]drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(hookTitle.text)}':expansion=none:` +
      `fontcolor=${hookTitle.color}:fontsize=64:borderw=4:bordercolor=black:` +
      `box=1:boxcolor=black@0.55:boxborderw=20:` +
      `x=(w-text_w)/2:y=140:enable='lte(t,3)'[vhook0]`
    : "[vconcat0]copy[vhook0]";

  const dateStage = dateText
    ? `[vhook0]drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(dateText)}':expansion=none:fontcolor=white@0.85:fontsize=26:borderw=2:bordercolor=black:x=w-text_w-24:y=h-text_h-40[vout]`
    : "[vhook0]copy[vout]";

  return [`[0:v]${splitStage}`, ...branchStages, concatStage, hookStage, dateStage].join(";\n");
}

// Reads the exact numbers/labels the dashboard itself has already computed
// and rendered - BTC price/change (market-board ticker), trend (chart
// header badge), DIRECTION (Market Sentiment's own classifyDirection()
// output, term-direction-value - present in the DOM even while that
// rotator slide is hidden, since ROTATION_SLIDES only toggles the `hidden`
// attribute, never removes the content), and `technical` (real EMA20/
// EMA50/VWAP/price/trend/volume for the active ticker, via
// window.__mktChartDebug()'s `technical` field - the same real indicator
// computation index.html's own chart already runs, just also handed back
// here instead of only drawn as pixels). This is a direct read of numbers
// already computed/on screen, not a new computation of our own.
async function readOnScreenEvidence(page) {
  return page.evaluate(() => ({
    btcPrice: document.getElementById("mb-price-BTC")?.textContent?.trim() || null,
    btcChange: document.getElementById("mb-change-BTC")?.textContent?.trim().replace(/[+%]/g, "") || null,
    trend: document.getElementById("trend-value")?.textContent?.trim() || null,
    volume: document.getElementById("volume-value")?.textContent?.trim() || null,
    direction: document.querySelector(".term-direction-value")?.textContent?.trim() || null,
    technical: window.__mktChartDebug?.()?.technical ?? null,
    // "What Matters Now" rows (TOP NARRATIVE / TOP SIGNAL / OVERALL BIAS) -
    // index.html's own renderWhatNow() already builds these purely from
    // the first real x_narratives/sentiment entries plus a deterministic
    // bias readout (see its comment: "deliberately NOT a new synthesized
    // insight"). Read directly off the DOM rather than recomputed here, so
    // narration can never diverge from what the panel actually shows.
    whatNowRows: Array.from(document.querySelectorAll("#whatnow-list li")).map((li) => ({
      label: li.querySelector(".term-row-label")?.textContent?.trim() || "",
      value: li.querySelector(".term-row-value")?.textContent?.trim() || "",
    })),
  }));
}

// Split into two phases (was one captureFrames() before) because the
// actual frame-capture timing now depends on real per-beat narration
// durations, which can only be known AFTER the real signal/evidence text
// has been read from this same page and synthesized - a chicken-and-egg
// order that means the browser has to stay open across that gap instead
// of closing right after reading evidence.
async function openCapturePage() {
  // Everything below page.goto (and goto itself) can throw - a slow/
  // degraded dashboard load hitting the 30s timeout, a Chromium render
  // error inside page.evaluate/readOnScreenEvidence, etc. Previously none
  // of that was caught here, so the caller's `browser`/`server` variables
  // (only assigned via destructuring AFTER this function returns) stayed
  // undefined on any such failure, and the finally block's cleanup never
  // ran - a real production leak: one Chromium process + local HTTP server
  // per failed page load, on a pipeline that runs continuously and can hit
  // this on any transient page-load hiccup. Catch and close whatever was
  // actually created before rethrowing, so the caller's cleanup is never
  // the only line of defense.
  let server;
  let browser;
  try {
    ({ server } = await startLocalServer(path.resolve(".")));
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const port = server.address().port;

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
    return { page, browser, server, evidence };
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      server.close();
    }
    throw err;
  }
}

// Captures the actual frame sequence once real per-beat timing (keyframes,
// from buildKeyframes) is known - forces the rotator to each beat's real
// category at its real start time (driven by that beat's own narration
// duration now, not a fixed offset), same mechanism as before.
async function captureFramesForKeyframes(page, frameDir, keyframes) {
  const durationS = keyframes[keyframes.length - 1].end;
  // Every beat in a themed clip shares one rotatorSlide (see buildKeyframes),
  // which may not be the page's default (slide 0) - unlike the old 4-beat
  // arc, this always needs a cue at t=0 too, not just for later beats.
  // Calling __mktRotatorGoTo repeatedly with the same slide is harmless.
  const pendingRotatorCues = keyframes
    .filter((k) => k.rotatorSlide !== null)
    .map((k) => ({ atSecond: k.start, slide: k.rotatorSlide }));

  const totalFrames = Math.round(durationS * CLIP_FPS);
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
}

function renderVideo(frameDir, outputPath, narrationPath, keyframes, dateText, hookTitle) {
  return new Promise((resolve, reject) => {
    const durationS = keyframes[keyframes.length - 1].end;
    // Real ElevenLabs narration when available, silent track otherwise -
    // never fails the render if TTS wasn't configured/errored. Since
    // keyframes' own timing is now built from these exact same real
    // narration segment durations (see buildKeyframes/synthesizeNarration-
    // Segments), audio and video length should already match; apad stays
    // as a safety margin against any tiny rounding gap between ffprobe's
    // measured duration and what ffmpeg actually encodes, rather than
    // -shortest, which would truncate the video if it were ever off in
    // the other direction.
    const audioInputArgs = narrationPath
      ? ["-i", narrationPath]
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
    const args = [
      "-y",
      "-framerate", String(CLIP_FPS),
      "-i", path.join(frameDir, "frame_%05d.jpg"),
      ...audioInputArgs,
      "-filter_complex", buildFilterComplex(keyframes, dateText, hookTitle),
      "-map", "[vout]", "-map", "1:a:0", "-af", "apad",
      // tune=stillimage + a lower CRF (higher quality/bitrate) for
      // graphics-first rendering - this content is flat-color dashboard
      // panels and text, not natural video, so x264's motion-focused psy
      // optimizations buy nothing here and stillimage tuning keeps edges/
      // text sharper instead. Verified locally that -tune stillimage is
      // accepted by this ffmpeg/libx264 build.
      "-c:v", "libx264", "-preset", "fast", "-tune", "stillimage", "-crf", "16", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-t", String(durationS),
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

// Generates up to 6 focused, single-topic short clips from the given
// normalized Grok signal (same shape stream_engine.js already writes to
// grok_data.json) - one per CLIP_TEMPLATES entry (institutional/ETF flow,
// macro pulse, technical indicators, narrative/catalyst, overall
// sentiment, what-matters-now) - and uploads each to YouTube as an
// unlisted Short for manual review. One Chromium/local-HTTP-server pair is
// opened once and reused across all six clips rather than relaunching per
// clip. A failure on one template is logged and skipped so it can't
// take down the others;
// never throws past this function's own logging either way - a failure
// here must not take down the caller (the main broadcast pipeline).
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

  let parentDir;
  let browser;
  let server;
  const watchUrls = [];
  try {
    if (!signal || typeof signal !== "object") {
      throw new Error("corrupted or missing signal input");
    }

    parentDir = await mkdtemp(path.join(tmpdir(), "clip-frames-"));

    const capture = await openCapturePage();
    ({ browser, server } = capture);
    const { page, evidence } = capture;

    for (const template of CLIP_TEMPLATES) {
      try {
        const frameDir = path.join(parentDir, template.id);
        await mkdir(frameDir, { recursive: true });

        // Real per-template signal bullets/technical evidence, close to
        // verbatim for the flow/macro/narrative/sentiment templates (see
        // buildFieldNarration's comment on why this differs from the old
        // zero-numbers narration policy), or real EMA/VWAP/price numbers
        // for the technical template (buildTechnicalNarration).
        const scripts = template.buildScripts(signal, evidence);
        const narrationSegments = await synthesizeNarrationSegments(scripts, frameDir);

        let narrationPath = null;
        let keyframes;
        if (narrationSegments) {
          keyframes = buildKeyframes(
            narrationSegments.map((s) => s.duration),
            template.crop,
            template.zoomCrop,
            template.rotatorSlide
          );
          narrationPath = path.join(frameDir, "narration.mp3");
          await concatAudioSegments(narrationSegments, narrationPath);
        } else {
          keyframes = buildKeyframes(
            DEFAULT_BEAT_DURATIONS_S.slice(0, scripts.length),
            template.crop,
            template.zoomCrop,
            template.rotatorSlide
          );
        }

        // Real per-beat narration duration now drives how long each beat's
        // visual crop actually stays on screen (via keyframes), so the
        // frame capture itself can't start until keyframes is known - this
        // is the second phase of the two-phase capture split (see
        // openCapturePage). The same open `page` is reused across every
        // template's capture pass.
        await captureFramesForKeyframes(page, frameDir, keyframes);

        const outputPath = path.join(frameDir, "clip.mp4");
        const dateText = formatClipDate(signal.timestamp);
        const hookTitle = buildHookTitle(template, scripts);
        await renderVideo(frameDir, outputPath, narrationPath, keyframes, dateText, hookTitle);
        console.log(`[RENDER COMPLETE] ${template.id}`);

        const videoBuffer = await readFile(outputPath);
        if (videoBuffer.length === 0) {
          throw new Error("rendered clip buffer is empty/corrupted");
        }

        console.log(`[UPLOADING TO YOUTUBE] ${template.id}`);
        // uploadShort/buildShortMetadata only need the plain text (for the
        // title/description) - the per-beat color is purely a video-render
        // concern, not relevant to the upload metadata.
        const watchUrl = await uploadShort(videoBuffer, { signal, overlayText: [template.label, ...scripts] });
        console.log(`[REVIEW URL GENERATED] ${template.id}: ${watchUrl}`);
        watchUrls.push(watchUrl);
      } catch (err) {
        console.error(`[CLIPPER] ${template.id} failed, skipping: ${err.message}`);
      }
    }

    await browser.close();
    browser = null;
    server.close();
    server = null;

    return watchUrls;
  } catch (err) {
    console.error(`[CLIPPER] Failed: ${err.message}`);
    return watchUrls.length ? watchUrls : null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      server.close();
    }
    if (parentDir && !process.env.CLIPPER_KEEP_FRAMES) {
      await rm(parentDir, { recursive: true, force: true }).catch(() => {});
    } else if (parentDir) {
      console.log(`[CLIPPER] CLIPPER_KEEP_FRAMES set - kept ${parentDir}`);
    }
    clipGenerationInFlight = false;
  }
}

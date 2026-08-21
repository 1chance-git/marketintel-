// ---------------------------------------------------------------------------
// Short-form vertical clip generator (Block 10)
//
// Renders a short (~12s) 1080x1920 vertical MP4 from the live dashboard,
// narrated by an ElevenLabs voiceover and captioned with bold sans-serif
// on-screen text, both built from the real Grok/Supabase signal that
// triggered it - never fabricated/placeholder marketing copy. The two
// channels complement rather than duplicate each other: captions show the
// exact real data (numbers included), narration provides context in
// active-verb sentences that deliberately never read those digits aloud.
// Runs as its own isolated Puppeteer + FFmpeg pipeline (separate local
// server instance, separate browser) so it never contends with or
// interferes with the main continuous RTMP broadcast in stream_engine.js.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
// live below (deriveNarrativeArc), never fixed/fabricated copy. Crop and
// rotator-slide assignment per beat is fixed; timing is not - each beat's
// on-screen window is now driven by that beat's own real narration
// duration (see buildKeyframes), so the clip's total length varies with
// how much there actually is to say, rather than a fixed 11s regardless of
// content.
const BEAT_CROPS = [ROTATOR_CROP, INFO_CROP, ROTATOR_CROP, ROTATOR_CROP];
const BEAT_ROTATOR_SLIDES = [0, null, 2, 3];
// Fallback timing only - used when narration isn't available/fails
// entirely (see synthesizeNarrationSegments's all-or-nothing behavior),
// so the clip still has a sensible default pace with no real audio driving
// it.
const DEFAULT_BEAT_DURATIONS_S = [2.7, 2.8, 2.7, 2.8];

// Builds the actual KEYFRAMES array for one clip from real per-beat
// durations (either each beat's real synthesized narration length, or the
// DEFAULT_BEAT_DURATIONS_S fallback) - replaces the old fixed-timing
// module-level constant now that timing is content-driven instead of
// hardcoded.
function buildKeyframes(beatDurations) {
  let t = 0;
  return beatDurations.map((duration, i) => {
    const start = t;
    t += duration;
    return { start, end: t, crop: BEAT_CROPS[i], rotatorSlide: BEAT_ROTATOR_SLIDES[i] };
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
const OVERLAY_MAX_CHARS = 36;
const OVERLAY_FONTSIZE = 42;
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
// inventing content. Kept separate from deriveLine (which additionally
// truncates/uppercases for the on-screen caption) so buildAnalystNarration
// below can read the same real detail text in full, natural sentences
// instead of a caption-truncated fragment.
function extractDetail(items, fallback) {
  const raw = Array.isArray(items) ? items.find((s) => typeof s === "string" && s.trim()) : null;
  if (!raw) return fallback;
  const idx = raw.indexOf(":");
  return (idx !== -1 && idx <= 40) ? raw.slice(idx + 1).trim() : raw.trim();
}

function deriveLine(items, fallback) {
  return truncateForOverlay(extractDetail(items, fallback));
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

// Sentiment clause appended to a real signal line - reuses the exact same
// BULLISH_WORDS/BEARISH_WORDS keyword match deriveColor already applies
// for on-screen color-coding, just spoken as an active verb phrase instead
// of a color. Restates a classification already made from the real text;
// adds no new inference on top of it, and stays silent (returns null)
// rather than guessing when neither keyword set matches. Deliberately
// doesn't claim trend history ("snapping a streak", "reclaiming a level")
// since this pipeline has no prior-period data to back that kind of claim -
// only the current signal's own real classification.
function sentimentClause(text) {
  if (BULLISH_WORDS.test(text)) return "reinforcing bullish positioning";
  if (BEARISH_WORDS.test(text)) return "pressuring sentiment";
  return null;
}

// Active verb phrase for the real % change and sign (evidence.btcChange) -
// a deterministic threshold on the exact number, not a guess. The word
// alone carries the magnitude; the digits themselves are never spoken
// (narration constraint: numbers stay on no screen at all now that the
// overlay is gone, so audio must convey magnitude qualitatively, not by
// reading the figure back).
function verbForChange(pct) {
  const abs = Math.abs(pct);
  const up = pct >= 0;
  if (abs >= 3) return up ? "surged" : "plunged";
  if (abs >= 1) return up ? "climbed" : "slipped";
  if (abs >= 0.3) return up ? "edged higher" : "eased lower";
  return "held steady";
}

// Removes numeric literals (currency amounts, percentages, ranges, plain
// numbers, and their attached units like "$385-390M" or "24h") from real
// free-text signal fields before they're spoken. Narration must never read
// a raw number aloud - only the real qualitative color the number sits
// inside. Only strips digit-bearing tokens; any other real wording in the
// same sentence ("led by GBTC redemptions") survives untouched, and
// nothing is invented to replace what's removed - occasional minor
// grammatical roughness (a dangling "over the last," where a number used
// to sit) is an accepted tradeoff for a rule that's simple, deterministic,
// and impossible to fabricate from, rather than running the real signal
// text through a rewriting model.
function stripNumbers(text) {
  return text
    .replace(/[$~]?\d[\d,.]*\s*-\s*[$~]?\d[\d,.]*\s*[%A-Za-z]*/g, "")
    .replace(/[$~]?\d[\d,.]*\s*[%A-Za-z]*/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .trim();
}

// Real, fixed real-world facts (which firm issues which spot-Bitcoin-ETF
// ticker) - same category as FONT_PATH or the ElevenLabs voice ID: used to
// interpret real signal text, never to invent a claim about market
// conditions. Lets narration name the actual institution moving money
// ("BlackRock", "Grayscale") instead of reading a bare fund ticker
// ("IBIT", "GBTC") a listener has no context for.
const ETF_TICKER_TO_ISSUER = {
  IBIT: "BlackRock",
  GBTC: "Grayscale",
  FBTC: "Fidelity",
  ARKB: "ARK Invest",
  BITB: "Bitwise",
  BRRR: "Valkyrie",
  EZBC: "Franklin Templeton",
  HODL: "VanEck",
  BTCO: "Invesco",
  BTCW: "WisdomTree",
};
// Known institution/desk names that might appear directly in real signal
// text (not just via a fund ticker) - matched case-insensitively.
const KNOWN_INSTITUTIONS = [
  "BlackRock", "Grayscale", "Fidelity", "ARK Invest", "Bitwise", "Valkyrie",
  "Franklin Templeton", "Invesco", "WisdomTree", "Jane Street", "Citadel",
  "Susquehanna", "Cantor Fitzgerald", "JPMorgan", "Goldman Sachs",
  "Jump Trading", "DRW", "Virtu",
];

// Extracts the real institution names actually present in a real signal
// line - either named directly, or via a well-known fund ticker mapped to
// its real issuer (ETF_TICKER_TO_ISSUER). Never invents a name that isn't
// actually in the text; returns [] if none match, so the caller falls back
// to generic phrasing rather than guessing who was involved.
function extractInstitutions(text) {
  const found = new Set();
  for (const name of KNOWN_INSTITUTIONS) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) found.add(name);
  }
  for (const [ticker, issuer] of Object.entries(ETF_TICKER_TO_ISSUER)) {
    if (new RegExp(`\\b${ticker}\\b`).test(text)) found.add(issuer);
  }
  return [...found];
}

function joinNames(names) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// Voiceover narration - one segment per KEYFRAMES beat (Hook/Detail/
// Context/Close, modeled on a scriptwriting template the user supplied),
// synthesized and timed separately per beat rather than one continuous
// pass, so each segment's real spoken duration can drive that beat's own
// on-screen window (see buildKeyframes) instead of narration and visuals
// only being loosely ordered the same way. Zero raw numbers are spoken -
// stripNumbers removes any digit-bearing content from the real free-text
// signal fields, and the price beat speaks verbForChange's word only, never
// the percentage itself. Every specific number/claim from either that
// template or an earlier reference script (a named firm's ETF holdings, a
// Fear & Greed index reading, EMA support levels, SOL/XRP flow direction,
// "snapped its streak"-style trend-history claims) is deliberately left
// out - this pipeline has no real, verifiable source for any of those, and
// copying them in would fabricate a one-time snapshot as permanent
// narration. Every fact spoken here is still either a deterministic
// function of (verbForChange's real sign/magnitude) or a direct
// restatement of (sentimentClause reuses deriveColor's own keyword
// classification; "mixed"/"neutral"/"low volume" phrasing restates the
// literal real value) something already in signal/evidence.
function buildAnalystNarrationSegments(signal, evidence) {
  const etfRaw = extractDetail(signal.etf_flows, "no notable ETF flow data available");
  const narrativeDetail = stripNumbers(extractDetail(signal.x_narratives, "no notable narrative shift reported"));

  // Beat 0 - Hook: WHO is actually moving money, not a bare fund ticker
  // or leftover filler text. extractInstitutions only ever returns names
  // it actually found in the real signal text (directly, or via a known
  // ticker->issuer mapping) - falls back to the old stripped-text phrasing
  // when no recognized institution is mentioned, rather than guessing one.
  const institutions = extractInstitutions(etfRaw);
  const etfClause = sentimentClause(etfRaw);
  const etfSegment = institutions.length
    ? `Institutional flows in focus: ${joinNames(institutions)} moving money in Bitcoin ETFs${etfClause ? `, ${etfClause}` : ""}.`
    : `Institutional flows in focus: ${stripNumbers(etfRaw)}${etfClause ? `, ${etfClause}` : ""}.`;

  // Beat 1 - Detail: the real price action, in active verbs, no digits.
  // Trend/volume are read from separate DOM elements than the price
  // ticker (see readOnScreenEvidence) and can be valid even when price
  // itself briefly isn't - gating the whole beat on btcPrice meant a
  // missing price alone silenced real trend/volume data that was actually
  // available. Each piece now speaks independently of the others.
  const trend = evidence.trend && evidence.trend !== "—" ? evidence.trend.toLowerCase() : null;
  const volume = evidence.volume && evidence.volume !== "—" ? evidence.volume.toLowerCase() : null;
  const hasPrice = evidence.btcPrice && evidence.btcPrice !== "DATA UNAVAILABLE";
  const changeNum = parseFloat(evidence.btcChange);
  const hasChange = hasPrice && Number.isFinite(changeNum);

  const priceParts = [];
  if (hasChange) {
    priceParts.push(`Bitcoin ${verbForChange(changeNum)}${trend ? `, trend reading ${trend}` : ""}.`);
  } else if (trend) {
    priceParts.push(`Bitcoin's trend is reading ${trend}.`);
  } else {
    priceParts.push("No clear price trend to report on Bitcoin right now.");
  }
  if (volume === "low") {
    priceParts.push("Volume is thin, so this move still lacks conviction.");
  } else if (volume) {
    priceParts.push(`Volume is running ${volume}, adding weight behind the move.`);
  }
  const priceSegment = priceParts.join(" ");

  // Beat 2 - Context: what's shaping the broader narrative.
  const narrativeClause = sentimentClause(narrativeDetail);
  const narrativeSegment = `On the narrative side, ${narrativeDetail}${narrativeClause ? `, ${narrativeClause}` : ""}.`;

  // Beat 3 - Close: the takeaway.
  let directionSegment = "Overall sentiment is still forming, with no clear directional read yet.";
  if (evidence.direction) {
    const dir = evidence.direction.toLowerCase();
    directionSegment = `Bottom line, sentiment reads ${dir}`;
    if (dir.includes("mixed")) directionSegment += " — stay cautious until a clearer signal emerges";
    else if (dir.includes("bullish")) directionSegment += ", favoring further upside";
    else if (dir.includes("bearish")) directionSegment += ", favoring further downside";
    directionSegment += ".";
  }

  return [etfSegment, priceSegment, narrativeSegment, directionSegment];
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

function concatAudioSegments(segments, outputPath) {
  return new Promise((resolve, reject) => {
    const inputArgs = segments.flatMap((s) => ["-i", s.path]);
    const filter = `${segments.map((_, i) => `[${i}:a]`).join("")}concat=n=${segments.length}:v=0:a=1[aout]`;
    const args = ["-y", ...inputArgs, "-filter_complex", filter, "-map", "[aout]", outputPath];
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.once("error", (err) => reject(new Error(`ffmpeg audio concat failed to start: ${err.message}`)));
    proc.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg audio concat exited ${code}: ${stderr.slice(-500)}`));
    });
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

function buildFilterComplex(keyframes, arc, dateText) {
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

  // Bold sans-serif on-screen captions, back after a brief narration-only
  // period - the exact real data (numbers included) stays visible on
  // screen even though the narration deliberately never reads those digits
  // aloud (see stripNumbers/verbForChange), so the two channels complement
  // rather than duplicate each other. Timed to keyframes' own real
  // start/end - now driven by each beat's actual narration duration - so
  // the caption for a beat is on screen for exactly as long as that beat's
  // crop is, same guarantee as the audio sync.
  const captionStages = arc.map((beat, i) => {
    const k = keyframes[i];
    const text = escapeDrawtext(beat.text);
    // alpha ramps 0->1 over the first OVERLAY_FADE_S of each beat's own
    // window (verified previously via real ffmpeg render: brightness ramps
    // smoothly then holds) so text fades in at scene entrance rather than
    // hard-cutting in; enable='between(t,...)' still gates visibility to
    // exactly the beat's own start/end.
    const alphaExpr = `if(lt(t-${k.start},${OVERLAY_FADE_S}),(t-${k.start})/${OVERLAY_FADE_S},1)`;
    const inLabel = i === 0 ? "vconcat0" : `vcap${i - 1}`;
    const outLabel = `vcap${i}`;
    return `[${inLabel}]drawtext=fontfile=${FONT_PATH}:text='${text}':expansion=none:fontcolor=${beat.color}:fontsize=${OVERLAY_FONTSIZE}:borderw=3:bordercolor=black:x=(w-text_w)/2:y=120:alpha='${alphaExpr}':enable='between(t,${k.start},${k.end})'[${outLabel}]`;
  });
  const lastCaptionLabel = captionStages.length ? `vcap${captionStages.length - 1}` : "vconcat0";

  // Small persistent date stamp (the real signal timestamp, never
  // fabricated/current-time) shown for the whole clip, layered on top of
  // the per-beat captions.
  const dateStage = dateText
    ? `[${lastCaptionLabel}]drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(dateText)}':expansion=none:fontcolor=white@0.85:fontsize=26:borderw=2:bordercolor=black:x=w-text_w-24:y=h-text_h-40[vout]`
    : `[${lastCaptionLabel}]copy[vout]`;

  return [`[0:v]${splitStage}`, ...branchStages, concatStage, ...captionStages, dateStage].join(";\n");
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
    volume: document.getElementById("volume-value")?.textContent?.trim() || null,
    direction: document.querySelector(".term-direction-value")?.textContent?.trim() || null,
  }));
}

// Split into two phases (was one captureFrames() before) because the
// actual frame-capture timing now depends on real per-beat narration
// durations, which can only be known AFTER the real signal/evidence text
// has been read from this same page and synthesized - a chicken-and-egg
// order that means the browser has to stay open across that gap instead
// of closing right after reading evidence.
async function openCapturePage() {
  const { server, port } = await startLocalServer(path.resolve("."));
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

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
}

// Captures the actual frame sequence once real per-beat timing (keyframes,
// from buildKeyframes) is known - forces the rotator to each beat's real
// category at its real start time (driven by that beat's own narration
// duration now, not a fixed offset), same mechanism as before.
async function captureFramesForKeyframes(page, frameDir, keyframes) {
  const durationS = keyframes[keyframes.length - 1].end;
  // showRotatorSlide(0) already runs on page load, matching keyframes[0]'s
  // rotatorSlide - only need to force it for the later keyframes.
  const pendingRotatorCues = keyframes
    .filter((k) => k.rotatorSlide !== null && k.start > 0)
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

function renderVideo(frameDir, outputPath, narrationPath, keyframes, arc, dateText) {
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
      "-filter_complex", buildFilterComplex(keyframes, arc, dateText),
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
  let browser;
  let server;
  try {
    if (!signal || typeof signal !== "object") {
      throw new Error("corrupted or missing signal input");
    }

    frameDir = await mkdtemp(path.join(tmpdir(), "clip-frames-"));

    const capture = await openCapturePage();
    ({ browser, server } = capture);
    const { page, evidence } = capture;

    const arc = deriveNarrativeArc(signal, evidence);

    // Voiceover reads the same real signal/evidence as the on-screen data
    // (now removed - see buildFilterComplex), phrased as analyst-report
    // sentences with zero raw numbers spoken (buildAnalystNarrationSegments).
    // Best effort: a TTS failure/missing API key must not block the rest of
    // the clip - synthesizeNarrationSegments returns null on any failure,
    // and DEFAULT_BEAT_DURATIONS_S covers timing so the visual pipeline
    // still works with no narration at all.
    const scripts = buildAnalystNarrationSegments(signal, evidence);
    const narrationSegments = await synthesizeNarrationSegments(scripts, frameDir);

    let narrationPath = null;
    let keyframes;
    if (narrationSegments) {
      keyframes = buildKeyframes(narrationSegments.map((s) => s.duration));
      narrationPath = path.join(frameDir, "narration.mp3");
      await concatAudioSegments(narrationSegments, narrationPath);
    } else {
      keyframes = buildKeyframes(DEFAULT_BEAT_DURATIONS_S);
    }

    // Real per-beat narration duration now drives how long each beat's
    // visual crop actually stays on screen (via keyframes), so the frame
    // capture itself can't start until keyframes is known - this is the
    // second phase of the two-phase capture split (see openCapturePage).
    await captureFramesForKeyframes(page, frameDir, keyframes);
    await browser.close();
    browser = null;
    server.close();
    server = null;

    const outputPath = path.join(frameDir, "clip.mp4");
    const dateText = formatClipDate(signal.timestamp);
    await renderVideo(frameDir, outputPath, narrationPath, keyframes, arc, dateText);
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
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      server.close();
    }
    if (frameDir) {
      await rm(frameDir, { recursive: true, force: true }).catch(() => {});
    }
    clipGenerationInFlight = false;
  }
}

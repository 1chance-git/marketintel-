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

// A 20% tighter, re-centered version of the same real crop region -
// alternated in every other beat (see buildKeyframes) as a cheap "pattern
// interrupt": the visual framing punches in on a beat change so the shot
// isn't perfectly static for the whole clip, without any new capture/
// timing machinery (same DOM pixels, same evidence, just a different
// centered crop of them). Punch amount raised from an 8% shrink to 20%
// per direct feedback wanting a noticeably tighter/more magnified zoom
// than the earlier subtle version - center point is still preserved
// algebraically from ROTATOR_CROP/INFO_CROP's own real x/y/w/h
// (new_w = w*0.8, new_x = x + w*0.1, etc.), not a separately eyeballed
// region. Matches the shrink factor rectToCropFilterZoom now applies to
// the real per-beat measured rect below.
const ROTATOR_CROP_ZOOM = "w='iw*0.256':h='ih*0.40':x='iw*0.712':y='ih*0.167'";
const INFO_CROP_ZOOM = "w='iw*0.11064':h='ih*0.0728':x='iw*0.01383':y='ih*0.2098'";

// Real user feedback on a produced clip: "Panel is too text-heavy" /
// "Visual doesn't match what's narrated". Root cause: the rotator panel
// can render up to MAX_ROWS_PER_SECTION (4) real bullets per slide (see
// index.html's renderRows/renderMacroPulse/renderSentimentBlock), but
// narration below only ever speaks the FIRST real bullet (extractDetail) -
// so the static ROTATOR_CROP was showing 2-4x more text than was ever
// spoken.
// A fixed fraction can't fix this correctly since real bullet text length
// varies signal to signal (same reasoning as ROTATOR_CROP/INFO_CROP's own
// "measure real rects, don't guess" derivation above). Instead,
// __mktRotatorTightRect() (index.html) measures the real union bbox of
// just the header + (DIRECTION row if present) + the FIRST content row -
// i.e. exactly what gets narrated - fresh at each beat's capture time, and
// this converts that rect into the same iw*/ih* crop-filter string shape
// used everywhere else in this file. A small fixed padding margin (in
// real source px, not a fraction) keeps the crop from clipping text
// descenders/anti-aliased edges right at the measured bbox.
const TIGHT_CROP_PAD_PX = 10;
function rectToCropFilter(rect) {
  const x = Math.max(0, rect.x - TIGHT_CROP_PAD_PX);
  const y = Math.max(0, rect.y - TIGHT_CROP_PAD_PX);
  // Floored at 1px - a real production crash traced to this: a rect near
  // the source frame's right/bottom edge could make SOURCE_WIDTH-x (or
  // -y) collapse toward 0, and ffmpeg's encoder init hard-fails on a
  // crop with an effectively-zero dimension ("incorrect parameters such
  // as width or height"), killing the whole clip. This is a second,
  // independent guard from the caller's minimum-rect-size check (that one
  // rejects a degenerate MEASURED rect; this one protects against the
  // edge-clamping math itself producing a degenerate crop even from a
  // real, reasonably-sized rect).
  const w = Math.max(1, Math.min(SOURCE_WIDTH - x, rect.width + TIGHT_CROP_PAD_PX * 2));
  const h = Math.max(1, Math.min(SOURCE_HEIGHT - y, rect.height + TIGHT_CROP_PAD_PX * 2));
  return `w='iw*${(w / SOURCE_WIDTH).toFixed(6)}':h='ih*${(h / SOURCE_HEIGHT).toFixed(6)}':` +
    `x='iw*${(x / SOURCE_WIDTH).toFixed(6)}':y='ih*${(y / SOURCE_HEIGHT).toFixed(6)}'`;
}
// Same 20% tighter/recentered algebra used to derive ROTATOR_CROP_ZOOM from
// ROTATOR_CROP, applied to the real measured rect instead of the static one.
function rectToCropFilterZoom(rect) {
  const shrink = 0.8;
  const zw = rect.width * shrink;
  const zh = rect.height * shrink;
  const zx = rect.x + (rect.width - zw) / 2;
  const zy = rect.y + (rect.height - zh) / 2;
  return rectToCropFilter({ x: zx, y: zy, width: zw, height: zh });
}

// Fallback timing only - used when narration isn't available/fails
// entirely (see synthesizeNarrationSegments's all-or-nothing behavior).
// Each beat's own real pace stays tight/brisk (no beat is individually
// stretched out); applyMinClipDuration below is what brings the clip's
// TOTAL length up to the real ~30s benchmark, as extra hold time on the
// closing beat only - not by slowing down beats 0-2.
const DEFAULT_BEAT_DURATIONS_S = [2.7, 2.8, 2.7, 2.8];

// A FLOOR, not a target to hit exactly and not a ceiling to truncate down
// to - real narration should run however long it actually takes. This
// only ever pads UP when real content came out short, added as extra
// hold time on the LAST beat only (silence there is filled by
// renderVideo's existing apad) - a natural pause on the closing beat, not
// mid-clip dead air. Removed entirely once for "make the video edit
// tighter", then reinstated at 30s per direct confirmation that ~30s is
// the actual real-world benchmark length - "tighter" turned out to mean
// the crop/zoom framing (see ROTATOR_CROP_ZOOM's 20% punch-in above), not
// a shorter overall runtime.
const MIN_CLIP_DURATION_S = 30;
function applyMinClipDuration(beatDurations) {
  const total = beatDurations.reduce((sum, d) => sum + d, 0);
  if (total >= MIN_CLIP_DURATION_S) return beatDurations;
  const out = [...beatDurations];
  out[out.length - 1] += MIN_CLIP_DURATION_S - total;
  return out;
}

// Builds the KEYFRAMES array for one clip from real per-beat narration
// durations (or the DEFAULT_BEAT_DURATIONS_S fallback) and each beat's own
// fixed crop/rotator-slide (ARC_META, one entry per beat - see below).
// Alternates each beat between its normal crop and its punched-in zoom
// variant for a bit of visual movement, on top of the hard cut between
// the arc's real beats.
function buildKeyframes(beatDurations, beatMeta) {
  let t = 0;
  return beatDurations.map((duration, i) => {
    const start = t;
    t += duration;
    const meta = beatMeta[i] ?? beatMeta[beatMeta.length - 1];
    return { start, end: t, crop: i % 2 === 0 ? meta.crop : meta.zoomCrop, rotatorSlide: meta.rotatorSlide };
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

// On-screen hook title cap (fontsize 64, first 3 seconds only - see
// buildFilterComplex) - tighter than a normal caption width since this
// renders much larger, scaled from the bbox-verified fontsize-42/~40-char
// and fontsize-58/~30-char fit points down to ~24 chars with margin.
const HOOK_MAX_CHARS = 24;
function truncateForHook(text) {
  const upper = text.toUpperCase();
  if (upper.length <= HOOK_MAX_CHARS) return upper;
  const cut = upper.slice(0, HOOK_MAX_CHARS - 3);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > HOOK_MAX_CHARS * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${base}...`;
}

// Removes numeric literals (currency amounts, percentages, ranges, plain
// numbers, and their attached units like "$385-390M" or "24h") from real
// free-text signal fields before they're spoken. Narration must never read
// a raw number aloud - only the real qualitative color the number sits
// inside. This briefly changed (a themed clip spoke real dollar figures
// verbatim, e.g. "$517M+ BTC ETF inflows") but was reverted - numbers stay
// off narration across every clip that reads raw signal text; the real
// figures are still visible on screen in the captured panel itself, just
// not spoken. Only strips digit-bearing tokens; any other real wording in
// the same sentence ("led by GBTC redemptions") survives untouched, and
// nothing is invented to replace what's removed.
function stripNumbers(text) {
  return text
    .replace(/[$~]?\d[\d,.]*\s*-\s*[$~]?\d[\d,.]*\s*[%A-Za-z]*/g, "")
    .replace(/[$~]?\d[\d,.]*\s*[%A-Za-z]*/g, "")
    // Orphaned +/~ signs left dangling once the number after them is gone
    // (e.g. "+$517M (largest..." -> "+ (largest..." after the above) - the
    // bare sign reads as a typo to a TTS voice, not a real word. Became
    // more visible once buildPartLine started joining 2 real bullets per
    // part instead of 1 (more lines that individually start with a
    // number, e.g. two "+$...M" ETF-flow bullets in a row).
    .replace(/(^|\s)[+~](?=\s|$|\))/g, "$1")
    // Now-empty parenthetical remnants (e.g. "( )") left behind once
    // everything inside was numeric.
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .trim()
    // A bullet whose entire pre-parenthetical content was numeric leaves
    // just "(Fear)"/"(High)" standing alone as an orphaned parenthetical
    // fragment - not a real sentence. Unwrapping a leftover that's
    // ENTIRELY one parenthetical (nothing outside it) restores it to
    // plain real text ("Fear") instead of a dangling fragment.
    .replace(/^\(([^()]*)\)$/, "$1");
}

// Real, fixed real-world facts (which firm issues which spot-Bitcoin-ETF
// ticker) - same category as FONT_PATH or the ElevenLabs voice ID: used to
// interpret real signal text, never to invent a claim about market
// conditions. Lets narration name the actual institution moving money
// ("BlackRock", "Fidelity") instead of reading a bare fund ticker ("IBIT",
// "FBTC") a listener has no context for - this is the single biggest
// difference between this narration and a flat data readout, and was the
// specific thing a real transcribed benchmark clip's narration was
// praised for ("BlackRock and Fidelity are moving money to the Bitcoin
// ETF").
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

// Sentiment clause appended to a real signal line - reuses the exact same
// BULLISH_WORDS/BEARISH_WORDS keyword match used elsewhere, just spoken as
// an active verb phrase. Restates a classification already made from the
// real text; adds no new inference on top of it, and stays silent (returns
// null) rather than guessing when neither keyword set matches.
function sentimentClause(text) {
  const sentiment = classifySentiment(text);
  if (sentiment === "bullish") return "reinforcing bullish positioning";
  if (sentiment === "bearish") return "pressuring sentiment";
  return null;
}

// The first real bullet's detail text (after any "LABEL:" prefix), or a
// fixed honest fallback when the field is genuinely empty - unlike the
// combined-clip design this replaces, every beat here always has SOME
// text (never dropped), matching the blueprint's original 4-beat arc
// where every beat is always present.
function extractDetail(items, fallback) {
  const real = Array.isArray(items) ? items.find((s) => typeof s === "string" && s.trim()) : null;
  if (!real) return fallback;
  const idx = real.indexOf(":");
  return (idx !== -1 && idx <= 40) ? real.slice(idx + 1).trim() : real.trim();
}

// The original single-clip 4-beat arc (ETF/institutional flow -> technical
// read -> narrative shift -> bottom-line sentiment), restored per direct
// request ("revert back to the one clip... the blueprint... started off
// with etf flows") after this session tried splitting into 2-3 combined
// multi-topic clips. rotatorSlide indices match index.html's own rotator
// order (etf=0, macro=1, narrative=2, sentiment=3, whatnow=4); technical
// has no rotator slide of its own - it's the TREND/VOLUME info panel.
const ARC_META = [
  { crop: ROTATOR_CROP, zoomCrop: ROTATOR_CROP_ZOOM, rotatorSlide: 0 },
  { crop: INFO_CROP, zoomCrop: INFO_CROP_ZOOM, rotatorSlide: null },
  { crop: ROTATOR_CROP, zoomCrop: ROTATOR_CROP_ZOOM, rotatorSlide: 2 },
  { crop: ROTATOR_CROP, zoomCrop: ROTATOR_CROP_ZOOM, rotatorSlide: 3 },
];

// Analyst-report narration for the single 4-beat arc above. Zero raw
// numbers are spoken - stripNumbers removes any digit-bearing content from
// the real free-text signal fields, and the technical beat speaks
// trend/volume words only, never the price figure itself (the price stays
// visible on screen in the captured INFO_CROP panel). Every fact spoken
// here is either a direct restatement of real signal/evidence text or a
// deterministic function of it (sentimentClause reuses classifySentiment's
// own keyword match; extractInstitutions only ever names an institution
// actually present in the real text) - nothing is invented.
function buildAnalystNarrationSegments(signal, evidence) {
  // Beat 0 - ETF/institutional flow: WHO is actually moving money, not a
  // bare fund ticker or leftover filler text.
  const etfRaw = extractDetail(signal.etf_flows, "no notable ETF flow data available");
  const etfInstitutions = extractInstitutions(etfRaw);
  const etfClause = sentimentClause(etfRaw);
  const etfSegment = etfInstitutions.length
    ? `Institutional flows in focus: ${joinNames(etfInstitutions)} moving money in Bitcoin ETFs${etfClause ? `, ${etfClause}` : ""}.`
    : `Institutional flows in focus: ${stripNumbers(etfRaw)}${etfClause ? `, ${etfClause}` : ""}.`;

  // Beat 1 - Technical read: real trend + volume from evidence.technical
  // (fresh EMA20/EMA50/VWAP/price/trend/volume computed by the chart's own
  // __mktChartDebug hook - see readOnScreenEvidence). Each piece speaks
  // independently so a missing one doesn't silence the other.
  const t = evidence.technical;
  const trend = t?.trend ? t.trend.toLowerCase() : null;
  const volume = t?.volume ? t.volume.toLowerCase() : null;
  const priceParts = [];
  if (trend) {
    priceParts.push(`${t.ticker || "Bitcoin"}'s trend is reading ${trend}.`);
  } else {
    priceParts.push("No clear price trend to report right now.");
  }
  if (volume === "low") {
    priceParts.push("Volume is thin, so this move still lacks conviction.");
  } else if (volume) {
    priceParts.push(`Volume is running ${volume}, adding weight behind the move.`);
  }
  const technicalSegment = priceParts.join(" ");

  // Beat 2 - Narrative: what's shaping the broader story. Same
  // extractInstitutions treatment as the ETF beat above.
  const narrativeRaw = stripNumbers(extractDetail(signal.x_narratives, "no notable narrative shift reported"));
  const narrativeInstitutions = extractInstitutions(narrativeRaw);
  const narrativeClause = sentimentClause(narrativeRaw);
  const narrativeSegment = narrativeInstitutions.length
    ? `On the narrative side, ${joinNames(narrativeInstitutions)} in focus${narrativeClause ? `, ${narrativeClause}` : ""}.`
    : `On the narrative side, ${narrativeRaw}${narrativeClause ? `, ${narrativeClause}` : ""}.`;

  // Beat 3 - Close: the bottom-line takeaway, from the sentiment panel's
  // own real DIRECTION classification (evidence.direction, read directly
  // off index.html's .term-direction-value - the same 4-state
  // classifyDirection() result already shown on screen), not a separate
  // synthesized verdict.
  let directionSegment = "Overall sentiment is still forming, with no clear directional read yet.";
  if (evidence.direction) {
    const dir = evidence.direction.toLowerCase();
    directionSegment = `Bottom line, sentiment reads ${dir}`;
    if (dir.includes("mixed")) directionSegment += " — stay cautious until a clearer signal emerges";
    else if (dir.includes("bullish")) directionSegment += ", favoring further upside";
    else if (dir.includes("bearish")) directionSegment += ", favoring further downside";
    directionSegment += ".";
  }

  return [etfSegment, technicalSegment, narrativeSegment, directionSegment];
}

// Bold hook title for the clip's opening 3 seconds - prefers the
// narrative beat (usually the punchiest, most specific line) then the ETF
// beat, falling back to a fixed product-name label only when every real
// beat came back as its own no-data fallback text, colored by the real
// sentiment of what that beat actually says.
const ARC_FALLBACK_MARKERS = ["no notable ETF flow data available", "no notable narrative shift reported"];
function buildHookTitle(scripts) {
  const [etfSegment, , narrativeSegment] = scripts;
  const candidates = [narrativeSegment, etfSegment];
  const real = candidates.find((s) => s && !ARC_FALLBACK_MARKERS.some((marker) => s.includes(marker)));
  if (real) return { text: truncateForHook(real), color: deriveColor(real) };
  return { text: "MARKET INTELLIGENCE NETWORK".slice(0, HOOK_MAX_CHARS), color: "#FFFFFF" };
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
        // speed: 1.0 is ElevenLabs' default/natural pace; 1.15 is a
        // modest bump for a brisker delivery, within their documented
        // 0.7-1.2 range for this model - not verifiable from this
        // sandbox (ElevenLabs is network-blocked here), so confirm the
        // pace actually sounds right on the next real production clip.
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.15 },
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
    return (
      `[s${i}]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS,` +
      `crop=${k.crop}:exact=1,split=2[c${i}fg][c${i}bg];` +
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
// and rendered - `technical` (real EMA20/EMA50/VWAP/price/trend/volume for
// the active ticker, via window.__mktChartDebug()'s `technical` field - the
// same real indicator computation index.html's own chart already runs,
// just also handed back here instead of only drawn as pixels) and the real
// sentiment DIRECTION classification below. This is a direct read of
// values already computed/on screen, not a new computation of our own.
async function readOnScreenEvidence(page) {
  return page.evaluate(() => ({
    technical: window.__mktChartDebug?.()?.technical ?? null,
    // The sentiment slide's own real DIRECTION classification (index.
    // html's classifyDirection(), rendered as a .term-direction-value
    // span at the top of the sentiment rotator slide) - a direct read of
    // a value already computed/shown on screen, not a new synthesis of
    // our own, so the closing narration beat can never diverge from what
    // the captured frame actually displays.
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
  const totalFrames = Math.round(durationS * CLIP_FPS);
  // index.html's own rotator keeps auto-advancing on its independent
  // 10s setInterval the whole time this page is open (see
  // ROTATION_INTERVAL_MS) - it doesn't know or care that we're forcing a
  // specific slide for capture. A one-time cue per beat boundary (the
  // original approach) could get silently clobbered by that timer firing
  // moments later, and by real wall-clock time this function starts
  // (page load + up to ~8s waiting for candle data + narration attempts),
  // the auto-rotation is often already close to its own 10s mark -
  // confirmed locally: a real render showed the SAME slide for an entire
  // 2-beat clip because the forced slide-0 cue lost a race with the
  // timer. Reasserting the current beat's real rotatorSlide corrects any
  // such override. Doing that on EVERY captured frame (the first fix)
  // turned out to add real overhead in production - each reassertion is a
  // page.evaluate() CDP round-trip, and a 15s clip at 30fps is up to 450
  // of them, which measurably slowed real capture well past its nominal
  // duration. Reasserting once per beat change plus roughly twice a
  // second (every 15 frames) instead still self-corrects within half a
  // second of any timer override - far faster than the 10s window that
  // caused the original bug - at a fraction of the per-frame cost.
  let lastForcedSlide = null;
  // Tracks which keyframe index has already had its crop replaced with a
  // real dynamic measurement, so that's done once per beat (right after
  // forcing its slide into view) rather than every captured frame - same
  // per-frame-cost reasoning as the rotator-slide reassertion above.
  let lastMeasuredBeatIndex = null;
  for (let i = 0; i < totalFrames; i++) {
    const elapsedS = i / CLIP_FPS;
    const beatIndex = keyframes.findIndex((k) => elapsedS >= k.start && elapsedS < k.end);
    const beat = beatIndex !== -1 ? keyframes[beatIndex] : keyframes[keyframes.length - 1];
    if (beat.rotatorSlide !== null && (beat.rotatorSlide !== lastForcedSlide || i % 15 === 0)) {
      await page.evaluate((slide) => window.__mktRotatorGoTo?.(slide), beat.rotatorSlide);
      lastForcedSlide = beat.rotatorSlide;
    }
    if (beat.rotatorSlide !== null && beatIndex !== -1 && beatIndex !== lastMeasuredBeatIndex) {
      const rect = await page.evaluate(() => window.__mktRotatorTightRect?.() ?? null);
      // A real production crash traced to this: __mktRotatorTightRect()
      // can catch the slide mid-transition (e.g. right after the forced
      // rotatorSlide reassertion above, before the new row has actually
      // laid out) and return a real but degenerate rect - near-zero width
      // or height. That's still truthy, so it used to pass straight
      // through into rectToCropFilter(Zoom), producing a crop fraction so
      // thin ffmpeg's scale/encoder init failed outright ("Error while
      // opening encoder... incorrect parameters such as width or
      // height"), killing the whole clip. A sane minimum size (in real
      // source px, well below any real header+row content) rejects those
      // and falls back to the static crop for that beat instead - same
      // "no measurement is better than a broken one" contract as the
      // null case already handled below.
      const MIN_TIGHT_RECT_PX = 30;
      if (rect && rect.width >= MIN_TIGHT_RECT_PX && rect.height >= MIN_TIGHT_RECT_PX) {
        beat.crop = beatIndex % 2 === 0 ? rectToCropFilter(rect) : rectToCropFilterZoom(rect);
      }
      lastMeasuredBeatIndex = beatIndex;
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

// Generates ONE short clip from the given normalized Grok signal (same
// shape stream_engine.js already writes to grok_data.json) - a single
// 4-beat narrative arc (ETF/institutional flow -> technical read ->
// narrative shift -> bottom-line sentiment, see ARC_META/
// buildAnalystNarrationSegments) - and uploads it to YouTube as an
// unlisted Short for manual review. Reverted from an earlier 2-3 combined-
// clip design back to this single-clip blueprint per direct request.
// Never throws past this function's own logging - a failure here must not
// take down the caller (the main broadcast pipeline).
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

    const scripts = buildAnalystNarrationSegments(signal, evidence);
    console.log(`[CLIPPER] script:\n${scripts.map((s, i) => `  [${i}] ${s}`).join("\n")}`);
    const narrationSegments = await synthesizeNarrationSegments(scripts, frameDir);

    let narrationPath = null;
    let keyframes;
    if (narrationSegments) {
      keyframes = buildKeyframes(applyMinClipDuration(narrationSegments.map((s) => s.duration)), ARC_META);
      narrationPath = path.join(frameDir, "narration.mp3");
      await concatAudioSegments(narrationSegments, narrationPath);
    } else {
      keyframes = buildKeyframes(applyMinClipDuration(DEFAULT_BEAT_DURATIONS_S), ARC_META);
    }

    // Real per-beat narration duration now drives how long each beat's
    // visual crop actually stays on screen (via keyframes), so the frame
    // capture itself can't start until keyframes is known - this is the
    // second phase of the two-phase capture split (see openCapturePage).
    await captureFramesForKeyframes(page, frameDir, keyframes);

    const outputPath = path.join(frameDir, "clip.mp4");
    const dateText = formatClipDate(signal.timestamp);
    const hookTitle = buildHookTitle(scripts);
    await renderVideo(frameDir, outputPath, narrationPath, keyframes, dateText, hookTitle);
    console.log("[RENDER COMPLETE]");

    const videoBuffer = await readFile(outputPath);
    if (videoBuffer.length === 0) {
      throw new Error("rendered clip buffer is empty/corrupted");
    }

    console.log("[UPLOADING TO YOUTUBE]");
    const watchUrl = await uploadShort(videoBuffer, { signal, overlayText: scripts });
    console.log(`[REVIEW URL GENERATED] ${watchUrl}`);

    await browser.close();
    browser = null;
    server.close();
    server = null;

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
    if (frameDir && !process.env.CLIPPER_KEEP_FRAMES) {
      await rm(frameDir, { recursive: true, force: true }).catch(() => {});
    } else if (frameDir) {
      console.log(`[CLIPPER] CLIPPER_KEEP_FRAMES set - kept ${frameDir}`);
    }
    clipGenerationInFlight = false;
  }
}

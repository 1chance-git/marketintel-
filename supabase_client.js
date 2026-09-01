import { createClient } from "@supabase/supabase-js";

// anon/publishable key — public by design (RLS on grok_signals restricts it
// to read-only SELECT access), safe to keep in version control.
export const SUPABASE_URL = "https://zzscfmnqgccuwcfpicob.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6c2NmbW5xZ2NjdXdjZnBpY29iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MDI1MTMsImV4cCI6MjEwMDE3ODUxM30.ahbBjwtB_g08FyiFFndSz7uWUqZnNdO7m59BzsyyiAM";

let supabase = null;

function getClient() {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabase;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

// Trump signal is informational only (see GROK_SIGNAL_SCHEMA.json) - never
// a trading/position signal. Validates/sanitizes the raw JSONB value from
// Supabase defensively: a malformed or partial value (wrong types, an
// unrecognized enum value, a missing required field) is never thrown on
// and never passed through as-is - it's either coerced to a safe default
// per-field or the whole thing collapses to `null` (statement/timestamp
// are the only fields without a safe default, since a Trump signal with
// no actual statement or time isn't a usable signal at all).
const TRUMP_DIRECTIONS = new Set(["BULLISH", "BEARISH", "MIXED", "UNKNOWN"]);
const TRUMP_SIGNIFICANCE = new Set(["HIGH", "MEDIUM", "LOW"]);
export function normalizeTrumpSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { source, timestamp, statement, topic, market_impact, affected_assets, direction, significance, new_information, evidence } = value;

  if (typeof statement !== "string" || !statement.trim()) return null;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) return null;

  return {
    source: typeof source === "string" && source.trim() ? source : "Trump",
    timestamp,
    statement,
    topic: typeof topic === "string" ? topic : null,
    market_impact: typeof market_impact === "string" ? market_impact : null,
    affected_assets: Array.isArray(affected_assets) ? affected_assets.filter((a) => typeof a === "string") : [],
    direction: TRUMP_DIRECTIONS.has(direction) ? direction : "UNKNOWN",
    significance: TRUMP_SIGNIFICANCE.has(significance) ? significance : "LOW",
    new_information: typeof new_information === "boolean" ? new_information : false,
    evidence: typeof evidence === "string" ? evidence : null,
  };
}

// Pure merge logic, extracted out of fetchLatestGrokSignal() so it's
// testable without a real Supabase round-trip - behavior is unchanged for
// every existing field; this only adds a third, independent "slot" for
// trump_signal on top of the existing Slot A (etf_flows/system_macro) /
// Slot B (x_narratives/sentiment) merge.
//
// trump_signal reuses this exact same slot-merge mechanism rather than
// any new dedup system: its own row's `id` is folded into the composite
// `id` string below exactly like slotA/slotB already are, so
// StreamEngine's existing hasChanged() (id/timestamp comparison) already
// detects a new Trump statement as "changed" with zero new code, the same
// way it already detects a new Slot A or Slot B row today.
export function mergeGrokSlots(rawRows) {
  if (!rawRows || rawRows.length === 0) {
    return null;
  }

  const rows = rawRows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    etf_flows: normalizeArray(row.etf_flows),
    system_macro: normalizeArray(row.system_macro),
    x_narratives: normalizeArray(row.x_narratives),
    sentiment: normalizeArray(row.sentiment),
    trump_signal: normalizeTrumpSignal(row.trump_signal),
  }));

  const slotA = rows.find((row) => row.etf_flows.length > 0 || row.system_macro.length > 0) ?? null;
  const slotB = rows.find((row) => row.x_narratives.length > 0 || row.sentiment.length > 0) ?? null;
  const slotC = rows.find((row) => row.trump_signal !== null) ?? null;

  if (!slotA && !slotB && !slotC) {
    return null;
  }
  // A slot with no match inside the fetched window is silently treated as
  // "empty" below (etf_flows/system_macro or x_narratives/sentiment come
  // back []) - that's indistinguishable from a real day with no data for
  // that slot unless it's logged here. trump_signal has no such log: unlike
  // Slot A/B (which the pipeline always expects to find), the overwhelming
  // majority of rows/polls legitimately have no Trump statement at all, so
  // "no slotC found" is the normal case, not a warning-worthy gap.
  if (!slotA) console.error(`[SUPABASE] fetchLatestGrokSignal: no Slot A row found in the latest ${rows.length} rows`);
  if (!slotB) console.error(`[SUPABASE] fetchLatestGrokSignal: no Slot B row found in the latest ${rows.length} rows`);

  // id/timestamp identify this merged view for downstream dedup
  // (StreamEngine.hasChanged) - composing them from every found slot's own
  // id/timestamp means the merged signal only changes when any slot
  // actually gets a newer row, and settles back to stable between polls.
  const foundSlots = [slotA, slotB, slotC].filter(Boolean);
  const timestamp = foundSlots.reduce((latest, s) => (s.timestamp > latest ? s.timestamp : latest), foundSlots[0].timestamp);

  return {
    id: `${slotA?.id ?? "none"}-${slotB?.id ?? "none"}-${slotC?.id ?? "none"}`,
    timestamp,
    etf_flows: slotA?.etf_flows ?? [],
    system_macro: slotA?.system_macro ?? [],
    x_narratives: slotB?.x_narratives ?? [],
    sentiment: slotB?.sentiment ?? [],
    trump_signal: slotC?.trump_signal ?? null,
  };
}

// The Grok bridge now inserts Slot A (etf_flows/system_macro) and Slot B
// (x_narratives/sentiment) as independent rows rather than one merged
// row/day (see the bridge Routine's own instructions). Fetching only the
// single latest row therefore means whichever slot fired most recently
// eclipses the other slot's still-current data - e.g. if Slot B just fired,
// the latest row's etf_flows/system_macro are legitimately empty even
// though a recent Slot A row with real data exists. Fetch each slot's
// latest row independently and merge them so the dashboard always shows
// the newest real data for all four fields, not just whichever slot
// happens to be freshest right now.
export async function fetchLatestGrokSignal() {
  // Enough rows to find each slot's latest non-empty match even if one
  // slot fires far more often than the other (e.g. a burst of Slot B
  // inserts between Slot A's real rows) - at the bridge's roughly-daily
  // cadence, 200 rows covers many months either way. A window that's too
  // small would silently return [] for a slot whose real recent row just
  // fell outside it (see the warning below), rather than erroring - so
  // generous headroom here matters more than query cost.
  const { data, error } = await getClient()
    .from("grok_signals")
    .select("id, timestamp, etf_flows, system_macro, x_narratives, sentiment, trump_signal")
    .order("timestamp", { ascending: false })
    .limit(200);

  if (error) {
    throw new Error(
      `fetchLatestGrokSignal: Supabase query failed (code=${error.code ?? "unknown"}, ` +
        `message=${error.message}, details=${error.details ?? "none"}, hint=${error.hint ?? "none"})`
    );
  }

  return mergeGrokSlots(data);
}

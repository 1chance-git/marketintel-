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
    .select("id, timestamp, etf_flows, system_macro, x_narratives, sentiment")
    .order("timestamp", { ascending: false })
    .limit(200);

  if (error) {
    throw new Error(
      `fetchLatestGrokSignal: Supabase query failed (code=${error.code ?? "unknown"}, ` +
        `message=${error.message}, details=${error.details ?? "none"}, hint=${error.hint ?? "none"})`
    );
  }

  if (!data || data.length === 0) {
    return null;
  }

  const rows = data.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    etf_flows: normalizeArray(row.etf_flows),
    system_macro: normalizeArray(row.system_macro),
    x_narratives: normalizeArray(row.x_narratives),
    sentiment: normalizeArray(row.sentiment),
  }));

  const slotA = rows.find((row) => row.etf_flows.length > 0 || row.system_macro.length > 0) ?? null;
  const slotB = rows.find((row) => row.x_narratives.length > 0 || row.sentiment.length > 0) ?? null;

  if (!slotA && !slotB) {
    return null;
  }
  // A slot with no match inside the fetched window is silently treated as
  // "empty" below (etf_flows/system_macro or x_narratives/sentiment come
  // back []) - that's indistinguishable from a real day with no data for
  // that slot unless it's logged here.
  if (!slotA) console.error(`[SUPABASE] fetchLatestGrokSignal: no Slot A row found in the latest ${rows.length} rows`);
  if (!slotB) console.error(`[SUPABASE] fetchLatestGrokSignal: no Slot B row found in the latest ${rows.length} rows`);

  // id/timestamp identify this merged view for downstream dedup
  // (StreamEngine.hasChanged) - composing them from both slots' own
  // ids/timestamps means the merged signal only changes when either slot
  // actually gets a newer row, and settles back to stable between polls.
  const timestamp =
    slotA && slotB
      ? slotA.timestamp > slotB.timestamp
        ? slotA.timestamp
        : slotB.timestamp
      : (slotA ?? slotB).timestamp;

  return {
    id: `${slotA?.id ?? "none"}-${slotB?.id ?? "none"}`,
    timestamp,
    etf_flows: slotA?.etf_flows ?? [],
    system_macro: slotA?.system_macro ?? [],
    x_narratives: slotB?.x_narratives ?? [],
    sentiment: slotB?.sentiment ?? [],
  };
}

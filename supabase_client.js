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

export async function fetchLatestGrokSignal() {
  const { data, error } = await getClient()
    .from("grok_signals")
    .select("id, timestamp, etf_flows, system_macro, x_narratives, sentiment")
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `fetchLatestGrokSignal: Supabase query failed (code=${error.code ?? "unknown"}, ` +
        `message=${error.message}, details=${error.details ?? "none"}, hint=${error.hint ?? "none"})`
    );
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id,
    timestamp: data.timestamp,
    etf_flows: normalizeArray(data.etf_flows),
    system_macro: normalizeArray(data.system_macro),
    x_narratives: normalizeArray(data.x_narratives),
    sentiment: normalizeArray(data.sentiment),
  };
}

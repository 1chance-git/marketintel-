import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "YOUR_SUPABASE_URL";
export const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

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

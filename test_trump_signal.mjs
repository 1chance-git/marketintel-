// -----------------------------------------------------------------------
// Tests for the additive Trump signal data contract (Block 6):
//   - supabase_client.js: normalizeTrumpSignal(), mergeGrokSlots()
//   - stream_engine.js: normalizeSignal()
//
// Pure-function tests only - no real Supabase network calls (mergeGrokSlots
// is exercised directly with fabricated row arrays, exactly like a real
// Supabase response shape). Run: node --test test_trump_signal.mjs
// -----------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrumpSignal, mergeGrokSlots } from "./supabase_client.js";
import { normalizeSignal } from "./stream_engine.js";

function makeRow(overrides = {}) {
  return {
    id: 1,
    timestamp: "2026-08-27T00:00:00+00:00",
    etf_flows: [],
    system_macro: [],
    x_narratives: [],
    sentiment: [],
    trump_signal: null,
    ...overrides,
  };
}

const VALID_TRUMP = {
  source: "Trump",
  timestamp: "2026-08-26T14:00:00+00:00",
  statement: "We are going to put tariffs on China.",
  topic: "Tariffs / trade",
  market_impact: "Could pressure import-heavy sectors.",
  affected_assets: ["SPY", "QQQ"],
  direction: "BEARISH",
  significance: "HIGH",
  new_information: true,
  evidence: "https://example.com/source",
};

test("1. existing Grok signal without trump_signal still works", () => {
  const rows = [makeRow({ id: 1, etf_flows: ["ETF flow A"] })];
  const merged = mergeGrokSlots(rows);
  assert.ok(merged);
  assert.deepEqual(merged.etf_flows, ["ETF flow A"]);
  assert.equal(merged.trump_signal, null);
});

test("2. signal containing a valid trump_signal passes through correctly", () => {
  const rows = [makeRow({ id: 2, trump_signal: VALID_TRUMP })];
  const merged = mergeGrokSlots(rows);
  assert.ok(merged.trump_signal);
  assert.equal(merged.trump_signal.statement, VALID_TRUMP.statement);
  assert.equal(merged.trump_signal.topic, "Tariffs / trade");
  assert.deepEqual(merged.trump_signal.affected_assets, ["SPY", "QQQ"]);
  assert.equal(merged.trump_signal.direction, "BEARISH");
  assert.equal(merged.trump_signal.significance, "HIGH");
  assert.equal(merged.trump_signal.new_information, true);
});

test("3. trump_signal = null works (explicit null, not just absent)", () => {
  const rows = [makeRow({ id: 3, trump_signal: null, etf_flows: ["x"] })];
  const merged = mergeGrokSlots(rows);
  assert.equal(merged.trump_signal, null);
  assert.deepEqual(merged.etf_flows, ["x"]);
});

test("4. malformed trump_signal is rejected/handled safely (never thrown, never passed through raw)", () => {
  const cases = [
    "just a string, not an object",
    42,
    ["array", "not", "object"],
    {},
    { statement: "no timestamp" },
    { timestamp: "2026-08-26T00:00:00Z" }, // no statement
    { statement: "", timestamp: "2026-08-26T00:00:00Z" }, // empty statement
    { statement: "ok", timestamp: "not-a-real-date" },
    null,
    undefined,
  ];
  for (const bad of cases) {
    assert.doesNotThrow(() => normalizeTrumpSignal(bad), `should not throw on: ${JSON.stringify(bad)}`);
    assert.equal(normalizeTrumpSignal(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test("4b. malformed trump_signal fields are coerced to safe defaults, not thrown on", () => {
  const result = normalizeTrumpSignal({
    statement: "Real statement",
    timestamp: "2026-08-26T00:00:00Z",
    direction: "TO_THE_MOON", // invalid enum value
    significance: "EXTREME", // invalid enum value
    affected_assets: ["SPY", 123, null, "QQQ"], // mixed garbage
    new_information: "yes", // wrong type
    topic: 12345, // wrong type
  });
  assert.ok(result);
  assert.equal(result.direction, "UNKNOWN");
  assert.equal(result.significance, "LOW");
  assert.deepEqual(result.affected_assets, ["SPY", "QQQ"]);
  assert.equal(result.new_information, false);
  assert.equal(result.topic, null);
  assert.equal(result.source, "Trump"); // defaulted, since not provided
});

test("5. existing signal fields (etf_flows/system_macro/x_narratives/sentiment) remain unchanged by trump_signal presence", () => {
  const withTrump = mergeGrokSlots([
    makeRow({ id: 10, etf_flows: ["a"], system_macro: ["b"], trump_signal: VALID_TRUMP }),
  ]);
  const withoutTrump = mergeGrokSlots([
    makeRow({ id: 10, etf_flows: ["a"], system_macro: ["b"] }),
  ]);
  assert.deepEqual(withTrump.etf_flows, withoutTrump.etf_flows);
  assert.deepEqual(withTrump.system_macro, withoutTrump.system_macro);
  assert.deepEqual(withTrump.x_narratives, withoutTrump.x_narratives);
  assert.deepEqual(withTrump.sentiment, withoutTrump.sentiment);
});

test("5b. Slot A / Slot B merge behavior across independent rows is unaffected by trump_signal", () => {
  const rows = [
    makeRow({ id: 20, timestamp: "2026-08-27T02:00:00+00:00", x_narratives: ["narrative"], sentiment: ["bullish"] }),
    makeRow({ id: 21, timestamp: "2026-08-27T01:00:00+00:00", etf_flows: ["etf"], system_macro: ["macro"] }),
  ];
  const merged = mergeGrokSlots(rows);
  assert.deepEqual(merged.etf_flows, ["etf"]);
  assert.deepEqual(merged.system_macro, ["macro"]);
  assert.deepEqual(merged.x_narratives, ["narrative"]);
  assert.deepEqual(merged.sentiment, ["bullish"]);
  assert.equal(merged.id, "21-20-none");
});

test("6. normalizeSignal() (stream_engine.js) preserves valid trump_signal and passes through unchanged", () => {
  const merged = mergeGrokSlots([makeRow({ id: 30, etf_flows: ["real etf data"], trump_signal: VALID_TRUMP })]);
  const normalized = normalizeSignal(merged);
  assert.deepEqual(normalized.etf_flows, ["real etf data"]);
  assert.ok(normalized.trump_signal);
  assert.equal(normalized.trump_signal.statement, VALID_TRUMP.statement);
});

test("6b. normalizeSignal() defends independently against a malformed trump_signal reaching it directly", () => {
  const normalized = normalizeSignal({ id: 1, timestamp: "2026-08-27T00:00:00Z", trump_signal: "not an object" });
  assert.equal(normalized.trump_signal, null);
});

test("6c. normalizeSignal() defaults trump_signal to null when absent entirely (backward compatible with pre-Trump signals)", () => {
  const normalized = normalizeSignal({ id: 1, timestamp: "2026-08-27T00:00:00Z" });
  assert.equal(normalized.trump_signal, null);
  assert.deepEqual(normalized.etf_flows, []);
});

test("7. existing Supabase/Grok behavior remains intact when Supabase returns zero rows", () => {
  assert.equal(mergeGrokSlots([]), null);
  assert.equal(mergeGrokSlots(null), null);
});

test("7b. existing Supabase/Grok behavior remains intact when nothing at all is found (no Slot A, B, or C)", () => {
  const rows = [makeRow({ id: 1 })]; // all fields empty/null
  assert.equal(mergeGrokSlots(rows), null);
});

test("composite id includes the Trump slot's row id so StreamEngine's existing hasChanged() detects a new Trump statement with zero new dedup code", () => {
  const before = mergeGrokSlots([makeRow({ id: 5, etf_flows: ["x"] })]);
  const after = mergeGrokSlots([
    makeRow({ id: 5, etf_flows: ["x"] }),
    makeRow({ id: 6, timestamp: "2026-08-27T03:00:00+00:00", trump_signal: VALID_TRUMP }),
  ]);
  assert.notEqual(before.id, after.id, "id must change when a new Trump-only row appears, so the existing id/timestamp dedup mechanism (StreamEngine.hasChanged) already detects it");
});

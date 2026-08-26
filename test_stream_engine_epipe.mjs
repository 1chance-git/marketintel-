// -----------------------------------------------------------------------
// Smallest possible reproduction of the confirmed production incident
// (2026-08-26): an ffmpeg stdin EPIPE must be handled as a recoverable
// stream failure - the Node process must survive, and the stream must
// attempt to restart (bounded), never a bare process.exit(0). Uses
// Node's built-in test runner (no new dependency) - run with:
//   node --test test_stream_engine_epipe.mjs
//
// Scope: exercises VideoEngine.handleStreamFailure()/
// scheduleStreamRestartOrGiveUp() in isolation (constructed directly,
// with a fake ffmpeg child process stand-in, and restartStream() itself
// stubbed out so no real ffmpeg process is ever spawned by a test) - no
// real ffmpeg/Puppeteer/network involved.
// -----------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VideoEngine } from "./stream_engine.js";

// Minimal stand-in for a Node ChildProcess: just enough surface
// (stdin as an EventEmitter with destroy/destroyed, exitCode/signalCode,
// kill()) for handleStreamFailure() to interact with.
function makeFakeFfmpeg() {
  const stdin = new EventEmitter();
  stdin.destroyed = false;
  stdin.destroy = () => { stdin.destroyed = true; };

  const killCalls = [];
  return {
    stdin,
    exitCode: null,
    signalCode: null,
    kill: (signal) => killCalls.push(signal),
    _killCalls: killCalls,
  };
}

// Builds a VideoEngine wired the same way run() wires a real one (stdin
// "error" -> handleStreamFailure), but with restartStream() stubbed to a
// no-op spy so the real (unref'd, 5s) restart timer scheduled by
// handleStreamFailure can never reach a real spawnFfmpeg() call even if
// it fires during/after a test. Always clears that timer in a `finally`
// as a second, belt-and-suspenders safeguard.
function makeTestEngine() {
  const engine = new VideoEngine({ durationMs: null });
  const fakeFfmpeg = makeFakeFfmpeg();
  engine.ffmpeg = fakeFfmpeg;
  engine.capturing = true;
  fakeFfmpeg.stdin.on("error", (err) => engine.handleStreamFailure(err));

  const restartCalls = [];
  engine.restartStream = () => restartCalls.push(true);

  return { engine, fakeFfmpeg, restartCalls };
}

test("EPIPE on ffmpeg stdin does NOT call process.exit()", () => {
  const { engine, fakeFfmpeg } = makeTestEngine();

  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = () => { exitCalled = true; };

  try {
    fakeFfmpeg.stdin.emit("error", new Error("write EPIPE"));
    assert.equal(exitCalled, false, "process.exit() must NOT be called on an ffmpeg stdin EPIPE");
  } finally {
    process.exit = originalExit;
    clearTimeout(engine.streamRestartTimer);
  }
});

test("EPIPE on ffmpeg stdin does NOT call shutdown()", () => {
  const { engine, fakeFfmpeg } = makeTestEngine();

  let shutdownCalled = false;
  engine.shutdown = () => { shutdownCalled = true; };

  fakeFfmpeg.stdin.emit("error", new Error("write EPIPE"));
  clearTimeout(engine.streamRestartTimer);

  assert.equal(shutdownCalled, false, "shutdown() must NOT be called on an ffmpeg stdin EPIPE");
});

test("EPIPE handling cleans up the failed ffmpeg process and leaves capturing=false", () => {
  const { engine, fakeFfmpeg } = makeTestEngine();

  fakeFfmpeg.stdin.emit("error", new Error("write EPIPE"));
  clearTimeout(engine.streamRestartTimer);

  assert.equal(engine.capturing, false, "capturing must be false after a stream failure");
  assert.equal(engine.ffmpeg, null, "the dead ffmpeg reference must be cleared so a restart can't collide with it");
  assert.equal(fakeFfmpeg.stdin.destroyed, true, "the failed process's stdin must be destroyed");
  assert.deepEqual(fakeFfmpeg._killCalls, ["SIGKILL"], "the failed process must be force-killed since it hadn't exited on its own");
});

test("EPIPE schedules a bounded stream restart (STREAM_RESTARTING path)", () => {
  const { engine, fakeFfmpeg } = makeTestEngine();

  fakeFfmpeg.stdin.emit("error", new Error("write EPIPE"));

  assert.equal(engine.consecutiveStreamFailures, 1, "one failure should be counted");
  assert.ok(engine.streamRestartTimer, "a restart must be scheduled (not just silently dropped)");
  clearTimeout(engine.streamRestartTimer);
});

test("a second EPIPE (or any handling while already shutting down) is a no-op, not a double-handle", () => {
  const { engine, fakeFfmpeg } = makeTestEngine();

  fakeFfmpeg.stdin.emit("error", new Error("write EPIPE"));
  clearTimeout(engine.streamRestartTimer);
  assert.equal(fakeFfmpeg._killCalls.length, 1);

  // Re-entrant call after the first one already handled it (e.g. another
  // write attempt on the now-destroyed stdin) must be a no-op, not throw
  // or attempt to kill an already-cleared ffmpeg reference again.
  assert.doesNotThrow(() => engine.handleStreamFailure(new Error("write EPIPE")));
  clearTimeout(engine.streamRestartTimer);
  assert.equal(fakeFfmpeg._killCalls.length, 1, "must not attempt to kill the same process twice");
});

test("repeated failures are bounded: exceeding the cap exits non-zero instead of retrying forever", () => {
  const engine = new VideoEngine({ durationMs: null });
  engine.restartStream = () => {}; // never actually reached in this test

  const originalExit = process.exit;
  const exitCalls = [];
  process.exit = (code) => { exitCalls.push(code); };

  try {
    // Simulate having already failed MAX_CONSECUTIVE_STREAM_FAILURES
    // times (mirrors what handleStreamFailure's increment would produce
    // over repeated real failures) and trigger one more decision.
    engine.consecutiveStreamFailures = 5; // matches MAX_CONSECUTIVE_STREAM_FAILURES in stream_engine.js
    engine.scheduleStreamRestartOrGiveUp();
  } finally {
    process.exit = originalExit;
    clearTimeout(engine.streamRestartTimer);
  }

  assert.deepEqual(exitCalls, [1], "must give up with a NON-ZERO exit code once the bounded retry budget is exhausted (never exit(0))");
});

test("normal finishCapture() (natural end of capture) still calls shutdown(0) unchanged", () => {
  const engine = new VideoEngine({ durationMs: null });
  engine.capturing = true;

  const shutdownCalls = [];
  engine.shutdown = (code) => { shutdownCalls.push(code); };

  engine.finishCapture();

  assert.deepEqual(shutdownCalls, [0], "normal/intentional capture completion must be unaffected by this change");
});

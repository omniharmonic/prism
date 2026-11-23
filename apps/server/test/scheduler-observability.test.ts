/**
 * Worker observability: consecutive-failure escalation, and the Fathom throttle
 * (audit 2026-08-13, F4 + F10).
 *
 * The behaviour under test is what the LOG says, because that WAS the defect: a
 * dead pipeline and an idle one produced byte-for-byte identical output, so the
 * Matrix homeserver being unreachable logged 31,162 identical warn lines and
 * never once said "this has been down for hours".
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./helpers";
import { noteIngestOutcome, resetIngestFailures, ingestFailureState } from "../src/worker/scheduler";
import { getWorkerCursor, setWorkerCursor } from "../src/db";
import { config } from "../src/config";

/** Capture console output for the duration of a block. */
function captureConsole() {
  const warns: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const ow = console.warn, oe = console.error, ol = console.log;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  return {
    warns, errors, logs,
    restore() { console.warn = ow; console.error = oe; console.log = ol; },
  };
}

beforeEach(() => {
  resetDb();
  resetIngestFailures();
});

test("the first failure warns once, and the next few stay silent", () => {
  const c = captureConsole();
  try {
    for (let i = 0; i < 4; i++) noteIngestOutcome("primary", "matrix", new Error("fetch failed"));
  } finally {
    c.restore();
  }
  assert.equal(c.warns.length, 1, "exactly one warn, not one per attempt");
  assert.match(c.warns[0]!, /matrix primary failed: fetch failed/);
  assert.equal(c.errors.length, 0, "not escalated yet");
});

test("a sustained outage escalates to an error naming how long it has been down", () => {
  const c = captureConsole();
  try {
    for (let i = 0; i < 5; i++) noteIngestOutcome("primary", "matrix", new Error("fetch failed"));
  } finally {
    c.restore();
  }
  assert.equal(c.errors.length, 1, "escalated exactly once at the threshold");
  assert.match(c.errors[0]!, /DOWN/);
  assert.match(c.errors[0]!, /5 consecutive failures/);
  assert.match(c.errors[0]!, /produced nothing/);
});

test("continuing to fail does NOT re-log every tick (that was the 31k-line bug)", () => {
  const c = captureConsole();
  try {
    for (let i = 0; i < 60; i++) noteIngestOutcome("primary", "matrix", new Error("fetch failed"));
  } finally {
    c.restore();
  }
  assert.equal(c.warns.length, 1);
  assert.equal(c.errors.length, 1, "still one error — hourly, not per tick");
  assert.equal(ingestFailureState()[0]!.count, 60, "but the outage is still being tracked");
});

test("recovery is logged and clears the failure state", () => {
  for (let i = 0; i < 6; i++) noteIngestOutcome("primary", "matrix", new Error("fetch failed"));
  const c = captureConsole();
  try {
    noteIngestOutcome("primary", "matrix", null);
  } finally {
    c.restore();
  }
  assert.equal(c.logs.length, 1);
  assert.match(c.logs[0]!, /RECOVERED after 6 failed run\(s\)/);
  assert.deepEqual(ingestFailureState(), [], "state cleared on recovery");
});

test("a healthy source never logs anything", () => {
  const c = captureConsole();
  try {
    for (let i = 0; i < 10; i++) noteIngestOutcome("primary", "fireflies", null);
  } finally {
    c.restore();
  }
  assert.deepEqual([...c.warns, ...c.errors, ...c.logs], []);
});

test("failures are tracked per (vault, source), not globally", () => {
  for (let i = 0; i < 5; i++) noteIngestOutcome("primary", "matrix", new Error("a"));
  noteIngestOutcome("primary", "fathom", new Error("b"));
  const state = ingestFailureState();
  assert.equal(state.length, 2);
  assert.equal(state.find((s) => s.source === "matrix")!.count, 5);
  assert.equal(state.find((s) => s.source === "fathom")!.count, 1);
});

test("Fathom is throttled to one run per interval, not once per 60s tick", () => {
  // The slot claim is what stops the whole-transcript-set refetch every minute.
  const slot = Math.floor(Date.now() / config.fathomIntervalMs);
  setWorkerCursor("primary", "fathom-slot", String(slot));
  assert.equal(getWorkerCursor("primary", "fathom-slot"), String(slot));
  assert.ok(config.fathomIntervalMs >= 3_600_000, "hourly or slower, not the 60s tick");
});

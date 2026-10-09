// tests/gate-surface.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { surfaceOnce, markSurfaced, sanitizeLine } from "../hooks/gate-surface.mjs";
import { upsertRun, readJournal } from "../hooks/run-journal.mjs";
import { CONFIG } from "../hooks/gate-run.config.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function repo(t) { return tempDirFor(t, "surf-"); }

test("surfaceOnce CLAIMS and returns the line but does NOT mark surfaced=true (mark-after-emit)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "pass", surfaced: false, reviewer: "codex:terra", diffId: "d1abc234" });
  const a = surfaceOnce(r);
  assert.ok(a.line && a.line.includes("R1"));
  assert.equal(a.runId, "R1");
  assert.equal(readJournal(r)["R1"].surfaced, "claiming");  // claimed, NOT true yet
  markSurfaced(r, "R1");                                     // caller marks AFTER emitting
  assert.equal(readJournal(r)["R1"].surfaced, true);
  assert.equal(surfaceOnce(r).line, null);                  // nothing left to surface
});

test("a crash AFTER claim/emit but BEFORE mark re-emits ONCE past the TTL (at-least-once, never lost)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "failed", surfaced: false, reviewer: "codex:terra", failure_reason: "exhausted", diffId: "d1" });
  const t0 = new Date("2026-07-18T12:00:00Z");
  const a = surfaceOnce(r, { now: () => t0 });               // claim at t0; caller "crashes" before markSurfaced
  assert.ok(a.line);
  assert.equal(surfaceOnce(r, { now: () => new Date(t0.getTime() + 1000) }).line, null);          // within TTL: not re-claimable
  const b = surfaceOnce(r, { now: () => new Date(t0.getTime() + CONFIG.ttl.claimStaleMs + 1000) }); // past TTL
  assert.ok(b.line && b.line.includes("R1"));               // the FAILED verdict is re-emitted, never silently dropped
});

test("surfaceOnce accepts a NUMERIC deps.now (module convention) coerced to Date -- does not throw", (t) => {
  // Pre-fix, a numeric now made now.getTime()/toISOString() throw a TypeError. The module convention
  // (run-journal.mjs / withLock) injects a NUMBER, so surfaceOnce must coerce. This discriminates that.
  const r = repo(t);
  upsertRun(r, "R1", { status: "failed", surfaced: false, reviewer: "codex:terra", failure_reason: "exhausted", diffId: "d1" });
  const t0 = new Date("2026-07-18T12:00:00Z").getTime();     // NUMBER (Date.now-style)
  const a = surfaceOnce(r, { now: () => t0 });               // must NOT throw
  assert.ok(a.line && a.line.includes("R1"));
  assert.equal(readJournal(r)["R1"].surfaced, "claiming");
  assert.equal(surfaceOnce(r, { now: () => t0 + 1000 }).line, null);                       // within TTL
  assert.ok(surfaceOnce(r, { now: () => t0 + CONFIG.ttl.claimStaleMs + 1000 }).line);       // past TTL -> re-emit
});

test("a running (nonterminal) run is not surfaced", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", surfaced: false });
  assert.equal(surfaceOnce(r).line, null);
});

test("a budget skip surfaces the same way", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "skipped", surfaced: false, failure_reason: "budget", diffId: "d1" });
  assert.ok(surfaceOnce(r).line.includes("budget"));
});

test("sanitizeLine strips control chars (ASCII-escaped range), defangs directives, caps length", () => {
  const dirty = "ok\nhookEventName injection " + "x".repeat(500);
  const clean = sanitizeLine(dirty, 100);
  assert.ok(clean.length <= 100);
  assert.ok(!/[\x00-\x1f\x7f]/.test(clean));   // no control chars survive
  assert.ok(!/hookEventName/i.test(clean));    // hook directive defanged
});

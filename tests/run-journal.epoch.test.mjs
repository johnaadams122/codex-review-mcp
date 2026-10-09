// tests/run-journal.epoch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nextAttemptEpoch, claimAttempt, isLiveEpoch, bumpEpoch, upsertRun, readJournal } from "../hooks/run-journal.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function repo(t) { return tempDirFor(t, "epoch-"); }

test("nextAttemptEpoch is per-targetKey monotonic FROM THE JOURNAL (no in-memory Map)", () => {
  const j = { R1: { targetKey: "A", attemptEpoch: 1 }, R2: { targetKey: "A", attemptEpoch: 2 }, R3: { targetKey: "B", attemptEpoch: 5 } };
  assert.equal(nextAttemptEpoch(j, "A"), 3);
  assert.equal(nextAttemptEpoch(j, "B"), 6);
  assert.equal(nextAttemptEpoch(j, "C"), 1);            // an unseen target starts at 1
});

test("claimAttempt writes a running entry with a fresh epoch; a LIVE duplicate is debounced", (t) => {
  const r = repo(t);
  const c1 = claimAttempt(r, { runId: "R1", targetKey: "d1", dayKey: "2026-07-18", entry: { diffId: "d1" } });
  assert.equal(c1.claimed, true);
  assert.equal(c1.attemptEpoch, 1);
  assert.equal(readJournal(r)["R1"].status, "running");
  // a second claim for the SAME targetKey/day while the first is live -> debounced, no second entry
  const c2 = claimAttempt(r, { runId: "R2", targetKey: "d1", dayKey: "2026-07-18", entry: { diffId: "d1" } });
  assert.equal(c2.claimed, false);
  assert.equal(c2.reason, "debounced");
  assert.equal(readJournal(r)["R2"], undefined);
});

test("claimAttempt debounces a LIVE duplicate ACROSS a day-key change (midnight straddle)", (t) => {
  const r = repo(t);
  claimAttempt(r, { runId: "R1", targetKey: "d1", dayKey: "2026-07-18", entry: {} });   // live, day A
  const c2 = claimAttempt(r, { runId: "R2", targetKey: "d1", dayKey: "2026-07-19", entry: {} }); // next day, same bytes
  assert.equal(c2.claimed, false);                        // still debounced -- no double-launch across midnight
  assert.equal(c2.reason, "debounced");
});

test("claimAttempt after the first entry terminalized mints a HIGHER epoch (same-bytes retry)", (t) => {
  const r = repo(t);
  claimAttempt(r, { runId: "R1", targetKey: "d1", dayKey: "2026-07-18", entry: {} });
  upsertRun(r, "R1", { status: "failed" });             // first attempt terminal -> no longer live
  const c2 = claimAttempt(r, { runId: "R2", targetKey: "d1", dayKey: "2026-07-18", entry: {} });
  assert.equal(c2.claimed, true);
  assert.equal(c2.attemptEpoch, 2);                      // monotonic across attempts for this targetKey
});

test("isLiveEpoch reflects the journal; bumpEpoch supersedes a running attempt (persisted commit gate)", (t) => {
  const r = repo(t);
  claimAttempt(r, { runId: "R1", targetKey: "d1", dayKey: "2026-07-18", entry: {} }); // epoch 1
  assert.equal(isLiveEpoch(r, "R1", 1), true);
  bumpEpoch(r, "d1");                                    // reaper/timeout invalidates the in-flight attempt
  assert.equal(isLiveEpoch(r, "R1", 1), false);          // a child holding epoch 1 now fails its commit CAS
});

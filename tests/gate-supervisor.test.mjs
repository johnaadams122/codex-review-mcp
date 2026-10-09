// tests/gate-supervisor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sweepJournal } from "../hooks/gate-supervisor.mjs";
import { upsertRun, readJournal } from "../hooks/run-journal.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function repo(t) { return tempDirFor(t, "sup-"); }

// a pid that no process has (liveness is faked in these tests anyway)
const DEAD_PID = 2 ** 30;

test("a dead-pid running entry with NO verdict.json becomes failed:supervisor_reaped + bumps epoch", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: DEAD_PID, attemptEpoch: 1, deadlineAt: "2999-01-01T00:00:00Z" });
  const out = sweepJournal(r, { isPidAlive: () => false, readVerdict: () => null });
  const e = readJournal(r)["R1"];
  assert.equal(e.status, "failed");
  assert.equal(e.failure_reason, "supervisor_reaped");
  assert.equal(e.attemptEpoch, 2);                        // bumped -> a late child rung is superseded
  assert.equal(out.reaped, 1);
});

test("a dead child that WROTE a BOUND verdict.json PASS is reconciled to PASS, NOT clobbered to FAILED", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: DEAD_PID, attemptEpoch: 1, diffId: "d1", deadlineAt: "2999-01-01T00:00:00Z" });
  const verdict = { status: "pass", runId: "R1", diffId: "d1", reviewer: "codex:terra", strength_attested: true, attempts: [{ attempt: 1 }] };
  sweepJournal(r, { isPidAlive: () => false, readVerdict: () => verdict });
  const e = readJournal(r)["R1"];
  assert.equal(e.status, "pass");                         // the real, run-bound verdict on disk wins
  assert.equal(e.reviewer, "codex:terra");
  assert.notEqual(e.failure_reason, "supervisor_reaped");
});

test("a MISBOUND verdict.json (wrong runId/diffId) is IGNORED -> supervisor_reaped, never a fabricated PASS", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: DEAD_PID, attemptEpoch: 1, diffId: "d1", deadlineAt: "2999-01-01T00:00:00Z" });
  const stale = { status: "pass", runId: "OTHER", diffId: "OTHER-BYTES", reviewer: "codex:terra" };
  sweepJournal(r, { isPidAlive: () => false, readVerdict: () => stale });
  const e = readJournal(r)["R1"];
  assert.equal(e.status, "failed");                       // unbound artifact rejected
  assert.equal(e.failure_reason, "supervisor_reaped");
});

test("sweepJournal accepts a NUMERIC deps.now (coerced to Date) -- expired entry still reaps, no getTime throw", (t) => {
  // Module convention injects a NUMERIC now; without coercion now.getTime() throws. The 3rd/last consumer
  // to get the same coercion as run-journal/gate-surface.
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: 4242, attemptEpoch: 1, deadlineAt: "2000-01-01T00:00:00Z" });
  const nowNum = new Date("2026-07-18T12:00:00Z").getTime();   // NUMBER
  sweepJournal(r, { isPidAlive: () => true, readVerdict: () => null, now: () => nowNum });   // must NOT throw
  assert.equal(readJournal(r)["R1"].status, "failed");
  assert.equal(readJournal(r)["R1"].failure_reason, "deadline_exceeded");
});

test("a verdict.json with the RIGHT runId but WRONG diffId is IGNORED -> supervisor_reaped (diffId-half of the bind; the likely stale-artifact case)", (t) => {
  // The prior test flips BOTH runId and diffId; this isolates the diffId check -- a leftover verdict.json
  // for the SAME runId but a stale/different diff must not be trusted (a re-triggered run at the same runId
  // with new bytes would otherwise fabricate a PASS from the old attempt). Discriminates a bind that drops diffId.
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: DEAD_PID, attemptEpoch: 1, diffId: "d1", deadlineAt: "2999-01-01T00:00:00Z" });
  const staleDiff = { status: "pass", runId: "R1", diffId: "WRONG-BYTES", reviewer: "codex:terra" };
  sweepJournal(r, { isPidAlive: () => false, readVerdict: () => staleDiff });
  const e = readJournal(r)["R1"];
  assert.equal(e.status, "failed");
  assert.equal(e.failure_reason, "supervisor_reaped");
});

test("a NO-pid running entry within deadline is LEFT running (pid-write may be racing the claim)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", attemptEpoch: 1, deadlineAt: "2999-01-01T00:00:00Z" }); // no pid
  sweepJournal(r, { isPidAlive: () => false, readVerdict: () => null, now: () => new Date("2026-07-18T12:00:00Z") });
  assert.equal(readJournal(r)["R1"].status, "running");   // NOT falsely reaped
});

test("an EXPIRED entry (alive pid) terminalizes deadline_exceeded (no worker kill)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: 4242, attemptEpoch: 1, deadlineAt: "2000-01-01T00:00:00Z" });
  sweepJournal(r, { isPidAlive: () => true, readVerdict: () => null, now: () => new Date("2026-07-18T12:00:00Z") });
  assert.equal(readJournal(r)["R1"].status, "failed");
  assert.equal(readJournal(r)["R1"].failure_reason, "deadline_exceeded");
});

test("a live-pid, pre-deadline running entry is left running (no false reap)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: 4242, deadlineAt: "2999-01-01T00:00:00Z" });
  sweepJournal(r, { isPidAlive: () => true, readVerdict: () => null, now: () => new Date("2026-07-18T12:00:00Z") });
  assert.equal(readJournal(r)["R1"].status, "running");
});

test("sweepJournal is idempotent over an already-terminal entry", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "pass", pid: DEAD_PID });
  sweepJournal(r, { isPidAlive: () => false, readVerdict: () => null });
  assert.equal(readJournal(r)["R1"].status, "pass");
});

test("a PASS that lands BETWEEN the sweep's read and its terminalize is preserved (first-terminal-wins race)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: DEAD_PID, deadlineAt: "2999-01-01T00:00:00Z" });
  let raced = false;
  const deps = {
    isPidAlive: () => false, readVerdict: () => null,
    upsertRun: (root, id, patch, o) => {
      if (!raced) { raced = true; upsertRun(r, "R1", { status: "pass", reviewer: "codex:terra" }); } // child wins
      return upsertRun(root, id, patch, o); // the sweep's FAILED -> dropped by first-terminal-wins
    },
  };
  sweepJournal(r, deps);
  assert.equal(readJournal(r)["R1"].status, "pass");     // the real verdict survives the reaper
});

test("a TRUE-reaped entry with persisted jobIds RECORDS them as reclaimed_jobs (audit linkage; never kills/queries)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: DEAD_PID, attemptEpoch: 1, jobIds: ["j1", "j2"], deadlineAt: "2999-01-01T00:00:00Z" });
  sweepJournal(r, { isPidAlive: () => false, readVerdict: () => null });   // no verdict -> TRUE reap; no jobStatus dep exists
  const e = readJournal(r)["R1"];
  assert.equal(e.status, "failed");
  assert.deepEqual(e.reclaimed_jobs, ["j1", "j2"]);       // the run's reviewer jobIds are recorded (a separate reaper owns the kill)
  assert.deepEqual(e.jobIds, ["j1", "j2"]);               // jobIds[] stays authoritative
});

test("a vBound reconcile SKIPS reclaim_jobs (child finished -> reviewer jobs already terminated normally)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", pid: DEAD_PID, attemptEpoch: 1, diffId: "d1", jobIds: ["j1"], deadlineAt: "2999-01-01T00:00:00Z" });
  const verdict = { status: "pass", runId: "R1", diffId: "d1", reviewer: "codex:terra", strength_attested: true };
  sweepJournal(r, { isPidAlive: () => false, readVerdict: () => verdict });
  const e = readJournal(r)["R1"];
  assert.equal(e.status, "pass");
  assert.equal(e.reclaimed_jobs, undefined);              // no reclaim record on the happy reconcile path
});

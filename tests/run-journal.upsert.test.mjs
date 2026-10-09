// tests/run-journal.upsert.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJournal, upsertRun, journalPath, dayKey } from "../hooks/run-journal.mjs";
import { readJSON } from "../hooks/atomic-store.mjs";
import { CONFIG } from "../hooks/gate-run.config.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function repo(t) { return tempDirFor(t, "journal-"); }

test("upsertRun creates then merges an entry and bumps seq", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", targetKey: "d1", jobs_submitted: 0 });
  const e1 = readJournal(r)["R1"];
  assert.equal(e1.status, "running");
  assert.equal(e1.seq, 1);
  upsertRun(r, "R1", { jobs_submitted: 2 });
  const e2 = readJournal(r)["R1"];
  assert.equal(e2.jobs_submitted, 2);
  assert.equal(e2.seq, 2);
  assert.equal(e2.targetKey, "d1"); // preserved
});

test("upsertRun DROPS a terminal->running downgrade (monotonic RUN_STATE_RANK)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running" });
  upsertRun(r, "R1", { status: "pass" });     // terminal
  upsertRun(r, "R1", { status: "running" });  // late orphan patch must NOT roll back
  assert.equal(readJournal(r)["R1"].status, "pass");
});

test("upsertRun is FIRST-TERMINAL-WINS: a reaper FAILED cannot clobber a real PASS", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running" });
  upsertRun(r, "R1", { status: "pass", reviewer: "codex:terra" });  // child reconciles PASS
  const out = upsertRun(r, "R1", { status: "failed", failure_reason: "supervisor_reaped", reviewer: "reaper" }); // reaper races
  assert.equal(out.status, "pass");                 // terminal PASS preserved
  assert.notEqual(out.failure_reason, "supervisor_reaped"); // losing verdict-identity is DROPPED, not smeared
  assert.equal(out.reviewer, "codex:terra");        // the real PASS reviewer is preserved
  assert.equal(readJournal(r)["R1"].status, "pass");
});

test("upsertRun FIRST-TERMINAL-WINS drops ALL 8 losing verdict-identity fields, not just status/reviewer", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running" });
  upsertRun(r, "R1", {
    status: "pass",
    reviewer: "codex:terra",
    verdictPath: "verdicts/R1-pass.json",
    attempts: 1,
    strength_attested: true,
    attemptEpoch: 1,
  }); // child reconciles PASS -- winning terminal entry
  // Reaper races with a losing patch that sets ALL 8 drop-set fields to poisoned values, including
  // reclaimed_jobs (the reaper's jobId audit is part of
  // the terminalize it just lost).
  const out = upsertRun(r, "R1", {
    status: "failed",
    failure_reason: "supervisor_reaped",
    reviewer: "reaper",
    verdictPath: "verdicts/R1-reaper.json",
    attempts: 99,
    strength_attested: false,
    attemptEpoch: 2,
    reclaimed_jobs: ["job-a", "job-b"],
  });

  // Winner identity preserved exactly as the winning PASS patch set it.
  assert.equal(out.status, "pass");
  assert.equal(out.reviewer, "codex:terra");
  assert.equal(out.verdictPath, "verdicts/R1-pass.json");
  assert.equal(out.attempts, 1);
  assert.equal(out.strength_attested, true);
  assert.equal(out.attemptEpoch, 1);
  // failure_reason and reclaimed_jobs were never set by the winning PASS patch -- they must stay
  // absent, not get smeared in from the reaper's losing patch.
  assert.equal(out.failure_reason, undefined);
  assert.equal(out.reclaimed_jobs, undefined);

  assert.equal(readJournal(r)["R1"].status, "pass");
});

test("upsertRun optimistic CAS: a stale expectSeq writes NOTHING and reports conflict", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", attemptEpoch: 1 });      // seq now 1
  upsertRun(r, "R1", { jobs_submitted: 1 });                        // another writer -> seq now 2
  const out = upsertRun(r, "R1", { status: "pass" }, { expectSeq: 1 }); // we read at seq 1, lost the race
  assert.equal(out.conflict, true);
  assert.notEqual(readJournal(r)["R1"].status, "pass");             // no write happened
});

test("upsertRun epoch CAS: a superseded attemptEpoch writes NOTHING (persisted commit gate)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", attemptEpoch: 2 });       // live epoch is 2
  const out = upsertRun(r, "R1", { status: "pass" }, { expectEpoch: 1 }); // child holds stale epoch 1
  assert.equal(out.conflict, true);
  assert.notEqual(readJournal(r)["R1"].status, "pass");
});

test("readJournal is STRICT: a corrupt journal throws (never reads as empty)", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running" });
  fs.writeFileSync(journalPath(r), '{"R1": CORRUPT');
  assert.throws(() => readJournal(r), (e) => e && e.code === "ECORRUPT");
});

test("readJournal's corrupt-guard PERSISTS a budget-exhausted entry so a spent budget cannot silently reopen", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running" });
  fs.writeFileSync(journalPath(r), '{"R1": CORRUPT');
  assert.throws(() => readJournal(r), (e) => e && e.code === "ECORRUPT");

  // The corrupt bytes were quarantined aside (renamed, never overwritten) and a guard entry was
  // written to journalPath in their place. Read it back via a plain (non-strict-relevant) readJSON
  // of journalPath -- this does not depend on whether a bare follow-up readJournal() call throws or
  // succeeds, it just confirms the guard is durably on disk.
  const persisted = readJSON(journalPath(r), {});
  const key = dayKey();
  const guard = persisted["__corrupt_guard__:" + key];
  assert.ok(guard, "expected a persisted __corrupt_guard__:<dayKey> entry after the corrupt throw");
  assert.equal(guard.status, "skipped");
  assert.equal(guard.jobs_submitted, CONFIG.budget.dailyJobCap);
  assert.equal(guard.failure_reason, "corrupt_journal");
});

test("readJournal's corrupt-guard survives a numeric deps.now (withLock convention) without a TypeError", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running" });
  fs.writeFileSync(journalPath(r), '{"R1": CORRUPT');
  // upsertRun threads the SAME deps into withLock (which uses deps.now() as a Date.now-style
  // NUMBER) and into readJournal (whose corrupt-guard needs a Date for dayKey()). A caller
  // injecting a numeric now must still get ECORRUPT, never a raw TypeError from
  // (number).getFullYear().
  assert.throws(
    () => readJournal(r, { now: () => 10 ** 12 }),
    (e) => e && e.code === "ECORRUPT"
  );
});

test("journalPath is repo-scoped under .superpowers", (t) => {
  const r = repo(t);
  assert.equal(journalPath(r), path.join(r, ".superpowers", "gate-runs.json"));
});

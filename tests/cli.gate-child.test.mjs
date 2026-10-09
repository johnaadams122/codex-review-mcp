import { test } from "node:test";
import assert from "node:assert/strict";
import { runGateCommand } from "../cli.mjs";

test("child (--run-id) verifies diffId, runs the ladder, writes verdict.json, reconciles journal epoch-guarded", async () => {
  const upserts = [];
  let verdictWritten = null, ladderRan = false;
  const deps = {
    runGit: () => "PINNED-BYTES",
    diffIdOf: () => "d1",                                   // hash matches --diff-id
    runLadder: async () => { ladderRan = true; return { status: "pass", reviewer: "codex:terra", attempts: [{}] }; },
    makeRecheck: () => async () => ({ ok: true }),
    recordSubmission: () => ({ ok: true }),
    isLiveEpoch: () => true,
    upsertRun: (root, id, patch, o) => { upserts.push({ id, patch, o }); return { ...patch }; },
    atomicWriteJSON: (p, obj) => { verdictWritten = { p, obj }; },
  };
  const res = await runGateCommand(
    { phase: "impl", cwd: "/repo", "run-id": "R1", "payload-ref": "commit:abc", "target-key": "d1", "attempt-epoch": "1", "diff-id": "d1" },
    deps);
  assert.equal(ladderRan, true);
  assert.equal(res.status, "pass");
  assert.match(verdictWritten.p, /R1[\\/]verdict\.json$/);
  assert.equal(verdictWritten.obj.diffId, "d1");           // verdict binds to reviewed bytes
  const terminal = upserts.find((u) => u.patch.status === "pass");
  assert.ok(terminal, "reconciled the journal to terminal PASS");
  assert.equal(terminal.o.expectEpoch, 1);                 // commit-gate CAS guards the reconcile
});

test("child aborts on a diffId MISMATCH -> terminal failed:diffid_mismatch, ladder NEVER runs", async () => {
  let ladderRan = false;
  const upserts = [];
  const res = await runGateCommand(
    { phase: "impl", cwd: "/repo", "run-id": "R1", "payload-ref": "commit:abc", "target-key": "d1", "attempt-epoch": "1", "diff-id": "EXPECTED" },
    { runGit: () => "MUTATED-BYTES", diffIdOf: () => "ACTUAL", runLadder: async () => { ladderRan = true; return {}; },
      upsertRun: (r, id, patch, o) => { upserts.push({ patch, o }); return patch; }, atomicWriteJSON: () => {} });
  assert.equal(ladderRan, false);
  assert.equal(res.status, "failed");
  assert.equal(res.failure_reason, "diffid_mismatch");
  assert.ok(upserts.some((u) => u.patch.status === "failed" && u.patch.failure_reason === "diffid_mismatch"));
});

test("child does NOT reconcile a SUPERSEDED verdict (reaper/newer attempt owns it); verdict.json still written", async () => {
  // Load-bearing safety invariant: a superseded attempt must NOT write a terminal journal reconcile.
  // Discriminates removal of the superseded-skip (upsertRun would then be called -> upserts.length===1).
  const upserts = [];
  let verdictWritten = null;
  const res = await runGateCommand(
    { phase: "impl", cwd: "/repo", "run-id": "R1", "payload-ref": "commit:abc", "target-key": "d1", "attempt-epoch": "1", "diff-id": "d1" },
    {
      runGit: () => "PINNED-BYTES", diffIdOf: () => "d1",
      runLadder: async () => ({ status: "superseded", reviewer: "codex:terra (requested, unattested)", attempts: [] }),
      makeRecheck: () => async () => ({ ok: true }), recordSubmission: () => ({ ok: true }), isLiveEpoch: () => true,
      upsertRun: (root, id, patch, o) => { upserts.push({ id, patch, o }); return { ...patch }; },
      atomicWriteJSON: (p, obj) => { verdictWritten = { p, obj }; },
    });
  assert.equal(res.status, "superseded");
  assert.equal(upserts.length, 0, "a superseded verdict must NOT reconcile the journal (no upsertRun)");
  assert.ok(verdictWritten, "verdict.json is still written (best-effort artifact)");
});

test("without --run-id, runGateCommand keeps Phase-1 behavior (one gate, clears markers, no artifact)", async () => {
  let wrote = false, cleared = false;
  const runGate = async () => ({ consensus_verdict: "block", status: "complete" });
  const res = await runGateCommand({ phase: "impl", cwd: "/repo" },
    { runGate, clearGateDueForGate: () => { cleared = true; }, atomicWriteJSON: () => { wrote = true; } });
  assert.equal(res.consensus_verdict, "block");
  assert.equal(wrote, false);
  assert.equal(cleared, true);
});

test("child WIRES afterSubmit -> recordJobId: a submitted jobId is persisted (end-to-end)", async () => {
  // Guards the two NEW wiring hops the unit tests otherwise mock past: runGateOnce must build an
  // afterSubmit that calls recordJobId with the submitted jobId. Fake runLadder INVOKES runGateOnce;
  // fake runGate simulates the panel firing afterSubmit post-submit; spy recordJobId records the jobId.
  const jobIdsSeen = [];
  const deps = {
    runGit: () => "PINNED-BYTES",
    diffIdOf: () => "d1",                                   // matches --diff-id -> ladder runs
    recordSubmission: () => ({ ok: true }),
    recordJobId: (root, id, jobId) => { jobIdsSeen.push({ root, id, jobId }); return { ok: true, jobIds: [jobId] }; },
    isLiveEpoch: () => true,
    upsertRun: (root, id, patch) => ({ ...patch }),
    atomicWriteJSON: () => {},
    makeRecheck: () => async () => ({ ok: true }),
    runGate: async (_opts, d) => {                          // simulate the panel calling afterSubmit AFTER a submit
      if (d.afterSubmit) await d.afterSubmit({ lens: "correctness", jobId: "J-42" });
      return { status: "pass", reviewer: "codex:terra", attempts: [{}], consensus_verdict: "pass" };
    },
    runLadder: async (_ev, d) => d.runGateOnce(),           // actually EXERCISE the child's runGateOnce wiring
  };
  const res = await runGateCommand(
    { phase: "impl", cwd: "/repo", "run-id": "R1", "payload-ref": "commit:abc", "target-key": "d1", "attempt-epoch": "1", "diff-id": "d1" },
    deps);
  assert.equal(res.status, "pass");
  assert.deepEqual(jobIdsSeen, [{ root: "/repo", id: "R1", jobId: "J-42" }]);  // the child's afterSubmit->recordJobId fired with the submitted jobId
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForResult, pollToTerminal, TERMINAL } from "../jobs.mjs";

// -------- pollToTerminal (moved from panel.mjs; vendor-neutral) --------

test("pollToTerminal normalizes 'canceled' -> 'cancelled'", async () => {
  const getStatusFn = async () => ({ job: { status: "canceled" } });
  assert.equal(await pollToTerminal("j", { pollIntervalMs: 1, timeoutMs: 1000 }, getStatusFn), "cancelled");
});

test("pollToTerminal returns 'timeout' when no terminal state is ever reached", async () => {
  const getStatusFn = async () => ({ job: { status: "running" } });
  assert.equal(await pollToTerminal("j", { pollIntervalMs: 1, timeoutMs: 5 }, getStatusFn), "timeout");
});

test("pollToTerminal folds a persistent status-error into timeout (fail-closed, no throw)", async () => {
  const getStatusFn = async () => { throw new Error("status endpoint down"); };
  assert.equal(await pollToTerminal("j", { pollIntervalMs: 1, timeoutMs: 5 }, getStatusFn), "timeout");
});

test("TERMINAL includes both success and failure terminal states", () => {
  for (const s of ["completed", "succeeded", "failed", "error", "cancelled", "canceled"]) {
    assert.ok(TERMINAL.has(s), `TERMINAL missing ${s}`);
  }
});

// -------- waitForResult (C1): result ONLY on a success terminal (m10) --------

test("waitForResult returns result when the job reaches completed", async () => {
  let calls = 0;
  const getStatusFn = async () => ({ job: { status: calls++ < 1 ? "running" : "completed" } });
  const getResultFn = async () => ({ output: "done" });
  const r = await waitForResult("j1", { pollIntervalMs: 1, timeoutMs: 1000, getStatusFn, getResultFn });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.result, { output: "done" });
});

test("waitForResult returns a timeout sentinel and never fetches result on timeout", async () => {
  let resultCalled = false;
  const getStatusFn = async () => ({ job: { status: "running" } });
  const getResultFn = async () => { resultCalled = true; return {}; };
  const r = await waitForResult("j2", { pollIntervalMs: 1, timeoutMs: 5, getStatusFn, getResultFn });
  assert.equal(r.status, "timeout");
  assert.equal(r.job_id, "j2");
  assert.equal(resultCalled, false);
});

test("m10: a FAILURE terminal returns { status } with no result and never fetches it", async () => {
  let resultCalled = false;
  const getStatusFn = async () => ({ job: { status: "failed" } });
  const getResultFn = async () => { resultCalled = true; return {}; };
  const r = await waitForResult("j3", { pollIntervalMs: 1, timeoutMs: 1000, getStatusFn, getResultFn });
  assert.equal(r.status, "failed");
  assert.equal(r.result, undefined);
  assert.equal(resultCalled, false);
});

test("m10: a CANCELLED terminal returns { status:'cancelled' } with no result", async () => {
  let resultCalled = false;
  const getStatusFn = async () => ({ job: { status: "canceled" } });
  const getResultFn = async () => { resultCalled = true; return {}; };
  const r = await waitForResult("j4", { pollIntervalMs: 1, timeoutMs: 1000, getStatusFn, getResultFn });
  assert.equal(r.status, "cancelled");
  assert.equal(resultCalled, false);
});

test("m10: getResult throwing on a success terminal yields result_error, never orphans/throws", async () => {
  const getStatusFn = async () => ({ job: { status: "completed" } });
  const getResultFn = async () => { throw new Error("result fetch failed"); };
  const r = await waitForResult("j5", { pollIntervalMs: 1, timeoutMs: 1000, getStatusFn, getResultFn });
  assert.equal(r.status, "result_error");
  assert.equal(r.job_id, "j5");
  assert.equal(r.result, undefined);
});

// -------- not_found: the phantom-job signal is a DISTINCT terminal, never folded into timeout --------
// Bug fixed here: a missing job (task --background printed an id but never persisted a job file)
// surfaces from the companion status subcommand as "No job found". It used to be caught and folded
// into "timeout", making a job-that-never-existed indistinguishable from a job-that-is-too-slow.

test("pollToTerminal returns 'not_found' on TWO consecutive companion 'No job found' reads", async () => {
  let calls = 0;
  const getStatusFn = async () => { calls++; throw new Error("companion exited 1: No job found for id jP"); };
  const r = await pollToTerminal("jP", { pollIntervalMs: 1, timeoutMs: 5 }, getStatusFn);
  assert.equal(r, "not_found");
  // Store race: one missing read is no longer proof of a phantom (a
  // sibling saveState can transiently delete a live record; the worker's next
  // upsert resurrects it). Double-check, then terminal -- still no deadline wait.
  assert.equal(calls, 2);
});

test("pollToTerminal: a TRANSIENT missing read (record resurrected by worker upsert) is not not_found", async () => {
  let calls = 0;
  const getStatusFn = async () => {
    calls++;
    if (calls === 1) throw new Error("companion exited 1: No job found for id jRZ");
    if (calls === 2) return { job: { status: "running" } };
    return { job: { status: "completed" } };
  };
  const r = await pollToTerminal("jRZ", { pollIntervalMs: 1, timeoutMs: 5000 }, getStatusFn);
  assert.equal(r, "completed");
});

test("pollToTerminal does NOT treat 'No finished job found' (job exists, not done) as not_found", async () => {
  // "No finished job found" means the job EXISTS but has not finished -> still running/timeout,
  // never the phantom not_found terminal. Must stay fail-closed as timeout, not not_found.
  const getStatusFn = async () => { throw new Error("companion exited 1: No finished job found for id jR"); };
  assert.equal(await pollToTerminal("jR", { pollIntervalMs: 1, timeoutMs: 5 }, getStatusFn), "timeout");
});

test("waitForResult returns { status:'not_found' } and never fetches result for a phantom job", async () => {
  let resultCalled = false;
  const getStatusFn = async () => { throw new Error("companion exited 1: No job found for id jP2"); };
  const getResultFn = async () => { resultCalled = true; return {}; };
  const r = await waitForResult("jP2", { pollIntervalMs: 1, timeoutMs: 5, getStatusFn, getResultFn });
  assert.equal(r.status, "not_found"); // RED before change: "timeout"
  assert.equal(r.job_id, "jP2");
  assert.equal(r.result, undefined);
  assert.equal(resultCalled, false);
});

test("waitForResult still returns { status:'timeout' } for a job that never terminates (distinct from not_found)", async () => {
  const getStatusFn = async () => ({ job: { status: "running" } });
  const r = await waitForResult("jT", { pollIntervalMs: 1, timeoutMs: 5, getStatusFn });
  assert.equal(r.status, "timeout");
  assert.equal(r.job_id, "jT");
});

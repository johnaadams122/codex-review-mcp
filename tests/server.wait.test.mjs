import { test, mock, after } from "node:test";
import { installPolicyFixture, BETA } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";

// SCOPE: this file tests ONLY the server-handler
// wiring -- that maybeWait folds waitForResult's terminal status+result inline. It mocks
// waitForResult, so it deliberately does NOT (and cannot) exercise the ownership
// gate or the real submit-to-poll path. That coverage is NOT vacuous elsewhere:
//   - tests/jobs.same-session.test.mjs -- the FULLY UN-MOCKED submit-then-poll path
//     (real submitTaskViaFile + waitForResult + getStatus/getResult + real gate + real
//     in-process submitted set + real fixture companion subprocess), plus the (a)/(b)/deny
//     matrix across simulated server processes (fresh module instances);
//   - tests/jobs.ownership.test.mjs -- the same-session/owner two-path gate on every endpoint.

// Mock every jobs.mjs export that server.mjs (and its transitive panel/reviewers imports) touch,
// so no companion spawns. submitTask + waitForResult are the two the wait wiring exercises.
const fakeSubmitTask = mock.fn(async () => ({ job_id: "j1", status: "queued" }));
const fakeWaitForResult = mock.fn(async () => ({ status: "completed", result: { output: "ok" }, job_id: "j1" }));

await mock.module("../jobs.mjs", {
  exports: {
    submitTask: fakeSubmitTask,
    submitReview: mock.fn(async () => ({ job_id: "rev-1", status: "queued" })),
    submitAdversarialReview: mock.fn(async () => ({ job_id: "adv-1", status: "queued" })),
    submitTaskViaFile: mock.fn(async () => ({ job_id: "file-1", status: "queued" })),
    extractAnswerText: (r) => (r == null ? "" : typeof r === "string" ? r : r.output ?? ""),
    getStatus: mock.fn(async () => ({})),
    getResult: mock.fn(async () => ({})),
    listJobs: mock.fn(async () => []),
    cancelJob: mock.fn(async () => ({})),
    pollToTerminal: mock.fn(async () => "completed"),
    waitForResult: fakeWaitForResult,
    // direct.mjs (transitively loaded via admission.mjs) imports these
    isPidAlive: () => false,
    buildTreeKillArgs: (pid) => ["taskkill", "/PID", String(pid), "/T", "/F"]
  },
});

const { handleTask, handleWait } = await import("../server.mjs?wait=1");
const fx = installPolicyFixture({ after });
const SAFE_CWD = fx.dirOf(BETA);

// These deep-equality assertions use the projected contracts --
// the fold now runs waitForResult's result through project.mjs's projectResult/projectWait
// by default (minimal caller-facing shape) instead of passing it through byte-for-byte.
// fakeWaitForResult resolves { status:"completed", result:{ output:"ok" }, job_id:"j1" };
// projectResult("j1", { output:"ok" }, "completed") flattens to { status, job_id, output }
// (no touchedFiles/model -- the fake result carries no storedJob).

test("handleTask with wait:true folds submit + waitForResult into one inline PROJECTED result", async () => {
  fakeWaitForResult.mock.resetCalls();
  const res = await handleTask({ prompt: "do", cwd: SAFE_CWD, wait: true });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.waited, true);
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.result, { status: "completed", job_id: "j1", output: "ok" });
  assert.equal(fakeWaitForResult.mock.calls.length, 1);
});

test("handleTask with wait:true and verbose:true folds in the RAW waitForResult result untouched", async () => {
  fakeWaitForResult.mock.resetCalls();
  const res = await handleTask({ prompt: "do", cwd: SAFE_CWD, wait: true, verbose: true });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.waited, true);
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.result, { output: "ok" });
  assert.equal(fakeWaitForResult.mock.calls.length, 1);
});

test("handleTask default (no wait) returns a job_id and never waits", async () => {
  fakeWaitForResult.mock.resetCalls();
  const res = await handleTask({ prompt: "do", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.job_id, "j1");
  assert.equal(payload.waited, undefined);
  assert.equal(fakeWaitForResult.mock.calls.length, 0);
});

test("codex_wait (handleWait) blocks a loose job_id to completion and returns its PROJECTED result (minimal default)", async () => {
  const res = await handleWait({ job_id: "j1", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, "completed");
  assert.equal(payload.job_id, "j1");
  assert.equal(payload.output, "ok");
  assert.equal(payload.result, undefined, "projectWait flattens the answer -- there is no nested .result key");
});

test("codex_wait (handleWait) with verbose:true returns the RAW waitForResult outcome untouched", async () => {
  const res = await handleWait({ job_id: "j1", cwd: SAFE_CWD, verbose: true });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.result, { output: "ok" });
});

test("codex_wait (handleWait) result_error terminal carries the error in BOTH minimal and verbose modes", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({
    status: "result_error", job_id: "j-err", error: "companion timed out after 150ms"
  }));
  const minimal = await handleWait({ job_id: "j-err", cwd: SAFE_CWD });
  const minimalPayload = JSON.parse(minimal.content[0].text);
  assert.deepEqual(minimalPayload, { status: "result_error", job_id: "j-err", error: "companion timed out after 150ms" });

  fakeWaitForResult.mock.mockImplementationOnce(async () => ({
    status: "result_error", job_id: "j-err", error: "companion timed out after 150ms"
  }));
  const verbose = await handleWait({ job_id: "j-err", cwd: SAFE_CWD, verbose: true });
  const verbosePayload = JSON.parse(verbose.content[0].text);
  assert.deepEqual(verbosePayload, { status: "result_error", job_id: "j-err", error: "companion timed out after 150ms" });
});

test("codex_wait surfaces a timeout sentinel as a (non-error) result", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "timeout", job_id: "j9" }));
  const res = await handleWait({ job_id: "j9", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, "timeout");
  assert.equal(payload.job_id, "j9");
  assert.ok(!res.isError);
});

test("codex_wait maps a not_found sentinel (phantom job) through as a (non-error) result", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "not_found", job_id: "jP" }));
  const res = await handleWait({ job_id: "jP", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, "not_found");
  assert.equal(payload.job_id, "jP");
  assert.equal(payload.result, undefined);
  assert.ok(!res.isError);
});

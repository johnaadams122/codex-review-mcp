import { test, mock, after } from "node:test";
import { installPolicyFixture, BETA, DELTA, EPSILON } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectResult, projectStatus } from "../project.mjs";

// MCP adapter case: "MCP delegate handler -> isError:true for a conflicting call". Also
// covers the schema's raw `model` param, contract-honest description assertions, and
// the projector-wiring + verbose-threading coverage.

// Mock every jobs.mjs export server.mjs (and its transitive panel/reviewers/direct imports)
// touch, so no companion spawns. Pattern copied from tests/server.wait.test.mjs:14-36.
// Named consts (rather than anonymous mock.fn literals) so individual tests below can swap
// in per-call return values via mockImplementationOnce.
const fakeSubmitTask = mock.fn(async () => ({ job_id: "j1", status: "queued" }));
const fakeSubmitReview = mock.fn(async () => ({ job_id: "rev-1", status: "queued" }));
const fakeSubmitAdversarialReview = mock.fn(async () => ({ job_id: "adv-1", status: "queued" }));
const fakeGetStatus = mock.fn(async () => ({}));
const fakeGetResult = mock.fn(async () => ({}));
const fakeWaitForResult = mock.fn(async () => ({ status: "completed", result: {} }));

await mock.module("../jobs.mjs", {
  exports: {
    submitTask: fakeSubmitTask,
    submitReview: fakeSubmitReview,
    submitAdversarialReview: fakeSubmitAdversarialReview,
    submitTaskViaFile: mock.fn(async () => ({ job_id: "file-1", status: "queued" })),
    extractAnswerText: (r) => (r == null ? "" : typeof r === "string" ? r : r.output ?? ""),
    getStatus: fakeGetStatus,
    getResult: fakeGetResult,
    listJobs: mock.fn(async () => []),
    cancelJob: mock.fn(async () => ({})),
    pollToTerminal: mock.fn(async () => "completed"),
    waitForResult: fakeWaitForResult,
    // direct.mjs (transitively loaded via admission.mjs) imports these
    isPidAlive: () => false,
    buildTreeKillArgs: (pid) => ["taskkill", "/PID", String(pid), "/T", "/F"]
  },
});

const { handleDelegate, handleTask, handleReview, handleAdversarialReview, handleWait, server } =
  await import("../server.mjs?projection=1");
const fx = installPolicyFixture({ after });
const SAFE_CWD = fx.dirOf(BETA);
const PII_CWD = fx.dirOf(DELTA);
const PHI_CWD = fx.dirOf(EPSILON);

// Fixture loading, same pattern as tests/project.test.mjs:12-18.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "jobs");
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name + ".json"), "utf8"));
}
const taskCompleted = loadFixture("task-completed");
const reviewNative = loadFixture("review-native-completed");
const adversarial = loadFixture("adversarial-completed");
const statusRunning = loadFixture("status-running");

// Schema-assertion pattern (as in tests/server.max.test.mjs): server._registeredTools,
// safeParse wrapper.
function delegateSchema() {
  const s = server._registeredTools.delegate.inputSchema;
  return typeof s.safeParse === "function" ? s : z.object(s);
}

// Generic per-tool schema accessor + minimal-valid-args table, used by the
// schema assertions below and reusable for any tool (not just delegate).
function toolSchema(name) {
  const s = server._registeredTools[name].inputSchema;
  return typeof s.safeParse === "function" ? s : z.object(s);
}
function toolShape(name) {
  const s = server._registeredTools[name].inputSchema;
  return s.shape ?? s;
}

test("(f) handleDelegate: a conflicting quality+effort override returns isError:true with the failure envelope", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await handleDelegate({
    task: "implement the feature",
    quality: "flagship",
    effort: "medium",
    cwd: SAFE_CWD
  });
  assert.equal(r.isError, true);
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.reason, "conflicting_override");
  assert.ok(payload.result.error);
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "submitTask must not be called on a normalization failure");
});

test("(f) handleDelegate: a normal (non-conflicting) call has no isError", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await handleDelegate({ task: "plan the migration strategy", tier: "claude", cwd: SAFE_CWD });
  assert.equal(r.isError, undefined);
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.selected_tier, "claude");
  assert.equal(payload.requested_quality, null);
});

// The delegate tool's registered schema has a validated raw `model` param.

test("delegate schema: accepts a complete, row-consistent raw model+effort pair", () => {
  const result = delegateSchema().safeParse({ task: "x", model: "gpt-6.1-sol", effort: "medium" });
  assert.equal(result.success, true);
});

test("delegate schema: accepts task alone with model omitted (optional-chain regression pin)", () => {
  const result = delegateSchema().safeParse({ task: "x" });
  assert.equal(result.success, true);
});

test("delegate schema: rejects an empty-string model", () => {
  const result = delegateSchema().safeParse({ task: "x", model: "" });
  assert.equal(result.success, false);
});

test("delegate schema: rejects a whitespace-only model", () => {
  const result = delegateSchema().safeParse({ task: "x", model: "   " });
  assert.equal(result.success, false);
});

test("handleDelegate: a complete raw model+effort pair reaches submitTask verbatim and the envelope carries resolved_quality custom", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await handleDelegate({
    task: "implement the feature",
    tier: "codex",
    model: "gpt-6.1-sol",
    effort: "medium",
    cwd: SAFE_CWD
  });
  assert.equal(r.isError, undefined);
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.resolved_quality, "custom");
  assert.equal(payload.model, "gpt-6.1-sol");
  assert.equal(payload.effort, "medium");
  assert.equal(fakeSubmitTask.mock.calls.length, 1, "submitTask must be called exactly once");
  const submitOpts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(submitOpts.model, "gpt-6.1-sol");
  assert.equal(submitOpts.effort, "medium");
});

test("delegate tool description strings make no 'override' claim about raw quality/model/effort fields", () => {
  const tool = server._registeredTools.delegate;
  const shape = tool.inputSchema.shape ?? tool.inputSchema;
  assert.doesNotMatch(tool.description, /override/i);
  assert.doesNotMatch(shape.quality.description ?? "", /override/i);
  assert.doesNotMatch(shape.model?.description ?? "", /override/i);
  assert.doesNotMatch(shape.effort?.description ?? "", /override/i);
});

// ==========================================================================================
// project.mjs is wired into server.mjs's four payload seams (codex_status, codex_result,
// codex_wait, and the shared maybeWait fold used by codex_task/codex_review/
// codex_adversarial_review), thread `verbose` end-to-end, and assert the six schemas.
//
// Note: the SDK's registered-tool object (SDK 1.29.0) exposes the callback under the
// property `handler`, not `callback` (`Object.keys(server._registeredTools.codex_status)`
// includes `handler`; there is no `.callback`). Tests below drive tools via `.handler(args)` -- the
// exact runtime property -- which is the real registered callback the MCP transport invokes.
// ==========================================================================================

// -------------------- (a) codex_result: minimal vs verbose --------------------

test("(a) codex_result tool: minimal (default) projects the task fixture via projectResult", async () => {
  fakeGetResult.mock.mockImplementationOnce(async () => taskCompleted);
  const res = await server._registeredTools.codex_result.handler({ job_id: "task-8f3ac1", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, projectResult("task-8f3ac1", taskCompleted));
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, taskCompleted.storedJob.result.rawOutput);
});

test("(a) codex_result tool: verbose:true returns the full raw payload untouched", async () => {
  fakeGetResult.mock.mockImplementationOnce(async () => taskCompleted);
  const res = await server._registeredTools.codex_result.handler({ job_id: "task-8f3ac1", cwd: SAFE_CWD, verbose: true });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, taskCompleted);
});

// -------------------- (b) codex_status: minimal vs verbose --------------------

test("(b) codex_status tool: minimal (default) projects status-running via projectStatus", async () => {
  fakeGetStatus.mock.mockImplementationOnce(async () => statusRunning);
  const res = await server._registeredTools.codex_status.handler({ job_id: "task-r55e1", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, projectStatus("task-r55e1", statusRunning));
  assert.equal(payload.status, "running");
  assert.equal(payload.elapsed, "0m 47s");
});

test("(b) codex_status tool: verbose:true returns the full raw snapshot untouched", async () => {
  fakeGetStatus.mock.mockImplementationOnce(async () => statusRunning);
  const res = await server._registeredTools.codex_status.handler({ job_id: "task-r55e1", cwd: SAFE_CWD, verbose: true });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, statusRunning);
});

// -------------------- (c) codex_wait: success projected; result_error carries error in BOTH
// modes; timeout/not_found/cancelled collapse to {status, job_id} --------------------

test("(c) codex_wait tool: success (completed) minimal default projects via projectResult", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "task-8f3ac1", result: taskCompleted }));
  const res = await server._registeredTools.codex_wait.handler({ job_id: "task-8f3ac1", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, projectResult("task-8f3ac1", taskCompleted, "completed"));
});

test("(c) codex_wait tool: success (completed) verbose:true returns the raw waitForResult outcome", async () => {
  const raw = { status: "completed", job_id: "task-8f3ac1", result: taskCompleted };
  fakeWaitForResult.mock.mockImplementationOnce(async () => raw);
  const res = await server._registeredTools.codex_wait.handler({ job_id: "task-8f3ac1", cwd: SAFE_CWD, verbose: true });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, raw);
});

test("(c) codex_wait tool: result_error carries error in minimal mode", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "result_error", job_id: "task-99", error: "companion timed out" }));
  const res = await server._registeredTools.codex_wait.handler({ job_id: "task-99", cwd: SAFE_CWD });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, { status: "result_error", job_id: "task-99", error: "companion timed out" });
});

test("(c) codex_wait tool: result_error carries error in verbose mode too", async () => {
  const raw = { status: "result_error", job_id: "task-99", error: "companion timed out" };
  fakeWaitForResult.mock.mockImplementationOnce(async () => raw);
  const res = await server._registeredTools.codex_wait.handler({ job_id: "task-99", cwd: SAFE_CWD, verbose: true });
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload, raw);
});

for (const status of ["timeout", "not_found", "cancelled"]) {
  test(`(c) codex_wait tool: ${status} collapses to {status, job_id} in minimal mode`, async () => {
    fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status, job_id: "task-77" }));
    const res = await server._registeredTools.codex_wait.handler({ job_id: "task-77", cwd: SAFE_CWD });
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload, { status, job_id: "task-77" });
  });

  test(`(c) codex_wait tool: ${status} collapses to {status, job_id} in verbose mode too (nothing to project)`, async () => {
    fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status, job_id: "task-77" }));
    const res = await server._registeredTools.codex_wait.handler({ job_id: "task-77", cwd: SAFE_CWD, verbose: true });
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload, { status, job_id: "task-77" });
  });
}

// -------------------- (d) wait:true + write_blocked regression, BOTH modes --------------------
// write_blocked lives on the maybeWait fold's BASE (handleTask base, server.mjs handleTask),
// never on the result/status payload -- it must survive the fold regardless of verbose.

test("(d) codex_task tool: wait:true on a PHI cwd with write:true -- write_blocked survives the fold in MINIMAL mode", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "j1", result: taskCompleted }));
  const res = await server._registeredTools.codex_task.handler({ prompt: "fix the thing", write: true, cwd: PHI_CWD, wait: true });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.write_blocked, true, "write must be reported blocked on a PHI cwd");
  assert.equal(payload.waited, true);
  assert.deepEqual(payload.result, projectResult("j1", taskCompleted, "completed"));
});

test("(d) codex_task tool: wait:true on a PHI cwd with write:true -- write_blocked survives the fold in VERBOSE mode", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "j1", result: taskCompleted }));
  const res = await server._registeredTools.codex_task.handler({ prompt: "fix the thing", write: true, cwd: PHI_CWD, wait: true, verbose: true });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.write_blocked, true, "write must be reported blocked on a PHI cwd");
  assert.equal(payload.waited, true);
  assert.deepEqual(payload.result, taskCompleted);
});

// Same regression through the exported handler signature directly (not just the registered tool).
test("(d) handleTask (exported handler): write_blocked survives the wait fold in both modes", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "j1", result: taskCompleted }));
  const minimal = await handleTask({ prompt: "x", write: true, cwd: PHI_CWD, wait: true });
  assert.equal(JSON.parse(minimal.content[0].text).write_blocked, true);

  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "j1", result: taskCompleted }));
  const verbose = await handleTask({ prompt: "x", write: true, cwd: PHI_CWD, wait: true, verbose: true });
  assert.equal(JSON.parse(verbose.content[0].text).write_blocked, true);
});

// -------------------- (e) all six tools driven through server._registeredTools[name].handler,
// asserting `verbose` reaches the fold/projection --------------------
// codex_status/codex_result/codex_wait/codex_task are already exercised above via .handler;
// this section adds the remaining two (codex_review, codex_adversarial_review).

test("(e) codex_review tool (.handler): wait:true threads verbose into the fold/projection", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "rev-1", result: reviewNative }));
  const minimal = await server._registeredTools.codex_review.handler({ scope: "auto", cwd: SAFE_CWD, wait: true });
  assert.deepEqual(JSON.parse(minimal.content[0].text).result, projectResult("rev-1", reviewNative, "completed"));

  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "rev-1", result: reviewNative }));
  const verbose = await server._registeredTools.codex_review.handler({ scope: "auto", cwd: SAFE_CWD, wait: true, verbose: true });
  assert.deepEqual(JSON.parse(verbose.content[0].text).result, reviewNative);
});

test("(e) codex_adversarial_review tool (.handler): wait:true threads verbose into the fold/projection", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "adv-1", result: adversarial }));
  const minimal = await server._registeredTools.codex_adversarial_review.handler({ scope: "auto", cwd: SAFE_CWD, wait: true });
  assert.deepEqual(JSON.parse(minimal.content[0].text).result, projectResult("adv-1", adversarial, "completed"));

  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "adv-1", result: adversarial }));
  const verbose = await server._registeredTools.codex_adversarial_review.handler({ scope: "auto", cwd: SAFE_CWD, wait: true, verbose: true });
  assert.deepEqual(JSON.parse(verbose.content[0].text).result, adversarial);
});

// Same regression through the exported handleReview/handleAdversarialReview signatures directly.
test("(e) handleReview / handleAdversarialReview (exported handlers): verbose reaches the fold", async () => {
  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "rev-1", result: reviewNative }));
  const rev = await handleReview({ scope: "auto", cwd: SAFE_CWD, wait: true, verbose: true });
  assert.deepEqual(JSON.parse(rev.content[0].text).result, reviewNative);

  fakeWaitForResult.mock.mockImplementationOnce(async () => ({ status: "completed", job_id: "adv-1", result: adversarial }));
  const adv = await handleAdversarialReview({ scope: "auto", cwd: SAFE_CWD, wait: true, verbose: true });
  assert.deepEqual(JSON.parse(adv.content[0].text).result, adversarial);
});

// -------------------- (f) schema assertions: six tools accept boolean verbose and reject
// non-boolean; delegate + codex_list_jobs carry NO verbose key --------------------

const VERBOSE_TOOLS = {
  codex_status: { job_id: "j1" },
  codex_result: { job_id: "j1" },
  codex_wait: { job_id: "j1" },
  codex_task: { prompt: "p" },
  codex_review: {},
  codex_adversarial_review: {}
};

for (const [name, minimalArgs] of Object.entries(VERBOSE_TOOLS)) {
  test(`(f) ${name} schema: accepts boolean verbose`, () => {
    const result = toolSchema(name).safeParse({ ...minimalArgs, verbose: true });
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  test(`(f) ${name} schema: rejects a non-boolean verbose`, () => {
    const result = toolSchema(name).safeParse({ ...minimalArgs, verbose: "yes" });
    assert.equal(result.success, false);
  });
}

test("(f) delegate schema carries NO verbose key (not projected)", () => {
  assert.equal(toolShape("delegate").verbose, undefined);
});

test("(f) codex_list_jobs schema carries NO verbose key (not projected)", () => {
  assert.equal(toolShape("codex_list_jobs").verbose, undefined);
});

// -------------------- description strings advertise minimal-default + verbose escape hatch
// --------------------

for (const name of Object.keys(VERBOSE_TOOLS)) {
  test(`${name} description mentions the verbose escape hatch`, () => {
    assert.match(server._registeredTools[name].description, /verbose/i);
  });
}

// Codex built-tree review 2026-10-08, finding 6: the codex_task `write` description must match the
// policy. Writes follow each project row's `write` flag (owner parity ruling 2026-08-22): a PII row
// with write:true is NOT hard-blocked, while unknown folders and write:false rows run read-only.
test("codex_task write description matches the policy-row rule, not a blanket PII hard-block", async (t) => {
  const desc = toolShape("codex_task").write.description;
  assert.doesNotMatch(desc, /hard-blocked in PII/i);
  assert.match(desc, /write: ?true/);
  assert.match(desc, /write_blocked/);
  const { admit } = await import("../admission.mjs");
  const { ALPHA } = await import("./helpers/policy-fixture.mjs");
  const fx = installPolicyFixture(t);
  const d = admit({ kind: "task", cwd: fx.dirOf(ALPHA), write: true });
  assert.equal(d.policy.pii_sensitive, true);
  assert.equal(d.effective_write, true, "a pii:true/write:true row writes, as the description now says");
});

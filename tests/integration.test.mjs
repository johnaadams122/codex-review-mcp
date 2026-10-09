import { test } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Point companion resolver to the fake companion before importing jobs.
// resolveCompanionPath() reads CLAUDE_PLUGIN_ROOT at call time, so setting
// it here before the dynamic import is sufficient.
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");

// Cache-bust to get a fresh jobs.mjs not shared with unit test mocks
const { submitTask, getStatus, getResult, cancelJob, listJobs } =
  await import("../jobs.mjs?integration=1");

test("submitTask returns a job_id with queued status", async () => {
  const job = await submitTask("implement the feature", {});
  assert.equal(typeof job.job_id, "string");
  assert.ok(job.job_id.length > 0);
  assert.equal(job.status, "queued");
});

test("getStatus returns completed status for a known job", async () => {
  const snapshot = await getStatus("task-fake001", null);
  const job = snapshot.job ?? snapshot;
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
});

test("getResult returns a non-empty output string", async () => {
  const result = await getResult("task-fake001", null);
  assert.equal(typeof result.output, "string");
  assert.ok(result.output.length > 0);
  assert.equal(result.status, "completed");
});

test("cancelJob returns cancelled: true", async () => {
  const result = await cancelJob("task-fake001", null);
  assert.equal(result.cancelled, true);
  assert.equal(result.jobId, "task-fake001");
});

test("listJobs returns an array with at least one entry", async () => {
  const jobs = await listJobs({});
  assert.ok(Array.isArray(jobs));
  assert.ok(jobs.length > 0);
  assert.equal(typeof jobs[0].jobId, "string");
});

test("companion timeout tree-kills the process and rejects", async () => {
  const jobs = await import("../jobs.mjs?timeout=1");
  const prevEnv = process.env.CODEX_COMPANION_TIMEOUT_MS;
  process.env.CODEX_COMPANION_TIMEOUT_MS = "150";
  let killedPid = null;
  jobs._internals.killProcessTree = (pid) => { killedPid = pid; };
  await assert.rejects(jobs.runCompanion(["hang", "--json"], {}), /timed out/);
  assert.ok(killedPid !== null, "killProcessTree was invoked with the companion pid");
  process.env.CODEX_COMPANION_TIMEOUT_MS = prevEnv;
});

test("cancelJob tree-kills a still-alive worker (pre-cancel pid snapshot)", async () => {
  const jobs = await import("../jobs.mjs?cancel=1");
  let killed = null;
  jobs._internals.killTreeVerified = async (pid) => { killed = pid; return { verified: true }; };
  const result = await jobs.cancelJob("live-123", null,
    { getPidCommandLineFn: () => "node codex-companion.mjs task-worker --job-id live-123" });
  assert.equal(killed, process.pid);
  assert.deepEqual(result.kill, { pid: process.pid, verified: true });
});

function setEnv(name, value) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => { if (prev === undefined) delete process.env[name]; else process.env[name] = prev; };
}

test("getStatus times out on the CONTROL budget, not the 300s data budget", async () => {
  const jobs = await import("../jobs.mjs?ctl=1");
  const r1 = setEnv("CODEX_CONTROL_TIMEOUT_MS", "150");
  const r2 = setEnv("CODEX_COMPANION_TIMEOUT_MS", "600000");   // huge data budget: must not apply
  jobs._internals.killProcessTree = () => {};
  const t0 = Date.now();
  await assert.rejects(jobs.getStatus("hang-ctl-1", null), /timed out after 150ms/);
  assert.ok(Date.now() - t0 < 5000, "control op rejected on the control budget");
  r1(); r2();
});

test("cancelJob times out on the CONTROL budget (the cancel-hang incident class)", async () => {
  const jobs = await import("../jobs.mjs?ctl=2");
  const r1 = setEnv("CODEX_CONTROL_TIMEOUT_MS", "150");
  const r2 = setEnv("CODEX_COMPANION_TIMEOUT_MS", "600000");
  jobs._internals.killProcessTree = () => {};
  await assert.rejects(jobs.cancelJob("hang-ctl-2", null), /timed out after 150ms/);
  r1(); r2();
});

test("data plane ignores CODEX_CONTROL_TIMEOUT_MS (budgets are independent)", async () => {
  const jobs = await import("../jobs.mjs?ctl=3");
  const r1 = setEnv("CODEX_CONTROL_TIMEOUT_MS", "600000");     // huge control budget
  const r2 = setEnv("CODEX_COMPANION_TIMEOUT_MS", "150");      // tiny data budget
  jobs._internals.killProcessTree = () => {};
  await assert.rejects(jobs.runCompanion(["hang", "--json"], {}), /timed out after 150ms/);
  r1(); r2();
});

test("defaults -- control 30000ms, data 300000ms", async () => {
  const jobs = await import("../jobs.mjs?ctl=4");
  const r1 = setEnv("CODEX_CONTROL_TIMEOUT_MS", undefined);
  const r2 = setEnv("CODEX_COMPANION_TIMEOUT_MS", undefined);
  assert.equal(jobs.controlTimeoutMs(), 30000);
  assert.equal(jobs.companionTimeoutMs(), 300000);
  r1(); r2();
});

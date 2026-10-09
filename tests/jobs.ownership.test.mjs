// Confidentiality: codex_status / codex_result / codex_wait / codex_list_jobs
// must not return persisted prompts or raw results across ALL cwd stores without
// an ownership check. These tests pin the read-boundary
// owner gate (cross-store fail-closed), the disk-scan owner gate, PII summary
// redaction, and legacy-record handling wired into jobs.mjs.
//
// The same-session (a) path is an IN-PROCESS submitted-job registry
// (a job THIS process submitted), not a
// forgeable on-disk token sidecar. Tests inject `submittedJobs` (a Map jobId -> cwd)
// to model exactly which jobs this process submitted; an empty Map means "submitted
// nothing", so ownership is decided purely by the owner-workspace path (b).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getStatus, getResult, listJobs, waitForResult, readJobRecordFromDisk } from "../jobs.mjs";
import { resolveWorkspaceRootLocal } from "../job-guard.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, ALPHA } from "./helpers/policy-fixture.mjs";

// A server instance that submitted NOTHING this session (empty registry). Injecting an
// empty Map both models "path (a) can never grant" and isolates these tests from any job
// another test recorded in the shared module registry.
const SELF = { selfWorkspaceRoot: "C:/proj/self", selfStoreDir: "self-store-0000", submittedJobs: new Map() };
const FOREIGN_CWD = "C:/proj/foreign";
const fx = installPolicyFixture({ after });
const PF = fx.dirOf(ALPHA);   // a pii project in the synthetic policy table
// The server owns the workspace its own folder resolves to (the nearest folder holding .git, else the folder
// itself). A temp folder can sit inside a git checkout (CI keeps its temp folder in the clone), so the owner
// workspace is resolved the same way rather than assumed to be PF itself.
const PF_WORKSPACE = resolveWorkspaceRootLocal(PF);

// ---------- codex_status ----------

test("getStatus: a foreign cwd is refused fail-closed (cross_store); the companion is never spawned", async () => {
  let called = false;
  await assert.rejects(
    getStatus("task-x", FOREIGN_CWD, { ...SELF, runCompanionFn: async () => { called = true; return { stdout: "{}" }; } }),
    (e) => e.code === "cross_store"
  );
  assert.equal(called, false);
});

test("getStatus: an owned read strips request.prompt and neutralizes the summary", async () => {
  const snap = await getStatus("task-x", null, {
    resolvePolicy: () => ({ name: "project_beta", pii_sensitive: false }),
    runCompanionFn: async () => ({ stdout: JSON.stringify({
      job: { id: "task-x", kind: "task", jobClass: "task", status: "completed", phase: "done",
             summary: "SECRET-PROMPT-BODY", request: { prompt: "SECRET-PROMPT-BODY", cwd: "x" },
             result: { rawOutput: "answer" } } }) }),
  });
  const job = snap.job ?? snap;
  assert.equal(job.request.prompt, undefined);        // prompt copy stripped
  assert.equal(job.result.rawOutput, "answer");       // answer preserved
  assert.equal(job.status, "completed");
});

test("getStatus: a PII-owned read emits NO prompt text anywhere in the record", async () => {
  const snap = await getStatus("task-pf", PF, {
    selfWorkspaceRoot: PF_WORKSPACE, selfStoreDir: "pf-store",
    runCompanionFn: async () => ({ stdout: JSON.stringify({
      job: { id: "task-pf", kind: "task", jobClass: "task", status: "completed",
             title: "balance report SSN 123-45-6789",
             summary: "compute net worth accounts total 123456 SSN 123-45-6789",
             request: { prompt: "compute net worth accounts total 123456 SSN 123-45-6789", cwd: PF },
             result: { rawOutput: "net worth computed" } } }) }),
  });
  const blob = JSON.stringify(snap);
  assert.ok(!blob.includes("123-45-6789"));
  assert.ok(!blob.includes("123456"));
  assert.ok(!blob.includes("net worth accounts"));
  const job = snap.job ?? snap;
  assert.equal(job.request.prompt, undefined);
  assert.equal(job.result.rawOutput, "net worth computed");   // the owner still gets the answer
});

// ---------- codex_result ----------

test("getResult: a foreign cwd is refused fail-closed (cross_store)", async () => {
  let called = false;
  await assert.rejects(
    getResult("task-x", FOREIGN_CWD, { ...SELF, runCompanionFn: async () => { called = true; return { stdout: "{}" }; } }),
    (e) => e.code === "cross_store"
  );
  assert.equal(called, false);
});

test("getResult: the disk-scan fallback will NOT recover a foreign-owned record (fail closed)", async (t) => {
  const root = tempDirFor(t, "gate-getresult-");
  const foreignJobs = path.join(root, "foreign-ws-bbb", "jobs");
  fs.mkdirSync(foreignJobs, { recursive: true });
  fs.writeFileSync(path.join(foreignJobs, "task-f.json"),
    JSON.stringify({ id: "task-f", status: "completed", workspaceRoot: "C:/proj/foreign", result: { rawOutput: "leak" } }));
  const missing = (id) => { const e = new Error(`companion exited 1: No finished job found for "${id}"`); return e; };
  await assert.rejects(
    getResult("task-f", null, {
      selfWorkspaceRoot: "C:/proj/self", selfStoreDir: "self-store-0000",
      processCwd: "C:/proj/self",   // owner-launched server (null-cwd semantics)
      roots: [root], submittedJobs: new Map(),
      runCompanionFn: async () => { throw missing("task-f"); },
      getStatusFn: async () => { throw missing("task-f"); },   // status fallback also empty
    }),
    /No (?:finished )?job found/
  );
});

test("getResult: the disk-scan fallback recovers an OWNED record and redacts its prompt", async (t) => {
  const root = tempDirFor(t, "gate-getresult-own-");
  const ownJobs = path.join(root, "self-ws-aaa", "jobs");
  fs.mkdirSync(ownJobs, { recursive: true });
  fs.writeFileSync(path.join(ownJobs, "task-o.json"), JSON.stringify({
    id: "task-o", status: "completed", workspaceRoot: "C:/proj/self",
    summary: "OWNER-PROMPT", request: { prompt: "OWNER-PROMPT" }, result: { rawOutput: '{"ok":true}' } }));
  const missing = (id) => { const e = new Error(`companion exited 1: No finished job found for "${id}"`); return e; };
  const r = await getResult("task-o", null, {
    selfWorkspaceRoot: "C:/proj/self", selfStoreDir: "self-ws-aaa",
    processCwd: "C:/proj/self",   // owner-launched server (null-cwd semantics)
    roots: [root],
    resolvePolicy: () => ({ name: "project_beta", pii_sensitive: false }),
    runCompanionFn: async () => { throw missing("task-o"); },
  });
  assert.equal(r._diskRecovered, true);
  assert.equal(r.status, "completed");
  assert.equal(r.storedJob.result.rawOutput, '{"ok":true}');   // answer preserved
  assert.equal(r.storedJob.request.prompt, undefined);          // prompt stripped
});

// ---------- readJobRecordFromDisk owner gate ----------

test("readJobRecordFromDisk: returns a record only from an OWNED store; a foreign store is denied", (t) => {
  const root = tempDirFor(t, "gate-disk-");
  const ownJobs = path.join(root, "self-ws-aaa", "jobs");
  fs.mkdirSync(ownJobs, { recursive: true });
  fs.writeFileSync(path.join(ownJobs, "task-own.json"),
    JSON.stringify({ id: "task-own", status: "completed", workspaceRoot: "C:/proj/self", result: { rawOutput: "x" } }));
  const foreignJobs = path.join(root, "foreign-ws-bbb", "jobs");
  fs.mkdirSync(foreignJobs, { recursive: true });
  fs.writeFileSync(path.join(foreignJobs, "task-foreign.json"),
    JSON.stringify({ id: "task-foreign", status: "completed", workspaceRoot: "C:/proj/foreign", result: { rawOutput: "y" } }));
  const deps = { roots: [root], selfWorkspaceRoot: "C:/proj/self", selfStoreDir: "self-ws-aaa", submittedJobs: new Map() };
  assert.equal(readJobRecordFromDisk("task-own", deps).id, "task-own");
  assert.equal(readJobRecordFromDisk("task-foreign", deps), null);   // cross-store denied
});

test("readJobRecordFromDisk: a legacy record (no workspaceRoot) is visible only from its physically-owned store", (t) => {
  const root = tempDirFor(t, "gate-legacy-");
  const dir = path.join(root, "self-ws-aaa", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task-legacy.json"),
    JSON.stringify({ id: "task-legacy", status: "completed", result: { rawOutput: "z" } }));
  // physical store dir == self store dir -> owned
  assert.equal(readJobRecordFromDisk("task-legacy",
    { roots: [root], selfWorkspaceRoot: "C:/other", selfStoreDir: "self-ws-aaa", submittedJobs: new Map() }).id, "task-legacy");
  // physical store dir != self, and the record has no workspaceRoot -> fail closed
  assert.equal(readJobRecordFromDisk("task-legacy",
    { roots: [root], selfWorkspaceRoot: "C:/other", selfStoreDir: "different-store", submittedJobs: new Map() }), null);
});

// ---------- codex_list_jobs ----------

test("listJobs: a foreign cwd with nothing submitted lists nothing (fail-closed empty, no spawn)", async () => {
  let called = false;
  const jobs = await listJobs({ cwd: FOREIGN_CWD }, {
    ...SELF,
    runCompanionFn: async () => { called = true; return { stdout: JSON.stringify({ running: [{ jobId: "x" }] }) }; },
  });
  assert.deepEqual(jobs, []);
  assert.equal(called, false);   // nothing there is readable -> the foreign store is never queried
});

test("listJobs: an owned cwd returns items with prompts redacted", async () => {
  const jobs = await listJobs({ cwd: null }, {
    resolvePolicy: () => ({ name: "project_beta", pii_sensitive: false }),
    runCompanionFn: async () => ({ stdout: JSON.stringify({ running: [
      { jobId: "j1", id: "j1", status: "running", summary: "raw prompt text", request: { prompt: "raw prompt text" } } ] }) }),
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].request?.prompt, undefined);
});

// ---------- codex_wait ----------

test("waitForResult: an unowned foreign cwd fails closed immediately (cross_store), not a slow timeout", async () => {
  await assert.rejects(
    waitForResult("j1", { cwd: FOREIGN_CWD, timeoutMs: 50, ...SELF }),
    (e) => e.code === "cross_store"
  );
});

// ---------- same-session (a) path via the IN-PROCESS submitted-job set ----------
// Gating read-back on the server's OWN cwd only would fail closed for an admitted
// foreign TARGET cwd (the primary delegate/review/gate/panel pattern) -- an
// inaccessible job. An on-disk token sidecar would be forgeable. So a job THIS
// process submitted is owned for
// read-back regardless of the (admitted) target cwd -- tracked in an in-process Map,
// injected here as `submittedJobs`. Only the companion transport is mocked; the real
// gate runs.

test("getStatus: a same-session submit admits a FOREIGN target cwd (submit-then-poll restored)", async () => {
  let calledCwd = null;
  const snap = await getStatus("job-tok", FOREIGN_CWD, {
    submittedJobs: new Map([["job-tok", FOREIGN_CWD]]), selfWorkspaceRoot: "C:/proj/self",
    resolvePolicy: () => ({ name: "project_beta", pii_sensitive: false }),
    runCompanionFn: async (args, o) => { calledCwd = o.cwd; return { stdout: JSON.stringify({
      job: { id: "job-tok", kind: "review", status: "completed",
             summary: "SECRET-PROMPT", request: { prompt: "SECRET-PROMPT" }, result: { rawOutput: "ok" } } }) }; },
  });
  const job = snap.job ?? snap;
  assert.equal(job.status, "completed");
  assert.equal(job.request.prompt, undefined);     // redaction still applies on the same-session path
  assert.equal(calledCwd, FOREIGN_CWD);            // companion WAS spawned for the admitted foreign cwd
});

test("getStatus: a job this process did NOT submit on a foreign cwd is refused (cross_store), no spawn", async () => {
  let called = false;
  await assert.rejects(
    getStatus("job-tok2", FOREIGN_CWD, {
      submittedJobs: new Map(), selfWorkspaceRoot: "C:/proj/self",
      runCompanionFn: async () => { called = true; return { stdout: "{}" }; } }),
    (e) => e.code === "cross_store");
  assert.equal(called, false);
});

test("getStatus: an unsubmitted job on the OWNER cwd is still admitted (owner path -- cross-session pickup)", async () => {
  const snap = await getStatus("job-own", "C:/proj/self", {
    submittedJobs: new Map(), selfWorkspaceRoot: "C:/proj/self",
    resolvePolicy: () => ({ name: "project_beta", pii_sensitive: false }),
    runCompanionFn: async () => ({ stdout: JSON.stringify({
      job: { id: "job-own", status: "completed", result: { rawOutput: "ok" } } }) }),
  });
  assert.equal((snap.job ?? snap).status, "completed");
});

test("waitForResult: a same-session submit admits a FOREIGN-cwd wait (review wait:true / panel poll)", async () => {
  const r = await waitForResult("job-w", {
    cwd: FOREIGN_CWD, timeoutMs: 1000, pollIntervalMs: 1,
    submittedJobs: new Map([["job-w", FOREIGN_CWD]]), selfWorkspaceRoot: "C:/proj/self",
    getStatusFn: async () => ({ job: { status: "completed" } }),
    getResultFn: async () => ({ output: "ok" }),
  });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.result, { output: "ok" });
});

test("cancelJob-class gate: a same-session submit admits a foreign-cwd cancel; an unsubmitted job is refused", async () => {
  const { cancelJob } = await import("../jobs.mjs");
  // unsubmitted job on a foreign cwd -> cross_store, no companion cancel spawn
  let spawned = false;
  await assert.rejects(
    cancelJob("job-c", FOREIGN_CWD, { submittedJobs: new Map(), selfWorkspaceRoot: "C:/proj/self",
      runCompanionFn: async () => { spawned = true; return { stdout: "{}" }; },
      getStatusFn: async () => ({ job: { status: "running", pid: 0 } }) }),
    (e) => e.code === "cross_store");
  assert.equal(spawned, false);
  // same-session submit -> admitted (companion cancel runs)
  let cancelArgs = null;
  const r = await cancelJob("job-c", FOREIGN_CWD, { submittedJobs: new Map([["job-c", FOREIGN_CWD]]), selfWorkspaceRoot: "C:/proj/self",
    getStatusFn: async () => ({ job: { id: "job-c", status: "running", pid: 0 } }),
    runCompanionFn: async (args) => { cancelArgs = args; return { stdout: JSON.stringify({ jobId: "job-c", status: "cancelled" }) }; } });
  assert.equal(cancelArgs[0], "cancel");
  assert.equal(r.status, "cancelled");
});

test("listJobs: a foreign cwd surfaces ONLY this session's submitted jobs (union path a), others dropped + redacted", async () => {
  let called = false;
  const jobs = await listJobs({ cwd: FOREIGN_CWD }, {
    submittedJobs: new Map([["mine-1", FOREIGN_CWD]]), selfWorkspaceRoot: "C:/proj/self",
    resolvePolicy: () => ({ name: "project_beta", pii_sensitive: false }),
    runCompanionFn: async () => { called = true; return { stdout: JSON.stringify({ running: [
      { id: "mine-1", jobId: "mine-1", status: "running", summary: "p", request: { prompt: "p" } },
      { id: "theirs-9", jobId: "theirs-9", status: "running", summary: "q", request: { prompt: "q" } } ] }) }; },
  });
  assert.equal(called, true);                       // we submitted a job under this cwd -> the store is worth querying
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "mine-1");               // only OUR submitted job survives; the stranger is dropped
  assert.equal(jobs[0].request?.prompt, undefined); // and it is prompt-redacted
});

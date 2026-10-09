import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  submitDirect, getDirectStatus, getDirectResult, directEffectiveStrength, finalizeJob,
  readCommandExecutionEvents, resolveDirectRuntime, _resetDirectRuntime, _resetPreconditions,
  _setDirectPreconditions, statBinaryIdentity, _registry,
  revalidatePreconditions, getDirectPreconditions,
} from "../direct.mjs";
import { pollToTerminal, isPidAlive } from "../jobs.mjs";
import { admitDirect } from "../admission.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { stopJobsOnCleanup } from "./helpers/direct-jobs.mjs";
import { installPolicyFixture, DELTA } from "./helpers/policy-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, "fixtures", "scripts", "fake-codex.mjs");
const fx = installPolicyFixture({ after });

function setup(t, mode, { timeoutMs = 30000 } = {}) {
  _resetDirectRuntime(); _resetPreconditions();
  const home = tempDirFor(t, "a1-int-home-");
  fs.writeFileSync(path.join(home, "fake-mode.txt"), mode, "utf8"); // mode rides CODEX_HOME
  const repo = tempDirFor(t, "a1-int-repo-");
  fs.writeFileSync(path.join(repo, "a.mjs"), "export const x = 1;", "utf8");
  // This file's real sweeps/jobs need their own isolated root so
  // they never race other test files' CODEX_DIRECT_ROOT-scoped instance dirs (same pattern as
  // tests/direct.sweep.test.mjs freshRuntime() and tests/direct.submit.test.mjs setup(t)).
  const root = tempDirFor(t, "a1-int-root-");
  const deps = { env: { ...process.env, CODEX_BIN: FAKE, CODEX_HOME: home, CODEX_DIRECT_ROOT: root } };
  const rt = resolveDirectRuntime(deps);
  assert.ok(!rt.error, rt.error);
  // Runs before the folders above are removed: a job a failed or timed-out test left running has its
  // timers stopped and its real fake-codex child killed (by its own handle) first.
  stopJobsOnCleanup(t, rt.instanceDir);
  const identity = statBinaryIdentity(deps);
  assert.ok(identity);
  _setDirectPreconditions({ binary: identity, writeDenialVerified: true,
    networkDenialVerified: true, verifiedAt: "t", generation: 1 });
  return {
    deps,
    opts: { model: "gpt-6-astra", effort: "max", cwd_real: fs.realpathSync(repo),
      pii: false, timeoutMs, binaryIdentity: identity },
  };
}
const wait = (jobId, ms = 30000) =>
  pollToTerminal(jobId, { timeoutMs: ms, pollIntervalMs: 50 }, (id) => getDirectStatus(id));

test("happy path: completed, result decodes, events readable, EXACT attested pair, finalize sweeps", async (t) => {
  const { deps, opts } = setup(t, "happy");
  const { jobId } = await submitDirect("review payload", opts, deps);
  assert.equal(await wait(jobId), "completed");
  const out = JSON.parse(getDirectResult(jobId).output);
  assert.equal(out.verdict, "pass");
  assert.deepEqual(out.files_checked, ["a.mjs"]);
  const events = readCommandExecutionEvents(jobId);
  assert.ok(events.some((e) => e.command.includes("a.mjs")));
  assert.deepEqual(await directEffectiveStrength(jobId), { model: "gpt-6-astra", effort: "max" });
  const rt = resolveDirectRuntime(deps);
  const dir = path.join(rt.instanceDir, jobId);
  await finalizeJob(jobId, deps);
  assert.equal(_registry().has(jobId), false);
  assert.equal(fs.existsSync(dir), false);
});

test("timeout kill: a hung child is tree-killed AND VERIFIED dead; dir removed by finalize", async (t) => {
  const { deps, opts } = setup(t, "hang", { timeoutMs: 1500 });
  const { jobId } = await submitDirect("p", opts, deps);
  const pid = getDirectStatus(jobId).job.pid;
  assert.equal(await wait(jobId, 30000), "failed");
  const s = getDirectStatus(jobId).job;
  assert.equal(s.failure_reason, "timeout");
  assert.ok(!s.kill_unverified, "tree-kill must have VERIFIED death (kill_unverified false)");
  assert.equal(isPidAlive(pid), false, "the hung child pid must actually be dead");
  const rt = resolveDirectRuntime(deps);
  await finalizeJob(jobId, deps);
  assert.equal(fs.existsSync(path.join(rt.instanceDir, jobId)), false);
});

test("production probe path: revalidatePreconditions drives a REAL fake-codex probe child", async (t) => {
  const { deps } = setup(t, "probe-denied");
  const identity = statBinaryIdentity(deps);
  assert.ok(identity);
  _resetPreconditions();
  const r = await revalidatePreconditions(identity, { ...deps, httpsGet: async () => true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = getDirectPreconditions();
  assert.equal(p.writeDenialVerified, true);         // real spawn + fs oracle + denial events + signature
  assert.equal(p.writeDenialClass, "os");            // fake emits UnauthorizedAccessException on BOTH key events -> os-class
  assert.equal(p.networkDenialVerified, false);      // the fake's write-denial-shaped fetch output mismatches the pinned policy-class network signature -> fail closed
  assert.equal(p.networkDenialClass, null);
  const rt = resolveDirectRuntime(deps);
  const leftoverProbes = fs.readdirSync(rt.instanceDir).filter((n) => n.startsWith("probe-"));
  assert.equal(leftoverProbes.length, 0);            // throwaway dir cleaned in finally
  _resetPreconditions();
});

test("pinned positive path: pinned manifest+signature drive networkDenialVerified=true through the REAL probe chain and unlock real PII admission", async (t) => {
  const { deps } = setup(t, "probe-denied-pinned");
  _resetPreconditions();
  const identity = statBinaryIdentity(deps);
  const r = await revalidatePreconditions(identity, { ...deps, httpsGet: async () => true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = getDirectPreconditions();
  assert.equal(p.networkDenialVerified, true);   // DERIVED via judgeNetwork with the pinned artifacts, not seeded
  assert.equal(p.networkDenialClass, "os");      // 0.160.1 capture (elevated sandbox): the fetch ran and the firewall refused it
  assert.equal(p.writeDenialVerified, true);
  assert.equal(p.writeDenialClass, "os");        // the fake's write events stay os-shaped
  // real PII admission: REAL ensureDirectPreconditions; flags are cached-current so no re-probe. The
  // connectivity stub is passed anyway, so a cache miss could never make a real HTTPS request.
  const d = await admitDirect({ cwd: fx.dirOf(DELTA) }, { ...deps, realpath: (p2) => p2, httpsGet: async () => true });
  assert.equal(d.allowed, true);
  assert.equal(d.policy.pii_sensitive, true);
  assert.deepEqual(d.binaryIdentity, identity);
  _resetPreconditions();
});

// Revalidation cancellation-completeness: a fake child whose spawn is spied so we can
// prove the probe child is / is not created relative to the 180s cap firing.
function spawnSpy(counter) {
  return () => {
    counter.n++;
    return {
      pid: 9999, exitCode: null,
      stdout: { on: () => {} }, stderr: { on: () => {} },
      stdin: { on: () => {}, write: () => {}, end: () => {} },
      // resolve the probe promise cleanly (empty events) so no rejection leaks
      on: (ev, fn) => { if (ev === "close") setTimeout(() => fn(0), 1); },
    };
  };
}

test("a cap firing BEFORE the pre-spawn connectivity await resolves prevents the probe spawn entirely", async (t) => {
  const { deps } = setup(t, "probe-denied");
  const identity = statBinaryIdentity(deps);
  assert.ok(identity);
  _resetPreconditions();
  const counter = { n: 0 };
  // slow connectivity (resolves at ~60ms) races a short cap (10ms): the cap wins, so when the
  // connectivity await finally resolves the probe must observe control.expired and refuse to spawn.
  const slowConnectivity = () => new Promise((resolve) => setTimeout(() => resolve(true), 60));
  const r = await revalidatePreconditions(identity, {
    ...deps, revalidationCapMs: 10, httpsGet: slowConnectivity, spawn: spawnSpy(counter),
  });
  assert.equal(r.ok, false);
  assert.equal(r.why, "revalidation_timeout");
  // let the (now-expired) probe run past its connectivity await -- a pre-fix probe spawns here.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(counter.n, 0, "cap fired before connectivity resolved -> probe child must NEVER spawn");
  assert.equal(getDirectPreconditions(), null, "an expired probe commits nothing");
  const rt = resolveDirectRuntime(deps);
  assert.equal(fs.readdirSync(rt.instanceDir).filter((n) => n.startsWith("probe-")).length, 0);
  _resetPreconditions();
});

test("with a normal (unfired) cap the probe child still spawns as before", async (t) => {
  const { deps } = setup(t, "probe-denied");
  const identity = statBinaryIdentity(deps);
  _resetPreconditions();
  const counter = { n: 0 };
  const r = await revalidatePreconditions(identity, {
    ...deps, revalidationCapMs: 5000, httpsGet: async () => true, spawn: spawnSpy(counter),
  });
  assert.notEqual(r.why, "revalidation_timeout"); // cap never fired
  assert.equal(counter.n, 1, "normal path: the probe child spawns exactly once");
  _resetPreconditions();
});

test("integration sweep: a crashed no-pid dir ages out on the per-submit sweep cadence", async (t) => {
  const { deps, opts } = setup(t, "happy");
  const rt = resolveDirectRuntime(deps);
  const torn = path.join(rt.instanceDir, "torn-crash-dir");
  fs.mkdirSync(torn);
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(torn, past, past);
  const { jobId } = await submitDirect("p", opts, deps); // per-submit sweep runs first
  assert.equal(fs.existsSync(torn), false);
  await wait(jobId);
  await finalizeJob(jobId, deps);
});

test("empty answer -> getDirectResult throws (result_error -> abstention upstream)", async (t) => {
  const { deps, opts } = setup(t, "empty-answer");
  const { jobId } = await submitDirect("p", opts, deps);
  assert.equal(await wait(jobId), "completed");
  assert.throws(() => getDirectResult(jobId), /result_error/);
  await finalizeJob(jobId, deps);
});

test("missing receipt -> unattested; wrong-effort receipt (downgrade) -> unattested", async (t) => {
  const a = setup(t, "no-rollout");
  const ja = await submitDirect("p", a.opts, a.deps);
  assert.equal(await wait(ja.jobId), "completed");
  assert.equal(await directEffectiveStrength(ja.jobId, { retryDelayMs: 1 }), null);
  await finalizeJob(ja.jobId, a.deps);

  const b = setup(t, "wrong-effort");
  const jb = await submitDirect("p", b.opts, b.deps);
  assert.equal(await wait(jb.jobId), "completed");
  assert.equal(await directEffectiveStrength(jb.jobId, { retryDelayMs: 1 }), null);
  await finalizeJob(jb.jobId, b.deps);
});

test("crash (nonzero exit): failed(nonzero_exit)", async (t) => {
  const { deps, opts } = setup(t, "crash");
  const { jobId } = await submitDirect("p", opts, deps);
  assert.equal(await wait(jobId), "failed");
  assert.equal(getDirectStatus(jobId).job.failure_reason, "nonzero_exit");
  await finalizeJob(jobId, deps);
});

test("output cap: an artifact-file flood breaches the log cap -> failed(output_cap)", async (t) => {
  const { deps, opts } = setup(t, "hang"); // keep the child alive while we oversize an artifact
  deps.env.CODEX_DIRECT_LOG_CAP = String(1024 * 1024); // clamp floor is 1MB
  const { jobId } = await submitDirect("p", opts, deps);
  const rt = resolveDirectRuntime(deps);
  fs.writeFileSync(path.join(rt.instanceDir, jobId, "stderr.log"), "x".repeat(1024 * 1024 + 10), "utf8");
  assert.equal(await wait(jobId, 30000), "failed");
  assert.equal(getDirectStatus(jobId).job.failure_reason, "output_cap");
  await finalizeJob(jobId, deps);
});

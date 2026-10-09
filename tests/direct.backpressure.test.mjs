import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  submitDirect, _registry, _resetDirectRuntime, _resetPreconditions, _setDirectPreconditions,
  resolveDirectRuntime, statBinaryIdentity,
} from "../direct.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { dropJob, stopJobsOnCleanup } from "./helpers/direct-jobs.mjs";

// Fake child whose stdout records pause()/resume() calls -- the backpressure discriminator.
function fakeChildBP() {
  const child = new EventEmitter();
  child.pid = 7777;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stdout.paused = 0;
  child.stdout.resumed = 0;
  child.stdout.pause = function () { this.paused++; };
  child.stdout.resume = function () { this.resumed++; };
  child.stderr = new EventEmitter();
  child.stderr.pipe = () => {}; child.stderr.resume = () => {}; child.stderr.unpipe = () => {};
  child.stdin = { written: "", handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, write(s) { this.written += s; }, end() {} };
  return child;
}

// Controllable tee: EventEmitter so direct.mjs can attach .on("error")/.once("drain") and we can
// emit them; write() returns whatever writeReturn is set to (models buffer-full backpressure).
function makeControllableTee() {
  const tee = new EventEmitter();
  tee.writeReturn = true;
  tee.write = (_chunk, cb) => { if (cb) { /* success: no err */ } return tee.writeReturn; };
  tee.end = () => {};
  return tee;
}

function setup(t, { tee } = {}) {
  _resetDirectRuntime(); _resetPreconditions();
  const binDir = tempDirFor(t, "a1bp-bin-");
  const bin = path.join(binDir, "fake-codex.mjs");
  fs.writeFileSync(bin, "// fake\n", "utf8");
  const home = tempDirFor(t, "a1bp-home-");
  const repo = tempDirFor(t, "a1bp-repo-");
  const deps = {
    env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "", CODEX_DIRECT_ROOT: tempDirFor(t, "a1bp-root-") },
    spawnSync: () => ({ stdout: "codex-cli 0.144.1\n" }),
    spawn: () => fakeChildBP(),
    isPidAlive: () => false,
  };
  if (tee) {
    deps.createWriteStream = (p) => (p.endsWith("events.jsonl") ? tee : fs.createWriteStream(p, { flags: "a" }));
  }
  const rt = resolveDirectRuntime(deps);
  assert.ok(!rt.error);
  stopJobsOnCleanup(t, rt.instanceDir);   // runs before the folders above are removed
  const identity = statBinaryIdentity(deps);
  assert.ok(identity && identity.digest);
  _setDirectPreconditions({ binary: identity, writeDenialVerified: true,
    networkDenialVerified: false, verifiedAt: "t", generation: 1 });
  const opts = { model: "gpt-6-astra", effort: "max", cwd_real: fs.realpathSync(repo),
    pii: false, timeoutMs: 60000, binaryIdentity: identity };
  return { deps, opts, rt };
}

test("backpressure: tee.write() returning false pauses child stdout; a tee 'drain' resumes it", async (t) => {
  const tee = makeControllableTee();
  const { deps, opts } = setup(t, { tee });
  const { jobId } = await submitDirect("p", opts, deps);
  const job = _registry().get(jobId);
  const child = job.child;

  // A normal write (returns true) must NOT pause the child.
  tee.writeReturn = true;
  child.stdout.emit("data", Buffer.from("{}\n"));
  assert.equal(child.stdout.paused, 0, "normal write must not pause the child stdout");
  assert.equal(child.stdout.resumed, 0);

  // write() returns false (tee buffer full) -> the child stdout must be paused.
  tee.writeReturn = false;
  child.stdout.emit("data", Buffer.from("{\"a\":1}\n"));
  assert.equal(child.stdout.paused, 1, "write() false must pause child stdout (backpressure)");
  assert.equal(child.stdout.resumed, 0, "must not resume until drain");

  // tee drains -> the child stdout must resume.
  tee.emit("drain");
  assert.equal(child.stdout.resumed, 1, "'drain' must resume child stdout");

  dropJob(jobId);
});

test("backpressure regression: a tee 'error' still drives the stream_error kill road", async (t) => {
  const tee = makeControllableTee();
  // second spawn = kill road's taskkill; it must CLOSE for the road to resolve.
  let spawns = 0;
  const { deps, opts } = setup(t, { tee });
  deps.spawn = () => {
    spawns++;
    if (spawns === 1) return fakeChildBP();
    const k = fakeChildBP(); setTimeout(() => { k.exitCode = 0; k.emit("close", 0); }, 5); return k;
  };
  const { jobId } = await submitDirect("p", opts, deps);
  const job = _registry().get(jobId);
  job.tee.emit("error", new Error("ENOSPC"));
  const term = await job.roadPromise;
  assert.equal(term.failure_reason, "stream_error");
  dropJob(jobId);
});

test("backpressure fail-closed: after a tee failure, a later 'drain' does NOT resume a killed child", async (t) => {
  const tee = makeControllableTee();
  let spawns = 0;
  const { deps, opts } = setup(t, { tee });
  deps.spawn = () => {
    spawns++;
    if (spawns === 1) return fakeChildBP();
    const k = fakeChildBP(); setTimeout(() => { k.exitCode = 0; k.emit("close", 0); }, 5); return k;
  };
  const { jobId } = await submitDirect("p", opts, deps);
  const job = _registry().get(jobId);
  const child = job.child;

  // Buffer fills -> pause + arm drain.
  tee.writeReturn = false;
  child.stdout.emit("data", Buffer.from("{}\n"));
  assert.equal(child.stdout.paused, 1);

  // The tee then errors (fail closed): teeFailed is set and the kill road runs.
  job.tee.emit("error", new Error("EIO"));
  const term = await job.roadPromise;
  assert.equal(term.failure_reason, "stream_error");

  // A late drain must NOT resume a stream that failed closed.
  tee.emit("drain");
  assert.equal(child.stdout.resumed, 0, "a failed tee must never resume the child (fail-closed)");

  dropJob(jobId);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  submitDirect, _registry, _resetDirectRuntime, _resetPreconditions, _setDirectPreconditions,
  resolveDirectRuntime, readMeta, statBinaryIdentity,
} from "../direct.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { dropJob, stopJobsOnCleanup } from "./helpers/direct-jobs.mjs";

// A controllable fake child.
function fakeChild({ autoClose = null } = {}) {
  const child = new EventEmitter();
  child.pid = 7777;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter(); child.stderr.pipe = () => {}; child.stderr.resume = () => {}; child.stderr.unpipe = () => {};
  child.stdin = { written: "", handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, write(s) { this.written += s; }, end() {} };
  if (autoClose !== null) setTimeout(() => { child.exitCode = autoClose; child.emit("close", autoClose); }, 10);
  return child;
}

// killTree calls deps.spawn a SECOND time to launch its own taskkill sub-process -- the same
// seam direct.machine.test.mjs's fakeKillSpawn answers for the kill-road tests. A
// pre-resolution-failure spawnImpl mock only models the PRIMARY codex child and would otherwise
// leave that second call unanswered (killTree never settles -> the awaited pre-resolution kill
// road never returns -> the test hangs forever). This wrapper routes call 1 to the caller's
// primary-child mock and call 2+ to a self-closing fake taskkill process, mirroring the
// fakeKillSpawn pattern. Test-only.
function withKillSpawn(primary) {
  let calls = 0;
  return (...args) => (++calls > 1 ? fakeChild({ autoClose: 0 }) : primary(...args));
}

function setup(t, { spawnImpl } = {}) {
  _resetDirectRuntime(); _resetPreconditions();
  const binDir = tempDirFor(t, "a1-bin-");
  const bin = path.join(binDir, "fake-codex.mjs");
  fs.writeFileSync(bin, "// fake\n", "utf8");
  const home = tempDirFor(t, "a1-home-");
  const repo = tempDirFor(t, "a1-repo-");
  const deps = {
    env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "", CODEX_DIRECT_ROOT: tempDirFor(t, "a1-root-") },
    spawnSync: () => ({ stdout: "codex-cli 0.144.1\n" }),
    spawn: spawnImpl ?? (() => fakeChild()),
    isPidAlive: () => false,
  };
  const rt = resolveDirectRuntime(deps);
  assert.ok(!rt.error);
  stopJobsOnCleanup(t, rt.instanceDir);   // runs before the folders above are removed
  // Build the seed identity through the real statBinaryIdentity so it carries the fifth field
  // (digest); submit re-stats the same bin via the same path, so identityEquals must hold.
  const identity = statBinaryIdentity(deps);
  assert.ok(identity && identity.digest);
  _setDirectPreconditions({ binary: identity, writeDenialVerified: true,
    networkDenialVerified: false, verifiedAt: "t", generation: 1 });
  const opts = { model: "gpt-6-astra", effort: "max", cwd_real: fs.realpathSync(repo),
    pii: false, timeoutMs: 60000, binaryIdentity: identity };
  // deps.spawnSync must keep answering --version for statBinaryIdentity re-stats
  return { deps, opts, rt };
}

test("happy submit: steps 1-5, resolves { jobId }, registry insert, meta running", async (t) => {
  const { deps, opts, rt } = setup(t);
  const { jobId } = await submitDirect("review this", opts, deps);
  assert.ok(jobId);
  assert.ok(_registry().has(jobId));
  const meta = readMeta(path.join(rt.instanceDir, jobId));
  assert.equal(meta.state, "running");
  assert.equal(meta.pid, 7777);
  dropJob(jobId);
});

test("missing required opt -> throws, nothing registered", async (t) => {
  const { deps, opts } = setup(t);
  delete opts.binaryIdentity;
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "direct_preconditions_unmet");
  assert.equal(_registry().size, 0);
});

test("spawn precondition: binary identity mismatch at spawn -> throws (admit-then-swap window closed)", async (t) => {
  const { deps, opts } = setup(t);
  opts.binaryIdentity = { ...opts.binaryIdentity, mtime: opts.binaryIdentity.mtime + 1 };
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "direct_preconditions_unmet");
});

test("cwd realpath mismatch at spawn -> throws", async (t) => {
  const { deps, opts } = setup(t);
  opts.cwd_real = opts.cwd_real + "-not-real";
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "direct_preconditions_unmet");
});

test("PII spawn requires networkDenialVerified", async (t) => {
  const { deps, opts } = setup(t);
  opts.pii = true;
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "direct_preconditions_unmet");
});

test("prompt rides stdin (no argv), and argv is the pinned shape", async (t) => {
  let spawnedArgs = null;
  let child;
  const { deps, opts } = setup(t, { spawnImpl: (cmd, args) => { spawnedArgs = args; child = fakeChild(); return child; } });
  const { jobId } = await submitDirect("PROMPT-BODY", opts, deps);
  assert.ok(spawnedArgs.includes("--ignore-user-config"));
  assert.ok(spawnedArgs.includes("read-only"));
  // The network-disable manifest for the ADMITTED identity version rides argv (the
  // argv version from job.request.version = opts.binaryIdentity.version, not a cached runtime version).
  assert.ok(spawnedArgs.includes("features.browser_use=false"));
  assert.equal(child.stdin.written, "PROMPT-BODY");
  assert.ok(!spawnedArgs.includes("PROMPT-BODY"));
  dropJob(jobId);
});

test("submit refuses when the reviewed cwd overlaps CODEX_HOME (a read-only review must not write into the reviewed tree)", async (t) => {
  const { deps, opts, rt } = setup(t);
  const nested = tempDirFor(t, "nested-", { parent: rt.codexHome, realpath: true }); // cwd UNDER where rollout receipts land
  opts.cwd_real = nested;
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "direct_preconditions_unmet");
});

test("pre-resolution close -> failed(spawn_error) semantics: submit throws, dir deleted on verified death", async (t) => {
  // The fake child emits close BEFORE step 5 can resolve (setImmediate beats the submit's own
  // setImmediate tick), so natural-close semantics must NOT apply: spawn_error, nothing registered.
  const { deps, opts, rt } = setup(t, { spawnImpl: () => { const c = fakeChild(); setImmediate(() => { c.exitCode = 3; c.emit("close", 3); }); return c; } });
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "spawn_error");
  assert.equal(_registry().size, 0);
  const dirs = fs.readdirSync(rt.instanceDir).filter((n) => n !== "instance.json");
  assert.equal(dirs.length, 0); // verified-dead pre-resolution failure deletes its dir
});

test("pre-resolution kill road waits for both log streams to close before deleting the job dir", async (t) => {
  // On Windows a folder cannot be removed while a file in it is still open, so deleting the job
  // dir straight after destroy() sometimes left it behind (seen on CI). Each real stream here
  // keeps its file open 50 ms after destroy(); the delete must still see both streams closed.
  const streams = [];
  const { deps, opts, rt } = setup(t, { spawnImpl: () => { const c = fakeChild(); setImmediate(() => { c.exitCode = 3; c.emit("close", 3); }); return c; } });
  deps.createWriteStream = (p, o) => {
    const s = fs.createWriteStream(p, o);
    const realDestroy = s._destroy.bind(s);
    s._destroy = (err, cb) => { setTimeout(() => realDestroy(err, cb), 50); };
    streams.push(s);
    return s;
  };
  let closedAtRm = null;
  deps.rm = (dir, o) => { closedAtRm = streams.map((s) => s.closed); fs.rmSync(dir, o); };
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "spawn_error");
  assert.equal(streams.length, 2);
  assert.deepEqual(closedAtRm, [true, true]);
  const dirs = fs.readdirSync(rt.instanceDir).filter((n) => n !== "instance.json");
  assert.equal(dirs.length, 0);
});

test("pre-resolution kill road does not hang on a stream that never closes", async (t) => {
  // A stream whose close never arrives must not hold the submit forever: the wait is bounded.
  const { deps, opts } = setup(t, { spawnImpl: () => { const c = fakeChild(); setImmediate(() => { c.exitCode = 3; c.emit("close", 3); }); return c; } });
  deps.createWriteStream = () => { const s = new EventEmitter(); s.write = () => true; s.end = () => {}; s.destroy = () => {}; return s; };
  deps.streamCloseWaitMs = 20;
  let rmCalled = false;
  deps.rm = () => { rmCalled = true; };
  const started = Date.now();
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "spawn_error");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 15, `returned after ${elapsed} ms, before the 20 ms wait`);
  assert.ok(elapsed < 1500, `took ${elapsed} ms; the injected 20 ms wait was not used`);
  assert.equal(rmCalled, true);
});

test("kill_unverified before registration: dir RETAINED with kill_unverified meta", async (t) => {
  const { deps, opts, rt } = setup(t, { spawnImpl: () => { const c = fakeChild(); setImmediate(() => c.emit("error", new Error("boom"))); return c; } });
  deps.isPidAlive = () => true; // kill never verifies
  await assert.rejects(() => submitDirect("p", opts, deps));
  assert.equal(_registry().size, 0);
  const dirs = fs.readdirSync(rt.instanceDir).filter((n) => fs.statSync(path.join(rt.instanceDir, n)).isDirectory());
  assert.equal(dirs.length, 1);
  const meta = readMeta(path.join(rt.instanceDir, dirs[0]));
  assert.equal(meta.kill_unverified, true);
});

test("fatal step failures -- mkdir (1), initial meta (2), spawn (3), stdin (3a): pre-resolution throw, nothing registered", async (t) => {
  const s1 = setup(t);
  await assert.rejects(() => submitDirect("p", s1.opts, { ...s1.deps, mkdir: () => { throw new Error("EEXIST"); } }),
    (e) => e.reason === "spawn_error");
  const s2 = setup(t);
  await assert.rejects(() => submitDirect("p", s2.opts, { ...s2.deps, writeFile: () => { throw new Error("disk full"); } }),
    (e) => e.reason === "spawn_error");
  const s3 = setup(t, { spawnImpl: () => { throw new Error("EPERM"); } });
  await assert.rejects(() => submitDirect("p", s3.opts, s3.deps), (e) => e.reason === "spawn_error");
  const s4 = setup(t, { spawnImpl: withKillSpawn(() => { const c = fakeChild(); c.stdin.write = () => { throw new Error("EPIPE"); }; return c; }) });
  s4.deps.killWaitMs = 5;
  await assert.rejects(() => submitDirect("p", s4.opts, s4.deps), (e) => e.reason === "stream_error");
  assert.equal(_registry().size, 0);
});

test("internal submission deadline: expiry during the pre-resolve window converts the submit (CAS)", async (t) => {
  const { deps, opts } = setup(t, { spawnImpl: withKillSpawn(() => fakeChild()) });
  deps.killWaitMs = 5;
  deps.submitDeadlineMs = 5;
  deps.preResolveTick = () => new Promise((r) => setTimeout(r, 40));
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "spawn_error");
  assert.equal(_registry().size, 0);
});

test("pre-resolution kill-TIMER fire converts the submit to failure (timeout reason, CAS)", async (t) => {
  const { deps, opts } = setup(t, { spawnImpl: withKillSpawn(() => fakeChild()) });
  deps.killWaitMs = 5;
  opts.timeoutMs = 5;
  deps.preResolveTick = () => new Promise((r) => setTimeout(r, 40));
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "timeout");
  assert.equal(_registry().size, 0);
});

test("tee write error through the REAL stream wiring -> pre-resolution stream_error, nothing registered", async (t) => {
  // the events.jsonl tee stream fails its write-callback while stdout data flows through the
  // ACTUAL data handler -- not a direct signalFailure call
  const failingStream = new EventEmitter();
  failingStream.write = (chunk, cb) => { if (cb) cb(new Error("EIO")); return false; };
  failingStream.end = () => {};
  const { deps, opts } = setup(t, { spawnImpl: withKillSpawn(() => { const c = fakeChild(); setImmediate(() => c.stdout.emit("data", Buffer.from("{}\n"))); return c; }) });
  deps.killWaitMs = 5;
  deps.createWriteStream = (p) => (p.endsWith("events.jsonl") ? failingStream : fs.createWriteStream(p, { flags: "a" }));
  deps.preResolveTick = () => new Promise((r) => setTimeout(r, 40)); // hold the pre-resolve window open
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "stream_error");
  assert.equal(_registry().size, 0);
});

test("ASYNC stdin EPIPE (stream error event) -> pre-resolution stream_error, nothing registered", async (t) => {
  const { deps, opts } = setup(t, { spawnImpl: withKillSpawn(() => {
    const c = fakeChild();
    setImmediate(() => { if (c.stdin.handlers.error) c.stdin.handlers.error(new Error("EPIPE")); });
    return c;
  }) });
  deps.killWaitMs = 5;
  deps.preResolveTick = () => new Promise((r) => setTimeout(r, 40));
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "stream_error");
  assert.equal(_registry().size, 0);
});

test("pre-resolution WATCHER breach converts the submit (output_cap reason, CAS)", async (t) => {
  // deps.tickMs/deps.stat flow into startSizeWatcher through submitDirect's deps.
  // This test is the ONLY guard on that threading -- do not "simplify" the seam away.
  const { deps, opts } = setup(t, { spawnImpl: withKillSpawn(() => fakeChild()) });
  deps.killWaitMs = 5;
  deps.tickMs = 5;
  // Scoped to the watcher's targets only -- deps.stat is ALSO consumed by statBinaryIdentity's
  // spawn-time re-stat of the codex binary (submitDirect's precondition recheck); a blanket
  // override here would corrupt that unrelated check with a fake size.
  deps.stat = (p) => (/events\.jsonl$|stderr\.log$|answer\.txt$/.test(p) ? { size: Number.MAX_SAFE_INTEGER } : fs.statSync(p));
  deps.preResolveTick = () => new Promise((r) => setTimeout(r, 60));
  await assert.rejects(() => submitDirect("p", opts, deps), (e) => e.reason === "output_cap");
  assert.equal(_registry().size, 0);
});

test("tee WRITE failure post-resolution through the real wiring -> stream_error kill road", async (t) => {
  // second spawn = the kill road's taskkill: it must CLOSE for the road to resolve
  let spawns = 0;
  const { deps, opts } = setup(t, { spawnImpl: () => { spawns++; return spawns === 1 ? fakeChild() : fakeChild({ autoClose: 0 }); } });
  const { jobId } = await submitDirect("p", opts, deps);
  const job = _registry().get(jobId);
  job.tee.emit("error", new Error("ENOSPC")); // drives the actual job.tee.on("error") handler
  const term = await job.roadPromise;
  assert.equal(term.failure_reason, "stream_error");
  dropJob(jobId);
});

test("stderr.log failure is LOGGED and the run continues (stderr reattached to a draining sink)", async (t) => {
  const { deps, opts } = setup(t);
  const lines = [];
  deps.log = (m) => lines.push(m);
  const { jobId } = await submitDirect("p", opts, deps);
  const job = _registry().get(jobId);
  job.errlog.emit("error", new Error("disk full"));
  assert.ok(lines.some((m) => /stderr\.log write failed/.test(m))); // logged
  assert.ok(_registry().has(jobId)); // log-only: never a failure signal
  dropJob(jobId);
});

test("post-spawn meta write failure is NON-fatal (step 4, the one best-effort step): submit resolves", async (t) => {
  const { deps, opts } = setup(t);
  let calls = 0;
  deps.writeFile = (p, d, e) => { calls++; if (calls > 1) throw new Error("late meta fail"); return fs.writeFileSync(p, d, e); };
  const { jobId } = await submitDirect("p", opts, deps);
  assert.ok(jobId);
  await _registry().get(jobId).metaQueue;
  assert.ok(_registry().get(jobId).metaWriteError); // recorded, never thrown
  dropJob(jobId);
});

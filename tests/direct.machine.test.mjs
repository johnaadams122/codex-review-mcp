import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recordIntent, onChildClose, startSizeWatcher, signalFailure, clearJobTimers, _newJobForTest } from "../direct.mjs";
import { onCleanup, tempDirFor } from "./helpers/test-cleanup.mjs";

// The failure paths these tests drive make direct.mjs print "a1-direct: ..." status lines through
// console.error (its default when no deps.log is given), and those lines quote temp-folder paths. They are
// expected here, so this file keeps them out of the test output; every other stderr line still prints. The
// filter is not undone at the end: a late async write can still fail after the last test, and node --test
// runs each test file in its own process.
const realConsoleError = console.error;
console.error = (...args) => {
  // Only the exact shape direct.mjs prints (one string, one line) is dropped.
  if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("a1-direct: ") && !args[0].includes("\n")) return;
  realConsoleError(...args);
};

function tmpDir(ctx) { return tempDirFor(ctx, "a1-machine-"); }

// A fake spawn for taskkill that "kills" by delivering the close event. exitCode controls the
// taskkill process's own exit (nonzero -> killTree rejects -> kill_unverified).
function fakeKillSpawn(job, { failLaunch = false, neverDies = false, exitCode = 0 } = {}) {
  return (cmd, args, opts) => {
    if (failLaunch) throw new Error("taskkill missing");
    if (!neverDies) setTimeout(() => { job.closeInfo = { code: 1 }; for (const w of job.closeWaiters.splice(0)) w(); }, 5);
    return { on: (ev, fn) => { if (ev === "close") setTimeout(() => fn(exitCode), 1); } };
  };
}

function makeJob(ctx, { exitCode = null, pid = 4242 } = {}) {
  const dir = tmpDir(ctx);
  const job = _newJobForTest({
    jobId: "j1", dir,
    request: { model: "gpt-6-astra", effort: "max", cwd_real: "C:\\repo", pii: false,
      timeoutMs: 5000, logCap: 1024 * 1024, answerFile: path.join(dir, "answer.txt") },
  });
  job.child = { pid, exitCode };
  job.resolved = true;
  // Runs before the folder is removed (newest-first): a watcher a failed test left running stops
  // polling the folder instead of logging ENOENT every tick.
  onCleanup(ctx, () => clearJobTimers(job));
  return job;
}

test("kill road: verified death -> terminal failed(<reason>), kill_unverified false", async (ctx) => {
  const job = makeJob(ctx);
  const t = await recordIntent(job, "timeout", { spawn: fakeKillSpawn(job), isPidAlive: () => false });
  assert.equal(t.status, "failed");
  assert.equal(t.failure_reason, "timeout");
  assert.equal(t.kill_unverified, false);
  assert.equal(job.roadResolved, true);
});

test("kill road: pid still alive after the 10s window -> kill_unverified true (deferral, not success)", async (ctx) => {
  const job = makeJob(ctx);
  const t = await recordIntent(job, "cancel", { spawn: fakeKillSpawn(job), isPidAlive: () => true });
  assert.equal(t.status, "cancelled");
  assert.equal(t.kill_unverified, true);
});

test("kill road: taskkill launch failure, NONZERO taskkill exit, or isPidAlive error -> kill_unverified", async (ctx) => {
  const j1 = makeJob(ctx);
  const t1 = await recordIntent(j1, "timeout", { spawn: fakeKillSpawn(j1, { failLaunch: true }), isPidAlive: () => false });
  assert.equal(t1.kill_unverified, true);
  const j2 = makeJob(ctx);
  const t2 = await recordIntent(j2, "timeout", { spawn: fakeKillSpawn(j2), isPidAlive: () => { throw new Error("eperm"); } });
  assert.equal(t2.kill_unverified, true);
  const j3 = makeJob(ctx);
  const t3 = await recordIntent(j3, "timeout", { spawn: fakeKillSpawn(j3, { exitCode: 128 }), isPidAlive: () => false });
  assert.equal(t3.kill_unverified, true); // taskkill EXIT failure is a deferral, never silent success
});

test("signalFailure: post-resolution -> mapped kill road; pre-resolution -> converts the submit (CAS)", async (ctx) => {
  const job = makeJob(ctx);
  signalFailure(job, "stream_error", { spawn: fakeKillSpawn(job), isPidAlive: () => false });
  const t = await job.roadPromise;
  assert.equal(t.failure_reason, "stream_error");
  const pre = makeJob(ctx);
  pre.resolved = false;
  let got = null;
  pre.preResolutionFail = (r) => { got = r; };
  signalFailure(pre, "output_cap", {});
  assert.equal(got, "output_cap");
});

test("natural close with REAL write streams: our flush completes before the final check and terminal", async (ctx) => {
  const job = makeJob(ctx, { exitCode: 0 });
  job.tee = fs.createWriteStream(path.join(job.dir, "events.jsonl"), { flags: "a" });
  job.errlog = fs.createWriteStream(path.join(job.dir, "stderr.log"), { flags: "a" });
  job.tee.write("x".repeat(64));
  const t = await onChildClose(job, 0, {});
  assert.equal(t.status, "completed");
  assert.equal(fs.readFileSync(path.join(job.dir, "events.jsonl"), "utf8").length, 64); // flushed first
});

test("natural close after a tee failure -> failed(stream_error), NOT completed", async (ctx) => {
  const job = makeJob(ctx, { exitCode: 0 });
  job.tee = fs.createWriteStream(path.join(job.dir, "events.jsonl"), { flags: "a" });
  job.errlog = fs.createWriteStream(path.join(job.dir, "stderr.log"), { flags: "a" });
  job.teeFailed = true; // a tee write/stream error surfaced (post-resolution, natural-close path)
  const t = await onChildClose(job, 0, {}); // clean exit code, but the trace is partial
  assert.equal(t.status, "failed");
  assert.equal(t.failure_reason, "stream_error"); // was silently "completed" before the fix
});

test("size watcher covers ALL THREE artifacts: an oversized ANSWER file breaches its 5MB cap", async (ctx) => {
  const job = makeJob(ctx);
  let roadRan = null;
  const deps = {
    tickMs: 5,
    onIntent: (k) => { roadRan = k; },
    stat: (f) => ({ size: f === job.request.answerFile ? 6 * 1024 * 1024 : 10 }),
  };
  startSizeWatcher(job, deps);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(roadRan, "output_cap");
  clearJobTimers(job);
});

test("intent CAS: first intent wins; later intents return the same road", async (ctx) => {
  const job = makeJob(ctx);
  const p1 = recordIntent(job, "timeout", { spawn: fakeKillSpawn(job), isPidAlive: () => false });
  const p2 = recordIntent(job, "cancel", { spawn: fakeKillSpawn(job), isPidAlive: () => false });
  const [t1, t2] = await Promise.all([p1, p2]);
  assert.equal(t1.failure_reason, "timeout");
  assert.deepEqual(t1, t2);
});

test("natural close exit 0: flush -> mandatory final size check -> completed", async (ctx) => {
  const job = makeJob(ctx, { exitCode: 0 });
  fs.writeFileSync(path.join(job.dir, "events.jsonl"), "small", "utf8");
  fs.writeFileSync(job.request.answerFile, "answer", "utf8");
  const t = await onChildClose(job, 0, {});
  assert.equal(t.status, "completed");
  assert.equal(job.roadResolved, true);
});

test("a breach found only at the final check -> failed(output_cap) WINS over completed", async (ctx) => {
  const job = makeJob(ctx, { exitCode: 0 });
  job.request.logCap = 4;
  fs.writeFileSync(path.join(job.dir, "events.jsonl"), "way more than four bytes", "utf8");
  const t = await onChildClose(job, 0, {});
  assert.equal(t.status, "failed");
  assert.equal(t.failure_reason, "output_cap");
});

test("nonzero exit -> failed(nonzero_exit); size check moot", async (ctx) => {
  const job = makeJob(ctx, { exitCode: 3 });
  const t = await onChildClose(job, 3, {});
  assert.equal(t.failure_reason, "nonzero_exit");
});

test("intent precedence: a completed natural close stands; later intents no-op", async (ctx) => {
  const job = makeJob(ctx, { exitCode: 0 });
  fs.writeFileSync(job.request.answerFile, "answer", "utf8");
  const t1 = await onChildClose(job, 0, {});
  const t2 = await recordIntent(job, "cancel", { spawn: fakeKillSpawn(job), isPidAlive: () => false });
  assert.equal(t1.status, "completed");
  assert.deepEqual(t2, t1);
});

test("a recorded intent's terminal wins over a close arriving during the wait", async (ctx) => {
  const job = makeJob(ctx);
  const road = recordIntent(job, "timeout", { spawn: fakeKillSpawn(job), isPidAlive: () => false });
  const closeResult = onChildClose(job, 0, {});
  const t = await road;
  await closeResult;
  assert.equal(t.failure_reason, "timeout");
  assert.equal(job.terminal.failure_reason, "timeout");
});

test("size watcher: tick breach -> output_cap kill road; stat errors skip the tick (LOGGED)", async (ctx) => {
  const job = makeJob(ctx);
  job.request.logCap = 4;
  fs.writeFileSync(path.join(job.dir, "events.jsonl"), "way more than four bytes", "utf8");
  let roadRan = null;
  const deps = {
    spawn: fakeKillSpawn(job), isPidAlive: () => false,
    tickMs: 5,
    onIntent: (kind) => { roadRan = kind; },
  };
  startSizeWatcher(job, deps);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(roadRan, "output_cap");
  // stat error during ticks: the tick is skipped AND the error is logged (log and skip the tick)
  const job2 = makeJob(ctx);
  let road2 = null;
  const lines = [];
  const deps2 = { tickMs: 5, stat: () => { throw new Error("EPERM"); },
    onIntent: (kind) => { road2 = kind; }, log: (m) => lines.push(m) };
  startSizeWatcher(job2, deps2);
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(job2.watcher);
  assert.equal(road2, null);                                    // tick skipped, no breach road
  assert.ok(lines.some((m) => /watcher stat failed/.test(m)));  // logged
});

test("final size check stat-error: LOGGED, natural completed terminal stands", async (ctx) => {
  const job = makeJob(ctx, { exitCode: 0 });
  job.resolved = true;
  const lines = [];
  const t = await onChildClose(job, 0, { stat: () => { throw new Error("EPERM"); }, log: (m) => lines.push(m) });
  assert.equal(t.status, "completed");                            // caps are a soft bound, not a verdict input
  assert.ok(lines.some((m) => /final size stat failed/.test(m))); // logged
});

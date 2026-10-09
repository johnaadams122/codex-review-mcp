// tests/test-cleanup.direct-jobs.test.mjs -- tests/helpers/direct-jobs.mjs: a test's direct-exec jobs
// have their timers stopped before the job folders are removed (see the helper's header for why).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { _newJobForTest, _registry } from "../direct.mjs";
import { dropJob, stopJobsOnCleanup } from "./helpers/direct-jobs.mjs";
import { createRecordingContext } from "./helpers/test-cleanup.mjs";

// Paths only: nothing is created on disk.
const ROOT = path.resolve("codex-mcp-no-such-instance-dir");

function registeredJob(jobId, dir) {
  const job = _newJobForTest({
    jobId, dir, rt: {},
    request: { model: "m", effort: "e", cwd_real: "c", pii: false, timeoutMs: 5, logCap: 1024, answerFile: path.join(dir, "answer.txt") },
  });
  job.watcher = setInterval(() => {}, 60_000); job.watcher.unref();
  job.timer = setTimeout(() => {}, 60_000); job.timer.unref();
  _registry().set(jobId, job);
  return job;
}

test("dropJob clears a job's watcher and kill timer, then forgets it", (t) => {
  const job = registeredJob("drop-1", path.join(ROOT, "drop-1"));
  t.after(() => { clearInterval(job.watcher); clearTimeout(job.timer); _registry().delete("drop-1"); });
  dropJob("drop-1");
  assert.equal(job.watcher, null);
  assert.equal(job.timer, null);
  assert.equal(_registry().has("drop-1"), false);
  dropJob("drop-1");   // an unknown id is a no-op
});

test("stopJobsOnCleanup stops only the jobs under its instance folder (not a sibling sharing the name prefix)", async (t) => {
  const inside = registeredJob("under-1", path.join(ROOT, "under-1"));
  const sibling = registeredJob("sibling-1", path.join(ROOT + "-other", "sibling-1"));
  t.after(() => {
    for (const j of [inside, sibling]) { clearInterval(j.watcher); clearTimeout(j.timer); _registry().delete(j.jobId); }
  });
  const ctx = createRecordingContext();
  stopJobsOnCleanup(ctx, ROOT);
  assert.equal(inside.watcher !== null && _registry().has("under-1"), true, "nothing happens before cleanup");
  await ctx.runHooksLikeNodeTest();
  assert.equal(inside.watcher, null);
  assert.equal(_registry().has("under-1"), false);
  assert.notEqual(sibling.watcher, null, "a job outside the folder is left alone");
  assert.equal(_registry().has("sibling-1"), true);
});

test("stopJobsOnCleanup stops a REAL child still running under the folder, and never calls kill() on a fake child", async (t) => {
  // A real child the job still holds (a timed-out integration test leaves one): it must be gone
  // before the job folder is removed, or Windows refuses the removal.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const real = registeredJob("real-child-1", path.join(ROOT, "real-child-1"));
  real.child = child;
  // A fake child with a made-up pid (the unit tests use 7777): killing "7777" could hit an unrelated
  // process, so only a genuine ChildProcess handle of this test process may be stopped.
  let fakeKilled = false;
  const fake = registeredJob("fake-child-1", path.join(ROOT, "fake-child-1"));
  fake.child = { pid: 7777, exitCode: null, kill() { fakeKilled = true; } };
  t.after(() => {
    for (const j of [real, fake]) { clearInterval(j.watcher); clearTimeout(j.timer); _registry().delete(j.jobId); }
  });
  const ctx = createRecordingContext();
  stopJobsOnCleanup(ctx, ROOT);
  await ctx.runHooksLikeNodeTest();
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the real child has exited by the time cleanup returns");
  assert.equal(fakeKilled, false, "a fake child is never killed");
  assert.equal(_registry().has("real-child-1"), false);
  assert.equal(_registry().has("fake-child-1"), false);
});

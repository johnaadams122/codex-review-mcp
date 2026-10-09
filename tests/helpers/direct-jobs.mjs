// tests/helpers/direct-jobs.mjs -- stop a test's direct-exec jobs before their folders are removed.
//
// A job whose fake child never closes keeps its kill timer and its 3 s size watcher (direct.mjs
// startSizeWatcher) alive after the test ends. Both are unref'd, so they never held a run open, and
// while test folders were never removed the watcher kept stat-ing files that still existed. Now that
// tempDirFor removes the folders, a live watcher logs "watcher stat failed: ENOENT" every tick. So a
// test drops a finished job with dropJob, and stopJobsOnCleanup stops whatever the test left behind:
// timers always, and a REAL child still running (tests/integration.direct.test.mjs spawns the fake
// codex binary; a failed or timed-out test can leave it holding the job folders, which Windows then
// refuses to remove).
import { ChildProcess } from "node:child_process";
import path from "node:path";
import { _registry, clearJobTimers } from "../../direct.mjs";
import { onCleanup } from "./test-cleanup.mjs";

// How long cleanup waits for a stopped child to exit before moving on (the folder removal that
// follows then reports any handle it still holds).
const CHILD_EXIT_WAIT_MS = 10_000;

// Stop a job's timers, then forget it (replaces a bare `_registry().delete(jobId)`).
export function dropJob(jobId) {
  const job = _registry().get(jobId);
  if (job) clearJobTimers(job);
  _registry().delete(jobId);
}

// Stop a child this test process spawned, through its own handle, and wait for it to exit. Only a
// genuine ChildProcess qualifies: the unit tests' fake children carry made-up pids (7777) that may
// belong to an unrelated process, so they are never signalled.
async function stopChild(child) {
  if (!(child instanceof ChildProcess) || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, CHILD_EXIT_WAIT_MS); })]);
  clearTimeout(timer);
}

// Register a cleanup step that stops and forgets every registered job living under instanceDir.
// Call it AFTER the folders are made: steps run newest-first, so this runs before they are removed.
export function stopJobsOnCleanup(t, instanceDir) {
  onCleanup(t, async () => {
    for (const [jobId, job] of [..._registry()]) {
      if (typeof job.dir !== "string" || !job.dir.startsWith(instanceDir + path.sep)) continue;
      dropJob(jobId);
      await stopChild(job.child);
    }
  });
}

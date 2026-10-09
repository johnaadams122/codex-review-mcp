// tests/gate-run.launch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchDetached } from "../hooks/gate-run.mjs";

test("launchDetached does the atomic claim then spawns detached+unref with epoch/diffId/targetKey argv", () => {
  let claimSpec = null, spawnArgs = null, pidPatch = null;
  const fakeChild = { pid: 4242, unref() { this.unrefed = true; } };
  const deps = {
    claimAttempt: (root, spec) => { claimSpec = { root, spec }; return { claimed: true, attemptEpoch: 3 }; },
    upsertRun: (root, id, patch) => { pidPatch = patch; return { ...patch }; },
    spawn: (bin, args, opts) => { spawnArgs = { bin, args, opts }; return fakeChild; },
    now: () => new Date("2026-07-18T12:00:00"),
  };
  const decision = { action: "launch", runId: "R1", repoRoot: "/repo", targetKey: "d1", diffId: "d1", payloadRef: { kind: "patch", path: "/repo/.superpowers/gate-runs/R1/payload.patch" }, dayKey: "2026-07-18", jobs: 2 };
  const ev = { sessionId: "s1", cwd_real: "/repo", target: { kind: "worktree" } };
  const r = launchDetached(decision, ev, deps);
  assert.equal(r.pid, 4242);
  assert.equal(r.claimed, true);
  assert.equal(claimSpec.root, "/repo");
  assert.equal(claimSpec.spec.targetKey, "d1");
  assert.equal(claimSpec.spec.entry.jobs_reserved, 2);
  assert.equal(spawnArgs.opts.detached, true);
  assert.equal(spawnArgs.opts.stdio, "ignore");
  assert.ok(spawnArgs.args.includes("--run-id") && spawnArgs.args.includes("R1"));
  assert.ok(spawnArgs.args.includes("--attempt-epoch") && spawnArgs.args.includes("3")); // the claimed epoch
  assert.ok(spawnArgs.args.includes("--diff-id") && spawnArgs.args.includes("--target-key"));
  assert.equal(pidPatch.pid, 4242);                          // child pid recorded post-spawn
  assert.equal(fakeChild.unrefed, true);
});

test("launchDetached on a DEBOUNCED claim does NOT spawn (cross-process single-flight)", () => {
  let spawned = false;
  const deps = {
    claimAttempt: () => ({ claimed: false, reason: "debounced" }),
    spawn: () => { spawned = true; return { pid: 1, unref() {} }; },
    now: () => new Date("2026-07-18T12:00:00"),
  };
  const decision = { action: "launch", runId: "R2", repoRoot: "/repo", targetKey: "d1", diffId: "d1", payloadRef: { kind: "commit", sha: "abc" }, dayKey: "2026-07-18", jobs: 2 };
  const r = launchDetached(decision, { sessionId: "s1", cwd_real: "/repo" }, deps);
  assert.equal(r.claimed, false);
  assert.equal(spawned, false);
});

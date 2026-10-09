// tests/integration.gate-hook-phase2.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classify, launchDetached } from "../hooks/gate-run.mjs";
import { runLadder } from "../hooks/gate-recovery.mjs";
import { surfaceOnce, markSurfaced } from "../hooks/gate-surface.mjs";
import { upsertRun, readJournal, claimAttempt, dayKey } from "../hooks/run-journal.mjs";
import { sweepJournal } from "../hooks/gate-supervisor.mjs";
import { onCleanup, tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, BETA } from "./helpers/policy-fixture.mjs";

// the in-process tests inject their policy; the allowlist gate itself reads the policy settings file
installPolicyFixture({ after }, { gateAllowlist: [BETA.name] });

function repoWithAutogate(t) {
  const d = tempDirFor(t, "e2e-", { realpath: true });
  fs.writeFileSync(path.join(d, ".codex-autogate"), "");
  return d;
}
const T = new Date("2026-07-18T12:00:00");
// a pid that no process has (liveness is faked in this test)
const DEAD_PID = 2 ** 30;
const cleanDeps = () => ({
  runGit: (args) => (args[0] === "diff" ? "diff --git a/x.js b/x.js\n+const y=1" : ""),
  listUntracked: () => [],
  realpath: (p) => p,
  resolvePolicy: () => ({ pii_sensitive: false, name: BETA.name }),
  projectNameOf: () => BETA.name,
  now: () => T,
});

test("IN-PROCESS glue: classify -> claim -> child ladder PASS -> reconcile -> surface (emit then mark)", async (t) => {
  const cwd = repoWithAutogate(t);
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, cleanDeps());
  assert.equal(d.action, "launch");
  assert.equal(d.repoRoot, cwd);
  // launcher atomic-claims + "spawns" (fake spawn); the claim writes the running entry with epoch 1
  const r = launchDetached(d, ev, { ...cleanDeps(), spawn: () => ({ pid: 4242, unref() {} }) });
  assert.equal(r.claimed, true);
  assert.equal(readJournal(cwd)[d.runId].status, "running");
  // the child runs the ladder and reconciles (epoch-guarded) exactly as cli.mjs would
  const verdict = await runLadder({ event: ev, runId: d.runId, targetKey: d.targetKey, payloadRef: d.payloadRef },
    { recheck: async () => ({ ok: true }), isLiveEpoch: () => true, epoch: r.attemptEpoch,
      runGateOnce: async () => ({ status: "complete", consensus_verdict: "pass", blockers: [], reviewers: [], abstentions: [], identity_errors: [], strength: { backbone_attested: true } }) });
  upsertRun(cwd, d.runId, { status: verdict.status, reviewer: verdict.reviewer }, { expectEpoch: r.attemptEpoch });
  const a = surfaceOnce(cwd);
  assert.ok(a.line.includes("PASS"));
  markSurfaced(cwd, a.runId);                        // emit-then-mark
  assert.equal(surfaceOnce(cwd).line, null);         // surfaced once
});

test("forced incompleteness on both attempts -> FAILED with a reason, surfaced", async (t) => {
  const cwd = repoWithAutogate(t);
  const inc = { status: "complete", consensus_verdict: "block", blockers: [], reviewers: [], abstentions: [{ reason: "missing" }], identity_errors: [], diff_truncated: false, strength: { backbone_attested: true } };
  const verdict = await runLadder({ event: {}, runId: "R9", targetKey: "d9", payloadRef: {} },
    { recheck: async () => ({ ok: true }), isLiveEpoch: () => true, epoch: 1, runGateOnce: async () => inc });
  assert.equal(verdict.status, "failed");
  assert.equal(verdict.attempts.length, 2);
  // Note: upsertRun does not default a brand-new entry's `surfaced` field (only claimAttempt does, via
  // its explicit `surfaced: false` in the claimed entry) -- so an entry created directly via
  // upsertRun (bypassing claimAttempt, as this test intentionally does to exercise runLadder's
  // failure classification in isolation) has surfaced===undefined, which surfaceOnce's claim
  // check (`e.surfaced === false`) does not treat as claimable, and the entry is silently never
  // surfaced. Set it explicitly here.
  upsertRun(cwd, "R9", { status: "failed", reviewer: verdict.reviewer, failure_reason: verdict.failure_reason, surfaced: false });
  assert.ok(surfaceOnce(cwd).line.includes("FAILED"));
});

test("crashed detached run (dead pid, running, NO verdict.json) is reaped to FAILED then surfaced", (t) => {
  const cwd = repoWithAutogate(t);
  upsertRun(cwd, "R5", { status: "running", pid: DEAD_PID, attemptEpoch: 1, deadlineAt: "2999-01-01T00:00:00Z", surfaced: false, reviewer: "codex:terra" });
  sweepJournal(cwd, { isPidAlive: () => false, readVerdict: () => null });
  assert.equal(readJournal(cwd)["R5"].status, "failed");
  assert.ok(surfaceOnce(cwd).line.includes("FAILED"));
});

test("REAL detached child: `node cli.mjs gate --run-id` reaches the review path, terminalizes + writes artifact", async (t) => {
  // Run under an ALLOWLISTED root so the child's real makeRecheck allowlist gate PASSES and the ladder
  // actually reaches runGate + the fake companion -- a tmpdir resolves to policy 'unknown' and the child
  // would short-circuit to failed:not_allowlisted WITHOUT exercising the review. The
  // policy fixture registers this temp folder as the synthetic beta project and allowlists it; the
  // child inherits CODEX_MCP_POLICY_FILE from this process.
  const cwd = tempDirFor(t, "e2e-", { realpath: true });   // removed by the hook even on failure/timeout
  installPolicyFixture(t, { projectsBase: path.dirname(cwd), projects: [{ ...BETA, dir: path.basename(cwd) }], gateAllowlist: [BETA.name] });
  fs.writeFileSync(path.join(cwd, ".codex-autogate"), "");
  const runId = "E2E1";
  const runDir = path.join(cwd, ".superpowers", "gate-runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const patch = "diff --git a/x.js b/x.js\n+const y = 1;\n";
  const patchPath = path.join(runDir, "payload.patch");
  fs.writeFileSync(patchPath, patch);
  const diffId = createHash("sha256").update(Buffer.from(patch, "utf8")).digest("hex");
  claimAttempt(cwd, { runId, targetKey: diffId, dayKey: dayKey(T), entry: { diffId, payloadRef: { kind: "patch", path: patchPath } } });
  const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url)); // <repo>/tests/fixtures/scripts/codex-companion.mjs
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  await new Promise((res, rej) => {
    const c = spawn(process.execPath,
      [cli, "gate", "--phase=impl", "--run-id", runId, "--payload-ref", "patch:" + patchPath,
       "--target-key", diffId, "--attempt-epoch", "1", "--diff-id", diffId, "--cwd", cwd],
      { stdio: "ignore", env: { ...process.env, CLAUDE_PLUGIN_ROOT: fixtureRoot } });
    // Registered after the folder, so it runs first: a child still running at cleanup (a timed-out
    // test) is stopped, by its own pid, before the folder it works in is removed.
    onCleanup(t, () => { if (c.exitCode === null && c.signalCode === null) c.kill(); });
    c.on("exit", () => res());   // a --run-id child exits 0 regardless of verdict
    c.on("error", rej);
  });
  const entry = readJournal(cwd)[runId];
  assert.ok(entry && ["pass", "block", "failed", "error"].includes(entry.status), "terminalized, got: " + (entry && entry.status));
  // CRUCIAL discriminator: the ladder must REACH the fake companion's fan-out, proven by
  // jobs_submitted > 0 (beforeSubmit->recordSubmission fires per provider.submit). A pre-companion
  // short-circuit (not_allowlisted / payload_unreadable / recheck_error / blocked / diff_error) leaves
  // jobs_submitted at 0. This proves the pinned-payload review path actually ran, not just spawn+terminalize.
  assert.ok((entry.jobs_submitted ?? 0) > 0, "the ladder reached the companion fan-out (jobs_submitted>0), status=" + entry.status + " reason=" + entry.failure_reason);
  assert.equal(entry.diffId, diffId);
  assert.ok(fs.existsSync(path.join(runDir, "verdict.json")), "durable verdict artifact written");
});

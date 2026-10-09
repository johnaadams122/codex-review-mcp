// codex_cancel MSYS/pid-null defect: the companion's
// handleCancel (a) shells its taskkill through win32 `shell: SHELL || true`,
// which under a Git-Bash-hosted session lets MSYS mangle /PID into a path (its
// kill never lands), and (b) unconditionally rewrites the record pid:null +
// status "cancelled" regardless of kill outcome. Any post-cancel verify
// therefore reads pid:null and kills nothing while the worker computes on.
// cancelJob must snapshot the pid BEFORE companion cancel and tree-kill it
// itself via a direct argv spawn (no shell -> no MSYS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelJob } from "../jobs.mjs";

function statefulStatus({ prePid }) {
  // Mirrors the real companion: pid present while running, null after cancel.
  const state = { cancelled: false };
  return {
    state,
    getStatusFn: async () => ({
      job: state.cancelled
        ? { id: "j1", status: "cancelled", pid: null }
        : { id: "j1", status: "running", pid: prePid },
    }),
  };
}

test("cancelJob kills the PRE-cancel pid (post-cancel record has pid nulled)", async () => {
  const { state, getStatusFn } = statefulStatus({ prePid: 4242 });
  const killed = [];
  const result = await cancelJob("j1", "C:\\ws", {
    // Cancel is gated (token OR owner path). This test exercises cwd
    // threading with a non-null cwd, so pin the server's own workspace to that cwd to
    // keep it OWNED -- the gate is exercised in jobs.ownership / jobs.session-token.
    selfWorkspaceRoot: "C:\\ws",
    getStatusFn,
    runCompanionFn: async (args) => {
      assert.equal(args[0], "cancel");
      state.cancelled = true;   // companion nulls the pid from here on
      return { stdout: JSON.stringify({ jobId: "j1", status: "cancelled" }) };
    },
    isPidAliveFn: (pid) => pid === 4242,
    getPidCommandLineFn: () => "node codex-companion.mjs task-worker",
    killTreeVerifiedFn: async (pid) => { killed.push(pid); return { verified: true }; },
  });
  assert.deepEqual(killed, [4242]);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.kill, { pid: 4242, verified: true });
});

test("cancelJob: companion cancel rejects (frozen record) but a verified kill still cancels", async () => {
  const { getStatusFn } = statefulStatus({ prePid: 555 });
  const killed = [];
  const result = await cancelJob("j1", null, {
    getStatusFn,
    runCompanionFn: async () => { throw new Error('companion exited 1: No job found for "j1"'); },
    isPidAliveFn: () => true,
    getPidCommandLineFn: () => "node codex-companion.mjs task-worker",
    killTreeVerifiedFn: async (pid) => { killed.push(pid); return { verified: true }; },
  });
  assert.deepEqual(killed, [555]);
  assert.equal(result.status, "cancelled");
  assert.match(result.companion_cancel_error, /No job found/);
  assert.equal(result.kill.verified, true);
});

test("cancelJob: companion cancel rejects and no pid is obtainable -> rethrows", async () => {
  await assert.rejects(
    cancelJob("j1", null, {
      getStatusFn: async () => { throw new Error("status down"); },
      runCompanionFn: async () => { throw new Error("companion exited 1: cancel down"); },
      isPidAliveFn: () => false,
      killTreeVerifiedFn: async () => ({ verified: true }),
    }),
    /cancel down/
  );
});

test("cancelJob: pre-pid already dead -> reported, kill fn never spawned", async () => {
  const { state, getStatusFn } = statefulStatus({ prePid: 777 });
  let killCalls = 0;
  const result = await cancelJob("j1", null, {
    getStatusFn,
    runCompanionFn: async () => { state.cancelled = true; return { stdout: JSON.stringify({ jobId: "j1", status: "cancelled" }) }; },
    isPidAliveFn: () => false,
    killTreeVerifiedFn: async () => { killCalls += 1; return { verified: true }; },
  });
  assert.equal(killCalls, 0);
  assert.deepEqual(result.kill, { pid: 777, verified: true, already_dead: true });
});

test("cancelJob: pid whose identity is not codex-like is NEVER tree-killed (pid-reuse defense)", async () => {
  // The job can finish between the snapshot
  // and the kill, and Windows can hand the pid to a stranger. Foreign or
  // unreadable identity -> skip the kill, report it.
  const { state, getStatusFn } = statefulStatus({ prePid: 999 });
  let killCalls = 0;
  const result = await cancelJob("j1", null, {
    getStatusFn,
    runCompanionFn: async () => { state.cancelled = true; return { stdout: JSON.stringify({ jobId: "j1", status: "cancelled" }) }; },
    isPidAliveFn: () => true,
    getPidCommandLineFn: () => ["C:", "Windows", "explorer.exe"].join("\\"),
    killTreeVerifiedFn: async () => { killCalls += 1; return { verified: true }; },
  });
  assert.equal(killCalls, 0);
  assert.deepEqual(result.kill, { pid: 999, verified: false, skipped: "identity_unverified", identity: "non-codex" });
  // unreadable identity (null) also skips
  const r2 = await cancelJob("j1", null, {
    getStatusFn: (async () => ({ job: { id: "j1", status: "running", pid: 999 } })),
    runCompanionFn: async () => ({ stdout: JSON.stringify({ jobId: "j1", status: "cancelled" }) }),
    isPidAliveFn: () => true,
    getPidCommandLineFn: () => null,
    killTreeVerifiedFn: async () => { killCalls += 1; return { verified: true }; },
  });
  assert.equal(killCalls, 0);
  assert.equal(r2.kill.identity, "unreadable");
});

test("cancelJob: an UNVERIFIED kill after a companion-cancel rejection rethrows (never a false cancelled)", async () => {
  const { getStatusFn } = statefulStatus({ prePid: 888 });
  await assert.rejects(
    cancelJob("j1", null, {
      getStatusFn,
      runCompanionFn: async () => { throw new Error("companion exited 1: cancel down"); },
      isPidAliveFn: () => true,
    getPidCommandLineFn: () => "node codex-companion.mjs task-worker",
      killTreeVerifiedFn: async () => ({ verified: false }),
    }),
    /cancel down/
  );
});

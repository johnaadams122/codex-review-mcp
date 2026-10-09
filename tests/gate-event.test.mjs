import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommitEvent, buildWorktreeEvent, validateEvent } from "../hooks/gate-event.mjs";

const realpath = (p) => "/real" + p; // fake canonicalization

test("commit and worktree adapters reconcile into ONE shape; cwd is realpathed first", () => {
  const c = buildCommitEvent({ sessionId: "s1", cwd: "/repo", sha: "abc123", triggeredAt: "T" }, { realpath });
  assert.deepEqual(c, { sessionId: "s1", cwd_real: "/real/repo", target: { kind: "commit", sha: "abc123" }, triggeredAt: "T" });
  const w = buildWorktreeEvent({ sessionId: "s1", cwd: "/repo", patchRef: "R1/payload.patch", triggeredAt: "T" }, { realpath });
  assert.equal(w.target.kind, "worktree");
  assert.equal(w.cwd_real, "/real/repo");
});

test("realpath failure fails closed to cwd_real=null and validateEvent rejects it", () => {
  const throwing = () => { throw new Error("ENOENT"); };
  const c = buildCommitEvent({ sessionId: "s1", cwd: "/repo", sha: "abc" }, { realpath: throwing });
  assert.equal(c.cwd_real, null);
  assert.equal(validateEvent(c), false);
});

test("validateEvent rejects unknown target kinds and missing sessionId", () => {
  assert.equal(validateEvent({ sessionId: "s", cwd_real: "/r", target: { kind: "nope" } }), false);
  assert.equal(validateEvent({ cwd_real: "/r", target: { kind: "commit", sha: "a" } }), false);
  assert.equal(validateEvent({ sessionId: "s", cwd_real: "/r", target: { kind: "commit", sha: "a" } }), true);
});

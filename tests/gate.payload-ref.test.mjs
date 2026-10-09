// tests/gate.payload-ref.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGate } from "../gate.mjs";

// Capture what the panel actually reviewed via an injected runPanel that echoes the payload.
function harness(extra = {}) {
  let seenDiff = null;
  const runPanel = async (opts, deps) => {
    seenDiff = deps.gatherDiff().diff;
    return { consensus_verdict: "pass", status: "complete", reviewers: [], findings: [], blockers: [], dissent: [], abstentions: [], identity_errors: [], strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "medium" }, backbone_attested: true } };
  };
  return { seen: () => seenDiff, deps: { runPanel, admit: () => ({ allowed: true }), gatherDiff: () => { throw new Error("gatherDiff MUST NOT be called when payloadRef is set"); }, ...extra } };
}

test("payloadRef (patch) is reviewed verbatim; gatherDiff is NOT called", async () => {
  const h = harness({ readFile: () => "PINNED-PATCH-BYTES" });
  const res = await runGate(
    { phase: "impl", cwd: "/repo", strength: { model: "gpt-6.1-sol", effort: "medium" }, payloadRef: { kind: "patch", path: "/repo/.superpowers/gate-runs/R1/payload.patch" } },
    h.deps);
  assert.equal(res.consensus_verdict, "pass");
  assert.ok(h.seen().includes("PINNED-PATCH-BYTES"));
});

test("payloadRef (commit) pins git diff <sha>~1..<sha>", async () => {
  const h = harness({ runGit: (args) => (args.join(" ") === "diff abc~1..abc" ? "COMMIT-DIFF" : "") });
  const res = await runGate(
    { phase: "impl", cwd: "/repo", strength: { model: "gpt-6.1-sol", effort: "medium" }, payloadRef: { kind: "commit", sha: "abc" } },
    h.deps);
  assert.ok(h.seen().includes("COMMIT-DIFF"));
});

test("runGate FORWARDS deps.beforeSubmit into the panel deps (budget seam wired)", async () => {
  let seen = null;
  const runPanel = async (_opts, deps) => { seen = deps.beforeSubmit; return { consensus_verdict: "pass", status: "complete", reviewers: [], findings: [], blockers: [], dissent: [], abstentions: [], identity_errors: [], strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "medium" }, backbone_attested: true } }; };
  const bs = async () => ({ ok: true });
  await runGate(
    { phase: "impl", cwd: "/repo", strength: { model: "gpt-6.1-sol", effort: "medium" }, payloadRef: { kind: "commit", sha: "abc" } },
    { runPanel, admit: () => ({ allowed: true }), runGit: () => "D", beforeSubmit: bs });
  assert.equal(seen, bs);   // the exact callback reaches runPanel -> the fan-out can veto submissions
});

test("runGate FORWARDS deps.afterSubmit into the panel deps (jobId-persist seam wired)", async () => {
  let seen = "unset";
  const runPanel = async (_opts, deps) => { seen = deps.afterSubmit; return { consensus_verdict: "pass", status: "complete", reviewers: [], findings: [], blockers: [], dissent: [], abstentions: [], identity_errors: [], strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "medium" }, backbone_attested: true } }; };
  const as = async () => {};
  await runGate(
    { phase: "impl", cwd: "/repo", strength: { model: "gpt-6.1-sol", effort: "medium" }, payloadRef: { kind: "commit", sha: "abc" } },
    { runPanel, admit: () => ({ allowed: true }), runGit: () => "D", afterSubmit: as });
  assert.equal(seen, as);   // the exact callback reaches runPanel -> the fan-out can persist the jobId
});

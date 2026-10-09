import { test } from "node:test";
import assert from "node:assert/strict";
import { runPanel } from "../panel.mjs";
import { ROLES } from "../reviewers.mjs";

// A minimal fake backbone provider satisfying the ReviewerProvider contract.
function fakeProvider(verdict = { verdict: "pass", findings: [] }) {
  let n = 0;
  return {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: `job-${n++}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult() { return { output: JSON.stringify(verdict) }; },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
}

const baseDeps = (overrides = {}) => ({
  admit: () => ({ allowed: true, project: "project_beta" }),
  gatherDiff: () => ({ diff: "diff --git a b\n+x", truncated: false, bytes: 10, scope: "working-tree", base: "main", treeClean: false }),
  redactSecrets: (d) => d,
  ...overrides,
});

test("runPanel drives an injected provider set and passes with all-pass reviewers", async () => {
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [fakeProvider()] }));
  assert.equal(res.consensus_verdict, "pass");
  assert.equal(res.reviewers.length, 3, "one reviewer per default lens");
  assert.ok(res.reviewers.every((r) => r.model === "gpt-6.1-sol"), "each reviewer records its strength");
  assert.ok(res.reviewers.every((r) => r.role === ROLES.BACKBONE), "each reviewer records its role");
});

test("runPanel through providers: a backbone block verdict -> consensus block", async () => {
  const blocker = fakeProvider({ verdict: "block", findings: [{ severity: "blocker", file: "f", line: 1, summary: "leak" }] });
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [blocker] }));
  assert.equal(res.consensus_verdict, "block");
});

test("runPanel default provider path still submits every lens on flagship sol/xhigh (behavior preserved)", async () => {
  // No providers injected -> legacy per-fn deps wrap into the codex backbone provider.
  const submitted = [];
  const res = await runPanel({ cwd: "/repo" }, baseDeps({
    submitReviewer: async (prompt, o) => { submitted.push(o); return { job_id: "j" + submitted.length }; },
    pollToTerminal: async () => "completed",
    getResult: async () => ({ output: '{"verdict":"pass","findings":[]}' }),
    cancelJob: async () => ({}),
  }));
  assert.equal(res.consensus_verdict, "pass");
  assert.equal(submitted.length, 3);
  assert.equal(submitted[0].model, "gpt-6.1-sol");
  assert.equal(submitted[0].effort, "xhigh");
});

// tests/gate.pii-review-unblock.test.mjs -- integration coverage for a pii, no-git project whose policy
// row sets review: true, using the REAL admit()/resolvePolicy() AND the REAL runPanel (not
// mocked, unlike gate.run.test.mjs's fakeFs().admit stub) so the actual gate.mjs <->
// admission.mjs <-> panel.mjs wiring is what's under test.
//
// This is deliberately NOT a thin wrapper over a stubbed runPanel: stubbing runPanel via
// deps.runPanel would only exercise gate.mjs's OWN admission pre-check and never panel.mjs's
// SEPARATE, independent admission call in runPanel. Injecting only the low-level reviewer deps
// (submitReviewer/pollToTerminal/getResult) and letting the real runPanel run covers both.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { runGate } from "../gate.mjs";
import { installPolicyFixture, DELTA, EPSILON } from "./helpers/policy-fixture.mjs";

const fx = installPolicyFixture({ after });
// pii + review allowed + no git, and pii + review blocked
const PII_CWD = fx.dirOf(DELTA);
const PHI_CWD = fx.dirOf(EPSILON);

// Low-level reviewer deps only -- runPanel itself is REAL, so its own admission check
// genuinely runs, not just gate.mjs's earlier one.
const passReviewerDeps = {
  submitReviewer: async () => ({ job_id: "j1" }),
  pollToTerminal: async () => "completed",
  getResult: async () => ({ output: '{"verdict":"pass","findings":[]}' }),
  cancelJob: async () => ({}),
};

function fakeReads(cwd, files) {
  return {
    realpath: (p) => {
      const n = String(p);
      if (n === cwd) return cwd;
      const rel = n.startsWith(cwd + "\\") ? n.slice(cwd.length + 1).replace(/\\/g, "/") : n;
      if (rel in files) return n;
      throw new Error("ENOENT: " + p);
    },
    readFile: (p) => {
      const n = String(p);
      const rel = n.startsWith(cwd + "\\") ? n.slice(cwd.length + 1).replace(/\\/g, "/") : n;
      if (rel in files) return files[rel];
      throw new Error("ENOENT read: " + p);
    },
  };
}

test("real admission + real runPanel: spec-phase gate on a pii, no-git, review-allowed project is admitted end-to-end -- both gate.mjs's and panel.mjs's independent admission checks must agree", async () => {
  const res = await runGate(
    { phase: "spec", cwd: PII_CWD, target_files: ["specs/fake-spec.md"] },
    { ...fakeReads(PII_CWD, { "specs/fake-spec.md": "spec content" }), panelDeps: passReviewerDeps }
  );
  assert.equal(res.consensus_verdict, "pass");
  assert.notEqual(res.status, "blocked");
});

test("real admission + real runPanel: plan-phase gate on a pii, no-git, review-allowed project is admitted end-to-end", async () => {
  const res = await runGate(
    { phase: "plan", cwd: PII_CWD, target_files: ["plans/fake-plan.md"] },
    { ...fakeReads(PII_CWD, { "plans/fake-plan.md": "plan content" }), panelDeps: passReviewerDeps }
  );
  assert.equal(res.consensus_verdict, "pass");
  assert.notEqual(res.status, "blocked");
});

test("real admission + real runPanel: impl-phase gate on that project is STILL blocked at BOTH admission layers -- impl needs a real git diff and the project is no-git (unchanged by the review_allowed change)", async () => {
  const res = await runGate(
    { phase: "impl", cwd: PII_CWD },
    { ...fakeReads(PII_CWD, {}), panelDeps: passReviewerDeps }
  );
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "git_not_allowed");
});

test("real admission: spec-phase gate on a pii project without a review override stays blocked at gate.mjs's own pre-check", async () => {
  const res = await runGate(
    { phase: "spec", cwd: PHI_CWD, target_files: ["fake-spec.md"] },
    { ...fakeReads(PHI_CWD, { "fake-spec.md": "spec content" }), panelDeps: passReviewerDeps }
  );
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "pii_project");
});

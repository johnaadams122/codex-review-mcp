// tests/gate-recovery.taxonomy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVerdict } from "../hooks/gate-recovery.mjs";

const base = { blockers: [], reviewers: [], abstentions: [], identity_errors: [], diff_truncated: false };

test("empty_diff -> clean_pass", () => {
  assert.equal(classifyVerdict({ ...base, status: "empty_diff", consensus_verdict: "pass" }).kind, "clean_pass");
});
test("consensus pass -> clean_pass", () => {
  assert.equal(classifyVerdict({ ...base, status: "complete", consensus_verdict: "pass" }).kind, "clean_pass");
});
test("block WITH a real blocker -> clean_block (no retry)", () => {
  assert.equal(classifyVerdict({ ...base, status: "complete", consensus_verdict: "block", blockers: [{ severity: "blocker" }] }).kind, "clean_block");
});
test("block, no real blocker, truncated -> diff_too_large (terminal FAILED, no shrink-to-pass)", () => {
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "block", diff_truncated: true });
  assert.equal(r.kind, "diff_too_large");
});
test("a budget_capped abstention -> budget_capped (terminal, NO retry) not incompleteness", () => {
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "block", abstentions: [{ reason: "budget_capped" }] });
  assert.equal(r.kind, "budget_capped");
  assert.equal(r.failure_reason, "budget");
});
test("block, no real blocker, abstentions, NOT truncated -> incompleteness (retry)", () => {
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "block", abstentions: [{ reason: "missing" }] });
  assert.equal(r.kind, "incompleteness");
});
test("config/input error status -> config_error (no reviewer recovery)", () => {
  assert.equal(classifyVerdict({ ...base, status: "strength_below_floor", consensus_verdict: "error" }).kind, "config_error");
});
test("an UNKNOWN non-complete status with consensus pass is config_error, NOT a fabricated pass", () => {
  // an allowlist-based status check would let this fall through to clean_pass; precedence must fail closed first.
  assert.equal(classifyVerdict({ ...base, status: "some_future_status", consensus_verdict: "pass" }).kind, "config_error");
});
test("a REAL blocker that is ALSO truncated -> clean_block (real-blocker precedes diff_too_large)", () => {
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "block", blockers: [{ severity: "blocker" }], diff_truncated: true });
  assert.equal(r.kind, "clean_block");
});
test("error with identity_errors -> structural (hard-fail)", () => {
  assert.equal(classifyVerdict({ ...base, status: "complete", consensus_verdict: "error", identity_errors: [{ reason: "x" }] }).kind, "structural");
});
test("error, all-backbone-abstain -> transient (retry then FAILED)", () => {
  assert.equal(classifyVerdict({ ...base, status: "complete", consensus_verdict: "error", abstentions: [{ reason: "missing" }] }).kind, "transient");
});

// --- PRECEDENCE GUARDS: a real block/identity error must NEVER be masked as budget_capped ---
test("PRECEDENCE: a real blocker WINS over a co-occurring budget_capped abstention -> clean_block, NOT budget_capped", () => {
  // Swapping the realBlocker/budgetCapped checks would return budget_capped here; this discriminates it.
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "block", blockers: [{ severity: "blocker" }], abstentions: [{ reason: "budget_capped" }] });
  assert.equal(r.kind, "clean_block");
});
test("PRECEDENCE: a reviewer verdict:block WINS over budget_capped (realBlocker via reviewers[], not blockers[])", () => {
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "block", reviewers: [{ verdict: "block" }], abstentions: [{ reason: "budget_capped" }] });
  assert.equal(r.kind, "clean_block");
});
test("error branch: budget_capped abstention with NO identity errors -> budget_capped terminal", () => {
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "error", abstentions: [{ reason: "budget_capped" }] });
  assert.equal(r.kind, "budget_capped");
  assert.equal(r.failure_reason, "budget");
});
test("error branch PRECEDENCE: identity_errors WIN over a co-occurring budget_capped -> structural, NOT budget_capped", () => {
  const r = classifyVerdict({ ...base, status: "complete", consensus_verdict: "error", identity_errors: [{ reason: "x" }], abstentions: [{ reason: "budget_capped" }] });
  assert.equal(r.kind, "structural");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRoute, CODEX_TIERS } from "../routing.mjs";

const SAFE_POLICY    = { pii_sensitive: false, write_allowed: false, git_allowed: true };
const PII_POLICY     = { pii_sensitive: true,  write_allowed: false, git_allowed: false };
const WRITABLE_POLICY = { pii_sensitive: false, write_allowed: true,  git_allowed: true };

test("summarize task routes to local", () => {
  const r = computeRoute("summarize this log file", SAFE_POLICY);
  assert.equal(r.tier, "local");
  assert.equal(r.reason, "trivial_text_op");
  assert.deepEqual(r.risk_flags, []);
});

test("classify task routes to local", () => {
  const r = computeRoute("classify these alerts as high/medium/low", SAFE_POLICY);
  assert.equal(r.tier, "local");
});

test("extract task routes to local", () => {
  const r = computeRoute("extract the JSON fields from this response", SAFE_POLICY);
  assert.equal(r.tier, "local");
});

test("multi-file refactor routes to codex", () => {
  const r = computeRoute("refactor the strategy module across multiple files", SAFE_POLICY);
  assert.equal(r.tier, "codex");
  assert.ok(r.risk_flags.includes("multi_file"));
});

test("implement feature routes to codex", () => {
  const r = computeRoute("implement a new equity guard feature", SAFE_POLICY);
  assert.equal(r.tier, "codex");
});

test("pii project read task routes to codex (read-only review allowed)", () => {
  const r = computeRoute("refactor the trading module", PII_POLICY);
  assert.equal(r.tier, "codex");
  assert.ok(r.risk_flags.includes("sensitive_project"));
});

test("pii project write task routes to claude (write still blocked)", () => {
  const r = computeRoute("refactor the trading module", PII_POLICY, null, { write: true });
  assert.equal(r.tier, "claude");
  assert.equal(r.reason, "pii_project_write_blocked");
  assert.ok(r.risk_flags.includes("sensitive_project"));
});

test("judgment task routes to claude", () => {
  const r = computeRoute("plan the migration strategy", SAFE_POLICY);
  assert.equal(r.tier, "claude");
});

test("forceTier overrides routing for non-pii project", () => {
  const r = computeRoute("summarize this", SAFE_POLICY, "codex");
  assert.equal(r.tier, "codex");
  assert.equal(r.reason, "forced_by_caller");
});

test("forceTier codex on pii read task routes to codex", () => {
  const r = computeRoute("summarize this", PII_POLICY, "codex");
  assert.equal(r.tier, "codex");
  assert.equal(r.reason, "forced_by_caller");
});

test("forceTier codex on pii write task still routes to claude", () => {
  const r = computeRoute("summarize this", PII_POLICY, "codex", { write: true });
  assert.equal(r.tier, "claude");
  assert.equal(r.reason, "pii_project_write_blocked");
});

test("irreversible keywords set risk flag", () => {
  const r = computeRoute("delete the old tables and truncate logs", SAFE_POLICY);
  assert.ok(r.risk_flags.includes("irreversible"));
});

test("risk_flags does not include sensitive_project for non-pii project", () => {
  const r = computeRoute("summarize", SAFE_POLICY);
  assert.ok(!r.risk_flags.includes("sensitive_project"));
});

test("CODEX_TIERS exports flagship with correct model and effort", () => {
  assert.equal(CODEX_TIERS.flagship.model, "gpt-6.1-sol");
  assert.equal(CODEX_TIERS.flagship.effort, "xhigh");
});

test("CODEX_TIERS exports standard with correct model and effort", () => {
  assert.equal(CODEX_TIERS.standard.model, "gpt-6.1-sol");
  assert.equal(CODEX_TIERS.standard.effort, "medium");
});

test("CODEX_TIERS exports fast with correct model and effort", () => {
  assert.equal(CODEX_TIERS.fast.model, "gpt-6-luna");
  assert.equal(CODEX_TIERS.fast.effort, "low");
});

test("CODEX_TIERS exports astra with correct model and effort", () => {
  assert.equal(CODEX_TIERS.astra.model, "gpt-6-astra");
  assert.equal(CODEX_TIERS.astra.effort, "xhigh");
});

test("code review prompt routes to codex", () => {
  const r = computeRoute("Review this implementation against its task requirements", SAFE_POLICY);
  assert.equal(r.tier, "codex");
});

test("adversarial review prompt routes to codex", () => {
  const r = computeRoute("adversarial review of the design spec", SAFE_POLICY);
  assert.equal(r.tier, "codex");
});

test("spec review prompt routes to codex", () => {
  const r = computeRoute("spec review: identify gaps and contradictions", SAFE_POLICY);
  assert.equal(r.tier, "codex");
});

test("truncate without trailing word does not set irreversible flag", () => {
  // "truncated" should not match after trailing-space fix
  const r = computeRoute("this data was truncated at 100 rows", SAFE_POLICY);
  assert.ok(!r.risk_flags.includes("irreversible"), "truncated should not set irreversible");
});

test("truncate table does set irreversible flag", () => {
  const r = computeRoute("truncate the logs table", SAFE_POLICY);
  assert.ok(r.risk_flags.includes("irreversible"));
});

test("forceTier local and its deprecated alias gemma both resolve to tier local", () => {
  const policy = { pii_sensitive: false, write_allowed: true };
  const a = computeRoute("anything at all", policy, "local");
  assert.equal(a.tier, "local");
  assert.equal(a.reason, "forced_by_caller");
  const b = computeRoute("anything at all", policy, "gemma");
  assert.equal(b.tier, "local");   // alias normalized: output label is always local
});

// ---------------------------------------------------------------------------
// keyword-promotion branch flags "auto_codex_promotion"
// ONLY when it fires with NO forceTier at all (null). An invalid truthy
// forceTier (e.g. "bogus", not in VALID_FORCE_TIERS) falls through to the
// keyword branch but must NOT carry the flag -- it was never absent, it was
// just unusable.
// ---------------------------------------------------------------------------

test("keyword promotion with forceTier=null flags auto_codex_promotion", () => {
  const r = computeRoute("implement the feature", SAFE_POLICY, null);
  assert.equal(r.tier, "codex");
  assert.ok(r.risk_flags.includes("auto_codex_promotion"));
});

test("keyword promotion with forceTier='codex' does NOT flag auto_codex_promotion", () => {
  const r = computeRoute("implement the feature", SAFE_POLICY, "codex");
  assert.equal(r.tier, "codex");
  assert.equal(r.reason, "forced_by_caller");
  assert.ok(!r.risk_flags.includes("auto_codex_promotion"));
});

test("keyword promotion with invalid truthy forceTier='bogus' routes via keywords but does NOT flag auto_codex_promotion", () => {
  const r = computeRoute("implement the feature", SAFE_POLICY, "bogus");
  assert.equal(r.tier, "codex");
  assert.equal(r.reason, "multi_file_or_autonomous_coding");
  assert.ok(!r.risk_flags.includes("auto_codex_promotion"));
});

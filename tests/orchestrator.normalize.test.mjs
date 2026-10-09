import { test, mock, after } from "node:test";
import { installPolicyFixture, BETA } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";
import { CODEX_TIERS } from "../routing.mjs";

// Mock jobs.mjs BEFORE importing orchestrator so orchestrator's static import (and the
// transitive admission.mjs -> direct.mjs import) gets the mock, never a real companion call.
// Pattern copied from tests/orchestrator.test.mjs:18-28, including the extra mocked exports
// tests/server.wait.test.mjs:19-36 shows direct.mjs requires (isPidAlive, buildTreeKillArgs).
const fakeSubmitTask = mock.fn(async () => ({ job_id: "task-abc123", status: "queued" }));

await mock.module("../jobs.mjs", {
  exports: {
    submitTask: fakeSubmitTask,
    // direct.mjs (transitively loaded via admission.mjs) imports these
    isPidAlive: () => false,
    buildTreeKillArgs: (pid) => ["taskkill", "/PID", String(pid), "/T", "/F"]
  }
});

// Unique query string so this file's dynamic import gets its own module instance,
// independent of any other test file that also imports orchestrator.mjs.
const { normalizeDelegateStrength, NORMALIZATION_ERRORS, delegate } = await import("../orchestrator.mjs?norm=1");

const FLAGSHIP = CODEX_TIERS.flagship; // { model: "gpt-6.1-sol", effort: "xhigh" }
const STANDARD = CODEX_TIERS.standard; // { model: "gpt-6.1-sol", effort: "medium" }
const FAST = CODEX_TIERS.fast;         // { model: "gpt-6-luna", effort: "low" }
const fx = installPolicyFixture({ after });
const CWD = fx.dirOf(BETA);

// ---------------------------------------------------------------------------
// Row L: quality="local", tier!=="codex" -> ok; resolved_quality "local";
// model/effort null (raw opts ignored on local path).
// ---------------------------------------------------------------------------

test("rule L: quality=local with no tier resolves ok with null model/effort", () => {
  const n = normalizeDelegateStrength({ quality: "local" });
  assert.equal(n.ok, true);
  assert.equal(n.requested_quality, "local");
  assert.equal(n.resolved_quality, "local");
  assert.equal(n.model, null);
  assert.equal(n.effort, null);
  assert.deepEqual(n.risk_flags, []);
});

test("rule L: quality=local with tier=claude (not codex) still resolves ok, raw opts ignored", () => {
  const n = normalizeDelegateStrength({ quality: "local", tier: "claude", model: "should-be-ignored", effort: "xxbad" });
  assert.equal(n.ok, true);
  assert.equal(n.resolved_quality, "local");
  assert.equal(n.model, null);
  assert.equal(n.effort, null);
});

// ---------------------------------------------------------------------------
// Row 5: quality="local", tier==="codex" -> error local_codex_conflict.
// ---------------------------------------------------------------------------

test("rule 5: quality=local with tier=codex errors local_codex_conflict", () => {
  const n = normalizeDelegateStrength({ quality: "local", tier: "codex" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "local_codex_conflict");
  assert.match(n.error, /local/);
  assert.match(n.error, /codex/);
});

// ---------------------------------------------------------------------------
// Row 1a: quality in CODEX_TIERS, raws absent or EQUAL to row -> ok; row
// model+effort; resolved_quality = literal.
// ---------------------------------------------------------------------------

for (const [name, row] of Object.entries(CODEX_TIERS)) {
  test(`rule 1a: quality=${name} with raws absent resolves the row literal`, () => {
    const n = normalizeDelegateStrength({ quality: name });
    assert.equal(n.ok, true);
    assert.equal(n.requested_quality, name);
    assert.equal(n.resolved_quality, name);
    assert.equal(n.model, row.model);
    assert.equal(n.effort, row.effort);
    assert.deepEqual(n.risk_flags, []);
  });

  test(`rule 1a: quality=${name} with raws EQUAL to the row resolves ok (no conflict)`, () => {
    const n = normalizeDelegateStrength({ quality: name, model: row.model, effort: row.effort });
    assert.equal(n.ok, true);
    assert.equal(n.resolved_quality, name);
    assert.equal(n.model, row.model);
    assert.equal(n.effort, row.effort);
  });
}

// ---------------------------------------------------------------------------
// Row 1b: quality in CODEX_TIERS, present raw model or effort differs from
// row -> error conflicting_override (message names row values + conflict).
// ---------------------------------------------------------------------------

test("rule 1b: flagship + raw effort=medium is a hard error", () => {
  const n = normalizeDelegateStrength({ quality: "flagship", effort: "medium" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "conflicting_override");
  assert.match(n.error, /xhigh/);
  assert.match(n.error, /medium/);
});

test("rule 1b: standard + raw model differing from the row is a hard error", () => {
  const n = normalizeDelegateStrength({ quality: "standard", model: "gpt-5.6-terra" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "conflicting_override");
  assert.match(n.error, new RegExp(STANDARD.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(n.error, /gpt-5\.6-terra/);
});

test("rule 1b: fast + both raw model and effort differing from the row names both offenders", () => {
  const n = normalizeDelegateStrength({ quality: "fast", model: "gpt-6.1-sol", effort: "high" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "conflicting_override");
  assert.match(n.error, /gpt-6-luna/); // row value
  assert.match(n.error, /low/);           // row value
  assert.match(n.error, /gpt-6\.1-sol/);  // offending raw
  assert.match(n.error, /high/);          // offending raw
});

// ---------------------------------------------------------------------------
// Row 2: no quality, BOTH model+effort present -> ok; resolved_quality
// "custom"; the raw pair.
// ---------------------------------------------------------------------------

test("rule 2: no quality with both model and effort present resolves custom", () => {
  const n = normalizeDelegateStrength({ model: "gpt-custom-model", effort: "high" });
  assert.equal(n.ok, true);
  assert.equal(n.requested_quality, null);
  assert.equal(n.resolved_quality, "custom");
  assert.equal(n.model, "gpt-custom-model");
  assert.equal(n.effort, "high");
  assert.deepEqual(n.risk_flags, []);
});

// ---------------------------------------------------------------------------
// Row 3: no quality, exactly one of model/effort present -> error
// partial_override.
// ---------------------------------------------------------------------------

test("rule 3: no quality with only model present errors partial_override", () => {
  const n = normalizeDelegateStrength({ model: "gpt-custom-model" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "partial_override");
  assert.equal(n.error, "pass quality=flagship|standard|fast|fast_review|local|astra, or BOTH model and effort");
});

test("rule 3: no quality with only effort present errors partial_override", () => {
  const n = normalizeDelegateStrength({ effort: "high" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "partial_override");
  assert.equal(n.error, "pass quality=flagship|standard|fast|fast_review|local|astra, or BOTH model and effort");
});

// ---------------------------------------------------------------------------
// Row 4: no quality, no raw pair -> ok; CODEX_TIERS.standard; resolved_quality
// "standard".
// ---------------------------------------------------------------------------

test("rule 4: nothing given resolves standard terra/medium", () => {
  const n = normalizeDelegateStrength({});
  assert.equal(n.ok, true);
  assert.equal(n.requested_quality, null);
  assert.equal(n.resolved_quality, "standard");
  assert.equal(n.model, "gpt-6.1-sol");
  assert.equal(n.effort, "medium");
  assert.deepEqual(n.risk_flags, []);
});

test("rule 4: called with no argument at all resolves standard (default param)", () => {
  const n = normalizeDelegateStrength();
  assert.equal(n.ok, true);
  assert.equal(n.resolved_quality, "standard");
});

// ---------------------------------------------------------------------------
// Row U: unknown quality, no raws -> ok; case-4 values; requested_quality =
// the literal; risk_flags ["unknown_quality"].
// ---------------------------------------------------------------------------

test("rule U: unknown quality with no raws resolves standard values, preserves requested_quality, flags unknown_quality", () => {
  const n = normalizeDelegateStrength({ quality: "ultra-mega" });
  assert.equal(n.ok, true);
  assert.equal(n.requested_quality, "ultra-mega");
  assert.equal(n.resolved_quality, "standard");
  assert.equal(n.model, STANDARD.model);
  assert.equal(n.effort, STANDARD.effort);
  assert.deepEqual(n.risk_flags, ["unknown_quality"]);
});

// ---------------------------------------------------------------------------
// Row U+: unknown quality, any present raw -> error conflicting_override
// (OQ2 ruling).
// ---------------------------------------------------------------------------

test("rule U+: unknown quality with a raw model present errors conflicting_override", () => {
  const n = normalizeDelegateStrength({ quality: "ultra-mega", model: "gpt-6.1-sol" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "conflicting_override");
  assert.match(n.error, /ultra-mega/);
});

test("rule U+: unknown quality with both raws present errors conflicting_override", () => {
  const n = normalizeDelegateStrength({ quality: "ultra-mega", model: "gpt-6.1-sol", effort: "medium" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "conflicting_override");
  assert.match(n.error, /ultra-mega/);
});

// ---------------------------------------------------------------------------
// Row V: present raw effort not in the allowed set -> error invalid_override,
// in every quality state where raws are honored/checked (i.e. every state
// except quality="local", which ignores raws entirely -- rule L above proves
// that case already).
// ---------------------------------------------------------------------------

test("rule V: no quality, invalid raw effort with a matching model errors invalid_override", () => {
  const n = normalizeDelegateStrength({ effort: "xxhigh", model: "gpt-6.1-sol" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "invalid_override");
  assert.match(n.error, /xxhigh/);
});

test("rule V: no quality, invalid raw effort alone (no model) errors invalid_override, not partial_override", () => {
  const n = normalizeDelegateStrength({ effort: "xxhigh" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "invalid_override");
  assert.match(n.error, /xxhigh/);
});

test("rule V: quality in CODEX_TIERS with invalid raw effort errors invalid_override, not conflicting_override", () => {
  const n = normalizeDelegateStrength({ quality: "flagship", effort: "xxhigh" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "invalid_override");
  assert.match(n.error, /xxhigh/);
});

test("rule V: unknown quality with invalid raw effort errors invalid_override, not conflicting_override", () => {
  const n = normalizeDelegateStrength({ quality: "ultra-mega", effort: "xxhigh" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "invalid_override");
  assert.match(n.error, /xxhigh/);
});

// ---------------------------------------------------------------------------
// Extra cases
// ---------------------------------------------------------------------------

test("blank strings are absent, not present (blank pair resolves case 4 standard)", () => {
  const n = normalizeDelegateStrength({ model: "", effort: "  " });
  assert.equal(n.ok, true);
  assert.equal(n.resolved_quality, "standard");
  assert.equal(n.model, "gpt-6.1-sol");
  assert.equal(n.effort, "medium");
});

test("blank model + real effort is exactly-one-present -> partial_override", () => {
  const n = normalizeDelegateStrength({ model: "   ", effort: "high" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "partial_override");
});

test("blank quality is absent -- both raws present still resolves custom, not unknown_quality", () => {
  const n = normalizeDelegateStrength({ quality: "  ", model: "gpt-custom-model", effort: "high" });
  assert.equal(n.ok, true);
  assert.equal(n.requested_quality, null);
  assert.equal(n.resolved_quality, "custom");
  assert.deepEqual(n.risk_flags, []);
});

test("tier is trimmed before the codex comparison (padded 'codex' still conflicts)", () => {
  const n = normalizeDelegateStrength({ quality: "local", tier: "  codex  " });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "local_codex_conflict");
});

test("{effort:'xxhigh', model:'gpt-6.1-sol'} -> invalid_override", () => {
  const n = normalizeDelegateStrength({ effort: "xxhigh", model: "gpt-6.1-sol" });
  assert.equal(n.ok, false);
  assert.equal(n.reason, "invalid_override");
});

test("NORMALIZATION_ERRORS contains exactly the four documented reasons", () => {
  assert.equal(NORMALIZATION_ERRORS.size, 4);
  assert.ok(NORMALIZATION_ERRORS.has("conflicting_override"));
  assert.ok(NORMALIZATION_ERRORS.has("partial_override"));
  assert.ok(NORMALIZATION_ERRORS.has("local_codex_conflict"));
  assert.ok(NORMALIZATION_ERRORS.has("invalid_override"));
});

test("every ok:false result's reason is a member of NORMALIZATION_ERRORS", () => {
  const cases = [
    { quality: "local", tier: "codex" },
    { quality: "flagship", effort: "medium" },
    { effort: "high" },
    { effort: "xxhigh" }
  ];
  for (const opts of cases) {
    const n = normalizeDelegateStrength(opts);
    assert.equal(n.ok, false);
    assert.ok(NORMALIZATION_ERRORS.has(n.reason), `reason "${n.reason}" should be in NORMALIZATION_ERRORS`);
  }
});

test("returned object and risk_flags are fresh per call -- mutating a result never affects CODEX_TIERS", () => {
  const n1 = normalizeDelegateStrength({ quality: "standard" });
  n1.model = "mutated-model";
  n1.effort = "mutated-effort";
  n1.risk_flags.push("mutated_flag");
  assert.equal(CODEX_TIERS.standard.model, "gpt-6.1-sol");
  assert.equal(CODEX_TIERS.standard.effort, "medium");

  const n2 = normalizeDelegateStrength({ quality: "ultra-mega" });
  assert.deepEqual(n2.risk_flags, ["unknown_quality"], "a prior call's mutated risk_flags must not leak into a new call");
});

test("normalizeDelegateStrength does not mutate its input options object", () => {
  const opts = { quality: "flagship", model: "  ", effort: "  " };
  const before = JSON.stringify(opts);
  normalizeDelegateStrength(opts);
  assert.equal(JSON.stringify(opts), before);
});

// ---------------------------------------------------------------------------
// delegate()-level cases (a)-(e) -- normalizeDelegateStrength
// consumed inside delegate() itself, ahead of admit()/routing/submission.
// ---------------------------------------------------------------------------

test("(a) HEADLINE: omitted-everything codex task -> submitTask receives terra/medium", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the new feature", { cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "medium");
  assert.equal(r.requested_quality, null);
  assert.equal(r.resolved_quality, "standard");
  assert.equal(r.model, "gpt-6.1-sol");
  assert.equal(r.effort, "medium");
});

test("(b) conflicting override -> failure envelope, submitTask NOT called", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { quality: "flagship", effort: "medium", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.reason, "conflicting_override");
  assert.deepEqual(r.risk_flags, []);
  assert.equal(r.write_blocked, false);
  assert.equal(r.requested_quality, "flagship");
  assert.ok(r.result.error);
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "submitTask must not be called on a normalization failure");
});

test("(c) quality=local + tier=codex -> local_codex_conflict failure envelope", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("do a thing", { quality: "local", tier: "codex", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.reason, "local_codex_conflict");
  assert.equal(r.write_blocked, false);
  assert.equal(r.requested_quality, "local");
  assert.ok(r.result.error);
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "submitTask must not be called on a normalization failure");
});

test("(d) envelope fields per route; requested_quality survives JSON serialization as null", async () => {
  fakeSubmitTask.mock.resetCalls();
  const claudeResult = await delegate("plan the migration strategy", { tier: "claude", cwd: CWD });
  const claudeSerialized = JSON.parse(JSON.stringify(claudeResult));
  assert.equal(claudeSerialized.requested_quality, null);
  assert.equal("resolved_quality" in claudeSerialized, false, "resolved_quality only on an executed codex route");
  assert.equal("model" in claudeSerialized, false, "model only on an executed codex route");
  assert.equal("effort" in claudeSerialized, false, "effort only on an executed codex route");

  fakeSubmitTask.mock.resetCalls();
  const codexResult = await delegate("implement the feature", { tier: "codex", cwd: CWD });
  const codexSerialized = JSON.parse(JSON.stringify(codexResult));
  assert.equal(codexSerialized.requested_quality, null);
  assert.equal(codexSerialized.resolved_quality, "standard");
  assert.equal(codexSerialized.model, "gpt-6.1-sol");
  assert.equal(codexSerialized.effort, "medium");
});

// ---------------------------------------------------------------------------
// delegate()-level auto_codex_promotion assertions.
// forceTier = opts.tier ?? qualityForcedTier(norm.requested_quality); with no
// tier and no quality supplied, forceTier is null, so the keyword-promotion
// branch in routing.mjs fires with no forceTier and the envelope must carry
// the flag. A caller-supplied tier="codex" forces the tier earlier (reason
// "forced_by_caller") and must not carry the flag.
// ---------------------------------------------------------------------------

test("(d) codex-keyword task, no tier/quality -> envelope risk_flags includes auto_codex_promotion", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.ok(r.risk_flags.includes("auto_codex_promotion"));
});

test("(e) codex-keyword task with tier='codex' -> envelope risk_flags does NOT include auto_codex_promotion", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { tier: "codex", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.ok(!r.risk_flags.includes("auto_codex_promotion"));
});

test("(e) effort='max' rejection wins over normalization (order pin)", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { quality: "flagship", effort: "max", tier: "codex", cwd: CWD });
  assert.equal(r.reason, "max_reviews_only");
  assert.match(r.result.error, /codex_gate|codex_review_panel/);
  assert.equal(fakeSubmitTask.mock.calls.length, 0);
  // requested_quality is provenance on EVERY route, error envelopes
  // included -- the literal quality survives even though normalization never ran.
  assert.equal(JSON.parse(JSON.stringify(r)).requested_quality, "flagship");
});

test("quality=fast_review resolves to gpt-6-luna/high; fast stays luna/low; a raw effort that differs from the row is rejected", () => {
  const r = normalizeDelegateStrength({ quality: "fast_review" });
  assert.equal(r.ok, true);
  assert.equal(r.model, "gpt-6-luna");
  assert.equal(r.effort, "high");
  assert.equal(r.resolved_quality, "fast_review");
  const f = normalizeDelegateStrength({ quality: "fast" });
  assert.equal(f.effort, "low");
  const bad = normalizeDelegateStrength({ quality: "fast", effort: "high" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "conflicting_override");
});
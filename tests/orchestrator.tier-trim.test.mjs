import { test, mock, after } from "node:test";
import { installPolicyFixture, BETA } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";

// Raw opts.tier was never hygiene-trimmed before the
// forceTier line in delegate() (orchestrator.mjs:214). A padded tier (" local ", " codex ",
// " gemma ") or a blank tier ("   ") was truthy-raw, so VALID_FORCE_TIERS (routing.mjs) never
// recognized it -- the forced-tier branch silently fell through and task keywords decided the
// tier instead, while a codex-keyword task could still submit with the quality-normalized
// (possibly null) model/effort. Fix: trim tier ONCE at delegate() entry (presentValue hygiene,
// same as normalizeDelegateStrength uses internally) and feed the TRIMMED tier to both
// normalization and the forceTier line. qualityForcedTier() and routing.mjs are untouched.

const fakeSubmitTask = mock.fn(async () => ({ job_id: "task-trim-1", status: "queued" }));
globalThis.fetch = mock.fn(async () => ({ ok: true, json: async () => ({ response: "local result" }) }));

await mock.module("../jobs.mjs", {
  exports: {
    submitTask: fakeSubmitTask,
    // direct.mjs (transitively loaded via admission.mjs) imports these
    isPidAlive: () => false,
    buildTreeKillArgs: (pid) => ["taskkill", "/PID", String(pid), "/T", "/F"]
  }
});

// Unique query string so this file's dynamic import gets its own module instance.
const { delegate } = await import("../orchestrator.mjs?tiertrim=1");
const fx = installPolicyFixture({ after });
const CWD = fx.dirOf(BETA);

test("padded tier=' local ' + quality=local: selected_tier local, submitTask NEVER called", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("handle this generic task", { tier: " local ", quality: "local", cwd: CWD });
  assert.equal(r.selected_tier, "local");
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "a trimmed-local forced tier must never reach submitTask");
});

test("padded tier=' codex ' + neutral task: forced_by_caller codex, standard terra/medium, NO auto_codex_promotion", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("handle this generic task", { tier: " codex ", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.reason, "forced_by_caller");
  assert.ok(!r.risk_flags.includes("auto_codex_promotion"), "a caller-forced tier is not the keyword promotion path");
  assert.equal(fakeSubmitTask.mock.calls.length, 1);
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "medium");
});

test("padded tier=' gemma ' still honors the deprecated local alias after trim", async () => {
  const r = await delegate("handle this generic task", { tier: " gemma ", cwd: CWD });
  assert.equal(r.selected_tier, "local");
});

test("blank tier='   ' + codex-keyword task + no quality: codex via keywords WITH auto_codex_promotion (blank = no caller tier)", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { tier: "   ", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.reason, "multi_file_or_autonomous_coding");
  assert.ok(r.risk_flags.includes("auto_codex_promotion"), "blank tier must be treated as absent, same as no tier at all");
});

test("padded tier=' bogus ' + codex-keyword task: codex via keywords, auto_codex_promotion ABSENT (still caller-supplied, just trimmed)", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { tier: " bogus ", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.reason, "multi_file_or_autonomous_coding");
  assert.ok(!r.risk_flags.includes("auto_codex_promotion"), "a present invalid tier is the same bucket as unpadded 'bogus'");
});

import { test, mock, after } from "node:test";
import { installPolicyFixture, BETA } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";

// Capture Ollama payloads; switchable failure modes for the fallback tests.
let fetchMode = "ok";
let lastFetch = null;
globalThis.fetch = mock.fn(async (url, init) => {
  lastFetch = { url, init, body: JSON.parse(init.body) };
  if (fetchMode === "refused") throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:11434");
  if (fetchMode === "http500") return { ok: false, status: 500, text: async () => "boom" };
  return { ok: true, json: async () => ({ response: "local result" }) };
});

const fakeSubmitTask = mock.fn(async () => ({ job_id: "task-local-1", status: "queued" }));
await mock.module("../jobs.mjs", {
  exports: {
    submitTask: fakeSubmitTask,
    isPidAlive: () => false,
    buildTreeKillArgs: (pid) => ["taskkill", "/PID", String(pid), "/T", "/F"]
  }
});

const { delegate } = await import("../orchestrator.mjs");
const fx = installPolicyFixture({ after });
const CWD = fx.dirOf(BETA);

test("quality=local with no tier forces the local tier, inline result", async () => {
  fetchMode = "ok";
  const r = await delegate("sanity-check this paragraph for contradictions", { quality: "local", cwd: CWD });
  assert.equal(r.selected_tier, "local");
  assert.equal(r.result.response, "local result");
});

// The per-route envelope test in orchestrator.normalize.test.mjs
// covers only claude+codex routes. Local-success and Ollama-fallback-to-claude each retain
// requested_quality and OMIT resolved_quality/model/effort (those three are codex-route-only).
test("local-success route retains requested_quality, omits resolved_quality/model/effort", async () => {
  fetchMode = "ok";
  const r = await delegate("sanity-check this paragraph for contradictions", { quality: "local", cwd: CWD });
  const serialized = JSON.parse(JSON.stringify(r));
  assert.equal(serialized.selected_tier, "local");
  assert.equal(serialized.requested_quality, "local");
  assert.equal("resolved_quality" in serialized, false, "resolved_quality only on an executed codex route");
  assert.equal("model" in serialized, false, "model only on an executed codex route");
  assert.equal("effort" in serialized, false, "effort only on an executed codex route");
});

test("local tier default model is qwen2.5:7b with hardened payload", async () => {
  fetchMode = "ok";
  delete process.env.CODEX_MCP_LOCAL_MODEL;
  delete process.env.CODEX_MCP_LOCAL_THINK;
  await delegate("summarize this", { tier: "gemma", cwd: CWD });
  assert.equal(lastFetch.body.model, "qwen2.5:7b");
  assert.equal(lastFetch.body.truncate, false, "top-level truncate:false must be present");
  assert.equal(lastFetch.body.options.num_ctx, 32768, "explicit num_ctx must be present");
  assert.ok(lastFetch.body.options.num_predict > 0, "num_predict cap must be present");
  assert.equal(lastFetch.body.think, false, "think defaults to false");
  assert.ok(lastFetch.init.signal, "fetch must carry an abort signal (timeout)");
});

test("CODEX_MCP_LOCAL_MODEL env overrides the local model (rollback path)", async () => {
  fetchMode = "ok";
  process.env.CODEX_MCP_LOCAL_MODEL = "gemma4:12b-it-qat";
  try {
    await delegate("summarize this", { tier: "gemma", cwd: CWD });
    assert.equal(lastFetch.body.model, "gemma4:12b-it-qat");
  } finally {
    delete process.env.CODEX_MCP_LOCAL_MODEL;
  }
});

test("CODEX_MCP_LOCAL_THINK=omit drops the think key entirely", async () => {
  fetchMode = "ok";
  process.env.CODEX_MCP_LOCAL_THINK = "omit";
  try {
    await delegate("summarize this", { tier: "gemma", cwd: CWD });
    assert.ok(!("think" in lastFetch.body), "think key must be absent when env=omit");
  } finally {
    delete process.env.CODEX_MCP_LOCAL_THINK;
  }
});

test("Ollama connection-refused falls back to claude tier, TAGGED", async () => {
  fetchMode = "refused";
  const r = await delegate("summarize this", { tier: "gemma", cwd: CWD });
  assert.equal(r.selected_tier, "claude", "selected_tier stays honest about who does the work");
  assert.equal(r.reason, "ollama_unavailable_fallback");
  assert.ok(r.risk_flags.includes("ollama_unavailable"), "outage must be flagged, never silent");
  assert.equal(r.result.message, "Handle inline in Claude");
  assert.equal(r.result.fallback_from, "local");
  assert.ok(r.result.error.includes("ECONNREFUSED"));
});

test("Ollama HTTP 5xx falls back to claude tier, TAGGED", async () => {
  fetchMode = "http500";
  const r = await delegate("summarize this", { tier: "gemma", cwd: CWD });
  assert.equal(r.selected_tier, "claude");
  assert.equal(r.reason, "ollama_unavailable_fallback");
  assert.ok(r.result.error.includes("500"));
});

// Likewise, the Ollama-fallback-to-claude route.
test("Ollama-fallback-to-claude route retains requested_quality, omits resolved_quality/model/effort", async () => {
  fetchMode = "refused";
  const r = await delegate("summarize this", { tier: "gemma", cwd: CWD });
  assert.equal(r.selected_tier, "claude");
  assert.equal(r.reason, "ollama_unavailable_fallback");
  const serialized = JSON.parse(JSON.stringify(r));
  assert.equal(serialized.requested_quality, null, "no quality was passed -- present as a literal null");
  assert.equal("resolved_quality" in serialized, false, "resolved_quality only on an executed codex route");
  assert.equal("model" in serialized, false, "model only on an executed codex route");
  assert.equal("effort" in serialized, false, "effort only on an executed codex route");
});

// BACKWARD-COMPAT REGRESSIONS: prose-specified callers (skill documents,
// delegate()-based review hooks) pass quality WITHOUT tier and depend on quality
// forcing codex. A naive quality->tier change would silently downgrade an audit's
// independent Codex cross-check to inline-Claude. These pin the contract.
for (const quality of ["flagship", "standard", "fast", "astra"]) {
  test(`REGRESSION: quality=${quality} with NO tier still forces codex`, async () => {
    fetchMode = "ok";
    fakeSubmitTask.mock.resetCalls();
    const r = await delegate("cross-check the implementation against requirements", { quality, cwd: CWD });
    assert.equal(r.selected_tier, "codex");
    assert.equal(fakeSubmitTask.mock.calls.length, 1, "must reach submitTask, not Ollama/inline");
  });
}

test("REGRESSION: unknown quality still forces codex (legacy behavior preserved)", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("do a thing", { quality: "ultra-mega", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol", "unknown quality now resolves to the standard model");
});

test("explicit tier always wins over quality", async () => {
  fetchMode = "ok";
  const r = await delegate("summarize this", { tier: "gemma", quality: "flagship", cwd: CWD });
  assert.equal(r.selected_tier, "local", "tier=gemma (alias of local) must not be overridden by quality");
});

// The hygiene seam between normalization and tier forcing.
// delegate() must feed qualityForcedTier() the NORMALIZED (trimmed) quality, not the raw
// opts.quality -- a padded "quality: ' local '" normalizes as local (model/effort null),
// but the RAW string is not in LOCAL_QUALITIES, so an unfixed qualityForcedTier(opts.quality)
// would treat it as an unknown value and force codex, reaching submitTask with a null
// model/effort (reopening the config-toml fallback normalization is supposed to close).
test("padded quality=' local ' still forces the local tier, submitTask never called", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("summarize this", { quality: " local ", cwd: CWD });
  assert.equal(r.selected_tier, "local");
  assert.equal(r.result.response, "local result");
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "a padded local quality must never reach submitTask/codex");
});

test("padded quality=' flagship ' still forces codex with the correct model/effort", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("do a thing", { quality: " flagship ", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "xhigh");
});

test("blank quality stays absent for tier forcing too -- routes via task-text pattern to standard terra/medium", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { quality: "   ", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.notEqual(r.reason, "forced_by_caller", "blank quality must not force a tier");
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "medium");
});

test("padded quality=' local ' + tier=codex still trips local_codex_conflict (trim applies before rule 5)", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("do a thing", { quality: " local ", tier: "codex", cwd: CWD });
  assert.equal(r.reason, "local_codex_conflict");
  assert.equal(fakeSubmitTask.mock.calls.length, 0);
});

// quality="local" resolves ok at
// normalization (row L: resolved_quality "local", model/effort null) whenever the raw tier
// is anything OTHER than exactly "codex". An invalid truthy tier ("bogus") or a programmatic
// "auto" (the CLI/MCP adapters map "auto" to null, but delegate() itself must not rely on
// that) both fail VALID_FORCE_TIERS (routing.mjs) and fall through to keyword promotion --
// a codex-shaped task then lands on the codex branch with norm.model/norm.effort still null,
// which used to submit a null-strength job (reopening the config-toml fallback) AND return a
// dishonest envelope (selected_tier:"codex", resolved_quality:"local"). delegate() must guard
// the null-strength INVARIANT before submitTask, not just the explicit tier="codex" symptom.
test("quality=local + invalid tier='bogus' on a codex-keyword task errors local_codex_conflict, submitTask NEVER called", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { quality: "local", tier: "bogus", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.reason, "local_codex_conflict");
  assert.deepEqual(r.risk_flags, []);
  assert.equal(r.write_blocked, false);
  assert.equal(r.requested_quality, "local");
  assert.ok(r.result.error, "must carry an error message, never a job_id");
  assert.equal(r.result.job_id, undefined);
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "the codex branch must never submit with a null model/effort");
});

test("quality=local + programmatic tier='auto' on a codex-keyword task errors local_codex_conflict, submitTask NEVER called", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { quality: "local", tier: "auto", cwd: CWD });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.reason, "local_codex_conflict");
  assert.deepEqual(r.risk_flags, []);
  assert.equal(r.write_blocked, false);
  assert.equal(r.requested_quality, "local");
  assert.ok(r.result.error);
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "delegate() must not rely on an adapter having pre-mapped 'auto' to null");
});

test("regression check: quality=local + tier=local (valid, explicit) still routes local, Ollama path", async () => {
  fetchMode = "ok";
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", { quality: "local", tier: "local", cwd: CWD });
  assert.equal(r.selected_tier, "local");
  assert.equal(r.result.response, "local result");
  assert.equal(fakeSubmitTask.mock.calls.length, 0);
});

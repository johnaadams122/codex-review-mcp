import { test, mock, after } from "node:test";
import { installPolicyFixture, BETA, DELTA, EPSILON } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";

const fx = installPolicyFixture({ after });

// Secret-shaped test values are assembled at run time so no key-shaped literal
// sits in the source; the redactor still sees the full shape.
const FAKE_SK = ["sk", "abc12345678901234567890"].join("-");
const FAKE_API_KEY_ASSIGNMENT = ["api_key", FAKE_SK].join("=");
const FAKE_TOKEN_VALUE = "abcdef0123456789xyz";
const FAKE_TOKEN_ASSIGNMENT = ["token", FAKE_TOKEN_VALUE].join("=");

// Patch jobs.mjs to avoid real companion calls
const fakeSubmitTask = mock.fn(async () => ({ job_id: "task-abc123", status: "queued" }));

// Patch fetch to avoid real Ollama calls
globalThis.fetch = mock.fn(async (url, init) => ({
  ok: true,
  json: async () => ({ response: "gemma summary result" })
}));

// Mock jobs.mjs BEFORE importing orchestrator so orchestrator's static import gets the mock.
// Note: ESM namespace objects are non-writable (strict-mode spec), so the CJS-style
// `jobs.submitTask = fn` pattern cannot be used with .mjs files. mock.module() is the
// correct Node.js v22+ mechanism -- it replaces the module in the ESM cache so that
// orchestrator.mjs (loaded via dynamic import below) receives the mocked submitTask.
await mock.module("../jobs.mjs", {
  exports: {
    submitTask: fakeSubmitTask,
    // direct.mjs (transitively loaded via admission.mjs) imports these
    isPidAlive: () => false,
    buildTreeKillArgs: (pid) => ["taskkill", "/PID", String(pid), "/T", "/F"]
  }
});

// Import after patching (dynamic to allow mock setup before load)
const { delegate } = await import("../orchestrator.mjs");

test("delegate with tier=gemma (deprecated alias of local) calls Ollama, reports selected_tier local", async () => {
  const r = await delegate("summarize this log", { tier: "gemma" });
  assert.equal(r.selected_tier, "local");
  assert.equal(r.result.response, "gemma summary result");
  assert.equal(r.write_blocked, false);
});

test("delegate with codex tier submits task and returns job_id", async () => {
  const r = await delegate("implement the new feature", {
    tier: "codex",
    cwd: fx.dirOf(BETA)
  });
  assert.equal(r.selected_tier, "codex");
  assert.equal(r.result.job_id, "task-abc123");
  assert.equal(r.result.status, "queued");
});

test("delegate with claude tier returns message without calling companion", async () => {
  const r = await delegate("plan the migration strategy", { tier: "claude" });
  assert.equal(r.selected_tier, "claude");
  assert.equal(r.result.message, "Handle inline in Claude");
});

test("delegate with write=true in a pii project that allows write: write allowed", async () => {
  const r = await delegate("summarize", {
    tier: "gemma",
    write: true,
    cwd: fx.dirOf(DELTA)
  });
  assert.equal(r.write_blocked, false);
});

test("delegate with write=true in a pii project that blocks write still sets write_blocked=true", async () => {
  const r = await delegate("summarize", {
    tier: "gemma",
    write: true,
    cwd: fx.dirOf(EPSILON)
  });
  assert.equal(r.write_blocked, true);
});

test("delegate passes context_snapshot prepended to prompt for codex", async () => {
  fakeSubmitTask.mock.resetCalls();
  await delegate("fix the bug", {
    tier: "codex",
    context_snapshot: "<project>Sample Project</project>",
    cwd: fx.dirOf(BETA)
  });
  const calledPrompt = fakeSubmitTask.mock.calls[0].arguments[0];
  assert.ok(calledPrompt.includes("<project>Sample Project</project>"));
  assert.ok(calledPrompt.includes("fix the bug"));
});

test("quality=flagship sets model and effort on submitTask call", async () => {
  fakeSubmitTask.mock.resetCalls();
  await delegate("implement the feature", {
    tier: "codex",
    quality: "flagship",
    cwd: fx.dirOf(BETA)
  });
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "xhigh");
});

test("quality=standard sets model and effort on submitTask call", async () => {
  fakeSubmitTask.mock.resetCalls();
  await delegate("implement the feature", {
    tier: "codex",
    quality: "standard",
    cwd: fx.dirOf(BETA)
  });
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "medium");
});

test("model conflicting with quality is a hard normalization failure: conflicting_override, submitTask never called", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", {
    tier: "codex",
    quality: "flagship",
    model: "gpt-6-luna",
    cwd: fx.dirOf(BETA)
  });
  assert.equal(r.reason, "conflicting_override");
  assert.equal(fakeSubmitTask.mock.calls.length, 0, "a normalization failure must never reach submitTask");
  assert.ok(r.result.error);
});

test("unknown quality resolves to the standard model+effort, flagged unknown_quality", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("implement the feature", {
    tier: "codex",
    quality: "ultra-mega",
    cwd: fx.dirOf(BETA)
  });
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "medium");
  assert.ok(r.risk_flags.includes("unknown_quality"));
});

test("quality without explicit tier auto-routes to codex", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate("review the implementation", {
    quality: "flagship",
    cwd: fx.dirOf(BETA)
  });
  // quality=flagship should auto-force tier=codex even without explicit tier
  assert.equal(r.selected_tier, "codex");
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.effort, "xhigh");
});

test("delegate does not mutate caller opts object", async () => {
  const callerOpts = {
    tier: "codex",
    quality: "flagship",
    cwd: fx.dirOf(BETA)
  };
  const originalKeys = Object.keys(callerOpts).sort().join(",");
  await delegate("implement the feature", callerOpts);
  const afterKeys = Object.keys(callerOpts).sort().join(",");
  assert.equal(afterKeys, originalKeys, "delegate should not add keys to caller opts");
  assert.equal(callerOpts.model, undefined, "delegate should not set model on caller opts");
  assert.equal(callerOpts.effort, undefined, "delegate should not set effort on caller opts");
});

test("context_snapshot with secret-like value is redacted before forwarding", async () => {
  fakeSubmitTask.mock.resetCalls();
  await delegate("fix the bug", {
    tier: "codex",
    context_snapshot: FAKE_API_KEY_ASSIGNMENT,
    cwd: fx.dirOf(BETA)
  });
  const calledPrompt = fakeSubmitTask.mock.calls[0].arguments[0];
  assert.ok(!calledPrompt.includes(FAKE_SK), "raw sk- key should be redacted");
  assert.ok(calledPrompt.includes("[REDACTED"), "redaction marker should be present");
});

test("task text with a secret is redacted before forwarding to codex", async () => {
  fakeSubmitTask.mock.resetCalls();
  await delegate(`investigate why ${FAKE_API_KEY_ASSIGNMENT} stopped working`, {
    tier: "codex",
    cwd: fx.dirOf(BETA)
  });
  const calledPrompt = fakeSubmitTask.mock.calls[0].arguments[0];
  assert.ok(!calledPrompt.includes(FAKE_SK), "raw key must not leave the gate");
  assert.ok(calledPrompt.includes("[REDACTED"), "redaction marker present");
});

test("PII cwd read-only delegate reaches codex with a redacted prompt", async () => {
  fakeSubmitTask.mock.resetCalls();
  const r = await delegate(`audit the loader for a ${FAKE_TOKEN_ASSIGNMENT} leak`, {
    tier: "codex",
    cwd: fx.dirOf(DELTA)
  });
  assert.equal(r.selected_tier, "codex", "read-only PII delegation stays allowed");
  assert.equal(r.write_blocked, false);
  const calledPrompt = fakeSubmitTask.mock.calls[0].arguments[0];
  assert.ok(!calledPrompt.includes(FAKE_TOKEN_VALUE), "PII-cwd prompt must be redacted");
});

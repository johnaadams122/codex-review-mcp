// Confidentiality: the job-control READ side must not leak persisted prompts or
// results across cwd stores. job-guard.mjs is the read-boundary owner gate +
// prompt-redaction layer. These are the pure-unit tests; jobs.ownership.test.mjs
// exercises the wiring into the endpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workspaceStoreDir,
  isOwned,
  isCwdOwned,
  deriveNeutralSummary,
  sanitizeJobRecord,
  crossStoreError,
} from "../job-guard.mjs";

// ---- store-dir identity (mirrors the companion's lib/state.mjs resolveStateDir) ----

test("workspaceStoreDir is deterministic and slug-hash shaped", () => {
  const a = workspaceStoreDir("C:/proj/codex-mcp");
  const b = workspaceStoreDir("C:/proj/codex-mcp");
  assert.equal(a, b);
  assert.match(a, /^codex-mcp-[0-9a-f]{16}$/);
});

test("workspaceStoreDir differs for different workspace roots", () => {
  assert.notEqual(workspaceStoreDir("C:/proj/a"), workspaceStoreDir("C:/proj/b"));
});

// ---- ownership decision ----

const SELF_STORE = "self-" + "0".repeat(16);
const SELF = { selfWorkspaceRoot: "C:/proj/self", selfStoreDir: SELF_STORE };

test("isOwned: same workspaceRoot path is owned even when the store hash drifted", () => {
  assert.equal(isOwned({ workspaceRoot: "C:/proj/self", storeDir: "drifted-hash" }, SELF), true);
});

test("isOwned: a matching store dir is owned (legacy record without workspaceRoot)", () => {
  assert.equal(isOwned({ workspaceRoot: null, storeDir: SELF_STORE }, SELF), true);
});

test("isOwned: a foreign workspaceRoot AND foreign store dir is NOT owned", () => {
  assert.equal(isOwned({ workspaceRoot: "C:/proj/foreign", storeDir: "foreign-hash" }, SELF), false);
});

test("isOwned: an unresolvable owner (no workspaceRoot, no store dir) fails closed", () => {
  assert.equal(isOwned({ workspaceRoot: null, storeDir: null }, SELF), false);
});

test("isCwdOwned: a null/empty cwd resolves to the PROCESS launch dir and is owned only when that matches self", () => {
  // An omitted cwd makes the companion use
  // process.cwd() -- when CODEX_MCP_OWNER_CWD overrides the owner elsewhere, a
  // null cwd must NOT be trivially owned.
  const selfLaunch = { ...SELF, processCwd: "C:/proj/self" };
  assert.equal(isCwdOwned(null, selfLaunch), true);
  assert.equal(isCwdOwned("", selfLaunch), true);
  assert.equal(isCwdOwned(undefined, selfLaunch), true);
  const foreignLaunch = { ...SELF, processCwd: "C:/proj/launchdir" };
  assert.equal(isCwdOwned(null, foreignLaunch), false);
  assert.equal(isCwdOwned("", foreignLaunch), false);
  assert.equal(isCwdOwned(undefined, foreignLaunch), false);
});

test("isCwdOwned: an explicit cwd resolving to self is owned; a foreign cwd is not", () => {
  assert.equal(isCwdOwned("C:/proj/self", SELF), true);
  assert.equal(isCwdOwned("C:/proj/foreign", SELF), false);
});

// ---- neutral summary derivation (requirement 2) ----

test("deriveNeutralSummary: a PII cwd yields NO prompt text at all", () => {
  const rec = { kind: "task", jobClass: "task", summary: "compute net worth SSN 123-45-6789 balance 40000" };
  const s = deriveNeutralSummary(rec, "C:/x", { resolvePolicy: () => ({ name: "project_alpha", pii_sensitive: true }) });
  assert.ok(!/123-45-6789/.test(s));
  assert.ok(!/40000/.test(s));
  assert.ok(!/net worth/.test(s));
  assert.match(s, /project_alpha/);
  assert.match(s, /redact/i);
});

test("deriveNeutralSummary: a non-PII cwd emits kind + repo + a truncated first line only", () => {
  const rec = { kindLabel: "rescue", summary: "fix the parser bug\nsecond line detail" };
  const s = deriveNeutralSummary(rec, "C:/x", { resolvePolicy: () => ({ name: "project_beta", pii_sensitive: false }) });
  assert.match(s, /rescue/);
  assert.match(s, /project_beta/);
  assert.match(s, /fix the parser bug/);
  assert.ok(!s.includes("second line detail"));
});

test("deriveNeutralSummary: non-PII first line still runs the secret-redaction pass", () => {
  // Built at run time so no key-shaped literal sits in the source.
  const fakeKey = ["sk", "ABCDEFGHIJKLMNOPQRSTUV"].join("-");
  const rec = { kind: "task", summary: `auth with ${fakeKey} token` };
  const s = deriveNeutralSummary(rec, "C:/x", { resolvePolicy: () => ({ name: "project_gamma", pii_sensitive: false }) });
  assert.ok(!s.includes(fakeKey));
});

// ---- record sanitization ----

test("sanitizeJobRecord strips request.prompt, neutralizes summary+title, keeps the answer", () => {
  const rec = {
    id: "task-1", kind: "task", jobClass: "task", status: "completed",
    title: "balance report for account 40000",
    summary: "compute net worth balance 40000",
    request: { cwd: "C:/x", model: "m", prompt: "compute net worth balance 40000" },
    result: { rawOutput: "the answer" }, rendered: "# answer", workspaceRoot: "C:/x",
  };
  const clean = sanitizeJobRecord(rec, "C:/x", { resolvePolicy: () => ({ name: "project_alpha", pii_sensitive: true }) });
  const blob = JSON.stringify({ summary: clean.summary, title: clean.title });
  assert.ok(!blob.includes("40000"));
  assert.equal(clean.request.prompt, undefined);
  assert.equal(clean.request.cwd, "C:/x");            // non-prompt request fields preserved
  assert.deepEqual(clean.result, { rawOutput: "the answer" });   // answer preserved
  assert.equal(clean.rendered, "# answer");
  assert.equal(clean.status, "completed");
  assert.equal(clean.id, "task-1");
});

test("sanitizeJobRecord does not mutate its input", () => {
  const rec = { summary: "secret prompt", request: { prompt: "secret prompt" } };
  const clean = sanitizeJobRecord(rec, null, { resolvePolicy: () => ({ name: "x", pii_sensitive: false }) });
  assert.equal(rec.request.prompt, "secret prompt");   // original untouched
  assert.notEqual(clean.summary, "secret prompt");
});

test("crossStoreError carries a cross_store code and a clear, path-free message", () => {
  const e = crossStoreError("status", "job-9");
  assert.equal(e.code, "cross_store");
  assert.match(e.message, /cross_store|not owned|refus/i);
});

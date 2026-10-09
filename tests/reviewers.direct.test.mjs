import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { directCodexProvider, codexProvider, ROLES } from "../reviewers.mjs";

test("directCodexProvider: backbone role, distinct name, finalize hook present; codexProvider has none", () => {
  assert.equal(directCodexProvider.role, ROLES.BACKBONE);
  assert.equal(directCodexProvider.name, "codex-direct");
  assert.equal(typeof directCodexProvider.finalize, "function");
  assert.equal(codexProvider.finalize, undefined);   // codexProvider omits it
});

test("submit passes the pinned opts through to submitDirect verbatim", async () => {
  let seen = null;
  const opts = { model: "gpt-5.6-sol", effort: "max", cwd_real: "C:\\r", pii: false,
    timeoutMs: 1200000, binaryIdentity: { path: "p", version: "0.144.1", size: 1, mtime: 2 } };
  const r = await directCodexProvider.submit("prompt", opts,
    { submitDirect: async (p, o) => { seen = { p, o }; return { jobId: "dj-1" }; } });
  assert.deepEqual(r, { jobId: "dj-1" });
  assert.equal(seen.p, "prompt");
  assert.deepEqual(seen.o, opts);
});

test("extractAnswerText handles the direct result shape and raw strings", () => {
  assert.equal(directCodexProvider.extractAnswerText({ output: "verdict json" }), "verdict json");
  assert.equal(directCodexProvider.extractAnswerText("raw"), "raw");
  assert.equal(directCodexProvider.extractAnswerText(null), "");
});

// Review finding: getResult/cancel/effectiveStrength/finalize must forward the optional `deps`
// second param verbatim to their direct.mjs targets. Those targets are called via reviewers.mjs's
// own static import (no deps.fn ?? _fn seam like submit has), so the only way to observe the
// forwarded call is to mock direct.mjs BEFORE reviewers.mjs's dependency graph resolves it, and
// re-import reviewers.mjs fresh (cache-busted query, since the top of this file already imported
// it once against the real direct.mjs).
test("directCodexProvider.getResult/cancel/effectiveStrength/finalize forward (jobId, deps) verbatim to direct.mjs", async () => {
  const seen = {};
  await mock.module("../direct.mjs", {
    exports: {
      submitDirect: async () => ({ jobId: "unused" }),
      getDirectStatus: (jobId) => { seen.getStatus = [jobId]; return { job: { status: "completed" } }; },
      getDirectResult: (jobId, deps) => { seen.getResult = [jobId, deps]; return { output: "r" }; },
      cancelDirect: (jobId, deps) => { seen.cancel = [jobId, deps]; return { cancelled: true, jobId }; },
      directEffectiveStrength: (jobId, deps) => { seen.effectiveStrength = [jobId, deps]; return { model: "m", effort: "e" }; },
      finalizeJob: (jobId, deps) => { seen.finalize = [jobId, deps]; return undefined; },
    },
  });
  const { directCodexProvider: mockedProvider } = await import("../reviewers.mjs?direct-deps-forward=1");

  const jobId = "job-42";
  const deps = { cwd: "C:\\r", log: () => {} };

  mockedProvider.getResult(jobId, deps);
  mockedProvider.cancel(jobId, deps);
  mockedProvider.effectiveStrength(jobId, deps);
  mockedProvider.finalize(jobId, deps);

  assert.equal(seen.getResult[0], jobId);
  assert.equal(seen.getResult[1], deps);
  assert.equal(seen.cancel[0], jobId);
  assert.equal(seen.cancel[1], deps);
  assert.equal(seen.effectiveStrength[0], jobId);
  assert.equal(seen.effectiveStrength[1], deps);
  assert.equal(seen.finalize[0], jobId);
  assert.equal(seen.finalize[1], deps);
});

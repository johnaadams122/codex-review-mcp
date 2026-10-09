import { test } from "node:test";
import assert from "node:assert/strict";
import { codexProvider, ROLES, assignReviewers } from "../reviewers.mjs";

test("codexProvider is a backbone provider exposing the full contract", () => {
  assert.equal(codexProvider.name, "codex");
  assert.equal(codexProvider.role, ROLES.BACKBONE);
  for (const m of ["submit", "getStatus", "getResult", "extractAnswerText", "cancel", "effectiveStrength"]) {
    assert.equal(typeof codexProvider[m], "function", `missing ${m}`);
  }
});

test("codexProvider.submit forwards write:false and returns { jobId }", async () => {
  const seen = {};
  const fakeSubmit = async (prompt, opts) => { seen.prompt = prompt; seen.opts = opts; return { job_id: "abc" }; };
  const r = await codexProvider.submit("hello", { model: "m", effort: "high", cwd: "/x" }, { submitTaskViaFile: fakeSubmit });
  assert.equal(r.jobId, "abc");
  assert.equal(seen.opts.write, false);
  assert.equal(seen.opts.model, "m");
  assert.equal(seen.opts.effort, "high");
  assert.equal(seen.opts.cwd, "/x");
});

test("effectiveStrength reads request.model/effort back from the job status", async () => {
  const getStatus = async () => ({ job: { status: "completed", request: { model: "gpt-6.1-sol", effort: "xhigh" } } });
  const s = await codexProvider.effectiveStrength("j", { cwd: "/x" }, { getStatus });
  assert.deepEqual(s, { model: "gpt-6.1-sol", effort: "xhigh" });
});

test("effectiveStrength returns null (fail-closed) when the status omits model/effort", async () => {
  const getStatus = async () => ({ job: { status: "completed" } });
  assert.equal(await codexProvider.effectiveStrength("j", {}, { getStatus }), null);
});

test("effectiveStrength returns null when the status call throws (never a phantom strength)", async () => {
  const getStatus = async () => { throw new Error("down"); };
  assert.equal(await codexProvider.effectiveStrength("j", {}, { getStatus }), null);
});

test("assignReviewers maps every lens to the backbone by default", () => {
  const lenses = [{ key: "a" }, { key: "b" }];
  const manifest = assignReviewers(lenses);
  assert.equal(manifest.length, 2);
  assert.equal(manifest[0].provider.name, "codex");
  assert.equal(manifest[0].role, ROLES.BACKBONE);
  assert.equal(manifest[0].lens.key, "a");
});

test("assignReviewers produces a UNIQUE assignment_id per assignment", () => {
  const lenses = [{ key: "a" }, { key: "b" }, { key: "c" }];
  const manifest = assignReviewers(lenses);
  const ids = manifest.map((m) => m.assignment_id);
  assert.equal(new Set(ids).size, ids.length, "assignment_ids must be unique");
});

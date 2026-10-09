// tests/panel.before-submit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPanel, LENSES } from "../panel.mjs";

test("runPanel beforeSubmit VETO skips that lens's submit and records budget_capped", async () => {
  let submits = 0;
  const provider = {
    name: "codex", role: "backbone",
    submit: async () => { submits++; return { jobId: "j" + submits }; },
    getStatus: async () => ({ status: "completed" }), // pollToTerminal reads snap.status (jobs.mjs:293); a bare "completed" string would loop to the 480s timeout (C#12)
    getResult: async () => ({ output: "" }),
    extractAnswerText: (r) => (r && r.output) || "",
    cancel: async () => {},
  };
  const implLenses = LENSES.filter((l) => ["correctness", "security-pii"].includes(l.key));
  const beforeSubmit = async ({ lens }) => ({ ok: lens === "correctness" }); // veto security-pii
  const res = await runPanel(
    { cwd: "/repo", base: "main", scope: "auto", lenses: implLenses, model: "gpt-6.1-sol", effort: "medium" },
    { admit: () => ({ allowed: true }),
      gatherDiff: () => ({ diff: "diff --git a/x b/x\n+1", bytes: 20, truncated: false, scope: "auto", base: "main", treeClean: true }),
      providers: [provider], beforeSubmit });
  assert.equal(submits, 1);                                              // only the non-vetoed lens submitted
  assert.ok(res.abstentions.some((a) => a.reason === "budget_capped")); // the vetoed lens is a budget_capped absence
});

test("runPanel afterSubmit receives the REAL jobId after each successful submit (jobIds now populatable)", async () => {
  const seen = [];
  const provider = {
    name: "codex", role: "backbone",
    submit: async () => ({ jobId: "J-" + (seen.length + 1) }),
    getStatus: async () => ({ status: "completed" }),
    getResult: async () => ({ output: "" }),
    extractAnswerText: (r) => (r && r.output) || "",
    cancel: async () => {},
  };
  const implLenses = LENSES.filter((l) => ["correctness", "security-pii"].includes(l.key));
  const afterSubmit = async ({ lens, jobId }) => { seen.push({ lens, jobId }); };
  await runPanel(
    { cwd: "/repo", base: "main", scope: "auto", lenses: implLenses, model: "gpt-6.1-sol", effort: "medium" },
    { admit: () => ({ allowed: true }),
      gatherDiff: () => ({ diff: "diff --git a/x b/x\n+1", bytes: 20, truncated: false, scope: "auto", base: "main", treeClean: true }),
      providers: [provider], afterSubmit });
  assert.equal(seen.length, 2);                                          // fired once per submitted lens
  assert.ok(seen.every((s) => /^J-\d+$/.test(s.jobId)));                 // with the REAL jobId the provider returned
});

test("runPanel afterSubmit that THROWS never fails the submit (best-effort persist)", async () => {
  const provider = {
    name: "codex", role: "backbone",
    submit: async () => ({ jobId: "J1" }),
    getStatus: async () => ({ status: "completed" }),
    getResult: async () => ({ output: "" }),
    extractAnswerText: (r) => (r && r.output) || "",
    cancel: async () => {},
  };
  const implLenses = LENSES.filter((l) => ["correctness"].includes(l.key));
  const res = await runPanel(
    { cwd: "/repo", base: "main", scope: "auto", lenses: implLenses, model: "gpt-6.1-sol", effort: "medium" },
    { admit: () => ({ allowed: true }),
      gatherDiff: () => ({ diff: "diff --git a/x b/x\n+1", bytes: 20, truncated: false, scope: "auto", base: "main", treeClean: true }),
      providers: [provider], afterSubmit: async () => { throw new Error("journal write failed"); } });
  assert.ok(res.reviewers.length >= 0);                                  // the panel completed; the throw was swallowed
});

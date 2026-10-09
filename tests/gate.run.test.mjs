import { test } from "node:test";
import "./helpers/hermetic-policy.mjs";
import { installPolicyFixture, BETA } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "../gate.mjs";
import { handleGate } from "../server.mjs?gate=1";
import { ROLES } from "../reviewers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");

const CWD = "C:\\repo";

// A fake filesystem: `files` keyed by repo-relative forward-slash path. `symlink` maps a rel path
// to the REAL absolute path realpath would resolve it to (used to simulate an escaping symlink).
function fakeFs(files, { symlink = {} } = {}) {
  const norm = (p) => String(p).replace(/\//g, "\\");
  const key = (p) => {
    let n = norm(p);
    if (n.toLowerCase().startsWith(CWD.toLowerCase() + "\\")) n = n.slice(CWD.length + 1);
    return n.replace(/\\/g, "/");
  };
  return {
    admit: () => ({ allowed: true, project: "project_beta" }),
    realpath: (p) => {
      const n = norm(p);
      if (n === CWD) return CWD;
      const k = key(p);
      if (k in symlink) return symlink[k];
      if (k in files) return n;
      throw new Error("ENOENT: " + p);
    },
    readFile: (p) => {
      const k = key(p);
      if (k in files) return files[k];
      throw new Error("ENOENT read: " + p);
    },
  };
}

const passPanel = (over = {}) => async () => ({
  consensus_verdict: "pass", reviewers: [], findings: [],
  strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true },
  ...over,
});

// -------- strength floor (pre-dispatch) --------

test("runGate rejects an override below the phase floor WITHOUT dispatching", async () => {
  let dispatched = false;
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"], strength: { model: "gpt-6.1-sol", effort: "medium" } },
    { ...fakeFs({ "spec.md": "content" }), runPanel: async () => { dispatched = true; return { consensus_verdict: "pass" }; } }
  );
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "strength_below_floor");
  assert.equal(dispatched, false);
});

// -------- routing + labeling --------

test("runGate routes spec -> spec lenses + flagship strength and labels the verdict", async () => {
  let seen;
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"] },
    { ...fakeFs({ "spec.md": "a real spec body" }), runPanel: async (opts) => { seen = opts; return (await passPanel()()); } }
  );
  assert.equal(res.phase, "spec");
  assert.equal(res.consensus_verdict, "pass");
  assert.equal(seen.model, "gpt-6.1-sol");
  assert.equal(seen.effort, "xhigh");
  assert.deepEqual(seen.lenses.map((l) => l.key), ["completeness-gaps", "contradictions-ambiguity", "edge-cases-risks"]);
});

// -------- never review nothing --------

test("impl with an empty diff, no target and only context files -> no_reviewable_target (context is not the review target)", async () => {
  let dispatched = false;
  const res = await runGate(
    { phase: "impl", cwd: CWD, context_files: ["notes.md"] },
    { ...fakeFs({ "notes.md": "background only" }), gatherDiff: () => ({ diff: "", bytes: 0, truncated: false, treeClean: true }),
      runPanel: async () => { dispatched = true; return (await passPanel()()); } }
  );
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "no_reviewable_target");
  assert.equal(dispatched, false);
});

test("spec with NO target_files -> no_reviewable_target, no dispatch", async () => {
  let dispatched = false;
  const res = await runGate(
    { phase: "spec", cwd: CWD },
    { ...fakeFs({}), runPanel: async () => { dispatched = true; return {}; } }
  );
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "no_reviewable_target");
  assert.equal(dispatched, false);
});

test("impl with an empty diff and no target -> no_reviewable_target (never passes on nothing)", async () => {
  let dispatched = false;
  const res = await runGate(
    { phase: "impl", cwd: CWD },
    { ...fakeFs({}), gatherDiff: () => ({ diff: "", bytes: 0, truncated: false, treeClean: true }), runPanel: async () => { dispatched = true; return {}; } }
  );
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "no_reviewable_target");
  assert.equal(dispatched, false);
});

// -------- file-path safety --------

test("an ABSOLUTE target path is rejected (path_not_contained)", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: [String.raw`C:\Windows\system32\secret`] },
    { ...fakeFs({}), runPanel: passPanel() }
  );
  assert.equal(res.status, "path_not_contained");
});

test("a target path with '..' is rejected (path_not_contained)", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["../outside.md"] },
    { ...fakeFs({}), runPanel: passPanel() }
  );
  assert.equal(res.status, "path_not_contained");
});

test("a symlink whose real target escapes the repo is rejected", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["link.md"] },
    { ...fakeFs({ "link.md": "x" }, { symlink: { "link.md": String.raw`C:\outside\evil.md` } }), runPanel: passPanel() }
  );
  assert.equal(res.status, "path_not_contained");
});

test("a missing target file -> no_reviewable_target", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["ghost.md"] },
    { ...fakeFs({ "other.md": "x" }), runPanel: passPanel() }
  );
  assert.equal(res.status, "no_reviewable_target");
});

test("a binary target file -> no_reviewable_target", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["bin.md"] },
    { ...fakeFs({ "bin.md": `PK${String.fromCharCode(0)}${String.fromCharCode(0)}binaryjunk` }), runPanel: passPanel() }
  );
  assert.equal(res.status, "no_reviewable_target");
});

// -------- a content-empty target must not slip past on its label alone --------

test("an EMPTY-content target file -> no_reviewable_target (label alone is not review material)", async () => {
  let dispatched = false;
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"] },
    { ...fakeFs({ "spec.md": "" }), runPanel: async () => { dispatched = true; return { consensus_verdict: "pass", strength: {} }; } }
  );
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "no_reviewable_target");
  assert.equal(dispatched, false, "a content-empty target must never be dispatched");
});

test("a WHITESPACE-only target file -> no_reviewable_target", async () => {
  const res = await runGate(
    { phase: "plan", cwd: CWD, target_files: ["plan.md"] },
    { ...fakeFs({ "plan.md": "   \n\t\n" }), runPanel: passPanel() }
  );
  assert.equal(res.status, "no_reviewable_target");
});

// -------- context files --------

test("a declared-but-unreadable context_file is an error (never silently dropped)", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"], context_files: ["missing-context.md"] },
    { ...fakeFs({ "spec.md": "content" }), runPanel: passPanel() }
  );
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "no_reviewable_target");
});

// -------- effective-strength recheck (post-completion) --------

test("a panel that recorded a below-floor backbone strength is downgraded to error", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"] },
    {
      ...fakeFs({ "spec.md": "content" }),
      runPanel: passPanel({ strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "medium" }, backbone_attested: true } }),
    }
  );
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "strength_below_floor");
});

// -------- pass-through shaping --------

test("runGate labels a real block verdict with phase + extracts blockers[]", async () => {
  const res = await runGate(
    { phase: "plan", cwd: CWD, target_files: ["plan.md"] },
    {
      ...fakeFs({ "plan.md": "content" }),
      runPanel: async () => ({
        consensus_verdict: "block",
        reviewers: [], findings: [{ severity: "blocker", summary: "gap", lens: "scope-fidelity" }, { severity: "minor", summary: "nit" }],
        strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true },
      }),
    }
  );
  assert.equal(res.phase, "plan");
  assert.equal(res.consensus_verdict, "block");
  assert.equal(res.blockers.length, 1);
  assert.equal(res.strength.floor, "flagship");
});

// -------- end-to-end (real runPanel): truncation BLOCKS --------

test("an over-cap payload truncates and BLOCKS through the real panel", async (t) => {
  const repo = path.resolve(__dirname, ".."); // this checkout, registered as a git-allowed, non-PII project -> admit passes
  installPolicyFixture(t, { projectsBase: path.dirname(repo), projects: [{ ...BETA, dir: path.basename(repo) }] });
  const fakeProvider = {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: "j" }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult() { return { output: '{"verdict":"pass","findings":[]}' }; },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
  const res = await runGate(
    { phase: "spec", cwd: repo, target_files: ["package.json"] },
    { diffCap: 40, panelDeps: { providers: [fakeProvider] } }
  );
  assert.equal(res.consensus_verdict, "block", "a truncated gate payload can never pass");
});

// -------- server wiring: error -> isError --------

test("handleGate surfaces a blocked/unknown cwd as an MCP error", async () => {
  const res = await handleGate({ phase: "spec", cwd: String.raw`C:\definitely\not\a\project`, target_files: ["x.md"] });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.consensus_verdict, "error");
  assert.equal(res.isError, true);
});

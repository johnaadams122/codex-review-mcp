import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate, revisionLabel } from "../gate.mjs";
import { MAX_STRENGTH } from "../routing.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

const CWD = "C:\\repo";
const fakeFs = (files) => ({
  realpath: (p) => { const n = String(p).replace(/\//g, "\\"); if (n === CWD) return CWD; const k = n.slice(CWD.length + 1).replace(/\\/g, "/"); if (k in files) return n; throw new Error("ENOENT"); },
  readFile: (p) => { const k = String(p).replace(/\//g, "\\").slice(CWD.length + 1).replace(/\\/g, "/"); return files[k]; },
});

test("revisionLabel: throwing runGit -> pinned sentinel (no-git project)", () => {
  const noGit = () => { throw new Error("not a git repository"); };
  assert.equal(revisionLabel(CWD, noGit), "revision: none (no-git project)");
});

// revisionLabel must not inherit an ENCLOSING repo's HEAD/dirty state for a
// no-git project nested inside a larger git tree. The label is git-derived ONLY when
// `git rev-parse --show-toplevel` resolves (via fs.realpathSync) to the SAME directory as cwd.
test("revisionLabel: own-repo toplevel (realpath-stable temp dir) -> HEAD + dirty flag", (t) => {
  const dir = tempDirFor(t, "gate-revision-", { realpath: true });
  const calls = [];
  const gitClean = (args) => {
    calls.push(args.slice());
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return dir + "\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
    if (args[0] === "status") return "";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  assert.equal(revisionLabel(dir, gitClean), "revision: abc123");
  // show-toplevel first, then HEAD, then status -- exact call order, no extras.
  assert.deepEqual(calls, [["rev-parse", "--show-toplevel"], ["rev-parse", "HEAD"], ["status", "--porcelain"]]);

  const gitDirty = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return dir + "\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
    if (args[0] === "status") return " M panel.mjs\n";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  assert.equal(revisionLabel(dir, gitDirty), "revision: abc123 (dirty)");
});

test("revisionLabel: toplevel resolves to an ENCLOSING repo (different real dir) -> sentinel; HEAD/status NEVER run", (t) => {
  const dir = tempDirFor(t, "gate-revision-", { realpath: true });
  const enclosing = fs.realpathSync(os.tmpdir()); // real, distinct ancestor directory -- NOT dir's own toplevel
  const calls = [];
  const runGit = (args) => {
    calls.push(args.slice());
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return enclosing + "\n";
    // HEAD/status must never be reached once the toplevel mismatch is found.
    throw new Error(`unexpected git call past the toplevel check: ${args.join(" ")}`);
  };
  assert.equal(revisionLabel(dir, runGit), "revision: none (no-git project)");
  assert.deepEqual(calls, [["rev-parse", "--show-toplevel"]]); // HEAD/status never invoked
});

test("max spec gate: admitDirect (not sync admit) authorizes; direct bundle reaches runPanel", async () => {
  let panelArgs = null, syncAdmitCalled = false, admitDirectArgs = null;
  const admission = { allowed: true, kind: "direct_review", needs_git: false, cwd_real: CWD,
    policy: { name: "project_delta", pii_sensitive: true }, binaryIdentity: { path: "p", version: "0.144.1", size: 1, mtime: 2 } };
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"], strength: MAX_STRENGTH },
    {
      ...fakeFs({ "spec.md": "the spec body" }),
      admit: () => { syncAdmitCalled = true; return { allowed: true }; },
      admitDirect: async (a) => { admitDirectArgs = a; return admission; },
      // CWD is a fake, non-existent path here (this test's focus is admitDirect/direct-bundle
      // plumbing, not revisionLabel's own-repo logic -- see the dedicated revisionLabel tests
      // above): fs.realpathSync(CWD) can never resolve, so the toplevel check always falls to
      // the pinned sentinel regardless of what runGit returns for rev-parse.
      runGit: (args) => (args[0] === "rev-parse" ? "abc123\n" : ""),
      runPanel: async (opts, pdeps) => { panelArgs = { opts, pdeps }; return {
        consensus_verdict: "pass", reviewers: [], findings: [], dissent: [], abstentions: [],
        strength: { backbone_weakest: MAX_STRENGTH, backbone_attested: true }, transport: "direct",
      }; },
    });
  assert.equal(res.consensus_verdict, "pass");
  assert.equal(syncAdmitCalled, false);                       // exactly-once admission
  assert.deepEqual(admitDirectArgs, { cwd: CWD, needs_git: false }); // spec/plan pass needs_git=false
  assert.equal(panelArgs.pdeps.admission, admission);
  const d = panelArgs.opts.direct;
  assert.equal(d.evidence_kind, "document");
  assert.equal(d.revision, "revision: none (no-git project)");     // CWD has no real toplevel (see comment above)
  assert.deepEqual(d.target_files, ["spec.md"]);
  assert.equal(d.file_texts["spec.md"], "the spec body");     // in-memory bytes for the baseline
  assert.equal(typeof d.timeoutMs, "number");
  assert.equal(d.regatherDiff, null);                         // explicit-null contract: a document gate DISABLES the re-gather compare
  assert.equal(d.embedded_diff, "");
  assert.equal(res.strength_unverified, undefined);           // never applies to direct runs
});

test("zero-git-in-PII short-circuit: a no-git-policy max gate NEVER invokes git, label = pinned sentinel", async () => {
  let panelArgs = null;
  const admission = { allowed: true, kind: "direct_review", needs_git: false, cwd_real: CWD,
    policy: { name: "project_delta", pii_sensitive: true, git_allowed: false },
    binaryIdentity: { path: "p", version: "0.144.1", size: 1, mtime: 2 } };
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"], strength: MAX_STRENGTH },
    {
      ...fakeFs({ "spec.md": "the spec body" }),
      admitDirect: async () => admission,
      runGit: () => { throw new Error("git must NEVER be invoked on a git_allowed:false cwd"); },
      runPanel: async (opts, pdeps) => { panelArgs = { opts, pdeps }; return {
        consensus_verdict: "pass", reviewers: [], findings: [], dissent: [], abstentions: [],
        strength: { backbone_weakest: MAX_STRENGTH, backbone_attested: true }, transport: "direct",
      }; },
    });
  assert.equal(res.consensus_verdict, "pass"); // the throwing runGit proves git was never reached
  assert.equal(panelArgs.opts.direct.revision, "revision: none (no-git project)");
});

test("max impl gate: needs_git=true, evidence_kind=diff, regatherDiff + embedded_diff provided", async () => {
  let panelArgs = null;
  const admission = { allowed: true, kind: "direct_review", needs_git: true, cwd_real: CWD,
    policy: { name: "project_beta", pii_sensitive: false }, binaryIdentity: { path: "p", version: "0.144.1", size: 1, mtime: 2 } };
  const DIFF = "diff --git a/x.mjs b/x.mjs\n+1\n";
  const res = await runGate(
    { phase: "impl", cwd: CWD, strength: MAX_STRENGTH },
    {
      ...fakeFs({}),
      admitDirect: async () => admission,
      gatherDiff: () => ({ diff: DIFF, bytes: DIFF.length, truncated: false, scope: "working-tree", base: "main", treeClean: false }),
      runGit: (args) => (args[0] === "rev-parse" ? "abc123\n" : " M x.mjs\n"),
      runPanel: async (opts, pdeps) => { panelArgs = { opts, pdeps }; return {
        consensus_verdict: "pass", reviewers: [], findings: [], dissent: [], abstentions: [],
        strength: { backbone_weakest: MAX_STRENGTH, backbone_attested: true }, transport: "direct",
      }; },
    });
  assert.equal(res.consensus_verdict, "pass");
  const d = panelArgs.opts.direct;
  assert.equal(d.evidence_kind, "diff");
  assert.equal(d.embedded_diff, DIFF);
  assert.equal(typeof d.regatherDiff, "function");
  assert.equal(d.regatherDiff(), DIFF);
});

test("max gate: a failed direct admission maps to the EXISTING blocked shape", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"], strength: MAX_STRENGTH },
    { ...fakeFs({ "spec.md": "body" }),
      admitDirect: async () => ({ allowed: false, reason: "direct_preconditions_unmet", project: "project_delta" }),
      runPanel: async () => { throw new Error("must not dispatch"); } });
  assert.equal(res.consensus_verdict, "error");
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "direct_preconditions_unmet");
});

test("max gate: a blocked direct admission's detail rides the error payload (failure reason)", async () => {
  const res = await runGate(
    { phase: "plan", cwd: CWD, target_files: ["plan.md"], strength: MAX_STRENGTH },
    { ...fakeFs({ "plan.md": "body" }),
      admitDirect: async () => ({ allowed: false, reason: "direct_preconditions_unmet",
        project: "project_delta", detail: "network_denial_unverified: no_connectivity_control" }),
      runPanel: async () => { throw new Error("must not dispatch"); } });
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "direct_preconditions_unmet");
  assert.equal(res.detail, "network_denial_unverified: no_connectivity_control");
});

test("non-max gates are byte-identical: sync admit path, no direct bundle", async () => {
  let sawAdmit = false, panelArgs = null;
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"] },
    { ...fakeFs({ "spec.md": "body" }),
      admit: () => { sawAdmit = true; return { allowed: true, project: "project_beta" }; },
      admitDirect: async () => { throw new Error("must not be called"); },
      runPanel: async (opts, pdeps) => { panelArgs = { opts, pdeps }; return {
        consensus_verdict: "pass", reviewers: [], findings: [], dissent: [], abstentions: [],
        strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true },
      }; } });
  assert.equal(res.consensus_verdict, "pass");
  assert.equal(sawAdmit, true);
  assert.equal(panelArgs.opts.direct, undefined);
  assert.equal(panelArgs.pdeps.admission, undefined);
});

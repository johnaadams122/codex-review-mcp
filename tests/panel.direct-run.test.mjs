import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPanel, LENSES } from "../panel.mjs";
import { admitDirect } from "../admission.mjs";
import { MAX_STRENGTH } from "../routing.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, BETA, DELTA } from "./helpers/policy-fixture.mjs";

const ID = { path: ["C:", "bin", "codex.exe"].join("\\"), version: "0.144.1", size: 1, mtime: 2 };

function repoDir(t) {
  const dir = tempDirFor(t, "a1-prun-");
  fs.writeFileSync(path.join(dir, "a.mjs"), "export const x = 1;\n", "utf8");
  return fs.realpathSync(dir);
}
async function admission(cwd, needs_git = true) {
  // real admitDirect with injected deps -> genuine branded decision
  return admitDirect({ cwd, needs_git }, {
    realpath: (p) => fs.realpathSync(p),
    ensurePreconditions: async () => ({ ok: true, binaryIdentity: ID }),
  });
}
// admitDirect resolves policy from the policy table, so branded decisions need a named row. The
// diff below names package.json, a REAL file, so the direct-run cwd is this checkout itself,
// registered through the policy fixture as the synthetic beta project; a second, non-existent
// folder stands in for a pii, no-git project.
const CODEX_MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = installPolicyFixture({ after }, {
  projectsBase: path.dirname(CODEX_MCP),
  projects: [{ ...BETA, dir: path.basename(CODEX_MCP) }, DELTA],
});

function fakeDirectProvider({ verdictFor, attested = true, events }) {
  const submitted = [];
  return {
    submitted,
    name: "codex-direct", role: "backbone",
    async submit(prompt, opts) { const id = `dj-${submitted.length}`; submitted.push({ prompt, opts, id }); return { jobId: id }; },
    getStatus() { return { job: { status: "completed" } }; },
    getResult(jobId) { return { output: verdictFor(jobId) }; },
    extractAnswerText(raw) { return raw.output ?? ""; },
    cancel() {},
    effectiveStrength() { return attested ? { model: MAX_STRENGTH.model, effort: MAX_STRENGTH.effort } : null; },
    finalized: [],
    finalize(jobId) { this.finalized.push(jobId); },
  };
}

function directOpts(cwd) {
  return {
    cwd, scope: "working-tree", lenses: [LENSES[0]],
    model: MAX_STRENGTH.model, effort: MAX_STRENGTH.effort,
    direct: { timeoutMs: 120000, revision: "revision: abc", evidence_kind: "diff" },
  };
}
// The diff names package.json -- a REAL file in this repo -- so files_checked
// validation (regular file inside cwd_real), corroboration, diff-kind pass evidence, and a
// STABLE tree baseline (the file does not change during the test) all hold.
const DIFF = "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n+  \"a1\": true,\n";
function panelDeps(cwd, provider, admissionDecision, extra = {}) {
  return {
    admission: admissionDecision,
    providers: [provider],
    gatherDiff: () => ({ diff: DIFF, bytes: DIFF.length, truncated: false, scope: "working-tree", base: "main", treeClean: false }),
    readEvents: () => [{ command: "Get-Content package.json", aggregated_output: "" }],
    pollIntervalMs: 1,
    ...extra,
  };
}
const PASS = JSON.stringify({ lens: "correctness", verdict: "pass", confidence: "high", findings: [], files_checked: ["package.json"] });

test("resolution: per-lens max over a non-max default -> mixed rejected pre-admission; ALL-max map -> direct", async () => {
  // one max lens over the flagship default = mixed -> refused before any admission or dispatch
  const r = await runPanel({ cwd: CODEX_MCP, lenses: LENSES.slice(0, 2),
    lens_strengths: { correctness: { model: MAX_STRENGTH.model, effort: MAX_STRENGTH.effort } } });
  assert.equal(r.consensus_verdict, "error");
  assert.equal(r.status, "mixed_transport_unsupported");
  // an all-max per-lens map over the non-max default IS a direct run: it reaches
  // the direct branch and fails there only for the missing admission
  const r2 = await runPanel({ cwd: CODEX_MCP, lenses: [LENSES[0]],
    lens_strengths: { correctness: MAX_STRENGTH } });
  assert.equal(r2.status, "admission_required");
});

test("direct without deps.admission -> admission_required; forged/copy-stripped brands and wrong kind too", async (t) => {
  const cwd = repoDir(t);
  const r1 = await runPanel(directOpts(cwd), { gatherDiff: () => ({ diff: DIFF, bytes: 1, truncated: false, scope: "working-tree", base: "main", treeClean: false }) });
  assert.equal(r1.status, "admission_required");
  const real = await admission(CODEX_MCP);
  const forged = { ...real }; // spread drops the non-enumerable brand
  const r2 = await runPanel(directOpts(CODEX_MCP), panelDeps(CODEX_MCP, fakeDirectProvider({ verdictFor: () => PASS }), forged));
  assert.equal(r2.status, "admission_required");
  const wrongKind = await admission(CODEX_MCP);
  wrongKind.kind = "adversarial_review"; // genuinely branded, wrong kind -> refused
  const r3 = await runPanel(directOpts(CODEX_MCP), panelDeps(CODEX_MCP, fakeDirectProvider({ verdictFor: () => PASS }), wrongKind));
  assert.equal(r3.status, "admission_required");
});

test("companion runs must NOT carry a direct admission", async () => {
  const real = await admission(CODEX_MCP);
  const r = await runPanel({ cwd: CODEX_MCP, lenses: [LENSES[0]] }, { admission: real });
  assert.equal(r.consensus_verdict, "error");
  assert.equal(r.status, "admission_required");
});

test("admission cwd mismatch -> rejected", async (t) => {
  const other = repoDir(t);
  const real = await admission(CODEX_MCP);
  const r = await runPanel(directOpts(other), panelDeps(other, fakeDirectProvider({ verdictFor: () => PASS }), real));
  assert.equal(r.status, "admission_required");
});

test("happy direct run: submit opts pinned from admission+strength, attested pass, finalize awaited per reviewer", async () => {
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  const real = await admission(CODEX_MCP);
  const r = await runPanel(directOpts(CODEX_MCP), panelDeps(CODEX_MCP, provider, real));
  assert.equal(r.consensus_verdict, "pass");
  assert.equal(r.transport, "direct");
  assert.equal(provider.submitted.length, 1);
  const o = provider.submitted[0].opts;
  assert.deepEqual(o.binaryIdentity, ID);
  assert.equal(o.cwd_real, real.cwd_real);
  assert.equal(o.timeoutMs, 120000);
  assert.equal(o.pii, false);
  assert.deepEqual(provider.finalized, ["dj-0"]);
  assert.ok(provider.submitted[0].prompt.includes("files_checked"));
  assert.equal(r.strength.backbone_attested, true);
});

test("unattested -> strength_unattested abstention: completed+abstain -> block; ALL-abstain -> error", async () => {
  const real = await admission(CODEX_MCP);
  // (a) two lenses: one attested pass + one unattested -> abstention + completed backbone = BLOCK
  const p1 = fakeDirectProvider({ verdictFor: () => PASS });
  p1.effectiveStrength = (jobId) => (jobId === "dj-0" ? { model: MAX_STRENGTH.model, effort: MAX_STRENGTH.effort } : null);
  const r1 = await runPanel({ ...directOpts(CODEX_MCP), lenses: LENSES.slice(0, 2) }, panelDeps(CODEX_MCP, p1, real));
  assert.equal(r1.consensus_verdict, "block");
  assert.ok(r1.abstentions.some((a) => a.reason === "strength_unattested"));
  // (b) sole reviewer unattested -> ALL abstain -> ERROR (never a pass, distinct from block)
  const p2 = fakeDirectProvider({ verdictFor: () => PASS, attested: false });
  const r2 = await runPanel(directOpts(CODEX_MCP), panelDeps(CODEX_MCP, p2, real));
  assert.equal(r2.consensus_verdict, "error");
  assert.deepEqual(p2.finalized, ["dj-0"]); // finalize still ran
});

test("finalize failure is caught, LOGGED, and never reclassifies the reviewer", async () => {
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  provider.finalize = () => { throw new Error("finalize blew up"); };
  const real = await admission(CODEX_MCP);
  const lines = [];
  const r = await runPanel(directOpts(CODEX_MCP), panelDeps(CODEX_MCP, provider, real, { log: (m) => lines.push(m) }));
  assert.equal(r.consensus_verdict, "pass");
  assert.ok(lines.some((m) => /finalize failed/.test(m))); // logged, never rethrown
});

test("self-gathering diff with a genuine branded needs_git=false admission is refused; git never runs", async () => {
  const real = await admission(CODEX_MCP, false); // branded, allowed, needs_git: false
  let gitRan = false;
  const r = await runPanel(directOpts(CODEX_MCP), {
    admission: real,
    runGit: () => { gitRan = true; return ""; },
    pollIntervalMs: 1,
  }); // NO injected gatherDiff -> self-gathering -> the guard must fire pre-gather
  assert.equal(r.status, "admission_required");
  assert.equal(gitRan, false);
});

test("PII direct run: the payload is redacted at the panel and pii rides the submit opts", async () => {
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  const PII_PROJECT = fx.dirOf(DELTA);
  const real = await admitDirect({ cwd: PII_PROJECT, needs_git: false }, {
    realpath: (p) => p, ensurePreconditions: async () => ({ ok: true, binaryIdentity: ID }),
  });
  assert.equal(real.allowed, true);
  // Built at run time so no key-shaped literal sits in the source.
  const FAKE_AWS_ID = ["AKIA", "12345", "67890", "SECRET"].join("");
  const secretDiff = `diff --git a/notes.md b/notes.md\n+${["api_key", `"${FAKE_AWS_ID}"`].join(" = ")}\n`;
  const r = await runPanel({
    cwd: PII_PROJECT, scope: "working-tree", lenses: [LENSES[0]],
    model: MAX_STRENGTH.model, effort: MAX_STRENGTH.effort,
    direct: { timeoutMs: 120000, revision: "revision: none (no-git project)", evidence_kind: "diff" },
  }, {
    admission: real, providers: [provider], pollIntervalMs: 1,
    realpath: (p) => p, // match the admission's injected realpath
    gatherDiff: () => ({ diff: secretDiff, bytes: secretDiff.length, truncated: false, scope: "working-tree", base: "main", treeClean: false }),
    readEvents: () => [],
  });
  assert.equal(provider.submitted[0].opts.pii, true);                        // policy rode the admission
  assert.ok(!provider.submitted[0].prompt.includes(FAKE_AWS_ID)); // secret never dispatched
  assert.ok(provider.submitted[0].prompt.includes("[REDACTED:api-key]"));
  assert.equal(r.consensus_verdict, "error"); // sole reviewer's files_checked can't validate in the pii project -> all-abstain
});

test("payload_parse_error: an undecodable diff header refuses dispatch", async () => {
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  const real = await admission(CODEX_MCP);
  const badDiff = 'diff --git "a/bad\\q.md" "b/bad\\q.md"\n';
  const r = await runPanel(directOpts(CODEX_MCP), panelDeps(CODEX_MCP, provider, real,
    { gatherDiff: () => ({ diff: badDiff, bytes: badDiff.length, truncated: false, scope: "working-tree", base: "main", treeClean: false }) }));
  assert.equal(r.status, "payload_parse_error");
  assert.equal(provider.submitted.length, 0);
});

test("tree_changed: the diff re-gather mismatching the embedded diff -> consensus error", async () => {
  // Mutating real repo files in a test is unacceptable, so drive the tree_changed path through
  // the diff re-gather compare: the second gather returns different bytes.
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  const real = await admission(CODEX_MCP);
  let calls = 0;
  const gatherDiff = () => { calls++; return { diff: calls === 1 ? DIFF : DIFF + "+mutated\n", bytes: DIFF.length, truncated: false, scope: "working-tree", base: "main", treeClean: false }; };
  const r = await runPanel(directOpts(CODEX_MCP), panelDeps(CODEX_MCP, provider, real, { gatherDiff }));
  assert.equal(r.consensus_verdict, "error");
  assert.equal(r.status, "tree_changed");
});

test("gate document shape: explicit regatherDiff:null + embedded_diff:'' disables the re-gather compare -- NOT tree_changed", async () => {
  // Mirrors the spec/plan wiring exactly: the gate injects a static payload gatherDiff,
  // passes embedded_diff = diffText ("" for spec/plan) and regatherDiff = null (the
  // re-gather compare applies to DIFF-derived paths only; a document gate has none).
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  const real = await admission(CODEX_MCP);
  const opts = directOpts(CODEX_MCP);
  opts.direct = { ...opts.direct, regatherDiff: null, embedded_diff: "" };
  const r = await runPanel(opts, panelDeps(CODEX_MCP, provider, real));
  assert.equal(r.consensus_verdict, "pass");
  assert.equal(r.status, "complete"); // the recheck must not report __diff__ drift
});

test("fan-out drain: one submit failure cancels+finalizes the submitted sibling; all-abstain -> error", async () => {
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  let n = 0;
  provider.submit = async function (prompt, opts) {
    n++;
    if (n === 2) throw new Error("submit blew up");
    const id = `dj-${n}`; this.submitted.push({ prompt, opts, id }); return { jobId: id };
  };
  const cancelled = [];
  provider.cancel = (id) => cancelled.push(id);
  const real = await admission(CODEX_MCP);
  const opts = { ...directOpts(CODEX_MCP), lenses: LENSES.slice(0, 2) };
  const r = await runPanel(opts, panelDeps(CODEX_MCP, provider, real));
  assert.equal(r.consensus_verdict, "error"); // EVERY outcome abstained (submit_failed) -> error, never a pass
  assert.deepEqual(cancelled, ["dj-1"]);
  assert.ok(provider.finalized.includes("dj-1"));
});

test("fan-out drain: a LATE-resolving submit cannot escape -- allSettled waits, then cancel+finalize", async () => {
  const provider = fakeDirectProvider({ verdictFor: () => PASS });
  let n = 0;
  provider.submit = async function (prompt, opts) {
    n++;
    if (n === 1) throw new Error("first submit fails fast");
    await new Promise((r) => setTimeout(r, 50)); // the sibling resolves LATE, after the failure
    this.submitted.push({ prompt, opts, id: "dj-late" });
    return { jobId: "dj-late" };
  };
  const cancelled = [];
  provider.cancel = (id) => cancelled.push(id);
  const real = await admission(CODEX_MCP);
  const r = await runPanel({ ...directOpts(CODEX_MCP), lenses: LENSES.slice(0, 2) }, panelDeps(CODEX_MCP, provider, real));
  assert.equal(r.consensus_verdict, "error");
  assert.deepEqual(cancelled, ["dj-late"]);            // the late child was still drained
  assert.ok(provider.finalized.includes("dj-late"));
});

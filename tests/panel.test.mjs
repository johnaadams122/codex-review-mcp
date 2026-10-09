import { test } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Point the companion resolver at the fake companion in case any path reaches jobs.mjs.
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");

const { LENSES, gatherDiff, buildLensPrompt, decodeReviewerResult, aggregate, runPanel, normalizeSeverity } =
  await import("../panel.mjs");
const { handlePanel } = await import("../server.mjs?panel=1");

// -------- gatherDiff --------

test("gatherDiff working-tree runs `git diff HEAD` and includes untracked files", () => {
  const calls = [];
  const runGit = (args) => { calls.push(args); return args[0] === "ls-files" ? "brand_new.js" : "trackedchange"; };
  const r = gatherDiff({ cwd: "X", scope: "working-tree" }, runGit, () => "dangerous()");
  assert.ok(calls.some((a) => a[0] === "diff" && a[1] === "HEAD"));
  assert.ok(calls.some((a) => a[0] === "ls-files"));
  assert.ok(r.diff.includes("trackedchange"));
  assert.ok(r.diff.includes("NEW UNTRACKED FILE: brand_new.js"));
  assert.ok(r.diff.includes("dangerous()"));
  assert.equal(r.scope, "working-tree");
});

test("gatherDiff branch runs `git diff base...HEAD` AND folds untracked files in", () => {
  const calls = [];
  const runGit = (args) => { calls.push(args); return args[0] === "ls-files" ? "sneaky.js" : "committed"; };
  const r = gatherDiff({ cwd: "X", scope: "branch", base: "develop" }, runGit, () => "payload()");
  assert.ok(calls.some((a) => a[0] === "diff" && a[1] === "develop...HEAD"));
  assert.ok(r.diff.includes("committed"));
  assert.ok(r.diff.includes("NEW UNTRACKED FILE: sneaky.js"));
});

test("gatherDiff auto falls back to branch when the working tree (tracked+untracked) is clean", () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === "ls-files") return ""; // no untracked
    if (args[1] === "HEAD") return "   "; // empty tracked
    return "branchdiff";
  };
  const r = gatherDiff({ cwd: "X", scope: "auto", base: "main" }, runGit, () => "");
  assert.ok(calls.some((a) => a[0] === "diff" && a[1] === "HEAD"));
  assert.ok(calls.some((a) => a[0] === "ls-files"));
  assert.ok(r.diff.includes("branchdiff"));
  assert.equal(r.scope, "branch");
});

test("an untracked-only working tree is NOT an empty diff (no false pass)", () => {
  const runGit = (args) => (args[0] === "ls-files" ? "evil.js" : ""); // empty tracked, one untracked
  const r = gatherDiff({ cwd: "X", scope: "auto", base: "main" }, runGit, () => "steal_secrets()");
  assert.ok(r.diff.includes("evil.js"));
  assert.ok(r.diff.includes("steal_secrets()"));
  assert.equal(r.scope, "working-tree"); // treated as real working-tree changes, not empty/branch
});

test("branch scope with an empty committed diff still surfaces untracked code (no false pass)", () => {
  // git diff base...HEAD is empty, but an untracked file exists -> must NOT be an empty diff.
  const runGit = (args) => (args[0] === "ls-files" ? "evil.js" : ""); // empty committed diff, one untracked
  const r = gatherDiff({ cwd: "X", scope: "branch", base: "main" }, runGit, () => "steal_secrets()");
  assert.ok(r.diff.trim().length > 0, "untracked code must make the branch diff non-empty");
  assert.ok(r.diff.includes("evil.js"));
  assert.ok(r.diff.includes("steal_secrets()"));
});

test("gatherDiff reports treeClean=false when `git status --porcelain` is non-empty", () => {
  const runGit = (args) => (args[0] === "status" ? " M panel.mjs" : ""); // dirty tree, empty diffs
  const r = gatherDiff({ cwd: "X", scope: "branch", base: "main" }, runGit, () => "");
  assert.equal(r.treeClean, false);
});

test("gatherDiff reports treeClean=true on a clean tree", () => {
  const r = gatherDiff({ cwd: "X", scope: "branch", base: "main" }, () => "", () => "");
  assert.equal(r.treeClean, true);
});

test("gatherDiff caps an oversized diff and marks it truncated", () => {
  const big = "x".repeat(500);
  const runGit = (args) => (args[0] === "ls-files" ? "" : big);
  const r = gatherDiff({ cwd: "X", scope: "working-tree", diffCap: 100 }, runGit, () => "");
  assert.equal(r.truncated, true);
  assert.equal(r.bytes, 500);
  assert.ok(r.diff.length < 550);
  assert.ok(r.diff.includes("truncated"));
});

// -------- buildLensPrompt --------

test("buildLensPrompt embeds the lens key, the diff, and a JSON-only instruction", () => {
  const p = buildLensPrompt(LENSES[0], "MYDIFFBODY");
  assert.ok(p.includes(LENSES[0].key));
  assert.ok(p.includes("MYDIFFBODY"));
  assert.ok(p.includes("ONLY one JSON object"));
  assert.ok(p.includes("--- BEGIN DIFF ---"));
});

test("buildLensPrompt warns when the diff was truncated", () => {
  assert.ok(/truncat/i.test(buildLensPrompt(LENSES[0], "d", { truncated: true })));
});

// -------- decodeReviewerResult (the one canonical decoder) --------

test("decodeReviewerResult parses a clean JSON verdict", () => {
  const d = decodeReviewerResult('{"lens":"correctness","verdict":"pass","confidence":"high","findings":[]}');
  assert.equal(d.ok, true);
  assert.equal(d.verdict.verdict, "pass");
});

test("decodeReviewerResult tolerates markdown fences and surrounding prose", () => {
  const raw = 'Here is my review:\n```json\n{"lens":"security-pii","verdict":"block","findings":[{"severity":"blocker","summary":"leak"}]}\n```\nDone.';
  const d = decodeReviewerResult(raw);
  assert.equal(d.ok, true);
  assert.equal(d.verdict.verdict, "block");
  assert.equal(d.verdict.findings[0].severity, "blocker");
});

test("decodeReviewerResult accepts a getResult() object shape", () => {
  const d = decodeReviewerResult({ output: '{"lens":"x","verdict":"pass"}', status: "completed" });
  assert.equal(d.ok, true);
});

// The REAL companion `result` payloads (observed from the real companion): the reviewer's answer is
// nested, not on a top-level `output`. These shapes MUST decode or every reviewer abstains.
test("decodeReviewerResult reads the real companion result shape (job.summary)", () => {
  const raw = { job: { summary: '{"lens":"security-pii","verdict":"block","findings":[{"severity":"blocker","summary":"injection"}]}' } };
  const d = decodeReviewerResult(raw);
  assert.equal(d.ok, true);
  assert.equal(d.verdict.verdict, "block");
  assert.equal(d.verdict.findings[0].severity, "blocker");
});

test("decodeReviewerResult reads the real companion result shape (storedJob.result.rawOutput)", () => {
  const raw = { storedJob: { result: { rawOutput: '{"lens":"correctness","verdict":"pass","findings":[]}' } } };
  const d = decodeReviewerResult(raw);
  assert.equal(d.ok, true);
  assert.equal(d.verdict.verdict, "pass");
});

test("decodeReviewerResult never reads storedJob.summary (that field holds the PROMPT)", () => {
  // If the decoder mistakenly read the prompt, it would parse_fail on prose; verify it ignores it
  // and uses the real answer location instead.
  const raw = {
    job: { summary: '{"lens":"design-simplicity","verdict":"pass","findings":[]}' },
    storedJob: { summary: "You are an adversarial code reviewer. Review ONLY ..." },
  };
  const d = decodeReviewerResult(raw);
  assert.equal(d.ok, true);
  assert.equal(d.verdict.verdict, "pass");
});

test("decodeReviewerResult fails closed on non-JSON output", () => {
  const d = decodeReviewerResult("no json here at all");
  assert.equal(d.ok, false);
  assert.equal(d.reason, "parse_failed");
});

test("decodeReviewerResult fails closed on an invalid verdict value", () => {
  assert.equal(decodeReviewerResult('{"verdict":"maybe"}').ok, false);
});

test("decodeReviewerResult normalizes an unknown severity to blocker (fail-closed)", () => {
  const d = decodeReviewerResult('{"lens":"x","verdict":"pass","findings":[{"severity":"nuclear","summary":"s"}]}');
  assert.equal(d.verdict.findings[0].severity, "blocker");
});

// -------- aggregate (fail-CLOSED state machine) --------
// aggregate's signature is { manifest } (identity-safe), not { configuredCount }.
// Outcomes carry an assignment_id + role; the manifest names the expected backbone assignments.

const passOutcome = (lens) => ({ assignment_id: lens, lens, role: "backbone", ok: true, verdict: { lens, role: "backbone", verdict: "pass", confidence: "high", findings: [] } });
const blockOutcome = (lens) => ({ assignment_id: lens, lens, role: "backbone", ok: true, verdict: { lens, role: "backbone", verdict: "block", confidence: "high", findings: [{ severity: "blocker", summary: "x", file: "a", line: 1 }] } });
const abstainOutcome = (lens, reason) => ({ assignment_id: lens, lens, role: "backbone", ok: false, reason });
const mf = (...lenses) => lenses.map((lens) => ({ assignment_id: lens, lens, role: "backbone" }));

test("aggregate: all pass and all present -> pass", () => {
  assert.equal(aggregate([passOutcome("a"), passOutcome("b"), passOutcome("c")], { manifest: mf("a", "b", "c") }).consensus_verdict, "pass");
});

test("aggregate: any block verdict -> block", () => {
  assert.equal(aggregate([passOutcome("a"), blockOutcome("b"), passOutcome("c")], { manifest: mf("a", "b", "c") }).consensus_verdict, "block");
});

test("aggregate: a pass verdict carrying a blocker finding still -> block (cross-check)", () => {
  const sneaky = { assignment_id: "b", lens: "b", role: "backbone", ok: true, verdict: { lens: "b", role: "backbone", verdict: "pass", findings: [{ severity: "blocker", summary: "s" }] } };
  assert.equal(aggregate([passOutcome("a"), sneaky, passOutcome("c")], { manifest: mf("a", "b", "c") }).consensus_verdict, "block");
});

test("aggregate: one abstention -> block even if the rest pass", () => {
  const r = aggregate([passOutcome("a"), passOutcome("b"), abstainOutcome("c", "timeout")], { manifest: mf("a", "b", "c") });
  assert.equal(r.consensus_verdict, "block");
  assert.equal(r.abstentions.length, 1);
  assert.equal(r.abstentions[0].reason, "timeout");
});

test("aggregate: all abstain -> error", () => {
  assert.equal(aggregate([abstainOutcome("a", "timeout"), abstainOutcome("b", "parse_failed")], { manifest: mf("a", "b") }).consensus_verdict, "error");
});

test("aggregate: dedupes identical findings and lens-tags them", () => {
  const f = { severity: "major", summary: "dup", file: "a", line: 2 };
  const o1 = { assignment_id: "a", lens: "a", role: "backbone", ok: true, verdict: { lens: "a", role: "backbone", verdict: "block", findings: [f] } };
  const o2 = { assignment_id: "b", lens: "b", role: "backbone", ok: true, verdict: { lens: "b", role: "backbone", verdict: "block", findings: [f] } };
  const r = aggregate([o1, o2], { manifest: mf("a", "b") });
  assert.equal(r.findings.length, 1);
  assert.ok(r.findings[0].lens);
});

test("aggregate: dissent captures the minority verdict", () => {
  const r = aggregate([passOutcome("a"), passOutcome("b"), blockOutcome("c")], { manifest: mf("a", "b", "c") });
  assert.equal(r.consensus_verdict, "block");
  assert.equal(r.dissent.length, 2);
});

// -------- runPanel (orchestration, fully injected deps) --------

function fakeDeps(overrides = {}) {
  const deps = {
    admit: () => ({ allowed: true }),
    gatherDiff: () => ({ diff: "SOME DIFF", bytes: 9, truncated: false, scope: "working-tree", base: "main", treeClean: false }),
    redactSecrets: (s) => s,
    submitReviewer: async () => ({ job_id: "job" }),
    pollToTerminal: async () => "completed",
    getResult: async () => ({ output: '{"verdict":"pass","findings":[]}' }),
    cancelJob: async () => ({}),
  };
  return Object.assign(deps, overrides);
}

test("runPanel happy path -> pass, and submits every lens on flagship sol/xhigh", async () => {
  const submitted = [];
  const deps = fakeDeps({
    submitReviewer: async (prompt, o) => { submitted.push({ prompt, o }); return { job_id: "j" + submitted.length }; },
  });
  const r = await runPanel({ cwd: "/repo" }, deps);
  assert.equal(r.consensus_verdict, "pass");
  assert.equal(r.status, "complete");
  assert.equal(submitted.length, 3);
  assert.equal(submitted[0].o.model, "gpt-6.1-sol");
  assert.equal(submitted[0].o.effort, "xhigh");
  assert.equal(r.model, "gpt-6.1-sol");
});

test("runPanel submits lenses SEQUENTIALLY (store-race guard: no submission burst)", async () => {
  // The companion's saveState lost-update race deletes sibling jobs created by
  // concurrent submissions (ghosted lens jobs / "1/3 lenses completed" panels).
  // The panel must never submit two reviewer jobs at once.
  let inFlight = 0, maxInFlight = 0, n = 0;
  const deps = fakeDeps({
    submitReviewer: async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1; n += 1;
      return { job_id: "j" + n };
    },
  });
  const r = await runPanel({ cwd: "/repo" }, deps);
  assert.equal(r.consensus_verdict, "pass");
  assert.equal(n, 3);
  assert.equal(maxInFlight, 1);   // RED pre-fix: Promise.all made this 3
});

test("runPanel authorizes the cwd BEFORE gathering the diff (blocked cwd never reads git)", async () => {
  let gathered = false;
  const deps = fakeDeps({
    admit: () => ({ allowed: false, reason: "pii_project", project: "project_delta" }),
    gatherDiff: () => { gathered = true; return { diff: "x", bytes: 1, truncated: false }; },
  });
  const r = await runPanel({ cwd: "/pii" }, deps);
  assert.equal(gathered, false);
  assert.equal(r.status, "blocked");
  assert.equal(r.consensus_verdict, "error");
  assert.equal(r.reason, "pii_project");
});

test("runPanel threads opts.needs_git into its own admission call (gate.mjs spec/plan phases opt out; default true preserves every git-diff caller)", async () => {
  const calls = [];
  const deps = fakeDeps({
    admit: (args) => { calls.push(args); return { allowed: true }; },
  });
  await runPanel({ cwd: "/repo" }, deps);
  assert.equal(calls[0].needs_git, true, "default (no needs_git in opts) must stay true -- companion-path callers are diff-based");

  calls.length = 0;
  await runPanel({ cwd: "/repo", needs_git: false }, deps);
  assert.equal(calls[0].needs_git, false, "an explicit opts.needs_git:false must reach admit() unchanged");
});

test("runPanel redacts secrets from the diff before a reviewer sees it (real redactor)", async () => {
  let submittedPrompt = "";
  const leakedKey = ["sk", "ABCDEFGHIJKLMNOPQRSTUVWX0123456789"].join("-"); // built at run time
  const deps = fakeDeps({
    gatherDiff: () => ({ diff: `leak ${leakedKey}`, bytes: 40, truncated: false, scope: "working-tree", base: "main" }),
    submitReviewer: async (prompt) => { submittedPrompt = prompt; return { job_id: "j" }; },
  });
  delete deps.redactSecrets; // force runPanel to use the real admission.redactSecrets
  await runPanel({ cwd: "/repo" }, deps);
  assert.ok(!submittedPrompt.includes(leakedKey), "raw key must never reach the reviewer");
  assert.ok(submittedPrompt.includes("[REDACTED:sk-key]"));
});

test("runPanel: a reviewer timeout -> block, and its job is cancelled", async () => {
  let cancelled = 0;
  const deps = fakeDeps({
    submitReviewer: async (prompt) => ({ job_id: prompt.includes("security-pii") ? "timeoutjob" : "okjob" }),
    pollToTerminal: async (id) => (id === "timeoutjob" ? "timeout" : "completed"),
    cancelJob: async () => { cancelled++; return {}; },
  });
  const r = await runPanel({ cwd: "/repo" }, deps);
  assert.equal(r.consensus_verdict, "block");
  assert.equal(cancelled, 1);
  assert.equal(r.abstentions.length, 1);
  assert.equal(r.abstentions[0].reason, "timeout");
});

test("runPanel: empty diff on a CLEAN tree -> pass (empty_diff), no reviewers submitted", async () => {
  let submitted = 0;
  const deps = fakeDeps({
    gatherDiff: () => ({ diff: "   ", bytes: 3, truncated: false, scope: "working-tree", base: "main", treeClean: true }),
    submitReviewer: async () => { submitted++; return { job_id: "j" }; },
  });
  const r = await runPanel({ cwd: "/repo" }, deps);
  assert.equal(r.status, "empty_diff");
  assert.equal(r.consensus_verdict, "pass");
  assert.equal(submitted, 0);
});

test("empty scoped diff over a DIRTY tree fails closed (never a clean pass)", async () => {
  // e.g. scope=branch with tracked-but-uncommitted edits: the branch diff is empty but the
  // working tree holds unreviewed changes the scope did not capture.
  let submitted = 0;
  const deps = fakeDeps({
    gatherDiff: () => ({ diff: "", bytes: 0, truncated: false, scope: "branch", base: "HEAD", treeClean: false }),
    submitReviewer: async () => { submitted++; return { job_id: "j" }; },
  });
  const r = await runPanel({ cwd: "/repo", scope: "branch", base: "HEAD" }, deps);
  assert.equal(r.consensus_verdict, "error");
  assert.equal(r.status, "empty_scope_dirty_tree");
  assert.equal(submitted, 0);
});

// -------- handlePanel (server wiring), hermetic: blocked cwd needs no git or companion --------

test("handlePanel blocks an unknown/PII cwd without touching git or the companion", async () => {
  const res = await handlePanel({ cwd: ["C:", "definitely", "not", "a", "real", "project", "path"].join("\\") });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.status, "blocked");
  assert.equal(out.consensus_verdict, "error");
});

// -------- fail-closed hardening (review-driven) --------

test("normalizeSeverity: case-insensitive, synonyms, and unknown -> blocker (fail-closed)", () => {
  assert.equal(normalizeSeverity("BLOCKER"), "blocker");
  assert.equal(normalizeSeverity("Critical"), "blocker");
  assert.equal(normalizeSeverity("high"), "blocker");
  assert.equal(normalizeSeverity("moderate"), "major");
  assert.equal(normalizeSeverity("nit"), "minor");
  assert.equal(normalizeSeverity("frobnicate"), "blocker"); // unrecognized -> fail-closed
  assert.equal(normalizeSeverity(undefined), "blocker");
});

test("decodeReviewerResult accepts an uppercase/mixed-case verdict value", () => {
  assert.equal(decodeReviewerResult('{"verdict":"PASS"}').ok, true);
  assert.equal(decodeReviewerResult('{"verdict":"Block"}').verdict.verdict, "block");
});

test("a pass verdict hiding an uppercase BLOCKER finding still aggregates to block", () => {
  const d = decodeReviewerResult('{"lens":"security-pii","verdict":"pass","findings":[{"severity":"BLOCKER","file":"jobs.mjs","line":127,"summary":"secret leak"}]}');
  assert.equal(d.ok, true);
  assert.equal(d.verdict.findings[0].severity, "blocker"); // normalized, NOT downgraded to minor
  const r = aggregate(
    [{ assignment_id: "security-pii", lens: "security-pii", role: "backbone", ok: true, verdict: d.verdict }, passOutcome("correctness"), passOutcome("design-simplicity")],
    { manifest: mf("security-pii", "correctness", "design-simplicity") }
  );
  assert.equal(r.consensus_verdict, "block");
});

test("a truncated diff can never pass (all-pass + truncated -> block)", () => {
  const r = aggregate([passOutcome("a"), passOutcome("b"), passOutcome("c")], { manifest: mf("a", "b", "c"), truncated: true });
  assert.equal(r.consensus_verdict, "block");
});

test("end-to-end: runPanel with a truncated diff blocks even when every reviewer passes", async () => {
  const deps = fakeDeps({
    gatherDiff: () => ({ diff: "partial diff body", bytes: 500000, truncated: true, scope: "working-tree", base: "main" }),
  });
  const r = await runPanel({ cwd: "/repo" }, deps);
  assert.equal(r.diff_truncated, true);
  assert.equal(r.consensus_verdict, "block");
});

test("the lens prompt tells reviewers to BLOCK (never pass) when they cannot review", () => {
  const p = buildLensPrompt(LENSES[0], "d");
  assert.ok(/CANNOT fully review/i.test(p));
  assert.ok(/NEVER return "pass"/.test(p));
});

test("a non-array findings object fails closed (parse_failed), never pass", () => {
  const d = decodeReviewerResult('{"verdict":"pass","findings":{"severity":"BLOCKER","file":"server.mjs","line":42,"summary":"leak"}}');
  assert.equal(d.ok, false);
  assert.equal(d.reason, "parse_failed");
});

test("a findings array with a non-object element fails closed", () => {
  assert.equal(decodeReviewerResult('{"verdict":"pass","findings":["blocker: leak"]}').ok, false);
});

test("a finding with non-scalar fields (garbled file/line/summary) fails closed", () => {
  const raw = '{"lens":"correctness","verdict":"pass","findings":[{"severity":"minor","file":{"nested":"x"},"line":{"n":12},"summary":["garbled"]}]}';
  const d = decodeReviewerResult(raw);
  assert.equal(d.ok, false);
  assert.equal(d.reason, "parse_failed");
});

test("normalizeFinding-through-decode accepts a well-formed finding and a numeric-string line", () => {
  const d = decodeReviewerResult('{"lens":"x","verdict":"block","findings":[{"severity":"major","file":"a.js","line":"42","summary":"ok"}]}');
  assert.equal(d.ok, true);
  assert.equal(d.verdict.findings[0].line, 42);
});

test("a reviewer hiding blocker text in an unknown top-level field fails closed", () => {
  const d = decodeReviewerResult('{"verdict":"pass","notes":"BLOCKER: secret leak in jobs.mjs:127","findings":[]}');
  assert.equal(d.ok, false);
  assert.equal(d.reason, "parse_failed");
});

test("decodeReviewerResult still treats absent findings as a clean pass", () => {
  const d = decodeReviewerResult('{"verdict":"pass"}');
  assert.equal(d.ok, true);
  assert.deepEqual(d.verdict.findings, []);
});

test("handlePanel pins the flagship model (quality cannot downgrade) and surfaces error as isError", async () => {
  const res = await handlePanel({ cwd: ["C:", "definitely", "not", "a", "real", "project", "path"].join("\\"), quality: "fast" });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.model, "gpt-6.1-sol"); // quality:"fast" is ignored -> still flagship
  assert.equal(res.isError, true); // "error" consensus surfaced as an MCP error
});

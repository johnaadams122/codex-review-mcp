import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");

const { decodeReviewerResult, runPanel } = await import("../panel.mjs");
const { pollToTerminal } = await import("../jobs.mjs");
const { ROLES } = await import("../reviewers.mjs");

// WHY THIS EXISTS: a reviewer lens can finish with a complete, well-formed verdict that the
// panel nonetheless fails to read. Because ANY abstention blocks fail-closed, a lost read looks
// exactly like "this document cannot pass", and an input-shaped decode failure looks like a
// decoder bug when it is not. Replaying the decoder over completed lens records that held
// complete verdicts decodes every one of them cleanly, so the loss is in the READ path,
// not the decode path:
//   exit A -- the record is transiently absent at poll time (the companion's unlocked saveState
//             read-modify-write deletes a live sibling's record; the worker's next upsert
//             resurrects it). pollToTerminal gives up after TWO consecutive missing reads
//             ~1.5s apart -> not_found -> the panel maps that to reason `error`.
//   exit B -- the record is present and terminal but `result` is not written yet, so the answer
//             text extracts EMPTY, and an empty string decodes as `parse_failed` -- indistinguishable
//             from a reviewer that emitted garbage.
//
// Exit A is pinned by the two-read settle below. Exit B is INFERRED, not proven:
// progressPreview is cleared on completion, so a read cannot be reconstructed from the final
// record. What IS pinned is that an empty read must be reported distinctly from `parse_failed`.
//
// The fix is threefold and none of it weakens fail-closed: name an empty read `empty_result`
// instead of `parse_failed`, RE-READ (never re-dispatch) a bounded number of times before
// abstaining, and let the panel demand more consecutive missing reads than the default before
// accepting not_found. After the retries are exhausted it still abstains, and an abstention still
// blocks -- see the two sabotage tests at the bottom.

const VERDICT = JSON.stringify({
  verdict: "block",
  confidence: "high",
  findings: [{ severity: "blocker", file: "x.md", line: 1, summary: "y" }],
});

const baseDeps = (overrides = {}) => ({
  admit: () => ({ allowed: true, project: "project_beta" }),
  gatherDiff: () => ({ diff: "diff --git a b\n+x", truncated: false, bytes: 10, scope: "working-tree", base: "main", treeClean: false }),
  redactSecrets: (d) => d,
  resultRetryDelayMs: 0, // keep the suite fast; the production default is a real backoff
  ...overrides,
});

// A provider whose getResult returns an EMPTY answer for the first `emptyReads` calls per job,
// then the real verdict -- the mid-finalization read (exit B).
function flakyReadProvider(emptyReads) {
  let n = 0;
  const seen = new Map();
  return {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: `job-${n++}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult(jobId) {
      const c = (seen.get(jobId) ?? 0) + 1;
      seen.set(jobId, c);
      return { output: c <= emptyReads ? "" : VERDICT };
    },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
}

// ---------------- decode: an EMPTY answer is not a MALFORMED answer ----------------

test("decodeReviewerResult reports an empty answer as empty_result, not parse_failed", () => {
  const r = decodeReviewerResult({ output: "" }, (x) => x.output);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_result", "an absent answer must be identifiable as absent");
});

test("decodeReviewerResult reports a whitespace-only answer as empty_result", () => {
  const r = decodeReviewerResult({ output: "   \n\t  " }, (x) => x.output);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_result");
});

test("decodeReviewerResult reports a null/absent payload as empty_result", () => {
  assert.equal(decodeReviewerResult(null, () => null).reason, "empty_result");
  assert.equal(decodeReviewerResult({}, (x) => x.nope).reason, "empty_result");
});

test("decodeReviewerResult reports a fence-only answer as empty_result", () => {
  // ```json with nothing after it strips to whitespace -- still an absent answer, not a garbled one.
  const r = decodeReviewerResult({ output: "```json\n```" }, (x) => x.output);
  assert.equal(r.reason, "empty_result");
});

test("REGRESSION: real-but-unparseable text is still parse_failed, never empty_result", () => {
  // The point of the new reason is telling the cases apart. It must not swallow the genuine garbled-output
  // case, which is what parse_failed exists to name.
  assert.equal(decodeReviewerResult({ output: "I could not review this." }, (x) => x.output).reason, "parse_failed");
  assert.equal(decodeReviewerResult({ output: '{"verdict":"maybe"}' }, (x) => x.output).reason, "parse_failed");
  assert.equal(decodeReviewerResult({ output: "{ not json {" }, (x) => x.output).reason, "parse_failed");
});

// ---------------- panel: re-read a transiently empty result instead of discarding it ----------------

test("runPanel re-reads a transiently empty result and keeps the verdict", async () => {
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [flakyReadProvider(2)] }));
  assert.deepEqual(res.abstentions, [], "a mid-finalization read must not cost the lens");
  assert.equal(res.reviewers.length, 3, "all three lenses must be counted");
  assert.equal(res.consensus_verdict, "block");
});

test("runPanel survives an empty read on only SOME lenses", async () => {
  // The failure is partial -- one lens lost, the others fine.
  let call = 0;
  const provider = {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: `job-${call++}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult(jobId) {
      // only job-1 is caught mid-finalization, and only once
      if (jobId === "job-1" && !provider._hit) { provider._hit = true; return { output: "" }; }
      return { output: VERDICT };
    },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [provider] }));
  assert.deepEqual(res.abstentions, []);
  assert.equal(res.reviewers.length, 3);
});

test("runPanel re-reads but NEVER re-dispatches -- no second submit, no double spend", async () => {
  let submits = 0;
  const provider = {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { submits++; return { jobId: `job-${submits}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult() { return { output: "" }; },   // never resolves
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
  await runPanel({ cwd: "/repo" }, baseDeps({ providers: [provider] }));
  assert.equal(submits, 3, "exactly one submit per lens -- a retry is a READ, never a new job");
});

// ---------------- panel: re-read a TRUNCATED result too, not just an empty one ----------------

test("runPanel re-reads a TRUNCATED result and keeps the verdict", async () => {
  // The shape: a 3-lens gate records 1 reviewer + 2 `parse_failed`
  // abstentions while all three job records on disk hold complete decodable verdicts. The reads
  // were not empty -- they were cut off. getResult's fallback ladder returns the progressPreview
  // capture when the companion throws and the disk record is not readable yet, and that capture is
  // truncated. Retrying only `empty_result` misses this entirely.
  const cut = VERDICT.slice(0, Math.floor(VERDICT.length * 0.6)); // valid prefix, no closing brace
  let n = 0;
  const seen = new Map();
  const provider = {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: `job-${n++}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult(jobId) {
      const c = (seen.get(jobId) ?? 0) + 1;
      seen.set(jobId, c);
      return { output: c === 1 ? cut : VERDICT };
    },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [provider] }));
  assert.deepEqual(res.abstentions, [], "a truncated read must not cost the lens");
  assert.equal(res.reviewers.length, 3);
});

test("a truncated verdict decodes as parse_failed, not empty_result", () => {
  // Pins WHY the empty-only retry missed it: the text is present, just unbalanced.
  const cut = VERDICT.slice(0, Math.floor(VERDICT.length * 0.6));
  const r = decodeReviewerResult({ output: cut }, (x) => x.output);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "parse_failed");
});

// ---------------- poll: the panel tolerates more transient misses than the default ----------------

test("pollToTerminal accepts a configurable missing-read threshold", async () => {
  const missing = (id) => { throw new Error(`companion exited 1: No job found for "${id}"`); };
  let n = 0;
  const getStatus = async (id) => {
    n++;
    if (n <= 3) missing(id);
    return { job: { status: "completed" } };
  };
  const r = await pollToTerminal("task-x", { pollIntervalMs: 1, missingReadsBeforeNotFound: 4 }, getStatus);
  assert.equal(r, "completed", "three transient misses must not sink a job that then completes");
});

test("REGRESSION: pollToTerminal still defaults to TWO consecutive misses -> not_found", async () => {
  // The default is relied on elsewhere to resolve a genuine phantom quickly. Only the panel
  // widens it, because there a false not_found discards a completed multi-minute review.
  const getStatus = async (id) => { throw new Error(`companion exited 1: No job found for "${id}"`); };
  const r = await pollToTerminal("task-y", { pollIntervalMs: 1 }, getStatus);
  assert.equal(r, "not_found");
});

// ---------------- sabotage: prove fail-closed survives the retry ----------------

test("SABOTAGE: a permanently empty result still abstains, and all-abstain is still error", async () => {
  const provider = {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: `job-${Math.random()}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult() { return { output: "" }; },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [provider] }));
  assert.equal(res.abstentions.length, 3, "retries exhausted -> still an abstention");
  assert.ok(res.abstentions.every((a) => a.reason === "empty_result"));
  // Zero reviewers completed -> the panel did not RUN, which is `error`, not a verdict on the
  // document. Retrying must not have converted that into a pass by any route.
  assert.equal(res.consensus_verdict, "error");
  assert.notEqual(res.consensus_verdict, "pass");
});

test("SABOTAGE: ONE permanently empty lens still blocks the other two -- the 2-of-3 shape", async () => {
  // This is the shape of the failure: two lenses answer, one is lost. It must
  // remain a BLOCK. If the retry had made a lost lens silently ignorable, this would go pass.
  let n = 0;
  const provider = {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: `job-${n++}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult(jobId) {
      if (jobId === "job-1") return { output: "" };           // permanently unreadable
      return { output: JSON.stringify({ verdict: "pass", confidence: "high", findings: [] }) };
    },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [provider] }));
  assert.equal(res.abstentions.length, 1);
  assert.equal(res.abstentions[0].reason, "empty_result");
  assert.equal(res.consensus_verdict, "block", "a surviving abstention must still block two passes");
});

test("SABOTAGE: a retried-then-garbled result is named parse_failed, not empty_result", async () => {
  const seen = new Map();
  let n = 0;
  const provider = {
    name: "fake", role: ROLES.BACKBONE,
    async submit() { return { jobId: `job-${n++}` }; },
    async getStatus() { return { job: { status: "completed" } }; },
    async getResult(jobId) {
      const c = (seen.get(jobId) ?? 0) + 1;
      seen.set(jobId, c);
      return { output: c === 1 ? "" : "the reviewer rambled and emitted no verdict" };
    },
    extractAnswerText(raw) { return raw.output; },
    async cancel() {},
  };
  const res = await runPanel({ cwd: "/repo" }, baseDeps({ providers: [provider] }));
  assert.notEqual(res.consensus_verdict, "pass");
  assert.ok(res.abstentions.every((a) => a.reason === "parse_failed"),
    "once real text arrives, a bad verdict must be named for what it is");
});

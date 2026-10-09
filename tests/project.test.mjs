// Pure unit tests for project.mjs (the poll projector). NO mock.module, NO subprocess
// spawning -- `node --test tests/project.test.mjs` must work standalone. project.mjs
// imports nothing from jobs.mjs/server.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAnswer, projectResult, projectWait, projectStatus } from "../project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "jobs");
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name + ".json"), "utf8"));
}

const taskCompleted = loadFixture("task-completed");
const reviewNative = loadFixture("review-native-completed");
const adversarial = loadFixture("adversarial-completed");
const diskRecovered = loadFixture("disk-recovered");
const synthesized = loadFixture("synthesized");
const statusRunning = loadFixture("status-running");
const statusSynthesized = loadFixture("status-synthesized");

// -------------------- extractAnswer: precedence rungs (synthetic, isolated) --------------------

test("extractAnswer: string passthrough", () => {
  assert.equal(extractAnswer("plain string answer"), "plain string answer");
});

test("extractAnswer: null/undefined -> empty string", () => {
  assert.equal(extractAnswer(null), "");
  assert.equal(extractAnswer(undefined), "");
});

test("extractAnswer: bare {output} (rung 2) wins over rendered/summary", () => {
  assert.equal(extractAnswer({ output: "A", rendered: "B", summary: "C" }), "A");
});

test("extractAnswer: payload.job?.summary (rung 5) wins over rendered/summary when storedJob rungs are absent", () => {
  assert.equal(extractAnswer({ job: { summary: "job summary text" }, rendered: "x", summary: "y" }), "job summary text");
});

test("extractAnswer: falls to rendered when output/storedJob/job absent", () => {
  assert.equal(extractAnswer({ rendered: "rendered text", summary: "summary text" }), "rendered text");
});

test("extractAnswer: falls to summary when everything else absent", () => {
  assert.equal(extractAnswer({ summary: "summary text" }), "summary text");
});

test("extractAnswer: falls to empty string when nothing matches", () => {
  assert.equal(extractAnswer({}), "");
});

// ?? semantics, not truthiness: a PRESENT empty string at a rung must WIN, not be treated as
// absent and fall through to the next rung.
test("extractAnswer: a PRESENT empty string at payload.output wins over summary (?? semantics)", () => {
  assert.equal(extractAnswer({ output: "", summary: "y" }), "");
});

test("extractAnswer: a PRESENT empty string at storedJob.result.rawOutput wins over rendered (?? semantics)", () => {
  assert.equal(extractAnswer({ storedJob: { result: { rawOutput: "" } }, rendered: "x" }), "");
});

// -------------------- extractAnswer: per fixture (production variants) --------------------

test("extractAnswer(task-completed): reads storedJob.result.rawOutput (rung 3), never job.summary or storedJob.summary", () => {
  const answer = extractAnswer(taskCompleted);
  assert.equal(answer, taskCompleted.storedJob.result.rawOutput);
  assert.notEqual(answer, taskCompleted.job.summary);
  assert.notEqual(answer, taskCompleted.storedJob.summary);
});

test("extractAnswer(review-native-completed): companion stores NO rawOutput for native reviews -- must yield the FULL codex.stdout text (rung 4), not the one-line job summary", () => {
  assert.notEqual(taskCompleted.storedJob.result.rawOutput, undefined, "sanity: task fixture does have rawOutput");
  assert.equal(reviewNative.storedJob.result.rawOutput, undefined, "sanity: native review fixture must NOT carry rawOutput");
  const answer = extractAnswer(reviewNative);
  assert.equal(answer, reviewNative.storedJob.result.codex.stdout);
  assert.notEqual(answer, reviewNative.job.summary);
  assert.notEqual(answer, reviewNative.storedJob.summary);
});

test("extractAnswer(adversarial-completed): rawOutput (rung 3) is chosen over codex.stdout (rung 4) even though both are present", () => {
  const answer = extractAnswer(adversarial);
  assert.equal(answer, adversarial.storedJob.result.rawOutput);
  assert.notEqual(answer, adversarial.storedJob.result.codex.stdout);
  assert.notEqual(answer, adversarial.job.summary);
  assert.notEqual(answer, adversarial.storedJob.summary);
});

test("extractAnswer(disk-recovered): reads storedJob.result.rawOutput", () => {
  const answer = extractAnswer(diskRecovered);
  assert.equal(answer, diskRecovered.storedJob.result.rawOutput);
  assert.notEqual(answer, diskRecovered.storedJob.summary);
});

test("extractAnswer(synthesized): reads the bare {output} field (rung 2)", () => {
  assert.equal(extractAnswer(synthesized), "2 is prime");
});

// -------------------- prompt-trap: storedJob.summary is neutral, and never leaks --------------------

const BIG_FIXTURES = [
  ["task-completed", taskCompleted, "task-8f3ac1"],
  ["review-native-completed", reviewNative, "review-4b9e02"],
  ["adversarial-completed", adversarial, "review-adv-77c1"],
  ["disk-recovered", diskRecovered, "task-d19f4a"],
];

test("prompt-trap sanity: every stored-job fixture's storedJob.summary is genuinely neutral (post-sanitization) text, not a raw prompt/marker", () => {
  for (const [name, fx] of BIG_FIXTURES) {
    const s = fx.storedJob.summary;
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0, `${name}: storedJob.summary must be present`);
    assert.doesNotMatch(s, /MARKER|DO_NOT_LEAK/, `${name}: storedJob.summary must be neutral fixture text, not a debug marker`);
  }
});

test("prompt-trap: injecting a marker into storedJob.summary on a CLONE never leaks through ANY projector function", () => {
  const MARKER = "PROMPT_MARKER_DO_NOT_LEAK";
  const MARKER_RE = /PROMPT_MARKER_DO_NOT_LEAK/;
  for (const [name, fx, jobId] of BIG_FIXTURES) {
    const trapped = { ...fx, storedJob: { ...fx.storedJob, summary: MARKER } };

    const answer = extractAnswer(trapped);
    assert.doesNotMatch(answer, MARKER_RE, `${name}: extractAnswer leaked the prompt`);

    const projected = projectResult(jobId, trapped);
    assert.doesNotMatch(JSON.stringify(projected), MARKER_RE, `${name}: projectResult leaked the prompt`);

    const waited = projectWait({ status: "completed", job_id: jobId, result: trapped });
    assert.doesNotMatch(JSON.stringify(waited), MARKER_RE, `${name}: projectWait leaked the prompt`);
  }
});

// -------------------- projectResult: per-fixture shape + status precedence --------------------

test("projectResult(task-completed): status falls back to payload.job?.status (no top-level payload.status); touchedFiles/model pass through", () => {
  assert.equal(taskCompleted.status, undefined, "sanity: real companion result payloads carry no top-level status");
  const r = projectResult("task-8f3ac1", taskCompleted);
  assert.deepEqual(r, {
    status: "completed",
    job_id: "task-8f3ac1",
    output: taskCompleted.storedJob.result.rawOutput,
    touchedFiles: taskCompleted.storedJob.result.touchedFiles,
    model: taskCompleted.storedJob.request.model,
  });
});

test("projectResult(review-native-completed): status falls back to payload.job?.status; no optional passthroughs present at all", () => {
  assert.equal(reviewNative.status, undefined);
  const r = projectResult("review-4b9e02", reviewNative);
  assert.deepEqual(r, {
    status: "completed",
    job_id: "review-4b9e02",
    output: reviewNative.storedJob.result.codex.stdout,
  });
});

test("projectResult(adversarial-completed): status falls back to payload.job?.status; no optional passthroughs present in the raw fixture", () => {
  assert.equal(adversarial.status, undefined);
  const r = projectResult("review-adv-77c1", adversarial);
  assert.deepEqual(r, {
    status: "completed",
    job_id: "review-adv-77c1",
    output: adversarial.storedJob.result.rawOutput,
  });
});

test("projectResult(disk-recovered): status comes from top-level payload.status (jobs.mjs constructs this itself, no job sub-record exists); _diskRecovered, model, touchedFiles pass through", () => {
  assert.equal(diskRecovered.job, undefined, "sanity: disk-recovered payloads carry no job sub-record");
  const r = projectResult("task-d19f4a", diskRecovered);
  assert.deepEqual(r, {
    status: "completed",
    job_id: "task-d19f4a",
    output: diskRecovered.storedJob.result.rawOutput,
    touchedFiles: diskRecovered.storedJob.result.touchedFiles,
    model: diskRecovered.storedJob.request.model,
    _diskRecovered: true,
  });
});

test("projectResult(synthesized): statusOverride wins over payload.status (waitForResult owns terminal status separately from the payload)", () => {
  assert.equal(synthesized.status, "completed");
  const overridden = projectResult("job-x1", synthesized, "succeeded");
  assert.equal(overridden.status, "succeeded", "statusOverride must win over payload.status");
  const notOverridden = projectResult("job-x1", synthesized);
  assert.deepEqual(notOverridden, {
    status: "completed",
    job_id: "job-x1",
    output: "2 is prime",
    _synthesized: true,
  });
});

// -------------------- projectResult: "present ONLY when present" passthroughs (spread-clones) --------------------
// The 7 named fixtures are kept 100% production-true (no field without a producer citation), so
// the optional top-level flags are exercised here via spread-augmented clones instead of baking
// unverifiable fields into the fixture files themselves.

test("projectResult: write_blocked passes through ONLY when present on the payload (spread-clone of task-completed), including present-but-false", () => {
  const withFlag = { ...taskCompleted, write_blocked: false };
  const r = projectResult("task-8f3ac1", withFlag);
  assert.equal(hasOwn(r, "write_blocked"), true);
  assert.equal(r.write_blocked, false);

  const withoutFlag = projectResult("task-8f3ac1", taskCompleted);
  assert.equal(hasOwn(withoutFlag, "write_blocked"), false, "absent on the un-augmented fixture");
});

test("projectResult: truncated passes through ONLY when present on the payload (spread-clone of adversarial-completed), including present-but-false", () => {
  const withFlag = { ...adversarial, truncated: false };
  const r = projectResult("review-adv-77c1", withFlag);
  assert.equal(hasOwn(r, "truncated"), true);
  assert.equal(r.truncated, false);

  const withoutFlag = projectResult("review-adv-77c1", adversarial);
  assert.equal(hasOwn(withoutFlag, "truncated"), false, "absent on the un-augmented fixture");
});

// -------------------- provenance divergence (item 4): fake vs real companion result shape --------------------
//
// VERDICT (verified by reading the real companion's scripts/codex-companion.mjs, read-only):
//   handleResult in codex-companion.mjs builds `const payload = { job, storedJob }` and
//   passes it straight to outputCommandResult(payload, rendered, options.json) (:99-101), which
//   for --json calls outputResult(payload, true) (:91-97) -> `console.log(JSON.stringify(payload,
//   null, 2))`. No status key is ever injected anywhere in that path. The REAL companion's
//   `result --json` output genuinely has NO top-level `status`, for every jobClass (task/review/
//   adversarial-review) -- confirming task-completed/review-native-completed/adversarial-completed
//   are correct to omit it and rely on the payload.job?.status fallback rung.
//
//   The IN-REPO FAKE companion (tests/fixtures/scripts/codex-companion.mjs) diverges: its `result`
//   handler prints `{storedJob, status: rec.status}` for the STORE-based path (:83-87) and
//   `{output, status: "completed"}` for the legacy non-STORE path (:105-106) -- both DO carry a
//   top-level `status`. This is a fake-companion-only simplification used by this repo's own
//   integration tests, not a real production shape. Pinned here so the divergence is explicit,
//   not silent.
test("provenance divergence: a fake-companion-shaped payload (top-level status present) wins rung 1 of the status chain, unlike the real companion's result payloads which never carry it", () => {
  const fakeCompanionShapedPayload = {
    status: "completed", // only the fake companion's `result` output ever sets this
    job: { status: "running" },
    storedJob: { status: "running" },
  };
  const r = projectResult("job-fake1", fakeCompanionShapedPayload);
  assert.equal(r.status, "completed", "top-level payload.status must win over job?.status/storedJob?.status when present");
});

// -------------------- byte evidence: projection strictly shrinks the 4 big fixtures --------------------

test("byte evidence: JSON.stringify(projected).length < JSON.stringify(raw).length for the 4 big fixtures", () => {
  for (const [name, fx, jobId] of BIG_FIXTURES) {
    const rawLen = JSON.stringify(fx).length;
    const projectedLen = JSON.stringify(projectResult(jobId, fx)).length;
    console.log(`byte evidence: ${name} raw=${rawLen} projected=${projectedLen}`);
    assert.ok(projectedLen < rawLen, `${name}: projected (${projectedLen}) must be smaller than raw (${rawLen})`);
  }
});

// -------------------- projectWait: every terminal status shape --------------------

test("projectWait: completed -> full projectResult shape", () => {
  const w = { status: "completed", job_id: "task-8f3ac1", result: taskCompleted };
  assert.deepEqual(projectWait(w), projectResult("task-8f3ac1", taskCompleted, "completed"));
});

test("projectWait: succeeded -> full projectResult shape (succeeded is a success terminal, same as completed)", () => {
  const w = { status: "succeeded", job_id: "review-4b9e02", result: reviewNative };
  assert.deepEqual(projectWait(w), projectResult("review-4b9e02", reviewNative, "succeeded"));
});

test("projectWait: result_error -> {status, job_id, error}, error retained", () => {
  const w = { status: "result_error", job_id: "task-99", error: "companion timed out after 150ms" };
  assert.deepEqual(projectWait(w), { status: "result_error", job_id: "task-99", error: "companion timed out after 150ms" });
});

for (const status of ["timeout", "not_found", "cancelled", "failed", "error"]) {
  test(`projectWait: ${status} -> {status, job_id} only (no getResult call, no result/error leakage)`, () => {
    const w = { status, job_id: "task-77" };
    assert.deepEqual(projectWait(w), { status, job_id: "task-77" });
  });
}

// -------------------- projectStatus: minimal shape from both status fixtures --------------------

test("projectStatus(status-running): minimal shape + write_blocked passthrough (spread-clone, present); _synthesized absent", () => {
  const withFlag = { job: { ...statusRunning.job, write_blocked: false } };
  const r = projectStatus("task-r55e1", withFlag);
  assert.deepEqual(r, {
    job_id: "task-r55e1",
    status: "running",
    phase: "investigating",
    pid: 48212,
    elapsed: "0m 47s",
    summary: statusRunning.job.summary,
    write_blocked: false,
  });

  const withoutFlag = projectStatus("task-r55e1", statusRunning);
  assert.equal(hasOwn(withoutFlag, "write_blocked"), false, "absent on the un-augmented fixture");
  assert.equal(hasOwn(withoutFlag, "_synthesized"), false);
});

test("projectStatus: jobId param falls back to rec.id when jobId is null/undefined", () => {
  assert.equal(projectStatus(undefined, statusRunning).job_id, "task-r55e1");
  assert.equal(projectStatus(null, statusRunning).job_id, "task-r55e1");
  assert.equal(projectStatus("explicit-id", statusRunning).job_id, "explicit-id");
});

test("projectStatus(status-synthesized): summary is the CAPTURED answer (post-synthesize overwrite, not a neutral placeholder); _synthesized passthrough present; write_blocked absent", () => {
  const r = projectStatus("task-s90c2", statusSynthesized);
  assert.deepEqual(r, {
    job_id: "task-s90c2",
    status: "completed",
    phase: "done",
    pid: null,
    elapsed: "4m 02s",
    summary: "normalization landed; poll trim pending review",
    _synthesized: true,
  });
  assert.equal(r.summary, statusSynthesized.job.summary);
  assert.equal(hasOwn(r, "write_blocked"), false);
});

// -------------------- projectStatus: bare-record snapshot (no .job wrapper) --------------------
// job-guard.mjs sanitizeSnapshot:165-171 handles two snapshot shapes: {job:{...}} (the common
// case, covered above) and a BARE record (the snapshot IS the job record, no wrapper). This
// models a stored job record fed directly to projectStatus with no `.job` wrapper and no
// `elapsed` (elapsed is enrichJob-only enrichment on a STATUS read, per lib/job-control.mjs:
// 161-180 -- a bare stored-job-shaped record never carries it).
test("projectStatus: bare-record snapshot (no .job wrapper) with absent elapsed -- elapsed key is OMITTED, not present-as-undefined", () => {
  const bareRec = {
    id: "task-bare1",
    status: "completed",
    phase: "done",
    pid: null,
    summary: "[task] codex-mcp: bare record, no job wrapper",
  };
  const r = projectStatus("task-bare1", bareRec);
  assert.deepEqual(r, {
    job_id: "task-bare1",
    status: "completed",
    phase: "done",
    pid: null,
    summary: "[task] codex-mcp: bare record, no job wrapper",
  });
  assert.equal(hasOwn(r, "elapsed"), false, "elapsed must be omitted when absent from the record, not present-as-undefined");
});

test("projectStatus: bare-record snapshot with elapsed present includes it (hasOwnProperty-gated, not truthiness-gated)", () => {
  const bareRec = { id: "task-bare2", status: "running", phase: "investigating", pid: 100, elapsed: "0m 01s", summary: "s" };
  const r = projectStatus("task-bare2", bareRec);
  assert.equal(hasOwn(r, "elapsed"), true);
  assert.equal(r.elapsed, "0m 01s");
});

import { test, mock, after } from "node:test";
import { installPolicyFixture, BETA, DELTA, EPSILON } from "./helpers/policy-fixture.mjs";
import assert from "node:assert/strict";

// Mock ALL jobs.mjs exports server.mjs imports, so no companion is spawned.
const fakeSubmitTask = mock.fn(async () => ({ job_id: "task-adm-1", status: "queued" }));
const fakeSubmitReview = mock.fn(async () => ({ job_id: "rev-adm-1", status: "queued" }));
const fakeSubmitAdversarial = mock.fn(async () => ({ job_id: "adv-adm-1", status: "queued" }));

await mock.module("../jobs.mjs", {
  exports: {
    submitTask: fakeSubmitTask,
    submitReview: fakeSubmitReview,
    submitAdversarialReview: fakeSubmitAdversarial,
    submitTaskViaFile: mock.fn(async () => ({ job_id: "task-adm-file-1", status: "queued" })),
    extractAnswerText: (r) => (r == null ? "" : typeof r === "string" ? r : r.output ?? ""),
    getStatus: mock.fn(async () => ({})),
    getResult: mock.fn(async () => ({})),
    listJobs: mock.fn(async () => []),
    cancelJob: mock.fn(async () => ({})),
    // panel.mjs re-exports pollToTerminal from jobs; server.mjs imports waitForResult.
    pollToTerminal: mock.fn(async () => "completed"),
    waitForResult: mock.fn(async () => ({ status: "completed", result: {} })),
    // direct.mjs (transitively loaded via admission.mjs) imports these
    isPidAlive: () => false,
    buildTreeKillArgs: (pid) => ["taskkill", "/PID", String(pid), "/T", "/F"]
  }
});

const { handleTask, handleReview, handleAdversarialReview } = await import("../server.mjs?adm=1");

const fx = installPolicyFixture({ after });
// Secret-shaped test values are assembled at run time so no key-shaped literal sits in the source.
const FAKE_SK = ["sk", "abc12345678901234567890"].join("-");
const FAKE_PW_VALUE = "supersecret99x";
const FAKE_TOKEN_VALUE = "abcdef0123456789xyz";
// pii + write + review allowed + no git; pii + write blocked + review blocked; plain non-pii git project
const PII_CWD = fx.dirOf(DELTA);
const PHI_CWD = fx.dirOf(EPSILON);
const SAFE_CWD = fx.dirOf(BETA);

test("codex_task on PII cwd is NO LONGER full-blocked: read-only job submitted", async () => {
  fakeSubmitTask.mock.resetCalls();
  const res = await handleTask({ prompt: "explain the ledger loader", write: false, cwd: PII_CWD });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.job_id, "task-adm-1");
  assert.equal(out.write_blocked, false);
  assert.ok(!res.isError);
});

test("codex_task on a pii project that allows write, write=true: write reaches the companion", async () => {
  fakeSubmitTask.mock.resetCalls();
  const res = await handleTask({ prompt: "fix the bug", write: true, cwd: PII_CWD });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.write_blocked, false);
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.write, true);
});

test("codex_task on a pii project that blocks write, write=true: write still fails CLOSED before the companion sees it", async () => {
  fakeSubmitTask.mock.resetCalls();
  const res = await handleTask({ prompt: "fix the bug", write: true, cwd: PHI_CWD });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.write_blocked, true);
  const opts = fakeSubmitTask.mock.calls[0].arguments[1];
  assert.equal(opts.write, false, "write flag must never reach submitTask on a write-blocked cwd");
});

test("codex_task redacts prompt AND context_snapshot at the gate", async () => {
  fakeSubmitTask.mock.resetCalls();
  await handleTask({
    prompt: `why does ${["api_key", FAKE_SK].join("=")} fail`,
    context_snapshot: `env has ${["password", FAKE_PW_VALUE].join("=")} here`,
    write: false, cwd: SAFE_CWD
  });
  const calledPrompt = fakeSubmitTask.mock.calls[0].arguments[0];
  assert.ok(!calledPrompt.includes(FAKE_SK), "prompt secret redacted");
  assert.ok(!calledPrompt.includes(FAKE_PW_VALUE), "context secret redacted");
  assert.ok(calledPrompt.includes("[REDACTED"), "redaction marker present");
});

test("codex_review on a pii cwd with review allowed stays blocked: codex_review is git-diff based and the project has no git", async () => {
  fakeSubmitReview.mock.resetCalls();
  const res = await handleReview({ scope: "working-tree", base: undefined, cwd: PII_CWD });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.error, "blocked");
  assert.equal(out.reason, "git_not_allowed", "the remaining reason is no-git, not PII");
  assert.equal(res.isError, true);
  assert.equal(fakeSubmitReview.mock.calls.length, 0, "no diff to review in a no-git project");
});

test("codex_review on a pii cwd without a review override stays blocked and never calls submitReview", async () => {
  fakeSubmitReview.mock.resetCalls();
  const res = await handleReview({ scope: "working-tree", base: undefined, cwd: PHI_CWD });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.error, "blocked");
  assert.equal(out.reason, "pii_project");
  assert.equal(res.isError, true);
  assert.equal(fakeSubmitReview.mock.calls.length, 0, "blocked review must not submit");
});

test("codex_review on UNKNOWN cwd is blocked (fail-closed default)", async () => {
  const res = await handleReview({ scope: "auto", base: undefined, cwd: ["C:", "Nope", "Nowhere"].join("\\") });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.error, "blocked");
  assert.equal(out.reason, "pii_project");
});

test("codex_adversarial_review redacts focus text; blocks a pii project on pii_project; blocks a no-git project on git_not_allowed (diff-based)", async () => {
  fakeSubmitAdversarial.mock.resetCalls();
  await handleAdversarialReview({
    focus: `check handling of ${["token", FAKE_TOKEN_VALUE].join("=")}`,
    scope: "working-tree", base: undefined, cwd: SAFE_CWD
  });
  const calledFocus = fakeSubmitAdversarial.mock.calls[0].arguments[0];
  assert.ok(!calledFocus.includes(FAKE_TOKEN_VALUE), "focus secret redacted");

  const phiBlocked = await handleAdversarialReview({ focus: "x", scope: "auto", base: undefined, cwd: PHI_CWD });
  const phiOut = JSON.parse(phiBlocked.content[0].text);
  assert.equal(phiOut.reason, "pii_project");

  fakeSubmitAdversarial.mock.resetCalls();
  const pfBlocked = await handleAdversarialReview({ focus: "x", scope: "auto", base: undefined, cwd: PII_CWD });
  const pfOut = JSON.parse(pfBlocked.content[0].text);
  assert.equal(pfOut.reason, "git_not_allowed", "codex_adversarial_review is diff-based and the project has no git");
  assert.equal(fakeSubmitAdversarial.mock.calls.length, 0);
});

test("codex_adversarial_review pins the flagship model (gpt-6.1-sol) by default", async () => {
  fakeSubmitAdversarial.mock.resetCalls();
  const res = await handleAdversarialReview({ focus: "design", scope: "working-tree", base: undefined, cwd: SAFE_CWD });
  const opts = fakeSubmitAdversarial.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol", "adversarial review must run on the flagship model");
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.model, "gpt-6.1-sol", "response surfaces the model actually used");
});

test("codex_review pins the flagship model (gpt-6.1-sol) by default", async () => {
  fakeSubmitReview.mock.resetCalls();
  await handleReview({ scope: "working-tree", base: undefined, cwd: SAFE_CWD });
  const opts = fakeSubmitReview.mock.calls[0].arguments[0];
  assert.equal(opts.model, "gpt-6.1-sol", "review must run on the flagship model");
});

test("review quality override selects the standard tier (terra)", async () => {
  fakeSubmitAdversarial.mock.resetCalls();
  await handleAdversarialReview({ focus: "x", scope: "working-tree", base: undefined, cwd: SAFE_CWD, quality: "standard" });
  const opts = fakeSubmitAdversarial.mock.calls[0].arguments[1];
  assert.equal(opts.model, "gpt-6.1-sol", "quality=standard selects terra");
});

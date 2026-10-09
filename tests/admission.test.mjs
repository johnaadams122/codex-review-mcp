import { test, after } from "node:test";
import assert from "node:assert/strict";
import { admit, redactSecrets } from "../admission.mjs";
import { installPolicyFixture, BETA, GAMMA, DELTA, EPSILON } from "./helpers/policy-fixture.mjs";

const fx = installPolicyFixture({ after });
// a pii project that allows write and review but has no git; a pii project that blocks write too
const PII_CWD = fx.dirOf(DELTA);
const PHI_CWD = fx.dirOf(EPSILON);
const WRITABLE_CWD = fx.dirOf(BETA);
const GIT_SAFE_CWD = fx.dirOf(BETA);
const NO_GIT_CWD = fx.dirOf(GAMMA);
const UNKNOWN_CWD = String.raw`C:\Some\Unknown\Path`;
// Secret-shaped test values are assembled at run time so no source line looks like a real credential.
const FAKE_SK_KEY = ["sk", "abc12345678901234567890"].join("-");
const FAKE_PASSWORD = ["hunter2", "secret99"].join("");
const FAKE_TOKEN = ["abcdef01234", "56789xyz"].join("");

// --- task kind ---

test("task on PII cwd without write: allowed read-only", () => {
  const g = admit({ kind: "task", cwd: PII_CWD, write: false, task: "review the ledger loader" });
  assert.equal(g.allowed, true);
  assert.equal(g.effective_write, false);
  assert.equal(g.write_blocked, false);
  assert.equal(g.policy.name, "project_delta");
});

test("task on a pii project that allows write, with write=true: write allowed", () => {
  const g = admit({ kind: "task", cwd: PII_CWD, write: true, task: "fix the bug" });
  assert.equal(g.allowed, true);
  assert.equal(g.effective_write, true);
  assert.equal(g.write_blocked, false);
  assert.equal(g.policy.pii_sensitive, true, "still pii_sensitive");
});

test("task on writable cwd with write=true: write allowed", () => {
  const g = admit({ kind: "task", cwd: WRITABLE_CWD, write: true, task: "fix the bug" });
  assert.equal(g.allowed, true);
  assert.equal(g.effective_write, true);
  assert.equal(g.write_blocked, false);
});

test("task on UNKNOWN cwd: fail-closed default -> read-only allowed, write blocked", () => {
  const g = admit({ kind: "task", cwd: UNKNOWN_CWD, write: true, task: "do something" });
  assert.equal(g.allowed, true);
  assert.equal(g.effective_write, false);
  assert.equal(g.write_blocked, true);
  assert.equal(g.policy.pii_sensitive, true, "unknown cwd must resolve to the PII default");
});

test("task on a pii project that blocks write: read-only allowed, write blocked", () => {
  const g = admit({ kind: "task", cwd: PHI_CWD, write: true, task: "summarize the timeline doc" });
  assert.equal(g.allowed, true);
  assert.equal(g.effective_write, false);
  assert.equal(g.write_blocked, true);
});

test("task redaction applies to task text AND context_snapshot at the gate", () => {
  const g = admit({
    kind: "task", cwd: GIT_SAFE_CWD,
    task: `investigate why api_key=${FAKE_SK_KEY} stopped working`,
    context_snapshot: `config has password=${FAKE_PASSWORD} in it`
  });
  assert.ok(!g.task.includes(FAKE_SK_KEY), "task text must be redacted");
  assert.ok(g.task.includes("[REDACTED"), "task redaction marker present");
  assert.ok(!g.context_snapshot.includes(FAKE_PASSWORD), "context must be redacted");
  assert.ok(g.context_snapshot.includes("[REDACTED"), "context redaction marker present");
});

// --- delegate kind (same semantics as task) ---

test("delegate mirrors task semantics: write allowed where the row allows it, write-blocked where it does not", () => {
  const pf = admit({ kind: "delegate", cwd: PII_CWD, write: true, task: "analyze this module" });
  assert.equal(pf.allowed, true);
  assert.equal(pf.effective_write, true);
  assert.equal(pf.write_blocked, false);

  const phi = admit({ kind: "delegate", cwd: PHI_CWD, write: true, task: "analyze this module" });
  assert.equal(phi.allowed, true);
  assert.equal(phi.effective_write, false);
  assert.equal(phi.write_blocked, true);
});

test("delegate on unknown cwd: fail-closed read-only", () => {
  const g = admit({ kind: "delegate", cwd: UNKNOWN_CWD, write: true, task: "t" });
  assert.equal(g.allowed, true);
  assert.equal(g.write_blocked, true);
});

// --- review / adversarial_review kinds ---

test("review (git-diff based, needs_git default true) on a pii project with review allowed but no git: blocked on git_not_allowed, not pii_project (a git-diff review has nothing to diff)", () => {
  const g = admit({ kind: "review", cwd: PII_CWD });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "git_not_allowed");
  assert.equal(g.project, "project_delta");
});

test("review with needs_git:false on that project: ALLOWED (spec/plan gate phases review named files, not a diff)", () => {
  const g = admit({ kind: "review", cwd: PII_CWD, needs_git: false });
  assert.equal(g.allowed, true);
  assert.equal(g.policy.name, "project_delta");
  assert.equal(g.effective_write, false);
  assert.equal(g.write_blocked, false);
});

test("review on a pii project with no review override: still BLOCKED", () => {
  const g = admit({ kind: "review", cwd: PHI_CWD });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "pii_project");
});

test("review on UNKNOWN cwd: BLOCKED via the fail-closed pii default", () => {
  const g = admit({ kind: "review", cwd: UNKNOWN_CWD });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "pii_project");
});

test("review on non-git non-PII cwd: BLOCKED with git_not_allowed", () => {
  const g = admit({ kind: "review", cwd: NO_GIT_CWD });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "git_not_allowed");
  assert.equal(g.project, "project_gamma");
});

test("review on git-allowed non-PII cwd: allowed", () => {
  const g = admit({ kind: "review", cwd: GIT_SAFE_CWD });
  assert.equal(g.allowed, true);
  assert.equal(g.effective_write, false);
  assert.equal(g.write_blocked, false);
});

test("adversarial_review: a pii project without review override blocked on pii_project; a pii no-git project with review allowed blocked on git_not_allowed (needs_git default true); needs_git:false unblocks it; focus text redacted when allowed", () => {
  const phiBlocked = admit({ kind: "adversarial_review", cwd: PHI_CWD, task: "focus" });
  assert.equal(phiBlocked.allowed, false);
  assert.equal(phiBlocked.reason, "pii_project");

  const pfBlocked = admit({ kind: "adversarial_review", cwd: PII_CWD, task: "focus" });
  assert.equal(pfBlocked.allowed, false);
  assert.equal(pfBlocked.reason, "git_not_allowed", "no-git is the remaining reason once review is allowed");

  const pfNoGitNeeded = admit({ kind: "adversarial_review", cwd: PII_CWD, task: "focus", needs_git: false });
  assert.equal(pfNoGitNeeded.allowed, true, "spec/plan-style review is allowed without git");

  const ok = admit({
    kind: "adversarial_review", cwd: GIT_SAFE_CWD,
    task: `challenge the auth flow around token=${FAKE_TOKEN}`
  });
  assert.equal(ok.allowed, true);
  assert.ok(!ok.task.includes(FAKE_TOKEN),"focus text must be redacted");
});

// --- fail-closed defaults ---

test("unknown kind is BLOCKED (gate fails closed on unrecognized operations)", () => {
  const g = admit({ kind: "status", cwd: GIT_SAFE_CWD });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "unknown_kind");
});

test("missing kind is BLOCKED", () => {
  const g = admit({ cwd: GIT_SAFE_CWD });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "unknown_kind");
});

test("redactSecrets passes through null/empty unchanged", () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets("no secrets here"), "no secrets here");
});

// A simple /sk-[A-Za-z0-9]{20,}/ pattern stops at the first hyphen, so modern HYPHENATED
// vendor keys would walk straight through the outbound redactor. Both shapes below are
// real-world formats (an OpenRouter key and an Anthropic key).
test("redactSecrets redacts a hyphenated OpenRouter sk-or-v1- key", () => {
  // Built from short segments on purpose: a full-length literal here would itself look
  // like a vendor API key and trip secret scanners. The joined value is still a
  // realistic key, so the test is not weakened.
  const key = "sk-or-" + "v1-" + "4f8a2b9c1d3e5f7a" + "8b9c0d1e2f3a4b5c";
  const out = redactSecrets(`use ${key} now`);
  assert.ok(!out.includes(key), "raw OpenRouter key survived redaction");
  assert.ok(out.includes("[REDACTED:sk-key]"));
});

test("redactSecrets redacts a hyphenated Anthropic sk-ant-api03- key", () => {
  const key = "sk-ant-api03-" + "A".repeat(95);
  const out = redactSecrets(`ANTHROPIC_API_KEY=${key}`);
  assert.ok(!out.includes(key), "raw Anthropic key survived redaction");
  assert.ok(out.includes("[REDACTED:sk-key]"));
});

test("redactSecrets still redacts a legacy non-hyphenated sk- key", () => {
  const key = "sk-" + "B".repeat(32);
  assert.ok(!redactSecrets(`k=${key}`).includes(key));
});

test("redactSecrets does not redact ordinary hyphenated prose", () => {
  const prose = "ask-me-about-the-sk-this-is-not-a-key thanks";
  assert.equal(redactSecrets(prose), prose);
});

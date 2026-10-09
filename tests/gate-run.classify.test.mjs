// tests/gate-run.classify.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classify } from "../hooks/gate-run.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, BETA, DELTA } from "./helpers/policy-fixture.mjs";

// the auto-gate allowlist is read from the policy settings file: list only the synthetic beta project
installPolicyFixture({ after }, { gateAllowlist: [BETA.name] });

function repoWithAutogate(t) {
  const d = tempDirFor(t, "cls-", { realpath: true });
  fs.writeFileSync(path.join(d, ".codex-autogate"), "");
  return d;
}
const baseDeps = () => ({
  runGit: (args) => (args[0] === "diff" ? "diff --git a/x.js b/x.js\n+1" : ""),
  listUntracked: () => [],
  realpath: (p) => p,                                     // identity: PII scan resolves synthetic files
  resolvePolicy: () => ({ pii_sensitive: false, name: BETA.name }),
  projectNameOf: () => BETA.name,                        // UNDERSCORE -- matches the fixture allowlist
  now: () => new Date("2026-07-18T12:00:00"),
});

test("clean impl commit returns launch with targetKey=diffId (repoRoot resolved via walk-up)", async (t) => {
  const cwd = repoWithAutogate(t);
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, baseDeps());
  assert.equal(d.action, "launch");
  assert.equal(d.targetKey, d.diffId);
  assert.equal(d.repoRoot, cwd);                           // keyed off the resolved root
  assert.equal(d.jobs, 2);                                 // N = IMPL_LENS_KEYS.length
});

test("a commit from a SUBDIR keys off the walked-up repoRoot, not cwd_real", async (t) => {
  const root = repoWithAutogate(t);
  const sub = path.join(root, "hooks");
  fs.mkdirSync(sub, { recursive: true });
  const ev = { sessionId: "s1", cwd_real: fs.realpathSync(sub), target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, baseDeps());
  assert.equal(d.action, "launch");
  assert.equal(d.repoRoot, root);                          // resolveAutogateRoot walked UP to the root
});

test("CODEX_AUTOGATE=off short-circuits to opt_out skip (before any panel import)", async (t) => {
  const cwd = repoWithAutogate(t);
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, { ...baseDeps(), env: { CODEX_AUTOGATE: "off" } });
  assert.equal(d.action, "skip"); assert.equal(d.reason, "opt_out");
});

test("a PII-tree payload file skips (fail-closed), never launches", async (t) => {
  const cwd = repoWithAutogate(t);
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, { ...baseDeps(), resolvePolicy: (p) => (String(p).includes("x.js") ? { pii_sensitive: true, name: DELTA.name } : { pii_sensitive: false, name: BETA.name }) });
  assert.equal(d.action, "skip"); assert.match(d.reason, /^pii_/);
});

test("budget exhaustion returns a SURFACEABLE skip (not a silent drop)", async (t) => {
  const cwd = repoWithAutogate(t);
  // pre-fill today's journal to the cap so reserveOK(2) is false
  const { upsertRun, dayKey } = await import("../hooks/run-journal.mjs");
  upsertRun(cwd, "OLD", { status: "pass", dayKey: dayKey(new Date("2026-07-18T12:00:00")), jobs_submitted: 20 });
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, baseDeps());
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "budget");
  assert.equal(d.surfaceable, true);
  assert.equal(d.repoRoot, cwd);
});

test("classify never throws -- an internal error is a skip", async () => {
  const d = await classify(null, {});
  assert.equal(d.action, "skip");
});

test("classify's catch block converts a thrown dep error into skip(internal_error) -- not just validateEvent's early-return", async (t) => {
  const cwd = repoWithAutogate(t);
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, { ...baseDeps(), resolveAutogateRoot: () => { throw new Error("boom"); } });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /^internal_error/);
});

test("STRING payload_files does not fail-open to launch (Array.isArray guard)", async (t) => {
  const cwd = repoWithAutogate(t);
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  // computePayloadFiles returns a STRING for payload_files (no .error) -- piiScanPayload's for..of
  // would iterate this char-by-char WITHOUT throwing, so only the explicit Array.isArray guard in
  // classify stops this from silently passing the PII scan and launching.
  const d = await classify(ev, { ...baseDeps(), computePayloadFiles: () => ({ payload_files: "not-an-array-string" }) });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "payload_parse_error");
});

test("a non-allowlisted repo does NOT launch, even with an otherwise-valid event", async (t) => {
  const cwd = repoWithAutogate(t);
  const ev = { sessionId: "s1", cwd_real: cwd, target: { kind: "commit", sha: "abc" }, triggeredAt: "T" };
  const d = await classify(ev, { ...baseDeps(), projectNameOf: () => "some_unlisted_repo" });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "not_allowlisted");
});

test("hooks/gate-run.mjs has NO top-level static import of panel/gate/jobs.mjs (lazy-load invariant)", () => {
  const src = fs.readFileSync(new URL("../hooks/gate-run.mjs", import.meta.url), "utf8");
  // Only a line-start `import ... from "panel.mjs"|"gate.mjs"|"jobs.mjs"` should trip this -- a
  // dynamic `await import("../panel.mjs")` inside a function does NOT start a line with "import".
  const topLevelHeavyImport = /^\s*import\s.+from\s+["'](\.\.\/)?(panel|gate|jobs)\.mjs["']/m;
  assert.equal(topLevelHeavyImport.test(src), false);
  // sanity: the regex itself must be able to catch a real top-level import if one were added.
  assert.equal(topLevelHeavyImport.test('import { x } from "../panel.mjs";\n'), true);
  // sanity: a dynamic import must NOT trip the regex.
  assert.equal(topLevelHeavyImport.test('  const panel = deps.panel ?? await import("../panel.mjs");\n'), false);
});

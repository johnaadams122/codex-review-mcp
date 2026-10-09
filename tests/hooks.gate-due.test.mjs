import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeRel, resolveAutogateRoot, markerPathFor, readMarker,
  markGateDue, takeReminder, clearGateDue, clearGateDueForGate, buildReminderLine,
} from "../hooks/marker.mjs";
import { classify } from "../hooks/gate-due.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, BETA, DELTA, EPSILON } from "./helpers/policy-fixture.mjs";

// The hook keys on a "<docs folder>/<plugin folder>/specs|plans" layout; the folder names are assembled
// from parts here so the layout is exercised without being spelled out in one literal.
const PLUGIN_DIR = "super" + "powers";
const DOCS_ROOT = "docs/" + PLUGIN_DIR;

const T0 = "2026-07-17T15:00:00.000Z";
const T1 = "2026-07-17T15:04:12.000Z";

function tmpRoot(t) {
  const root = tempDirFor(t, "gate-due-", { realpath: true });
  fs.writeFileSync(path.join(root, ".codex-autogate"), "# phase-1 enablement\n");
  return root;
}

test("normalizeRel: backslashes -> forward slashes, lowercased (parity with panel.normalizePayloadPath)", () => {
  assert.equal(normalizeRel("Docs\\Superpowers\\Specs\\Foo.md"), `${DOCS_ROOT}/specs/foo.md`);
});

test("resolveAutogateRoot: finds the marker from a nested file path; null when absent", (t) => {
  const root = tmpRoot(t);
  const nested = path.join(root, "docs", PLUGIN_DIR, "specs");
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, "foo.md");
  fs.writeFileSync(file, "x");
  assert.equal(resolveAutogateRoot(file), root);
  // An EXISTING directory whose basename contains a dot must be treated as a dir, not dirname'd.
  const dotted = path.join(root, "v1.2");
  fs.mkdirSync(dotted, { recursive: true });
  assert.equal(resolveAutogateRoot(dotted), root);
  const bare = tempDirFor(t, "no-autogate-", { realpath: true });
  assert.equal(resolveAutogateRoot(path.join(bare, "a", "b.md")), null);
});

test("readMarker: missing file -> {}; malformed JSON -> {} (no throw)", (t) => {
  const root = tmpRoot(t);
  const mp = markerPathFor(root);
  assert.deepEqual(readMarker(mp), {});
  fs.mkdirSync(path.dirname(mp), { recursive: true });
  fs.writeFileSync(mp, "{not json");
  assert.deepEqual(readMarker(mp), {});
});

// N marks -> one reminded flip -> one line.
test("markGateDue + takeReminder: idempotent -- one reminder across N edits, last_edit advances", (t) => {
  const root = tmpRoot(t);
  const rel = `${DOCS_ROOT}/specs/foo.md`;
  markGateDue({ root, relFile: rel, phase: "spec", now: T0 });
  assert.equal(takeReminder({ root, relFile: rel }).remind, true);
  markGateDue({ root, relFile: rel, phase: "spec", now: T1 });
  assert.equal(takeReminder({ root, relFile: rel }).remind, false);
  const m = readMarker(markerPathFor(root));
  assert.equal(Object.keys(m).length, 1);
  assert.equal(m[rel].first_seen, T0);
  assert.equal(m[rel].last_edit, T1);
  assert.equal(m[rel].reminded, true);
  // Interface pin: the upsert overwrites phase, preserves first_seen/reminded.
  markGateDue({ root, relFile: rel, phase: "plan", now: T1 });
  const m2 = readMarker(markerPathFor(root))[rel];
  assert.equal(m2.phase, "plan");
  assert.equal(m2.first_seen, T0);
  assert.equal(m2.reminded, true);
});

// clear removes; the next mark re-adds with reminded:false (re-arm).
test("clearGateDue: removes matching (file, phase); re-mark re-arms with reminded:false", (t) => {
  const root = tmpRoot(t);
  const rel = `${DOCS_ROOT}/specs/foo.md`;
  markGateDue({ root, relFile: rel, phase: "spec", now: T0 });
  takeReminder({ root, relFile: rel });
  assert.equal(clearGateDue({ root, relFile: rel, phase: "plan" }).cleared, false); // phase mismatch
  assert.equal(clearGateDue({ root, relFile: rel, phase: "spec" }).cleared, true);
  assert.deepEqual(readMarker(markerPathFor(root)), {});
  markGateDue({ root, relFile: rel, phase: "spec", now: T1 });
  assert.equal(readMarker(markerPathFor(root))[rel].reminded, false); // re-armed
});

test("clearGateDueForGate: clears via autogate-root resolution from a subdir cwd; never throws", (t) => {
  const root = tmpRoot(t);
  const rel = `${DOCS_ROOT}/plans/bar.md`;
  markGateDue({ root, relFile: rel, phase: "plan", now: T0 });
  const subdir = path.join(root, "docs");
  // target_files are CWD-relative (the real gate.mjs readContained resolves them against cwd
  // = subdir), while the mark is keyed relative to the autogate ROOT -- clearGateDueForGate
  // must re-base the target to the root before clearing so the keys agree.
  clearGateDueForGate({ cwd: subdir, phase: "plan", target_files: ["superpowers\\plans\\Bar.md"] });
  assert.deepEqual(readMarker(markerPathFor(root)), {});
  // never throws, even on garbage
  clearGateDueForGate({ cwd: String.raw`C:\does\not\exist`, phase: "plan", target_files: ["x.md"] });
});

test("clearGateDueForGate: standard cwd === root path clears with a root-relative target (no-op re-basing)", (t) => {
  const root = tmpRoot(t);
  const rel = `${DOCS_ROOT}/specs/foo.md`;
  markGateDue({ root, relFile: rel, phase: "spec", now: T0 });
  clearGateDueForGate({ cwd: root, phase: "spec", target_files: ["docs\\superpowers\\specs\\foo.md"] });
  assert.deepEqual(readMarker(markerPathFor(root)), {});
});

test("buildReminderLine: exact advisory line", () => {
  assert.equal(
    buildReminderLine({ relFile: `${DOCS_ROOT}/specs/foo.md`, phase: "spec", pending: 2 }),
    `\u26a0 codex_gate due: ${DOCS_ROOT}/specs/foo.md (spec) -- run before presenting. [2 pending; .superpowers/gate-due.json]`
  );
});

// Synthetic policy table (policy fixture): the beta project is pii:false; the delta and epsilon projects
// are pii:true; anything outside the table resolves pii:true (fail-closed).
const fx = installPolicyFixture({ after });
const REPO = fx.dirOf(BETA);
const PII_REPO = fx.dirOf(DELTA);
const fakeFsWithRoot = (root) => ({
  existsSync: (p) => normalizeRel(p) === normalizeRel(path.join(root, ".codex-autogate")),
  statSync: () => ({ isDirectory: () => true }),
  // Identity realpath: a plain repo dir with no junction resolves to itself under real fs --
  // required now that classify()'s PII guard unconditionally canonicalizes the root.
  realpathSync: (p) => path.resolve(String(p ?? "")),
});

function payloadFor(file, cwd = REPO, tool = "Edit") {
  return { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: file }, cwd };
}

test("classify: specs/*.md -> mark/spec; plans/*.md -> mark/plan", () => {
  const fsv = fakeFsWithRoot(REPO);
  const spec = classify(payloadFor(path.join(REPO, "docs", PLUGIN_DIR, "specs", "foo.md")), {}, fsv);
  assert.deepEqual(spec, { action: "mark", root: REPO, relFile: `${DOCS_ROOT}/specs/foo.md`, phase: "spec" });
  const plan = classify(payloadFor(path.join(REPO, "docs", PLUGIN_DIR, "plans", "bar.md")), {}, fsv);
  assert.equal(plan.action, "mark");
  assert.equal(plan.phase, "plan");
});

test("classify: non-artifact paths skip -- src file, nested subdir, non-md, missing file_path", () => {
  const fsv = fakeFsWithRoot(REPO);
  assert.equal(classify(payloadFor(path.join(REPO, "gate.mjs")), {}, fsv).action, "skip");
  assert.equal(classify(payloadFor(path.join(REPO, "docs", PLUGIN_DIR, "specs", "archive", "old.md")), {}, fsv).action, "skip");
  assert.equal(classify(payloadFor(path.join(REPO, "docs", PLUGIN_DIR, "specs", "notes.txt")), {}, fsv).action, "skip");
  assert.equal(classify({ tool_name: "Edit", tool_input: {}, cwd: REPO }, {}, fsv).action, "skip");
  assert.equal(classify(payloadFor(path.join(REPO, "docs", PLUGIN_DIR, "specs", "foo.md"), REPO, "Bash"), {}, fsv).action, "skip");
});

test("classify: no .codex-autogate root -> skip; CODEX_AUTOGATE=off -> skip", () => {
  const noRoot = { existsSync: () => false, statSync: () => ({ isDirectory: () => true }) };
  const file = path.join(REPO, "docs", PLUGIN_DIR, "specs", "foo.md");
  assert.equal(classify(payloadFor(file), {}, noRoot).reason, "no_autogate_root");
  assert.equal(classify(payloadFor(file), { CODEX_AUTOGATE: "off" }, fakeFsWithRoot(REPO)).reason, "env_off");
});

test("classify: PII skip -- pii file path, pii cwd, unknown file location", () => {
  const piiFile = path.join(PII_REPO, "docs", PLUGIN_DIR, "specs", "notes.md");
  const fsvPii = fakeFsWithRoot(PII_REPO);
  assert.equal(classify(payloadFor(piiFile, PII_REPO), {}, fsvPii).reason, "pii_file");
  // cwd under a KNOWN pii project suppresses even an allowlisted file
  const okFile = path.join(REPO, "docs", PLUGIN_DIR, "specs", "foo.md");
  assert.equal(classify(payloadFor(okFile, fx.dirOf(EPSILON)), {}, fakeFsWithRoot(REPO)).reason, "pii_cwd");
  // UNKNOWN cwd (a folder outside the table) does NOT suppress -- only affirmative PII matches do
  assert.equal(classify(payloadFor(okFile, path.dirname(fx.base)), {}, fakeFsWithRoot(REPO)).action, "mark");
  // unknown file location fails closed even with an autogate root present
  const strayRoot = "C:\\Stray";
  const stray = path.join(strayRoot, "docs", PLUGIN_DIR, "specs", "foo.md");
  assert.equal(classify(payloadFor(stray, strayRoot), {}, fakeFsWithRoot(strayRoot)).reason, "pii_file");
});

test("classify: malformed payload -> skip, no throw", () => {
  assert.equal(classify(null, {}, fakeFsWithRoot(REPO)).action, "skip");
  assert.equal(classify("garbage", {}, fakeFsWithRoot(REPO)).action, "skip");
  assert.equal(classify({ tool_name: "Edit", tool_input: { file_path: 42 }, cwd: REPO }, {}, fakeFsWithRoot(REPO)).action, "skip");
});

// Security: a Windows junction/symlink under
// %TEMP% that points at a real PII repo must be refused. These use an INJECTED
// fsView.realpathSync + policyView to simulate the junction -- no real junctions, no real
// PII repo touched. Fake-path literals are the synthetic policy fixture's folders.
const FAKE_PII = PII_REPO;
const fakeJunctionPolicyView = (p) =>
  normalizeRel(p) === normalizeRel(FAKE_PII)
    ? { name: DELTA.name, pii_sensitive: true }
    : { name: "unknown", pii_sensitive: true };

test("classify: junction bypass to a PII repo is refused (pii_root)", () => {
  // bypassBase is a plain (non-junction) tmp dir; alias is a SUBDIRECTORY of it that is the
  // simulated junction, so it resolves lexically under tmp (bypass activates normally) but its
  // REALPATH is the PII repo (the load-bearing root guard must catch this).
  const bypassBase = path.join(os.tmpdir(), "gate-due-bypass-outer");
  const alias = path.join(bypassBase, "alias");
  const file = path.join(alias, "docs", PLUGIN_DIR, "specs", "foo.md");
  const fsv = {
    existsSync: (p) => normalizeRel(p) === normalizeRel(path.join(alias, ".codex-autogate")),
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => {
      const n = path.resolve(String(p ?? ""));
      return normalizeRel(n) === normalizeRel(alias) ? FAKE_PII : n;
    },
  };
  const env = { CODEX_AUTOGATE_POLICY_BYPASS: bypassBase };
  const decision = classify(payloadFor(file, alias), env, fsv, fakeJunctionPolicyView);
  assert.equal(decision.reason, "pii_root");
  assert.equal(decision.action, "skip");
});

test("classify: bypass whose realpath escapes tmpdir is refused", () => {
  // The bypass value itself IS the junction this time: its realpath escapes tmpdir entirely,
  // so the canonicalized bypass check must refuse it -- a policy-unknown non-bypassed
  // file then fails closed on pii_file (the temp file is NOT marked).
  const alias = path.join(os.tmpdir(), "gate-due-alias-escape");
  const file = path.join(alias, "docs", PLUGIN_DIR, "specs", "foo.md");
  const fsv = {
    existsSync: (p) => normalizeRel(p) === normalizeRel(path.join(alias, ".codex-autogate")),
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => {
      const n = path.resolve(String(p ?? ""));
      return normalizeRel(n) === normalizeRel(alias) ? FAKE_PII : n;
    },
  };
  const env = { CODEX_AUTOGATE_POLICY_BYPASS: alias };
  const decision = classify(payloadFor(file, alias), env, fsv, fakeJunctionPolicyView);
  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "pii_file");
});

test("classify: root realpath throw -> skip(root_unresolvable), fail closed (no mark)", () => {
  // The autogate root is found, but realpath of it throws -> the root guard must fail closed
  // rather than fall through to a mark. Bypass is set so the file-level PII check is skipped,
  // isolating the root_unresolvable branch as the only thing that can stop the mark.
  const root = path.join(os.tmpdir(), "gate-due-root-throw");
  const file = path.join(root, "docs", PLUGIN_DIR, "specs", "foo.md");
  const fsv = {
    existsSync: (p) => normalizeRel(p) === normalizeRel(path.join(root, ".codex-autogate")),
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => {
      const n = path.resolve(String(p ?? ""));
      if (normalizeRel(n) === normalizeRel(root)) throw new Error("ENOENT: root vanished");
      return n; // bypass path + os.tmpdir() resolve identity so the bypass activates
    },
  };
  const env = { CODEX_AUTOGATE_POLICY_BYPASS: os.tmpdir() };
  const decision = classify(payloadFor(file, root), env, fsv, (p) => ({ name: "unknown", pii_sensitive: true }));
  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "root_unresolvable");
});

import { runHook } from "../hooks/gate-due.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Data flow, against a REAL temp repo on disk (no mocks): first edit -> one
// advisory JSON line + marker entry; second edit -> silent; malformed stdin -> silent, no throw.
test("runHook: first edit reminds once via hookSpecificOutput.additionalContext, second is silent", (t) => {
  const root = tmpRoot(t);
  const specDir = path.join(root, "docs", PLUGIN_DIR, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const file = path.join(specDir, "foo.md");
  fs.writeFileSync(file, "# spec\n");
  // NOTE: tmpRoot(t) lives under os.tmpdir(), which is OUTSIDE the policy table -> pii-fail-closed
  // would skip it. Inject a policy view scoped to the temp root for hook-level tests.
  const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, cwd: root });
  const policyView = (p) => ({ name: "temp_repo", pii_sensitive: false });
  const r1 = runHook({ stdinText: payload, env: {}, now: T0, policyView });
  const parsed = JSON.parse(r1.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /codex_gate due: docs\/superpowers\/specs\/foo\.md \(spec\)/);
  const r2 = runHook({ stdinText: payload, env: {}, now: T1, policyView });
  assert.equal(r2.out, null);
  assert.equal(readMarker(markerPathFor(root))[`${DOCS_ROOT}/specs/foo.md`].reminded, true);
});

test("runHook: malformed stdin and unwritable marker -> null out, no throw", (t) => {
  assert.equal(runHook({ stdinText: "{not json", env: {}, now: T0 }).out, null);
  // unwritable marker: .superpowers exists as a FILE, so mkdirSync/writeFileSync throws inside mark
  const root = tmpRoot(t);
  const specDir = path.join(root, "docs", PLUGIN_DIR, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(root, ".superpowers"), "i am a file, not a dir");
  const file = path.join(specDir, "foo.md");
  fs.writeFileSync(file, "# spec\n");
  const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: file }, cwd: root });
  const r = runHook({ stdinText: payload, env: {}, now: T0, policyView: () => ({ name: "temp_repo", pii_sensitive: false }) });
  assert.equal(r.out, null); // write failed -> NO false reminder
});

// The one child-process E2E: the real script, real stdin, real exit code.
test("hook script E2E: node hooks/gate-due.mjs consumes stdin, exits 0, prints the advisory JSON", (t) => {
  const root = tmpRoot(t);
  const specDir = path.join(root, "docs", PLUGIN_DIR, "specs");
  fs.mkdirSync(specDir, { recursive: true });
  const file = path.join(specDir, "foo.md");
  fs.writeFileSync(file, "# spec\n");
  const script = fileURLToPath(new URL("../hooks/gate-due.mjs", import.meta.url));
  const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: file }, cwd: root });
  const r = spawnSync(process.execPath, [script], { input: payload, encoding: "utf8", env: { ...process.env, CODEX_AUTOGATE_POLICY_BYPASS: root } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"additionalContext"/);
  // garbage stdin also exits 0, silent stdout
  const r2 = spawnSync(process.execPath, [script], { input: "garbage", encoding: "utf8" });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.trim(), "");
});

// Top-level, before the server import.
let gateVerdict = { consensus_verdict: "pass", phase: "spec", findings: [], blockers: [] };
await mock.module("../gate.mjs", {
  exports: {
    runGate: async () => gateVerdict,
    revisionLabel: () => "revision: none (no-git project)",
  },
});
const { handleGate } = await import("../server.mjs?gatedue=1");

test("handleGate clears the gate-due marker on a non-error verdict; error verdicts do not clear", async (t) => {
  const root = tmpRoot(t);
  markGateDue({ root, relFile: `${DOCS_ROOT}/specs/foo.md`, phase: "spec", now: T0 });
  markGateDue({ root, relFile: `${DOCS_ROOT}/plans/bar.md`, phase: "plan", now: T0 });

  gateVerdict = { consensus_verdict: "pass", phase: "spec", findings: [], blockers: [] };
  await handleGate({ phase: "spec", cwd: root, target_files: [`${DOCS_ROOT}/specs/foo.md`] });
  let m = readMarker(markerPathFor(root));
  assert.equal(m[`${DOCS_ROOT}/specs/foo.md`], undefined); // cleared
  assert.ok(m[`${DOCS_ROOT}/plans/bar.md`]);               // untouched (different file+phase)

  gateVerdict = { consensus_verdict: "error", status: "blocked", phase: "plan" };
  await handleGate({ phase: "plan", cwd: root, target_files: [`${DOCS_ROOT}/plans/bar.md`] }); // errContent return, no throw
  m = readMarker(markerPathFor(root));
  assert.ok(m[`${DOCS_ROOT}/plans/bar.md`]); // error verdict -> NOT cleared

  // "block" is a NON-error verdict: the gate RAN, so it too clears (a future
  // "clear only on pass" regression must fail here).
  gateVerdict = { consensus_verdict: "block", phase: "plan", findings: [], blockers: [] };
  await handleGate({ phase: "plan", cwd: root, target_files: [`${DOCS_ROOT}/plans/bar.md`] });
  assert.equal(readMarker(markerPathFor(root))[`${DOCS_ROOT}/plans/bar.md`], undefined); // block -> cleared
});

// Second entry point: the cli gate path, driven through the extracted export with
// the EXACT flag shapes cli passes (comma-joined --target string, cwd flag).
test("runGateCommand clears the marker with cli flag shapes; error verdict does not clear", async (t) => {
  const { runGateCommand } = await import("../cli.mjs");
  const root = tmpRoot(t);
  markGateDue({ root, relFile: `${DOCS_ROOT}/specs/foo.md`, phase: "spec", now: T0 });
  const flags = { phase: "spec", cwd: root, target: `${DOCS_ROOT}/specs/foo.md,${DOCS_ROOT}/specs/other.md` };
  const res = await runGateCommand(flags, {
    runGate: async () => ({ consensus_verdict: "block", findings: [] }), // non-error: the gate RAN
    clearGateDueForGate,
  });
  assert.equal(res.consensus_verdict, "block");
  assert.deepEqual(readMarker(markerPathFor(root)), {}); // cleared
  markGateDue({ root, relFile: `${DOCS_ROOT}/specs/foo.md`, phase: "spec", now: T0 });
  await runGateCommand(flags, {
    runGate: async () => ({ consensus_verdict: "error", status: "blocked" }),
    clearGateDueForGate,
  });
  assert.ok(readMarker(markerPathFor(root))[`${DOCS_ROOT}/specs/foo.md`]); // error -> NOT cleared
});
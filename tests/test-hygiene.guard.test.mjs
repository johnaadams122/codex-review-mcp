// tests/test-hygiene.guard.test.mjs -- static guard: every temp folder a test makes goes through
// tests/helpers/test-cleanup.mjs, so it is removed when the test ends, even on failure or timeout.
//
// Why: test files that called mkdtempSync and never removed the folder, or removed it in a
// `finally` / at the end of the body, leave folders behind in the OS temp folder. This is a text scan, so it
// cannot prove absence (a folder can be made in ways no pattern here names); tools/check-test-temp-leaks.mjs
// is the runtime check (it runs test files with TEMP pointed at a private folder and lists what is left).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));   // this file quotes the patterns it bans
const IMPLEMENTATION = "helpers/test-cleanup.mjs";            // the one place allowed to call mkdtemp

// Every .mjs under tests/ (test files, helpers, fixture scripts), as paths relative to tests/ with "/".
function scannedFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.endsWith(".mjs") && r !== SELF && r !== IMPLEMENTATION) out.push(r);
    }
  };
  walk(TESTS, "");
  return out.sort();
}
const read = (rel) => fs.readFileSync(path.join(TESTS, ...rel.split("/")), "utf8");

// Any mkdtemp-family name (mkdtemp, mkdtempSync, mkdtempDisposableSync, ...), called or aliased.
const MKDTEMP = /\bmkdtemp\w*/;
// tmpdir() with or without `os.` and with any spacing; a local helper that takes an argument is not it.
const TMPDIR = /\btmpdir\s*\(\s*\)/g;
// Reading the temp folder straight from the environment.
const TEMP_ENV = /process\.env\s*(\.\s*(TEMP|TMP)\b|\[\s*["'`](TEMP|TMP)["'`]\s*\])/;

// A file that reaches the real review submit path must point its log folder at a private one
// (CODEX_REVIEW_LOG_DIR, see reviewLogDir in review-detach.mjs), or replace jobs.mjs with a mock (which
// covers the jobs/server names, not a direct submitDetachedReview call). Otherwise it writes into, and
// runs the production sweep on, the live server's <OS temp>/codex-mcp-reviews.
const DETACHED_SUBMIT = /\bsubmitDetachedReview\b/;
const JOBS_SUBMIT = /\b(submitReview|submitAdversarialReview|handleReview|handleAdversarialReview)\b/;
const REVIEW_LOG_SEAM = /\bCODEX_REVIEW_LOG_DIR\b/;
const JOBS_MOCKED = /mock\.module\(\s*["'`][^"'`]*\bjobs\.mjs["'`]/;
function leavesReviewLogsLive(text) {
  if (REVIEW_LOG_SEAM.test(text)) return false;
  return DETACHED_SUBMIT.test(text) || (JOBS_SUBMIT.test(text) && !JOBS_MOCKED.test(text));
}

// Files allowed to name mkdtemp, and why. Keep this list short.
const MKDTEMP_EXEMPT = new Map([
  ["test-cleanup.test.mjs", "builds a finally-based CONTROL folder inside a scratch test it runs in a child runner"],
]);

// Every remaining tmpdir() use under tests/, pinned by count. None of them CREATES a folder: each is a
// path that must not exist, an assertion about where production code puts things, an env value, a
// comment, or a production call that removes its own file. A new use fails this test: make the folder
// with tempDirFor, or pin the use (with its reason) here.
const TMPDIR_USES = new Map([
  ["direct.foundation.test.mjs", [1, "a comment on stubbing it so the default CODEX_DIRECT_ROOT is proved off the live folder"]],
  ["direct.meta.test.mjs", [2, "two paths that must not exist (readMeta on a missing dir)"]],
  ["gate.direct.test.mjs", [1, "the real temp folder as a distinct enclosing directory (read only)"]],
  ["hooks.gate-due.test.mjs", [6, "fake bypass/alias/root paths behind an injected fs view, the bypass env value, comments"]],
  ["jobs.ghost.test.mjs", [1, "tmpDir for submitTaskViaFile, which deletes its own prompt file"]],
  ["jobs.same-session.test.mjs", [3, "a comment, the legacy stamp dir that must never be created, and submitTaskViaFile's tmpDir"]],
  ["panel.direct-decode.test.mjs", [1, "an outside target path that must not be read"]],
  ["review-detach.test.mjs", [1, "the production log folder reviewLogDir must return when CODEX_REVIEW_LOG_DIR is unset (read only)"]],
  ["test-cleanup.test.mjs", [1, "asserts where tempDirFor puts its folders"]],
]);

test("the scan covers test files, helpers and fixture scripts", () => {
  const files = scannedFiles();
  assert.ok(files.includes("direct.submit.test.mjs"));
  assert.ok(files.includes("helpers/direct-jobs.mjs"));
  assert.ok(files.includes("fixtures/scripts/fake-codex.mjs"));
  assert.ok(!files.includes(IMPLEMENTATION) && !files.includes(SELF));
});

test("nothing under tests/ names mkdtemp -- temp folders come from tempDirFor", () => {
  const offenders = [];
  for (const rel of scannedFiles()) {
    if (MKDTEMP_EXEMPT.has(rel)) continue;
    read(rel).split(/\r?\n/).forEach((line, i) => { if (MKDTEMP.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(offenders, [], "use tempDirFor(t, prefix) from tests/helpers/test-cleanup.mjs:\n" + offenders.join("\n"));
});

test("nothing under tests/ reads TEMP or TMP from the environment", () => {
  const offenders = [];
  for (const rel of scannedFiles()) {
    read(rel).split(/\r?\n/).forEach((line, i) => { if (TEMP_ENV.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(offenders, []);
});

test("tmpdir() appears under tests/ only where pinned, and never to build a folder", () => {
  const found = {};
  for (const rel of scannedFiles()) {
    const n = (read(rel).match(TMPDIR) ?? []).length;
    if (n > 0) found[rel] = n;
  }
  const expected = Object.fromEntries([...TMPDIR_USES].map(([k, [n]]) => [k, n]));
  assert.deepEqual(found, expected,
    "a new tmpdir() use: make the folder with tempDirFor instead, or pin the use (with its reason) in TMPDIR_USES");
});

test("the patterns catch the spellings they are meant to", () => {
  for (const s of ["fs.mkdtempSync(x)", "mkdtemp(x)", "fs.mkdtempDisposableSync(x)", "const m = fs.mkdtempSync;"]) assert.match(s, MKDTEMP, s);
  for (const s of ["os.tmpdir()", "os.tmpdir ()", "tmpdir()", "os.tmpdir( )"]) assert.equal((s.match(TMPDIR) ?? []).length, 1, s);
  assert.equal(("function tmpdir(t) {}".match(TMPDIR) ?? []).length, 0, "a local helper taking an argument is not tmpdir()");
  for (const s of ["process.env.TEMP", "process.env.TMP", "process.env['TEMP']", 'process.env["TMP"]']) assert.match(s, TEMP_ENV, s);
  assert.doesNotMatch("process.env.TEMPLATE_DIR", TEMP_ENV);
});

test("every tempDirFor prefix is a string literal, so the leftover cleanup script can match it", () => {
  const offenders = [];
  for (const rel of scannedFiles()) {
    if (rel === "test-cleanup.test.mjs") continue;   // exercises the prefix validation with bad prefixes
    for (const m of read(rel).matchAll(/\btempDirFor\(\s*[^,()]+,\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      if (!/^"[A-Za-z0-9][A-Za-z0-9.-]*-"$/.test(arg)) offenders.push(`${rel}: tempDirFor prefix ${arg}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the exemption list names only files that exist and still need it", () => {
  for (const rel of MKDTEMP_EXEMPT.keys()) {
    assert.ok(fs.existsSync(path.join(TESTS, ...rel.split("/"))), rel);
    assert.match(read(rel), MKDTEMP, `${rel} no longer names mkdtemp; drop the exemption`);
  }
});

test("every file that reaches the review submit path points its logs at a private folder", () => {
  const offenders = scannedFiles().filter((rel) => leavesReviewLogsLive(read(rel)));
  assert.deepEqual(offenders, [],
    "set process.env.CODEX_REVIEW_LOG_DIR to a tempDirFor folder (see tests/server.test.mjs), or mock ../jobs.mjs");
});

test("the review-log check flags what it is meant to", () => {
  assert.equal(leavesReviewLogsLive("await submitReview({ cwd });"), true);
  assert.equal(leavesReviewLogsLive("await handleAdversarialReview({});"), true);
  assert.equal(leavesReviewLogsLive("process.env.CODEX_REVIEW_LOG_DIR = d;\nawait submitReview({});"), false);
  assert.equal(leavesReviewLogsLive('await mock.module("../jobs.mjs", {});\nawait handleReview({});'), false);
  assert.equal(leavesReviewLogsLive('await mock.module("../jobs.mjs", {});\nawait submitDetachedReview({});'), true,
    "a jobs.mjs mock does not cover a direct review-detach.mjs call");
  assert.equal(leavesReviewLogsLive("submitReviewer: async () => ({ job_id: 1 })"), false, "a different name");
});

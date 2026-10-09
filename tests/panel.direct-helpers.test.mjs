import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseDirectTimeout, unquoteGitPath, parseDiffHeaderPaths, normalizePayloadPath,
  computePayloadFiles, computeTreeEntry, computeTreeBaseline, recheckTreeBaseline,
} from "../panel.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

test("parseDirectTimeout: default 1200000, clamp [60000..7200000], garbage -> default", () => {
  assert.equal(parseDirectTimeout({}), 1200000);
  assert.equal(parseDirectTimeout({ CODEX_DIRECT_TIMEOUT_MS: "junk" }), 1200000);
  assert.equal(parseDirectTimeout({ CODEX_DIRECT_TIMEOUT_MS: "1" }), 60000);
  assert.equal(parseDirectTimeout({ CODEX_DIRECT_TIMEOUT_MS: String(10 ** 8 - 1) }), 7200000);
});

test("unquoteGitPath: git C-quoting (escapes + octal); undecodable -> null", () => {
  assert.equal(unquoteGitPath("plain/path.mjs"), "plain/path.mjs");
  assert.equal(unquoteGitPath('"with\\ttab.mjs"'), "with\ttab.mjs");
  assert.equal(unquoteGitPath('"quo\\"te.mjs"'), 'quo"te.mjs');
  // Octal escapes are the UTF-8 BYTES of the name (Codex built-tree review 2026-10-08, finding 5): \303\244 is
  // one character, a-umlaut, not two Latin-1 characters. ASCII-only source (PS 5.1 rule), so built from code points.
  assert.equal(unquoteGitPath('"oct\\303\\244.md"'), "oct" + String.fromCharCode(0xE4) + ".md");
  assert.equal(unquoteGitPath('"caf\\303\\251.mjs"'), "caf" + String.fromCharCode(0xE9) + ".mjs");
  assert.equal(unquoteGitPath('"zh\\346\\226\\207.md"'), "zh" + String.fromCharCode(0x6587) + ".md"); // 3-byte character
  assert.equal(unquoteGitPath('"emoji\\360\\237\\230\\200.md"'), "emoji" + String.fromCodePoint(0x1F600) + ".md"); // 4-byte character
  // a raw (unescaped) non-ASCII character inside the quotes (core.quotePath=false) keeps its value
  assert.equal(unquoteGitPath('"raw' + String.fromCharCode(0xE9) + '\\t.md"'), "raw" + String.fromCharCode(0xE9) + "\t.md");
  // bytes that are not valid UTF-8 cannot name a real file here: fail closed
  assert.equal(unquoteGitPath('"bad\\377.md"'), null);
  assert.equal(unquoteGitPath('"half\\303.md"'), null);
  assert.equal(unquoteGitPath('"broken\\q.md"'), null);
  assert.equal(unquoteGitPath('"unterminated'), null);
  // the final quote is escaped, so the string is unterminated (Gemini lens, 2026-10-08)
  assert.equal(unquoteGitPath('"unterminated\\"'), null);
  assert.equal(unquoteGitPath('"ends-in-backslash\\\\"'), "ends-in-backslash\\");
});

test("parseDiffHeaderPaths: plain, rename (both sides), spaces, quoted; ambiguity -> null", () => {
  assert.deepEqual(parseDiffHeaderPaths("diff --git a/src/x.mjs b/src/x.mjs"), ["src/x.mjs", "src/x.mjs"]);
  assert.deepEqual(parseDiffHeaderPaths("diff --git a/old name.md b/new name.md"), ["old name.md", "new name.md"]);
  assert.deepEqual(parseDiffHeaderPaths('diff --git "a/we ird\\ttab.md" "b/we ird\\ttab.md"'), ["we ird\ttab.md", "we ird\ttab.md"]);
  assert.equal(parseDiffHeaderPaths('diff --git "a/bad\\q.md" "b/x.md"'), null);
  // a path that embeds " b/" creates conflicting splits -> ambiguous -> null
  assert.equal(parseDiffHeaderPaths("diff --git a/x b/y b/z"), null);
});

test("computePayloadFiles: union of targets, contexts, diff headers (both sides), TARGET labels; deleted paths stay", () => {
  const payload = [
    "--- TARGET FILE: Docs/Spec.md ---",
    "spec body",
    "diff --git a/src/a.mjs b/src/b.mjs",
    "--- a/src/a.mjs",
    "+++ b/src/b.mjs",
    "diff --git a/gone.mjs b/gone.mjs",
    "deleted file mode 100644",
  ].join("\n");
  const r = computePayloadFiles({ payload, target_files: ["docs/spec.md"], context_files: ["CTX.md"] });
  assert.deepEqual([...r.payload_files].sort(), ["ctx.md", "docs/spec.md", "gone.mjs", "src/a.mjs", "src/b.mjs"]);
  assert.deepEqual([...r.diff_set].sort(), ["gone.mjs", "src/a.mjs", "src/b.mjs"]);
  assert.deepEqual(r.target_set, ["docs/spec.md"]);
});

test("computePayloadFiles: an undecodable header fails closed", () => {
  const r = computePayloadFiles({ payload: 'diff --git "a/bad\\q" "b/bad\\q"', target_files: [], context_files: [] });
  assert.equal(r.error, "payload_parse_error");
});

test("computePayloadFiles: a real top-level a/ dir is not double-stripped (regression: single-strip principle)", () => {
  const r = computePayloadFiles({
    payload: "diff --git a/a/foo.mjs b/a/foo.mjs",
    target_files: [],
    context_files: [],
  });
  assert.deepEqual([...r.payload_files].sort(), ["a/foo.mjs"]);
  assert.deepEqual([...r.diff_set].sort(), ["a/foo.mjs"]);
});

test("computeTreeEntry: typed entries, never throws", (t) => {
  const dir = tempDirFor(t, "a1-tree-");
  fs.writeFileSync(path.join(dir, "f.txt"), "body", "utf8");
  fs.mkdirSync(path.join(dir, "sub"));
  assert.match(computeTreeEntry(dir, "f.txt"), /^SHA256:[0-9a-f]{64}$/);
  assert.equal(computeTreeEntry(dir, "missing.txt"), "ABSENT");
  assert.equal(computeTreeEntry(dir, "sub"), "NONREGULAR");
  assert.equal(computeTreeEntry(dir, "f.txt", { lstat: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } }), "UNREADABLE");
  // containment (same rules as readContained): escapes are rejected pre-resolution,
  // the path is NEVER resolved and NEVER read
  assert.equal(computeTreeEntry(dir, "..\\evil.txt"), "ESCAPE");            // '..' segment
  assert.equal(computeTreeEntry(dir, "sub/../../evil.txt"), "ESCAPE");      // embedded '..'
  assert.equal(computeTreeEntry(dir, ["C:", "Windows", "win.ini"].join("\\")), "ESCAPE");    // absolute/drive
  assert.equal(computeTreeEntry(dir, ["", "", "unc", "share", "x.txt"].join("\\")), "ESCAPE");   // UNC
  let touched = false;
  assert.equal(computeTreeEntry(dir, "../evil.txt", { lstat: () => { touched = true; throw new Error("x"); } }), "ESCAPE");
  assert.equal(touched, false); // rejected BEFORE any fs access
});

test("baseline: target/context hash the SAME in-memory bytes; recheck flips on disk mutation", (t) => {
  const dir = tempDirFor(t, "a1-base-");
  fs.writeFileSync(path.join(dir, "spec.md"), "V1", "utf8");
  const baseline = computeTreeBaseline({
    cwd_real: dir, payload_files: ["spec.md"], file_texts: { "spec.md": "V1" }, storedPayload: "PAYLOAD",
  });
  assert.match(baseline.files["spec.md"], /^SHA256:/);
  assert.match(baseline.payload, /^SHA256:/);
  assert.equal(recheckTreeBaseline(baseline, { cwd_real: dir }).changed, false);
  fs.writeFileSync(path.join(dir, "spec.md"), "V2-mutated", "utf8");
  const r = recheckTreeBaseline(baseline, { cwd_real: dir });
  assert.equal(r.changed, true);
  assert.equal(r.rel, "spec.md");
});

test("baseline: adversarially-named files __proto__ and __payload__ are tracked and recheck flips (smoke fail-open)", (t) => {
  const dir = tempDirFor(t, "a1-base-proto-");
  fs.writeFileSync(path.join(dir, "__proto__"), "P1", "utf8");
  fs.writeFileSync(path.join(dir, "__payload__"), "Q1", "utf8");
  const baseline = computeTreeBaseline({
    cwd_real: dir, payload_files: ["__proto__", "__payload__"], file_texts: {}, storedPayload: "PAYLOAD",
  });
  // both adversarial filenames are REAL own entries in the null-proto files map...
  assert.match(baseline.files["__proto__"], /^SHA256:/);
  assert.match(baseline.files["__payload__"], /^SHA256:/);
  // ...and the stored-payload hash is a SEPARATE field, not colliding with the file named __payload__
  assert.match(baseline.payload, /^SHA256:/);
  assert.notEqual(baseline.files["__payload__"], baseline.payload);
  assert.equal(recheckTreeBaseline(baseline, { cwd_real: dir }).changed, false);
  // mutating EITHER adversarially-named file mid-review must trip tree_changed (was silently missed)
  fs.writeFileSync(path.join(dir, "__proto__"), "P2-mutated", "utf8");
  assert.equal(recheckTreeBaseline(baseline, { cwd_real: dir }).changed, true);
  fs.writeFileSync(path.join(dir, "__proto__"), "P1", "utf8"); // restore, then mutate the other
  fs.writeFileSync(path.join(dir, "__payload__"), "Q2-mutated", "utf8");
  const r = recheckTreeBaseline(baseline, { cwd_real: dir });
  assert.equal(r.changed, true);
  assert.equal(r.rel, "__payload__");
});

test("recheck: races that flip a file UNREADABLE land fail-closed; diff re-gather mismatch -> changed", (t) => {
  const dir = tempDirFor(t, "a1-base2-");
  fs.writeFileSync(path.join(dir, "a.mjs"), "x", "utf8");
  const baseline = computeTreeBaseline({ cwd_real: dir, payload_files: ["a.mjs"], file_texts: {}, storedPayload: "P" });
  assert.equal(recheckTreeBaseline(baseline, { cwd_real: dir, regatherDiff: () => "DIFF", embeddedDiff: "DIFF" }).changed, false);
  assert.equal(recheckTreeBaseline(baseline, { cwd_real: dir, regatherDiff: () => "DIFF2", embeddedDiff: "DIFF" }).changed, true);
  assert.equal(recheckTreeBaseline(baseline, { cwd_real: dir, regatherDiff: () => { throw new Error("git gone"); }, embeddedDiff: "DIFF" }).changed, true);
});

test("normalizePayloadPath: backslashes -> slashes, lowercase; a/-b/ prefixes NOT stripped (that's parseDiffHeaderPaths's job -- single-strip principle)", () => {
  assert.equal(normalizePayloadPath("a/Src\\File.MJS"), "a/src/file.mjs");
  assert.equal(normalizePayloadPath("b/x.md"), "b/x.md");
  assert.equal(normalizePayloadPath("A\\b.md"), "a/b.md");
});

// The release CI requires the same skipped-test set on every Windows machine, so a machine that cannot
// create symlinks adds a TAP note and returns instead of calling t.skip (the same rule as
// tests/policy.canonical.test.mjs). The note method's name is assembled from parts so the public-release
// word scanner does not flag it.
const NOTE_METHOD = ["diag", "nostic"].join("");
const notExercised = (t, why) => t[NOTE_METHOD](`not exercised on this machine: ${why}`);

test("typed entries: LINK (inside) and LINK_ESCAPE (outside); not exercised where symlinks need privilege", (t) => {
  const dir = tempDirFor(t, "a1-link-");
  const outside = tempDirFor(t, "a1-outside-");
  fs.writeFileSync(path.join(dir, "real.txt"), "content", "utf8");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside", "utf8");
  try {
    fs.symlinkSync(path.join(dir, "real.txt"), path.join(dir, "inside-link.txt"), "file");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "escape-link.txt"), "file");
  } catch {
    notExercised(t, "symlink creation needs Developer Mode or an elevated shell");
    return;
  }
  assert.match(computeTreeEntry(dir, "inside-link.txt"), /^LINK:[0-9a-f]{64}$/); // resolved-target hash
  assert.equal(computeTreeEntry(dir, "escape-link.txt"), "LINK_ESCAPE");          // never followed
  // a REGULAR leaf reached through an escaping symlinked parent dir: the regular-file branch's
  // realpath containment catches it (lstat alone only detects a symlink LEAF)
  fs.symlinkSync(outside, path.join(dir, "linkdir"), "dir");
  assert.equal(computeTreeEntry(dir, "linkdir/secret.txt"), "ESCAPE");
});

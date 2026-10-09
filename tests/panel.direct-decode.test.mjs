import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeReviewerResult, decodeDirectReviewerResult, validateFilesChecked,
  corroborateEntries, passEvidenceSatisfied, buildDirectLensPrompt, LENSES,
} from "../panel.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function repo(t, files) {
  const dir = tempDirFor(t, "a1-decode-");
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, "utf8");
  }
  return fs.realpathSync(dir);
}
const id = (x) => x;
const V = (extra) => JSON.stringify({ lens: "correctness", verdict: "pass", confidence: "high", findings: [], ...extra });

test("companion decode still rejects unknown keys (byte-identical default)", () => {
  const r = decodeReviewerResult(V({ files_checked: ["x"] }), id);
  assert.equal(r.ok, false); // files_checked is unknown to the COMPANION key set
});

test("validateFilesChecked: full violation matrix", (t) => {
  const cwd = repo(t, { "src/a.mjs": "x", "docs/spec.md": "y" });
  const ok = validateFilesChecked(["src/a.mjs", "docs\\spec.md"], { cwd_real: cwd });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.entries, ["src/a.mjs", "docs/spec.md"]);
  for (const bad of [
    "not-an-array",
    [42],
    [""], ["."],
    [["C:", "abs", "x.mjs"].join("\\")], ["/abs.mjs"], [["", "", "unc", "share"].join("\\")],
    ["../escape.mjs"], ["src/../../etc"],
    ["src/a.mjs", "SRC/A.MJS"],          // case-insensitive duplicate
    ["missing.mjs"],                      // does not resolve
    ["src"],                              // directory, not a regular file
  ]) {
    assert.equal(validateFilesChecked(bad, { cwd_real: cwd }).ok, false, JSON.stringify(bad));
  }
});

test("validateFilesChecked: entry whose realpath resolves OUTSIDE cwd_real is rejected (symlink escape, deps-injected)", (t) => {
  // Deps-injected so it NEVER skips: the fake realpath passes cwd_real through unchanged and
  // maps only the entry, simulating a symlink resolving outside the repo. The realpath seam is
  // already how the helper observes symlinks; the fake stat is unreachable (containment rejects
  // first) and present only to keep the test hermetic.
  const cwd = repo(t, { "src/a.mjs": "x" });
  const outside = path.join(os.tmpdir(), "a1-outside-target", "secret.mjs");
  const deps = {
    realpath: (p) => (String(p).replace(/\\/g, "/").endsWith("/link.mjs") ? outside : fs.realpathSync(p)),
    stat: () => ({ isFile: () => true }),
  };
  assert.equal(validateFilesChecked(["link.mjs"], { cwd_real: cwd }, deps).ok, false);
});

test("corroboration: full path substring; basename only when unique; collision needs full path", () => {
  const events = [
    { command: `powershell Get-Content "${["C:", "repo", "src", "a.mjs"].join("\\")}"`, aggregated_output: "" },
    { command: "type config.json", aggregated_output: "" },
  ];
  // unique basename a.mjs -> corroborated via basename; context/config.json collides with
  // target/config.json -> basename match is NOT enough
  const entries = ["src/a.mjs", "target/config.json"];
  const payload_files = ["src/a.mjs", "context/config.json", "target/config.json"];
  const got = corroborateEntries(entries, events, payload_files);
  assert.deepEqual(got, ["src/a.mjs"]);
  // full-path mention corroborates despite the collision
  const events2 = [...events, { command: "type target/config.json", aggregated_output: "" }];
  assert.deepEqual(corroborateEntries(entries, events2, payload_files), ["src/a.mjs", "target/config.json"]);
});

test("corroboration boundary tighten : an infix of a LONGER file name never corroborates", () => {
  // "beta.mjs" must not corroborate the unique-basename entry "a.mjs"; "a.mjs2"/"xa.mjs" likewise.
  const entries = ["src/a.mjs"];
  const payload_files = ["src/a.mjs"];
  const miss = (cmd) => corroborateEntries(entries, [{ command: cmd, aggregated_output: "" }], payload_files);
  assert.deepEqual(miss("type beta.mjs"), []);
  assert.deepEqual(miss("type a.mjs2"), []);
  assert.deepEqual(miss("type data.mjs"), []);
  // uppercase boundary chars are filename-run too (defensive: production haystacks/entries are
  // both lowercased, but the export must not trap a future non-lowercased caller)
  assert.deepEqual(miss("type Xa.mjs"), []);
  assert.deepEqual(miss("type a.mjsX"), []);
  // legitimate mentions still corroborate: separators, quotes, colons, line starts
  assert.deepEqual(miss("Get-Content src/a.mjs"), ["src/a.mjs"]);
  assert.deepEqual(miss("checked 'a.mjs': ok"), ["src/a.mjs"]);
  assert.deepEqual(miss("a.mjs"), ["src/a.mjs"]);
});

test("pass-evidence: document kind needs corroborated TARGET + (outside entry OR note)", () => {
  const base = {
    verdict: "pass", evidence_kind: "document",
    payload_files: ["docs/spec.md", "ctx.md"], target_set: ["docs/spec.md"], diff_set: [],
    files_checked: ["docs/spec.md"], deletionWaiver: false,
  };
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: ["docs/spec.md"], note: "" }), false);            // no outside, no note
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: ["docs/spec.md"], note: "greenfield spec" }), true);
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: ["docs/spec.md", "src/x.mjs"], note: "" }), true); // read-around evidence
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: ["ctx.md"], note: "n" }), false);                  // context does NOT satisfy target rule
  assert.equal(passEvidenceSatisfied({ ...base, verdict: "block", corroborated: [], files_checked: [], note: "cannot read" }), true); // blocks never need corroboration
  assert.equal(passEvidenceSatisfied({ ...base, verdict: "block", corroborated: [], files_checked: [], note: "" }), false);           // empty-list block REQUIRES a non-empty note
  assert.equal(passEvidenceSatisfied({ ...base, verdict: "block", corroborated: [], files_checked: ["docs/spec.md"], note: "" }), true); // non-empty files_checked: no note needed
});

test("pass-evidence: diff kind needs a corroborated diff-named entry; deletion waiver", () => {
  const base = {
    verdict: "pass", evidence_kind: "diff",
    payload_files: ["src/a.mjs"], target_set: [], diff_set: ["src/a.mjs"],
  };
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: ["src/a.mjs"], files_checked: ["src/a.mjs"], note: "", deletionWaiver: false }), true);
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: [], files_checked: ["src/a.mjs"], note: "", deletionWaiver: false }), false);
  // pure deletion (all diff_set files gone): corroborated entries OR empty files_checked + note
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: [], files_checked: [], note: "all files deleted", deletionWaiver: true }), true);
  assert.equal(passEvidenceSatisfied({ ...base, corroborated: [], files_checked: [], note: "  ", deletionWaiver: true }), false);
});

test("deletion waiver rides diff_set: deleted diff files waive even when a CONTEXT file still exists", (t) => {
  const cwd = repo(t, { "ctx.md": "context body" }); // ctx.md exists; gone.mjs (the diff file) does not
  const ctx = {
    extractAnswerText: id, cwd_real: cwd, events: [],
    payload_files: ["ctx.md", "gone.mjs"], target_set: [], diff_set: ["gone.mjs"], evidence_kind: "diff",
  };
  const r = decodeDirectReviewerResult(V({ files_checked: [], files_checked_note: "all diff files deleted" }), ctx);
  assert.equal(r.ok, true);
  // and a DOCUMENT-kind run never triggers the waiver (its target always exists at assembly)
  const doc = { ...ctx, evidence_kind: "document", diff_set: [], target_set: ["ctx.md"] };
  const r2 = decodeDirectReviewerResult(V({ files_checked: [], files_checked_note: "n/a" }), doc);
  assert.equal(r2.ok, false); // document pass still requires corroborated target evidence
});

test("decodeDirectReviewerResult: end-to-end pass, and violations -> parse_failed", (t) => {
  const cwd = repo(t, { "src/a.mjs": "x" });
  const ctx = {
    extractAnswerText: id, cwd_real: cwd,
    events: [{ command: "Get-Content src/a.mjs", aggregated_output: "" }],
    payload_files: ["src/a.mjs"], target_set: [], diff_set: ["src/a.mjs"], evidence_kind: "diff",
  };
  const good = decodeDirectReviewerResult(V({ files_checked: ["src/a.mjs"] }), ctx);
  assert.equal(good.ok, true);
  assert.deepEqual(good.verdict.files_checked, ["src/a.mjs"]);
  // files_checked missing entirely -> parse_failed (REQUIRED for direct runs)
  assert.equal(decodeDirectReviewerResult(V({}), ctx).ok, false);
  // whitespace-only note is the only rejected note shape
  assert.equal(decodeDirectReviewerResult(V({ files_checked: ["src/a.mjs"], files_checked_note: "   " }), ctx).ok, false);
  // block + empty files_checked + absent note -> parse_failed; with a note -> ok
  assert.equal(decodeDirectReviewerResult(V({ verdict: "block", files_checked: [] }), ctx).ok, false);
  assert.equal(decodeDirectReviewerResult(V({ verdict: "block", files_checked: [], files_checked_note: "cannot read the repo" }), ctx).ok, true);
  // uncorroborated pass -> parse_failed
  const ctx2 = { ...ctx, events: [] };
  assert.equal(decodeDirectReviewerResult(V({ files_checked: ["src/a.mjs"] }), ctx2).ok, false);
});

test("buildDirectLensPrompt: read-scope rules, files_checked instruction, revision label", () => {
  const p = buildDirectLensPrompt(LENSES[0], "PAYLOAD", { truncated: false, revision: "revision: abc123" });
  assert.ok(p.includes("files_checked"));
  assert.ok(p.includes("revision: abc123"));
  assert.ok(p.toLowerCase().includes("read-only")); // the prompt text is "READ-ONLY" (uppercase); .includes is case-sensitive, so compare case-insensitively
  assert.ok(p.includes("Read PURPOSEFULLY")); // purposeful claim-verification reads, no exploratory browsing
  assert.ok(p.includes("--- BEGIN PAYLOAD ---"));
});

test("an untracked entry never enables the deletion waiver, even when it reads as missing (a dangling link)", (t) => {
  const cwd = repo(t, {}); // neither file exists on disk
  const waiverNote = V({ files_checked: [], files_checked_note: "all files deleted" });
  const untrackedOnly = {
    extractAnswerText: id, cwd_real: cwd, events: [],
    payload_files: ["dangling.lnk"], target_set: [], diff_set: [], untracked_set: ["dangling.lnk"], evidence_kind: "diff",
  };
  assert.equal(decodeDirectReviewerResult(waiverNote, untrackedOnly).ok, false);
  const deletedPlusUntracked = { ...untrackedOnly, payload_files: ["gone.mjs", "dangling.lnk"], diff_set: ["gone.mjs"] };
  assert.equal(decodeDirectReviewerResult(waiverNote, deletedPlusUntracked).ok, false);
  // control: the same deleted diff file with no untracked entry still waives
  assert.equal(decodeDirectReviewerResult(waiverNote, { ...deletedPlusUntracked, payload_files: ["gone.mjs"], untracked_set: [] }).ok, true);
});

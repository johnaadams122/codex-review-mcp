// Codex review of 0c4a967 (2026-10-08): plain `git ls-files` C-quotes a non-ASCII name ("caf\303\251.mjs"),
// so the untracked-file fold read a name that matches no file ("<unreadable>") and the detached gate's
// untracked scan dropped the file. Untracked names must come from `git ls-files -z`, which never quotes.
// The fake git below answers exactly as real git does (checked by hand against git 2.54): quoted lines
// without -z, raw NUL-separated names with -z.
import { test } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { gatherDiff, listUntrackedFiles, parseGitPathList } from "../panel.mjs";
import { scanUntrackedContained } from "../hooks/gate-run.mjs";

const CAFE = "caf" + String.fromCharCode(0xE9) + ".mjs"; // ASCII-only source (PS 5.1 rule)
const QUOTED = '"caf\\303\\251.mjs"';

function fakeGit(seen = []) {
  return (args) => {
    seen.push(args);
    if (args[0] !== "ls-files") return "";
    return args.includes("-z") ? `${CAFE}\0plain.txt\0` : `${QUOTED}\nplain.txt\n`;
  };
}

test("gatherDiff folds a non-ASCII untracked file under its real name and reads it", () => {
  const reads = [];
  const g = gatherDiff({ cwd: "C:\\repo", scope: "working-tree" }, fakeGit(), (p) => { reads.push(p); return "body of " + path.basename(p); });
  assert.deepEqual(reads, [path.join("C:\\repo", CAFE), path.join("C:\\repo", "plain.txt")]);
  assert.ok(g.diff.includes(`--- NEW UNTRACKED FILE: ${CAFE} ---\nbody of ${CAFE}`));
  assert.doesNotMatch(g.diff, /<unreadable>/);
});

test("the detached gate's untracked scan sees the non-ASCII file under its real name", () => {
  const asked = [];
  const kept = scanUntrackedContained("C:\\repo", {
    runGit: fakeGit(),
    computeTreeEntry: (cwd, rel) => { asked.push(rel); return "SHA256:x"; },
  });
  assert.deepEqual(asked, [CAFE, "plain.txt"]);
  assert.deepEqual(kept.map((k) => k.rel), [CAFE, "plain.txt"]);
});

test("listUntrackedFiles asks git for -z output", () => {
  const seen = [];
  assert.deepEqual(listUntrackedFiles("C:\\repo", fakeGit(seen)), [CAFE, "plain.txt"]);
  assert.ok(seen.some((a) => a[0] === "ls-files" && a.includes("-z")));
});

test("parseGitPathList: NUL lists split exactly; newline lists are unquoted; undecodable stays as given", () => {
  assert.deepEqual(parseGitPathList(`a b.txt\0${CAFE}\0`), ["a b.txt", CAFE]);
  assert.deepEqual(parseGitPathList(`${QUOTED}\r\nplain.txt\n`), [CAFE, "plain.txt"]);
  assert.deepEqual(parseGitPathList('"bad\\377.md"\n'), ['"bad\\377.md"']);
  assert.deepEqual(parseGitPathList(""), []);
});

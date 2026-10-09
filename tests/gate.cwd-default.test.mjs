// Codex built-tree review 2026-10-08, finding 3: cwd is optional on codex_gate (server.mjs), and the
// admission check already falls back to this process's folder when it is omitted. The file reads and the
// untracked-file fold must fall back to the SAME folder, or an omitted cwd authorizes one folder and then
// reads nothing (no_reviewable_target) or folds "<unreadable>" for real untracked files.
import { test } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runGate } from "../gate.mjs";
import { gatherDiff } from "../panel.mjs";
import { tempDirFor, onCleanup } from "./helpers/test-cleanup.mjs";

function inTempFolder(t) {
  const dir = tempDirFor(t, "gate-cwd-default-", { realpath: true });
  const before = process.cwd();
  process.chdir(dir);
  onCleanup(t, () => process.chdir(before));
  return dir;
}

test("spec gate with cwd omitted reads its target from this process's folder", async (t) => {
  const dir = inTempFolder(t);
  fs.writeFileSync(path.join(dir, "README.md"), "Synthetic spec text for the default-cwd check.\n");
  let seen = null;
  const res = await runGate(
    { phase: "spec", target_files: ["README.md"] },
    {
      admit: () => ({ allowed: true, project: "project_beta" }),
      runPanel: async (opts, panelDeps) => {
        seen = { opts, payload: panelDeps.gatherDiff().diff };
        return {
          consensus_verdict: "pass", reviewers: [], findings: [],
          strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true },
        };
      },
    },
  );
  assert.notEqual(res.status, "no_reviewable_target", res.reason);
  assert.ok(seen, "the panel was reached");
  assert.equal(seen.opts.cwd, dir);
  assert.match(seen.payload, /Synthetic spec text for the default-cwd check/);
});

test("gatherDiff with cwd omitted folds untracked files from this process's folder", (t) => {
  const dir = inTempFolder(t);
  const reads = [];
  const runGit = (args) => (args[0] === "ls-files" ? "new-file.txt\n" : "");
  const readFile = (p) => { reads.push(p); return "synthetic untracked content"; };
  const g = gatherDiff({ scope: "working-tree" }, runGit, readFile);
  assert.deepEqual(reads, [path.join(dir, "new-file.txt")]);
  assert.match(g.diff, /synthetic untracked content/);
  assert.doesNotMatch(g.diff, /<unreadable>/);
});

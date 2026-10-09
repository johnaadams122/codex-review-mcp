import { test } from "node:test";
import assert from "node:assert/strict";
import { computePayloadFiles, passEvidenceSatisfied } from "../panel.mjs";

test("payload_files captures NEW UNTRACKED FILE and CONTEXT FILE labels (gap C)", () => {
  const payload = [
    "diff --git a/src/x.js b/src/x.js",
    "--- CONTEXT FILE: docs/notes.md ---",
    "note body",
    "--- NEW UNTRACKED FILE: src/untracked.js ---",
    "console.log(1)",
  ].join("\n");
  const r = computePayloadFiles({ payload });
  assert.ok(r.payload_files.includes("src/x.js"));
  assert.ok(r.payload_files.includes("docs/notes.md"));
  assert.ok(r.payload_files.includes("src/untracked.js"));
});

test("existing diff --git + TARGET FILE parsing is unchanged", () => {
  const payload = "diff --git a/a.js b/a.js\n--- TARGET FILE: b.md ---\nx";
  const r = computePayloadFiles({ payload });
  assert.ok(r.payload_files.includes("a.js"));
  assert.ok(r.payload_files.includes("b.md"));
});

test("an untracked file is a changed file of its own kind, so a review of an untracked-only change can pass", () => {
  const payload = ["--- NEW UNTRACKED FILE: src/new.js ---", "console.log(1)"].join(String.fromCharCode(10));
  const r = computePayloadFiles({ payload });
  assert.deepEqual(r.untracked_set, ["src/new.js"]);
  assert.deepEqual(r.diff_set, []); // diff_set keeps diff-header provenance only (the deletion waiver reads it)
  const args = {
    verdict: "pass", evidence_kind: "diff", corroborated: ["src/new.js"], payload_files: r.payload_files,
    target_set: r.target_set, diff_set: r.diff_set, files_checked: ["src/new.js"], note: undefined, deletionWaiver: false,
  };
  assert.equal(passEvidenceSatisfied({ ...args, untracked_set: r.untracked_set }), true);
  assert.equal(passEvidenceSatisfied(args), false); // without the untracked set nothing corroborates it
});

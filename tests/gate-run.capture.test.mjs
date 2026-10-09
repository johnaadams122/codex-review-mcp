import { test } from "node:test";
import assert from "node:assert/strict";
import { scanUntrackedContained, capturePayload } from "../hooks/gate-run.mjs";

test("scanUntrackedContained drops an escaping symlink, keeps a contained file", () => {
  const files = { "ok.js": "SHA256:abc", "eviljunction/leak": "LINK_ESCAPE", "gone": "ABSENT" };
  const listUntracked = () => ["ok.js", "eviljunction/leak", "gone"];
  const computeTreeEntry = (_cwd, rel) => files[rel];
  const kept = scanUntrackedContained("/repo", { listUntracked, computeTreeEntry });
  const names = kept.map((k) => k.rel);
  assert.deepEqual(names, ["ok.js"]);           // escaping + absent dropped
});

test("scanUntrackedContained FAILS CLOSED when the containment classifier is missing but untracked paths exist", () => {
  // The security branch: if `computeTreeEntry` (the realpath-inside-root classifier) is absent yet there
  // ARE untracked paths, we must THROW rather than silently include unclassified paths. Guards the
  // containment guard so a future edit can't reopen the containment hole.
  assert.throws(() => scanUntrackedContained("/repo", { listUntracked: () => ["x"] }));
  // ...but an EMPTY untracked list with no classifier is safe (nothing to classify) -> [].
  assert.deepEqual(scanUntrackedContained("/repo", { listUntracked: () => [] }), []);
});

test("capturePayload pins a commit SHA and computes a stable diffId", () => {
  const runGit = (args) => args[0] === "diff" ? "DIFFBYTES" : "";
  const r1 = capturePayload({ cwd_real: "/repo", target: { kind: "commit", sha: "abc" } }, "R1", { runGit, writeFile: () => {}, mkdir: () => {} });
  const r2 = capturePayload({ cwd_real: "/repo", target: { kind: "commit", sha: "abc" } }, "R1", { runGit, writeFile: () => {}, mkdir: () => {} });
  assert.equal(r1.payloadRef.kind, "commit");
  assert.equal(r1.diffId, r2.diffId);           // deterministic bind to reviewed bytes
});

test("capturePayload for a worktree writes payload.patch and refs it", () => {
  let written = null;
  const runGit = () => "WT-DIFF";
  const r = capturePayload(
    { cwd_real: "/repo", target: { kind: "worktree" } }, "R7",
    { runGit, listUntracked: () => [], mkdir: () => {}, writeFile: (p, data) => { written = { p, data }; } });
  assert.equal(r.payloadRef.kind, "patch");
  assert.match(r.payloadRef.path, /R7[\\/]payload\.patch$/);
  assert.ok(written.data.includes("WT-DIFF"));
});

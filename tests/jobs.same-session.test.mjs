// The FULLY UN-MOCKED
// submit-then-poll proof that the same-session + owner two-path gate keeps the
// shipping flow working -- WITHOUT any credential on disk.
//
// An on-disk session-token sidecar would be forgeable (a same-user process could
// write a stamp binding a known jobId to its own token and pass the gate), so there
// is no sidecar at all: for stdio MCP, same-session == same-process, so "this session
// submitted the job" is simply "this jobId is in the IN-PROCESS set this process
// submitted". A different server process is a fresh module graph with an empty set.
//
// This file mocks NOTHING in the ownership/read path:
//   - submitTaskViaFile (the EXACT function the panel/reviewers fan-out submits with),
//     waitForResult, getStatus and getResult all run for real;
//   - the read gate (jobs.isReadAllowed -> in-process submitted set + job-guard.isCwdOwned)
//     runs for real;
//   - the only subprocess is the SHIPPED fixture companion (a real spawned process),
//     and server identity is driven exactly as production drives it: a fresh module
//     instance per server process (empty submitted set) + cwd/CODEX_MCP_OWNER_CWD for
//     the owner path -- never by replacing an ownership function.
import { test, after } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");

// Two REAL directories (the spawned companion's cwd must exist): the admitted FOREIGN
// target project, and a SECOND server's owner workspace. Each carries its own .git so
// it resolves to a DISTINCT workspace root -- exactly like the real target projects
// (other project folders), and independent of any git repo above os.tmpdir().
// Both are shared by the whole file, so their removal hangs off ONE file-level after() hook,
// registered here at module top level; it runs even when the test fails or times out.
const FILE = { after };
const FOREIGN = tempDirFor(FILE, "gate-live-foreign-");
const OTHER_OWNER = tempDirFor(FILE, "gate-live-other-");
fs.mkdirSync(path.join(FOREIGN, ".git"), { recursive: true });
fs.mkdirSync(path.join(OTHER_OWNER, ".git"), { recursive: true });

// The default on-disk sidecar dir a token-sidecar design would have used. It
// must never be created: no credential touches disk.
const LEGACY_STAMP_DIR = path.join(os.tmpdir(), "codex-mcp-stamps");

test("end-to-end: same-session foreign-cwd submit+wait SUCCEEDS; other-instance denied; same-owner other-process allowed; NO sidecar artifact", async (t) => {
  // Start from a clean slate so a leftover from an earlier run cannot mask a regression.
  try { fs.rmSync(LEGACY_STAMP_DIR, { recursive: true, force: true }); } catch { /* absent is fine */ }
  t.after(() => {
    for (const k of ["CLAUDE_PLUGIN_ROOT", "CODEX_MCP_OWNER_CWD"]) delete process.env[k];
  });

  // --- Server process 1 (a fresh jobs.mjs module instance == a fresh submitted set)
  //     submits UNDER A FOREIGN target cwd -- the primary delegate/review/gate/panel
  //     pattern. This is the reviewers/panel submit fn (codexProvider.submit ->
  //     submitTaskViaFile). Its owner defaults to this repo; it is never consulted here
  //     because the SAME-SESSION path grants the read. ---
  delete process.env.CODEX_MCP_OWNER_CWD;
  const inst1 = await import("../jobs.mjs?inst=1");
  const sub = await inst1.submitTaskViaFile("review this diff", { cwd: FOREIGN, tmpDir: os.tmpdir() }, {});
  const jobId = sub.job_id;
  assert.equal(jobId, "task-fake001");

  // Same-session submit-then-poll ACROSS the foreign cwd SUCCEEDS. Under the first fix
  // this was a cross_store failure -> an inaccessible job. Fully un-mocked: real
  // waitForResult -> real pollToTerminal -> real getStatus/getResult -> real gate ->
  // real fixture companion subprocess.
  const w = await inst1.waitForResult(jobId, { cwd: FOREIGN, timeoutMs: 8000, pollIntervalMs: 50 });
  assert.equal(w.status, "completed");
  assert.ok(w.result && typeof w.result.output === "string");

  // --- Server process 2 (a DIFFERENT module instance -> EMPTY submitted set, and a
  //     DIFFERENT owner workspace) CANNOT read the job: neither the same-session path
  //     (it did not submit this job) nor the owner path (FOREIGN is not its workspace)
  //     grants access -> fail closed, no companion spawn. ---
  process.env.CODEX_MCP_OWNER_CWD = OTHER_OWNER;
  const inst2 = await import("../jobs.mjs?inst=2");
  await assert.rejects(inst2.getStatus(jobId, FOREIGN), (e) => e.code === "cross_store");

  // --- Server process 3 (another EMPTY-set instance, but its OWNER workspace IS that
  //     store) CAN read it via the owner path -- cross-session pickup within the owning
  //     project. Proves a foreign job is reachable ONLY by its true owner, never by a
  //     forged credential (there is none to forge). ---
  process.env.CODEX_MCP_OWNER_CWD = FOREIGN;
  const inst3 = await import("../jobs.mjs?inst=3");
  const snap = await inst3.getStatus(jobId, FOREIGN);
  assert.equal((snap.job ?? snap).status, "completed");

  // --- No sidecar artifact anywhere: the whole submit+read lifecycle wrote no token
  //     store to disk. The old stamp dir is not created at all, and the module is gone. ---
  assert.equal(fs.existsSync(LEGACY_STAMP_DIR), false);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "job-stamp.mjs")), false);
});

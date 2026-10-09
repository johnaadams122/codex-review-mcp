import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onCleanup, tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, BETA } from "./helpers/policy-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Point the companion resolver at the fake companion before importing server.
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");
// Review logs and handoff records go to a private folder, never the live server's
// <OS temp>/codex-mcp-reviews (see reviewLogDir in review-detach.mjs).
process.env.CODEX_REVIEW_LOG_DIR = tempDirFor({ after }, "srv-logs-");
const repo = path.resolve(__dirname, "..");   // this checkout, registered below as a git-allowed, non-PII project
installPolicyFixture({ after }, { projectsBase: path.dirname(repo), projects: [{ ...BETA, dir: path.basename(repo) }] });

const { handleReview, handleAdversarialReview } = await import("../server.mjs?srv=1");

// This file spawns the REAL fixture
// subprocess via CLAUDE_PLUGIN_ROOT (unlike server.wait.test.mjs / server-admission
// .test.mjs, which mock.module() jobs.mjs and never touch the companion). Reviews now
// run DETACHED: submitReview/submitAdversarialReview spawn the
// review child, DISCOVER its store record, and return { job_id, status } re-derived
// from the store -- never parsed from stdout (the --background job_id lie is gone;
// stdout carries no jobId in either fixture mode). Without CODEX_FAKE_STORE_DIR the
// fixture takes the store-less legacy branch, discovery finds nothing, and the call
// eventually rejects with review_discovery_timeout -- so these set a fresh store dir
// + fast discovery knobs + a small fake-review duration, same idiom as
// tests/integration.review-detach.test.mjs's freshStore/fastKnobs.
function freshStore(t) {
  const dir = tempDirFor(t, "srvtest-");
  process.env.CODEX_FAKE_STORE_DIR = dir;
  // Registered after the folder, so it runs first: kill any still-sleeping fixture child (by its
  // own pid) BEFORE the store is removed (no orphaned test children writing into a deleted directory).
  onCleanup(t, () => {
    try { process.kill(parseInt(fs.readFileSync(path.join(dir, "child.pid"), "utf8"), 10)); } catch { /* gone */ }
    delete process.env.CODEX_FAKE_STORE_DIR;
  });
  return dir;
}
const fastKnobs = (t) => {
  process.env.CODEX_REVIEW_DISCOVERY_TIMEOUT_MS = "5000";   // floor
  process.env.CODEX_REVIEW_DISCOVERY_POLL_MS = "250";
  onCleanup(t, () => { delete process.env.CODEX_REVIEW_DISCOVERY_TIMEOUT_MS; delete process.env.CODEX_REVIEW_DISCOVERY_POLL_MS; });
};

test("handleReview returns a job_id (async contract, no inline output)", async (t) => {
  freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "1000";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const res = await handleReview({ scope: "working-tree", base: undefined, cwd: repo });
  const out = JSON.parse(res.content[0].text);
  assert.equal(typeof out.job_id, "string");
  assert.ok(out.job_id.startsWith("review-fake-"));
  assert.ok("status" in out);
  assert.ok(!("output" in out), "must not return inline output");
});

test("handleAdversarialReview returns a job_id", async (t) => {
  freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "1000";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const res = await handleAdversarialReview({ focus: "design", scope: "working-tree", base: undefined, cwd: repo });
  const out = JSON.parse(res.content[0].text);
  assert.equal(typeof out.job_id, "string");
  assert.ok(out.job_id.startsWith("review-fake-"));
  assert.ok("status" in out);
});

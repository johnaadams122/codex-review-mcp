import { test, after } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onCleanup, tempDirFor } from "./helpers/test-cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");
// Review logs and handoff records go to a private folder, never the live server's
// <OS temp>/codex-mcp-reviews (see reviewLogDir in review-detach.mjs). Removed after the file's
// last test, by which point every test has stopped its own detached fixture child.
process.env.CODEX_REVIEW_LOG_DIR = tempDirFor({ after }, "rdit-logs-");

const { submitDetachedReview } = await import("../review-detach.mjs?itest=1");
const { getStatus, getResult, buildReviewArgs, buildAdversarialReviewArgs } = await import("../jobs.mjs?itest=1");

function freshStore(t) {
  const dir = tempDirFor(t, "rdtest-");
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

test("returns store id + running while review still runs; result reachable after", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "4000";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  // Cold-start subprocess polls on a loaded box can land post-finalize.
  assert.ok(["running", "completed"].includes(r.status));
  // poll to terminal via the store-backed fixture
  let job;
  for (let i = 0; i < 40; i++) {
    const snap = await getStatus(r.job_id, process.cwd());
    job = snap.job ?? snap;
    if (job.status === "completed") break;
    await new Promise(res => setTimeout(res, 250));
  }
  assert.equal(job.status, "completed");
  const result = await getResult(r.job_id, process.cwd());
  assert.equal(result.status, "completed");
});

test("adversarial kind: same flow, review- prefixed id", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "2000";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const r = await submitDetachedReview({ argv: buildAdversarialReviewArgs("focus", { cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
});

test("fast review resolves with the terminal record (discovery or settle path)", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "0";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  // A poll can land in the running->completed microwindow; re-poll to terminal.
  if (r.status !== "completed") {
    let j;
    for (let i = 0; i < 20; i++) {
      const snap = await getStatus(r.job_id, process.cwd());
      j = snap.job ?? snap;
      if (j.status === "completed") break;
      await new Promise(res => setTimeout(res, 100));
    }
    assert.equal(j.status, "completed");
  }
});

test("foreign-session records are invisible to discovery", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  // pre-seed one untagged and one foreign-tagged RUNNING review record
  fs.writeFileSync(path.join(dir, "rec-review-foreign1.json"), JSON.stringify({
    id: "review-foreign1", kind: "review", jobClass: "review", status: "running",
    pid: 99999, createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, "rec-review-foreign2.json"), JSON.stringify({
    id: "review-foreign2", kind: "review", jobClass: "review", status: "running",
    pid: 99998, createdAt: new Date().toISOString(), sessionId: "cmr-someoneelse" }));
  process.env.CODEX_FAKE_REVIEW_MS = "1500";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(!["review-foreign1", "review-foreign2"].includes(r.job_id));
});

test("golden inversion: tiny companion timer must NOT kill the review", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_COMPANION_TIMEOUT_MS = "150";
  process.env.CODEX_FAKE_REVIEW_MS = "3000";
  onCleanup(t, () => { delete process.env.CODEX_COMPANION_TIMEOUT_MS; delete process.env.CODEX_FAKE_REVIEW_MS; });
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  // The submission returning is NOT enough -- the review must REACH TERMINAL
  // despite the 150ms timer (a reintroduced timer killing the child after
  // submission would otherwise pass). The WIRED variant of this test
  // is the authoritative golden inversion on the shipped submitReview path.
  let done = null;
  for (let i = 0; i < 60; i++) {
    const snap = await getStatus(r.job_id, process.cwd());
    const j = snap.job ?? snap;
    if (j.status === "completed") { done = j; break; }
    await new Promise(res => setTimeout(res, 250));
  }
  assert.ok(done, "review must reach terminal despite the 150ms companion timer");
});

test("every companion invocation carried --cwd (cwd-probe)", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "1000";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  const lines = fs.readFileSync(path.join(dir, "cwd-probe.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(lines.length >= 2);   // the review child + at least one status --all
  for (const l of lines) assert.equal(path.resolve(l.cwd), path.resolve(process.cwd()));
});

// ---- failure-branch matrix -----------------------------------

test("no store -> review_discovery_timeout and child verified dead", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_SKIP_STORE = "1";
  process.env.CODEX_FAKE_REVIEW_MS = "60000";   // sleeps far past the 5s floor
  onCleanup(t, () => { delete process.env.CODEX_FAKE_SKIP_STORE; delete process.env.CODEX_FAKE_REVIEW_MS; });
  await assert.rejects(
    submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() }),
    (e) => e.code === "review_discovery_timeout");
  const pid = parseInt(fs.readFileSync(path.join(dir, "child.pid"), "utf8"), 10);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false);   // independent death check via the pid side channel
  // Discovery AND sweep calls all carried the submission cwd.
  const lines = fs.readFileSync(path.join(dir, "cwd-probe.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  for (const l of lines) assert.equal(path.resolve(l.cwd), path.resolve(process.cwd()));
});

test("pre-record failure -> fast reject with log tail", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_FAIL = "pre-record";
  onCleanup(t, () => delete process.env.CODEX_FAKE_FAIL);
  await assert.rejects(
    submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() }),
    (e) => e.code === "review_child_failed" && /forced pre-record failure/.test(e.message));
});

test("post-record failure -> review_died_record_frozen carrying the job id", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_FAIL = "post-record";
  onCleanup(t, () => delete process.env.CODEX_FAKE_FAIL);
  await assert.rejects(
    submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() }),
    (e) => e.code === "review_died_record_frozen" && /job_id review-fake-/.test(e.message));
});

test("exit 0 with no record -> review_completed_untracked", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_SKIP_STORE = "1";
  process.env.CODEX_FAKE_REVIEW_MS = "0";
  onCleanup(t, () => { delete process.env.CODEX_FAKE_SKIP_STORE; delete process.env.CODEX_FAKE_REVIEW_MS; });
  await assert.rejects(
    submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() }),
    (e) => e.code === "review_completed_untracked");
});

test("untagged last-resort sweep recovers a record that never had a tag (deterministic clobber-rebirth)", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_UNTAGGED = "1";        // record written WITHOUT sessionId
  process.env.CODEX_FAKE_REVIEW_MS = "30000";   // stays running past the 5s deadline
  onCleanup(t, () => { delete process.env.CODEX_FAKE_UNTAGGED; delete process.env.CODEX_FAKE_REVIEW_MS; });
  const started = Date.now();
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  assert.equal(r.status, "running");
  // Prove the SWEEP path ran (not ordinary discovery): tagged discovery must
  // have exhausted its full deadline first.
  assert.ok(Date.now() - started >= 5000, "resolved before the discovery deadline -> sweep never ran");
  // Sweep + discovery calls all carried the submission cwd.
  const lines = fs.readFileSync(path.join(dir, "cwd-probe.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  for (const l of lines) assert.equal(path.resolve(l.cwd), path.resolve(process.cwd()));
});

test("record beats exit code: finalize-then-nonzero-exit returns the terminal record", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_FAIL = "post-finalize";
  process.env.CODEX_FAKE_REVIEW_MS = "0";
  onCleanup(t, () => { delete process.env.CODEX_FAKE_FAIL; delete process.env.CODEX_FAKE_REVIEW_MS; });
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  // A 0ms review can legitimately be caught mid-flight
  // ("running", non-terminal-but-alive branch) by discovery - the SAME race
  // "fast review resolves with the terminal record" (above)
  // already re-polls for. Re-poll to
  // terminal using the file's established idiom; the assertion under test
  // (record beats exit code -> "completed", NOT review_child_failed) unchanged.
  let status = r.status;
  if (status !== "completed") {
    for (let i = 0; i < 20; i++) {
      const snap = await getStatus(r.job_id, process.cwd());
      status = (snap.job ?? snap).status;
      if (status === "completed") break;
      await new Promise(res => setTimeout(res, 100));
    }
  }
  assert.equal(status, "completed");   // NOT review_child_failed
});

test("finalize-failed: record beats exit code on the FAILED branch too", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_FAIL = "finalize-failed";
  process.env.CODEX_FAKE_REVIEW_MS = "0";
  onCleanup(t, () => { delete process.env.CODEX_FAKE_FAIL; delete process.env.CODEX_FAKE_REVIEW_MS; });
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  // Same 0ms-review race as the test above: re-poll to terminal before asserting.
  let status = r.status;
  if (status !== "failed") {
    for (let i = 0; i < 20; i++) {
      const snap = await getStatus(r.job_id, process.cwd());
      status = (snap.job ?? snap).status;
      if (status === "failed") break;
      await new Promise(res => setTimeout(res, 100));
    }
  }
  assert.equal(status, "failed");                 // resolved, NOT rejected
  // This pins the fallback-removal contract: if a future plugin removes the
  // direct fallback, the companion finalizes FAILED fast and submission
  // returns {job_id, status:"failed"} - loud, attributable, never a hang.
});

test("foreign TERMINAL records are invisible to discovery (tag filter isolated)", async (t) => {
  // The foreign seeds above are RUNNING-only,
  // so pid corroboration could mask tag-filter regressions. A terminal foreign
  // record has NO pid check - this isolates the tag/session filter alone.
  const dir = freshStore(t); fastKnobs(t);
  fs.writeFileSync(path.join(dir, "rec-review-foreignT.json"), JSON.stringify({
    id: "review-foreignT", kind: "review", jobClass: "review", status: "completed",
    pid: null, createdAt: new Date().toISOString(), sessionId: "cmr-someoneelse" }));
  process.env.CODEX_FAKE_REVIEW_MS = "1500";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const r = await submitDetachedReview({ argv: buildReviewArgs({ cwd: process.cwd() }), cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  assert.notEqual(r.job_id, "review-foreignT");
});

// ---- WIRED-path tests through jobs.mjs (the shipped MCP surface) ----
const jobsWired = await import("../jobs.mjs?wired=1");

test("runCompanion applies extraEnv (session-filter proof)", async (t) => {
  const dir = freshStore(t);
  fs.writeFileSync(path.join(dir, "rec-review-seed1.json"), JSON.stringify({
    id: "review-seed1", kind: "review", jobClass: "review", status: "running",
    pid: 1, createdAt: new Date().toISOString(), sessionId: "cmr-proof" }));
  const withTag = JSON.parse((await jobsWired.runCompanion(
    ["status", "--all", "--json", "--cwd", process.cwd()],
    { cwd: process.cwd(), extraEnv: { CODEX_COMPANION_SESSION_ID: "cmr-proof" } })).stdout);
  assert.equal(withTag.running.length, 1);
  const withOther = JSON.parse((await jobsWired.runCompanion(
    ["status", "--all", "--json", "--cwd", process.cwd()],
    { cwd: process.cwd(), extraEnv: { CODEX_COMPANION_SESSION_ID: "cmr-other" } })).stdout);
  assert.equal(withOther.running.length, 0);
});

test("WIRED submitReview returns a store id via the detached path", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "2000";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const r = await jobsWired.submitReview({ cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
});

test("WIRED submitAdversarialReview threads focus + cwd", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_FAKE_REVIEW_MS = "2000";
  onCleanup(t, () => delete process.env.CODEX_FAKE_REVIEW_MS);
  const r = await jobsWired.submitAdversarialReview("the focus", { cwd: process.cwd() });
  assert.ok(r.job_id.startsWith("review-fake-"));
  const lines = fs.readFileSync(path.join(dir, "cwd-probe.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const rev = lines.find(l => l.cmd === "adversarial-review");
  assert.ok(rev.argv.includes("the focus"));
  assert.equal(path.resolve(rev.cwd), path.resolve(process.cwd()));
});

test("WIRED golden inversion: submitReview survives a 150ms companion timer to terminal", async (t) => {
  const dir = freshStore(t); fastKnobs(t);
  process.env.CODEX_COMPANION_TIMEOUT_MS = "150";
  process.env.CODEX_FAKE_REVIEW_MS = "3000";
  onCleanup(t, () => { delete process.env.CODEX_COMPANION_TIMEOUT_MS; delete process.env.CODEX_FAKE_REVIEW_MS; });
  const r = await jobsWired.submitReview({ cwd: process.cwd() });
  let done = null;
  for (let i = 0; i < 60; i++) {
    const snap = await getStatus(r.job_id, process.cwd());
    const j = snap.job ?? snap;
    if (j.status === "completed") { done = j; break; }
    await new Promise(res => setTimeout(res, 250));
  }
  assert.ok(done, "wired review must reach terminal despite the 150ms timer");
  // This is the AUTHORITATIVE golden inversion: pre-fix submitReview (foreground
  // + timer + payload.jobId parse) fails this test against the store-backed
  // fixture in every respect -- killed at +150ms AND job_id undefined.
});

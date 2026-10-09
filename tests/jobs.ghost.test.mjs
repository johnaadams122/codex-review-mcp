// Ghost-submission guard + disk-store fallback (store-race root cause):
// the companion's saveState is an unlocked read-modify-write that
// deletes any job absent from its (possibly stale) list -- concurrent
// submissions ghost each other's fresh records after the jobId was printed.
import { test } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { submitTask, submitTaskViaFile, getResult, readJobRecordFromDisk } from "../jobs.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

const missing = (id) => { const e = new Error(`companion exited 1: No job found for "${id}"`); return e; };

function ghostThenPersistDeps({ ghostIds, sleeps }) {
  // getStatusFn: ids in ghostIds are NEVER seen; all others are persisted.
  return {
    getStatusFn: async (jobId) => {
      if (ghostIds.has(jobId)) throw missing(jobId);
      return { job: { id: jobId, status: "queued" } };
    },
    sleep: async (ms) => { sleeps.push(ms); },
    settleMs: 5,
  };
}

test("submitTaskViaFile: ghosted first submission is re-verified after a settle, then resubmitted once", async () => {
  const sleeps = [];
  let submits = 0;
  const deps = {
    ...ghostThenPersistDeps({ ghostIds: new Set(["t-ghost-1"]), sleeps }),
    runCompanionFn: async () => {
      submits += 1;
      return { stdout: JSON.stringify({ jobId: submits === 1 ? "t-ghost-1" : "t-real-2", status: "queued" }) };
    },
  };
  const r = await submitTaskViaFile("prompt", { tmpDir: os.tmpdir() }, deps);
  assert.equal(r.job_id, "t-real-2");
  assert.equal(submits, 2);
  assert.deepEqual(sleeps, [5]);   // exactly one settle before the re-verify
});

test("submitTask: both submissions ghost -> coded task_submission_ghosted rejection naming both ids", async () => {
  const sleeps = [];
  let submits = 0;
  const deps = {
    ...ghostThenPersistDeps({ ghostIds: new Set(["g1", "g2"]), sleeps }),
    runCompanionFn: async () => {
      submits += 1;
      return { stdout: JSON.stringify({ jobId: submits === 1 ? "g1" : "g2", status: "queued" }) };
    },
  };
  await assert.rejects(submitTask("p", {}, deps), (e) => {
    assert.equal(e.code, "task_submission_ghosted");
    assert.match(e.message, /g1, g2/);
    return true;
  });
});

test("submitTask: a WRITE-capable ghost is NEVER auto-resubmitted (fails loud as ambiguous)", async () => {
  // A lost record's worker can resurrect
  // past the settle window; auto-resubmitting a write task risks two agents
  // editing the same checkout. write:true -> single attempt, coded rejection.
  const sleeps = [];
  let submits = 0;
  const deps = {
    ...ghostThenPersistDeps({ ghostIds: new Set(["w1"]), sleeps }),
    runCompanionFn: async () => { submits += 1; return { stdout: JSON.stringify({ jobId: "w1", status: "queued" }) }; },
  };
  await assert.rejects(submitTask("p", { write: true }, deps), (e) => {
    assert.equal(e.code, "task_submission_ghosted");
    assert.match(e.message, /write-capable/);
    return true;
  });
  assert.equal(submits, 1);   // no second submission for a write task
});

test("submitTask: a NON-missing status error never triggers a resubmission", async () => {
  let submits = 0;
  const r = await submitTask("p", {}, {
    runCompanionFn: async () => { submits += 1; return { stdout: JSON.stringify({ jobId: "t1", status: "queued" }) }; },
    getStatusFn: async () => { throw new Error("companion timed out after 150ms"); },
    sleep: async () => {},
  });
  assert.equal(r.job_id, "t1");
  assert.equal(submits, 1);
});

test("readJobRecordFromDisk: scans workspace store dirs by unique job id; rejects unsafe ids", (t) => {
  const root = tempDirFor(t, "ghost-store-");
  const jobsDir = path.join(root, "some-ws-abc123", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const rec = { id: "task-x1", status: "completed", result: { rawOutput: "{\"ok\":true}" } };
  fs.writeFileSync(path.join(jobsDir, "task-x1.json"), JSON.stringify(rec));
  // The cross-store scan is owner-gated. This legacy record (no
  // workspaceRoot) is only returned when the server instance OWNS its physical
  // store dir -- pin the self store dir to make the recovery path deterministic.
  const owned = { roots: [root], selfWorkspaceRoot: "C:/nowhere", selfStoreDir: "some-ws-abc123" };
  assert.deepEqual(readJobRecordFromDisk("task-x1", owned), rec);
  assert.equal(readJobRecordFromDisk("task-none", owned), null);
  assert.equal(readJobRecordFromDisk("../../etc/passwd", owned), null);
  assert.equal(readJobRecordFromDisk("a/b", owned), null);
  // A server instance that does NOT own that store dir must not read it back.
  assert.equal(readJobRecordFromDisk("task-x1",
    { roots: [root], selfWorkspaceRoot: "C:/nowhere", selfStoreDir: "a-different-store" }), null);
});

test("getResult: store-dropped completed job is recovered from the on-disk job file (full rawOutput)", async () => {
  const rec = { id: "task-d1", status: "completed", result: { rawOutput: '{"lens":"x","verdict":"pass"}' } };
  const r = await getResult("task-d1", null, {
    runCompanionFn: async () => { throw missing("task-d1"); },
    readJobRecordFromDiskFn: () => rec,
    getStatusFn: async () => { throw new Error("should not be reached: disk fallback comes first"); },
  });
  assert.equal(r._diskRecovered, true);
  assert.equal(r.status, "completed");
  assert.equal(r.storedJob.result.rawOutput, rec.result.rawOutput);
});

test("getResult: disk record that is non-terminal or resultless falls through to the status fallback", async () => {
  const r = await getResult("task-d2", null, {
    runCompanionFn: async () => { throw missing("task-d2"); },
    readJobRecordFromDiskFn: () => ({ id: "task-d2", status: "running" }),
    getStatusFn: async () => ({ job: { status: "running", progressPreview: [
      "Turn completion inferred", "Assistant message captured: recovered answer"] } }),
  });
  assert.equal(r._synthesized, true);
  assert.equal(r.output, "recovered answer");
});

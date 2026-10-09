import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queueMetaWrite, readMeta, metaPath } from "../direct.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function tmpJobDir(t) { return tempDirFor(t, "a1-meta-"); }
function fakeJob(dir) {
  return { dir, meta: { jobId: "j1", state: "spawning" }, metaQueue: Promise.resolve(), metaWriteError: null };
}

test("meta writes serialize, tmp+rename, reader prefers meta.json", async (t) => {
  const dir = tmpJobDir(t);
  const job = fakeJob(dir);
  queueMetaWrite(job, { state: "running", pid: 123 });
  await queueMetaWrite(job, { thread_id: "t-1" });
  const m = readMeta(dir);
  assert.equal(m.state, "running");
  assert.equal(m.pid, 123);
  assert.equal(m.thread_id, "t-1");
  assert.equal(fs.existsSync(metaPath(dir)), true);
});

test("monotonic state ranks: a stale lower-rank state never rolls back a terminal", async (t) => {
  const dir = tmpJobDir(t);
  const job = fakeJob(dir);
  await queueMetaWrite(job, { state: "failed", failure_reason: "timeout" });
  await queueMetaWrite(job, { state: "running" }); // stale -- must not roll back
  assert.equal(readMeta(dir).state, "failed");
});

test("reader falls back to the newest parseable tmp on a torn meta.json", (t) => {
  const dir = tmpJobDir(t);
  fs.writeFileSync(metaPath(dir), "{ torn", "utf8");
  fs.writeFileSync(path.join(dir, "meta.json.aaa.tmp"), JSON.stringify({ state: "running" }), "utf8");
  const later = path.join(dir, "meta.json.bbb.tmp");
  fs.writeFileSync(later, JSON.stringify({ state: "completed" }), "utf8");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(later, future, future);
  assert.equal(readMeta(dir).state, "completed");
});

test("write failures are recorded on the job, never thrown (post-spawn meta is housekeeping) and LOGGED", async () => {
  const job = fakeJob(path.join(os.tmpdir(), "a1-meta-nonexistent-dir-xyz"));
  const lines = [];
  await queueMetaWrite(job, { state: "running" }, { log: (m) => lines.push(m) });
  assert.ok(job.metaWriteError);
  assert.ok(lines.some((m) => /meta write failed/.test(m))); // logged, never thrown
});

test("readMeta returns null when nothing is readable", () => {
  assert.equal(readMeta(path.join(os.tmpdir(), "a1-meta-missing-xyz")), null);
});

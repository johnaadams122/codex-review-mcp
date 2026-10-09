import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDirectStatus, getDirectResult, cancelDirect, readCommandExecutionEvents,
  directEffectiveStrength, _registry, _newJobForTest,
} from "../direct.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREAD = "5afe0001-fa57-4ace-8c0d-decaf0ba5e01"; // matches the session id in the checked-in rollout fixtures

function seedJob(t, { threadId = THREAD, model = "gpt-5.6-luna", effort = "low", sessionsRoot } = {}) {
  const dir = tempDirFor(t, "a1-att-");
  const job = _newJobForTest({
    jobId: `j-${Math.random().toString(36).slice(2)}`, dir,
    request: { model, effort, cwd_real: "C:\\repo", pii: false, timeoutMs: 5000,
      logCap: 1024 * 1024, answerFile: path.join(dir, "answer.txt") },
    rt: { sessionsRoot: sessionsRoot ?? tempDirFor(t, "a1-sess-"), instanceId: "i", codexVersion: "0.144.1" },
  });
  job.meta.thread_id = threadId;
  // _newJobForTest's newJob() defaults meta.state to "spawning" (the real pre-spawn value);
  // this fixture simulates an already-running job (resolved=true, roadResolved=true by default
  // below), so meta.state must reflect that or getDirectStatus's spawning/running branch
  // misreports "spawning" for the road-unresolved-yet case in the first test. Real jobs reach
  // "running" via the post-spawn queueMetaWrite in runSubmitSequence step 4.
  job.meta.state = "running";
  job.resolved = true;
  job.roadResolved = true;
  job.terminal = { status: "completed", failure_reason: null, kill_unverified: false };
  _registry().set(job.jobId, job);
  return job;
}
function placeRollout(job, records, name) {
  const dir = path.join(job.rt.sessionsRoot, "2026", "07", "15");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name ?? `rollout-2026-07-15T00-00-00-${job.meta.thread_id}.jsonl`), records, "utf8");
}
function cleanup(job) { _registry().delete(job.jobId); }   // its folders are removed by tempDirFor's hook

test("getDirectStatus: terminal visible only when road resolved; request is a display echo", (t) => {
  const job = seedJob(t);
  job.roadResolved = false;
  assert.equal(getDirectStatus(job.jobId).job.status, "running");
  job.roadResolved = true;
  const s = getDirectStatus(job.jobId).job;
  assert.equal(s.status, "completed");
  assert.equal(s.request.model, "gpt-5.6-luna");
  assert.throws(() => getDirectStatus("nope"));
  cleanup(job);
});

test("getDirectResult: missing/empty/oversized -> throws; happy path returns { output }", (t) => {
  const job = seedJob(t);
  assert.throws(() => getDirectResult(job.jobId));
  fs.writeFileSync(job.request.answerFile, "   ", "utf8");
  assert.throws(() => getDirectResult(job.jobId));
  fs.writeFileSync(job.request.answerFile, '{"verdict":"pass"}', "utf8");
  assert.deepEqual(getDirectResult(job.jobId), { output: '{"verdict":"pass"}' });
  assert.throws(() => getDirectResult(job.jobId, { stat: () => ({ size: 6 * 1024 * 1024 }) }));
  cleanup(job);
});

test("readCommandExecutionEvents: only item.completed command_execution from the job's own tee", (t) => {
  const job = seedJob(t);
  fs.writeFileSync(path.join(job.dir, "events.jsonl"), [
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "in-progress" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "Get-Content README.md", aggregated_output: "hello" } }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning" } }),
    "not json",
  ].join("\n"), "utf8");
  const evs = readCommandExecutionEvents(job.jobId);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].command, "Get-Content README.md");
  cleanup(job);
});

test("attestation: the checked-in fixture rollout attests (gpt-5.6-luna, low) exactly", async (t) => {
  const job = seedJob(t);
  placeRollout(job, fs.readFileSync(path.join(__dirname, "fixtures", "direct", "probe-rollout-records.jsonl"), "utf8"));
  assert.deepEqual(await directEffectiveStrength(job.jobId, { retryDelayMs: 1 }), { model: "gpt-5.6-luna", effort: "low" });
  cleanup(job);
});

test("attestation: a turn-level downgrade can never be outvoted -> unattested", async (t) => {
  const job = seedJob(t, { model: "gpt-6-astra", effort: "max" });
  placeRollout(job, [
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra", effort: "max" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra", effort: "high" } }),
  ].join("\n"));
  assert.equal(await directEffectiveStrength(job.jobId, { retryDelayMs: 1 }), null);
  cleanup(job);
});

test("attestation: zero strength records / malformed turn_context / session_meta-only -> unattested", async (t) => {
  const cases = [
    JSON.stringify({ type: "session_meta", payload: { model_provider: "openai" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),         // missing effort
    JSON.stringify({ type: "turn_context", payload: { model: 5, effort: "max" } }),      // non-string
  ];
  for (const recs of cases) {
    const job = seedJob(t, { model: "gpt-6-astra", effort: "max" });
    placeRollout(job, recs);
    assert.equal(await directEffectiveStrength(job.jobId, { retryDelayMs: 1 }), null);
    cleanup(job);
  }
});

test("attestation: zero matches after retries, multiple matches, bad thread_id -> unattested", async (t) => {
  const none = seedJob(t, { model: "gpt-6-astra", effort: "max" });
  assert.equal(await directEffectiveStrength(none.jobId, { retryDelayMs: 1 }), null);
  cleanup(none);

  const multi = seedJob(t, { model: "gpt-6-astra", effort: "max" });
  const rec = JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra", effort: "max" } });
  placeRollout(multi, rec);
  placeRollout(multi, rec, `rollout-2026-07-15T00-00-01-${multi.meta.thread_id}.jsonl`);
  assert.equal(await directEffectiveStrength(multi.jobId, { retryDelayMs: 1 }), null);
  cleanup(multi);

  const bad = seedJob(t, { threadId: "not-a-thread-id" });
  assert.equal(await directEffectiveStrength(bad.jobId, { retryDelayMs: 1 }), null);
  cleanup(bad);
});

test("attestation: oversized receipt -> unattested (50MB parse cap)", async (t) => {
  const job = seedJob(t, { model: "gpt-6-astra", effort: "max" });
  placeRollout(job, JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra", effort: "max" } }));
  assert.equal(await directEffectiveStrength(job.jobId, { retryDelayMs: 1, stat: () => ({ size: 51 * 1024 * 1024 }) }), null);
  cleanup(job);
});

test("attestation: a receipt appearing only on a LATER retry still attests (3x500ms retry road)", async (t) => {
  const job = seedJob(t, { model: "gpt-6-astra", effort: "max" });
  placeRollout(job, JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra", effort: "max" } }));
  let scans = 0;
  const gated = (dir, o) => { scans++; if (scans <= 2) return []; return fs.readdirSync(dir, o); };
  assert.deepEqual(await directEffectiveStrength(job.jobId, { retryDelayMs: 1, readdir: gated }),
    { model: "gpt-6-astra", effort: "max" });
  assert.ok(scans >= 3); // first two search rounds saw nothing; the third found the receipt
  cleanup(job);
});

test("cancelDirect resolves only after the road resolves and records intent", async (t) => {
  const job = seedJob(t);
  job.roadResolved = false; job.terminal = null; job.roadPromise = null;
  job.child = { pid: 1234, exitCode: null };
  const r = await cancelDirect(job.jobId, {
    spawn: (cmd, args) => ({ on: (ev, fn) => { if (ev === "close") setTimeout(fn, 1); } }),
    isPidAlive: () => false, killWaitMs: 20,
  });
  assert.equal(r.cancelled, true);
  assert.equal(job.roadResolved, true);
  assert.equal(job.terminal.status, "cancelled");
  cleanup(job);
});

test("multi-turn pin: the multi-turn rollout fixture attests THROUGH directEffectiveStrength", async (t) => {
  const recs = fs.readFileSync(path.join(__dirname, "fixtures", "direct", "rollout-multiturn.jsonl"), "utf8");
  const turnContexts = recs.split(/\r?\n/).filter(Boolean).map(JSON.parse).filter((r) => r.type === "turn_context");
  assert.ok(turnContexts.length >= 2, "multi-turn fixture must carry >=2 turn_context records");
  for (const tc of turnContexts) {
    assert.equal(typeof tc.payload.model, "string");
    assert.equal(typeof tc.payload.effort, "string");
  }
  // feed the fixture records through the production parser -- fixture/parser compatibility
  const { model, effort } = turnContexts[0].payload;
  const job = seedJob(t, { model, effort });
  placeRollout(job, recs);
  assert.deepEqual(await directEffectiveStrength(job.jobId, { retryDelayMs: 1 }), { model, effort });
  cleanup(job);
});

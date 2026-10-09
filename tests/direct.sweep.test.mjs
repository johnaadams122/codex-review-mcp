import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  finalizeJob, sweepInstances, startSweepInterval, _registry, _newJobForTest, _resetDirectRuntime,
  resolveDirectRuntime, metaPath, SWEEP_AGE_MS, SWEEP_INTERVAL_MS,
} from "../direct.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function freshRuntime(t) {
  _resetDirectRuntime();
  const binDir = tempDirFor(t, "a1-swbin-");
  const bin = path.join(binDir, "fake-codex.mjs");
  fs.writeFileSync(bin, "//", "utf8");
  const deps = {
    env: {
      CODEX_BIN: bin, CODEX_HOME: tempDirFor(t, "a1-swhome-"), PATH: "",
      CODEX_DIRECT_ROOT: tempDirFor(t, "a1-root-"),
    },
    spawnSync: () => ({ stdout: "codex-cli 0.144.1\n" }),
  };
  const rt = resolveDirectRuntime(deps);
  assert.ok(!rt.error);
  return { deps, rt };
}
function diskJob(rt, name, meta) {
  const dir = path.join(rt.instanceDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (meta !== null) fs.writeFileSync(metaPath(dir), JSON.stringify(meta), "utf8");
  return dir;
}

test("finalize: nonterminal job is self-cancelled first, registry ALWAYS dropped, dir deleted", async (t) => {
  const { deps, rt } = freshRuntime(t);
  const dir = path.join(rt.instanceDir, "jf1");
  fs.mkdirSync(dir);
  const job = _newJobForTest({ jobId: "jf1", dir, request: { model: "m", effort: "e", cwd_real: "c", pii: false, timeoutMs: 5, logCap: 1024, answerFile: path.join(dir, "answer.txt") }, rt });
  job.resolved = true;
  job.child = { pid: 1, exitCode: null };
  _registry().set("jf1", job);
  await finalizeJob("jf1", { ...deps, spawn: () => ({ on: (ev, fn) => { if (ev === "close") setTimeout(fn, 1, 0); } }), isPidAlive: () => false, killWaitMs: 10 });
  assert.equal(_registry().has("jf1"), false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(job.terminal.status, "cancelled");
});

// Real write streams that keep their file open 50 ms after destroy(), as Windows can.
function slowClosingStreams(dir) {
  return ["events.jsonl", "stderr.log"].map((name) => {
    const s = fs.createWriteStream(path.join(dir, name), { flags: "a" });
    const realDestroy = s._destroy.bind(s);
    s._destroy = (err, cb) => { setTimeout(() => realDestroy(err, cb), 50); };
    return s;
  });
}

test("finalize: a self-cancelled job's log streams are closed before its dir is deleted", async (t) => {
  // The cancel road destroys the streams without waiting; on Windows the delete that follows
  // can fail while a file is still open and leave the dir behind.
  const { deps, rt } = freshRuntime(t);
  const dir = path.join(rt.instanceDir, "jf4");
  fs.mkdirSync(dir);
  const job = _newJobForTest({ jobId: "jf4", dir, request: { model: "m", effort: "e", cwd_real: "c", pii: false, timeoutMs: 5, logCap: 1024, answerFile: path.join(dir, "answer.txt") }, rt });
  job.resolved = true;
  job.child = { pid: 1, exitCode: null };
  [job.tee, job.errlog] = slowClosingStreams(dir);
  _registry().set("jf4", job);
  let closedAtRm = null;
  const rm = (d, o) => { closedAtRm = [job.tee.closed, job.errlog.closed]; fs.rmSync(d, o); };
  await finalizeJob("jf4", { ...deps, rm, spawn: () => ({ on: (ev, fn) => { if (ev === "close") setTimeout(fn, 1, 0); } }), isPidAlive: () => false, killWaitMs: 10 });
  assert.deepEqual(closedAtRm, [true, true]);
  assert.equal(fs.existsSync(dir), false);
});

test("finalize: a terminal job's still-open log streams are closed before its dir is deleted", async (t) => {
  const { deps, rt } = freshRuntime(t);
  const dir = path.join(rt.instanceDir, "jf5");
  fs.mkdirSync(dir);
  const job = _newJobForTest({ jobId: "jf5", dir, request: { model: "m", effort: "e", cwd_real: "c", pii: false, timeoutMs: 5, logCap: 1024, answerFile: path.join(dir, "answer.txt") }, rt });
  job.resolved = true; job.roadResolved = true;
  job.terminal = { status: "completed", failure_reason: null, kill_unverified: false };
  [job.tee, job.errlog] = slowClosingStreams(dir);
  _registry().set("jf5", job);
  let closedAtRm = null;
  const rm = (d, o) => { closedAtRm = [job.tee.closed, job.errlog.closed]; fs.rmSync(d, o); };
  await finalizeJob("jf5", { ...deps, rm });
  assert.deepEqual(closedAtRm, [true, true]);
  assert.equal(fs.existsSync(dir), false);
});

test("finalize: kill_unverified dir is RETAINED (sweep pid-gate owns it); idempotent", async (t) => {
  const { deps, rt } = freshRuntime(t);
  const dir = path.join(rt.instanceDir, "jf2");
  fs.mkdirSync(dir);
  const job = _newJobForTest({ jobId: "jf2", dir, request: { model: "m", effort: "e", cwd_real: "c", pii: false, timeoutMs: 5, logCap: 1024, answerFile: path.join(dir, "answer.txt") }, rt });
  job.resolved = true; job.roadResolved = true;
  job.terminal = { status: "failed", failure_reason: "timeout", kill_unverified: true };
  job.meta.kill_unverified = true;
  _registry().set("jf2", job);
  await finalizeJob("jf2", deps);
  assert.equal(_registry().has("jf2"), false);
  assert.equal(fs.existsSync(dir), true);   // retained
  await finalizeJob("jf2", deps);           // idempotent -- no throw
});

test("finalize: a failing cancel road is LOGGED, registry still dropped, never throws", async (t) => {
  const { deps, rt } = freshRuntime(t);
  const dir = path.join(rt.instanceDir, "jf3");
  fs.mkdirSync(dir);
  const job = _newJobForTest({ jobId: "jf3", dir, request: { model: "m", effort: "e", cwd_real: "c", pii: false, timeoutMs: 5, logCap: 1024, answerFile: path.join(dir, "answer.txt") }, rt });
  job.child = { pid: 1, exitCode: null };
  // an in-flight kill road that FAILS: recordIntent returns the in-flight roadPromise verbatim
  // (a kill road in flight: its terminal wins), so finalize's cancel await rejects.
  job.roadPromise = Promise.reject(new Error("road blew up"));
  job.roadPromise.catch(() => {}); // pre-attach so node records no unhandled rejection
  _registry().set("jf3", job);
  const lines = [];
  await finalizeJob("jf3", { ...deps, log: (m) => lines.push(m) }); // must not throw
  assert.equal(_registry().has("jf3"), false);             // registry drop is unconditional
  assert.ok(lines.some((m) => /finalize failed/.test(m))); // failure logged, never rethrown
});

test("sweep precedence: a recorded live-or-unknown pid is NEVER deleted by age", (t) => {
  const { deps, rt } = freshRuntime(t);
  const dir = diskJob(rt, "old-live", { state: "failed", kill_unverified: true, pid: 999 });
  const past = new Date(Date.now() - 2 * SWEEP_AGE_MS);
  fs.utimesSync(dir, past, past);
  sweepInstances({ ...deps, isPidAlive: () => true });
  assert.equal(fs.existsSync(dir), true);
  sweepInstances({ ...deps, isPidAlive: () => { throw new Error("unknown"); } });
  assert.equal(fs.existsSync(dir), true);   // unknown -> keep (fail-safe)
  sweepInstances({ ...deps, isPidAlive: () => false });
  assert.equal(fs.existsSync(dir), false);  // pid-dead check IS the eligibility rule
});

test("sweep: terminal non-kill_unverified dead-pid dirs deleted; live-registry dirs untouched", (t) => {
  const { deps, rt } = freshRuntime(t);
  const done = diskJob(rt, "done", { state: "completed", kill_unverified: false, pid: 111 });
  const live = diskJob(rt, "live-reg", { state: "running", pid: 222 });
  _registry().set("live-reg", { jobId: "live-reg" });
  sweepInstances({ ...deps, isPidAlive: () => false });
  assert.equal(fs.existsSync(done), false);
  assert.equal(fs.existsSync(live), true);
  _registry().delete("live-reg");
});

test("sweep: a NONTERMINAL dead-pid record is RETAINED (eligibility is terminal-only)", (t) => {
  const { deps, rt } = freshRuntime(t);
  const dir = diskJob(rt, "torn-running", { state: "running", kill_unverified: false, pid: 333 });
  sweepInstances({ ...deps, isPidAlive: () => false });
  assert.equal(fs.existsSync(dir), true); // not sweep-eligible; the foreign-tree rule cleans it after this server dies
});

test("sweep age rule applies ONLY to no-pid dirs (corrupt/missing meta ages out at 24h)", (t) => {
  const { deps, rt } = freshRuntime(t);
  const fresh = diskJob(rt, "fresh-nopid", null);
  const stale = diskJob(rt, "stale-nopid", null);
  const past = new Date(Date.now() - 2 * SWEEP_AGE_MS);
  fs.utimesSync(stale, past, past);
  const corrupt = diskJob(rt, "stale-corrupt", null);
  fs.writeFileSync(metaPath(corrupt), "{ torn", "utf8");
  fs.utimesSync(metaPath(corrupt), past, past);
  fs.utimesSync(corrupt, past, past);
  sweepInstances({ ...deps, isPidAlive: () => false });
  assert.equal(fs.existsSync(fresh), true);   // seconds old -- mid-submit race guarded
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(corrupt), false);
});

test("foreign trees: only when serverPid dead AND quiet >24h; alive serverPid merely delays", (t) => {
  const { deps, rt } = freshRuntime(t);
  const root = path.dirname(rt.instanceDir);
  const foreign = path.join(root, "424242-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"); // valid <pid>-<uuidv4> shape
  fs.mkdirSync(path.join(foreign, "j1"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "instance.json"), JSON.stringify({ serverPid: 424242 }), "utf8");
  const past = new Date(Date.now() - 2 * SWEEP_AGE_MS);
  for (const p of [path.join(foreign, "instance.json"), path.join(foreign, "j1"), foreign]) fs.utimesSync(p, past, past);
  sweepInstances({ ...deps, isPidAlive: (pid) => pid === 424242 });
  assert.equal(fs.existsSync(foreign), true);   // pid "alive" -> delayed (fail-safe)
  sweepInstances({ ...deps, isPidAlive: () => false });
  assert.equal(fs.existsSync(foreign), false);
});

test("sweep NEVER deletes a sibling that isn't instance-shaped, even dead+quiet (destructive blast radius)", (t) => {
  const { deps, rt } = freshRuntime(t);
  const root = path.dirname(rt.instanceDir);
  const past = new Date(Date.now() - 2 * SWEEP_AGE_MS);
  // Directories a mis-set CODEX_DIRECT_ROOT could expose: a repo, a home-ish folder, a
  // non-numeric-prefixed name (the old NaN-pid -> "dead" mis-branch). All quiet >24h.
  const bystanders = ["my-important-repo", "Documents", "not-an-instance-uuid", "abc-def"];
  for (const name of bystanders) {
    const d = path.join(root, name);
    fs.mkdirSync(path.join(d, "stuff"), { recursive: true });
    fs.writeFileSync(path.join(d, "keep.txt"), "DO NOT DELETE", "utf8");
    for (const p of [path.join(d, "keep.txt"), path.join(d, "stuff"), d]) fs.utimesSync(p, past, past);
  }
  sweepInstances({ ...deps, isPidAlive: () => false }); // everything "dead"
  for (const name of bystanders) {
    assert.equal(fs.existsSync(path.join(root, name)), true, `${name} must survive the sweep`);
  }
});

test("sweepInstances never throws to callers", () => {
  _resetDirectRuntime();
  sweepInstances({ env: { PATH: "" } }); // runtime unresolvable -- must be a no-op
});

test("startSweepInterval: immediate start sweep; singleton; 15-min cadence", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { deps, rt } = freshRuntime(t);
  const past = new Date(Date.now() - 2 * SWEEP_AGE_MS);
  const a = diskJob(rt, "stale-a", null);
  fs.utimesSync(a, past, past);
  startSweepInterval({ ...deps, isPidAlive: () => false });
  assert.equal(fs.existsSync(a), false); // start sweep ran immediately
  const b = diskJob(rt, "stale-b", null);
  fs.utimesSync(b, past, past);
  startSweepInterval({ ...deps, isPidAlive: () => false });
  assert.equal(fs.existsSync(b), true);  // singleton: second call is a no-op
  t.mock.timers.tick(SWEEP_INTERVAL_MS);
  assert.equal(fs.existsSync(b), false); // interval sweep fired
});

test("startSweepInterval: timer is unref'd (never holds the process open)", (t) => {
  const { deps } = freshRuntime(t); // _resetDirectRuntime cleared the prior test's singleton
  const timer = startSweepInterval({ ...deps, isPidAlive: () => false });
  assert.equal(timer.hasRef(), false);
});

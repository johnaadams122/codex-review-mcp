// tests/atomic-store.lock.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "../hooks/atomic-store.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function tmpdir(t) { return tempDirFor(t, "lock-"); }

test("withLock serializes read-modify-write and releases the lock", (t) => {
  const d = tmpdir(t);
  const lock = path.join(d, "budget.lock");
  const store = path.join(d, "n.json");
  fs.writeFileSync(store, "0");
  for (let i = 0; i < 5; i++) {
    withLock(lock, () => {
      const n = parseInt(fs.readFileSync(store, "utf8"), 10);
      fs.writeFileSync(store, String(n + 1));
    });
  }
  assert.equal(fs.readFileSync(store, "utf8"), "5");
  assert.equal(fs.existsSync(lock), false); // released
});

test("withLock breaks a STALE lock (parseable, dead-pid, past TTL) and proceeds", (t) => {
  const d = tmpdir(t);
  const lock = path.join(d, "budget.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, at: 0 })); // ancient stamp, dead pid
  let ran = false;
  withLock(lock, () => { ran = true; }, { now: () => 10 ** 12, isPidAlive: () => false, sleep: () => {} });
  assert.equal(ran, true);
});

test("withLock CONFIRM-SAME-OWNER averts the ABA break: a stale stamp that CHANGES under us is NOT rm'd", (t) => {
  const d = tmpdir(t);
  const lock = path.join(d, "budget.lock");
  const stale = JSON.stringify({ pid: 2 ** 30, at: 0 });                 // dead + ancient -> judged stale
  const reacquired = JSON.stringify({ pid: process.pid, at: 10 ** 12 }); // another contender re-acquired (live, fresh)
  let reads = 0, rmCalls = 0;
  const readFile = () => (++reads === 1 ? stale : reacquired);           // read1: decide stale; read2 (confirm): changed
  const openEEXIST = () => { const e = new Error("EEXIST"); e.code = "EEXIST"; throw e; }; // lock always held -> tryTakeStale each spin
  assert.throws(() => withLock(lock, () => {}, {
    readFile, rm: () => { rmCalls++; }, open: openEEXIST,
    isPidAlive: () => false, now: () => 10 ** 12, sleep: () => {}, maxSpins: 2,
  }));
  assert.equal(rmCalls, 0, "confirm-same-owner must NOT remove a lock whose stamp changed under it (ABA break averted)");
});

test("withLock does NOT break an EMPTY just-created lock (v4 fail-open) -- throws, no takeover", (t) => {
  const d = tmpdir(t);
  const lock = path.join(d, "budget.lock");
  fs.writeFileSync(lock, "");                         // empty: the mid-init window a contender must NOT steal
  // fresh mtime (~now real), so the unparseable-branch mtime check is NOT past staleMs -> no break.
  assert.throws(() => withLock(lock, () => {}, { isPidAlive: () => false, sleep: () => {}, maxSpins: 3 }));
  assert.ok(fs.existsSync(lock));                     // the empty lock survives (was NOT force-removed)
});

test("withLock throws when a FRESH live lock is held (no takeover); bounded, does NOT hang", (t) => {
  const d = tmpdir(t);
  const lock = path.join(d, "budget.lock");
  const stamp = 10 ** 12;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: stamp }));
  // constant injected clock: the v4 `while(now()<end)` would spin FOREVER here; the bounded
  // maxSpins loop must terminate and throw.
  assert.throws(() => withLock(lock, () => {}, { now: () => stamp, isPidAlive: () => true, sleep: () => {}, maxSpins: 3 }));
});

test("withLock is mutually exclusive ACROSS PROCESSES (N children x M increments == N*M)", async (t) => {
  const d = tmpdir(t);
  const lock = path.join(d, "n.lock");
  const store = path.join(d, "n.json");
  fs.writeFileSync(store, "0");
  const storeModule = new URL("../hooks/atomic-store.mjs", import.meta.url).href;
  const worker = path.join(d, "worker.mjs");
  fs.writeFileSync(worker,
    'import fs from "node:fs";\n' +
    'import { withLock } from ' + JSON.stringify(storeModule) + ';\n' +
    'const [,, lock, store, m] = process.argv;\n' +
    'for (let i = 0; i < Number(m); i++) {\n' +
    '  withLock(lock, () => { const n = parseInt(fs.readFileSync(store, "utf8"), 10); fs.writeFileSync(store, String(n + 1)); });\n' +
    '}\n');
  const { spawn } = await import("node:child_process");
  const N = 4, M = 25;
  await Promise.all(Array.from({ length: N }, () => new Promise((res, rej) => {
    const c = spawn(process.execPath, [worker, lock, store, String(M)], { stdio: "ignore" });
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error("worker exit " + code))));
    c.on("error", rej);
  })));
  // A no-op or non-exclusive lock loses updates and yields < N*M; only true cross-process mutual
  // exclusion produces exactly N*M. This was intermittently flaky on Windows before withLock's
  // acquire-loop catch also retried EPERM/EACCES/EBUSY (a concurrent unlink/create of the lockfile
  // between two DIFFERENT worker processes surfaces as those codes, not EEXIST) -- the retry is
  // what makes this deterministic now.
  assert.equal(parseInt(fs.readFileSync(store, "utf8"), 10), N * M);
});

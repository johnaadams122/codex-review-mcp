// hooks/atomic-store.mjs -- shared durable-commit + tolerant reader.
// direct.mjs's queueMetaWrite serializes INTRA-process only; this is the cross-process-safe primitive.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const RETRYABLE = new Set(["EPERM", "EEXIST", "EACCES"]);

export function atomicWriteJSON(finalPath, obj, deps = {}) {
  const mkdir = deps.mkdir ?? fs.mkdirSync;
  const writeFile = deps.writeFile ?? fs.writeFileSync;
  const rename = deps.rename ?? fs.renameSync;
  const rm = deps.rm ?? fs.rmSync;
  mkdir(path.dirname(finalPath), { recursive: true });
  const tmp = path.join(path.dirname(finalPath), path.basename(finalPath) + "." + randomUUID() + ".tmp");
  writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try { rename(tmp, finalPath); return; }
    catch (e) { lastErr = e; if (!RETRYABLE.has(e && e.code)) break; }
  }
  try { rm(tmp, { force: true }); } catch { /* best-effort */ }
  throw lastErr ?? new Error("atomicWriteJSON: rename failed");
}

// Quarantine a corrupt store aside (never overwrite it) and throw ECORRUPT so a strict caller
// fails closed. Best-effort rename; the throw is the contract even if the rename fails.
function quarantineCorrupt(finalPath, reason, deps = {}) {
  const rename = deps.rename ?? fs.renameSync;
  const dest = finalPath + ".corrupt-" + randomUUID();
  try { rename(finalPath, dest); } catch { /* best-effort; the throw below is the real guard */ }
  const err = new Error("readJSON: corrupt store " + finalPath + " (" + reason + ") quarantined to " + dest);
  err.code = "ECORRUPT";
  err.quarantined = dest;
  throw err;
}

// Distinguish MISSING (ENOENT -> fallback, a legitimately-absent fresh store) from CORRUPT
// (existing bytes that fail JSON.parse). CORRUPT under strict mode -> quarantine + throw, so a
// journal/budget is NEVER silently reset (the marker.mjs torn-erase bug that would reopen a spent
// budget). Non-strict keeps Phase-1 advisory tolerance (returns fallback).
export function readJSON(finalPath, fallback = null, deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const strict = deps.strict === true;
  let raw;
  try { raw = readFile(finalPath); }
  catch (e) { if (e && e.code === "ENOENT") return fallback; if (strict) throw e; return fallback; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { if (strict) return quarantineCorrupt(finalPath, e.message, deps); return fallback; }
  // Must be a PLAIN object map. An ARRAY passes `typeof === "object"` but named runId props added to
  // an array are dropped by JSON.stringify -> a debit could be "recorded" yet never persisted. Reject it.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  if (strict) return quarantineCorrupt(finalPath, Array.isArray(parsed) ? "array-not-object-map" : "not-an-object", deps);
  return fallback;
}

import { CONFIG } from "./gate-run.config.mjs";

// isPidAlive INLINED here (3 lines, node builtins only) rather than imported from ../jobs.mjs, so
// that loading atomic-store -> run-journal -> gate-run/gate-surface does NOT pull jobs.mjs into the
// hook top-level graph ("no panel/jobs chain at hook top level"). Verified equivalent to
// jobs.mjs:25-29 (true on EPERM = "exists but not ours").
function _isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

// Synchronous sleep that BLOCKS without pegging a CPU core (Atomics.wait on a throwaway SAB).
// Injectable so tests pass sleep:()=>{} and rely on maxSpins to bound the loop.
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB blocked -> no wait */ }
}

export function withLock(lockPath, fn, deps = {}) {
  const openSync = deps.open ?? fs.openSync;
  const closeSync = deps.close ?? fs.closeSync;
  const writeSync = deps.write ?? fs.writeSync;
  const rm = deps.rm ?? fs.rmSync;
  const statSync = deps.stat ?? fs.statSync;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? _isPidAlive;
  const sleep = deps.sleep ?? sleepSync;
  const staleMs = deps.staleMs ?? CONFIG.ttl.lockStaleMs;
  const maxSpins = deps.maxSpins ?? 50;
  const spinMs = deps.spinMs ?? 20;
  const mkdir = deps.mkdir ?? fs.mkdirSync;
  mkdir(path.dirname(lockPath), { recursive: true }); // the lock's .superpowers dir may not exist on a fresh repo -> openSync("wx") would ENOENT before the first atomicWriteJSON creates it (C#2)

  // Break a lock ONLY when it is provably abandoned. A fresh/live lock (incl. an EMPTY file in the
  // holder's open->write init window) is NEVER broken -- that was the v4 fail-open. Before ANY rm we
  // CONFIRM-SAME-OWNER: re-read and require the lock to be byte-identical to what we judged abandoned
  // (read->confirm-same-owner->rm). A contender that already
  // broke+re-acquired between our judgement and our rm leaves DIFFERENT content, so we must not rm its
  // now-LIVE lock (the ABA break: two contenders reading the same dead owner each rm the other's fresh
  // lock and both enter the critical section). This narrows the race to a 2-syscall read2->rm TOCTOU;
  // the residual is bounded by the daily job cap. (Full ABA-freedom would need a rename-based break --
  // deliberately NOT taken; the read-confirm approach was chosen.)
  const tryTakeStale = () => {
    let raw;
    try { raw = readFile(lockPath); } catch { return false; }               // gone already -> let openSync("wx") race
    let owner = null;
    try { owner = JSON.parse(raw); } catch { owner = null; }
    if (owner && Number.isFinite(owner.pid) && Number.isFinite(owner.at)) {
      let dead = false;
      try { dead = isPidAlive(owner.pid) === false; } catch { dead = false; } // unknown -> not-dead (fail-safe)
      if (!(dead && (now() - owner.at) > staleMs)) return false;             // live holder / not past TTL -> respect it (even a slow fn())
      let raw2;
      try { raw2 = readFile(lockPath); } catch { return false; }             // vanished under us -> let openSync race
      if (raw2 !== raw) return false;                                        // stamp CHANGED -> another contender owns it now; do NOT rm (ABA break)
      try { rm(lockPath, { force: true }); return true; } catch { return false; }
    }
    // unparseable/empty/incomplete: possibly a lock mid-init. Break ONLY if the FILE mtime itself is
    // past staleMs (a genuinely abandoned corrupt lock), never a freshly-created empty one. Same
    // confirm-before-rm discipline: re-stat and require the mtime UNCHANGED before removing (a lock
    // re-created under us has a fresher mtime -> we back off).
    let mtimeMs;
    try { mtimeMs = statSync(lockPath).mtimeMs; } catch { return false; }
    if (!((now() - mtimeMs) > staleMs)) return false;
    let mtime2;
    try { mtime2 = statSync(lockPath).mtimeMs; } catch { return false; }
    if (mtime2 !== mtimeMs) return false;                                    // changed under us -> do NOT rm
    try { rm(lockPath, { force: true }); return true; } catch { return false; }
  };

  let fd = null;
  for (let spin = 0; spin <= maxSpins; spin++) {   // bounded by ITERATION COUNT, never a clock compare
    try { fd = openSync(lockPath, "wx"); break; }
    catch (e) {
      // On Windows a concurrent unlink/create of the lockfile (the normal release<->acquire race
      // between two DIFFERENT processes) surfaces as EPERM/EACCES/EBUSY (pending-delete / sharing
      // violation), not EEXIST. That is transient contention, not a fatal error -- treat it the same
      // as EEXIST and retry within the bounded spin loop. A genuine permission error still fails
      // after maxSpins via the "could not acquire" throw below, so this can never hang.
      if (e && (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY")) {
        if (tryTakeStale()) continue;              // broke an abandoned lock -> retry open now
        if (spin < maxSpins) sleep(spinMs);        // bounded wait for the holder; NOT while(now()<end)
        continue;
      }
      throw e;
    }
  }
  if (fd === null) throw new Error("withLock: could not acquire " + lockPath);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: now() })); // stamp owner immediately
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { rm(lockPath, { force: true }); } catch { /* ignore */ }
  }
}

// hooks/run-journal.mjs -- the .superpowers/gate-runs.json model.
import path from "node:path";
import { atomicWriteJSON, readJSON, withLock } from "./atomic-store.mjs";
import { CONFIG } from "./gate-run.config.mjs"; // needed by the corrupt-guard below

// Terminal states all rank 3; running ranks 1 (a late "running" can never roll back a terminal).
export const RUN_STATE_RANK = { running: 1, skipped: 3, pass: 3, block: 3, error: 3, failed: 3 };

export function journalPath(repoRoot) { return path.join(repoRoot, ".superpowers", "gate-runs.json"); }
export function lockPath(repoRoot) { return path.join(repoRoot, ".superpowers", "gate-runs.lock"); }

// Local-tz calendar-day key YYYY-MM-DD. Defined HERE because readJournal's
// corrupt-guard below needs it (the budget code also uses it; it is NOT re-defined there).
export function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// STRICT by default: missing -> {}, but a CORRUPT journal quarantines + throws (never read as empty
// -> never torn-erase a spent budget). A caller can pass strict:false for an advisory read.
// On ECORRUPT it ALSO persists a budget-exhausted GUARD for today so that SUBSEQUENT ops fail closed
// too (readJSON quarantined the corrupt file aside, so a naive next read would see ENOENT->{} and
// reopen the spent budget). The current op still throws (fail-closed). Recovers next dayKey.
export function readJournal(repoRoot, deps = {}) {
  try {
    return readJSON(journalPath(repoRoot), {}, { strict: true, ...deps });
  } catch (e) {
    if (e && e.code === "ECORRUPT" && deps.__corruptGuardWritten !== true) {
      // deps.now may be a withLock-convention now() returning a NUMBER (Date.now-style), since
      // upsertRun threads the same deps into both withLock (numeric now) and readJournal (Date
      // now). dayKey() needs a Date, so coerce a numeric result before calling it -- otherwise a
      // caller-injected numeric deps.now breaks the "STRICT always throws ECORRUPT" contract with
      // a TypeError on (number).getFullYear() instead (review fix, deliberate deviation from the
      // plan's verbatim Step-3 code).
      const nowRaw = (deps.now ?? (() => new Date()))();
      const key = dayKey(typeof nowRaw === "number" ? new Date(nowRaw) : nowRaw);
      const guard = { ["__corrupt_guard__:" + key]: { status: "skipped", dayKey: key, jobs_submitted: CONFIG.budget.dailyJobCap, surfaced: true, failure_reason: "corrupt_journal" } };
      try { atomicWriteJSON(journalPath(repoRoot), guard, deps); } catch { /* best-effort; the throw is the guard for THIS op */ }
    }
    throw e;
  }
}

// deps may carry CAS expectations: deps.expectSeq / deps.expectEpoch (kept in deps so the 4-arg
// signature is identical for every writer). A failed CAS writes NOTHING and returns {conflict:true}.
export function upsertRun(repoRoot, runId, patch, deps = {}) {
  return withLock(lockPath(repoRoot), () => {
    const journal = readJournal(repoRoot, deps);           // strict: corrupt -> throw, aborts the write
    const cur = journal[runId] ?? { seq: 0 };
    if (deps.expectSeq !== undefined && (cur.seq ?? 0) !== deps.expectSeq) return { conflict: true, cur };
    if (deps.expectEpoch !== undefined && cur.attemptEpoch !== deps.expectEpoch) return { conflict: true, cur };
    const p = { ...patch };
    if (p.status !== undefined) {
      const curRank = RUN_STATE_RANK[cur.status] ?? -1;
      const nxtRank = RUN_STATE_RANK[p.status] ?? -1;
      // FIRST-TERMINAL-WINS (curRank>=3) + no downgrade (nxt<cur): a terminal entry never changes
      // status again. When the losing status is dropped, DROP ITS VERDICT-IDENTITY FIELDS TOO, so a
      // reaper FAILED cannot smear "supervisor_reaped"/its reviewer/attempts onto a real PASS.
      if (curRank >= 3 || nxtRank < curRank) {
        delete p.status; delete p.failure_reason; delete p.reviewer;
        delete p.verdictPath; delete p.attempts; delete p.strength_attested; delete p.attemptEpoch;
        delete p.reclaimed_jobs; // reaper's jobId audit is part of the terminalize it just lost
      }
    }
    const merged = { ...cur, ...p, seq: (cur.seq ?? 0) + 1 };
    journal[runId] = merged;
    atomicWriteJSON(journalPath(repoRoot), journal, deps);
    return merged;
  }, deps);
}

// PERSISTED per-targetKey generation protocol (mirrors the generation protocol in direct.mjs). In-memory Maps
// would be a no-op across the launcher/child/reaper PROCESS split (each process minted epoch 1).
// The epoch lives on the journal; coordination is the lock + CAS, never shared memory.
// (RUN_STATE_RANK/withLock/readJournal/atomicWriteJSON/journalPath/lockPath are ALREADY in module
// scope -- do NOT import them here.)

export function nextAttemptEpoch(journal, targetKey) {
  let max = 0;
  for (const e of Object.values(journal || {})) {
    if (e && e.targetKey === targetKey && Number.isFinite(e.attemptEpoch)) max = Math.max(max, e.attemptEpoch);
  }
  return max + 1;
}

// The atomic claim: debounce-recheck + epoch mint + running write, ALL under one lock.
// Does its own fs I/O -- must NOT call upsertRun (withLock is not reentrant).
export function claimAttempt(repoRoot, { runId, targetKey, dayKey, entry = {} }, deps = {}) {
  return withLock(lockPath(repoRoot), () => {
    const journal = readJournal(repoRoot, deps); // strict: corrupt -> throw, aborts the claim
    for (const e of Object.values(journal)) {
      // Debounce on any LIVE (nonterminal) attempt for these exact bytes, REGARDLESS of dayKey -- a run
      // straddling midnight (dayKey changes) must not launch the same targetKey twice.
      if (e && e.targetKey === targetKey && (RUN_STATE_RANK[e.status] ?? 0) < 3) {
        return { claimed: false, reason: "debounced" };
      }
    }
    const attemptEpoch = nextAttemptEpoch(journal, targetKey);
    const merged = { ...entry, status: "running", targetKey, dayKey, attemptEpoch, seq: 1, surfaced: false };
    journal[runId] = merged;
    atomicWriteJSON(journalPath(repoRoot), journal, deps);
    return { claimed: true, attemptEpoch, entry: merged };
  }, deps);
}

// Cheap unlocked PRE-check; the authoritative gate is upsertRun's expectEpoch CAS at commit.
// Live iff the epoch still matches AND the entry is still nonterminal -- once the reaper terminalizes
// (and bumps the epoch), the child's next rung sees !live and aborts superseded (no attempt-2 spend).
export function isLiveEpoch(repoRoot, runId, epoch, deps = {}) {
  const e = readJournal(repoRoot, deps)[runId];
  return Boolean(e && e.attemptEpoch === epoch && (RUN_STATE_RANK[e.status] ?? 0) < 3);
}

// Persisted analog of direct.mjs control.expired: the STANDALONE supersession primitive -- stamp every
// LIVE entry for this targetKey with a fresh epoch so an in-flight child's expectEpoch commit CAS
// fails. The reaper INLINES an equivalent bump into its single terminalize write (one
// locked op, not two); this exported form is for a future "a newer attempt supersedes" path and is
// exercised by the epoch test. (If no such caller ever lands, delete it -- do not add a second
// reaper lock-acquire just to route through it.)
export function bumpEpoch(repoRoot, targetKey, deps = {}) {
  return withLock(lockPath(repoRoot), () => {
    const journal = readJournal(repoRoot, deps);
    const next = nextAttemptEpoch(journal, targetKey);
    let bumped = 0;
    for (const [id, e] of Object.entries(journal)) {
      if (e && e.targetKey === targetKey && (RUN_STATE_RANK[e.status] ?? 0) < 3) {
        journal[id] = { ...e, attemptEpoch: next, seq: (e.seq ?? 0) + 1 }; bumped++;
      }
    }
    if (bumped) atomicWriteJSON(journalPath(repoRoot), journal, deps);
    return bumped;
  }, deps);
}

// NOTE: `CONFIG` and `dayKey` are ALREADY imported/defined earlier in this same module
// (readJournal's corrupt-guard needs them) -- do NOT re-import CONFIG or re-declare dayKey here.

// CLOCK-ROLLBACK GUARD: the budget day-key is MONOTONIC = max(dayKey(now), the
// max dayKey already in the journal). YYYY-MM-DD sorts lexicographically = chronologically, so a
// clock rolled back to a lower-spend day cannot resurrect budget -- the effective day stays at the
// max seen, and today's spend still counts against it until the clock genuinely advances past it.
export function effectiveDayKey(journal, now = new Date()) {
  let max = dayKey(now);
  for (const e of Object.values(journal || {})) if (e && typeof e.dayKey === "string" && e.dayKey > max) max = e.dayKey;
  return max;
}

export function todaysSubmitted(repoRoot, now = new Date(), deps = {}) {
  const journal = readJournal(repoRoot, deps);
  const key = effectiveDayKey(journal, now);
  let sum = 0;
  for (const e of Object.values(journal)) {
    if (e && e.dayKey === key) sum += (e.jobs_submitted ?? 0);
  }
  return sum;
}

export function reserveOK(repoRoot, n, now = new Date(), deps = {}) {
  return todaysSubmitted(repoRoot, now, deps) + n <= CONFIG.budget.dailyJobCap;
}

// WRITE-AHEAD HARD GATE: the cap recheck and the increment are in ONE locked critical section, so
// two callers at 9/10 cannot both reach 10 and 11 (a double-spend). A crash after increment/
// before submit over-counts (conservative); a billed job is NEVER refunded, so submit->crash->
// resubmit is bounded by the daily cap. Returns { ok, over?, count } where `count` is the NEW DAILY
// TOTAL; a false `ok` VETOES the submit. The day-key is the clock-rollback-guarded effectiveDayKey.
export function recordSubmission(repoRoot, runId, now = new Date(), deps = {}) {
  const cap = deps.dailyJobCap ?? CONFIG.budget.dailyJobCap;
  return withLock(lockPath(repoRoot), () => {
    const journal = readJournal(repoRoot, deps);      // strict: corrupt -> throw, never a phantom-0 budget
    const key = effectiveDayKey(journal, now);
    let today = 0;
    for (const e of Object.values(journal)) if (e && e.dayKey === key) today += (e.jobs_submitted ?? 0);
    if (today + 1 > cap) return { ok: false, over: true, count: today };  // VETO -- do NOT submit
    const cur = journal[runId] ?? { seq: 0, jobs_submitted: 0 };
    // RESET on a day-boundary cross: cur.dayKey is the run's LAST-STAMPED day, which can lag the
    // freshly-computed `key` (effectiveDayKey) when a long-lived run straddles midnight. Carrying
    // cur.jobs_submitted (yesterday's cumulative count) forward under today's key would poison
    // todaysSubmitted's derived sum for EVERY run that day (review fix, deliberate deviation from
    // the plan's verbatim Step-3 code -- see task-5-report.md Fix pass).
    const carried = cur.dayKey === key ? (cur.jobs_submitted ?? 0) : 0;
    const merged = { ...cur, jobs_submitted: carried + 1, dayKey: key, seq: (cur.seq ?? 0) + 1 };
    journal[runId] = merged;
    atomicWriteJSON(journalPath(repoRoot), journal, deps);
    return { ok: true, count: today + 1 };            // the NEW DAILY TOTAL (not this run's count)
  }, deps);
}

// Persist reviewer jobIds so the reaper can OBSERVE (never kill) a leaked
// reviewer worker after a detached-gate hard-crash. Fired by the child's afterSubmit seam AFTER submit
// (the jobId now EXISTS; it would not at the beforeSubmit seam). This is
// ADDITIVE audit metadata: it preserves `status` (never resurrects a terminal/reaped entry), dedups, and
// bounds growth. It is NOT a budget gate -- recordSubmission is the write-ahead cost gate; this records
// identity only. Best-effort by contract (the fan-out swallows a throw), but still atomic under the lock.
export function recordJobId(repoRoot, runId, jobId, deps = {}) {
  if (!jobId) return { ok: false };
  return withLock(lockPath(repoRoot), () => {
    const journal = readJournal(repoRoot, deps);      // strict read: a corrupt store throws, never a phantom entry
    const cur = journal[runId] ?? { seq: 0 };
    const jobIds = Array.isArray(cur.jobIds) ? cur.jobIds.slice() : [];
    const id = String(jobId);
    if (!jobIds.includes(id)) jobIds.push(id);
    if (jobIds.length > 64) jobIds.splice(0, jobIds.length - 64);   // bound growth (drop-oldest, fail-safe)
    journal[runId] = { ...cur, jobIds, seq: (cur.seq ?? 0) + 1 };   // ...cur PRESERVES status/dayKey/jobs_submitted
    atomicWriteJSON(journalPath(repoRoot), journal, deps);
    return { ok: true, jobIds };
  }, deps);
}

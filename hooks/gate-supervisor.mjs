// hooks/gate-supervisor.mjs -- journal-sweeping reaper. The direct-dir
// sweep is deletion-only and RETAINS dead-pid+nonterminal (direct.mjs:1171); this closes that hole
// for the gate-runs.json journal a crashed detached cli.mjs gate leaves behind. Terminalization is a
// STATE WRITE (no worker kill -> PID-reuse-irrelevant). A child that wrote verdict.json before dying
// is reconciled to its REAL verdict. The epoch is BUMPED so a late rung is superseded.
// Reviewer-worker RECLAIM: jobIds persisted by the child's afterSubmit seam
// (populatable now that afterSubmit fires AFTER submit) are RECORDED on the terminalize patch as
// `reclaimed_jobs` -- the runId->jobId AUDIT LINKAGE for a crashed run. The node reaper does NOT query the
// companion and NEVER kills: the ACTUAL leaked-worker cleanup belongs to a separate external reaper job
// (outside this repo) that reads the codex-companion job records and kills/marks-failed stale reviewer
// workers, bound to pid and start time.
// So this stays a FAST, SYNCHRONOUS state-only sweep; reclaim only runs on a TRUE reap (no bound verdict).
import { isPidAlive as _isPidAlive } from "../jobs.mjs";       // reaper is NOT a hot hook -> jobs.mjs OK here
import path from "node:path";
import { readJSON } from "./atomic-store.mjs";
import { readJournal, upsertRun as _upsertRun, RUN_STATE_RANK } from "./run-journal.mjs";

export function sweepJournal(repoRoot, deps = {}) {
  const isPidAlive = deps.isPidAlive ?? _isPidAlive;
  const upsertRun = deps.upsertRun ?? _upsertRun;
  const readVerdict = deps.readVerdict ?? ((p) => readJSON(p, null));
  // Module convention (run-journal.mjs / withLock): an injected deps.now returns a NUMBER; coerce to a
  // Date so now.getTime() works for a numeric OR Date injection (matches readJournal/surfaceOnce -- the
  // third and last consumer to get this coercion).
  const nowRaw = (deps.now ?? (() => new Date()))();
  const now = typeof nowRaw === "number" ? new Date(nowRaw) : nowRaw;
  const journal = readJournal(repoRoot, deps);
  const TERMINAL = new Set(["pass", "block", "failed", "error"]);
  let reaped = 0;
  for (const [runId, e] of Object.entries(journal)) {
    if (!e || e.status !== "running") continue;
    // A NO-pid entry is NOT dead (the post-spawn pid-write may be racing/lost) -> only reap once expired.
    let dead = false;
    if (e.pid) { try { dead = isPidAlive(e.pid) === false; } catch { dead = false; } }
    const expired = e.deadlineAt && new Date(e.deadlineAt).getTime() <= now.getTime();
    if (!dead && !expired) continue; // alive/within-deadline (or no-pid + not-expired) -> leave running
    // verdict.json reconciliation: a child that wrote its artifact then died mid-reconcile has a REAL
    // verdict on disk -> use it (never clobber a PASS to FAILED). BUMP the epoch so a still-in-flight
    // rung is superseded (its next isLiveEpoch + reconcile expectEpoch CAS both fail).
    const bumped = (e.attemptEpoch ?? 0) + 1;
    const v = readVerdict(path.join(repoRoot, ".superpowers", "gate-runs", runId, "verdict.json"));
    // BIND the artifact to THIS run + THESE bytes before trusting it: a stale/misplaced/tampered
    // verdict.json must NOT fabricate a PASS for a different run or different diff.
    const vBound = v && typeof v.status === "string" && TERMINAL.has(v.status) && v.runId === runId && v.diffId === e.diffId;
    let patch;
    if (vBound) {
      patch = { status: v.status, reviewer: v.reviewer, failure_reason: v.failure_reason, diffId: v.diffId, attempts: v.attempts, strength_attested: v.strength_attested, attemptEpoch: bumped };
    } else {
      // TRUE reap (no bound verdict): RECORD this run's persisted reviewer jobIds as the audit linkage.
      // Best-effort snapshot subset -- the entry's jobIds[] (merged fresh under the lock by recordJobId) is
      // AUTHORITATIVE; on the expired-but-ALIVE path a wedged child may append more after this snapshot
      // No companion query, no kill: the external reaper job owns worker cleanup.
      const reclaimed_jobs = Array.isArray(e.jobIds) && e.jobIds.length ? e.jobIds.slice() : undefined;
      patch = { status: "failed", failure_reason: (expired && !dead) ? "deadline_exceeded" : "supervisor_reaped", attemptEpoch: bumped, ...(reclaimed_jobs ? { reclaimed_jobs } : {}) };
    }
    const out = upsertRun(repoRoot, runId, patch, deps);
    if (out && out.status && (RUN_STATE_RANK[out.status] ?? 0) >= 3) reaped++;
  }
  return { reaped };
}

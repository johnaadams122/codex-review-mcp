// hooks/gate-run.config.mjs -- single authoritative config of record.
// Telemetry-tuned placeholders carry conservative defaults; change ONLY here.
// The auto-gate project allowlist is NOT here: it is the optional `gateAllowlist` array in the project
// policy settings file (see policy.mjs). Default empty, so nothing is auto-gated until it is listed.
import { cachedPolicyConfig } from "../policy.mjs";

// TODO(telemetry): placeholder #1 -- trigger signal. Lean "commit" (immutable diff by SHA).
// TODO(telemetry): placeholder #2 -- dailyJobCap. 20 standard reviewer-JOBS/day (~10 impl gates @ 2 jobs).
export const CONFIG = Object.freeze({
  trigger: "commit",
  budget: Object.freeze({ dailyJobCap: 20 }),
  deadlines: Object.freeze({
    perAttemptMs: 8 * 60 * 1000,   // impl panel REVIEW budget
    rungWallMs: 14 * 60 * 1000,    // REAL per-rung wall (submit ~5m + poll ~8m); the reaper deadline uses this, NOT perAttemptMs
    killWaitMs: 10000,             // reuse direct.mjs KILL_WAIT_MS
    ladderMarginMs: 60 * 1000,     // total-ladder = maxCodex*rungWallMs + margin
  }),
  cadenceMs: 15 * 60 * 1000,       // reuse direct.mjs SWEEP_INTERVAL_MS
  ttl: Object.freeze({
    lockStaleMs: 30 * 1000,        // stale-lock takeover (by lockfile mtime)
    claimStaleMs: 5 * 60 * 1000,   // catch-up re-claim of a "claiming" entry
  }),
  attempts: Object.freeze({ maxCodex: 2 }),
});

// The names are the UNDERSCORE project ids resolvePolicy() returns. A hyphenated form matches nothing and
// would skip every real commit (the v4 dead-on-arrival blocker).
export function isAllowlisted(projectName, config = cachedPolicyConfig()) {
  return config.gateAllowlist.includes(String(projectName ?? ""));
}

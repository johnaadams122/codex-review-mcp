// review-detach.mjs -- detached review submission.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { resolveCompanionPath, mergeExtraEnv, controlTimeoutMs, isPidAlive } from "./jobs.mjs";

export const DISCOVERY_TIMEOUT_DEFAULT_MS = 60000;
export const DISCOVERY_TIMEOUT_FLOOR_MS = 5000;
export const DISCOVERY_POLL_DEFAULT_MS = 1500;
export const DISCOVERY_POLL_FLOOR_MS = 250;
export const CONTROL_CLAMP_FLOOR_MS = 1000;
export const SETTLE_WINDOW_MS = 5000;
export const SWEEP_BUDGET_MS = 10000;
export const SWEEP_ATTEMPTS = 3;
export const TAG_ENV = "CODEX_COMPANION_SESSION_ID";
export const APP_SERVER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const LOG_SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A unique, parseable, unreachable pipe endpoint. Requesting a broker at a
// dead address makes the companion's withAppServer fall back to a DIRECT
// (broker-less) app-server child of the review process: the review thread
// stays in OUR child's tree (SessionEnd broker teardown cannot touch it, and
// killProcessTreeVerified genuinely stops the review).
export function deadBrokerEndpoint(tag) {
  return "pipe:\\\\.\\pipe\\" + tag;
}

function positiveIntOr(def, raw) {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);                       // strict: "5000junk" -> NaN -> default
  return Number.isInteger(n) && n > 0 ? n : def;
}

export function discoveryKnobs(env = process.env) {
  const timeoutMs = Math.max(DISCOVERY_TIMEOUT_FLOOR_MS,
    positiveIntOr(DISCOVERY_TIMEOUT_DEFAULT_MS, env.CODEX_REVIEW_DISCOVERY_TIMEOUT_MS));
  let pollIntervalMs = Math.max(DISCOVERY_POLL_FLOOR_MS,
    positiveIntOr(DISCOVERY_POLL_DEFAULT_MS, env.CODEX_REVIEW_DISCOVERY_POLL_MS));
  pollIntervalMs = Math.min(pollIntervalMs, Math.floor(timeoutMs / 2));
  return { timeoutMs, pollIntervalMs };
}

export function clampControlTimeout(remainingMs, controlMs) {
  const control = Number.isFinite(controlMs) && controlMs > 0 ? controlMs : 30000;
  const remaining = Number.isFinite(remainingMs) ? remainingMs : CONTROL_CLAMP_FLOOR_MS;
  const capped = Math.min(control, Math.max(CONTROL_CLAMP_FLOOR_MS, remaining));
  return Math.max(CONTROL_CLAMP_FLOOR_MS, capped);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

export function dedupeById(records) {
  const seen = new Set(); const out = [];
  for (const r of records ?? []) {
    const id = r && r.id;
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(r);
  }
  return out;
}

export function matchTagged(records, { tag, childPid, kind }) {
  // The child env (tag included) is inherited by the direct
  // app-server's tool descendants, so a nested companion invocation could
  // mint a SAME-TAG record. Filter class/kind, prefer OUR live pid, and
  // tie-break multiple terminals by earliest createdAt (nested records are
  // created strictly after ours).
  // kind is REQUIRED: fail-closed guard against kind-less records
  if (typeof kind !== "string" || kind === "") return { record: null };
  const tagged = dedupeById(records).filter((r) =>
    r.sessionId === tag && r.jobClass === "review" && r.kind === kind);   // kind REQUIRED: an omitted kind matches nothing - fail-closed, never wrong-kind attribution
  const running = tagged.find((r) => (r.status === "running" || r.status === "queued") && r.pid === childPid);
  if (running) return { record: running };
  // running tagged record with a foreign pid: defensive no-match, keep polling
  const terminals = tagged.filter((r) => TERMINAL_STATUSES.has(r.status));
  if (terminals.length === 0) return { record: null };
  if (terminals.length > 1) {
    // Partition terminals into finite-createdAt and non-finite (fail-closed on NaN).
    // Date.parse of unparseable string returns NaN; NaN in a sort comparator
    // treats NaN as +0, leaving array-order-dependent results. Mirror matchUntagged
    // discipline: only finite dates can win the tie-break.
    const finiteTerminals = terminals.filter((r) => {
      const created = Date.parse(r.createdAt ?? "");
      return Number.isFinite(created);
    });
    if (finiteTerminals.length > 0) {
      finiteTerminals.sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
      return { record: finiteTerminals[0], multiple: true };
    }
    // No deterministic earliest exists; fail-closed, caller keeps polling
    return { record: null, multiple: true };
  }
  return { record: terminals[0] };
}

export function matchUntagged(records, { childPid, spawnedAtMs, nowMs = Date.now() }) {
  for (const r of dedupeById(records)) {
    if (r.status !== "running") continue;
    if (r.jobClass !== "review") continue;                             // symmetry with the kind filter
    if (!String(r.id).startsWith("review-")) continue;
    if (r.pid !== childPid) continue;
    const created = Date.parse(r.createdAt ?? "");
    if (!Number.isFinite(created)) continue;
    // V2 sol P1: lower bound is spawnedAtMs EXACTLY -- a backward-skew window
    // admitted a stranger's pre-spawn record whose dead pid the OS reused for
    // our child. The companion stamps createdAt on the same machine clock
    // strictly after our spawn, so no backward tolerance is needed.
    if (created < spawnedAtMs || created > nowMs) continue;            // upper bound NOW: no forward slack
    return { record: r };
  }
  return { record: null };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function killProcessTreeVerified(pid, deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const alive = deps.isPidAlive ?? isPidAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const bound = deps.taskkillBoundMs ?? 5000;
  if (!pid) return { verified: true };
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    let proc;
    try {
      proc = spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { finish(); return; }
    proc.on("error", finish);
    proc.on("close", finish);
    const t = setTimeout(finish, bound);
    if (typeof t.unref === "function") t.unref();
  });
  for (let i = 0; i < 5; i++) {
    if (!alive(pid)) return { verified: true };
    await sleep(200);
  }
  return { verified: !alive(pid) };
}

function reviewError(code, detail) {
  const err = new Error(code + (detail ? ": " + detail : ""));
  err.code = code;
  return err;
}

export const LOG_SWEEP_MAX_FILES = 400;

// Where review logs and handoff records go. CODEX_REVIEW_LOG_DIR is a test-isolation seam (production
// never sets it): tests point it at a private folder so they stop writing into, and sweeping, the live
// server's folder. Read per call, not at import. A folder named by the seam is swept of this module's
// own file names only, so a mis-set value (a leaked test env, a typo) cannot delete anyone else's files.
export function reviewLogDir(env = process.env) {
  const v = env.CODEX_REVIEW_LOG_DIR;
  if (typeof v === "string" && v.trim() !== "") return { dir: path.resolve(v.trim()), ownFilesOnly: true };
  return { dir: path.join(os.tmpdir(), "codex-mcp-reviews"), ownFilesOnly: false };
}

// The names submitDetachedReview writes: <tag>.log and <tag>.handoff.json, tag = "cmr-" + a UUID.
const OWN_LOG_NAME = /^cmr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(log|handoff\.json)$/i;

// ownFilesOnly: consider (delete, and count toward the cap) only OWN_LOG_NAME files; see reviewLogDir.
export function sweepOldLogs(dir, nowMs = Date.now(), { ownFilesOnly = false } = {}) {
  try {
    const kept = [];
    for (const f of fs.readdirSync(dir)) {
      if (ownFilesOnly && !OWN_LOG_NAME.test(f)) continue;
      const p = path.join(dir, f);
      try {
        const mtime = fs.statSync(p).mtimeMs;
        if (nowMs - mtime > LOG_SWEEP_AGE_MS) { fs.unlinkSync(p); continue; }
        kept.push({ p, mtime });
      } catch { /* best-effort */ }
    }
    // Rescue minor 3: the sweep only runs on the NEXT submission, so age alone
    // lets a hot week grow the dir unbounded -- cap the count too (newest kept).
    if (kept.length > LOG_SWEEP_MAX_FILES) {
      kept.sort((a, b) => b.mtime - a.mtime);
      for (const e of kept.slice(LOG_SWEEP_MAX_FILES)) {
        try { fs.unlinkSync(e.p); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

function tailOf(logFile, bytes = 2000) {
  try {
    const buf = fs.readFileSync(logFile, "utf8");
    return buf.slice(-bytes);
  } catch { return "(log unreadable)"; }
}

async function defaultListJobs(cwd, extraEnv, timeoutMs) {
  const { runCompanion } = await import("./jobs.mjs");
  const { stdout } = await runCompanion(["status", "--all", "--json", "--cwd", cwd], { cwd, extraEnv, timeoutMs });
  const payload = JSON.parse(stdout);
  if (Array.isArray(payload)) return payload;
  const items = [];
  if (Array.isArray(payload.running)) items.push(...payload.running);
  if (payload.latestFinished) items.push(payload.latestFinished);
  if (Array.isArray(payload.recent)) items.push(...payload.recent);
  if (Array.isArray(payload.jobs)) items.push(...payload.jobs);
  return items;
}

export async function submitDetachedReview({ argv, cwd }, deps = {}) {
  const resolvedCwd = path.resolve(cwd ?? process.cwd());
  const tag = "cmr-" + randomUUID();
  const spawnFn = deps.spawn ?? spawn;
  const listJobsFn = deps.listJobsFn ?? ((extraEnv, timeoutMs) => defaultListJobs(resolvedCwd, extraEnv, timeoutMs));
  const killFn = deps.killFn ?? killProcessTreeVerified;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const pidAlive = deps.isPidAlive ?? isPidAlive;
  const { timeoutMs, pollIntervalMs } = discoveryKnobs(process.env);

  const { dir: logDir, ownFilesOnly } = reviewLogDir(process.env);
  fs.mkdirSync(logDir, { recursive: true });
  sweepOldLogs(logDir, now(), { ownFilesOnly });
  const logFile = path.join(logDir, tag + ".log");

  const fd = fs.openSync(logFile, "a");
  // Terra review P2 (review-mrxdafdc): capture BEFORE spawn -- with the exact
  // (no-backward-skew) lower bound, a record the child creates the instant it
  // boots must never be able to precede our timestamp, even under extreme
  // scheduler preemption between spawn() and a later capture.
  const spawnedAtMs = now();
  let child;
  try {
    child = spawnFn(process.execPath, [resolveCompanionPath(), ...argv], {
      cwd: resolvedCwd,
      // BOTH overrides - the tag (discovery + job-cleanup exemption) and
      // the dead-pipe endpoint (direct app-server mode: SessionEnd survival +
      // the kill path actually reaching the review thread).
      env: mergeExtraEnv(process.env, { [TAG_ENV]: tag, [APP_SERVER_ENDPOINT_ENV]: deadBrokerEndpoint(tag) }),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd]
    });
  } catch (e) {
    // A synchronous spawnFn throw (invalid option, EMFILE-class)
    // must reject with the PROMISED coded error, not the raw exception.
    // finally below still runs exactly once after this rethrow.
    throw reviewError("review_spawn_error", String(e && e.message) + " log: " + logFile);
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }

  const state = { exited: false, exitCode: undefined, spawnError: null };
  const onError = (e) => { state.spawnError = e; };
  const onExit = (code) => { state.exited = true; state.exitCode = code; };
  child.on("error", onError);
  child.on("exit", onExit);
  child.unref();

  // Restart-orphan explainability: an MCP restart mid-discovery
  // loses the in-memory tag, orphaning a live tagged review that is then visible
  // only in unfiltered listings. Persist a handoff record beside the log so an
  // operator (or a future sweeper) can re-associate tag -> pid/log/cwd after a
  // restart. Best-effort; swept with the log dir (age + count caps).
  try {
    fs.writeFileSync(path.join(logDir, tag + ".handoff.json"), JSON.stringify({
      tag, childPid: child.pid ?? null, cwd: resolvedCwd, kind: argv[0] ?? null,
      logFile, spawnedAt: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
    }) + "\n");
  } catch { /* best-effort */ }

  // Success cleanup: drop our listeners before returning.
  const succeed = (record) => {
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
    return { job_id: record.id, status: record.status };
  };
  const failSpawn = () => reviewError("review_spawn_error", String(state.spawnError.message) + " log: " + logFile);

  const deadline = spawnedAtMs + timeoutMs;
  const control = controlTimeoutMs();
  const kind = argv[0];   // "review" | "adversarial-review" (kind filter)
  let pidMismatchLogged = false;
  let multiplicityLogged = false;

  const pollOnce = async (extraEnv, budgetMs) => {
    try { return await listJobsFn(extraEnv, clampControlTimeout(budgetMs, control)); }
    catch { return null; }   // ANY failure -> retry under the deadline
  };
  const taggedMatch = (records) => {
    const m = matchTagged(records, { tag, childPid: child.pid, kind });
    if (m.multiple && !multiplicityLogged) {   // nested same-tag record
      multiplicityLogged = true;
      // Guard (final-gate I2): the all-non-finite-createdAt branch returns
      // {record: null, multiple: true} (no deterministic earliest exists) --
      // m.record.id would be a null-deref TypeError on that shape.
      process.stderr.write("review-detach: multiple tagged terminal records for " + tag +
        "; selected earliest createdAt " + (m.record ? m.record.id : "(none - fail-closed)") + "\n");
    }
    if (!m.record && !pidMismatchLogged) {   // attribution-failure observability
      const stranger = dedupeById(records ?? []).find((r) =>
        r.sessionId === tag && (r.status === "running" || r.status === "queued") && r.pid !== child.pid);
      if (stranger) {
        pidMismatchLogged = true;
        process.stderr.write("review-detach: tagged running record " + stranger.id +
          " pid " + stranger.pid + " != child " + child.pid + "\n");
      }
    }
    return m;
  };

  while (now() < deadline) {
    if (state.spawnError) throw failSpawn();
    const records = await pollOnce({ [TAG_ENV]: tag }, deadline - now());
    if (records) {
      const { record } = taggedMatch(records);
      // Terminal record: safe to return regardless of exit ordering.
      if (record && TERMINAL_STATUSES.has(record.status)) return succeed(record);
      // NON-terminal record: honor it ONLY while the child is alive. A dead
      // child behind a running record is the frozen case -- settle handles it.
      // (The record's pid is frozen in the store; pid equality alone cannot
      // prove liveness. This ordering is the fix for the check-order defect.)
      // Liveness re-check (final-gate I1): !state.exited alone cannot close
      // the OS-dead-but-exit-event-unobserved TOCTOU window -- the child can
      // die between our poll dispatch and Node delivering "exit". Corroborate
      // with a live isPidAlive probe; a dead child's running record must fall
      // through to settle -> frozen reject, not a false "running" success.
      if (record && !state.exited && pidAlive(child.pid)) return succeed(record);
    }
    if (state.exited) return await settleAfterExit();
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }

  // Deadline expired.
  if (state.spawnError) throw failSpawn();
  if (state.exited) return await settleAfterExit();
  // Last-resort untagged sweep: OWN fixed budget, retried.
  const sweepEnd = now() + SWEEP_BUDGET_MS;
  for (let i = 0; i < SWEEP_ATTEMPTS && now() < sweepEnd; i++) {
    const records = await pollOnce({ [TAG_ENV]: null }, sweepEnd - now());
    if (records) {
      const { record } = matchUntagged(records, { childPid: child.pid, spawnedAtMs, nowMs: now() });
      // Liveness re-check (final-gate I1): same TOCTOU close as the discovery
      // loop above -- a dead child behind a running record must defer to
      // settle, never resolve as a live "running" success.
      if (record && !state.exited && pidAlive(child.pid)) return succeed(record);
    }
    if (state.spawnError) throw failSpawn();
    if (state.exited) return await settleAfterExit();
    await sleep(Math.min(pollIntervalMs, Math.max(1, sweepEnd - now())));
  }
  if (state.exited) return await settleAfterExit();   // disarm: exit observed -> never kill
  const kill = await killFn(child.pid);
  if (!kill.verified) {
    // Rescue minor 5: copy-pastable recovery for the operator.
    throw reviewError("review_kill_unverified", "pid " + child.pid + " log: " + logFile +
      " recover: taskkill /PID " + child.pid + " /T /F");
  }
  // Rescue minor 2: name the likely causes so a capacity prune is
  // operator-distinguishable from a plain slow store.
  throw reviewError("review_discovery_timeout", "pid " + child.pid + " log: " + logFile +
    " (record never discovered: submission may have ghosted under the store race" +
    " or been pruned by the companion MAX_JOBS=50 cap)");

  async function settleAfterExit() {
    if (state.spawnError) throw failSpawn();
    const settleEnd = now() + SETTLE_WINDOW_MS;
    let lastTagged = null;
    let emptyReads = 0;
    while (now() < settleEnd) {
      const records = await pollOnce({ [TAG_ENV]: tag }, settleEnd - now());
      if (records) {
        const m = taggedMatch(records);   // hardened selection (kind filter, earliest-terminal tie-break)
        if (m.record && TERMINAL_STATUSES.has(m.record.status)) return succeed(m.record);   // record beats exit code
        // Fail fast: abnormal exit + no tagged record
        // on TWO CONSECUTIVE successful reads. Never one - a transient-empty
        // store read must not pre-empt a finalized FAILED record.
        // "consecutive" counts SUCCESSFUL reads only. A FAILED poll between two
        // successful empty reads does NOT reset the streak -- poll failures
        // produce no store evidence either way, so they neither corroborate nor
        // refute emptiness. Only a successful NON-empty read (tagged record
        // seen) resets the counter.
        if (m.record) { lastTagged = m.record; emptyReads = 0; }
        else if (!lastTagged) { emptyReads += 1; if (emptyReads >= 2 && state.exitCode !== 0) break; }
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, settleEnd - now())));
    }
    if (lastTagged) {
      throw reviewError("review_died_record_frozen", "job_id " + lastTagged.id + " log: " + logFile);
    }
    const abnormal = state.exitCode !== 0;   // null (signal) counts as abnormal
    // pid + log PATH alongside the tail.
    if (abnormal) {
      throw reviewError("review_child_failed", "exit " + state.exitCode + " pid " + child.pid +
        " log: " + logFile + " tail: " + tailOf(logFile));
    }
    throw reviewError("review_completed_untracked", "pid " + child.pid +
      " log: " + logFile + " tail: " + tailOf(logFile));
  }
}

export const _internals = { sweepOldLogs };

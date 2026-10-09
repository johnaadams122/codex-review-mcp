import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { cachedPolicyConfig } from "./policy.mjs";
import { submitDetachedReview, killProcessTreeVerified } from "./review-detach.mjs";
import {
  isCwdOwned,
  isOwned,
  crossStoreError,
  normalizeOwnerPath,
  sanitizeSnapshot,
  sanitizeResultPayload,
  sanitizeJobRecord,
} from "./job-guard.mjs";

// ---- in-process submitted-job registry --------
//
// Keeping the job's session ownership in an on-disk token sidecar would be forgeable: the
// sidecar would store a session token in a predictable, shared, per-user directory and any
// same-user process could write a stamp binding a known jobId to its own token and pass the
// gate -- leaking the bearer credential and opening a foreign job's status/result/wait/cancel.
//
// For stdio MCP, same-session == same-process, so "this session
// submitted the job" needs no credential on disk at all -- it is simply "this jobId is
// in the set of ids THIS process submitted". A module-level registry, populated at
// submission, carries it. Nothing is written to disk, so there is nothing to forge,
// overwrite, or sweep. A process restart empties the set; read-back then falls to the
// owner path (b), which is the documented and accepted behaviour.
//
// The registry is a Map jobId -> normalized target cwd. Membership answers path (a)
// (isSubmittedBySelf); the stored cwd lets listJobs decide whether a foreign store is
// even worth querying (hasSubmittedForCwd) without spawning the companion against it.
const submittedJobs = new Map();

// Record a job this process just submitted. Called at submit time for every id the
// companion prints (including a ghost-resubmitted fresh id). No-op on a bad id.
export function recordSubmittedJob(jobId, cwd = null) {
  if (typeof jobId === "string" && jobId) submittedJobs.set(jobId, normalizeOwnerPath(cwd) ?? "");
  return jobId;
}

// (a) SAME-SESSION path: did THIS process submit this job? deps.submittedJobs (a Set or
// Map) overrides the module registry for tests; absence + unknown id fail closed.
export function isSubmittedBySelf(jobId, deps = {}) {
  if (typeof jobId !== "string" || !jobId) return false;
  const reg = deps.submittedJobs ?? submittedJobs;
  return typeof reg.has === "function" && reg.has(jobId);
}

// Did THIS session submit any job under `cwd`? Lets listJobs fail a foreign, unstamped
// cwd closed to empty WITHOUT spawning the companion against a store nothing is readable
// in. Only a Map (jobId -> cwd) carries cwds; a bare Set has none, so it answers false.
export function hasSubmittedForCwd(cwd, deps = {}) {
  if (cwd === null || cwd === undefined || cwd === "") return false;
  const reg = deps.submittedJobs ?? submittedJobs;
  const want = normalizeOwnerPath(cwd);
  if (!want || typeof reg.values !== "function") return false;
  for (const v of reg.values()) {
    if (typeof v === "string" && v && normalizeOwnerPath(v) === want) return true;
  }
  return false;
}

// Test-only: drop everything this process has recorded (simulate a fresh process).
export function _resetSubmittedJobs() { submittedJobs.clear(); }

// Read gate: a job-control read/cancel is allowed iff
//   (a) THIS process submitted the job -- the same-session path, which restores
//       submit-then-poll for ANY admitted target cwd within the session (review
//       wait:true, panel/reviewers fan-out, cross-project delegate); OR
//   (b) the job's store resolves to the server's own owner workspace -- the owner
//       path (job-guard.isCwdOwned), for cross-session pickup within the owning project.
// Everything else fails closed. A job this process did NOT submit is visible only under
// (b). Path (a) is checked FIRST so a foreign-but-same-session cwd is admitted before
// the (b) filesystem work.
export function isReadAllowed(jobId, cwd, deps = {}) {
  if (isSubmittedBySelf(jobId, deps)) return true;   // (a) this process submitted it
  return isCwdOwned(cwd, deps);                       // (b) owner workspace
}

// F5 timeout split. Data plane (submit task/review): the companion may do real work.
export function companionTimeoutMs() { return parseInt(process.env.CODEX_COMPANION_TIMEOUT_MS ?? "300000", 10); }
// Control plane (status/result/list/cancel): on-disk state reads -- must never hang the
// broker. Fail direction: CLOSED -- on expiry the companion tree is killed and the call
// rejects; a wedged companion cannot block the MCP server past this budget.
export function controlTimeoutMs() { return parseInt(process.env.CODEX_CONTROL_TIMEOUT_MS ?? "30000", 10); }

export function buildTreeKillArgs(pid) { return ["taskkill", "/PID", String(pid), "/T", "/F"]; }

function killProcessTree(pid) {
  if (!pid) return;
  try { const [c, ...rest] = buildTreeKillArgs(pid); spawn(c, rest, { stdio: "ignore" }); } catch { /* best-effort */ }
}

// Injectable seam so tests can spy on the kill without spawning taskkill.
// killTreeVerified is assigned after the import cycle settles (review-detach
// imports from this module too; the binding is live at call time).
export const _internals = { killProcessTree, killTreeVerified: (pid) => killProcessTreeVerified(pid) };

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }   // EPERM => exists but not ours
}

// The codex companion plugin folder (the one holding scripts/codex-companion.mjs) comes from, in order:
// a non-empty CLAUDE_PLUGIN_ROOT env var, then the settings file's companionPluginRoot (policy.mjs).
// There is no built-in default location: with neither, it is a coded error, not a guess.
export function resolveCompanionPath() {
  let root = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof root !== "string" || root === "") root = cachedPolicyConfig().companionPluginRoot;
  if (typeof root !== "string" || root === "") {
    const err = new Error("the codex companion plugin folder is not configured: set CLAUDE_PLUGIN_ROOT, or companionPluginRoot in the project policy settings file, to the folder that contains scripts/codex-companion.mjs");
    err.code = "companion_plugin_root_unset";
    throw err;
  }
  return path.join(root, "scripts", "codex-companion.mjs");
}

export function buildTaskArgs(prompt, opts = {}) {
  const args = ["task", "--background", "--json"];
  if (opts.write) args.push("--write");
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.model) args.push("--model", opts.model);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  // A large payload (e.g. a git diff for a review panel) cannot ride on argv --
  // Windows CreateProcess caps the command line near 32K. When promptFile is set,
  // the companion reads the prompt from the file (readTaskPrompt -> fs.readFileSync)
  // and the positional prompt is omitted.
  if (opts.promptFile) {
    args.push("--prompt-file", opts.promptFile);
  } else {
    args.push("--", prompt);
  }
  return args;
}

export function buildReviewArgs(opts = {}) {
  const args = ["review", "--json", "--background"];
  if (opts.base) args.push("--base", opts.base);
  if (opts.scope) args.push("--scope", opts.scope);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export function buildAdversarialReviewArgs(focus, opts = {}) {
  const args = ["adversarial-review", "--json", "--background"];
  if (opts.base) args.push("--base", opts.base);
  if (opts.scope) args.push("--scope", opts.scope);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.model) args.push("--model", opts.model);
  if (focus) args.push(focus);
  return args;
}

export function mergeExtraEnv(base, extra) {
  const env = { ...base };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) delete env[k];
      else env[k] = String(v);
    }
  }
  return env;
}

export async function runCompanion(args, opts = {}) {
  const companionPath = resolveCompanionPath();
  const cwd = opts.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const outChunks = [];
    const errChunks = [];
    const proc = spawn(process.execPath, [companionPath, ...args], {
      cwd,
      env: mergeExtraEnv(process.env, opts.extraEnv)
    });

    const TMO = opts.timeoutMs ?? companionTimeoutMs();
    const timer = TMO > 0
      ? setTimeout(() => { _internals.killProcessTree(proc.pid); proc.kill(); reject(new Error(`companion timed out after ${TMO}ms`)); }, TMO)
      : null;

    proc.stdout.on("data", (chunk) => outChunks.push(chunk));
    proc.stderr.on("data", (chunk) => errChunks.push(chunk));
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString("utf8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`companion exited ${code}: ${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr, code });
      }
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// -------- ghost-submission guard --------
// The companion's updateState is an UNLOCKED read-modify-write of the shared
// state.json, and saveState deletes the job file + log of any job absent from
// its (possibly stale) list. Two concurrent companion processes -> lost
// update: a sibling's saveState physically unlinks a just-created job AFTER
// its jobId was printed -- a perfect ghost (observed as whole panels
// of lens jobs ghosting, and panels reporting "1/3 lenses completed").
// The worker's next status upsert re-inserts a transiently-deleted RUNNING
// record, so the fatal window is submit-print -> first worker upsert. Guard:
// verify the record is readable after submit (missing -> settle -> re-verify),
// resubmit once, and fail LOUD with a coded error if both attempts ghost.
export async function submitWithGhostRetry(submitOnce, cwd, deps = {}) {
  const getStatusFn = deps.getStatusFn ?? getStatus;
  const sleepFn = deps.sleep ?? sleep;
  const settleMs = deps.settleMs ?? 300;
  // A lost record whose worker ALREADY runs
  // can resurrect via a worker upsert far past our settle window -- an auto
  // resubmission then runs TWO workers. Read-only submissions tolerate that
  // worst case (duplicate spend, no interference), so they keep the retry;
  // write-capable submissions must NEVER risk two agents editing one checkout
  // -- they fail LOUD as ambiguous instead of resubmitting.
  const allowResubmit = deps.allowResubmit ?? true;
  const attempts = allowResubmit ? 2 : 1;
  const persisted = async (jobId) => {
    // Only the companion's explicit missing-job signal counts as a ghost;
    // any other status error (timeout etc.) must NOT trigger a resubmission.
    try { await getStatusFn(jobId, cwd); return true; }
    catch (e) { return !isJobMissingError(e); }
  };
  const ghosted = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const payload = await submitOnce();
    const jobId = payload && payload.jobId;
    if (!jobId) return payload;              // no id to verify -- caller keeps its shape handling
    if (await persisted(jobId)) return payload;
    await sleepFn(settleMs);                 // deletion race may settle (worker upsert resurrects)
    if (await persisted(jobId)) return payload;
    ghosted.push(jobId);
  }
  const err = new Error("task_submission_ghosted: companion printed job id(s) " + ghosted.join(", ") +
    " but no record persisted after " + attempts + " attempt(s) (companion store lost-update race)" +
    (allowResubmit ? "" : "; auto-resubmit suppressed for a write-capable task -- verify no worker is running before retrying"));
  err.code = "task_submission_ghosted";
  throw err;
}

export async function submitTask(prompt, opts = {}, deps = {}) {
  const runCompanionFn = deps.runCompanionFn ?? runCompanion;
  const args = buildTaskArgs(prompt, opts);
  // Record the job in this process's submitted set the instant its id
  // exists -- BEFORE the ghost-verify getStatus, so a foreign-but-admitted target cwd
  // passes its own read gate. A ghost resubmission records the fresh id.
  const submitOnce = async () => {
    const payload = JSON.parse((await runCompanionFn(args, { cwd: opts.cwd })).stdout);
    if (payload && payload.jobId) recordSubmittedJob(payload.jobId, opts.cwd);
    return payload;
  };
  const payload = await submitWithGhostRetry(submitOnce, opts.cwd, { allowResubmit: !opts.write, ...deps });
  return { job_id: payload.jobId, status: payload.status };
}

// Submit a background task whose prompt is delivered via --prompt-file instead of argv.
// The companion resolves the prompt synchronously at submit time (handleTask calls
// readTaskPrompt -> fs.readFileSync BEFORE the --background branch persists the request),
// so the temp file is safe to delete as soon as runCompanion resolves -- the detached
// worker reads the persisted request, not this file. Bypasses the ~32K argv limit.
export async function submitTaskViaFile(promptText, opts = {}, deps = {}) {
  const runCompanionFn = deps.runCompanionFn ?? runCompanion;
  const dir = opts.tmpDir ?? os.tmpdir();
  const file = path.join(dir, `codex-panel-${randomUUID()}.txt`);
  fs.writeFileSync(file, String(promptText ?? ""), "utf8");
  try {
    const args = buildTaskArgs("", { ...opts, promptFile: file });
    const submitOnce = async () => {
      const payload = JSON.parse((await runCompanionFn(args, { cwd: opts.cwd })).stdout);
      if (payload && payload.jobId) recordSubmittedJob(payload.jobId, opts.cwd);   // in-process submit record
      return payload;
    };
    // The prompt file outlives the whole retry window (finally below): a ghost
    // resubmission re-reads it at its own submit time.
    const payload = await submitWithGhostRetry(submitOnce, opts.cwd, { allowResubmit: !opts.write, ...deps });
    return { job_id: payload.jobId, status: payload.status };
  } finally {
    try { fs.unlinkSync(file); } catch { /* best-effort cleanup */ }
  }
}

// Reviews run DETACHED: the companion ignores
// --background for reviews, so jobs.mjs spawns the review child itself --
// unique session-id tag, dead-pipe endpoint (direct app-server mode), store
// discovery, no submit timer. See review-detach.mjs.
export async function submitReview(opts = {}, deps = {}) {
  const r = await submitDetachedReview({ argv: buildReviewArgs(opts), cwd: opts.cwd });
  if (r && r.job_id) recordSubmittedJob(r.job_id, opts.cwd);   // in-process submit record (review wait:true poll)
  return r;
}

export async function submitAdversarialReview(focus, opts = {}, deps = {}) {
  const r = await submitDetachedReview({ argv: buildAdversarialReviewArgs(focus, opts), cwd: opts.cwd });
  if (r && r.job_id) recordSubmittedJob(r.job_id, opts.cwd);   // in-process submit record
  return r;
}

// Pull the assistant's final answer text out of a getResult() payload, whatever shape it took.
// The normal companion `result` payload nests it under storedJob.result.rawOutput (full text) or
// job.summary (short answers); the stuck-job fallback returns { output }. storedJob.summary holds
// the PROMPT, never the answer -- do not read it. Owning this here keeps callers (e.g. the review
// panel decoder) from reaching into companion transport internals.
export function extractAnswerText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  return (
    result.output ??
    result.storedJob?.result?.rawOutput ??
    result.job?.summary ??
    result.rendered ??
    result.summary ??
    ""
  );
}

// Returns the assistant message captured in progressPreview, or null.
export function extractCapturedMessage(preview) {
  if (!Array.isArray(preview)) return null;
  for (const line of preview) {
    const m = String(line).match(/^Assistant message captured:\s*([\s\S]*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

// True when the companion captured a final answer but never transitioned
// status to "completed" (inferred-completion race with process exit).
export function isStuckFinalizing(job) {
  if (!job || job.status !== "running") return false;
  const preview = job.progressPreview ?? [];
  return (
    preview.some((l) => String(l).includes("Turn completion inferred")) &&
    preview.some((l) => String(l).startsWith("Assistant message captured:"))
  );
}

// Patches a snapshot so a stuck-finalizing job appears completed.
// Adds _synthesized:true so callers can distinguish from a real terminal state.
function synthesizeIfStuck(snapshot) {
  const job = snapshot && snapshot.job ? snapshot.job : snapshot;
  if (!isStuckFinalizing(job)) return snapshot;
  const captured = extractCapturedMessage(job.progressPreview);
  const patched = Object.assign({}, job, { status: "completed", phase: "done", _synthesized: true });
  if (captured !== null) patched.summary = captured;
  return snapshot && snapshot.job ? Object.assign({}, snapshot, { job: patched }) : patched;
}

export async function getStatus(jobId, cwd, deps = {}) {
  // Gate: allowed iff THIS process submitted the job (same-session path --
  // restores submit-then-poll for any admitted target cwd) OR the cwd resolves to the
  // server's own owner workspace. Refused fail-closed BEFORE any companion spawn.
  if (!isReadAllowed(jobId, cwd, deps)) throw crossStoreError("status", jobId);
  const runCompanionFn = deps.runCompanionFn ?? runCompanion;
  const args = ["status", jobId, "--json"];
  if (cwd) args.push("--cwd", cwd);
  const { stdout } = await runCompanionFn(args, { cwd, timeoutMs: controlTimeoutMs() });
  // Redact the persisted prompt (summary/request.prompt) BEFORE synthesizeIfStuck:
  // for a stuck-finalizing job the synthesize step overwrites `summary` with the
  // captured ANSWER, which must survive (and is what the owner is waiting for).
  const sanitized = sanitizeSnapshot(JSON.parse(stdout), cwd, deps);
  return synthesizeIfStuck(sanitized);
}

// Scan every companion workspace store on disk for jobs/<jobId>.json. Job ids
// are globally unique (timestamp+random), so an id-keyed scan is unambiguous --
// and it sidesteps the documented cwd-scoping trap (a job living under a
// different workspace hash than the lookup's cwd, seen 2x in the field).
function diskStoreRoots() {
  const roots = [];
  if (process.env.CLAUDE_PLUGIN_DATA) roots.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "state"));
  roots.push(path.join(os.tmpdir(), "codex-companion"));
  return roots;
}

export function readJobRecordFromDisk(jobId, deps = {}) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9._-]+$/.test(jobId)) return null;   // path-safety
  const fsx = deps.fs ?? fs;
  // A job THIS process submitted is ours wherever it physically lives (a
  // foreign-but-admitted target cwd's store), so the disk-scan recovery honors the
  // same-session path too -- checked once up front by the unique id.
  const selfSubmitted = isSubmittedBySelf(jobId, deps);
  for (const root of deps.roots ?? diskStoreRoots()) {
    let dirs;
    try { dirs = fsx.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      let rec;
      try { rec = JSON.parse(fsx.readFileSync(path.join(root, d, "jobs", jobId + ".json"), "utf8")); }
      catch { continue; }   // not in this workspace store -- keep scanning
      // Gate: this scan crosses ALL workspace stores by unique id. Only return a
      // record the server owns -- by same-session submit (a), or by workspaceRoot /
      // physical store-dir match (b). A record this process did not submit, with no
      // workspaceRoot, is returned only from the server's own store; else fail closed.
      if (selfSubmitted || isOwned({ workspaceRoot: rec.workspaceRoot ?? null, storeDir: path.basename(d) }, deps)) return rec;
    }
  }
  return null;
}

export async function getResult(jobId, cwd, deps = {}) {
  // Gate: same-session path OR owner path (see getStatus). Fail-closed before spawn.
  if (!isReadAllowed(jobId, cwd, deps)) throw crossStoreError("result", jobId);
  const runCompanionFn = deps.runCompanionFn ?? runCompanion;
  const readDiskFn = deps.readJobRecordFromDiskFn ?? readJobRecordFromDisk;
  const getStatusFn = deps.getStatusFn ?? getStatus;
  try {
    const args = ["result", jobId, "--json"];
    if (cwd) args.push("--cwd", cwd);
    const { stdout } = await runCompanionFn(args, { cwd, timeoutMs: controlTimeoutMs() });
    return sanitizeResultPayload(JSON.parse(stdout), cwd, deps);   // redact the persisted prompt
  } catch (err) {
    // Companion rejects stuck-running, orphaned, and store-dropped jobs
    // ("No job found" / "No finished job found").
    if (!/No (?:finished )?job found/i.test(err.message)) throw err;
    // Disk-store fallback FIRST (store-race root cause): the
    // per-job file carries the FULL result.rawOutput, which beats the
    // status-fallback's progressPreview capture (preview truncation was a
    // parse_failed source in panel decodes). Automates the manual recovery
    // that worked repeatedly in the field. The disk scan is owner-gated inside
    // readJobRecordFromDisk (a foreign-owned record is never returned), and the
    // recovered record is prompt-redacted before it leaves this function.
    const rec = readDiskFn(jobId, deps);
    if (rec && TERMINAL.has(rec.status) && rec.result) {
      return { status: rec.status === "canceled" ? "cancelled" : rec.status,
        storedJob: sanitizeJobRecord(rec, cwd, deps), _diskRecovered: true };
    }
    // Status fallback: extract the inferred answer from progressPreview if the
    // companion captured one (stuck-finalizing class).
    let snapshot;
    try {
      snapshot = await getStatusFn(jobId, cwd, deps);
    } catch (_) {
      throw err; // status also unavailable -- re-throw original error
    }
    const job = snapshot && snapshot.job ? snapshot.job : snapshot;
    const captured = extractCapturedMessage(job && job.progressPreview);
    if (captured === null) throw err;
    return { output: captured, status: "completed", _synthesized: true };
  }
}

// Command line of a live pid via CIM (wmic is gone on current Win11). Returns
// null on any failure -- callers treat null as "identity unverifiable".
export function getPidCommandLine(pid, deps = {}) {
  const spawnSyncFn = deps.spawnSync ?? spawnSync;
  try {
    const r = spawnSyncFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + Number(pid) + "').CommandLine"],
      { encoding: "utf8", windowsHide: true, timeout: 8000 });
    if (!r || r.error || r.status !== 0) return null;
    const line = String(r.stdout ?? "").trim();
    return line || null;
  } catch { return null; }
}

export async function cancelJob(jobId, cwd, deps = {}) {
  // Gate: cancel is a cross-store WRITE (it tree-kills a worker and asks the
  // companion to rewrite the record), so it is gated identically to the reads -- same-
  // session path OR owner path. A foreign cwd this process did not submit under is
  // refused fail-closed before any status snapshot or companion cancel spawn, closing
  // the cross-store-cancel hole.
  if (!isReadAllowed(jobId, cwd, deps)) throw crossStoreError("cancel", jobId);
  const getStatusFn = deps.getStatusFn ?? getStatus;
  const runCompanionFn = deps.runCompanionFn ?? runCompanion;
  const alive = deps.isPidAliveFn ?? isPidAlive;
  const killTree = deps.killTreeVerifiedFn ?? ((pid) => _internals.killTreeVerified(pid));
  const pidCommandLine = deps.getPidCommandLineFn ?? getPidCommandLine;

  // MSYS-cancel defect: the companion's handleCancel
  // (a) shells its own taskkill through win32 `shell: SHELL || true` -- under a
  // Git-Bash-hosted session MSYS mangles /PID into a path, so ITS kill never
  // lands on this host -- and (b) unconditionally rewrites the record with
  // pid:null + status "cancelled" regardless of kill outcome. The post-cancel
  // record can therefore never tell us what to kill: snapshot the pid BEFORE
  // companion cancel, then tree-kill it OURSELVES (direct argv spawn, no shell,
  // no MSYS) with liveness verification.
  let prePid = null;
  try {
    const snap = await getStatusFn(jobId, cwd);
    const job = snap && snap.job ? snap.job : snap;   // {job:{...}} or {...}
    if (job && Number.isInteger(job.pid) && job.pid > 0) prePid = job.pid;
  } catch { /* status unavailable -- companion cancel may still bookkeep */ }

  const args = ["cancel", jobId, "--json"];
  if (cwd) args.push("--cwd", cwd);
  let payload = null;
  let cancelError = null;
  try {
    const { stdout } = await runCompanionFn(args, { cwd, timeoutMs: controlTimeoutMs() });
    payload = JSON.parse(stdout);
  } catch (e) {
    cancelError = e;
  }

  let kill = null;
  if (prePid !== null) {
    if (!alive(prePid)) {
      kill = { pid: prePid, verified: true, already_dead: true };
    } else {
      // The job can finish between our
      // snapshot and this point, and Windows can reuse the pid -- corroborate
      // process IDENTITY before a tree-kill (same discipline as the reaper's
      // pid+identity rule; a codex worker/review child always carries "codex"
      // in its command line). Unverifiable or foreign identity -> SKIP the
      // kill (fail-closed against killing a stranger; the skip is reported).
      const cmdline = pidCommandLine(prePid);
      if (typeof cmdline === "string" && /codex/i.test(cmdline)) {
        kill = { pid: prePid, ...(await killTree(prePid)) };
      } else {
        kill = { pid: prePid, verified: false, skipped: "identity_unverified",
          identity: cmdline === null ? "unreadable" : "non-codex" };
      }
    }
  }

  if (cancelError) {
    // Frozen/ghost records (outside the companion's running[] set) make its
    // cancel reject with "No job found" -- if we verifiably killed the worker
    // anyway, the cancel is EFFECTIVE: report it rather than discarding a
    // successful kill. An unverified kill still rethrows (never a false
    // "cancelled" while the worker may live).
    if (kill && kill.verified) {
      return { jobId, status: "cancelled", companion_cancel_error: cancelError.message, kill };
    }
    throw cancelError;
  }
  return kill ? { ...payload, kill } : payload;
}

export function buildStatusArgs(opts = {}) {
  const args = ["status", "--all", "--json"];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  return args;
}

export async function listJobs(opts = {}, deps = {}) {
  // codex_list_jobs lists the UNION of (a) jobs THIS process submitted and
  // (b) jobs whose store is the server's own owner workspace. The companion lists one
  // store per cwd, so:
  //  - an OWNED cwd -> every returned item physically lives in the owner store (b);
  //  - a FOREIGN cwd -> only items this process submitted (a) are readable there.
  // A foreign cwd this process submitted nothing under is fail-closed empty WITHOUT
  // spawning the companion against a foreign store (nothing there is readable anyway).
  const cwdOwned = isCwdOwned(opts.cwd, deps);
  if (!cwdOwned && !hasSubmittedForCwd(opts.cwd, deps)) return [];
  const runCompanionFn = deps.runCompanionFn ?? runCompanion;
  const args = buildStatusArgs(opts);
  const { stdout } = await runCompanionFn(args, { cwd: opts.cwd, timeoutMs: controlTimeoutMs() });
  const payload = JSON.parse(stdout);
  let items;
  if (Array.isArray(payload)) items = payload;
  else if (Array.isArray(payload.jobs)) items = payload.jobs;
  else {
    items = [];
    if (Array.isArray(payload.running)) items.push(...payload.running);
    if (payload.latestFinished) items.push(payload.latestFinished);
    if (Array.isArray(payload.recent)) items.push(...payload.recent);
  }
  return items
    .filter((it) => {
      const id = it && (it.id ?? it.jobId);
      if (isSubmittedBySelf(id, deps)) return true;                     // (a) our session's job
      if (!cwdOwned) return false;                                      // foreign store: only (a) is readable
      // (b) owner store: keep unless the item explicitly names a foreign workspaceRoot.
      return !(it && it.workspaceRoot) || isOwned({ workspaceRoot: it.workspaceRoot, storeDir: null }, deps);
    })
    .map((it) => sanitizeJobRecord(it, opts.cwd, deps));
}

// -------- generic poll-to-completion (C1; moved here from panel.mjs) --------
//
// pollToTerminal is vendor-neutral: it takes a getStatus fn so any ReviewerProvider (or the
// companion) can be polled. TERMINAL covers success AND failure terminals. `canceled` (companion
// spelling) is normalized to `cancelled`.
//
// Two distinct non-success outcomes, both fail-CLOSED (the poller never throws-orphans and never
// invents a success state):
//   not_found -- the companion reports the job MISSING ("No job found"): the phantom-job case where
//                task --background printed an id but never persisted a job file. This is TERMINAL --
//                stop polling immediately; waiting cannot make a job that never existed appear.
//   timeout   -- the deadline elapsed with the job still running, OR a persistent NON-missing
//                status-error (e.g. the status endpoint is transiently down). Genuinely-still-slow.
// Keeping these separate lets consumers tell "job never existed" from "job too slow".

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TERMINAL = new Set(["completed", "succeeded", "failed", "error", "cancelled", "canceled"]);

// The companion's missing-job signal, surfaced as a rejection from the `status` subcommand for a
// phantom/unknown job id. This is DISTINCT from "No finished job found" (the job EXISTS but has not
// finished yet -> still running/timeout), which must NOT be treated as not_found.
const JOB_MISSING_RE = /No job found/i;
export function isJobMissingError(err) {
  return !!err && JOB_MISSING_RE.test(String((err && err.message) ?? err));
}

export async function pollToTerminal(
  jobId,
  { cwd, timeoutMs = 480000, pollIntervalMs = 3000, missingReadsBeforeNotFound = 2 } = {},
  getStatusFn = getStatus
) {
  const started = Date.now();
  let missed = 0;
  for (;;) {
    let snap;
    try {
      snap = await getStatusFn(jobId, cwd);
    } catch (err) {
      // Missing job -> terminal not_found, but only on TWO consecutive missing
      // reads over a short settle (store-race root cause: a sibling
      // process's saveState lost-update transiently DELETES a live job's
      // record; the worker's next upsert resurrects it -- one missing read is
      // no longer proof of a phantom). Still bounded: a true phantom resolves
      // in <=2 reads. A non-missing status-error is folded into timeout only
      // once the deadline has passed (fail-closed, never a success).
      //
      // missingReadsBeforeNotFound raises that bar per caller (default 2, unchanged). The review
      // panel passes a higher value: there the job id came from a VERIFIED submit, so a missing
      // read is far likelier to be the transient deletion than a phantom -- and the cost of a
      // false not_found is discarding a completed multi-minute flagship review, which the panel
      // then reports as an abstention and fails closed on. Asymmetric enough to wait longer.
      if (isJobMissingError(err)) {
        missed++;
        if (missed < missingReadsBeforeNotFound) { await sleep(Math.min(pollIntervalMs, 1500)); continue; }
        return "not_found";
      }
      if (Date.now() - started > timeoutMs) return "timeout";
      await sleep(pollIntervalMs);
      continue;
    }
    missed = 0;   // any successful read resets the missing streak
    const job = snap && snap.job ? snap.job : snap;
    const st = job && job.status;
    if (st && TERMINAL.has(st)) return st === "canceled" ? "cancelled" : st;
    if (Date.now() - started > timeoutMs) return "timeout";
    await sleep(pollIntervalMs);
  }
}

// waitForResult (C1): poll to terminal, then fetch the result ONLY on a success terminal.
// m10 -- explicit return shapes, all fail-CLOSED (never orphans, never a phantom result):
//   success  (completed|succeeded)  -> { status, result, job_id }
//   failure  (failed|error)         -> { status, job_id }             (no getResult call)
//   cancel   (cancelled)            -> { status:"cancelled", job_id }  (no getResult call)
//   not_found (companion "No job found" / phantom) -> { status:"not_found", job_id } (no getResult call)
//   timeout / persistent non-missing status-err    -> { status:"timeout", job_id }   (no getResult call)
//   result-error (getResult throws) -> { status:"result_error", job_id, error }
// not_found is kept DISTINCT from timeout so callers can tell "job never existed" from "job too slow".
export async function waitForResult(jobId, opts = {}) {
  const { cwd, timeoutMs = 480000, pollIntervalMs = 3000, getStatusFn = getStatus, getResultFn = getResult } = opts;
  // Fail CLOSED and FAST when neither the same-session path nor the owner
  // path grants access -- a cross_store wait must surface a clear error immediately, never
  // spin to a timeout sentinel. A same-session foreign-cwd wait (review wait:true, panel
  // poll) passes via the same-session path.
  if (!isReadAllowed(jobId, cwd, opts)) throw crossStoreError("wait", jobId);
  const status = await pollToTerminal(jobId, { cwd, timeoutMs, pollIntervalMs }, getStatusFn);
  if (status === "timeout") return { status: "timeout", job_id: jobId };
  if (status === "not_found") return { status: "not_found", job_id: jobId };
  if (status !== "completed" && status !== "succeeded") return { status, job_id: jobId };
  try {
    const result = await getResultFn(jobId, cwd, opts);
    return { status, result, job_id: jobId };
  } catch (err) {
    return { status: "result_error", job_id: jobId, error: err.message };
  }
}

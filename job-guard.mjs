// job-guard.mjs -- the READ-boundary owner gate + prompt-redaction layer for the
// job-control endpoints (codex_status / codex_result / codex_wait / codex_list_jobs).
//
// Confidentiality: the submission
// side (admission.mjs/policy.mjs) is gated, but the READ side would otherwise return persisted
// prompts + raw results across ALL cwd stores with no ownership check. The
// companion's own status/result/status--all are workspace-scoped, so the leak
// surfaced two ways: (1) the `cwd` tool argument is caller-supplied and untrusted
// -- a session bound to project A could pass cwd=B and read B's job store; and
// (2) jobs.mjs's own readJobRecordFromDisk (the store-race recovery)
// scans EVERY workspace store on disk by job id, ignoring cwd.
//
// This module supplies:
//   - a store-identity function matching the companion's lib/state.mjs naming, so
//     jobs.mjs can decide ownership WITHOUT importing the black-box companion;
//   - an owner gate anchored on the SERVER INSTANCE's own cwd (process.cwd(), the
//     trusted identity -- the tool `cwd` argument is not), mirroring the fail-closed
//     discipline of the codex_cancel identity gate;
//   - prompt redaction: the companion persists the (secret-redacted) prompt as the
//     `summary` field AND in `request.prompt` (verified against codex/1.0.5). We
//     cannot durably neutralize the on-disk value (the companion rewrites the whole
//     record over the job lifecycle under an UNLOCKED read-modify-write; racing it
//     is exactly the store race). Instead the endpoints -- the only
//     path by which a job record escapes to any caller -- emit a neutral, derived
//     summary and strip the prompt copy. For pii:true cwds the summary carries NO
//     prompt text at all.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolvePolicy } from "./policy.mjs";
import { redactSecrets } from "./admission.mjs";

// ---- workspace-root + store-dir identity (mirrors companion lib/workspace.mjs + lib/state.mjs) ----

// git-root-or-cwd, matching the companion's resolveWorkspaceRoot(ensureGitRepository).
// Kept local so the guard carries no dependency on the versioned-black-box companion.
export function resolveWorkspaceRootLocal(cwd, deps = {}) {
  const fsx = deps.fs ?? fs;
  const start = path.resolve(cwd ?? ".");
  let dir = start;
  for (;;) {
    try { if (fsx.existsSync(path.join(dir, ".git"))) return dir; } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return start;   // hit the drive/filesystem root: no repo -> the cwd itself
    dir = parent;
  }
}

// The physical store directory basename the companion persists a workspace's jobs
// into: `${slug}-${sha256(realpath(workspaceRoot))[:16]}` (lib/state.mjs resolveStateDir).
export function workspaceStoreDir(workspaceRoot, deps = {}) {
  const fsx = deps.fs ?? fs;
  if (!workspaceRoot || typeof workspaceRoot !== "string") return null;
  let canonical = workspaceRoot;
  try { canonical = fsx.realpathSync.native(workspaceRoot); } catch { canonical = workspaceRoot; }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function normalizeOwnerPath(p) {
  if (!p || typeof p !== "string") return null;
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

// The server instance's trusted identity. The `cwd` tool argument is NEVER trusted
// for ownership; the server process's own cwd is. An optional CODEX_MCP_OWNER_CWD
// env override is an operational escape hatch if the server is ever launched from a
// fixed directory. Tests inject selfWorkspaceRoot/selfStoreDir directly.
export function selfIdentity(deps = {}) {
  const workspaceRoot = deps.selfWorkspaceRoot
    ?? resolveWorkspaceRootLocal(deps.selfCwd ?? process.env.CODEX_MCP_OWNER_CWD ?? process.cwd(), deps);
  const storeDir = deps.selfStoreDir ?? workspaceStoreDir(workspaceRoot, deps);
  return { workspaceRoot, storeDir };
}

// A record is owned by the caller iff it resides in -- or names -- the server's own
// store. workspaceRoot path match tolerates store-hash drift (same project, drifted
// realpath: the store-race recovery case). storeDir match covers a legacy record that
// carries no workspaceRoot but physically lives in the server's own store. No
// resolvable owner at all -> fail closed.
export function isOwned({ workspaceRoot = null, storeDir = null } = {}, deps = {}) {
  const self = selfIdentity(deps);
  const selfPath = normalizeOwnerPath(self.workspaceRoot);
  if (workspaceRoot && selfPath && normalizeOwnerPath(workspaceRoot) === selfPath) return true;
  if (storeDir && self.storeDir && storeDir === self.storeDir) return true;
  return false;
}

// Is the caller-supplied cwd owned by the server instance? A null/empty cwd is NOT
// trivially owned: the companion resolves an omitted cwd from the server PROCESS's
// launch directory (jobs.mjs runCompanion: opts.cwd ?? process.cwd()), which can
// differ from the configured owner when CODEX_MCP_OWNER_CWD overrides it. Resolve the null case to the directory the
// companion will actually use, then apply the same ownership check. With no
// override, selfIdentity also resolves to process.cwd(), so this is owned and
// behavior-identical to the old short-circuit.
export function isCwdOwned(cwd, deps = {}) {
  const effectiveCwd = (cwd === null || cwd === undefined || cwd === "")
    ? (deps.processCwd ?? process.cwd())
    : cwd;
  const workspaceRoot = resolveWorkspaceRootLocal(effectiveCwd, deps);
  const storeDir = workspaceStoreDir(workspaceRoot, deps);
  return isOwned({ workspaceRoot, storeDir }, deps);
}

export function crossStoreError(action, jobId) {
  const err = new Error(
    `cross_store: refusing to ${action} job '${jobId}' -- it is not owned by this server instance's store`);
  err.code = "cross_store";
  return err;
}

// ---- prompt redaction (requirement 2) ----

function jobKindLabel(rec) {
  return (rec && (rec.kindLabel || rec.kind || rec.jobClass)) || "job";
}

function policyFor(cwd, rec, deps) {
  const resolve = deps.resolvePolicy ?? resolvePolicy;
  return resolve(cwd ?? (rec && (rec.request?.cwd || rec.workspaceRoot)) ?? undefined);
}

// A neutral, derived summary that never reveals a PII prompt. PII cwd -> tool kind +
// repo label ONLY (no prompt text). Non-PII -> kind + repo + a truncated, secret-
// redacted FIRST line of the original summary.
export function deriveNeutralSummary(rec, cwd, deps = {}) {
  const policy = policyFor(cwd, rec, deps);
  const kind = jobKindLabel(rec);
  const repo = (policy && policy.name) || "unknown";
  if (policy && policy.pii_sensitive) {
    return `[${kind}] ${repo} (prompt redacted: PII project)`;
  }
  const firstLine = String((rec && rec.summary) ?? "").split(/\r?\n/)[0] ?? "";
  const redacted = redactSecrets(firstLine).slice(0, 120);
  return `[${kind}] ${repo}: ${redacted}`.trimEnd();
}

// Return a shallow clone of a job record with every prompt-bearing field neutralized:
// `summary` -> neutral derived summary; `title` -> neutral label; `request.prompt`
// (and any top-level `prompt`) stripped. The answer fields (`result`, `rendered`,
// `output`) and all control fields (id/status/pid/...) are preserved untouched. Never
// mutates the input.
export function sanitizeJobRecord(rec, cwd, deps = {}) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return rec;
  const clean = { ...rec };
  clean.summary = deriveNeutralSummary(rec, cwd, deps);
  const policy = policyFor(cwd, rec, deps);
  const repo = (policy && policy.name) || "unknown";
  if ("title" in clean) clean.title = `[${jobKindLabel(rec)}] ${repo}`;
  if ("prompt" in clean) delete clean.prompt;
  if (clean.request && typeof clean.request === "object" && !Array.isArray(clean.request)) {
    const { prompt, ...restReq } = clean.request;
    clean.request = restReq;
  }
  return clean;
}

// Sanitize whatever record shape an endpoint returns: a status snapshot ({job} or a
// bare record) and a result payload ({storedJob} / {job} / bare).
export function sanitizeSnapshot(snapshot, cwd, deps = {}) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  if (snapshot.job && typeof snapshot.job === "object") {
    return { ...snapshot, job: sanitizeJobRecord(snapshot.job, cwd, deps) };
  }
  return sanitizeJobRecord(snapshot, cwd, deps);
}

export function sanitizeResultPayload(payload, cwd, deps = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  if (out.storedJob && typeof out.storedJob === "object") out.storedJob = sanitizeJobRecord(out.storedJob, cwd, deps);
  if (out.job && typeof out.job === "object") out.job = sanitizeJobRecord(out.job, cwd, deps);
  return out;
}

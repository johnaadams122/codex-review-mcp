// reviewers.mjs -- vendor-agnostic reviewer providers. codex = the sole backbone today.
//
// A ReviewerProvider wraps one vendor's job transport behind a uniform contract so the panel's
// fan-out / poll / decode logic never reaches into companion internals. Future free-tier vendors
// (Gemini/Grok/Meta) land here as ADVISORY providers (additive-strictness only, see panel
// aggregate) without reopening the fail-closed vote logic.
//
//   ReviewerProvider {
//     name, role: "backbone" | "advisory",
//     submit(prompt, { model, effort, cwd }, deps?) -> { jobId },
//     getStatus(jobId, { cwd }) -> snapshot,
//     getResult(jobId, { cwd }) -> raw,
//     extractAnswerText(raw) -> string,
//     cancel(jobId, { cwd }),
//     effectiveStrength(jobId, { cwd }, deps?) -> { model, effort } | null,
//     available?() -> boolean                                                  // advisory only
//   }

import { submitTaskViaFile as _submitTaskViaFile, getStatus as _getStatus, getResult as _getResult,
         cancelJob as _cancelJob, extractAnswerText as _extractAnswerText } from "./jobs.mjs";
import { tierOf } from "./strength.mjs";
import {
  submitDirect as _submitDirect, getDirectStatus as _getDirectStatus,
  getDirectResult as _getDirectResult, cancelDirect as _cancelDirect,
  directEffectiveStrength as _directEffectiveStrength, finalizeJob as _finalizeJob,
} from "./direct.mjs";

export const ROLES = { BACKBONE: "backbone", ADVISORY: "advisory" };

// The `deps` argument exists ONLY so tests can inject fakes without module mocking.
export const codexProvider = {
  name: "codex",
  role: ROLES.BACKBONE,
  async submit(prompt, { model, effort, cwd } = {}, deps = {}) {
    const submit = deps.submitTaskViaFile ?? _submitTaskViaFile;
    const r = await submit(prompt, { model, effort, cwd, write: false });
    return { jobId: r.job_id };
  },
  getStatus(jobId, opts = {}) { return _getStatus(jobId, opts.cwd); },
  getResult(jobId, opts = {}) { return _getResult(jobId, opts.cwd); },
  extractAnswerText(raw) { return _extractAnswerText(raw); },
  cancel(jobId, opts = {}) { return _cancelJob(jobId, opts.cwd); },
  // The effective model+effort the companion actually ran, read back from the job status
  // (`request.model`/`request.effort`). Returns null on any absence/error so the caller fails
  // CLOSED (a null effective strength must never be treated as satisfying a floor).
  async effectiveStrength(jobId, opts = {}, deps = {}) {
    const getStatus = deps.getStatus ?? _getStatus;
    let snap;
    try { snap = await getStatus(jobId, opts.cwd); } catch { return null; }
    const job = snap && snap.job ? snap.job : snap;
    const req = (job && job.request) || (snap && snap.request) || null;
    const model = (req && req.model) ?? (job && job.model) ?? null;
    const effort = (req && req.effort) ?? (job && job.effort) ?? null;
    if (!model || !effort) return null;
    return { model, effort };
  },
};

// Build the immutable assignment manifest. Each lens is assigned to the single backbone
// provider today; the assignment_id is unique + deterministic so aggregate() can match actual
// outcomes back to expected assignments BY IDENTITY (not by a substitution-prone count).
// A future spread strategy / advisory add-ons extend this without touching aggregate().
export function assignReviewers(lenses, providers = [codexProvider]) {
  const backbone = providers.find((p) => p.role === ROLES.BACKBONE) ?? codexProvider;
  return lenses.map((lens, i) => ({
    assignment_id: `a${i}:${backbone.name}:${lens.key}`,
    lens,
    provider: backbone,
    role: backbone.role,
  }));
}

// Single transport per run. Input: the RESOLVED per-lens strengths (per-lens
// override ?? run-level ?? default -- resolved by the CALLER before this). all-max -> direct;
// none-max -> companion; a mix -> "mixed" (caller rejects pre-admission, no dispatch).
export function pickTransport(resolvedStrengths = []) {
  const maxes = resolvedStrengths.filter((s) => tierOf(s) === "max").length;
  if (maxes === 0) return "companion";
  if (maxes === resolvedStrengths.length) return "direct";
  return "mixed";
}

// The direct-exec provider. Same uniform contract; submit REQUIRES the
// pinned opts { model, effort, cwd_real, pii, timeoutMs, binaryIdentity } sourced by the panel
// from the branded admission + resolved strength (never re-derived). finalize = finalizeJob
// (self-cancels nonterminal jobs); the panel awaits it in each per-reviewer finally.
export const directCodexProvider = {
  name: "codex-direct",
  role: ROLES.BACKBONE,
  async submit(prompt, opts = {}, deps = {}) {
    const submit = deps.submitDirect ?? _submitDirect;
    const r = await submit(prompt, opts, deps);
    return { jobId: r.jobId };
  },
  // getStatus has no deps param to forward -- getDirectStatus(jobId) takes jobId only.
  getStatus(jobId) { return _getDirectStatus(jobId); },
  getResult(jobId, deps) { return _getDirectResult(jobId, deps); },
  extractAnswerText(raw) {
    if (raw == null) return "";
    if (typeof raw === "string") return raw;
    return raw.output ?? "";
  },
  cancel(jobId, deps) { return _cancelDirect(jobId, deps); },
  effectiveStrength(jobId, deps) { return _directEffectiveStrength(jobId, deps); },
  finalize(jobId, deps) { return _finalizeJob(jobId, deps); },
};

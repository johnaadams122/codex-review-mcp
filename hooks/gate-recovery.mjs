// hooks/gate-recovery.mjs -- failure taxonomy + recovery ladder.
// Precedence is EXACT -- and CRUCIALLY, ANY non-complete/non-empty_diff status is a
// config error BEFORE consensus is examined. v4 used a status ALLOWLIST, so an UNKNOWN non-complete
// status carrying consensus "pass" fell through to clean_pass -- a fabricated pass. That is closed.
export function classifyVerdict(res) {
  const cv = res.consensus_verdict;
  const status = res.status;
  // (1) empty_diff is a clean pass (0 jobs) regardless of consensus.
  if (status === "empty_diff") return { kind: "clean_pass" };
  // (2) ANY non-complete status -> CONFIG/INPUT error, fail-closed (no allowlist -> no fabricated pass).
  if (status !== "complete") return { kind: "config_error", failure_reason: status };
  // (3) status === "complete": decide on consensus.
  if (cv === "pass") return { kind: "clean_pass" };
  // A mid-run write-ahead budget VETO records a `budget_capped` abstention -> terminal
  // budget_capped FAILED, no retry (cap exhausted). But it is checked AFTER the decisive
  // real-blocker / identity-error checks, so a genuine BLOCK is never hidden behind a budget label
  // ("real-blocker FIRST").
  const budgetCapped = (res.abstentions || []).some((a) => a && a.reason === "budget_capped");
  if (cv === "block") {
    const realBlocker = (res.blockers || []).length > 0 || (res.reviewers || []).some((r) => r.verdict === "block");
    if (realBlocker) return { kind: "clean_block" };                       // decisive block wins
    if (budgetCapped) return { kind: "budget_capped", failure_reason: "budget" };
    if (res.diff_truncated === true) return { kind: "diff_too_large", failure_reason: "diff_too_large" };
    if ((res.abstentions || []).length > 0) return { kind: "incompleteness", failure_reason: "abstention" };
    return { kind: "clean_block" }; // block with neither blocker nor abstention nor truncation
  }
  if (cv === "error") {
    if ((res.identity_errors || []).length > 0) return { kind: "structural", failure_reason: "identity_error" };
    if (budgetCapped) return { kind: "budget_capped", failure_reason: "budget" };
    return { kind: "transient", failure_reason: "all_backbone_abstain" };
  }
  return { kind: "structural", failure_reason: "unknown_consensus" };
}

// -- Reviewer labels -- reflects ATTESTATION, never a fabricated trust signal.
// The shortname derives from the REQUESTED impl model (IMPL_MODEL), NEVER from
// verdict.model or strength.backbone_weakest -- those describe what a reviewer actually
// ran, not what the gate asked for, and mixing the two would mislabel a downgraded run.
export const MODEL_SHORTNAME = { "gpt-6.1-sol": "sol", "gpt-5.6-sol": "sol", "gpt-5.6-terra": "terra", "gpt-5.6-luna": "luna", "gpt-6-luna": "luna", "gpt-6-astra": "astra" };
const IMPL_MODEL = "gpt-6.1-sol"; // the impl gate runs the standard tier (gpt-6.1-sol/medium)

export function reviewerLabel(res) {
  const short = MODEL_SHORTNAME[IMPL_MODEL] ?? "terra";
  const attested = Boolean(res && res.strength && res.strength.backbone_attested === true);
  return attested ? `codex:${short}` : `codex:${short} (requested, unattested)`;
}

// -- Recovery ladder --
import { CONFIG, isAllowlisted } from "./gate-run.config.mjs";
import { resolvePolicy as _resolvePolicyR } from "../policy.mjs";
import { piiScanPayload, defaultRunGit } from "./gate-run.mjs"; // gate-run is LIGHT at top level (5c) -> no cycle, no panel chain
import fs from "node:fs";
import path from "node:path";

// The REAL per-rung recheck (v4's deps.recheck was an UNDEFINED injected dep). Re-checks
// the FILE opt-out (env is snapshot-at-spawn), the allowlist, and diff-wide PII over the PINNED bytes.
export function makeRecheck(repoRoot, mdeps = {}) {
  return async ({ payloadRef } = {}) => {
    const fsView = mdeps.fsView ?? fs;
    if (!fsView.existsSync(path.join(repoRoot, ".codex-autogate"))) return { ok: false, reason: "opted_out" };
    if (fsView.existsSync(path.join(repoRoot, ".codex-autogate-off"))) return { ok: false, reason: "opted_out" };
    const resolvePolicy = mdeps.resolvePolicy ?? _resolvePolicyR;
    if (!isAllowlisted(resolvePolicy(repoRoot).name)) return { ok: false, reason: "not_allowlisted" };
    try {
      const bytes = payloadRef.kind === "commit"
        ? (mdeps.runGit ?? defaultRunGit)(["diff", `${payloadRef.sha}~1..${payloadRef.sha}`], repoRoot)
        : (mdeps.readFile ?? ((p) => fs.readFileSync(p, "utf8")))(payloadRef.path);
      const computePayloadFiles = mdeps.computePayloadFiles ?? (await import("../panel.mjs")).computePayloadFiles;
      const pf = computePayloadFiles({ payload: bytes });
      if (pf.error) return { ok: false, reason: "payload_parse_error" };
      // Parity with classify's guard: a NON-ARRAY payload_files (e.g. a string, which for..of iterates
      // char-by-char and would vacuously pass the PII scan) must fail CLOSED, never fail-open (final review).
      if (!Array.isArray(pf.payload_files)) return { ok: false, reason: "payload_parse_error" };
      const pii = piiScanPayload(repoRoot, pf.payload_files, mdeps);
      if (!pii.ok) return { ok: false, reason: pii.reason };
    } catch { return { ok: false, reason: "recheck_error" }; }
    return { ok: true };
  };
}

const TERMINAL_KINDS = new Set(["clean_pass", "clean_block", "config_error", "structural", "diff_too_large", "budget_capped"]);
const STATUS_OF = { clean_pass: "pass", clean_block: "block", config_error: "error", structural: "error", diff_too_large: "failed", budget_capped: "failed" };

export async function runLadder({ event, runId, targetKey, payloadRef }, deps = {}) {
  const isLiveEpoch = deps.isLiveEpoch ?? (() => true); // child injects (_tk,ep)=>isLiveEpoch(repoRoot,runId,ep)
  const maxAttempts = deps.maxAttempts ?? CONFIG.attempts.maxCodex;
  const attempts = [];
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // (a) per-rung recheck: FILE opt-out + allowlist + diff-wide PII (env is snapshot-at-spawn)
    const rc = await deps.recheck({ event, payloadRef, attempt });
    if (!rc.ok) return { status: "failed", failure_reason: rc.reason, reviewer: reviewerLabel({ strength: {} }), attempts };
    // (b) epoch guard: a superseded attempt writes nothing (the child then does NOT reconcile)
    if (!isLiveEpoch(targetKey, deps.epoch)) return { status: "superseded", reviewer: reviewerLabel({ strength: {} }), attempts };
    // (c) run one gate over the PINNED payload
    const res = await deps.runGateOnce({ event, runId, payloadRef, attempt });
    last = res;
    const c = classifyVerdict(res);
    attempts.push({ attempt, kind: c.kind, failure_reason: c.failure_reason, reviewer: reviewerLabel(res) });
    if (TERMINAL_KINDS.has(c.kind)) {
      return { status: STATUS_OF[c.kind], failure_reason: c.failure_reason, reviewer: reviewerLabel(res), attempts, res };
    }
    // incompleteness/transient: loop to retry the FULL payload
  }
  // exhausted -> marked FAILED
  return { status: "failed", failure_reason: (attempts.at(-1) || {}).failure_reason ?? "exhausted", reviewer: reviewerLabel(last || { strength: {} }), attempts };
}

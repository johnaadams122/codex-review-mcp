#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { admit, admitDirect } from "./admission.mjs";
import { delegate as orchestratorDelegate, NORMALIZATION_ERRORS } from "./orchestrator.mjs";
import {
  submitTask,
  submitReview,
  submitAdversarialReview,
  getStatus,
  getResult,
  listJobs,
  cancelJob,
  waitForResult
} from "./jobs.mjs";
import { CODEX_TIERS } from "./routing.mjs";
import { runPanel, LENSES, parseDirectTimeout } from "./panel.mjs";
import { runGate, revisionLabel } from "./gate.mjs";
import { belowFloor, tierOf } from "./strength.mjs";
import { startSweepInterval } from "./direct.mjs";
import { clearGateDueForGate } from "./hooks/marker.mjs";
import { projectResult, projectWait, projectStatus } from "./project.mjs";

// The ad-hoc panel is a flagship gate by definition; any strength override is floor-enforced here.
const PANEL_FLOOR = "flagship";

export const server = new McpServer({ name: "codex-mcp", version: "1.0.0" });

export const EFFORT_ENUM = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional();
// Reviews-only max. Gate/panel strength accepts it; codex_task/delegate NEVER do -- their
// schemas keep EFFORT_ENUM, so zod rejects "max" at the boundary. The REGISTERED
// tool schemas are what the boundary test exercises (the enum exports are conveniences).
export const REVIEW_EFFORT_ENUM = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional();
const SCOPE_ENUM  = z.enum(["auto", "working-tree", "branch"]).optional();

const okContent  = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const errContent = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError: true });

// Reviews run on a named tier's MODEL (default flagship = gpt-6.1-sol). Note: the
// companion review command accepts --model but NOT --effort (verified against the
// codex/1.0.5 companion source: review valueOptions = base/scope/model/cwd), so
// effort inherits the codex config default (xhigh). The chosen model is surfaced
// in the response so callers can verify which model actually ran.
function reviewModel(quality) {
  return (CODEX_TIERS[quality] ?? CODEX_TIERS.flagship).model;
}

// C1 -- when wait:true, block on waitForResult and fold the terminal status + result inline.
// Default (wait falsy) is the byte-for-byte prior contract: return the job_id, no waiting.
// The folded result is PROJECTED by default (minimal caller-facing shape);
// verbose:true folds in the complete raw producer outcome instead. `error` (from a
// result_error terminal) is now carried in BOTH modes -- the pre-projection fold silently
// dropped it. base is spread FIRST so write_blocked/model survive under both modes.
async function maybeWait(base, { wait, wait_timeout_ms, cwd, verbose }) {
  if (!wait) return okContent(base);
  const w = await waitForResult(base.job_id, { cwd, timeoutMs: wait_timeout_ms });
  return okContent({
    ...base,
    waited: true,
    status: w.status,
    ...(w.result ? { result: verbose ? w.result : projectResult(base.job_id, w.result, w.status) } : {}),
    ...(w.error ? { error: w.error } : {})
  });
}

// codex_wait's handler -- block an already-submitted job to a terminal state, then return its
// result. A timeout is surfaced as a (non-error) { status:"timeout", job_id } sentinel so the
// caller can keep waiting; it fixes the loose-job-id "never polled to terminal" failure.
// Minimal (default) projects the outcome via projectWait; verbose:true returns the
// full raw waitForResult() outcome untouched.
export async function handleWait({ job_id, cwd, timeout_ms, verbose }) {
  const w = await waitForResult(job_id, { cwd, timeoutMs: timeout_ms });
  return okContent(verbose ? w : projectWait(w));
}

// Exported for testing: review tools are async -- they submit in the background and
// return a job_id to poll with codex_status / codex_result (or wait:true to fold in the result).
export async function handleReview({ scope, base, cwd, quality, wait, wait_timeout_ms, verbose }) {
  const gate = admit({ kind: "review", cwd });
  if (!gate.allowed) return errContent({ error: "blocked", reason: gate.reason, project: gate.project });
  const model = reviewModel(quality);
  const r = await submitReview({ scope, base, cwd, model });
  return maybeWait({ job_id: r.job_id, status: r.status, model }, { wait, wait_timeout_ms, cwd, verbose });
}

export async function handleAdversarialReview({ focus, scope, base, cwd, quality, wait, wait_timeout_ms, verbose }) {
  const gate = admit({ kind: "adversarial_review", cwd, task: focus ?? "" });
  if (!gate.allowed) return errContent({ error: "blocked", reason: gate.reason, project: gate.project });
  const model = reviewModel(quality);
  const r = await submitAdversarialReview(gate.task, { scope, base, cwd, model });
  return maybeWait({ job_id: r.job_id, status: r.status, model }, { wait, wait_timeout_ms, cwd, verbose });
}

// codex_review_panel's handler, exported for testing. UNLIKE the single reviews, the panel is
// SYNCHRONOUS: it runs every lens reviewer to completion and returns an aggregated, fail-closed
// consensus verdict inline (no job_id to poll). Admission (PII cwd block + secret redaction of
// the diff) happens inside runPanel before any reviewer is dispatched.
export async function handlePanel({ scope, base, cwd: cwdArg, lenses, timeout_ms, strength } = {}, deps = {}) {
  // cwd is optional: admission, the panel and the revision label all use this process's folder then.
  const cwd = cwdArg ?? process.cwd();
  const selected = Array.isArray(lenses) && lenses.length
    ? LENSES.filter((l) => lenses.includes(l.key))
    : undefined;
  if (strength && belowFloor(strength, PANEL_FLOOR)) {
    return errContent({
      consensus_verdict: "error", status: "strength_below_floor",
      reason: `codex_review_panel requires reviewer strength >= ${PANEL_FLOOR}`,
      strength: { weakest: strength, floor: PANEL_FLOOR },
    });
  }
  const _runPanel = deps.runPanel ?? runPanel;
  let result;
  if (strength && tierOf(strength) === "max") {
    // A1 handoff: admit ONCE here; the panel validates the branded decision.
    const admission = await (deps.admitDirect ?? admitDirect)({ cwd, needs_git: true });
    if (!admission.allowed) {
      return errContent({
        consensus_verdict: "error", status: "blocked", reason: admission.reason, project: admission.project,
        ...(admission.detail != null ? { detail: admission.detail } : {}),
      });
    }
    result = await _runPanel({
      cwd, base, scope, lenses: selected, timeoutMs: timeout_ms,
      model: strength.model, effort: strength.effort,
      direct: {
        timeoutMs: parseDirectTimeout(),
        revision: (deps.revisionLabel ?? revisionLabel)(cwd),
        evidence_kind: "diff",
      },
    }, { admission });
  } else {
    result = await _runPanel({
      cwd, base, scope, lenses: selected, timeoutMs: timeout_ms,
      ...(strength ? { model: strength.model, effort: strength.effort } : {}),
    });
  }
  // Effective recheck: refuse a pass whose recorded backbone strength fell below the floor. A clean
  // tree's empty_diff pass ran no reviewer, so it has no strength to check; any result that DID run
  // a reviewer is still checked, whatever its status label says.
  const noReviewerRan = result.status === "empty_diff" && Array.isArray(result.reviewers) && result.reviewers.length === 0;
  if (result.consensus_verdict !== "error" && !noReviewerRan && belowFloor((result.strength && result.strength.backbone_weakest) || {}, PANEL_FLOOR)) {
    return errContent({
      ...result, consensus_verdict: "error", status: "strength_below_floor",
      reason: `effective backbone strength below the ${PANEL_FLOOR} floor`,
      strength: { ...(result.strength || {}), floor: PANEL_FLOOR },
    });
  }
  // A "pass"/"block" verdict is a successful review; "error" (blocked cwd / diff error /
  // all-abstain) is surfaced as an MCP error so callers cannot mistake it for a clean result.
  return result.consensus_verdict === "error" ? errContent(result) : okContent(result);
}

// codex_gate's handler, exported for testing. Runs the phase-appropriate adversarial gate and
// returns a fail-CLOSED, phase- and strength-labeled verdict. An "error" verdict (blocked cwd /
// strength_below_floor / no_reviewable_target / diff error) is surfaced as an MCP error so a caller
// can never mistake it for a clean pass.
export async function handleGate({ phase, cwd, base, scope, target_files, context_files, strength }) {
  const res = await runGate({ phase, cwd, base, scope, target_files, context_files, strength });
  // Phase-1 hook automation: a gate that RAN (non-error verdict) clears its
  // gate-due marker entries. Best-effort by contract -- never turns a verdict into an error.
  if (res.consensus_verdict !== "error") clearGateDueForGate({ cwd, phase, target_files });
  return res.consensus_verdict === "error" ? errContent(res) : okContent(res);
}

// codex_task's handler, exported for testing (same pattern as handleReview).
export async function handleTask({ prompt, context_snapshot, effort, write, cwd, wait, wait_timeout_ms, verbose }) {
  const gate = admit({ kind: "task", cwd, write: Boolean(write), task: prompt, context_snapshot });
  if (!gate.allowed) return errContent({ error: "blocked", reason: gate.reason, project: gate.project });
  const full_prompt = gate.context_snapshot ? `${gate.context_snapshot}\n\n${gate.task}` : gate.task;
  const job = await submitTask(full_prompt, { write: gate.effective_write, effort, cwd });
  return maybeWait({ job_id: job.job_id, status: job.status, write_blocked: gate.write_blocked }, { wait, wait_timeout_ms, cwd, verbose });
}

// delegate's handler, exported for testing (same pattern as handleTask). A normalization
// failure (NORMALIZATION_ERRORS.has(reason), a result.error with no job submitted) surfaces as
// an MCP error so a caller cannot mistake a rejected quality/model/effort combo for a routed,
// executed task.
export async function handleDelegate({ task, context_snapshot, tier, quality, model, write, effort, cwd }) {
  const r = await orchestratorDelegate(task, {
    context_snapshot,
    tier: tier === "auto" ? null : tier,
    quality,
    model,
    write,
    effort,
    cwd
  });
  if (r.result?.error && NORMALIZATION_ERRORS.has(r.reason)) return errContent(r);
  return okContent(r);
}

server.tool(
  "codex_task",
  "Submit a task to the Codex CLI for multi-file implementation or autonomous coding. Returns immediately with a job_id; poll with codex_status / codex_result (minimal projected shape by default). With wait=true the terminal outcome is folded in as the same minimal projected shape; pass verbose=true to fold in the complete raw producer result instead.",
  {
    prompt:           z.string().describe("The task prompt for Codex"),
    context_snapshot: z.string().optional().describe("XML context block prepended to prompt"),
    effort:           EFFORT_ENUM.describe("Reasoning effort level"),
    write:            z.boolean().optional().default(false).describe("Allow Codex to write files. Honoured only where the project's policy row sets write: true; unknown folders and write: false rows run read-only and report write_blocked: true"),
    cwd:              z.string().optional().describe("Working directory of the target project"),
    wait:             z.boolean().optional().default(false).describe("Block until the job reaches a terminal state and return the result inline (waited:true)"),
    wait_timeout_ms:  z.number().int().positive().optional().describe("Max ms to wait when wait=true (default 480000); on timeout returns status:timeout with the job_id"),
    verbose:          z.boolean().optional().describe("When wait=true, fold in the complete raw producer result instead of the minimal projected shape")
  },
  async ({ prompt, context_snapshot, effort, write, cwd, wait, wait_timeout_ms, verbose }) => {
    try {
      return await handleTask({ prompt, context_snapshot, effort, write, cwd, wait, wait_timeout_ms, verbose });
    } catch (err) {
      return errContent({ error: err.message });
    }
  }
);

server.tool(
  "codex_review",
  "Start a Codex code review in the background on the flagship model (gpt-6.1-sol) by default. Returns a job_id; poll with codex_status / codex_result (minimal projected shape by default). With wait=true the terminal outcome is folded in as the same minimal projected shape; pass verbose=true to fold in the complete raw review payload instead. Project must be a git repo.",
  {
    scope:   SCOPE_ENUM.describe("Review scope: auto, working-tree, or branch"),
    base:    z.string().optional().describe("Base branch or ref for branch-scope review"),
    cwd:     z.string().optional().describe("Working directory of the git repo to review"),
    quality: z.enum(["flagship", "standard", "fast", "fast_review", "astra"]).optional().describe("Model tier for the review (default flagship = gpt-6.1-sol). astra=gpt-6-astra is OpenAI's fable-class flagship -- expensive in tokens/usage, reserve for massive large-scale reviews/audits, not routine use."),
    wait:            z.boolean().optional().default(false).describe("Block until the review job is terminal and return the result inline"),
    wait_timeout_ms: z.number().int().positive().optional().describe("Max ms to wait when wait=true (default 480000)"),
    verbose:         z.boolean().optional().describe("When wait=true, fold in the complete raw review payload instead of the minimal projected shape")
  },
  async ({ scope, base, cwd, quality, wait, wait_timeout_ms, verbose }) => {
    try {
      return await handleReview({ scope, base, cwd, quality, wait, wait_timeout_ms, verbose });
    } catch (err) {
      return errContent({ error: err.message });
    }
  }
);

server.tool(
  "codex_adversarial_review",
  "Start an adversarial Codex review in the background on the flagship model (gpt-6.1-sol) by default. Returns a job_id; poll with codex_status / codex_result (minimal projected shape by default). With wait=true the terminal outcome is folded in as the same minimal projected shape; pass verbose=true to fold in the complete raw review payload instead. Project must be a git repo.",
  {
    focus:   z.string().optional().describe("Specific area to challenge (design, assumptions, correctness)"),
    scope:   SCOPE_ENUM,
    base:    z.string().optional(),
    cwd:     z.string().optional(),
    quality: z.enum(["flagship", "standard", "fast", "fast_review", "astra"]).optional().describe("Model tier (default flagship = gpt-6.1-sol). astra=gpt-6-astra is OpenAI's fable-class flagship -- expensive in tokens/usage, reserve for massive large-scale reviews/audits, not routine use."),
    wait:            z.boolean().optional().default(false).describe("Block until the review job is terminal and return the result inline"),
    wait_timeout_ms: z.number().int().positive().optional().describe("Max ms to wait when wait=true (default 480000)"),
    verbose:         z.boolean().optional().describe("When wait=true, fold in the complete raw review payload instead of the minimal projected shape")
  },
  async ({ focus, scope, base, cwd, quality, wait, wait_timeout_ms, verbose }) => {
    try {
      return await handleAdversarialReview({ focus, scope, base, cwd, quality, wait, wait_timeout_ms, verbose });
    } catch (err) {
      return errContent({ error: err.message });
    }
  }
);

server.tool(
  "codex_review_panel",
  "Run a SYNCHRONOUS multi-lens adversarial review panel on the flagship model (gpt-6.1-sol, xhigh) -- always flagship, no downgrade. Fans out one reviewer per lens (correctness, security-pii, design-simplicity) over the same diff and returns an aggregated, fail-CLOSED consensus verdict inline: pass ONLY if every reviewer completes, every reviewer passes, there are zero blocker findings, and the diff was not truncated; any abstention/error -> block; all abstain -> error. No job_id. Project must be a git repo; PII projects are blocked (the diff cannot be redacted for them). This call can take several minutes. strength {model:'gpt-6-astra', effort:'max'} runs the direct-exec max path: OS-enforced read-only sandbox, read-around verification with files_checked evidence, receipt-attested strength (attested-or-no-pass). PII projects allowed read-only per the named policy rows; requires verified 6d preconditions.",
  {
    scope:      SCOPE_ENUM.describe("Diff scope: auto (default), working-tree, or branch"),
    base:       z.string().optional().describe("Base ref for branch scope (default main)"),
    cwd:        z.string().optional().describe("Working directory of the git repo to review"),
    lenses:     z.array(z.enum(["correctness", "security-pii", "design-simplicity"])).optional()
                  .describe("Subset of lenses to run (default all three)"),
    timeout_ms: z.number().int().positive().optional().describe("Per-reviewer poll timeout in ms (default 1800000 on the companion transport, DEFAULT_PANEL_TIMEOUT_MS in panel.mjs; clamped to 60000-7200000 via CODEX_PANEL_TIMEOUT_MS)"),
    strength:   z.object({ model: z.string(), effort: REVIEW_EFFORT_ENUM }).optional()
                  .describe("Optional model+effort override; default flagship. Rejected (strength_below_floor) if below the flagship floor. The verdict records the strength used.")
  },
  async ({ scope, base, cwd, lenses, timeout_ms, strength }) => {
    try {
      return await handlePanel({ scope, base, cwd, lenses, timeout_ms, strength });
    } catch (err) {
      return errContent({ error: err.message });
    }
  }
);

server.tool(
  "codex_gate",
  "Run the phase-appropriate adversarial review gate (spec|plan|impl) and return a fail-CLOSED, phase- and strength-labeled consensus verdict. spec/plan run a flagship multi-lens panel over a REQUIRED target document (target_files); impl runs a standard-tier code review of the git diff. Fail-closed: a strength below the phase floor -> strength_below_floor; a missing/unreadable/binary/empty target -> no_reviewable_target; a PII cwd is blocked; a truncated payload can never pass. context_files supply supporting context (parent spec/source) but are NOT the review target. Known limit: a spec/plan gate checks the document's INTERNAL quality only -- it cannot verify claims against external code. Synchronous; can take several minutes. strength {model:'gpt-6-astra', effort:'max'} runs the direct-exec max path: OS-enforced read-only sandbox, read-around verification with files_checked evidence, receipt-attested strength (attested-or-no-pass). PII projects allowed read-only per the named policy rows; requires verified 6d preconditions.",
  {
    phase:         z.enum(["spec", "plan", "impl"]).describe("Which gate to run"),
    cwd:           z.string().optional().describe("Working directory of the git repo (authorized before any file read)"),
    target_files:  z.array(z.string()).optional().describe("Repo-relative document(s) under review; REQUIRED for spec/plan. Full text is folded in."),
    context_files: z.array(z.string()).optional().describe("Repo-relative supporting context (parent spec/source); reviewed for context only, not as the target"),
    base:          z.string().optional().describe("Base ref for the impl diff (default main)"),
    scope:         SCOPE_ENUM.describe("impl diff scope: auto, working-tree, or branch"),
    strength:      z.object({ model: z.string(), effort: REVIEW_EFFORT_ENUM }).optional().describe("Override model+effort; rejected (strength_below_floor) if below the phase floor")
  },
  async ({ phase, cwd, base, scope, target_files, context_files, strength }) => {
    try {
      return await handleGate({ phase, cwd, base, scope, target_files, context_files, strength });
    } catch (err) {
      return errContent({ error: err.message });
    }
  }
);

server.tool(
  "codex_status",
  "Get the status of a Codex job (minimal projected shape by default: job_id/status/phase/pid/summary[+elapsed/write_blocked/_synthesized when present]; pass verbose=true for the full raw snapshot). Use codex_list_jobs to find job IDs.",
  {
    job_id:  z.string().describe("The job ID returned by codex_task"),
    cwd:     z.string().optional(),
    verbose: z.boolean().optional().describe("Return the full raw status snapshot instead of the minimal projected shape")
  },
  async ({ job_id, cwd, verbose }) => {
    try {
      const snapshot = await getStatus(job_id, cwd);
      const payload = verbose ? snapshot : projectStatus(job_id, snapshot);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  "codex_result",
  "Get the output of a completed Codex job (minimal projected shape by default: job_id/status/output[+touchedFiles/model/write_blocked/_synthesized/_diskRecovered/truncated when present]; pass verbose=true for the full raw payload). Call codex_status first to confirm the job is done.",
  {
    job_id:  z.string().describe("The job ID returned by codex_task"),
    cwd:     z.string().optional(),
    verbose: z.boolean().optional().describe("Return the full raw result payload instead of the minimal projected shape")
  },
  async ({ job_id, cwd, verbose }) => {
    try {
      const result = await getResult(job_id, cwd);
      const payload = verbose ? result : projectResult(job_id, result);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  "codex_wait",
  "Block on an already-submitted Codex job until it reaches a terminal state, then return its result (minimal projected shape by default; pass verbose=true for the full raw outcome). Use this instead of hand-rolling a codex_status poll loop -- it fixes the recurring 'got a job_id and returned without polling to completion' failure. On timeout returns { status:'timeout', job_id } (not an error) so you can keep waiting; if the job never existed (phantom id) it returns { status:'not_found', job_id } instead of timeout; a non-success terminal returns { status } with no result.",
  {
    job_id:     z.string().describe("The job ID to wait on (from codex_task / codex_review / codex_list_jobs)"),
    cwd:        z.string().optional().describe("Working directory the job was submitted under"),
    timeout_ms: z.number().int().positive().optional().describe("Max ms to wait (default 480000)"),
    verbose:    z.boolean().optional().describe("Return the full raw wait outcome instead of the minimal projected shape")
  },
  async ({ job_id, cwd, timeout_ms, verbose }) => {
    try {
      return await handleWait({ job_id, cwd, timeout_ms, verbose });
    } catch (err) {
      return errContent({ error: err.message });
    }
  }
);

server.tool(
  "codex_list_jobs",
  "List recent Codex jobs and their statuses.",
  {
    cwd: z.string().optional().describe("Working directory to scope the job list")
  },
  async ({ cwd } = {}) => {
    try {
      const jobs = await listJobs({ cwd });
      return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  "delegate",
  "Route a task to the appropriate AI tier (local=on-box qwen for cheap text, codex=coding, claude=judgment). Returns routing decision and result. Local result is inline; Codex returns job_id for polling; Claude tier means handle it yourself. (tier value gemma = deprecated alias for local.)",
  {
    task:             z.string().describe("The task description to route"),
    context_snapshot: z.string().optional().describe("XML context block to pass to Codex"),
    tier:             z.enum(["auto", "local", "gemma", "codex", "claude"]).optional().default("auto"),
    quality:          z.enum(["flagship", "standard", "fast", "fast_review", "local", "astra"]).optional().describe("Named quality tier: flagship=gpt-6.1-sol/xhigh, standard=gpt-6.1-sol/medium, fast=gpt-6-luna/low, local=on-box Ollama qwen2.5:7b (pure-text checks, zero cloud quota), astra=gpt-6-astra/xhigh (OpenAI's fable-class flagship -- deliberately expensive in tokens/usage; reserve for massive large-scale projects or reviews/audits, never routine work). Optional. With no quality set, a nonblank model plus an allowed effort literal, both provided together, resolve to resolved_quality \"custom\"; supplying only one of model/effort with no quality set is a hard error. With a named quality set, a single raw model or effort equal to that quality's own value is accepted as redundant, one that differs is a hard error, and an invalid effort value is always a hard error. Omitting quality, model, and effort resolves to standard (gpt-6.1-sol/medium)."),
    model:            z.string().trim().min(1).optional().describe("Raw Codex model id (e.g. gpt-6.1-sol). With no quality set, must be provided together with an allowed effort value to resolve to resolved_quality:\"custom\" -- alone, it is a hard error. With a named quality set, this value must equal that quality's own model (a match is accepted as redundant); a differing value is a hard error. Prefer the named quality field for the standard tiers."),
    write:            z.boolean().optional().default(false),
    effort:           EFFORT_ENUM.describe("Raw reasoning effort (e.g. medium). With no quality set, must be provided together with a nonblank model to resolve to resolved_quality:\"custom\" -- alone, it is a hard error. With a named quality set, this value must equal that quality's own effort (a match is accepted as redundant); a differing value, or an invalid effort literal, is a hard error."),
    cwd:              z.string().optional()
  },
  async ({ task, context_snapshot, tier, quality, model, write, effort, cwd }) => {
    try {
      return await handleDelegate({ task, context_snapshot, tier, quality, model, write, effort, cwd });
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  "codex_cancel",
  "Cancel a running Codex job.",
  {
    job_id: z.string().describe("The job ID to cancel"),
    cwd:    z.string().optional()
  },
  async ({ job_id, cwd }) => {
    try {
      const result = await cancelJob(job_id, cwd);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSweepInterval(); // start + 15-min unref'd sweep cadence
  // same-session job ownership is an IN-PROCESS registry (jobs.mjs), not
  // an on-disk sidecar -- nothing to sweep, and no credential ever touches disk. A read
  // is granted only for a job this process itself submitted, or via the owner-workspace
  // path; a process restart empties the registry and read-back falls to the owner path.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

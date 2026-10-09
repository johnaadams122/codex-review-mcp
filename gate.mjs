// gate.mjs -- C2 review-gate: a phase -> (lenses, strength, floor) router over runPanel.
//
// Operationalizes the review gates: codex_gate({ phase }) runs the phase-appropriate
// adversarial panel with a fail-CLOSED, strength-floored verdict. spec/plan run a flagship
// multi-lens panel over a REQUIRED target document; impl runs a standard-tier code review of the
// diff. (runGate + the file-safety plumbing land in the next task; this module defines the config.)
//
// Honest scope: the spec/plan gate reviews a document for INTERNAL quality (gaps /
// contradictions / ordering / test-coverage) only. It CANNOT verify a spec's claims against
// external code until the read-only sandbox exists; context_files can supply the parent spec +
// key source, but a factual spec-vs-code check is out of scope and stated as a known limitation.

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { CODEX_TIERS } from "./routing.mjs";
import { admit } from "./admission.mjs";
import { admitDirect as _admitDirect } from "./admission.mjs";
import { runPanel as _runPanel, LENSES, gatherDiff as _gatherDiff, parseDirectTimeout, normalizePayloadPath } from "./panel.mjs";
import { belowFloor as _belowFloor } from "./strength.mjs";
import { tierOf as _tierOf } from "./strength.mjs";
export { tierOf, tierRank, belowFloor } from "./strength.mjs";

export const DEFAULT_GATE_CAP = parseInt(process.env.CODEX_GATE_CAP ?? "200000", 10);

const sol = { model: CODEX_TIERS.flagship.model, effort: CODEX_TIERS.flagship.effort };
const terra = { model: CODEX_TIERS.standard.model, effort: CODEX_TIERS.standard.effort };

// -------- phase lenses (each carries a phase-tuned adversarial instruction) --------

export const SPEC_LENSES = [
  {
    key: "completeness-gaps",
    title: "Completeness and gaps",
    instruction:
      "Hunt for missing requirements, undefined behavior, and unhandled cases in this spec. " +
      "A blocker is a gap that would leave an implementer guessing on a load-bearing decision.",
  },
  {
    key: "contradictions-ambiguity",
    title: "Contradictions and ambiguity",
    instruction:
      "Hunt for internal contradictions, requirements that can be read two ways, and terms used " +
      "inconsistently. A blocker is an ambiguity that would produce two materially different " +
      "implementations.",
  },
  {
    key: "edge-cases-risks",
    title: "Edge cases and failure modes",
    instruction:
      "Hunt for missing edge cases, unstated assumptions, and failure modes the spec does not " +
      "address. A blocker is an unhandled case that would fail-open or corrupt state.",
  },
];

export const PLAN_LENSES = [
  {
    key: "ordering-dependencies",
    title: "Ordering and dependencies",
    instruction:
      "Hunt for steps in the wrong order, missing prerequisite steps, and steps that depend on " +
      "later work. A blocker is an ordering error that would make a task un-buildable as written.",
  },
  {
    key: "test-coverage",
    title: "Test coverage",
    instruction:
      "Hunt for behaviors with no test, missing failure-path tests, and missing verification " +
      "steps. A blocker is a load-bearing behavior shipped with no test.",
  },
  {
    key: "scope-fidelity",
    title: "Scope fidelity",
    instruction:
      "Hunt for plan steps that do not map to the spec, missing spec requirements, and scope " +
      "drift. A blocker is a spec requirement with no implementing step.",
  },
];

// impl reuses the panel's code lenses (correctness + security-pii), resolved lazily in runGate to
// avoid a gate<->panel import cycle.
export const IMPL_LENS_KEYS = ["correctness", "security-pii"];

// -------- phase -> config --------
// floor = the per-phase minimum reviewer strength (fail-CLOSED: a resolved strength below the
// floor makes the gate refuse a pass and return strength_below_floor).
export const PHASE_CONFIG = {
  spec: { floor: "flagship", strength: sol,   lensSet: "spec" },
  plan: { floor: "flagship", strength: sol,   lensSet: "plan" },
  impl: { floor: "standard", strength: terra, lensSet: "impl" },
};

// -------- runGate (C2) --------

function gateError(phase, status, reason, extra = {}) {
  return {
    phase, consensus_verdict: "error", status, reason,
    reviewers: [], findings: [], blockers: [], dissent: [], abstentions: [], ...extra,
  };
}

function lensesFor(phase) {
  if (phase === "spec") return SPEC_LENSES;
  if (phase === "plan") return PLAN_LENSES;
  return LENSES.filter((l) => IMPL_LENS_KEYS.includes(l.key)); // impl
}

// M7 -- read a repo-relative file with hard containment. Rejects absolute paths, any `..` segment,
// and (via realpath) a symlink whose real target escapes the authorized cwd. Missing / unreadable /
// binary -> throws with a `status` the caller maps to no_reviewable_target. NEVER reads outside cwd.
function readContained(cwd, rel, deps) {
  const realpath = deps.realpath ?? fs.realpathSync;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  if (typeof rel !== "string" || !rel.trim()) throw Object.assign(new Error("empty file path"), { status: "no_reviewable_target" });
  if (path.isAbsolute(rel)) throw Object.assign(new Error(`absolute path not allowed: ${rel}`), { status: "path_not_contained" });
  if (rel.split(/[\\/]/).includes("..")) throw Object.assign(new Error(`'..' segment not allowed: ${rel}`), { status: "path_not_contained" });

  let cwdReal;
  try { cwdReal = realpath(cwd); } catch { cwdReal = path.resolve(cwd); }
  const abs = path.resolve(cwdReal, rel);

  let real;
  try { real = realpath(abs); } catch { throw Object.assign(new Error(`missing/unreadable file: ${rel}`), { status: "no_reviewable_target" }); }
  const back = path.relative(cwdReal, real);
  if (back.startsWith("..") || path.isAbsolute(back)) {
    throw Object.assign(new Error(`path escapes the repo: ${rel}`), { status: "path_not_contained" });
  }

  let text;
  try { text = readFile(real); } catch { throw Object.assign(new Error(`unreadable file: ${rel}`), { status: "no_reviewable_target" }); }
  text = String(text ?? "");
  if (text.indexOf(String.fromCharCode(0)) !== -1) throw Object.assign(new Error(`binary file not reviewable: ${rel}`), { status: "no_reviewable_target" });
  return text;
}

// Returns { block, content, files }: `block` is the labeled payload fed to reviewers; `content` is
// the raw file text ONLY (no labels) so a caller can tell whether the files carry real review
// material -- a non-whitespace label must never make a content-empty document look reviewable.
// `files` is the per-file { rel, text } list (additive: feeds the direct bundle's file_texts).
function foldFiles(cwd, files, label, deps) {
  let block = "", content = "";
  const out = [];
  for (const rel of files) {
    const text = readContained(cwd, rel, deps);
    block += `\n--- ${label}: ${rel} ---\n${text}\n`;
    content += text;
    out.push({ rel, text });
  }
  return { block, content, files: out };
}

function localRunGit(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout ?? "";
}

// The revision label folded into the direct lens preamble.
// git cwds: HEAD + dirty flag; no-git cwds: the pinned sentinel.
//
// Final-review fix: a no-git project directory nested INSIDE an enclosing git repo (e.g. a
// no-git project living under a git-managed workspace root) must NOT inherit the enclosing
// repo's HEAD/dirty state -- `git rev-parse HEAD` / `git status` walk UP the tree to the
// nearest .git, so a naive check mislabels the project as the enclosing repo AND runs
// `git status` across the whole enclosing tree from a project with no repo of its own. Guard
// by resolving the actual toplevel FIRST (via the same runGit seam) and only trusting HEAD when
// that toplevel is the cwd itself (its own repo root) -- never an ancestor/enclosing repo.
// Ordered so NO further git command runs once the toplevel check fails.
export function revisionLabel(cwd, runGit = localRunGit) {
  let toplevel;
  try {
    toplevel = runGit(["rev-parse", "--show-toplevel"], cwd).trim();
  } catch {
    return "revision: none (no-git project)";
  }
  if (!toplevel) return "revision: none (no-git project)";

  // Resolve both sides through the real filesystem so a symlink, short-name, or trailing-slash
  // difference can't produce a false "own repo" match. Unresolvable -> not this project's repo.
  let toplevelReal, cwdReal;
  try {
    toplevelReal = path.resolve(fs.realpathSync(toplevel)).toLowerCase();
    cwdReal = path.resolve(fs.realpathSync(cwd)).toLowerCase();
  } catch {
    return "revision: none (no-git project)";
  }
  if (toplevelReal !== cwdReal) return "revision: none (no-git project)"; // enclosing/ancestor repo, not this project's

  try {
    const head = runGit(["rev-parse", "HEAD"], cwd).trim();
    const dirty = runGit(["status", "--porcelain"], cwd).trim() !== "";
    return `revision: ${head}${dirty ? " (dirty)" : ""}`;
  } catch {
    return "revision: none (no-git project)";
  }
}

// runGate: phase -> (lenses, strength, floor) router over runPanel. Fail-CLOSED throughout.
//   - spec/plan REQUIRE target_files (the document reviewed); their full text is folded in and a
//     gate NEVER inherits the panel's empty_diff/pass.
//   - context_files supply supporting context (parent spec / source); unreadable context -> error.
//   - the cwd is authorized BEFORE any file read; paths are containment-checked; the whole
//     payload is byte-capped and any truncation BLOCKS.
//   - the phase-floor is enforced on the requested strength (pre-dispatch) and on the panel-recorded
//     backbone strength (post-completion).
export async function runGate({ phase, cwd: cwdArg, base, scope = "auto", target_files = [], context_files = [], strength, payloadRef } = {}, deps = {}) {
  // cwd is optional (server.mjs). Admission already resolves an omitted cwd to this process's folder, so
  // every later step (file reads, the diff, the panel) must use that SAME folder, never undefined.
  const cwd = cwdArg ?? process.cwd();
  const cfg = PHASE_CONFIG[phase];
  if (!cfg) return gateError(phase, "unknown_phase", `unknown phase '${phase}' (expected spec|plan|impl)`);

  // (1) Requested-strength floor check BEFORE any dispatch or file read (pre-dispatch).
  const resolved = strength ?? cfg.strength;
  if (_belowFloor(resolved, cfg.floor)) {
    return gateError(phase, "strength_below_floor",
      `phase '${phase}' requires reviewer strength >= ${cfg.floor}`,
      { strength: { weakest: resolved, floor: cfg.floor } });
  }

  // (2) Authorize the cwd BEFORE reading any file. max -> admitDirect EXACTLY-ONCE (the
  // panel validates the branded decision; the sync admit is NOT also called); non-max -> the
  // EXISTING shipped flow verbatim.
  const isMax = _tierOf(resolved) === "max";
  let directAdmission = null;
  if (isMax) {
    directAdmission = await (deps.admitDirect ?? _admitDirect)({ cwd, needs_git: phase === "impl" });
    if (!directAdmission.allowed) {
      return gateError(phase, "blocked", directAdmission.reason, {
        project: directAdmission.project,
        ...(directAdmission.detail != null ? { detail: directAdmission.detail } : {}),
      });
    }
  } else {
    const _admit = deps.admit ?? admit;
    // Mirrors the admitDirect call above: spec/plan phases never touch git (they review named
    // target_files, not a diff -- see foldFiles/readContained), so only 'impl' needs it.
    const gate = _admit({ kind: "adversarial_review", cwd, needs_git: phase === "impl" });
    if (!gate.allowed) return gateError(phase, "blocked", gate.reason, { project: gate.project });
  }

  // (3) spec/plan MUST name a target document (never review nothing).
  const requiresTarget = phase === "spec" || phase === "plan";
  if (requiresTarget && (!Array.isArray(target_files) || target_files.length === 0)) {
    return gateError(phase, "no_reviewable_target", `phase '${phase}' requires target_files (the document under review)`);
  }

  // (4) Read target + context files under containment.
  let target, context;
  try {
    target = foldFiles(cwd, target_files || [], "TARGET FILE", deps);
    context = foldFiles(cwd, context_files || [], "CONTEXT FILE", deps);
  } catch (e) {
    return gateError(phase, e.status ?? "no_reviewable_target", e.message);
  }

  // spec/plan: the TARGET document itself must carry non-whitespace content. A content-empty
  // or whitespace-only target must NOT slip through on the strength of its injected filename label.
  if (requiresTarget && !target.content.trim()) {
    return gateError(phase, "no_reviewable_target", `phase '${phase}' target document has no reviewable (non-whitespace) content`);
  }

  // (5) impl folds in the diff. If a pinned payloadRef is supplied (detached run),
  // review those EXACT bytes -- never re-gather the live tree.
  let diffText = "";
  if (phase === "impl") {
    try {
      if (payloadRef) {
        diffText = payloadRef.kind === "commit"
          ? (deps.runGit ?? localRunGit)(["diff", `${payloadRef.sha}~1..${payloadRef.sha}`], cwd)
          : (deps.readFile ?? ((p) => fs.readFileSync(p, "utf8")))(payloadRef.path);
      } else {
        const g = (deps.gatherDiff ?? _gatherDiff)({ cwd, base, scope, diffCap: DEFAULT_GATE_CAP }, deps.runGit, deps.readFile);
        diffText = g.diff || "";
      }
    } catch (e) {
      return gateError(phase, "diff_error", e.message);
    }
  }

  // (6) A gate NEVER passes reviewing nothing. The guard is on CONTENT (labels excluded), so a
  // filename header can never masquerade as review material for any phase, and context files are
  // supporting material only: they never make an otherwise empty review target reviewable.
  let payload = diffText + target.block + context.block;
  if (!(diffText + target.content).trim()) {
    return gateError(phase, "no_reviewable_target", "no reviewable (non-whitespace) content in the target and/or diff");
  }

  // (7) One byte cap over the WHOLE payload; any truncation is recorded and BLOCKS downstream.
  const cap = deps.diffCap ?? DEFAULT_GATE_CAP;
  let truncated = false;
  if (payload.length > cap) { payload = payload.slice(0, cap) + `\n\n[...gate payload truncated at ${cap} bytes...]`; truncated = true; }

  // (8) Run the phase panel over the payload (fed via an injected gatherDiff so the fail-closed
  //     manifest/aggregate machinery is reused verbatim). Max runs additionally hand the panel a
  //     direct bundle + the already-obtained admission (exactly-once).
  const runPanel = deps.runPanel ?? _runPanel;
  const directOpts = isMax ? {
    direct: {
      timeoutMs: parseDirectTimeout(),
      // Zero-git-in-PII short-circuit: when the
      // resolved policy does not affirmatively allow git, NEVER invoke git on the cwd -- not
      // even revisionLabel's read-only rev-parse (git status can touch optional index state /
      // fsmonitor hooks on an unexpected repo). Label value is identical (the sentinel);
      // only the side effect is removed. Fail-closed: missing git_allowed -> no git.
      revision: directAdmission.policy.git_allowed
        ? revisionLabel(cwd, deps.runGit ?? localRunGit)
        : "revision: none (no-git project)",
      evidence_kind: phase === "impl" ? "diff" : "document",
      target_files: target_files || [],
      context_files: context_files || [],
      file_texts: Object.fromEntries(
        [...target.files, ...context.files].map((f) => [normalizePayloadPath(f.rel), f.text])),
      embedded_diff: diffText,
      regatherDiff: phase === "impl"
        ? () => (deps.gatherDiff ?? _gatherDiff)({ cwd, base, scope, diffCap: DEFAULT_GATE_CAP }, deps.runGit, deps.readFile).diff
        : null,
    },
  } : {};
  const res = await runPanel(
    {
      cwd, base, scope, lenses: lensesFor(phase), model: resolved.model, effort: resolved.effort,
      // Mirrors this function's own admission pre-check (step 2) and admitDirect's needs_git --
      // runPanel's companion path re-authorizes independently (defense in depth) and
      // needs the same signal, or a spec/plan phase would be admitted here but re-blocked there.
      needs_git: phase === "impl",
      ...directOpts,
    },
    {
      ...(deps.panelDeps || {}),
      ...(isMax ? { admission: directAdmission } : {}),
      beforeSubmit: deps.beforeSubmit,
      afterSubmit: deps.afterSubmit,
      gatherDiff: () => ({
        diff: payload, bytes: payload.length, truncated,
        scope: phase === "impl" ? (scope || "auto") : "target-files",
        base: base || "main", treeClean: !truncated,
      }),
    }
  );

  // (9) Effective-strength floor recheck (post-completion). If the backbone strength the panel
  //     actually recorded is below the floor, refuse to hand back a pass.
  const backboneWeakest = (res.strength && res.strength.backbone_weakest) || resolved;
  if (_belowFloor(backboneWeakest, cfg.floor)) {
    return gateError(phase, "strength_below_floor",
      `effective backbone strength is below the '${cfg.floor}' floor`,
      { strength: { weakest: backboneWeakest, floor: cfg.floor } });
  }

  const blockers = (res.findings || []).filter((f) => f.severity === "blocker");
  const out = { ...res, phase, strength: { ...(res.strength || {}), floor: cfg.floor }, blockers };
  // Effective strength could not be independently attested by the provider on THIS run (companion
  // status did not surface request.model/effort). Requested strength was enforced pre-dispatch, so
  // we flag rather than block. Verified live against the companion: a real completed
  // job's status carries job.request.model/effort and effectiveStrength reads it correctly, so this
  // flag is an error-case exception, not the steady state.
  if (res.strength && res.strength.backbone_attested === false && !isMax) out.strength_unverified = true;
  return out;
}

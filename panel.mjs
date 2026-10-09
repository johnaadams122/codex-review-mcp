// panel.mjs -- synchronous, fail-CLOSED adversarial review panel.
//
// Design:
//  - SYNCHRONOUS: runs to completion in one call. No panel_id, no persistence, no state owner.
//  - fail-CLOSED consensus: pass ONLY if every configured reviewer completed, every reviewer
//    returned pass, and no reviewer reported a blocker-severity finding. Any abstention/error
//    -> block. All reviewers abstaining -> error. Never a false pass.
//  - Diff travels via --prompt-file (submitTaskViaFile), NOT argv (Windows ~32K limit), with a
//    size cap. Ordering is authorize-cwd -> gather-diff -> redact-payload -> submit.
//  - One canonical decoder (decodeReviewerResult) parses every reviewer's output.
//
// Reviewers run through the existing background-job + admission + reaper infrastructure as
// codex `task` calls (model=flagship sol, effort=xhigh, write=false). The diff is embedded in
// the prompt so a reviewer is pure analysis and never needs repo write / git exec.

import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { admit, redactSecrets, isBrandedDirectAdmission } from "./admission.mjs";
import { submitTaskViaFile, getStatus, getResult, cancelJob, extractAnswerText as _extractAnswerText, pollToTerminal } from "./jobs.mjs";
import { CODEX_TIERS } from "./routing.mjs";
import { codexProvider, assignReviewers, ROLES, pickTransport, directCodexProvider } from "./reviewers.mjs";
import { tierOf, tierRank } from "./strength.mjs";
import { readCommandExecutionEvents } from "./direct.mjs";

// pollToTerminal + TERMINAL now live in jobs.mjs (C1, vendor-neutral). Re-export pollToTerminal so
// any caller/test importing it from panel keeps resolving.
export { pollToTerminal } from "./jobs.mjs";

export const DEFAULT_DIFF_CAP = parseInt(process.env.CODEX_PANEL_DIFF_CAP ?? "200000", 10);
// Flagship reviewer wall for the COMPANION transport. runGate calls runPanel without a
// timeoutMs, so this is the wall every ordinary gate runs on. It was 480000 (8 min) while
// the max/direct path already allowed parseDirectTimeout()'s 1200000 -- gpt-5.6-sol/xhigh
// blew through 8 min on three consecutive real spec-review runs, and since any abstention blocks
// fail-closed, that reads as "the document fails" rather than "the reviewer needed longer".
// Same [60s, 2h] clamp as the direct transport; a garbage value falls back rather than
// becoming NaN, which would make every deadline comparison false and poll forever.
export function parsePanelTimeout(env = process.env) {
  const raw = parseInt(env.CODEX_PANEL_TIMEOUT_MS ?? "", 10);
  const v = Number.isFinite(raw) ? raw : 1800000;
  return Math.min(7200000, Math.max(60000, v));
}
export const DEFAULT_PANEL_TIMEOUT_MS = parsePanelTimeout();
export const DEFAULT_POLL_INTERVAL_MS = parseInt(process.env.CODEX_PANEL_POLL_MS ?? "3000", 10);

// Each lens reviews the SAME diff but is told to challenge only its own dimension.
export const LENSES = [
  {
    key: "correctness",
    title: "Correctness and logic",
    instruction:
      "Hunt for correctness defects introduced by this diff: wrong logic, off-by-one, " +
      "null/undefined hazards, unhandled errors, race conditions, broken invariants, " +
      "incorrect edge-case handling, and tests that assert the wrong thing. " +
      "A blocker is any defect that would produce wrong output or a crash on a realistic input.",
  },
  {
    key: "security-pii",
    title: "Security, secrets, and PII",
    instruction:
      "Hunt for security and privacy defects: injected/leaked secrets or credentials, PII " +
      "written to logs or transmitted, missing redaction, injection vectors, unsafe shell/exec, " +
      "path traversal, and weakened auth or permission checks. " +
      "A blocker is any change that exposes a secret/PII or opens an exploitable hole.",
  },
  {
    key: "design-simplicity",
    title: "Design and simplicity",
    instruction:
      "Hunt for design defects: needless complexity, duplicated logic that should be reused, " +
      "leaky abstractions, dead code, and changes that fight the surrounding conventions. " +
      "A blocker is reserved for a design flaw that is likely to cause a real bug or make the " +
      "change unsafe to ship; style nits are 'minor', not blockers.",
  },
];

// -------- diff gathering --------

function defaultRunGit(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout ?? "";
}

const defaultReadFile = (p) => fs.readFileSync(p, "utf8");

// The full content of every untracked, non-gitignored file. `--exclude-standard` honors
// .gitignore, so build artifacts / node_modules do NOT leak in -- only genuinely new, unreviewed
// files. These are folded into the diff in EVERY scope: `git diff` (tracked or committed) never
// shows untracked files, so without this a scope whose diff is empty could look clean while
// unreviewed code sits in the tree -- a false "pass" (any scope, including branch).
// A git path list. `-z` output (NUL-separated) is never quoted, so it is split exactly. A newline list
// (plain git output, or a test fake) C-quotes unusual names, so each quoted line is decoded; a line
// that cannot be decoded is kept as given, which then reads as unreadable (fail closed).
export function parseGitPathList(out) {
  const s = String(out ?? "");
  if (s.includes("\0")) return s.split("\0").filter((x) => x !== "");
  return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((x) => unquoteGitPath(x) ?? x);
}

// Untracked, non-ignored files by their real names: plain `git ls-files` would C-quote a non-ASCII
// name ("caf\303\251.mjs"), which matches no file on disk.
export function listUntrackedFiles(cwd, runGit = defaultRunGit) {
  return parseGitPathList(runGit(["ls-files", "-z", "--others", "--exclude-standard"], cwd));
}

function untrackedFilesBlock(cwd, runGit, readFile) {
  const untracked = listUntrackedFiles(cwd, runGit);
  let extra = "";
  for (const rel of untracked) {
    let content;
    try {
      content = readFile(path.join(cwd, rel));
    } catch {
      content = "<unreadable>";
    }
    extra += `\n--- NEW UNTRACKED FILE: ${rel} ---\n${content}\n`;
  }
  return extra;
}

// scope: "working-tree" (uncommitted vs HEAD) | "branch" (base...HEAD) | "auto" (working-tree,
// fall back to branch when the working tree is clean). Untracked files are folded into ALL
// scopes. Hard byte cap.
export function gatherDiff({ cwd: cwdArg, base, scope = "auto", diffCap = DEFAULT_DIFF_CAP } = {}, runGit = defaultRunGit, readFile = defaultReadFile) {
  // An omitted cwd means this process's folder: git already runs there, so the untracked-file reads must too.
  const cwd = cwdArg ?? process.cwd();
  const baseRef = base || "main";
  const untracked = untrackedFilesBlock(cwd, runGit, readFile);
  let raw = "";
  let usedScope = scope;
  if (scope === "branch") {
    raw = runGit(["diff", `${baseRef}...HEAD`], cwd) + untracked;
  } else if (scope === "working-tree") {
    raw = runGit(["diff", "HEAD"], cwd) + untracked;
  } else {
    const workingTree = runGit(["diff", "HEAD"], cwd) + untracked;
    if (workingTree.trim()) {
      raw = workingTree;
      usedScope = "working-tree";
    } else {
      raw = runGit(["diff", `${baseRef}...HEAD`], cwd) + untracked; // untracked is "" here
      usedScope = "branch";
    }
  }
  // Whole-tree cleanliness (tracked-modified + staged + untracked). Used to gate the empty-diff
  // fast-path: a narrow scope (esp. "branch") can produce an empty diff while the working tree
  // still holds unreviewed changes it did not capture. `porcelain` empty == nothing anywhere.
  const treeClean = runGit(["status", "--porcelain"], cwd).trim() === "";

  const bytes = raw.length;
  let diff = raw;
  let truncated = false;
  if (bytes > diffCap) {
    diff = raw.slice(0, diffCap) + `\n\n[...diff truncated at ${diffCap} of ${bytes} bytes...]`;
    truncated = true;
  }
  return { diff, bytes, truncated, scope: usedScope, base: baseRef, treeClean };
}

// -------- prompts --------

export function buildLensPrompt(lens, diff, { truncated = false } = {}) {
  return [
    `You are an adversarial code reviewer. Review ONLY the "${lens.title}" dimension.`,
    lens.instruction,
    truncated
      ? "NOTE: the diff was truncated to fit a size cap; review what is present and do not assume the omitted part is safe."
      : "",
    "",
    "Respond with ONLY one JSON object and no other text, no markdown fences:",
    `{"lens":"${lens.key}","verdict":"pass|block","confidence":"low|medium|high",` +
      `"findings":[{"severity":"blocker|major|minor","file":"path","line":0,"summary":"..."}]}`,
    'Set verdict to "block" if and only if you find at least one blocker-severity issue in this ' +
      'dimension; otherwise "pass". Be strict. If you CANNOT fully review the diff (it is ' +
      'unreadable, binary, minified, or you lack enough context to judge), you MUST return ' +
      '"block" with a finding of severity "blocker" explaining why -- NEVER return "pass" for ' +
      'anything you could not fully review.',
    "",
    "--- BEGIN DIFF ---",
    diff,
    "--- END DIFF ---",
  ].join("\n");
}

// -------- the one canonical reviewer-result decoder --------

// The ONLY keys a conforming reviewer verdict object may carry. Any other key -> fail closed.
const REVIEWER_KEYS = new Set(["lens", "verdict", "confidence", "findings"]);

// Canonical severity vocabulary. Reviewers phrase severities inconsistently ("BLOCKER",
// "critical", "high"), so we lowercase and map synonyms. An UNRECOGNIZED severity on a finding
// means a reviewer flagged something we cannot classify -- fail CLOSED and treat it as a blocker
// rather than silently downgrading it to minor (which would let a real blocker slip to "pass").
const SEVERITY_SYNONYMS = {
  blocker: "blocker", critical: "blocker", crit: "blocker", high: "blocker", severe: "blocker",
  fatal: "blocker", security: "blocker",
  major: "major", medium: "major", moderate: "major", warning: "major", warn: "major",
  minor: "minor", low: "minor", trivial: "minor", nit: "minor", info: "minor", style: "minor",
  cosmetic: "minor", suggestion: "minor",
};

export function normalizeSeverity(sev) {
  const s = String(sev ?? "").toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(SEVERITY_SYNONYMS, s) ? SEVERITY_SYNONYMS[s] : "blocker";
}

// Returns a normalized finding, or null when the finding is structurally malformed (a non-object,
// or a scalar field carrying a non-scalar value like {..}/[..]). A null return propagates to
// decodeReviewerResult as parse_failed -> abstention -> block: we do not trust a "pass" from a
// reviewer whose findings are garbled, because the garbling could be hiding a real blocker.
function normalizeFinding(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  if (f.file !== undefined && f.file !== null && typeof f.file !== "string") return null;
  if (f.summary !== undefined && f.summary !== null && typeof f.summary !== "string") return null;
  let line = null;
  if (f.line !== undefined && f.line !== null) {
    if (typeof f.line === "number" && Number.isFinite(f.line)) line = f.line;
    else if (typeof f.line === "string" && /^\d+$/.test(f.line.trim())) line = parseInt(f.line, 10);
    else return null; // non-scalar / non-numeric line -> malformed -> fail closed
  }
  return {
    severity: normalizeSeverity(f.severity),
    file: typeof f.file === "string" ? f.file : null,
    line,
    summary: typeof f.summary === "string" ? f.summary : "",
  };
}

// Returns [start,end] index pairs for every brace-balanced TOP-LEVEL {...} region in text, in
// source order. Scans forward once, tracking JSON string state and backslash escapes, so a brace
// inside a string value ("body must be {\"type\":\"json_schema\"}") never disturbs the depth count.
// Regions that are not valid JSON (prose braces, {{MUSTACHE}}) are still reported; the caller
// decides by attempting a parse.
export function _topLevelObjectSpans(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        spans.push([start, i]);
        start = -1;
      }
    }
  }
  return spans;
}

// Accepts a raw string OR a getResult() object ({output|summary|rendered}). Tolerant of
// markdown fences and surrounding prose. Returns {ok:true, verdict} or {ok:false, reason}.
export function decodeReviewerResult(raw, extractAnswerText = _extractAnswerText, allowedKeys = REVIEWER_KEYS) {
  // Answer-text extraction lives in the PROVIDER (default jobs.extractAnswerText) -- the transport
  // layer owns the knowledge of vendor result shapes so this decoder stays pure JSON-verdict parsing.
  let text = String(extractAnswerText(raw) ?? "").replace(/```(?:json)?/gi, "");
  // An ABSENT answer is not a MALFORMED answer, and conflating them led to
  // misdiagnosis. A read that lands while the companion has written the terminal
  // status but not yet `result.rawOutput` extracts to "" -- which used to fall through to
  // parse_failed and read as "the reviewer emitted garbage the decoder cannot handle". It is the
  // opposite: there is nothing to decode YET. Naming it separately is what lets runPanel re-READ
  // instead of discarding a completed multi-minute review. Still fail-closed: an unresolved
  // empty_result is an abstention, and an abstention still blocks.
  if (!text.trim()) return { ok: false, reason: "empty_result" };
  // Take the LAST brace-balanced top-level object that actually parses -- never a blind
  // indexOf("{")..lastIndexOf("}") slice. A reviewer quoting ANY brace in prose (a request body,
  // a {{PLACEHOLDER}}, a provider block) corrupted that slice and produced parse_failed ->
  // abstention -> block, so a spec containing JSON was structurally harder to pass than one
  // without. Measured: two consecutive real gates over a JSON-dense protocol lost the
  // SAME two lenses (contradictions-ambiguity, edge-cases-risks) to parse_failed both times --
  // deterministic, and indistinguishable from a document verdict because it fails closed.
  let parsed = null;
  const spans = _topLevelObjectSpans(text);
  for (let i = spans.length - 1; i >= 0; i--) {
    const [s, e] = spans[i];
    let candidate;
    try {
      candidate = JSON.parse(text.slice(s, e + 1));
    } catch {
      continue; // prose braces and mustache placeholders are not JSON -- keep looking backwards
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate;
      break; // FIRST parseable object from the end wins; no fallback past it, so a non-conforming
             // answer still fails closed instead of being rescued by an earlier decoy.
    }
  }
  if (parsed === null) return { ok: false, reason: "parse_failed" };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "parse_failed" };
  // Strict shape: reject any unknown top-level key. A reviewer that stuffs blocking content into
  // an extra field (e.g. {"verdict":"pass","notes":"BLOCKER: leak","findings":[]}) must not decode
  // as a clean pass -- unknown keys mean the output does not conform, so fail closed (-> block).
  if (Object.keys(parsed).some((k) => !allowedKeys.has(k))) return { ok: false, reason: "parse_failed" };
  const verdict = String(parsed.verdict ?? "").toLowerCase().trim();
  if (verdict !== "pass" && verdict !== "block") return { ok: false, reason: "parse_failed" };
  // Findings must be absent/empty or a well-formed array of objects. A non-array `findings`, or
  // an array containing any non-object element, is a MALFORMED reviewer output -- fail CLOSED
  // (parse_failed -> abstention -> block) rather than silently dropping a possibly-blocker
  // finding and letting the pass verdict stand.
  let findings;
  if (parsed.findings === undefined || parsed.findings === null) {
    findings = [];
  } else if (Array.isArray(parsed.findings)) {
    const mapped = parsed.findings.map(normalizeFinding);
    if (mapped.some((f) => f === null)) return { ok: false, reason: "parse_failed" };
    findings = mapped;
  } else {
    return { ok: false, reason: "parse_failed" };
  }
  const confidence = ["low", "medium", "high"].includes(String(parsed.confidence).toLowerCase())
    ? String(parsed.confidence).toLowerCase()
    : "low";
  const verdictObj = { lens: parsed.lens ?? null, verdict, confidence, findings };
  if (allowedKeys.has("files_checked")) {
    verdictObj.files_checked = parsed.files_checked;
    verdictObj.files_checked_note = parsed.files_checked_note;
  }
  return { ok: true, verdict: verdictObj };
}

// -------- aggregation (fail-CLOSED state machine: pass | block | error) --------

function dedupeFindings(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const key = `${f.file}|${f.line}|${f.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function lensKeyOf(x) {
  if (x == null) return null;
  return typeof x === "string" ? x : (x.key ?? null);
}

function weakestStrength(list) {
  const ran = list
    .map((o) => ({ model: (o.verdict && o.verdict.model) ?? o.model, effort: (o.verdict && o.verdict.effort) ?? o.effort }))
    .filter((s) => s.model || s.effort);
  if (ran.length === 0) return null;
  let w = ran[0];
  for (const s of ran) if (tierRank(tierOf(s)) < tierRank(tierOf(w))) w = s;
  return w;
}

// Identity-safe, role-aware aggregation over the immutable assignment manifest.
//   manifest: [{ assignment_id, lens, role }]   (built BEFORE availability checks)
//   outcomes: [{ assignment_id, lens, role, ok, verdict?, reason?, model?, effort? }]
// A missing `role` defaults to "backbone" (fail-CLOSED: an untyped reviewer is treated as required).
// Pass iff EVERY expected backbone assignment_id appears exactly once, completed, and passed; AND no
// blocker-severity finding from anyone who completed; AND the diff was not truncated. Advisory
// reviewers add strictness only -- a block/blocker escalates, an absence is recorded and ignored.
// Any missing / duplicate / unknown / role-mismatched backbone identity, an unbacked required lens,
// or zero backbone configured -> error (structural, distinct from a reviewer-driven block).
// truncated=true means reviewers did NOT see the whole diff -> a pass would be unsound.
export function aggregate(outcomes, { manifest = [], truncated = false } = {}) {
  const roleOf = (o) => o.role ?? "backbone";
  const backboneManifest = manifest.filter((m) => (m.role ?? "backbone") === "backbone");
  const expectedIds = backboneManifest.map((m) => m.assignment_id);
  const expectedIdSet = new Set(expectedIds);
  const manifestById = new Map(backboneManifest.map((m) => [m.assignment_id, m]));

  const identityErrors = [];

  // Zero backbone configured -> error.
  if (expectedIds.length === 0) identityErrors.push({ reason: "no_backbone_configured" });

  // A malformed manifest that itself repeats a backbone assignment_id -> error. Without this a
  // single real outcome could be double-counted across the repeated ids into a false quorum.
  if (expectedIds.length !== expectedIdSet.size) identityErrors.push({ reason: "duplicate_manifest_assignment" });

  // A required lens carrying an advisory assignment but NO backbone assignment -> error.
  const lensKeys = new Set(manifest.map((m) => lensKeyOf(m.lens)).filter((k) => k != null));
  for (const key of lensKeys) {
    const forLens = manifest.filter((m) => lensKeyOf(m.lens) === key);
    if (!forLens.some((m) => (m.role ?? "backbone") === "backbone")) {
      identityErrors.push({ lens: key, reason: "advisory_only_required_lens" });
    }
  }

  const backboneOutcomes = outcomes.filter((o) => roleOf(o) === "backbone");
  const advisoryOutcomes = outcomes.filter((o) => roleOf(o) === "advisory");

  // Index backbone outcomes by assignment_id (identity).
  const byId = new Map();
  for (const o of backboneOutcomes) {
    const id = o.assignment_id ?? "__no_id__";
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(o);
  }
  for (const [id, list] of byId) {
    if (!expectedIdSet.has(id)) identityErrors.push({ assignment_id: id, reason: "unknown_assignment" });
    else if (list.length > 1) identityErrors.push({ assignment_id: id, reason: "duplicate_assignment" });
  }

  const abstentions = [];
  const backboneCompleted = [];
  for (const id of expectedIds) {
    const list = byId.get(id) || [];
    if (list.length === 0) { abstentions.push({ assignment_id: id, lens: lensKeyOf(manifestById.get(id)?.lens), reason: "missing" }); continue; }
    if (list.length !== 1) continue; // duplicate already flagged
    const o = list[0];
    if (o.ok) backboneCompleted.push(o);
    // `diag` (when the outcome carries one) records WHAT was actually read at the moment the
    // decode failed. Without it an investigation has to reconstruct that
    // from job files after the fact, and that is not always possible: a `reason` alone cannot
    // distinguish "the reviewer emitted garbage" from "we read a truncated copy of a good answer".
    else abstentions.push({ assignment_id: id, lens: lensKeyOf(o.lens), reason: o.reason, ...(o.diag ? { diag: o.diag } : {}) });
  }

  const advisoryCompleted = advisoryOutcomes.filter((o) => o.ok);
  const advisoryIgnored = advisoryOutcomes.filter((o) => !o.ok).map((o) => ({ lens: lensKeyOf(o.lens), reason: o.reason }));

  const completed = [...backboneCompleted, ...advisoryCompleted];

  let consensus_verdict;
  if (identityErrors.length > 0) {
    consensus_verdict = "error";
  } else if (backboneCompleted.length === 0) {
    consensus_verdict = "error"; // nobody backbone could judge -> fail-closed, distinct from block
  } else {
    const anyBlockVerdict = completed.some((o) => o.verdict.verdict === "block");
    const anyBlockerFinding = completed.some((o) => (o.verdict.findings || []).some((f) => f.severity === "blocker"));
    const allBackbonePresent = abstentions.length === 0 && backboneCompleted.length === expectedIds.length && !truncated;
    consensus_verdict = allBackbonePresent && !anyBlockVerdict && !anyBlockerFinding ? "pass" : "block";
  }

  const findings = dedupeFindings(
    completed.flatMap((o) => (o.verdict.findings || []).map((f) => ({ ...f, lens: lensKeyOf(o.verdict.lens) ?? lensKeyOf(o.lens) })))
  );
  const reviewers = completed.map((o) => o.verdict);
  const dissent =
    consensus_verdict === "error"
      ? []
      : completed
          .filter((o) => o.verdict.verdict !== consensus_verdict)
          .map((o) => ({ lens: lensKeyOf(o.verdict.lens) ?? lensKeyOf(o.lens), verdict: o.verdict.verdict, confidence: o.verdict.confidence }));

  const strength = {
    weakest: weakestStrength(completed),
    backbone_weakest: weakestStrength(backboneCompleted),
    advisory_weakest: weakestStrength(advisoryCompleted),
    // True only when EVERY completed backbone reviewer's effective strength was provider-attested.
    backbone_attested: backboneCompleted.length > 0 && backboneCompleted.every((o) => o.verdict && o.verdict.strength_attested === true),
  };

  return {
    consensus_verdict, reviewers, findings, dissent, abstentions,
    advisory_ignored: advisoryIgnored, identity_errors: identityErrors, strength,
  };
}

// -------- orchestration --------

export async function runPanel(opts = {}, deps = {}) {
  const {
    cwd: cwdArg,
    base,
    scope = "auto",
    lenses = LENSES,
    diffCap = DEFAULT_DIFF_CAP,
    timeoutMs = DEFAULT_PANEL_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = opts;
  // An omitted cwd means this process's folder, the same folder admission resolves it to.
  const cwd = cwdArg ?? process.cwd();

  // The panel is a FLAGSHIP gate by definition: every reviewer runs on the
  // flagship model at its effort. There is deliberately no quality/tier downgrade knob -- a
  // weaker reviewer returning "pass" would be a non-conforming, unsafe verdict. model/effort
  // remain overridable only for tests.
  const model = opts.model ?? CODEX_TIERS.flagship.model;
  const effort = opts.effort ?? CODEX_TIERS.flagship.effort;

  // ---- transport resolution FIRST (single transport per run) ----
  // Effective strength per lens = per-lens override ?? run-level ?? default.
  // opts.lens_strengths ({ [lensKey]: {model,effort} }) is the internal per-lens override
  // channel; no MCP schema exposes it yet, but the resolution and pickTransport semantics are
  // implemented in full (an all-max lens map over a non-max default IS a direct run).
  const resolvedStrengths = lenses.map((l) =>
    (opts.lens_strengths && opts.lens_strengths[l.key]) ?? ({ model, effort }));
  const transport = (deps.pickTransport ?? pickTransport)(resolvedStrengths);
  const meta0 = { model, effort, scope, base: base || "main", lenses: lenses.map((l) => l.key) };
  const emptyErr = (status, reason) => ({
    consensus_verdict: "error", status, ...(reason ? { reason } : {}),
    reviewers: [], findings: [], dissent: [], abstentions: [], ...meta0,
  });
  if (transport === "mixed") return emptyErr("mixed_transport_unsupported",
    "all reviewers must run at max for a direct run; mixed strengths have no transport");
  if (transport === "direct") {
    const eff = resolvedStrengths[0]; // all lenses resolved to max (definition of "direct")
    meta0.model = eff.model; meta0.effort = eff.effort;
    return runDirectPanel({ cwd, base, scope, lenses, diffCap, pollIntervalMs,
      model: eff.model, effort: eff.effort, directOpts: opts.direct || {}, meta: meta0, emptyErr }, deps);
  }
  if (deps.admission) return emptyErr("admission_required",
    "companion runs must not carry a direct admission (exactly-once, direct only)");
  // ---- companion path continues UNCHANGED below ----

  const _admit = deps.admit ?? admit;
  const _gatherDiff = deps.gatherDiff ?? gatherDiff;
  const _redact = deps.redactSecrets ?? redactSecrets;
  const _poll = deps.pollToTerminal ?? pollToTerminal;
  const _assign = deps.assignReviewers ?? assignReviewers;
  // Transient-read tolerance. Both knobs recover a reviewer whose answer EXISTS but
  // whose store record was momentarily unreadable; neither can turn a failure into a pass.
  const _sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const resultRetries = deps.resultRetries ?? 3;              // 4 reads total, ~12s of backoff
  const resultRetryDelayMs = deps.resultRetryDelayMs ?? 2000; // linear: 2s, 4s, 6s
  const missingReadsBeforeNotFound = deps.missingReadsBeforeNotFound ?? 4;

  // Provider set. Default = [codexProvider] (the sole backbone today). When the caller injects
  // legacy per-fn deps (submitReviewer/getResult/cancelJob) but no explicit providers, wrap them
  // into a synthetic backbone provider so pre-seam callers/tests keep working byte-for-byte.
  const providers = deps.providers ?? [legacyOrCodexProvider(deps)];

  const meta = { model, effort, scope, base: base || "main", lenses: lenses.map((l) => l.key) };

  // 1. Authorize the cwd FIRST -- a PII/non-git cwd is refused before any diff is read.
  // `opts.needs_git` (default true, matching every existing companion-path caller -- e.g.
  // codex_review_panel, always git-diff based) lets gate.mjs's spec/plan phases opt out
  // explicitly: they inject their own gatherDiff below (the folded target_files text, never a
  // real git diff) and so never need policy.git_allowed. This is a SEPARATE
  // admission check from gate.mjs's own pre-check (defense in depth: "authorize
  // before any file/diff read" -- gate.mjs authorizes before reading target_files, this
  // authorizes again before gatherDiff runs) -- both must agree, so needs_git threads through
  // to both rather than only the one gate.mjs happens to run first.
  const gate = _admit({ kind: "adversarial_review", cwd, needs_git: opts.needs_git ?? true });
  if (!gate.allowed) {
    return {
      consensus_verdict: "error",
      status: "blocked",
      reason: gate.reason,
      project: gate.project,
      reviewers: [],
      findings: [],
      dissent: [],
      abstentions: [],
      ...meta,
    };
  }

  // 2. Gather the diff (only on an authorized cwd).
  let gathered;
  try {
    gathered = _gatherDiff({ cwd, base, scope, diffCap }, deps.runGit);
  } catch (e) {
    return {
      consensus_verdict: "error",
      status: "diff_error",
      reason: e.message,
      reviewers: [],
      findings: [],
      dissent: [],
      abstentions: [],
      ...meta,
    };
  }
  const { diff, truncated, bytes, treeClean } = gathered;
  meta.scope = gathered.scope;
  meta.base = gathered.base;
  meta.diff_bytes = bytes;
  meta.diff_truncated = truncated;

  if (!diff.trim()) {
    // An empty scoped diff is a clean "pass" ONLY when the whole working tree is clean. If the
    // tree is dirty (e.g. tracked-but-uncommitted edits under "branch" scope), the scope missed
    // real changes -- fail CLOSED rather than wave them through.
    if (treeClean) {
      return {
        consensus_verdict: "pass",
        status: "empty_diff",
        reviewers: [],
        findings: [],
        dissent: [],
        abstentions: [],
        ...meta,
      };
    }
    return {
      consensus_verdict: "error",
      status: "empty_scope_dirty_tree",
      reason: "the requested scope produced an empty diff, but the working tree has uncommitted changes it did not capture; use scope=auto or working-tree to review them",
      reviewers: [],
      findings: [],
      dissent: [],
      abstentions: [],
      ...meta,
    };
  }

  // 3. Redact the payload before it leaves the gate.
  const redacted = _redact(diff);

  // 4. Build the immutable assignment manifest BEFORE any dispatch, then submit each
  //    reviewer via its provider -- SEQUENTIALLY (store-race root cause: the
  //    companion's saveState is an unlocked read-modify-write that DELETES jobs absent from
  //    its stale list; parallel lens submissions were the primary trigger of ghosted
  //    sibling jobs / "1/3 lenses completed" panels. Serialization costs ~1s per lens
  //    against multi-minute reviews; polling below stays concurrent -- reads don't write
  //    the store).
  const manifest = _assign(lenses, providers);
  const submissions = [];
  for (const entry of manifest) {
    const prompt = buildLensPrompt(entry.lens, redacted, { truncated });
    // Write-ahead budget veto -- ask BEFORE submitting a reviewer job.
    const dec = deps.beforeSubmit ? await deps.beforeSubmit({ lens: entry.lens.key }) : { ok: true };
    if (!dec || dec.ok === false) { submissions.push({ entry, job_id: null, budgetCapped: true }); continue; }
    try {
      const r = await entry.provider.submit(prompt, { model, effort, cwd });
      // The AFTER-submit seam -- the jobId now EXISTS (it would not at the beforeSubmit seam). Persist it best-effort so
      // the reaper can OBSERVE (never kill) a leaked reviewer worker. NEVER fail the submit on a persist error.
      if (deps.afterSubmit && r && r.jobId) { try { await deps.afterSubmit({ lens: entry.lens.key, jobId: r.jobId }); } catch { /* best-effort jobId persist */ } }
      submissions.push({ entry, job_id: r.jobId });
    } catch (e) {
      submissions.push({ entry, job_id: null, submitError: e.message });
    }
  }

  // 5. Poll each reviewer to terminal, decode; cancel/cleanup anything that did not complete.
  //    Every outcome carries its assignment_id + role + strength so aggregate matches by identity.
  const outcomes = await Promise.all(
    submissions.map(async (s) => {
      const { entry } = s;
      const base0 = { assignment_id: entry.assignment_id, lens: entry.lens.key, role: entry.role, model, effort };
      if (!s.job_id) return { ...base0, ok: false, reason: s.budgetCapped ? "budget_capped" : "submit_failed" };
      let status;
      try {
        status = await _poll(s.job_id, { cwd, timeoutMs, pollIntervalMs, missingReadsBeforeNotFound }, (id, c) => entry.provider.getStatus(id, { cwd: c }));
      } catch {
        try { await entry.provider.cancel(s.job_id, { cwd }); } catch { /* best-effort */ }
        return { ...base0, ok: false, reason: "poll_error" };
      }
      if (status !== "completed" && status !== "succeeded") {
        try { await entry.provider.cancel(s.job_id, { cwd }); } catch { /* best-effort */ }
        return { ...base0, ok: false, reason: status === "timeout" ? "timeout" : "error" };
      }
      // Bounded RE-READ on ANY decode failure. The job is already terminal and the
      // reviewer has already answered; every remaining failure mode here is a READ artifact:
      //   - empty extract      -- read between the status write and the result write
      //   - TRUNCATED extract  -- getResult's own fallback ladder. When the companion call throws
      //                           "No job found" (transient store race) and the disk record is not
      //                           readable yet, getResult falls back to the progressPreview capture,
      //                           which is truncated -- jobs.mjs names preview truncation as a
      //                           parse_failed source in exactly these panel decodes.
      //
      // An earlier revision retried ONLY `empty_result`, reasoning that a garbled verdict would
      // re-read identically so retrying was pointless. That was wrong, and a real gate proved it
      // the same day: a 3-lens run recorded 1 reviewer + 2 `parse_failed` abstentions while ALL
      // THREE job records on disk carried complete, well-formed, decodable verdicts (block/8,
      // block/15, block/13). The text was not empty, so the retry never fired. Re-reading is free
      // and idempotent; a genuinely malformed verdict simply re-reads the same and still abstains,
      // so this cannot convert a bad review into a pass. The job is NEVER re-submitted.
      let decoded;
      let diag = null;
      for (let attempt = 0; ; attempt++) {
        let result;
        try {
          result = await entry.provider.getResult(s.job_id, { cwd });
        } catch {
          return { ...base0, ok: false, reason: "result_error" };
        }
        decoded = decodeReviewerResult(result, entry.provider.extractAnswerText);
        if (decoded.ok) break;
        // Capture what we actually read, so a surviving abstention explains itself.
        let answerBytes = -1;
        try { answerBytes = String(entry.provider.extractAnswerText(result) ?? "").length; } catch { /* best-effort capture only */ }
        diag = {
          reads: attempt + 1,
          answer_bytes: answerBytes,
          synthesized: Boolean(result && result._synthesized),      // preview-derived => truncated source
          disk_recovered: Boolean(result && result._diskRecovered),
        };
        if (attempt >= resultRetries) break;
        if (resultRetryDelayMs > 0) await _sleep(resultRetryDelayMs * (attempt + 1));
      }
      if (!decoded.ok) return { ...base0, ok: false, reason: decoded.reason, diag };
      // Record the EFFECTIVE strength the provider actually ran, when it can attest it
      // (reads request.model/effort back from the job status); otherwise fall back to the requested
      // strength (which was enforced pre-dispatch) and mark the outcome as strength-unattested.
      let eff = null;
      if (typeof entry.provider.effectiveStrength === "function") {
        try { eff = await entry.provider.effectiveStrength(s.job_id, { cwd }); } catch { eff = null; }
      }
      const usedModel = (eff && eff.model) || model;
      const usedEffort = (eff && eff.effort) || effort;
      // Tag with the lens/role we ASSIGNED -- never trust the model's self-report.
      decoded.verdict.lens = entry.lens.key;
      decoded.verdict.role = entry.role;
      decoded.verdict.model = usedModel;
      decoded.verdict.effort = usedEffort;
      decoded.verdict.strength_attested = eff != null;
      return { ...base0, ok: true, verdict: decoded.verdict, model: usedModel, effort: usedEffort };
    })
  );

  // 6. Aggregate under the fail-closed state machine. A truncated diff can never pass.
  const agg = aggregate(outcomes, { manifest, truncated });
  return { ...agg, status: "complete", ...meta };
}

// Wrap legacy per-fn deps into a ReviewerProvider so pre-seam callers keep working. Returns the
// real codexProvider when no legacy transport deps are injected.
function legacyOrCodexProvider(deps) {
  if (!deps.submitReviewer && !deps.getResult && !deps.cancelJob && !deps.getStatus) return codexProvider;
  return {
    name: "codex",
    role: ROLES.BACKBONE,
    submit: async (prompt, o) => {
      const s = deps.submitReviewer ?? ((p, oo) => submitTaskViaFile(p, { ...oo, write: false }));
      const r = await s(prompt, o);
      return { jobId: r.jobId ?? r.job_id };
    },
    getStatus: (id, o = {}) => (deps.getStatus ?? getStatus)(id, o.cwd),
    getResult: (id, o = {}) => (deps.getResult ?? getResult)(id, o.cwd),
    extractAnswerText: (raw) => _extractAnswerText(raw),
    cancel: (id, o = {}) => (deps.cancelJob ?? cancelJob)(id, o.cwd),
  };
}

// ---------------- payload identity + budgets (pure helpers) ----------------

// The ONE parse point for CODEX_DIRECT_TIMEOUT_MS : default
// 1,200,000, clamp [60,000 .. 7,200,000]. Every downstream reader uses the manifest value.
export function parseDirectTimeout(env = process.env) {
  const raw = parseInt(env.CODEX_DIRECT_TIMEOUT_MS ?? "", 10);
  const v = Number.isFinite(raw) ? raw : 1200000;
  return Math.min(7200000, Math.max(60000, v));
}

// git C-quoted path decode. Undecodable -> null (caller fails closed: payload_parse_error).
// git writes each byte of a non-ASCII name as its own octal escape, so the escapes are collected as
// BYTES and the whole name is decoded as UTF-8 at the end (decoding each escape as its own character
// turned an existing "cafe-acute.mjs" into a name that matches no file, which read as a deletion).
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
export function unquoteGitPath(raw) {
  const s = String(raw ?? "");
  if (!s.startsWith('"')) return s;
  if (!s.endsWith('"') || s.length < 2) return null;
  const bytes = [];
  const pushText = (t) => { for (const b of Buffer.from(t, "utf8")) bytes.push(b); };
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== "\\") {
      // keep a surrogate pair together so a raw astral character encodes as one UTF-8 sequence
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      pushText(ch);
      i += ch.length - 1;
      continue;
    }
    const n = s[++i];
    // an escape that would consume the closing quote leaves the string unterminated
    if (n === undefined || i >= s.length - 1) return null;
    if (n === "\\" || n === '"') pushText(n);
    else if (n === "t") pushText("\t");
    else if (n === "n") pushText("\n");
    else if (n === "r") pushText("\r");
    else if (/[0-7]/.test(n)) {
      const oct = s.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      const v = parseInt(oct, 8);
      if (v > 0xFF) return null;
      bytes.push(v);
      i += 2;
    } else return null;
  }
  try { return UTF8_STRICT.decode(Uint8Array.from(bytes)); } catch { return null; }
}

// `diff --git <A> <B>` -> [aPath, bPath] with a/ b/ stripped (covers renames/copies -- both
// sides). Quoted sides decode per git's rules; ambiguous unquoted splits -> null (fail closed).
export function parseDiffHeaderPaths(line) {
  const rest = String(line).slice("diff --git ".length);
  let aRaw, bRaw;
  if (rest.startsWith('"')) {
    let i = 1, closed = -1;
    while (i < rest.length) {
      if (rest[i] === "\\") i += 2;
      else if (rest[i] === '"') { closed = i; break; }
      else i++;
    }
    if (closed === -1 || rest[closed + 1] !== " ") return null;
    aRaw = rest.slice(0, closed + 1);
    bRaw = rest.slice(closed + 2).trim();
  } else {
    const candidates = [];
    let idx = rest.indexOf(" b/");
    while (idx !== -1) { candidates.push([rest.slice(0, idx), rest.slice(idx + 1)]); idx = rest.indexOf(" b/", idx + 1); }
    const valid = candidates.filter(([a, b]) => a.startsWith("a/") && b.startsWith("b/"));
    if (valid.length === 0) return null;
    if (valid.length > 1) {
      const key = (v) => `${v[0]}|${v[1]}`;
      if (!valid.every((v) => key(v) === key(valid[0]))) return null; // ambiguous
    }
    [aRaw, bRaw] = valid[0];
  }
  const a = unquoteGitPath(aRaw);
  const b = unquoteGitPath(bRaw);
  if (a === null || b === null) return null;
  const strip = (p) => (p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p);
  return [strip(a), strip(b)];
}

// Normalization: forward slashes, case-insensitive. NOTE: a/ b/ prefix stripping is
// NOT done here -- it is parseDiffHeaderPaths's job (only it knows which token is a diff-header
// side vs. a real path). Stripping here too would double-strip diff-header output, mangling any
// real path under a repo's own top-level a/ or b/ directory (e.g. "a/foo.mjs" -> "foo.mjs"),
// which corrupts the tree baseline key and silently defeats the recheck (fail-open TOCTOU).
// This function must stay idempotent and safe for real a/ and b/ directories.
export function normalizePayloadPath(p) {
  return String(p ?? "").replace(/\\/g, "/").toLowerCase();
}

// payload_files (pinned producer): computed ONCE at assembly. Deleted paths remain --
// they identify the reviewed change. Undecodable header/label -> payload_parse_error.
export function computePayloadFiles({ payload, target_files = [], context_files = [] }) {
  const out = new Set();
  for (const rel of [...target_files, ...context_files]) out.add(normalizePayloadPath(rel));
  const diff_set = new Set();
  // Untracked files are changed files too, but kept apart from diff_set: diff_set carries diff-header
  // provenance for the pure-deletion waiver, and an untracked entry can read as missing (a dangling
  // link) without being a deletion.
  const untracked_set = new Set();
  for (const line of String(payload ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const pair = parseDiffHeaderPaths(line);
      if (pair === null) return { error: "payload_parse_error" };
      for (const p of pair) { const n = normalizePayloadPath(p); out.add(n); diff_set.add(n); }
    } else if (line.startsWith("--- TARGET FILE: ") && line.endsWith(" ---")) {
      const p = line.slice("--- TARGET FILE: ".length, -4);
      if (!p.trim()) return { error: "payload_parse_error" };
      out.add(normalizePayloadPath(p));
    } else if (line.startsWith("--- NEW UNTRACKED FILE: ") && line.endsWith(" ---")) {
      const p = line.slice("--- NEW UNTRACKED FILE: ".length, -4);
      if (!p.trim()) return { error: "payload_parse_error" };
      const n = normalizePayloadPath(p); out.add(n); untracked_set.add(n);
    } else if (line.startsWith("--- CONTEXT FILE: ") && line.endsWith(" ---")) {
      const p = line.slice("--- CONTEXT FILE: ".length, -4);
      if (!p.trim()) return { error: "payload_parse_error" };
      out.add(normalizePayloadPath(p));
    }
  }
  return {
    payload_files: [...out],
    diff_set: [...diff_set],
    untracked_set: [...untracked_set],
    target_set: (target_files || []).map(normalizePayloadPath),
  };
}

function sha256hex(data) { return createHash("sha256").update(data).digest("hex"); }

// Typed assembly-time entry: lstat under readContained-equivalent containment; NEVER
// throws -- every failure collapses to a deterministic entry string. ESCAPE extends the
// typed vocabulary in the same never-followed spirit as LINK_ESCAPE (a diff-derived rel that is
// absolute / '..' / UNC, or whose realpath leaves cwd_real, is never READ; the absolute/'..'/UNC
// forms are rejected before any resolution, under "the same containment rules as
// readContained"). Mirrors
// validateFilesChecked on the decode side.
export function computeTreeEntry(cwd_real, rel, deps = {}) {
  const lstat = deps.lstat ?? fs.lstatSync;
  const realpath = deps.realpath ?? fs.realpathSync;
  const readRaw = deps.readFileRaw ?? ((p) => fs.readFileSync(p));
  const r = String(rel ?? "");
  if (path.isAbsolute(r) || /^[A-Za-z]:/.test(r) || r.startsWith("\\\\") || r.split(/[\\/]/).includes("..")) {
    return "ESCAPE"; // readContained containment: never resolved, never read
  }
  const abs = path.resolve(cwd_real, r);
  let st;
  try { st = lstat(abs); } catch (e) { return e && e.code === "ENOENT" ? "ABSENT" : "UNREADABLE"; }
  try {
    if (st.isSymbolicLink()) {
      const real = realpath(abs);
      const back = path.relative(realpath(cwd_real), real);
      if (back.startsWith("..") || path.isAbsolute(back)) return "LINK_ESCAPE"; // never followed
      return "LINK:" + sha256hex(readRaw(real));
    }
    if (st.isFile()) {
      // realpath containment on the RESOLVED path too: a regular leaf reached through a
      // symlinked parent dir escapes lstat-leaf detection; readContained's rule catches it.
      const real = realpath(abs);
      const back = path.relative(realpath(cwd_real), real);
      if (back.startsWith("..") || path.isAbsolute(back)) return "ESCAPE";
      return "SHA256:" + sha256hex(readRaw(real));
    }
    return "NONREGULAR"; // directory / gitlink / other
  } catch { return "UNREADABLE"; }
}

// Assembly-snapshot binding (per source): target/context entries hash the SAME
// in-memory bytes foldFiles used (file_texts, keyed by normalized path); diff-derived paths
// read from disk capture-adjacent. "__payload__" pins the stored redacted payload bytes.
export function computeTreeBaseline({ cwd_real, payload_files, file_texts = {}, storedPayload }, deps = {}) {
  // `files` is a NULL-prototype map so a payload file literally named "__proto__" becomes a real
  // own entry (a plain {} would swallow it through the prototype setter and never recheck it).
  // The stored-payload hash lives in a SEPARATE `payload` field, not a reserved key inside the
  // filename namespace, so a real file named "__payload__" can no longer clobber it or be
  // skipped on recheck.
  const files = Object.create(null);
  for (const rel of payload_files) {
    files[rel] = Object.prototype.hasOwnProperty.call(file_texts, rel)
      ? "SHA256:" + sha256hex(Buffer.from(String(file_texts[rel]), "utf8"))
      : computeTreeEntry(cwd_real, rel, deps);
  }
  return { files, payload: "SHA256:" + sha256hex(Buffer.from(String(storedPayload ?? ""), "utf8")) };
}

// Immediately-before-aggregate recheck: recompute every entry identically from disk;
// ANY difference (including a race flipping a file UNREADABLE) -> tree_changed. The embedded
// diff is re-gathered and byte-compared when a regather thunk is provided.
export function recheckTreeBaseline(baseline, { cwd_real, regatherDiff, embeddedDiff } = {}, deps = {}) {
  for (const [rel, was] of Object.entries(baseline.files)) {
    const now = computeTreeEntry(cwd_real, rel, deps);
    if (now !== was) return { changed: true, rel, was, now };
  }
  if (typeof regatherDiff === "function") {
    let again;
    try { again = regatherDiff(); } catch { return { changed: true, rel: "__diff__" }; }
    if (String(again) !== String(embeddedDiff ?? "")) return { changed: true, rel: "__diff__" };
  }
  return { changed: false };
}

// ---------------- direct decode rules (violations -> parse_failed -> abstention) ----------------

export const DIRECT_REVIEWER_KEYS = new Set([...REVIEWER_KEYS, "files_checked", "files_checked_note"]);

// Direct lens preamble: verification against actual files is REQUIRED and audited;
// reads restricted to the repo; revision label included; files_checked is mandatory output.
export function buildDirectLensPrompt(lens, payload, { truncated = false, revision = "" } = {}) {
  return [
    `You are an adversarial max-strength reviewer. Review ONLY the "${lens.title}" dimension.`,
    lens.instruction,
    "",
    "You run with READ-ONLY filesystem access to the repository at your working directory.",
    "You MUST verify the document's load-bearing claims against the actual files before",
    "returning a verdict. Restrict every read to the repository at your working directory.",
    "Read PURPOSEFULLY: open only the files needed to verify or refute a specific claim in",
    "the payload -- targeted reads, never exploratory browsing of the repository.",
    "Never attempt to write, and never run git commands that mutate anything; on a project",
    "without git metadata, do not run git at all.",
    revision ? `Payload ${revision}` : "",
    truncated ? "NOTE: the payload was truncated to fit a size cap; never assume the omitted part is safe." : "",
    "",
    "Respond with ONLY one JSON object and no other text, no markdown fences:",
    `{"lens":"${lens.key}","verdict":"pass|block","confidence":"low|medium|high",` +
      `"findings":[{"severity":"blocker|major|minor","file":"path","line":0,"summary":"..."}],` +
      `"files_checked":["repo-relative/path"],"files_checked_note":"why no external check was needed (optional)"}`,
    '"files_checked" is REQUIRED: list every repository file you actually opened, as relative',
    "paths (no absolute paths, no '..'). If the document genuinely required no external",
    'verification, return "files_checked": [] and say why in "files_checked_note".',
    'Set verdict to "block" if and only if you find at least one blocker-severity issue in this',
    'dimension; otherwise "pass". Be strict. If you CANNOT fully review the payload you MUST',
    'return "block" with a blocker-severity finding explaining why.',
    "",
    "--- BEGIN PAYLOAD ---",
    payload,
    "--- END PAYLOAD ---",
  ].join("\n");
}

// files_checked decode rules: array of strings; entries non-empty, not ".", relative,
// no ..-segments / absolute / drive / UNC forms, no case-insensitive duplicates, each resolving
// (realpath) to a REGULAR FILE inside cwd_real.
export function validateFilesChecked(list, { cwd_real } = {}, deps = {}) {
  const realpath = deps.realpath ?? fs.realpathSync;
  const statFn = deps.stat ?? fs.statSync;
  if (!Array.isArray(list)) return { ok: false };
  let cwdReal;
  try { cwdReal = realpath(cwd_real); } catch { return { ok: false }; }
  const seen = new Set();
  const entries = [];
  for (const e of list) {
    if (typeof e !== "string" || !e.trim() || e.trim() === ".") return { ok: false };
    if (path.isAbsolute(e) || /^[A-Za-z]:/.test(e) || e.startsWith("\\\\")) return { ok: false };
    if (e.split(/[\\/]/).includes("..")) return { ok: false };
    const norm = normalizePayloadPath(e);
    if (seen.has(norm)) return { ok: false };
    seen.add(norm);
    let real;
    try { real = realpath(path.resolve(cwdReal, e)); } catch { return { ok: false }; }
    const back = path.relative(cwdReal, real);
    if (back.startsWith("..") || path.isAbsolute(back)) return { ok: false };
    let st;
    try { st = statFn(real); } catch { return { ok: false }; }
    if (!st.isFile()) return { ok: false };
    entries.push(norm);
  }
  return { ok: true, entries };
}

// Corroboration (normative): normalized entry -- or its basename when unique across
// payload_files UNION files_checked -- occurring as a substring of a normalized command /
// aggregated_output field. Substring is deliberate (paths ride inside quotes/arguments); the
// permissive direction only grants MORE corroboration for a SECONDARY control.
export function corroborateEntries(entries, events, payload_files) {
  const haystacks = (events || []).map((e) =>
    (String(e.command ?? "") + "\n" + String(e.aggregated_output ?? "")).replace(/\\/g, "/").toLowerCase());
  const counts = new Map();
  for (const p of new Set([...(payload_files || []), ...entries])) {
    const b = p.split("/").pop();
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  // Boundary-tightened substring: a match only counts when it
  // is not an infix of a LONGER file name -- "beta.mjs" must not corroborate entry "a.mjs",
  // "a.mjs2" must not corroborate "a.mjs". The char before the match must not be filename-run
  // [a-zA-Z0-9_.-] (a path separator/space/quote/start is fine); the char after must not extend
  // the name with [a-zA-Z0-9_]. Stricter matching only ever UN-corroborates -- fail-closed.
  // A-Z is defensive hardening only: the shipped call path lowercases BOTH sides (haystacks
  // above; entries via validateFilesChecked/normalizePayloadPath), but this export must not
  // hand a future caller a case-sensitivity trap.
  const bounded = (h, needle) => {
    for (let i = h.indexOf(needle); i !== -1; i = h.indexOf(needle, i + 1)) {
      const before = i === 0 ? "" : h[i - 1];
      const after = i + needle.length >= h.length ? "" : h[i + needle.length];
      if (!/[a-zA-Z0-9_.-]/.test(before) && !/[a-zA-Z0-9_]/.test(after)) return true;
    }
    return false;
  };
  const out = [];
  for (const entry of entries) {
    const base = entry.split("/").pop();
    const allowBase = counts.get(base) === 1;
    if (haystacks.some((h) => bounded(h, entry) || (allowBase && bounded(h, base)))) out.push(entry);
  }
  return out;
}

// Pass-evidence rule. Blocks never need corroboration; an empty-files_checked block
// still requires a non-empty note ("a block may always carry empty files_checked with
// a non-empty note"). Document kind (spec/plan): a corroborated TARGET entry (contexts do NOT satisfy) AND (a corroborated entry OUTSIDE
// payload_files OR a non-whitespace note). Diff kind (impl/panel): a corroborated diff-named
// entry. Pure-deletion waiver (deletionWaiver, computed by the DECODER from diff_set:
// it checks diff_set existence on disk, not context files): corroborated entries OR
// empty files_checked + non-empty note.
export function passEvidenceSatisfied({ verdict, evidence_kind, corroborated, payload_files,
  target_set, diff_set, untracked_set = [], files_checked, note, deletionWaiver }) {
  const noteOk = typeof note === "string" && note.trim().length > 0;
  if (verdict !== "pass") return files_checked.length > 0 || noteOk; // a block may carry empty files_checked only WITH a non-empty note
  if (deletionWaiver) {
    return corroborated.length > 0 || (files_checked.length === 0 && noteOk);
  }
  if (evidence_kind === "document") {
    const targetHit = corroborated.some((e) => target_set.includes(e));
    const outside = corroborated.some((e) => !payload_files.includes(e));
    return targetHit && (outside || noteOk);
  }
  // Diff kind: a corroborated entry the change names, from a diff header or as an untracked file.
  return corroborated.some((e) => diff_set.includes(e) || untracked_set.includes(e));
}

// The direct decoder: canonical JSON decode with the extended key set, then the direct rules.
export function decodeDirectReviewerResult(raw, ctx, deps = {}) {
  const decoded = decodeReviewerResult(raw, ctx.extractAnswerText, DIRECT_REVIEWER_KEYS);
  if (!decoded.ok) return decoded;
  const v = decoded.verdict;
  const note = v.files_checked_note;
  if (note !== undefined && note !== null && (typeof note !== "string" || !note.trim())) {
    return { ok: false, reason: "parse_failed" }; // trimmed non-whitespace string is the only accepted shape
  }
  const fc = validateFilesChecked(v.files_checked, { cwd_real: ctx.cwd_real }, deps);
  if (!fc.ok) return { ok: false, reason: "parse_failed" };
  const corroborated = corroborateEntries(fc.entries, ctx.events, ctx.payload_files);
  const exists = deps.exists ?? fs.existsSync;
  // Deletion-waiver eligibility rides diff_set PROVENANCE: a
  // diff-kind payload whose diff-named files are ALL gone from disk. An existing context or
  // target file never disables it, and a document-kind run never triggers it.
  // Any untracked entry disables the waiver: it is not a deletion even when it reads as missing.
  const deletionWaiver = ctx.evidence_kind === "diff" && (ctx.diff_set || []).length > 0
    && (ctx.untracked_set || []).length === 0
    && !ctx.diff_set.some((rel) => exists(path.resolve(ctx.cwd_real, rel)));
  const evidenceOk = passEvidenceSatisfied({
    verdict: v.verdict, evidence_kind: ctx.evidence_kind, corroborated,
    payload_files: ctx.payload_files, target_set: ctx.target_set, diff_set: ctx.diff_set,
    untracked_set: ctx.untracked_set || [], files_checked: fc.entries, note, deletionWaiver,
  });
  if (!evidenceOk) return { ok: false, reason: "parse_failed" };
  v.files_checked = fc.entries;
  v.files_checked_note = typeof note === "string" ? note : undefined;
  return { ok: true, verdict: v };
}

// The direct-transport panel run. Fail-closed at every step.
async function runDirectPanel({ cwd, base, scope, lenses, diffCap = DEFAULT_DIFF_CAP,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, model, effort, directOpts, meta, emptyErr }, deps = {}) {
  const realpath = deps.realpath ?? fs.realpathSync;
  const admission = deps.admission;

  // (8a step 2) admission validation: present, branded, allowed, right kind, cwd match,
  // needs_git consistency (self-gathering diff -> must be true; injected gatherDiff -> either).
  if (!admission) return emptyErr("admission_required", "direct run requires a branded admission");
  if (!isBrandedDirectAdmission(admission) || admission.allowed !== true || admission.kind !== "direct_review") {
    return emptyErr("admission_required", "invalid, forged, or stale direct admission");
  }
  let cwdReal;
  try { cwdReal = realpath(cwd ?? process.cwd()); } catch { return emptyErr("admission_required", "cwd unresolvable"); }
  if (admission.cwd_real !== cwdReal) return emptyErr("admission_required", "admission cwd mismatch");
  const selfGather = !deps.gatherDiff;
  if (selfGather && admission.needs_git !== true) {
    return emptyErr("admission_required", "self-gathering diff requires a needs_git admission");
  }

  // Assembly: gather (self or injected), empty-diff short-circuit identical to companion.
  let gathered;
  try { gathered = (deps.gatherDiff ?? gatherDiff)({ cwd, base, scope, diffCap }, deps.runGit); }
  catch (e) { return emptyErr("diff_error", e.message); }
  const { diff, truncated, bytes, treeClean } = gathered;
  meta.scope = gathered.scope; meta.base = gathered.base;
  meta.diff_bytes = bytes; meta.diff_truncated = truncated;
  if (!diff.trim()) {
    if (treeClean) return { consensus_verdict: "pass", status: "empty_diff", reviewers: [], findings: [], dissent: [], abstentions: [], ...meta };
    return emptyErr("empty_scope_dirty_tree",
      "the requested scope produced an empty diff, but the working tree has uncommitted changes it did not capture");
  }

  // Redaction FIRST; the redacted payload is STORED and hashed -- reviewers receive
  // exactly the hashed bytes. Panel-level redaction covers max codex_review_panel runs whose
  // payload never passes through gate.mjs (admission.policy rides deps.admission).
  // Unconditional across projects BY DESIGN: the redaction-first pipeline is unscoped and
  // the shipped companion panel already redacts every payload -- PII cwds additionally RELY on
  // it ("payload already secret-redacted for PII cwds at the gate"); non-PII redaction is
  // the same shipped posture, not a new behavior.
  const redacted = (deps.redactSecrets ?? redactSecrets)(diff);

  // payload_files + per-source tree baseline (8a-bis bundle content).
  const pf = computePayloadFiles({
    payload: redacted,
    target_files: directOpts.target_files ?? [],
    context_files: directOpts.context_files ?? [],
  });
  if (pf.error) return emptyErr("payload_parse_error", "undecodable diff header or target label in the payload");
  const timeoutMs = directOpts.timeoutMs ?? parseDirectTimeout();
  const baseline = computeTreeBaseline({
    cwd_real: cwdReal, payload_files: pf.payload_files,
    file_texts: directOpts.file_texts ?? {}, storedPayload: redacted,
  }, deps);
  const bundle = {
    admission, timeoutMs, payload_files: pf.payload_files, target_set: pf.target_set,
    diff_set: pf.diff_set, untracked_set: pf.untracked_set, revision: directOpts.revision ?? "", tree_baseline: baseline,
    evidence_kind: directOpts.evidence_kind ?? "diff",
    // Re-gather through the SAME channel used at assembly (injected or self). An EXPLICIT null
    // from the caller disables the compare: document gates (spec/plan) have no diff-derived
    // paths, and the re-gather byte-compare applies to diff paths only (the gate supplies
    // its own git-backed regatherDiff for impl runs). Only undefined takes the
    // fallback; `??` must not swallow the null contract.
    regatherDiff: directOpts.regatherDiff === undefined
      ? (() => (deps.gatherDiff ?? gatherDiff)({ cwd, base, scope, diffCap }, deps.runGit).diff)
      : directOpts.regatherDiff,
    embedded_diff: directOpts.embedded_diff ?? diff,
  };

  // Manifest (verbatim) with the direct bundle on each assignment.
  const provider = (deps.providers ?? [directCodexProvider]).find((p) => p.role === ROLES.BACKBONE) ?? directCodexProvider;
  const manifest = (deps.assignReviewers ?? assignReviewers)(lenses, [provider]).map((m) => ({ ...m, direct: bundle }));

  // Submit opts: sourced from the branded admission + resolved strength, never re-derived.
  const submitOpts = {
    model, effort, cwd_real: admission.cwd_real,
    pii: Boolean(admission.policy && admission.policy.pii_sensitive),
    timeoutMs, binaryIdentity: admission.binaryIdentity,
  };

  // Fan-out with allSettled drain: submitDirect owns its internal 60s deadline; on any
  // submit failure, cancel + finalize every submitted job before acting on outcomes.
  const settled = await Promise.allSettled(manifest.map(async (entry) => {
    const prompt = buildDirectLensPrompt(entry.lens, redacted, { truncated, revision: bundle.revision });
    const r = await entry.provider.submit(prompt, submitOpts, deps.providerDeps ?? {});
    return { entry, job_id: r.jobId };
  }));
  const submissions = settled.map((s, i) => s.status === "fulfilled"
    ? s.value : { entry: manifest[i], job_id: null });
  const anySubmitFailed = submissions.some((s) => !s.job_id);
  if (anySubmitFailed) {
    for (const s of submissions) {
      if (!s.job_id) continue;
      try { await s.entry.provider.cancel(s.job_id); } catch { /* best-effort */ }
      if (s.entry.provider.finalize) { try { await s.entry.provider.finalize(s.job_id); } catch (e) { ((deps.log) ?? console.error)(`a1-direct: finalize failed (job ${s.job_id}): ${e && e.message}`); } }
    }
  }

  // Poll -> decode (direct rules) -> attest -> finalize (per-reviewer finally).
  const outcomes = await Promise.all(submissions.map(async (s) => {
    const b0 = { assignment_id: s.entry.assignment_id, lens: s.entry.lens.key, role: s.entry.role, model, effort };
    if (!s.job_id || anySubmitFailed) return { ...b0, ok: false, reason: "submit_failed" };
    try {
      const status = await (deps.pollToTerminal ?? pollToTerminal)(
        s.job_id, { cwd, timeoutMs: timeoutMs + 60000, pollIntervalMs },
        (id) => s.entry.provider.getStatus(id));
      if (status !== "completed") {
        try { await s.entry.provider.cancel(s.job_id); } catch { /* best-effort */ }
        return { ...b0, ok: false, reason: status === "timeout" ? "timeout" : "error" };
      }
      let result;
      try { result = await s.entry.provider.getResult(s.job_id); } catch { return { ...b0, ok: false, reason: "result_error" }; }
      const events = (deps.readEvents ?? readCommandExecutionEvents)(s.job_id);
      const decoded = decodeDirectReviewerResult(result, {
        extractAnswerText: (raw) => s.entry.provider.extractAnswerText(raw),
        cwd_real: cwdReal, events, payload_files: bundle.payload_files,
        target_set: bundle.target_set, diff_set: bundle.diff_set, untracked_set: bundle.untracked_set,
        evidence_kind: bundle.evidence_kind,
      }, deps);
      if (!decoded.ok) return { ...b0, ok: false, reason: decoded.reason };
      // 10a -- attested-or-no-pass: the receipt must prove the exact requested pair.
      let eff = null;
      try { eff = await s.entry.provider.effectiveStrength(s.job_id); } catch { eff = null; }
      if (!eff || eff.model !== model || eff.effort !== effort) {
        return { ...b0, ok: false, reason: "strength_unattested" };
      }
      decoded.verdict.lens = s.entry.lens.key;
      decoded.verdict.role = s.entry.role;
      decoded.verdict.model = eff.model;
      decoded.verdict.effort = eff.effort;
      decoded.verdict.strength_attested = true;
      return { ...b0, ok: true, verdict: decoded.verdict, model: eff.model, effort: eff.effort };
    } finally {
      if (s.entry.provider.finalize) {
        // logged, never reclassifies the reviewer
        try { await s.entry.provider.finalize(s.job_id); } catch (e) { ((deps.log) ?? console.error)(`a1-direct: finalize failed (job ${s.job_id}): ${e && e.message}`); }
      }
    }
  }));

  // Tree recheck immediately before aggregate: any drift -> tree_changed error.
  const recheck = recheckTreeBaseline(bundle.tree_baseline,
    { cwd_real: cwdReal, regatherDiff: bundle.regatherDiff, embeddedDiff: bundle.embedded_diff }, deps);
  if (recheck.changed) {
    return emptyErr("tree_changed", `payload input changed during review: ${recheck.rel}`);
  }

  const agg = aggregate(outcomes, { manifest, truncated });
  return { ...agg, status: "complete", transport: "direct", ...meta };
}

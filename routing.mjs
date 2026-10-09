const GEMMA_PATTERNS = [
  /\b(summarize|summarise|classify|extract|label|triage)\b/i,
  /\byes.?or.?no\b/i,
  /\bhigh.?medium.?low\b/i,
];

const MULTI_FILE_PATTERNS = [
  /\bmultiple files\b/i,
  /\bacross files\b/i,
  /\bseveral files\b/i,
  /\brefactor the \w+ (module|system|codebase)\b/i,
];

const CODEX_PATTERNS = [
  ...MULTI_FILE_PATTERNS,
  /\b(implement|refactor|rewrite|migrate|fix bug|add feature|autonomous fix)\b/i,
  /\b(code review|spec review|plan review|adversarial review|implementation review)\b/i,
  /\breview (this|the) (implementation|spec|design|code|plan|changes)\b/i,
];

const IRREVERSIBLE_KEYWORDS = ["drop ", "delete ", "truncate ", "reset ", "rm -rf", "wipe ", "purge "];

const VALID_FORCE_TIERS = new Set(["local", "gemma", "codex", "claude"]);   // "gemma" = deprecated alias for "local" (the former name)

export function computeRoute(task, policy, forceTier = null, opts = {}) {
  const lower = String(task ?? "").toLowerCase();
  const risk_flags = [];
  const writeRequested = Boolean(opts.write);

  if (policy.pii_sensitive) risk_flags.push("sensitive_project");
  if (MULTI_FILE_PATTERNS.some((re) => re.test(lower))) risk_flags.push("multi_file");
  if (IRREVERSIBLE_KEYWORDS.some((kw) => lower.includes(kw))) risk_flags.push("irreversible");

  // PII projects: Codex may READ (review/analysis) but never WRITE. A write request on a
  // PII project is redirected to Claude; read-only tasks route normally. Write is also
  // independently gated in the orchestrator (effective_write = write && write_allowed),
  // so a PII Codex job always runs read-only regardless of this branch.
  if (policy.pii_sensitive && writeRequested) {
    return { tier: "claude", reason: "pii_project_write_blocked", risk_flags };
  }

  if (forceTier && VALID_FORCE_TIERS.has(forceTier)) {
    return { tier: forceTier === "gemma" ? "local" : forceTier, reason: "forced_by_caller", risk_flags };
  }

  if (isGemmaTask(lower)) {
    return { tier: "local", reason: "trivial_text_op", risk_flags };
  }

  if (isCodexTask(lower)) {
    // Flag the promotion ONLY when it fires with no forceTier at
    // all (null/undefined/other falsy). An invalid truthy forceTier (e.g. "bogus", not
    // in VALID_FORCE_TIERS) already fell through the check above without being honored,
    // but it is still a caller-supplied tier -- not the keyword branch acting alone --
    // so it must not carry the flag either.
    if (!forceTier) risk_flags.push("auto_codex_promotion");
    return { tier: "codex", reason: "multi_file_or_autonomous_coding", risk_flags };
  }

  return { tier: "claude", reason: "single_file_or_judgment_task", risk_flags };
}

function isGemmaTask(lower) {
  return GEMMA_PATTERNS.some((re) => re.test(lower)) && !isCodexTask(lower);
}

function isCodexTask(lower) {
  return CODEX_PATTERNS.some((re) => re.test(lower));
}

export const CODEX_TIERS = {
  flagship: { model: "gpt-6.1-sol",   effort: "xhigh"  },
  standard: { model: "gpt-6.1-sol",   effort: "medium" },
  fast:     { model: "gpt-6-luna",     effort: "low"    },
  // Second luna level: same cheap model at HIGH effort for simple code review.
  // Measured on 4 planted bugs x 3 files: luna/low found 17%, luna/high 56%, standard
  // (gpt-6.1-sol/medium) 72%, at about the same token count -- so this is a stopgap between fast and
  // standard, not a substitute for standard on reviews that matter.
  fast_review: { model: "gpt-6-luna", effort: "high"   },
  // OpenAI's fable-class flagship. Deliberately expensive in tokens/usage --
  // reserve for massive large-scale projects or reviews/audits, never routine work. Not a
  // replacement for "flagship": both remain available, this is a rare, heavier-still option.
  astra:    { model: "gpt-6-astra",   effort: "xhigh"  },
};

// The ONE max-strength pair. Reviews-only: codex_gate / codex_review_panel accept
// it; delegate / codex_task never do (schema + orchestrator rejection). NOT in CODEX_TIERS so
// the delegate quality surface stays untouched.
export const MAX_STRENGTH = { model: "gpt-6-astra", effort: "max" };

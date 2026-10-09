// admission.mjs -- the SINGLE admission gate for every codex-mcp entrypoint.
// Called by: codex_task, codex_review, codex_adversarial_review (server.mjs) and
// delegate (orchestrator.mjs, which also serves cli.mjs). Nothing may reach the
// companion or Ollama without passing through admit() first.
//
// PII semantics:
//   - task/delegate on a PII cwd: READ-ONLY allowed. Writes fail CLOSED
//     (effective_write=false, write_blocked=true -- surfaced, never silent).
//     Task text AND context_snapshot are redacted before they leave the gate.
//   - review/adversarial_review is gated on `policy.review_allowed`, NOT `pii_sensitive`
//     directly: a project's policy row can allow review even though it is pii_sensitive.
//     Still BLOCKED wherever `review_allowed` is false (a pii row with no review override) or the
//     cwd is non-git. This is a
//     project-scoped policy-table decision, not a blanket PII exemption -- a different
//     consumer of the same table (e.g. a hosted third-party review API, as opposed to a
//     subscription running headless) makes its OWN call.
//   - unknown cwd: resolvePolicy's fail-closed default (pii:true, review_allowed:false,
//     git_allowed:false) applies PII semantics automatically. A relative or drive-relative cwd,
//     a dangling link, or an ambiguous spelling is "unknown" too.
//   - links: resolvePolicy itself resolves the cwd's REAL location (native realpath: junctions,
//     symlinks and 8.3 names followed), so this synchronous gate needs no realpath of its own --
//     a junction under a permissive project gets the policy of the folder it points to.
//   - unknown kind: BLOCKED (fail-closed).

import fs from "node:fs";
import process from "node:process";
import { resolvePolicy } from "./policy.mjs";
import { ensureDirectPreconditions as _ensureDirectPreconditions } from "./direct.mjs";

const SECRET_PATTERNS = [
  // Vendor keys carry hyphenated PREFIX SEGMENTS before the random tail (sk-or-v1-...,
  // sk-ant-api03-...). A bare [A-Za-z0-9] run stops at the first hyphen and matches
  // nothing, so hyphenated keys leaked. Allow any number of alnum-then-hyphen segments,
  // then require a long alnum tail -- prose like "ask-me-about-this" has no such tail.
  [/sk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{16,}/g, "[REDACTED:sk-key]"],
  [/Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, "Bearer [REDACTED]"],
  [/api[_-]?key[=:\s]+["']?[A-Za-z0-9\-._]{16,}["']?/gi, "[REDACTED:api-key]"],
  [/password[=:\s]+["']?[^\s"']{8,}["']?/gi, "[REDACTED:password]"],
  [/token[=:\s]+["']?[A-Za-z0-9\-._]{16,}["']?/gi, "[REDACTED:token]"],
];

export function redactSecrets(text) {
  if (!text) return text;
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function admit({ kind, cwd, write = false, task = "", context_snapshot = null, needs_git = true } = {}) {
  const policy = resolvePolicy(cwd);

  if (kind === "review" || kind === "adversarial_review") {
    // review_allowed checked before git: preserves the error precedence server.mjs always had.
    // `needs_git` (default true, matching codex_review/codex_adversarial_review's own git-diff
    // payload) lets a caller that reviews NAMED FILES rather than a diff -- codex_gate's spec/plan
    // phases, gate.mjs -- opt out of the git requirement explicitly. Mirrors admitDirect's existing
    // `needs_git: phase === "impl"` pattern (line ~225 of gate.mjs) rather than inventing a second one.
    if (!policy.review_allowed) return { allowed: false, reason: "pii_project", project: policy.name };
    if (needs_git && !policy.git_allowed) return { allowed: false, reason: "git_not_allowed", project: policy.name };
    return {
      allowed: true, policy, effective_write: false, write_blocked: false,
      task: redactSecrets(task), context_snapshot: redactSecrets(context_snapshot)
    };
  }

  if (kind === "task" || kind === "delegate") {
    return {
      allowed: true, policy,
      effective_write: Boolean(write && policy.write_allowed),   // writes fail CLOSED
      write_blocked: Boolean(write && !policy.write_allowed),
      task: redactSecrets(task), context_snapshot: redactSecrets(context_snapshot)
    };
  }

  return { allowed: false, reason: "unknown_kind", project: policy.name };  // fail-closed
}

// ---------------- SEPARATE async admission for the direct path ONLY ----------------
// The sync admit() above and every existing caller stay byte-for-byte untouched.

const DIRECT_BRAND = Symbol("codex-mcp.direct-admission");

// Brand check WITHOUT exporting the Symbol (module-private: forgery requires this module's
// cooperation; in-process hostile code is outside the threat model). The Symbol
// property is non-enumerable, so a spread/copy silently loses the brand (stale-handoff defense).
export function isBrandedDirectAdmission(decision) {
  return Boolean(decision && decision[DIRECT_BRAND] === true);
}

// The NAMED pii rows of the policy table
// are not off-limits to the direct READ-ONLY path; unknown cwds are. Fail-closed preconditions:
// write-denial for all runs, network-denial additionally for PII.
export async function admitDirect({ cwd, needs_git = false } = {}, deps = {}) {
  const realpath = deps.realpath ?? fs.realpathSync;
  // The hardened policy checks run FIRST, on the cwd exactly as the caller gave it: resolvePolicy refuses a
  // relative or drive-relative cwd and a network share BEFORE any file-system call. Resolving the cwd here
  // first would turn "." into an absolute project path, and a realpath of a share path contacts its server.
  const policy = resolvePolicy(cwd);
  // Policy checks BEFORE the preconditions await: a refused request must never spawn a probe child.
  if (policy.name === "unknown") return { allowed: false, reason: "unknown_project", project: policy.name };
  // Named PII rows stay open to the direct READ-ONLY path (owner ruling 2026-07-13) whatever their review
  // default. A non-PII row has review_allowed false only when the row sets review:false explicitly, and that
  // refusal holds here exactly as it does at the ordinary review gate.
  if (!policy.review_allowed && !policy.pii_sensitive) {
    return { allowed: false, reason: "review_not_allowed", project: policy.name };
  }
  if (needs_git && !policy.git_allowed) return { allowed: false, reason: "git_not_allowed", project: policy.name };
  let cwd_real;
  try { cwd_real = realpath(cwd ?? process.cwd()); } catch { return { allowed: false, reason: "cwd_unresolvable" }; }
  // The real location must still belong to the same row (otherwise a link changed between the two reads).
  if (resolvePolicy(cwd_real).name !== policy.name) return { allowed: false, reason: "cwd_unresolvable" };
  const pre = await (deps.ensurePreconditions ?? _ensureDirectPreconditions)(
    { pii: Boolean(policy.pii_sensitive) }, deps);
  if (!pre.ok) {
    // detail: the precondition why, so a blocked caller can see
    // WHICH requirement failed (e.g. the connectivity control) without a code dive.
    return { allowed: false, reason: "direct_preconditions_unmet", project: policy.name, detail: pre.why ?? null };
  }
  const decision = {
    allowed: true, kind: "direct_review", needs_git: Boolean(needs_git),
    cwd_real, policy, binaryIdentity: pre.binaryIdentity,
  };
  Object.defineProperty(decision, DIRECT_BRAND, { value: true, enumerable: false });
  return decision;
}

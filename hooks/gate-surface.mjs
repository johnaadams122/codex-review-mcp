// hooks/gate-surface.mjs -- at-least-once, concurrent-safe verdict surfacing.
// MARK AFTER EMIT: surfaceOnce CLAIMS and returns the line; the caller emits; THEN markSurfaced sets
// surfaced=true. A crash between emit and mark re-emits ONCE past the TTL (accepted at-least-once
// residual) -- marking BEFORE emit would be at-most-once with silent loss. ASCII-only: non-ASCII glyph via escape + \xNN escapes.
import { readJournal, upsertRun, RUN_STATE_RANK, journalPath, lockPath } from "./run-journal.mjs";
import { withLock, atomicWriteJSON } from "./atomic-store.mjs";
import { CONFIG } from "./gate-run.config.mjs";

export function sanitizeLine(text, maxLen = 300) {
  let s = String(text ?? "").replace(/[\x00-\x1f\x7f]/g, " "); // strip C0 controls + DEL (ASCII-ESCAPED, never literal bytes)
  s = s.replace(/hookeventname|additionalcontext|hookspecificoutput/gi, "[x]"); // defang hook directives
  if (s.length > maxLen) s = s.slice(0, maxLen - 3) + "...";
  return s;
}

function verdictLine(runId, e) {
  const reviewer = e.reviewer ?? "codex:terra (requested, unattested)";
  const what = e.status === "skipped" ? "skipped (" + (e.failure_reason ?? "skip") + ")" : String(e.status).toUpperCase();
  const extra = e.failure_reason && e.status !== "skipped" ? " -- " + e.failure_reason : "";
  return sanitizeLine("\u26a0 codex impl gate [" + reviewer + "]: " + what + extra + " (" + runId + "; " + String(e.diffId ?? "").slice(0, 8) + ")");
}

// CLAIM a terminal, unsurfaced (or stale-claiming) run and RETURN its line WITHOUT marking surfaced.
export function surfaceOnce(repoRoot, deps = {}) {
  // Module convention (run-journal.mjs): an injected deps.now returns a NUMBER (Date.now-style), which
  // withLock/readJournal also consume. Coerce to a Date here so now.getTime()/now.toISOString() work
  // for a numeric OR a Date injection (matches the readJournal corrupt-guard coercion).
  const nowRaw = (deps.now ?? (() => new Date()))();
  const now = typeof nowRaw === "number" ? new Date(nowRaw) : nowRaw;
  return withLock(lockPath(repoRoot), () => {
    const journal = readJournal(repoRoot, deps);
    for (const [runId, e] of Object.entries(journal)) {
      if (!e || (RUN_STATE_RANK[e.status] ?? 0) < 3) continue; // terminal only
      const claimable = e.surfaced === false
        || (e.surfaced === "claiming" && e.claimedAt && (now.getTime() - new Date(e.claimedAt).getTime()) > CONFIG.ttl.claimStaleMs);
      if (!claimable) continue;
      journal[runId] = { ...e, surfaced: "claiming", claimedAt: now.toISOString(), seq: (e.seq ?? 0) + 1 };
      atomicWriteJSON(journalPath(repoRoot), journal, deps);
      return { runId, line: verdictLine(runId, e) }; // NOT marked surfaced yet -- caller emits then markSurfaced
    }
    return { runId: null, line: null };
  }, deps);
}

// Set surfaced=true AFTER the caller emitted the line (mark-after-emit -> at-least-once; a non-status
// field, so upsertRun's first-terminal-wins does not interfere).
export function markSurfaced(repoRoot, runId, deps = {}) {
  return upsertRun(repoRoot, runId, { surfaced: true }, deps);
}

// -- runSurfaceHook: the I/O shell for the PostToolUse/Stop hook. -------
// Claims via surfaceOnce, then EMITS the line FIRST and marks surfaced SECOND (mark-after-emit
// ordering lives here so it is directly testable). The emitted `out` JSON-ENCODES the sanitized
// line as a string VALUE inside the hookSpecificOutput object -- JSON.stringify escapes any
// residual hook-directive-looking substring (quotes/braces/newlines), so the substring defang in
// sanitizeLine is defense-in-depth, not the only barrier against the surfaced text being
// interpreted as hook-control JSON.
import { pathToFileURL } from "node:url";

export function runSurfaceHook({ repoRoot, hookEventName = "PostToolUse", emit, deps = {} } = {}) {
  try {
    const root = repoRoot ?? process.cwd();
    const { runId, line } = (deps.surfaceOnce ?? surfaceOnce)(root, deps);
    if (!line) return { out: null };
    const out = JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: line } });
    // EMIT then mark, and ONLY when there is an emit sink. Marking without emitting would set
    // surfaced=true on a verdict that was never delivered -> a permanent silent drop (the exact
    // at-most-once loss this module exists to prevent). No sink -> leave it "claiming" so a later
    // surfaceOnce re-claims past the TTL and re-emits (at-least-once).
    if (emit) {
      emit(out);
      (deps.markSurfaced ?? markSurfaced)(root, runId, deps);
    }
    return { out };
  } catch (e) { process.stderr.write(`gate-surface: ${e && e.message}\n`); return { out: null }; }
}
async function main() {
  const hookEventName = process.env.CODEX_SURFACE_EVENT === "Stop" ? "Stop" : "PostToolUse";
  // The launcher keys the journal off resolveAutogateRoot(cwd). The surfacer MUST resolve
  // the SAME root -- read the hook payload's cwd and WALK UP -- or a session running from a repo
  // SUBDIR would read <subdir>/.superpowers and silently miss the terminal verdict .
  const { resolveAutogateRoot } = await import("./marker.mjs");
  let cwd = process.cwd();
  try { let t = ""; for await (const chunk of process.stdin) t += chunk; const p = JSON.parse(t); if (p && typeof p.cwd === "string" && p.cwd) cwd = p.cwd; } catch { /* no/invalid stdin -> process.cwd() */ }
  const repoRoot = resolveAutogateRoot(cwd) ?? cwd;
  runSurfaceHook({ repoRoot, hookEventName, emit: (out) => process.stdout.write(out + "\n") });
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => process.exit(0));

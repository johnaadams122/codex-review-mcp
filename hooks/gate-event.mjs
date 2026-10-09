// hooks/gate-event.mjs -- canonical event contract + trigger adapters.
// The contract is the boundary: two triggers differ in session identity, PII inputs, and diff
// locator; the ADAPTER (not the core) reconciles them into this one shape.
import fs from "node:fs";

// Interface contract: cwd_real = realpathSync(cwd) BEFORE any policy lookup, fail-closed to
// null on throw. No path.resolve() pre-step here: realpathSync already resolves relative
// paths against process.cwd() itself, and adding a path.resolve() wrapper is platform-lossy
// (on Windows it rewrites a rootless absolute path like "/repo" against the current drive,
// e.g. "C:\repo", instead of leaving it as the literal path the caller/deps.realpath expects).
function canonicalCwd(cwd, deps) {
  const realpath = deps.realpath ?? fs.realpathSync;
  try { return String(realpath(String(cwd ?? ""))); } catch { return null; }
}

export function buildCommitEvent({ sessionId, cwd, sha, triggeredAt }, deps = {}) {
  return { sessionId, cwd_real: canonicalCwd(cwd, deps), target: { kind: "commit", sha }, triggeredAt };
}

export function buildWorktreeEvent({ sessionId, cwd, patchRef, triggeredAt }, deps = {}) {
  return { sessionId, cwd_real: canonicalCwd(cwd, deps), target: { kind: "worktree", patchRef }, triggeredAt };
}

const KNOWN_KINDS = new Set(["commit", "worktree"]);
export function validateEvent(ev) {
  return Boolean(ev && typeof ev.sessionId === "string" && ev.sessionId
    && typeof ev.cwd_real === "string" && ev.cwd_real
    && ev.target && KNOWN_KINDS.has(ev.target.kind));
}

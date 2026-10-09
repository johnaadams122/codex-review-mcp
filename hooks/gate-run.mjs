// hooks/gate-run.mjs -- Phase-2 launcher. ASCII-only, exits 0 always.
// This module MUST NOT import the panel/jobs chain at TOP LEVEL. `computeTreeEntry`/
// `computePayloadFiles`/`IMPL_LENS_KEYS` are DYNAMICALLY imported inside classify AFTER
// the cheap opt-out/allowlist gates, and passed down via deps -- so an opted-out/non-allowlisted
// repo never loads the heavy chain, and a load-time error there is caught by classify's try/catch.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process"; // top-level ESM import (require() is not defined in .mjs)
import { resolvePolicy as _resolvePolicy } from "../policy.mjs";
import { validateEvent } from "./gate-event.mjs";      // light (fs/path) -- 5c-safe top-level
import { resolveAutogateRoot } from "./marker.mjs";    // light (fs/path) -- the WALK-UP to the repo root
import { readJournal, reserveOK, dayKey, effectiveDayKey, RUN_STATE_RANK } from "./run-journal.mjs"; // light (no panel chain)
import { CONFIG, isAllowlisted } from "./gate-run.config.mjs"; // CONFIG is needed by launchDetached; add it ONCE on this existing line, do not re-import
// panel.mjs and gate.mjs are the ONLY heavy modules -> DYNAMICALLY imported inside classify.

export function defaultRunGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// Read an untracked file's bytes via its REALPATH under a containment recheck -- never re-open the
// raw joined path (the symlink-swap window: computeTreeEntry validated, then the raw path was
// reopened). Fail-closed on escape/unreadable -> the file is dropped from the payload.
function readContainedText(cwd_real, rel, deps = {}) {
  const realpath = deps.realpath ?? fs.realpathSync;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const real = realpath(path.resolve(cwd_real, rel));
  const back = path.relative(realpath(cwd_real), real);
  if (back.startsWith("..") || path.isAbsolute(back)) throw new Error("path escapes cwd_real: " + rel);
  return readFile(real);
}

const KEEP = /^SHA256:|^LINK:/; // contained regular file / contained symlink content
export function scanUntrackedContained(cwd_real, deps = {}) {
  // -z: git never C-quotes names in this mode (plain output quotes a non-ASCII name, which then matches no
  // file and was dropped from the scan). Same listing as panel.mjs listUntrackedFiles, kept inline because
  // this module must not import the panel chain at top level.
  const listUntracked = deps.listUntracked ?? ((cwd) => String((deps.runGit ?? defaultRunGit)(["ls-files", "-z", "--others", "--exclude-standard"], cwd)).split("\0").filter((s) => s !== ""));
  const rels = listUntracked(cwd_real);
  const out = [];
  if (rels.length === 0) return out; // nothing to scan -- computeTreeEntry dep not needed on this path
  const computeTreeEntry = deps.computeTreeEntry; // REQUIRED via deps (classify injects it from the dynamic panel import; no top-level import -- 5c)
  if (typeof computeTreeEntry !== "function") throw new Error("scanUntrackedContained: computeTreeEntry dep is required");
  for (const rel of rels) {
    const entry = computeTreeEntry(cwd_real, rel, deps);
    if (KEEP.test(String(entry))) out.push({ rel, entry }); // ESCAPE/LINK_ESCAPE/ABSENT/UNREADABLE dropped
  }
  return out;
}

function runDir(cwd_real, runId) { return path.join(cwd_real, ".superpowers", "gate-runs", runId); }

export function capturePayload(event, runId, deps = {}) {
  const runGit = deps.runGit ?? defaultRunGit;
  const sha256 = (s) => createHash("sha256").update(Buffer.from(String(s), "utf8")).digest("hex");
  if (event.target.kind === "commit") {
    const sha = event.target.sha;
    const bytes = runGit(["diff", `${sha}~1..${sha}`], event.cwd_real);
    return { payloadRef: { kind: "commit", sha }, diffId: sha256(bytes), bytes: bytes.length };
  }
  // worktree: capture NOW into an immutable patch file
  const diff = runGit(["diff", "HEAD"], event.cwd_real);
  let untracked = "";
  for (const { rel } of scanUntrackedContained(event.cwd_real, deps)) {
    let content;
    try { content = readContainedText(event.cwd_real, rel, deps); } catch { continue; } // escape/unreadable -> drop
    untracked += `\n--- NEW UNTRACKED FILE: ${rel} ---\n${content}\n`;
  }
  const payload = diff + untracked;
  const dir = runDir(event.cwd_real, runId);
  (deps.mkdir ?? fs.mkdirSync)(dir, { recursive: true });
  const patchPath = path.join(dir, "payload.patch");
  (deps.writeFile ?? fs.writeFileSync)(patchPath, payload, "utf8");
  return { payloadRef: { kind: "patch", path: patchPath }, diffId: sha256(payload), bytes: payload.length };
}

export function piiScanPayload(cwd_real, payload_files, deps = {}) {
  const realpath = deps.realpath ?? fs.realpathSync;
  const resolvePolicy = deps.resolvePolicy ?? _resolvePolicy;
  // Resolve the repo ROOT exactly ONCE and fail CLOSED if unresolvable. Doing this
  // inside the per-file try would let a root that ENOENTs (TOCTOU delete/rename, broken symlink component) make
  // EVERY file `continue` -> the loop returned {ok:true} with the PII gate silently disabled (fail-OPEN).
  // ENOENT-can't-leak applies to per-FILE paths, never the root.
  let cwdReal;
  try { cwdReal = realpath(cwd_real); }
  catch { return { ok: false, reason: "pii_root_unresolvable" }; }
  for (const rel of payload_files) {
    let real;
    try { real = realpath(path.resolve(cwd_real, rel)); }
    catch (e) {
      // A DELETED/renamed-away path is RETAINED by computePayloadFiles (panel.mjs:675) but does not
      // exist on disk at the reviewed SHA -> realpath ENOENT. An absent file cannot leak PII, so SKIP
      // it (mirrors computeTreeEntry's ABSENT, panel.mjs:718) -- otherwise EVERY commit that deletes or
      // renames a file would silently skip the whole gate. Any OTHER error is fail-closed.
      if (e && e.code === "ENOENT") continue;
      return { ok: false, reason: "pii_unresolvable", file: rel };
    }
    // Containment: the realpath must stay under cwd_real. A payload file whose realpath ESCAPES the
    // repo is blocked (path_not_contained) -- without this check a symlinked payload path could
    // resolve outside the reviewed repo and be waved through.
    const back = path.relative(cwdReal, real);
    if (back.startsWith("..") || path.isAbsolute(back)) return { ok: false, reason: "path_not_contained", file: rel };
    const pol = resolvePolicy(real);
    // Block ANY pii_sensitive resolution -- including the "unknown" default (policy.mjs DEFAULT_POLICY
    // has pii:true), which an earlier revision explicitly PERMITTED (`name !== "unknown"`). Given the non-PII allowlist,
    // a PII-tree or unknown-destination hit is anomalous -> fail-closed BLOCK.
    if (!pol) return { ok: false, reason: "pii_unresolvable", file: rel };
    if (pol.pii_sensitive) return { ok: false, reason: "pii_" + (pol.name || "unknown"), file: rel };
  }
  return { ok: true };
}

// classify: the pure launcher decision. ASYNC precisely so the panel/gate chain
// loads LATE -- only an opted-in, allowlisted repo pays for the dynamic import below. NEVER throws
// (any internal error collapses to a skip -- fail-safe). classify does NOT write the `running`
// journal entry -- that is the atomic claim in launchDetached; this function only decides.
const skip = (reason) => ({ action: "skip", reason });

export async function classify(event, deps = {}) {
  try {
    const env = deps.env ?? process.env;
    if (!validateEvent(event)) return skip("malformed_event");

    // (1) CHEAP opt-out + allowlist -- NO panel import yet (5c). Walk UP to the .codex-autogate root
    // and key EVERYTHING off that repoRoot (a commit from a subdir must not mis-key the journal).
    if ((env.CODEX_AUTOGATE ?? "") === "off") return skip("opt_out");
    const repoRoot = (deps.resolveAutogateRoot ?? resolveAutogateRoot)(event.cwd_real, deps.fsView ?? fs);
    if (!repoRoot) return skip("opt_out");
    const resolvePolicy = deps.resolvePolicy ?? _resolvePolicy;
    const projectName = (deps.projectNameOf ?? ((p) => resolvePolicy(p).name))(repoRoot);
    if (!isAllowlisted(projectName)) return skip("not_allowlisted");

    // (2) NOW load the heavy chain (dynamic; only an allowlisted, opted-in repo reaches here -- 5c).
    const panel = deps.panel ?? await import("../panel.mjs");
    const gate = deps.gate ?? await import("../gate.mjs");
    const computePayloadFiles = deps.computePayloadFiles ?? panel.computePayloadFiles;
    const computeTreeEntry = deps.computeTreeEntry ?? panel.computeTreeEntry;
    const IMPL_LENS_KEYS = deps.IMPL_LENS_KEYS ?? gate.IMPL_LENS_KEYS; // ["correctness","security-pii"] -> N=2

    // (3) capture immutable payload; key off the reviewed bytes.
    const runId = deps.runId ?? randomUUID();
    const cap = capturePayload(event, runId, { ...deps, computeTreeEntry });
    const targetKey = cap.diffId;

    // (4) diff-wide PII over every payload file, keyed off repoRoot.
    const runGit = deps.runGit ?? defaultRunGit;
    const payloadBytes = cap.payloadRef.kind === "commit"
      ? runGit(["diff", `${cap.payloadRef.sha}~1..${cap.payloadRef.sha}`], event.cwd_real)
      : (deps.readFile ?? ((p) => fs.readFileSync(p, "utf8")))(cap.payloadRef.path);
    const pf = computePayloadFiles({ payload: payloadBytes });
    if (pf.error) return skip("payload_parse_error");
    // Structural guard: piiScanPayload's `for..of payload_files` throws for a
    // non-iterable non-array (object/number/undefined) -- caught by classify's own try/catch below,
    // fail-closed. But a STRING is iterable char-by-char and would NOT throw: it would silently pass
    // every character through pii scanning as a "file" and vacuously return {ok:true}, a fail-OPEN
    // hole the throw-based reasoning misses. Enforce array-ness explicitly here so classify's promise
    // ("always pass a real ARRAY") holds structurally, not just by accident of what panel.mjs returns.
    if (!Array.isArray(pf.payload_files)) return skip("payload_parse_error");
    const pii = piiScanPayload(repoRoot, pf.payload_files, deps);
    if (!pii.ok) return skip(pii.reason);

    // (5) debounce PRE-check (advisory; the authoritative debounce is claimAttempt under the lock).
    const now = (deps.now ?? (() => new Date()))();
    const journal = readJournal(repoRoot, deps);
    const dk = effectiveDayKey(journal, now); // clock-rollback-guarded day-key
    if (Object.values(journal).some((e) => e && e.targetKey === targetKey && e.dayKey === dk && (RUN_STATE_RANK[e.status] ?? 0) < 3)) {
      return skip("debounced");
    }

    // (6) budget SOFT pre-check; the HARD gate is recordSubmission's veto. A budget skip is
    // SURFACEABLE (the launcher writes a terminal `skipped` entry -- never a silent absence).
    const N = IMPL_LENS_KEYS.length;
    if (!reserveOK(repoRoot, N, now, deps)) {
      return { action: "skip", reason: "budget", surfaceable: true, repoRoot, targetKey, diffId: cap.diffId, dayKey: dk };
    }

    return { action: "launch", runId, repoRoot, targetKey, diffId: cap.diffId, payloadRef: cap.payloadRef, dayKey: dk, jobs: N };
  } catch (e) {
    return skip("internal_error: " + (e && e.message)); // never throw
  }
}

// -- launchDetached --
import { spawn as _spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { upsertRun as _upsertRun, claimAttempt as _claimAttempt } from "./run-journal.mjs";
// NOTE: `CONFIG` is imported above alongside `isAllowlisted`; do NOT add a second `import { CONFIG }`
// here (SyntaxError: Identifier 'CONFIG' has already been declared). This module's single import
// ledger (dedupe across all appended slices): fs/path/crypto/child_process(execFileSync,spawn) +
// url(fileURLToPath) builtins; from local: CONFIG+isAllowlisted (config), validateEvent (gate-event),
// resolveAutogateRoot (marker), readJournal/reserveOK/dayKey/effectiveDayKey/RUN_STATE_RANK/upsertRun/
// claimAttempt (run-journal), _resolvePolicy (policy). panel.mjs/gate.mjs are DYNAMIC only (5c).

const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function refArg(ref) { return ref.kind === "commit" ? "commit:" + ref.sha : "patch:" + ref.path; }

export function launchDetached(decision, event, deps = {}) {
  const claimAttempt = deps.claimAttempt ?? _claimAttempt;
  const upsertRun = deps.upsertRun ?? _upsertRun;
  const spawn = deps.spawn ?? _spawn;
  const now = (deps.now ?? (() => new Date()))();
  // TOTAL-LADDER deadline: the journal deadlineAt must cover BOTH attempts at their
  // REAL wall time, not perAttemptMs alone -- one rung can take submission (~companion 300s) + poll
  // (~480s) + review, so ~13min, not 8min. Using perAttemptMs*maxCodex would expire the legit 2nd rung.
  // This is a GENEROUS outer reaper backstop; the real per-rung bound is the companion/poll timeouts
  // (accepted residual iii -- no terra in-process job.timer). `rungWallMs` is a config-of-record value.
  const rungWallMs = CONFIG.deadlines.rungWallMs ?? (CONFIG.deadlines.perAttemptMs + 6 * 60 * 1000); // ~14min per rung
  const deadlineAt = new Date(now.getTime() + (CONFIG.attempts.maxCodex * rungWallMs + CONFIG.deadlines.ladderMarginMs)).toISOString();

  // ATOMIC CLAIM: debounce + epoch mint + running write in ONE lock. A concurrent
  // launcher that already claimed this targetKey today makes this return debounced -> no spawn.
  const claim = claimAttempt(decision.repoRoot, {
    runId: decision.runId, targetKey: decision.targetKey, dayKey: decision.dayKey,
    entry: {
      diffId: decision.diffId, payloadRef: decision.payloadRef, sessionId: event.sessionId,
      attempt: 1, launcherPid: process.pid, deadlineAt,
      jobs_reserved: decision.jobs, jobs_submitted: 0, phase: "impl", tier: "standard",
    },
  }, deps);
  if (!claim.claimed) return { runId: decision.runId, claimed: false, reason: claim.reason };

  const child = spawn(process.execPath,
    [CLI_PATH, "gate", "--phase=impl", "--run-id", decision.runId, "--payload-ref", refArg(decision.payloadRef),
     "--target-key", decision.targetKey, "--attempt-epoch", String(claim.attemptEpoch),
     "--diff-id", decision.diffId, "--cwd", decision.repoRoot],
    { detached: true, stdio: "ignore", windowsHide: true });
  try { upsertRun(decision.repoRoot, decision.runId, { pid: child.pid }, deps); } catch { /* best-effort */ }
  child.unref();
  return { runId: decision.runId, pid: child.pid, claimed: true, attemptEpoch: claim.attemptEpoch };
}

// -- runLauncherHook: the post-commit shim's I/O shell. ----------------
// Parses the trigger payload, builds the canonical event, classifies, and on `launch` fires
// launchDetached. FAIL-SAFE BY CONTRACT: this must never throw and never block the git commit
// that invoked it -- every path (malformed JSON, classify's own internal errors, an unexpected
// throw from any dep) collapses to `{ out: null }`. classify() already never throws on its own,
// but this wraps the WHOLE body anyway so a future dep swap can't reopen that guarantee.
import { pathToFileURL } from "node:url";
import { buildCommitEvent, buildWorktreeEvent } from "./gate-event.mjs";
import { upsertRun as _upsertRunLH, readJournal as _readJournalLH } from "./run-journal.mjs";

export async function runLauncherHook({ stdinText, deps = {} } = {}) {
  try {
    let payload;
    try { payload = JSON.parse(String(stdinText ?? "")); } catch { return { out: null }; }
    const buildEvent = deps.buildEvent ?? ((p) =>
      CONFIG.trigger === "commit"
        ? buildCommitEvent({ sessionId: p.sessionId, cwd: p.cwd, sha: p.sha, triggeredAt: p.triggeredAt }, deps)
        : buildWorktreeEvent({ sessionId: p.sessionId, cwd: p.cwd, patchRef: p.patchRef, triggeredAt: p.triggeredAt }, deps));
    const event = buildEvent(payload);
    const decision = await (deps.classify ?? classify)(event, deps);
    if (decision.action === "launch") { (deps.launchDetached ?? launchDetached)(decision, event, deps); return { out: null }; }
    // A SURFACEABLE skip (budget) must leave a terminal `skipped` entry so the surface hook emits it
    // -- a dropped skip is a forbidden silent absence. Deterministic id dedupes per targetKey/day; and
    // we only WRITE it if it does not already exist, so re-triggering the same over-budget change does
    // NOT reset surfaced:false and re-emit the advisory every turn (Claude-m2).
    if (decision.action === "skip" && decision.surfaceable && decision.repoRoot) {
      const skipId = "skip:" + decision.targetKey + ":" + decision.dayKey;
      try {
        const upsertRun = deps.upsertRun ?? _upsertRunLH;
        const readJournal = deps.readJournal ?? _readJournalLH;
        if (!readJournal(decision.repoRoot, deps)[skipId]) {
          upsertRun(decision.repoRoot, skipId, {
            status: "skipped", failure_reason: decision.reason, surfaced: false,
            targetKey: decision.targetKey, diffId: decision.diffId, dayKey: decision.dayKey,
          }, deps);
        }
      } catch { /* best-effort; never break the hook */ }
    }
    return { out: null };
  } catch (e) { process.stderr.write(`gate-run: ${e && e.message}\n`); return { out: null }; }
}

async function main() {
  let text = ""; for await (const chunk of process.stdin) text += chunk;
  await runLauncherHook({ stdinText: text });
  process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => process.exit(0));

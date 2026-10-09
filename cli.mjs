#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { delegate, NORMALIZATION_ERRORS } from "./orchestrator.mjs";
import { projectResult } from "./project.mjs";

// These three flags are standalone booleans on
// every command -- a bare --write/--wait/--verbose must never consume the following
// token, even when it appears BEFORE the task string (e.g. `delegate --verbose "task" --wait`
// used to swallow "task" as --verbose's value, leaving no task at all). Explicit
// --verbose=true style still works via the eqIdx branch below, unaffected by this set.
const BOOLEAN_FLAGS = new Set(["write", "wait", "verbose"]);

export function parseArgv(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const positionals = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        // Check if next arg exists, is not a flag, and this key isn't a standalone boolean
        if (!BOOLEAN_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith("--")) {
          flags[key] = args[i + 1];
          i++; // Skip next arg since we consumed it
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

function parseRef(v) {
  if (!v) return undefined;
  if (v.startsWith("commit:")) return { kind: "commit", sha: v.slice("commit:".length) };
  if (v.startsWith("patch:")) return { kind: "patch", path: v.slice("patch:".length) };
  try { return JSON.parse(v); } catch { return undefined; }
}

// C2 gate command, exported so the clear wiring is unit-testable (cli.mjs is one of
// the two REQUIRED clear entry points). deps are injectable for tests; defaults lazy-import.
// With --run-id this is the DETACHED CHILD -- verify diffId, run the
// recovery ladder over the PINNED bytes, reconcile the terminal verdict into the run journal.
export async function runGateCommand(flags, deps = {}) {
  const cwd = flags.cwd ?? process.cwd();
  const payloadRef = parseRef(flags["payload-ref"]);
  const runGate = deps.runGate ?? (await import("./gate.mjs")).runGate;
  const splitList = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

  // ---- Phase-1 path (no --run-id): one gate, clear markers, no artifact ----
  if (!flags["run-id"]) {
    const clearGateDueForGate = deps.clearGateDueForGate ?? (await import("./hooks/marker.mjs")).clearGateDueForGate;
    const res = await runGate({
      phase: flags.phase, cwd, base: flags.base, scope: flags.scope,
      target_files: splitList(flags.target), context_files: splitList(flags["context-files"]), payloadRef,
    });
    if (res.consensus_verdict !== "error") clearGateDueForGate({ cwd, phase: flags.phase, target_files: splitList(flags.target) });
    return res;
  }

  // ---- DETACHED CHILD path (--run-id): verify diffId -> run the ladder -> reconcile ----
  const repoRoot = cwd;
  const runId = flags["run-id"];
  const targetKey = flags["target-key"];
  const attemptEpoch = Number(flags["attempt-epoch"]);
  const expectedDiffId = flags["diff-id"];
  const verdictPath = path.join(repoRoot, ".superpowers", "gate-runs", runId, "verdict.json");
  const atomicWriteJSON = deps.atomicWriteJSON ?? (await import("./hooks/atomic-store.mjs")).atomicWriteJSON;
  const rj = await import("./hooks/run-journal.mjs");
  const upsertRun = deps.upsertRun ?? rj.upsertRun;
  const recordSubmission = deps.recordSubmission ?? rj.recordSubmission;
  const recordJobId = deps.recordJobId ?? rj.recordJobId;   // persist reviewer jobIds for reaper OBSERVE-not-kill
  const isLiveEpoch = deps.isLiveEpoch ?? rj.isLiveEpoch;
  // Resolve EACH dep independently -- a whole-module fallback gated on `runLadder||makeRecheck` would
  // leave the OTHER undefined when a test injects exactly one. node caches the import.
  const runLadder = deps.runLadder ?? (await import("./hooks/gate-recovery.mjs")).runLadder;
  const makeRecheck = deps.makeRecheck ?? (await import("./hooks/gate-recovery.mjs")).makeRecheck;
  const runGit = deps.runGit ?? ((await import("./hooks/gate-run.mjs")).defaultRunGit);
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const diffIdOf = deps.diffIdOf ?? ((b) => createHash("sha256").update(Buffer.from(String(b), "utf8")).digest("hex"));

  const reconcile = (verdict) => {
    const strength_attested = Boolean(verdict.res && verdict.res.strength && verdict.res.strength.backbone_attested === true);
    atomicWriteJSON(verdictPath, { ...verdict, diffId: expectedDiffId, runId, strength_attested });
    if (verdict.status !== "superseded") {
      upsertRun(repoRoot, runId,
        { status: verdict.status, reviewer: verdict.reviewer, failure_reason: verdict.failure_reason,
          diffId: expectedDiffId, verdictPath, attempts: verdict.attempts, strength_attested },   // persist the audit trail
        { expectEpoch: attemptEpoch });   // commit-gate CAS: a superseded/reaper-bumped epoch drops the write
    }
    return verdict;
  };

  // (1) read the pinned bytes ONCE and verify diffId; then PIN a reader that returns those exact bytes
  // to makeRecheck AND runGate, so a mutation of payload.patch between reads cannot make them review
  // different-or-newly-PII bytes while recording the original diffId (a hash/use TOCTOU).
  let bytes;
  try {
    bytes = payloadRef.kind === "commit" ? runGit(["diff", `${payloadRef.sha}~1..${payloadRef.sha}`], repoRoot) : readFile(payloadRef.path);
  } catch (e) {
    return reconcile({ status: "failed", failure_reason: "payload_unreadable", reviewer: "codex:terra (requested, unattested)" });
  }
  if (diffIdOf(bytes) !== expectedDiffId) {
    return reconcile({ status: "failed", failure_reason: "diffid_mismatch", reviewer: "codex:terra (requested, unattested)" });
  }
  // Pin the reader for the mutable PATCH case (commit bytes are immutable by SHA -> re-read is safe).
  const pinned = payloadRef.kind === "patch" ? { readFile: () => bytes } : {};

  // (2) run the ladder over the PINNED bytes; each rung debits the budget write-ahead (vetoable)
  const runGateOnce = async () => runGate({ phase: "impl", cwd: repoRoot, payloadRef },
    { beforeSubmit: () => recordSubmission(repoRoot, runId, new Date()),
      afterSubmit: ({ jobId }) => recordJobId(repoRoot, runId, jobId),   // persist the jobId AFTER submit (now populatable)
      ...pinned });
  const recheck = makeRecheck(repoRoot, { payloadRef, expectedDiffId, ...deps, ...pinned });
  const verdict = await runLadder(
    { event: { cwd_real: repoRoot }, runId, targetKey, payloadRef },
    { runGateOnce, recheck, isLiveEpoch: (_tk, ep) => isLiveEpoch(repoRoot, runId, ep), epoch: attemptEpoch });

  // (3) reconcile the terminal verdict
  return reconcile(verdict);
}

async function main() {
  const { command, positionals, flags } = parseArgv(process.argv);

  // C2 -- `node cli.mjs gate --phase=spec --target=spec.md [--cwd] [--base] [--scope]`.
  // Prints the fail-closed gate verdict as JSON; exit 0 on pass, 1 otherwise.
  if (command === "gate") {
    const res = await runGateCommand(flags);
    if (flags["run-id"]) process.exit(0);                       // detached child: verdict is durable, exit clean
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.consensus_verdict === "pass" ? 0 : 1);
  }

  if (command !== "delegate") {
    console.error(`Unknown command: ${command}. Available: delegate, gate`);
    process.exit(1);
  }

  const task = positionals.join(" ");
  if (!task) {
    console.error("Missing task description. Usage: node cli.mjs delegate <task> [--tier=auto] [--quality=flagship|standard|fast|fast_review|local|astra] [--effort=low|medium|high|xhigh] [--model=gpt-6.1-sol]");
    process.exit(1);
  }

  const tier = flags.tier === "auto" ? null : (flags.tier ?? null);
  const write = Boolean(flags.write);
  const cwd = flags.cwd ?? process.cwd();
  const context_snapshot = flags.context ?? null;
  const quality = flags.quality ?? null;
  const effort = flags.effort ?? null;
  const model = flags.model ?? null;
  // --verbose restores the raw --wait fold (the default output is projected).
  const verbose = Boolean(flags.verbose);

  let result;
  try {
    result = await delegate(task, { tier, quality, effort, model, write, cwd, context_snapshot });
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }

  // C1 -- `--wait` blocks a codex job to completion and folds the result into the output, instead
  // of returning a bare job_id the caller has to poll. The fold is
  // PROJECTED to the minimal shape by default; --verbose restores the raw producer payload.
  if (flags.wait && result && result.result && result.result.job_id) {
    const { waitForResult } = await import("./jobs.mjs");
    const w = await waitForResult(result.result.job_id, { cwd });
    result = {
      ...result,
      waited: true,
      wait_status: w.status,
      ...(w.result ? { wait_result: verbose ? w.result : projectResult(result.result.job_id, w.result, w.status) } : {}),
      ...(w.error ? { wait_error: w.error } : {})
    };
  }

  console.log(JSON.stringify(result, null, 2));

  // Exit codes based on result
  if (result.write_blocked) {
    process.exit(3);
  } else if (result.result?.error && NORMALIZATION_ERRORS.has(result.reason)) {
    // A normalization rejection (conflicting/partial override, local+codex conflict,
    // invalid effort) never submitted a job. Exit 4 is distinct from all three existing
    // paths: write_blocked (3), a submitted codex job (2), and a thrown error (1).
    process.exit(4);
  } else if (result.selected_tier === "codex" && result.result?.job_id) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

// Only run the CLI when invoked directly (so tests can import parseArgv without executing main).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
}

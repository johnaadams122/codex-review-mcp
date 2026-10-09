// hooks/gate-due.mjs -- Phase-1 PostToolUse hook.
//
// classify() is a PURE decision function; the stdin entry (main) is the only I/O shell.
// The hook is advisory and fail-safe: every path exits 0, and no path may fabricate a reminder.
//
// TEST-ONLY env var: CODEX_AUTOGATE_POLICY_BYPASS bypasses PII checks for temp-directory roots
// that are outside the policy table. It is honored ONLY when the bypass path, CANONICALIZED via
// realpath (following any junction/symlink), (a) resolves under the realpath of os.tmpdir() AND
// (b) is outside the policy table (resolvePolicy().name === "unknown"). realpath is what makes a
// junction that points at a real (PII) repo resolve to its true, policy-known path so the bypass
// refuses it -- lexical path.resolve() would follow the junction blindly. Nothing in production
// sets this variable, and the load-bearing PII guard below (pii_root) does not depend on it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveAutogateRoot, normalizeRel, markGateDue, takeReminder, buildReminderLine } from "./marker.mjs";
import { resolvePolicy } from "../policy.mjs";

const ARTIFACT_RE = /^docs\/superpowers\/(specs|plans)\/[^/]+\.md$/;
const PHASE_BY_DIR = { specs: "spec", plans: "plan" };

const skip = (reason) => ({ action: "skip", reason });

export function classify(payload, env = process.env, fsView = fs, policyView = resolvePolicy) {
  try {
    if (!payload || typeof payload !== "object") return skip("malformed_payload");
    if (payload.tool_name !== "Write" && payload.tool_name !== "Edit") return skip("tool");
    const file = payload.tool_input && payload.tool_input.file_path;
    if (typeof file !== "string" || !file.trim()) return skip("no_file_path");
    if ((env.CODEX_AUTOGATE ?? "") === "off") return skip("env_off");

    // PII belt-and-suspenders: the FILE check fails closed (unknown -> pii:true),
    // the CWD check fires only on an affirmative PII project match.
    // TEST-ONLY bypass, structurally production-inert. Canonicalize BOTH the bypass path and
    // os.tmpdir() via realpath so a junction/symlink under %TEMP% that points at a real (PII)
    // repo resolves to its TRUE path -- resolvePolicy then sees the real project and the
    // "unknown" gate below refuses it. Lexical path.resolve() would follow the junction blindly
    // and leave a PII repo "unknown". realpath failure -> bypassRoot stays null (fail closed).
    const bypass = env.CODEX_AUTOGATE_POLICY_BYPASS;
    let bypassRoot = null;
    if (typeof bypass === "string" && bypass.trim() !== "") {
      try {
        const bReal = normalizeRel(fsView.realpathSync(path.resolve(bypass)));
        const tmpReal = normalizeRel(fsView.realpathSync(os.tmpdir()));
        if ((bReal === tmpReal || bReal.startsWith(tmpReal + "/")) &&
            policyView(fsView.realpathSync(path.resolve(bypass))).name === "unknown") {
          bypassRoot = bReal;
        }
      } catch { bypassRoot = null; }
    }
    const underBypass = (p) => {
      if (bypassRoot === null) return false;
      const n = normalizeRel(path.resolve(p));
      return n === bypassRoot || n.startsWith(bypassRoot + "/");
    };
    if (!underBypass(file) && policyView(file).pii_sensitive) return skip("pii_file");
    const cwdPolicy = policyView(payload.cwd ?? file);
    if (!underBypass(payload.cwd ?? file) && cwdPolicy.pii_sensitive && cwdPolicy.name !== "unknown") return skip("pii_cwd");

    const root = resolveAutogateRoot(file, fsView);
    if (!root) return skip("no_autogate_root");

    // Defense in depth (the load-bearing PII guard): the marker is written into `root`, so its
    // CANONICAL path (realpath, following any junction/symlink) must not be an affirmative PII
    // project. Affirmative-only (name !== "unknown") mirrors the cwd check, so a policy-unknown
    // temp/test root still marks, but a junction resolving to a pii project is
    // refused. realpath failure -> fail closed.
    // Accepted residual (documented, not a shipped-path risk): a TOCTOU window exists between this
    // realpath check and the later markGateDue write -- an attacker who swaps `root` for a junction
    // in that window could redirect the marker. It is not reachable in production (no bypass is set,
    // and the fail-closed file check above blocks anything outside a known non-PII project), and it
    // is the standard realpath-check limitation shared by gate.mjs readContained; closing it needs
    // open-handle APIs Node does not expose on Windows. Out of scope for a single-user advisory hook.
    let rootReal;
    try { rootReal = fsView.realpathSync(root); } catch { return skip("root_unresolvable"); }
    const rootPolicy = policyView(rootReal);
    if (rootPolicy.pii_sensitive && rootPolicy.name !== "unknown") return skip("pii_root");

    const rel = normalizeRel(path.relative(root, path.resolve(file)));
    const m = ARTIFACT_RE.exec(rel);
    if (!m) return skip("not_artifact");
    return { action: "mark", root, relFile: rel, phase: PHASE_BY_DIR[m[1]] };
  } catch (e) {
    // classify must never throw -- an internal error is a skip, not a broken turn.
    return skip("internal_error: " + (e && e.message));
  }
}

// runHook: the whole hook minus process I/O. Returns { out } -- the exact stdout string or null.
// Failure contract: any internal failure -> stderr note + null out. NEVER throws.
export function runHook({ stdinText, env = process.env, fsView = fs, now = new Date().toISOString(), policyView } = {}) {
  try {
    let payload;
    try { payload = JSON.parse(String(stdinText ?? "")); } catch { return { out: null }; }
    const decision = classify(payload, env, fsView, policyView);
    if (decision.action !== "mark") return { out: null };
    markGateDue({ root: decision.root, relFile: decision.relFile, phase: decision.phase, now, fsView });
    const { remind, pending } = takeReminder({ root: decision.root, relFile: decision.relFile, fsView });
    if (!remind) return { out: null };
    const line = buildReminderLine({ relFile: decision.relFile, phase: decision.phase, pending });
    return { out: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line } }) };
  } catch (e) {
    process.stderr.write(`gate-due: ${e && e.message}\n`);
    return { out: null };
  }
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const { out } = runHook({ stdinText: text });
  if (out) process.stdout.write(out + "\n");
  process.exit(0);
}

// Entry guard (same pattern as cli.mjs): importing this module NEVER runs main.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}

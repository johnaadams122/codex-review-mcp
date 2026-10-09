#!/usr/bin/env node
// Fake codex CLI for A1 integration tests. Mode rides in $CODEX_HOME/fake-mode.txt (the 6c
// allowlist strips every other env var -- CODEX_HOME is the one channel that reaches a child):
//   happy | hang | empty-answer | no-rollout | wrong-effort | crash
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("codex-cli 0.144.1"); process.exit(0); }
const opt = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const answerFile = opt("-o");
const model = opt("-m");
let effort = null;
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] === "-c" && String(argv[i + 1]).startsWith("model_reasoning_effort=")) {
    effort = String(argv[i + 1]).split("=")[1];
  }
}
let mode = "happy";
try { mode = fs.readFileSync(path.join(process.env.CODEX_HOME, "fake-mode.txt"), "utf8").trim(); } catch { /* default */ }
const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  if (mode === "crash") process.exit(3);
  if (mode === "probe-denied" || mode === "probe-denied-pinned") {
    // Emulate the read-only sandbox for the 6d probe: every mutation/fetch command "ran" and
    // was denied; NO files are touched, so the caller's filesystem oracle stays intact.
    // probe-denied-pinned: identical EXCEPT the fetch event's aggregated_output is
    // the REAL captured P5 fixture bytes, so the pinned SIGNATURES.network is exercised against
    // the actual capture through the production probe chain.
    console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
    const deny = (cmd, aggregated_output, exit_code) => console.log(JSON.stringify({ type: "item.completed", item: {
      type: "command_execution", command: cmd,
      aggregated_output, exit_code, status: "completed" } }));
    const osDenied = "Access to the path is denied. UnauthorizedAccessException";
    deny("Set-Content -LiteralPath probe-write.txt -Value CANARY", osDenied, 1);
    deny("Add-Content -LiteralPath probe-existing.txt -Value X", osDenied, 1);
    deny("Remove-Item -LiteralPath probe-existing.txt", osDenied, 1);
    if (mode === "probe-denied-pinned") {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const fixture = fs.readFileSync(path.join(here, "..", "direct", "probe-network-denial.txt"), "utf8");
      deny("Invoke-WebRequest https://1.1.1.1 -UseBasicParsing", fixture, -1);
    } else {
      deny("Invoke-WebRequest https://1.1.1.1 -UseBasicParsing", osDenied, 1);
    }
    process.exit(0);
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution",
    command: "powershell -Command \"Get-Content -LiteralPath 'a.mjs' -Raw\"",
    aggregated_output: "export const x = 1;", exit_code: 0, status: "completed" } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  if (answerFile) {
    fs.writeFileSync(answerFile, mode === "empty-answer" ? "" : JSON.stringify({
      lens: "correctness", verdict: "pass", confidence: "high", findings: [],
      files_checked: ["a.mjs"],
    }), "utf8");
  }
  if (mode !== "no-rollout") {
    const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "07", "15");
    fs.mkdirSync(dir, { recursive: true });
    const recEffort = mode === "wrong-effort" ? "low" : effort;
    fs.writeFileSync(path.join(dir, `rollout-2026-07-15T00-00-00-${threadId}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { id: threadId, model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", payload: { model, effort: recEffort } }),
    ].join("\n"), "utf8");
  }
  process.exit(0);
});

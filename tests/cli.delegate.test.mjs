import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
// The child inherits CODEX_MCP_POLICY_FILE from this private settings file, so it never reads the
// settings file in the real home folder.
import "./helpers/hermetic-policy.mjs";

// CLI adapter case (g) -- a normalization failure must be a HARD,
// nonzero-exit error at the CLI boundary (not just the MCP boundary). Spawns the real
// cli.mjs as a child process with CLAUDE_PLUGIN_ROOT pointed at tests/fixtures so any
// codex-route call would hit the FAKE companion (tests/fixtures/scripts/codex-companion.mjs)
// -- hermetic, no real Codex, no network.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const CLI = path.join(REPO_ROOT, "cli.mjs");
const FIXTURES_ROOT = path.join(__dirname, "fixtures");

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: FIXTURES_ROOT, ...extraEnv },
    encoding: "utf8"
  });
}

test("(g) CLI: conflicting quality+effort override exits 4 (distinct from 1/2/3), output carries conflicting_override", () => {
  const res = runCli(["delegate", "handle this generic task", "--quality=flagship", "--effort=medium"]);
  assert.equal(res.status, 4, `expected exit 4, got ${res.status}; stderr=${res.stderr}`);
  const combined = `${res.stdout || ""}${res.stderr || ""}`;
  assert.match(combined, /conflicting_override/);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.result.job_id, undefined, "a normalization failure must never carry a job_id");
});

test("(g) CLI: blank model/effort pair is absent, not partial -- resolves standard via a REAL codex submission (end-to-end)", () => {
  // The earlier task text ("handle this generic task")
  // routed to the claude tier, so this never reached the codex branch or the fake
  // companion -- it proved "no error", not "resolves standard". A codex-forcing phrase
  // exercises the CLAUDE_PLUGIN_ROOT fixture wiring this file sets up: the blank pair
  // must resolve to the standard model/effort AND a real job_id from the fake companion.
  const res = runCli(["delegate", "implement the feature", "--model=", "--effort="]);
  assert.equal(res.status, 2, `expected exit 2 (codex job submitted), got ${res.status}; stderr=${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.result.error, undefined, "blank model/effort must not be treated as a partial override");
  assert.equal(payload.write_blocked, false);
  assert.equal(payload.selected_tier, "codex");
  assert.equal(payload.resolved_quality, "standard");
  assert.equal(payload.model, "gpt-6.1-sol");
  assert.equal(payload.effort, "medium");
  assert.equal(typeof payload.result.job_id, "string", "the fake companion must have returned a job_id");
  assert.ok(payload.result.job_id.length > 0);
});

// `--wait` blocks the submitted codex job to completion via the
// SAME hermetic fake-companion path exercised above, then folds the outcome in. The fold is
// PROJECTED to the minimal shape by default (wait_result under project.mjs's projectResult);
// `--verbose` restores the pre-projection raw fold. The fake companion's legacy (non-STORE)
// `status`/`result` handlers resolve to `completed` on the very first poll, so this is fast
// and fully hermetic (no real Codex, no network).

test("(h) CLI --wait: projected by default -- wait_result is the minimal projectResult shape", () => {
  const res = runCli(["delegate", "implement the feature", "--model=", "--effort=", "--wait"]);
  assert.equal(res.status, 2, `expected exit 2 (codex job submitted), got ${res.status}; stderr=${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.waited, true);
  assert.equal(payload.wait_status, "completed");
  assert.deepEqual(payload.wait_result, {
    status: "completed",
    job_id: payload.result.job_id,
    output: "Fake companion result text"
  });
});

test("(h) CLI --wait --verbose: restores the raw (pre-projection) wait fold", () => {
  const res = runCli(["delegate", "implement the feature", "--model=", "--effort=", "--wait", "--verbose"]);
  assert.equal(res.status, 2, `expected exit 2 (codex job submitted), got ${res.status}; stderr=${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.waited, true);
  assert.equal(payload.wait_status, "completed");
  assert.deepEqual(payload.wait_result, { output: "Fake companion result text", status: "completed" });
});

// Regression: a bare --verbose BEFORE the task string used to
// consume it as its own value (cli.mjs parseArgv), leaving no task at all and exiting 1 with
// "Missing task description". --verbose/--wait/--write must be standalone booleans regardless
// of position, so the task string reaches the fake companion.

// Regression: quality="local" + an invalid tier ("bogus")
// on a codex-keyword task used to reach the fake companion with a null model/effort (the
// config-toml fallback was supposed to close) and return a dishonest envelope
// (selected_tier:"codex", resolved_quality:"local"). The codex branch now hard-guards the
// null-strength invariant before submitTask and returns the SAME local_codex_conflict shape
// the normalizer already produces for the explicit tier="codex" conflict -- both adapters
// (CLI here, MCP in server.mjs) already key off NORMALIZATION_ERRORS.has(reason), so this
// is a pure orchestrator.mjs fix with no adapter changes required.
test("(j) CLI: quality=local + tier=bogus on a codex-keyword task exits 4, reason local_codex_conflict, nothing submitted", () => {
  const res = runCli(["delegate", "implement the feature", "--tier=bogus", "--quality=local"]);
  assert.equal(res.status, 4, `expected exit 4, got ${res.status}; stderr=${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.reason, "local_codex_conflict");
  assert.equal(payload.selected_tier, "codex");
  assert.equal(payload.result.job_id, undefined, "must never submit a codex job with a null model/effort");
  assert.ok(payload.result.error);
});

test("(i) CLI: --verbose BEFORE the task string does not swallow it -- task reaches the fake companion", () => {
  const res = runCli(["delegate", "--verbose", "implement the feature", "--wait"]);
  assert.equal(res.status, 2, `expected exit 2 (codex job submitted), got ${res.status}; stderr=${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.selected_tier, "codex");
  assert.equal(typeof payload.result.job_id, "string", "the fake companion must have received and submitted the task");
  assert.equal(payload.waited, true);
  assert.equal(payload.wait_status, "completed");
  // --verbose still restores the raw (pre-projection) wait fold, proving the flag itself
  // was correctly parsed as boolean true, not consumed as the task text.
  assert.deepEqual(payload.wait_result, { output: "Fake companion result text", status: "completed" });
});

test("the child CLI reads this file's private settings file, never the one in the home folder", (t) => {
  const home = tempDirFor(t, "cli-home-");
  fs.mkdirSync(path.join(home, ".codex-mcp"));
  fs.writeFileSync(path.join(home, ".codex-mcp", "project-policy.json"), "{ not json", "utf8");
  const res = runCli(["delegate", "handle this generic task"], { HOME: home, USERPROFILE: home });
  assert.equal(res.status, 0, `stderr=${res.stderr}`);
  assert.doesNotMatch(res.stderr || "", /bad_json/);
});

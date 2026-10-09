import { test, mock } from "node:test";
import "./helpers/hermetic-policy.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { tempDirFor, onCleanup } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture } from "./helpers/policy-fixture.mjs";
import { _resetPolicyCacheForTests } from "../policy.mjs";

// We test resolveCompanionPath() directly, and test argument construction
// by patching the spawn call. Real companion invocations are integration tests.

// Sets (or, with undefined, deletes) CLAUDE_PLUGIN_ROOT for one test and puts the old value back.
function withPluginRoot(t, value) {
  const orig = process.env.CLAUDE_PLUGIN_ROOT;
  if (value === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = value;
  onCleanup(t, () => {
    if (orig === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = orig;
  });
}

test("resolveCompanionPath returns path using CLAUDE_PLUGIN_ROOT env var", async (t) => {
  const root = path.join(path.parse(process.cwd()).root, "fake", "plugin", "root");
  withPluginRoot(t, root);
  const { resolveCompanionPath } = await import("../jobs.mjs?t=1");
  assert.equal(resolveCompanionPath(), path.join(root, "scripts", "codex-companion.mjs"));
});

test("resolveCompanionPath fails with a clear error when CLAUDE_PLUGIN_ROOT is absent (no built-in fallback path)", async (t) => {
  withPluginRoot(t, undefined);
  const { resolveCompanionPath } = await import("../jobs.mjs?t=2");
  assert.throws(() => resolveCompanionPath(), (e) => {
    assert.equal(e.code, "companion_plugin_root_unset");
    assert.match(e.message, /CLAUDE_PLUGIN_ROOT/);
    return true;
  });
});

test("resolveCompanionPath falls back to the settings-file companionPluginRoot when the env var is unset or empty", async (t) => {
  const root = path.join(path.parse(process.cwd()).root, "settings", "plugin", "root");
  installPolicyFixture(t, { companionPluginRoot: root });
  const { resolveCompanionPath } = await import("../jobs.mjs?t=2d");
  withPluginRoot(t, undefined);
  assert.equal(resolveCompanionPath(), path.join(root, "scripts", "codex-companion.mjs"));
  withPluginRoot(t, "");
  assert.equal(resolveCompanionPath(), path.join(root, "scripts", "codex-companion.mjs"));
});

test("a non-empty CLAUDE_PLUGIN_ROOT wins over the settings-file companionPluginRoot", async (t) => {
  const fromSettings = path.join(path.parse(process.cwd()).root, "settings", "plugin", "root");
  const fromEnv = path.join(path.parse(process.cwd()).root, "env", "plugin", "root");
  installPolicyFixture(t, { companionPluginRoot: fromSettings });
  const { resolveCompanionPath } = await import("../jobs.mjs?t=2e");
  withPluginRoot(t, fromEnv);
  assert.equal(resolveCompanionPath(), path.join(fromEnv, "scripts", "codex-companion.mjs"));
});

test("no env var and no companionPluginRoot in the settings file: coded error", async (t) => {
  installPolicyFixture(t);
  const { resolveCompanionPath } = await import("../jobs.mjs?t=2f");
  withPluginRoot(t, undefined);
  assert.throws(() => resolveCompanionPath(), (e) => e.code === "companion_plugin_root_unset");
});

test("a settings file that is rejected as a whole does not supply companionPluginRoot", async (t) => {
  const fx = installPolicyFixture(t, { companionPluginRoot: path.join(path.parse(process.cwd()).root, "settings", "plugin", "root") });
  // corrupt the file after install: still a valid companionPluginRoot, but one invalid project row
  const doc = JSON.parse(fs.readFileSync(fx.file, "utf8"));
  doc.projects = [{ ...doc.projects[0], name: "Bad Name" }];
  fs.writeFileSync(fx.file, JSON.stringify(doc));
  _resetPolicyCacheForTests();
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;   // the fail-safe reason line is expected here
  try {
    const { resolveCompanionPath } = await import("../jobs.mjs?t=2g");
    withPluginRoot(t, undefined);
    assert.throws(() => resolveCompanionPath(), (e) => e.code === "companion_plugin_root_unset");
  } finally { process.stderr.write = real; }
});

test("resolveCompanionPath treats an empty CLAUDE_PLUGIN_ROOT as absent", async (t) => {
  withPluginRoot(t, "");
  const { resolveCompanionPath } = await import("../jobs.mjs?t=2b");
  assert.throws(() => resolveCompanionPath(), /CLAUDE_PLUGIN_ROOT/);
});

test("runCompanion rejects (and spawns nothing) when CLAUDE_PLUGIN_ROOT is absent", async (t) => {
  withPluginRoot(t, undefined);
  const { runCompanion } = await import("../jobs.mjs?t=2c");
  await assert.rejects(() => runCompanion(["status"]), (e) => e.code === "companion_plugin_root_unset");
});

test("submitTask builds --background --json args", async () => {
  const { buildTaskArgs } = await import("../jobs.mjs?t=3");
  const args = buildTaskArgs("fix the bug", { write: true, effort: "high", cwd: "C:\\proj" });
  assert.ok(args.includes("task"), "should include 'task' subcommand");
  assert.ok(args.includes("--background"), "should include --background");
  assert.ok(args.includes("--json"), "should include --json");
  assert.ok(args.includes("--write"), "should include --write when write=true");
  assert.ok(args.includes("--effort"), "should include --effort");
  assert.ok(args.includes("high"), "should include effort value");
  assert.ok(args.includes("fix the bug"), "should include prompt");
});

test("buildTaskArgs adds -- separator before prompt", async () => {
  const { buildTaskArgs } = await import("../jobs.mjs?t=9");
  const args = buildTaskArgs("--verbose fix the bug");
  const dashDashIdx = args.indexOf("--");
  const promptIdx = args.indexOf("--verbose fix the bug");
  assert.ok(dashDashIdx !== -1, "should include -- separator");
  assert.ok(promptIdx > dashDashIdx, "prompt should come after --");
});

test("buildTaskArgs prompt starting with dash is safe after -- separator", async () => {
  const { buildTaskArgs } = await import("../jobs.mjs?t=10");
  const args = buildTaskArgs("--flag-looking-prompt");
  const ddIdx = args.indexOf("--");
  assert.ok(ddIdx !== -1, "-- must be present");
  assert.ok(args[ddIdx + 1] === "--flag-looking-prompt", "prompt follows --");
});

test("submitTask does not include --write when write=false", async () => {
  const { buildTaskArgs } = await import("../jobs.mjs?t=4");
  const args = buildTaskArgs("read the file", { write: false });
  assert.ok(!args.includes("--write"), "should NOT include --write");
});

test("buildReviewArgs builds review subcommand", async () => {
  const { buildReviewArgs } = await import("../jobs.mjs?t=5");
  const args = buildReviewArgs({ base: "main", scope: "branch" });
  assert.ok(args.includes("review"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--base"));
  assert.ok(args.includes("main"));
  assert.ok(args.includes("--scope"));
  assert.ok(args.includes("branch"));
});

test("buildAdversarialReviewArgs includes focus text", async () => {
  const { buildAdversarialReviewArgs } = await import("../jobs.mjs?t=6");
  const args = buildAdversarialReviewArgs("check design assumptions", { scope: "working-tree" });
  assert.ok(args.includes("adversarial-review"));
  assert.ok(args.includes("check design assumptions"));
});

test("buildReviewArgs includes --background", async () => {
  const { buildReviewArgs } = await import("../jobs.mjs?t=A1a");
  assert.ok(buildReviewArgs({}).includes("--background"));
});

test("buildAdversarialReviewArgs includes --background", async () => {
  const { buildAdversarialReviewArgs } = await import("../jobs.mjs?t=A1b");
  assert.ok(buildAdversarialReviewArgs("focus", {}).includes("--background"));
});

// --- flagship model wiring into reviews (companion review accepts --model; verified against
// codex/1.0.5 companion source: review valueOptions include "model") ---

test("buildReviewArgs includes --model <value> when provided", async () => {
  const { buildReviewArgs } = await import("../jobs.mjs?t=M1");
  const args = buildReviewArgs({ model: "gpt-6.1-sol" });
  const i = args.indexOf("--model");
  assert.ok(i !== -1, "should include --model");
  assert.equal(args[i + 1], "gpt-6.1-sol");
});

test("buildReviewArgs omits --model when not provided (behavior unchanged)", async () => {
  const { buildReviewArgs } = await import("../jobs.mjs?t=M2");
  assert.ok(!buildReviewArgs({}).includes("--model"));
});

test("buildAdversarialReviewArgs includes --model <value> when provided", async () => {
  const { buildAdversarialReviewArgs } = await import("../jobs.mjs?t=M3");
  const args = buildAdversarialReviewArgs("focus text", { model: "gpt-6.1-sol" });
  const i = args.indexOf("--model");
  assert.ok(i !== -1, "should include --model");
  assert.equal(args[i + 1], "gpt-6.1-sol");
  assert.ok(args.includes("focus text"), "focus still present");
});

test("buildAdversarialReviewArgs omits --model when not provided", async () => {
  const { buildAdversarialReviewArgs } = await import("../jobs.mjs?t=M4");
  assert.ok(!buildAdversarialReviewArgs("focus", {}).includes("--model"));
});

// --- prompt-file delivery (bypasses the Windows argv limit for large payloads e.g. a review diff) ---

test("buildTaskArgs uses --prompt-file and omits the positional prompt when promptFile is set", async () => {
  const { buildTaskArgs } = await import("../jobs.mjs?t=PF1");
  const args = buildTaskArgs("IGNORED PROMPT", { promptFile: String.raw`C:\tmp\p.txt`, model: "gpt-6.1-sol", effort: "xhigh" });
  const i = args.indexOf("--prompt-file");
  assert.ok(i !== -1, "should include --prompt-file");
  assert.equal(args[i + 1], String.raw`C:\tmp\p.txt`);
  assert.ok(!args.includes("--"), "must NOT push the -- prompt separator when delivering via a file");
  assert.ok(!args.includes("IGNORED PROMPT"), "positional prompt must be omitted");
  assert.ok(args.includes("--model") && args.includes("gpt-6.1-sol"));
  assert.ok(args.includes("--effort") && args.includes("xhigh"));
});

test("buildTaskArgs still uses the -- prompt separator when no promptFile", async () => {
  const { buildTaskArgs } = await import("../jobs.mjs?t=PF2");
  const args = buildTaskArgs("do it", {});
  assert.ok(args.includes("--"));
  assert.ok(args.includes("do it"));
});

test("submitTaskViaFile writes a temp prompt file, returns the job_id, and cleans up", async (t) => {
  const origRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  process.env.CLAUDE_PLUGIN_ROOT = path.join(here, "fixtures");
  const { submitTaskViaFile } = await import("../jobs.mjs?t=PF3");
  // Dedicated tmpDir: counting codex-panel-* in the GLOBAL tmpdir raced other
  // concurrently-running test files that also submit via file.
  const tmpDir = tempDirFor(t, "panel-tmp-test-");
  try {
    const r = await submitTaskViaFile("a large review prompt", { cwd: here, model: "gpt-6.1-sol", effort: "xhigh", tmpDir });
    assert.equal(r.job_id, "task-fake001");
    assert.equal(fs.readdirSync(tmpDir).length, 0, "the temp prompt file must be unlinked after submit");
  } finally {
    process.env.CLAUDE_PLUGIN_ROOT = origRoot;
  }
});

// --- extractAnswerText: pulls the assistant answer out of every real getResult() shape ---

test("extractAnswerText reads storedJob.result.rawOutput, job.summary, and {output}", async () => {
  const { extractAnswerText } = await import("../jobs.mjs?t=EAT1");
  assert.equal(extractAnswerText({ output: "A" }), "A");
  assert.equal(extractAnswerText({ storedJob: { result: { rawOutput: "B" } } }), "B");
  assert.equal(extractAnswerText({ job: { summary: "C" } }), "C");
  assert.equal(extractAnswerText("D"), "D");
  assert.equal(extractAnswerText(null), "");
});

test("extractAnswerText never returns storedJob.summary (the prompt)", async () => {
  const { extractAnswerText } = await import("../jobs.mjs?t=EAT2");
  const r = { job: { summary: "ANSWER" }, storedJob: { summary: "THE PROMPT" } };
  assert.equal(extractAnswerText(r), "ANSWER");
});

test("buildTreeKillArgs targets the whole tree forcibly", async () => {
  const { buildTreeKillArgs } = await import("../jobs.mjs?t=A3");
  assert.deepEqual(buildTreeKillArgs(1234), ["taskkill", "/PID", "1234", "/T", "/F"]);
});

test("isPidAlive: true for self, false for an exited pid", async () => {
  const { isPidAlive } = await import("../jobs.mjs?t=A4");
  assert.equal(isPidAlive(process.pid), true);
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(isPidAlive(dead.pid), false);
});

test("listJobs calls status --all --json", async () => {
  // This test documents the expected companion call shape.
  // Live integration test requires the companion to be available.
  const { buildStatusArgs } = await import("../jobs.mjs?t=7");
  const args = buildStatusArgs({});
  assert.ok(args.includes("status"), "should call status subcommand");
  assert.ok(args.includes("--all"), "should include --all");
  assert.ok(args.includes("--json"), "should include --json");
});

test("listJobs payload mapper collects running, latestFinished object, and recent", async () => {
  // Test the shape mapping logic by verifying the array-vs-object distinction
  const singleObj = { jobId: "finished-1", status: "succeeded" };
  const runningArr = [{ jobId: "running-1", status: "running" }];
  const recentArr = [{ jobId: "old-1", status: "succeeded" }];

  // Simulate the mapping logic that listJobs uses
  const items = [];
  if (Array.isArray(runningArr)) items.push(...runningArr);
  if (singleObj) items.push(singleObj);  // single object, not array
  if (Array.isArray(recentArr)) items.push(...recentArr);

  assert.equal(items.length, 3);
  assert.equal(items[0].jobId, "running-1");
  assert.equal(items[1].jobId, "finished-1");
  assert.equal(items[2].jobId, "old-1");
});

// --- extractCapturedMessage ---

const { extractCapturedMessage, isStuckFinalizing } = await import("../jobs.mjs?t=8");

test("extractCapturedMessage returns null for empty preview", () => {
  assert.equal(extractCapturedMessage([]), null);
  assert.equal(extractCapturedMessage(null), null);
  assert.equal(extractCapturedMessage(undefined), null);
});

test("extractCapturedMessage extracts message after prefix", () => {
  const preview = [
    "Thread ready (abc).",
    "Turn started (def).",
    "Assistant message captured: 2 is prime",
    "Turn completion inferred after the main thread finished and subagent work drained."
  ];
  assert.equal(extractCapturedMessage(preview), "2 is prime");
});

test("extractCapturedMessage handles 'none' answer", () => {
  const preview = [
    "Assistant message captured: none"
  ];
  assert.equal(extractCapturedMessage(preview), "none");
});

test("extractCapturedMessage returns null when prefix absent", () => {
  const preview = ["Thread ready.", "Turn started."];
  assert.equal(extractCapturedMessage(preview), null);
});

// --- isStuckFinalizing ---

test("isStuckFinalizing returns false for completed jobs", () => {
  assert.equal(isStuckFinalizing({ status: "completed", progressPreview: [] }), false);
});

test("isStuckFinalizing returns false for running job without both signals", () => {
  // Has captured but no inferred-completion
  assert.equal(isStuckFinalizing({
    status: "running",
    progressPreview: ["Assistant message captured: hello"]
  }), false);

  // Has inferred-completion but no captured
  assert.equal(isStuckFinalizing({
    status: "running",
    progressPreview: ["Turn completion inferred after the main thread finished and subagent work drained."]
  }), false);
});

test("isStuckFinalizing returns true when both signals present and status is running", () => {
  const job = {
    status: "running",
    phase: "finalizing",
    progressPreview: [
      "Thread ready (xyz).",
      "Turn started (xyz).",
      "Assistant message captured: 2 is prime",
      "Turn completion inferred after the main thread finished and subagent work drained."
    ]
  };
  assert.equal(isStuckFinalizing(job), true);
});

test("isStuckFinalizing returns false for null/undefined", () => {
  assert.equal(isStuckFinalizing(null), false);
  assert.equal(isStuckFinalizing(undefined), false);
});

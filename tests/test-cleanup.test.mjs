// tests/test-cleanup.test.mjs -- the per-test cleanup stack in tests/helpers/test-cleanup.mjs.
//
// Why it exists: test folders left in the OS temp folder pile up fast. Test files that made folders
// with mkdtempSync and never removed them, or removed them only at the end of the test body or in a
// `finally`, leak them: a failed assertion skips the end of the body, and a
// timed-out test never reaches a `finally` (node:test runs t.after hooks for a timed-out test but not a finally
// in its body; observed on Node v24). node:test also runs t.after hooks in REGISTRATION order
// and skips the later ones once one throws. onCleanup gives each context ONE t.after hook that runs
// every step newest-first, keeps going past a failure and reports all failures at the end;
// tempDirFor registers a temp folder's removal that way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLEANUP_HOOK_TIMEOUT_MS, TEMP_NAMESPACE, createRecordingContext, onCleanup, removeTree, runCleanupSteps, tempDirFor,
} from "./helpers/test-cleanup.mjs";

const HELPER = fileURLToPath(new URL("./helpers/test-cleanup.mjs", import.meta.url));

test("onCleanup registers exactly one hook per context, with an explicit timeout", () => {
  const t = createRecordingContext();
  onCleanup(t, () => {});
  onCleanup(t, () => {});
  onCleanup(t, () => {});
  assert.equal(t.hooks.length, 1);
  assert.ok(CLEANUP_HOOK_TIMEOUT_MS >= 60_000);
  assert.deepEqual(t.hooks[0].options, { timeout: CLEANUP_HOOK_TIMEOUT_MS });
  const other = createRecordingContext();
  onCleanup(other, () => {});
  assert.equal(other.hooks.length, 1, "a different context gets its own hook");
});

test("steps run newest-first, so a child started after its folder is stopped before the folder is removed", async () => {
  const t = createRecordingContext();
  const order = [];
  onCleanup(t, () => { order.push("remove folder"); });
  onCleanup(t, async () => { order.push("stop child"); });
  await t.runHooksLikeNodeTest();
  assert.deepEqual(order, ["stop child", "remove folder"]);
});

test("a failing step does not stop the others, and the hook then fails with that step's own error", async () => {
  const t = createRecordingContext();
  const order = [];
  const removeError = new Error("synthetic EBUSY");
  onCleanup(t, () => { order.push("first"); });
  onCleanup(t, () => { order.push("second"); throw removeError; });
  onCleanup(t, () => { order.push("third"); });
  await assert.rejects(() => t.runHooksLikeNodeTest(), (e) => e === removeError);
  assert.deepEqual(order, ["third", "second", "first"]);
});

test("when several steps fail, every step still runs and one AggregateError names all of them", async () => {
  const ran = [];
  const steps = [
    () => { ran.push("a"); throw new Error("first failure"); },
    () => { ran.push("b"); },
    () => { ran.push("c"); throw new Error("second failure"); },
  ];
  await assert.rejects(() => runCleanupSteps(steps), (e) => {
    assert.ok(e instanceof AggregateError);
    assert.equal(e.errors.length, 2);
    assert.match(e.message, /2 cleanup steps failed/);
    assert.match(e.message, /first failure/);
    assert.match(e.message, /second failure/);
    return true;
  });
  assert.deepEqual(ran, ["c", "b", "a"]);
});

test("a context whose hook already ran gets a fresh hook for steps added later (file-level collectors)", async () => {
  const t = createRecordingContext();
  const ran = [];
  onCleanup(t, () => { ran.push("first batch"); });
  await t.hooks[0].callback();
  onCleanup(t, () => { ran.push("second batch"); });
  assert.equal(t.hooks.length, 2);
  await t.hooks[1].callback();
  assert.deepEqual(ran, ["first batch", "second batch"]);
});

test("onCleanup rejects a step that is not a function, before registering anything", () => {
  const t = createRecordingContext();
  assert.throws(() => onCleanup(t, "rm -rf"), TypeError);
  assert.equal(t.hooks.length, 0);
});

test("tempDirFor makes a namespaced mkdtemp-shaped folder under the OS temp folder, synchronously, and removes it at cleanup", async () => {
  assert.equal(TEMP_NAMESPACE, "codex-mcp-test-", "an operator cleanup script (not part of this repository) matches this literal");
  const t = createRecordingContext();
  const dir = tempDirFor(t, "cleanup-");
  assert.equal(typeof dir, "string", "returns the path itself, not a promise (the suite's helpers are synchronous)");
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  assert.match(path.basename(dir), /^codex-mcp-test-cleanup-[A-Za-z0-9]{6}$/);
  fs.mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nested", "deeper", "f.txt"), "x");
  await t.runHooksLikeNodeTest();
  assert.equal(fs.existsSync(dir), false);
});

test("tempDirFor({ realpath: true }) returns the real path, and { parent } places the folder under that parent", async () => {
  const t = createRecordingContext();
  const parent = tempDirFor(t, "cleanup-parent-");
  const child = tempDirFor(t, "inner-", { parent, realpath: true });
  assert.equal(child, fs.realpathSync(child));
  assert.match(path.basename(child), /^inner-[A-Za-z0-9]{6}$/, "no namespace under an explicit parent");
  assert.equal(fs.realpathSync(path.dirname(child)), fs.realpathSync(parent));
  await t.runHooksLikeNodeTest();
  assert.equal(fs.existsSync(parent), false);
});

test("tempDirFor refuses a prefix that is not a plain name ending in '-'", () => {
  const t = createRecordingContext();
  assert.throws(() => tempDirFor(t, "no-dash"), TypeError);
  assert.throws(() => tempDirFor(t, "a/b-"), TypeError);
  assert.throws(() => tempDirFor(t, "..\\up-"), TypeError);
  assert.equal(t.hooks.length, 0);
});

test("removeTree removes a nested tree and treats an already-missing path as done", async (t) => {
  const dir = tempDirFor(t, "cleanup-");
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "b", "c.txt"), "c");
  await removeTree(dir);
  assert.equal(fs.existsSync(dir), false);
  await removeTree(dir);
});

// Observed on Node v24: fs.rmSync ignores maxRetries here and throws EPERM at once
// while a child's working directory is inside the folder; fs.promises.rm retries until it exits.
test("removeTree waits out a child still holding the folder as its working directory", async (t) => {
  const dir = tempDirFor(t, "cleanup-held-");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"], { cwd: dir, stdio: "ignore", windowsHide: true });
  onCleanup(t, () => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await new Promise((resolve) => setTimeout(resolve, 200));   // the child is now running inside the folder
  await removeTree(dir);
  assert.equal(fs.existsSync(dir), false);
});

// The real runner, in a separate process, because a failing or timed-out scratch test would
// otherwise fail THIS file. NODE_TEST_CONTEXT must not be inherited: with it the nested runner
// reports over a private channel instead of printing TAP.
function runScratch(t, source) {
  const scratch = tempDirFor(t, "cleanup-run-");
  const file = path.join(scratch, "scratch.test.mjs");
  fs.writeFileSync(file, source(scratch), "utf8");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", windowsHide: true, env, timeout: 60_000 });
  return { scratch, stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const helperUrl = JSON.stringify(pathToFileURL(HELPER).href);

test("under the real runner, a FAILED test still removes its tempDirFor folder", (t) => {
  const { scratch, stdout, status } = runScratch(t, (s) => [
    'import { test } from "node:test";',
    'import fs from "node:fs";',
    `import { tempDirFor } from ${helperUrl};`,
    'test("scratch", (t) => {',
    `  const dir = tempDirFor(t, "leak-probe-", { parent: ${JSON.stringify(s)} });`,
    '  fs.writeFileSync(dir + "/f.txt", "x");',
    '  throw new Error("scratch assertion failure");',
    "});",
    "",
  ].join("\n"));
  assert.match(stdout, /not ok 1 - scratch/);
  assert.notEqual(status, 0);
  assert.deepEqual(fs.readdirSync(scratch).filter((n) => n.startsWith("leak-probe-")), []);
});

test("under the real runner, a TIMED-OUT test still removes its tempDirFor folder (a finally would not run)", (t) => {
  const { scratch, stdout, status } = runScratch(t, (s) => [
    'import { test } from "node:test";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    `import { tempDirFor } from ${helperUrl};`,
    'test("scratch", { timeout: 300 }, async (t) => {',
    `  const dir = tempDirFor(t, "leak-probe-", { parent: ${JSON.stringify(s)} });`,
    `  const legacy = fs.mkdtempSync(path.join(${JSON.stringify(s)}, "finally-probe-"));`,
    "  try {",
    "    await new Promise((resolve) => { const h = setTimeout(resolve, 5000); h.unref(); });",
    "  } finally {",
    "    fs.rmSync(legacy, { recursive: true, force: true });",
    "  }",
    "});",
    "",
  ].join("\n"));
  assert.match(stdout, /not ok 1 - scratch/);
  assert.match(stdout, /timed out/i);
  assert.notEqual(status, 0);
  const left = fs.readdirSync(scratch);
  assert.deepEqual(left.filter((n) => n.startsWith("leak-probe-")), [], "tempDirFor folder removed by the t.after hook");
  assert.equal(left.filter((n) => n.startsWith("finally-probe-")).length, 1,
    "control: the finally-based folder leaks on a timeout, which is why the suite no longer uses finally for temp folders");
});

test("under the real runner, a failing cleanup step still lets the other step run, and the test is reported failed", (t) => {
  const { scratch, stdout, status } = runScratch(t, (s) => [
    'import { test } from "node:test";',
    'import fs from "node:fs";',
    `import { onCleanup } from ${helperUrl};`,
    'test("scratch", (t) => {',
    `  onCleanup(t, () => { fs.writeFileSync(${JSON.stringify(path.join(s, "marker.txt"))}, "ran"); });`,
    '  onCleanup(t, () => { throw new Error("scratch cleanup failure"); });',
    "});",
    "",
  ].join("\n"));
  assert.equal(fs.readFileSync(path.join(scratch, "marker.txt"), "utf8"), "ran");
  assert.match(stdout, /not ok 1 - scratch/);
  assert.match(stdout, /scratch cleanup failure/);
  assert.notEqual(status, 0);
});

// node:test cannot stop a timed-out body: it keeps running after the test's t.after hook, and a
// write it makes then can re-create the folder. The exit sweep in the helper runs as the file's
// process exits, after such a body has finished.
test("under the real runner, a folder a TIMED-OUT body re-creates after cleanup is gone once the file's process exits", (t) => {
  const { scratch, stdout } = runScratch(t, (s) => [
    'import { test } from "node:test";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    `import { tempDirFor } from ${helperUrl};`,
    'test("scratch", { timeout: 200 }, async (t) => {',
    `  const dir = tempDirFor(t, "leak-probe-", { parent: ${JSON.stringify(s)} });`,
    "  await new Promise((resolve) => setTimeout(resolve, 700));   // still running after the timeout and the hook",
    '  fs.mkdirSync(path.join(dir, "late"), { recursive: true });',
    '  fs.writeFileSync(path.join(dir, "late", "meta.json"), "{}");',
    "});",
    "",
  ].join("\n"));
  assert.match(stdout, /timed out/i);
  assert.deepEqual(fs.readdirSync(scratch).filter((n) => n.startsWith("leak-probe-")), []);
});

// When the test has already failed, node:test reports only that failure and a failed removal in
// the hook is lost. The exit sweep tries once more and, if the folder still cannot go, says so on
// stderr and fails the file's process.
test("under the real runner, a folder that cannot be removed at all is reported and fails the file, even when the test already failed", (t) => {
  const pidFile = tempDirFor(t, "cleanup-pid-") + path.sep + "holder.pid";
  const { scratch, stdout, stderr, status } = runScratch(t, (s) => [
    'import { test } from "node:test";',
    'import fs from "node:fs";',
    'import { spawn } from "node:child_process";',
    `import { tempDirFor } from ${helperUrl};`,
    'test("scratch", (t) => {',
    `  const dir = tempDirFor(t, "leak-probe-", { parent: ${JSON.stringify(s)} });`,
    '  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { cwd: dir, stdio: "ignore", windowsHide: true });',
    "  holder.unref();",
    `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));`,
    '  throw new Error("scratch assertion failure");',
    "});",
    "",
  ].join("\n"));
  // Stop the holder (by its own pid) before this test's folders are removed.
  onCleanup(t, () => { try { process.kill(Number(fs.readFileSync(pidFile, "utf8"))); } catch { /* already gone */ } });
  if (process.platform !== "win32") return;   // elsewhere a working directory does not pin a folder
  assert.match(stdout, /not ok 1 - scratch/);
  assert.notEqual(status, 0);
  assert.match(stdout + stderr, /codex-mcp test cleanup: could not remove 1 temp folder/);
  assert.equal(fs.readdirSync(scratch).filter((n) => n.startsWith("leak-probe-")).length, 1, "the held folder is still there");
});

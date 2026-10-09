// tests/helpers/test-cleanup.mjs -- one cleanup hook per test, with every step guaranteed to run.
//
// Two node:test behaviours make ad hoc cleanup leak (both measured on Node v24.16.0):
//   * a `finally` block, or an rmSync at the end of a test body, never runs when the test times out
//     (node:test still runs the test's t.after hooks), and the end-of-body rmSync is skipped by any
//     failed assertion before it;
//   * t.after hooks run in REGISTRATION order, and once one throws every later hook on that test is
//     skipped.
// onCleanup gives each context ONE t.after hook that runs the registered steps newest-first (a child
// is stopped before the folder it works in is removed), runs every step even when one fails, and only
// then fails the test with the collected errors. tempDirFor makes a temp folder and registers its
// removal that way, then checks once more as the process exits (see `made` below). Use tempDirFor for
// EVERY temp folder a test makes (tests/test-hygiene.guard.test.mjs enforces it); never mkdtemp directly.
// What this does NOT cover: a run killed from outside (no hook or exit handler runs), and a removal
// that still fails at exit (reported on stderr, file failed). an operator cleanup script (not part of this repository) is the
// manual backstop for those.
//
// `t` may be a node:test context or any object with an after(callback, options) method. For a folder
// shared by a whole file, pass `{ after }` (node:test's own export) and call it at MODULE TOP LEVEL: the
// hook is registered on first use, and node:test attaches an after() made inside a running test to that
// test instead of the file. Do not call onCleanup from inside a cleanup step: a step added while the
// hook runs is not run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A per-test timeout does not cover a t.after hook: without its own timeout the hook runs under the
// command-line --test-timeout (Infinity when none is given). Removing small temp trees takes well under
// a second; the budget covers removeTree's EBUSY retries on a slow host with room to spare.
export const CLEANUP_HOOK_TIMEOUT_MS = 120_000;

const stacks = new WeakMap();

export function onCleanup(t, step) {
  if (typeof step !== "function") throw new TypeError("cleanup step must be a function");
  let steps = stacks.get(t);
  if (steps === undefined) {
    steps = [];
    stacks.set(t, steps);
    const registered = steps;
    t.after(async () => {
      if (stacks.get(t) === registered) stacks.delete(t);
      await runCleanupSteps(registered);
    }, { timeout: CLEANUP_HOOK_TIMEOUT_MS });
  }
  steps.push(step);
}

// Runs every step newest-first. A failure is kept, never allowed to stop the next step; one failure
// is rethrown as itself, several as one AggregateError whose message names each of them.
export async function runCleanupSteps(steps) {
  const failures = [];
  for (const step of steps.splice(0).reverse()) {
    try {
      await step();
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const detail = failures.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    throw new AggregateError(failures, `${failures.length} cleanup steps failed: ${detail}`);
  }
}

// Recursive removal that rides out the EBUSY/EPERM/ENOTEMPTY window while a child that works in the
// folder is still exiting: fs.promises.rm retries those codes with a linear back-off (about 5.5 s in
// all). fs.rmSync does NOT here: measured on Node v24.16.0, it threw EPERM after 1 ms with
// the same maxRetries while fs.promises.rm succeeded after about 1 s. A missing path counts as removed.
// Still rejects when the tree cannot be removed, so the failure reaches the test.
export async function removeTree(p) {
  await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Every folder tempDirFor made in this process, for one last pass as the process exits. node:test
// cannot stop a timed-out test body: it keeps running after the test's hook, and a write it makes
// then can re-create the folder. And when a test has already failed, node:test reports only that
// failure, so a removal the hook could not finish is lost. The exit pass runs after all of that; a
// folder it still cannot remove is named on stderr and the process exits nonzero, failing the file.
const made = new Set();
let exitSweepArmed = false;
function armExitSweep() {
  if (exitSweepArmed) return;
  exitSweepArmed = true;
  process.on("exit", () => {
    const failed = [];
    for (const dir of made) {
      if (!fs.existsSync(dir)) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { failed.push(`${dir} (${e.code ?? e.message})`); }
    }
    if (failed.length === 0) return;
    fs.writeSync(2, `codex-mcp test cleanup: could not remove ${failed.length} temp folder(s) at exit: ${failed.join("; ")}\n`);
    process.exitCode = 1;
  });
}

// A stand-in for a node:test context, for tests OF cleanup behaviour. It records hooks in
// registration order and runs them the way node:test does: once each, in that order, stopping at
// the first one that throws.
export function createRecordingContext() {
  const hooks = [];
  return {
    hooks,
    after(callback, options) { hooks.push({ callback, options }); },
    async runHooksLikeNodeTest() {
      for (const hook of hooks) await hook.callback();
    },
  };
}

// The mkdtemp name shape: a plain prefix ending in "-", plus six letters or digits that mkdtemp adds.
// An operator cleanup script (not part of this repository) removes only names of exactly this shape.
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9.-]*-$/;

// Every folder made directly in the OS temp folder carries this label in front of the caller's prefix,
// so a leftover (a run killed before its hooks ran) is attributable to this suite by name alone; a bare
// generic prefix (sup-, lock-, e2e-, ...) could collide with other tools. A folder made under an explicit parent keeps the bare prefix: the parent already scopes it.
export const TEMP_NAMESPACE = "codex-mcp-test-";

// A fresh folder `<OS temp>/codex-mcp-test-<prefix>XXXXXX`, or `<parent>/<prefix>XXXXXX`, whose removal is
// registered with onCleanup, so it is removed when the test ends, even if it failed or timed out. Synchronous,
// like the suite's other fixture helpers. { realpath: true } returns fs.realpathSync of the folder
// for tests that compare against resolved paths.
export function tempDirFor(t, prefix, { parent = null, realpath = false } = {}) {
  if (typeof prefix !== "string" || !PREFIX.test(prefix) || prefix.includes("..")) {
    throw new TypeError(`temp folder prefix must be a plain name ending in '-': ${JSON.stringify(prefix)}`);
  }
  const dir = fs.mkdtempSync(parent === null ? path.join(os.tmpdir(), TEMP_NAMESPACE + prefix) : path.join(parent, prefix));
  made.add(dir);
  armExitSweep();
  onCleanup(t, () => removeTree(dir));
  return realpath ? fs.realpathSync(dir) : dir;
}

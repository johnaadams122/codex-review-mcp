import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgv } from "../cli.mjs";

test("parseArgv recognizes the gate command with --phase and --cwd", () => {
  const { command, flags } = parseArgv(["node", "cli.mjs", "gate", "--phase=spec", "--cwd=/repo"]);
  assert.equal(command, "gate");
  assert.equal(flags.phase, "spec");
  assert.equal(flags.cwd, "/repo");
});

test("parseArgv treats a trailing --wait as a boolean flag on delegate", () => {
  const { command, positionals, flags } = parseArgv(["node", "cli.mjs", "delegate", "do a thing", "--wait"]);
  assert.equal(command, "delegate");
  assert.equal(flags.wait, true);
  assert.ok(positionals.includes("do a thing"));
});

test("parseArgv preserves a raw --target value (comma list) for the gate", () => {
  const { flags } = parseArgv(["node", "cli.mjs", "gate", "--phase=plan", "--target=a.md,b.md"]);
  assert.equal(flags.target, "a.md,b.md");
});

// --verbose/--wait/--write are standalone booleans and
// must never consume the following positional token.

test("parseArgv: --verbose BEFORE the task string does not swallow it as a value", () => {
  const { command, positionals, flags } = parseArgv(["node", "cli.mjs", "delegate", "--verbose", "implement the feature", "--wait"]);
  assert.equal(command, "delegate");
  assert.equal(flags.verbose, true);
  assert.equal(flags.wait, true);
  assert.deepEqual(positionals, ["implement the feature"]);
});

test("parseArgv: --verbose/--wait AFTER the task string still work (order independence)", () => {
  const { positionals, flags } = parseArgv(["node", "cli.mjs", "delegate", "implement the feature", "--verbose", "--wait"]);
  assert.equal(flags.verbose, true);
  assert.equal(flags.wait, true);
  assert.deepEqual(positionals, ["implement the feature"]);
});

test("parseArgv: --write is a standalone boolean and never consumes the next positional", () => {
  const { positionals, flags } = parseArgv(["node", "cli.mjs", "delegate", "--write", "do the task"]);
  assert.equal(flags.write, true);
  assert.deepEqual(positionals, ["do the task"]);
});

test("parseArgv: non-boolean flags (--tier, --quality, --model, --effort, --cwd, --context) still consume the next token", () => {
  const { flags } = parseArgv(["node", "cli.mjs", "delegate", "do it", "--tier", "codex", "--quality", "flagship", "--model", "gpt-6.1-sol", "--effort", "xhigh", "--cwd", "/repo", "--context", "snap"]);
  assert.equal(flags.tier, "codex");
  assert.equal(flags.quality, "flagship");
  assert.equal(flags.model, "gpt-6.1-sol");
  assert.equal(flags.effort, "xhigh");
  assert.equal(flags.cwd, "/repo");
  assert.equal(flags.context, "snap");
});

test("parseArgv: --verbose=true explicit-equals form still works", () => {
  const { flags } = parseArgv(["node", "cli.mjs", "delegate", "do it", "--verbose=true"]);
  assert.equal(flags.verbose, "true");
});

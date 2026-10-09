// tests/gate-reaper.entry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { reapAll, knownRoots, exitCodeFor } from "../tools/gate-reaper.mjs";

test("reapAll sweeps every provided root and aggregates counts", () => {
  const swept = [];
  const sweepJournal = (root) => { swept.push(root); return { reaped: 1 }; };
  const out = reapAll(["/repo/main-root", "/repo/second-root"], { sweepJournal });
  assert.deepEqual(swept, ["/repo/main-root", "/repo/second-root"]);
  assert.equal(out.reaped, 2);
});

test("reapAll tolerates a root that throws (one bad root never aborts the sweep)", () => {
  const sweepJournal = (root) => { if (root === "/bad") throw new Error("boom"); return { reaped: 1 }; };
  const out = reapAll(["/bad", "/repo/ok"], { sweepJournal });
  assert.equal(out.reaped, 1);
  assert.equal(out.errors, 1);
});

test("knownRoots returns injected roots verbatim when provided", () => {
  assert.deepEqual(knownRoots({ roots: ["/a", "/b"] }), ["/a", "/b"]);
});

test("exitCodeFor is nonzero when any root swept with an error (a scheduled reap must not report success on a real failure)", () => {
  assert.equal(exitCodeFor({ reaped: 3, errors: 0 }), 0);
  assert.equal(exitCodeFor({ reaped: 1, errors: 1 }), 1);
  assert.equal(exitCodeFor({ reaped: 0, errors: 2 }), 1);
});

const NO_SETTINGS = { reaperExtraRoots: [] };
const moduleDir = path.join(path.sep + "ws", "projects", "this-repo", "tools") + path.sep;
const repo = path.resolve(moduleDir, "..");
const other = (n) => path.join(path.sep + "ws", "projects", n);

test("knownRoots DERIVES only this repo's root from the module dir by default (no sibling project is assumed)", () => {
  const sibling = path.join(path.resolve(repo, ".."), "some-sibling");
  const existsSync = (p) => p === repo || p === sibling;
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env: {}, config: NO_SETTINGS }), [repo]);
  // a root that does not exist is filtered out (never sweep a phantom path)
  assert.deepEqual(knownRoots({ moduleDir, existsSync: () => false, env: {}, config: NO_SETTINGS }), []);
});

test("knownRoots adds extra roots from CODEX_MCP_REAPER_EXTRA_ROOTS (path-delimited), existing and absolute only", () => {
  const env = { CODEX_MCP_REAPER_EXTRA_ROOTS: [other("a"), "relative/dir", other("missing"), "", other("b")].join(path.delimiter) };
  const existsSync = (p) => p === repo || p === other("a") || p === other("b");
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env, config: NO_SETTINGS }), [repo, other("a"), other("b")]);
});

test("knownRoots adds the settings-file reaperExtraRoots after the env entries", () => {
  const env = { CODEX_MCP_REAPER_EXTRA_ROOTS: other("from-env") };
  const config = { reaperExtraRoots: [other("from-settings")] };
  const existsSync = () => true;
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env, config }), [repo, other("from-env"), other("from-settings")]);
});

test("knownRoots takes extra roots from deps.extraRoots too, and never lists the same root twice", () => {
  const existsSync = () => true;
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env: {}, config: NO_SETTINGS, extraRoots: [other("x"), repo, other("x")] }), [repo, other("x")]);
});

test("knownRoots dedupes across sources, and case-insensitively on Windows only", () => {
  const existsSync = () => true;
  const env = { CODEX_MCP_REAPER_EXTRA_ROOTS: other("Same") };
  const config = { reaperExtraRoots: [other("same"), other("SAME")] };
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env, config, platform: "win32" }), [repo, other("Same")]);
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env, config, platform: "linux" }), [repo, other("Same"), other("same"), other("SAME")]);
});

test("knownRoots dedupes by REAL location: a link or short-name spelling of a listed root is the same root", () => {
  const existsSync = () => true;
  const real = { [other("alias")]: other("x"), [other("x")]: other("x") };
  const realpath = (p) => { if (real[p]) return real[p]; throw Object.assign(new Error("nope"), { code: "ENOENT" }); };
  const config = { reaperExtraRoots: [other("x"), other("alias")] };
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env: {}, config, realpath, platform: "linux" }), [repo, other("x")]);
});

test("knownRoots keeps two RESOLVED roots that differ only in case (an NTFS case-sensitive folder holds both)", () => {
  const B = String.fromCharCode(92);
  const W = (...p) => p.join(B);
  const real = { [W("C:", "base", "safe")]: W("C:", "base", "safe"), [W("C:", "base", "alias")]: W("C:", "base", "SAFE") };
  const realpath = (p) => { if (real[p]) return real[p]; throw Object.assign(new Error("nope"), { code: "ENOENT" }); };
  const config = { reaperExtraRoots: [W("C:", "base", "safe"), W("C:", "base", "alias")] };
  const out = knownRoots({ moduleDir, existsSync: () => true, env: {}, config, realpath, platform: "win32" });
  assert.deepEqual(out.slice(1), [W("C:", "base", "safe"), W("C:", "base", "alias")]);
});

test("knownRoots reads the real settings file when no config is injected (an invalid file contributes nothing)", () => {
  const existsSync = (p) => p === repo;
  const failed = { ok: false, reason: "file_missing", projectsBase: "", table: [], gateAllowlist: [], companionPluginRoot: "", reaperExtraRoots: [] };
  assert.deepEqual(knownRoots({ moduleDir, existsSync, env: {}, config: failed }), [repo]);
});

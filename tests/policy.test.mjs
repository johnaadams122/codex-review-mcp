import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePolicy, loadPolicyConfig, policyFilePath, _resetPolicyCacheForTests, isCanonicalAbsolutePath } from "../policy.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import {
  installPolicyFixture, writeRawPolicyFile, POLICY_SCHEMA,
  ALPHA, BETA, GAMMA, DELTA, EPSILON,
} from "./helpers/policy-fixture.mjs";

// One shared fixture for the behavioural cases (module top level, so `after` owns the cleanup).
const fx = installPolicyFixture({ after });
const at = (row, ...sub) => fx.dirOf(row, ...sub);

// ---------------------------------------------------------------- behaviour per row type

test("a pii project that sets review explicitly allows write AND review but stays git-blocked and pii_sensitive", () => {
  const p = resolvePolicy(at(DELTA));
  assert.equal(p.write_allowed, true);
  assert.equal(p.git_allowed, false);
  assert.equal(p.pii_sensitive, true);
  assert.equal(p.review_allowed, true, "an explicit review override beats the !pii default");
  assert.equal(p.name, "project_delta");
});

test("a non-pii, write-blocked, git-less project", () => {
  const p = resolvePolicy(at(GAMMA));
  assert.equal(p.write_allowed, false);
  assert.equal(p.git_allowed, false);
  assert.equal(p.pii_sensitive, false);
  assert.equal(p.review_allowed, true, "review defaults to !pii");
  assert.equal(p.name, "project_gamma");
});

test("a pii project without a review override keeps write+git but defaults to review-blocked", () => {
  const p = resolvePolicy(at(ALPHA));
  assert.equal(p.pii_sensitive, true);
  assert.equal(p.write_allowed, true);
  assert.equal(p.git_allowed, true);
  assert.equal(p.review_allowed, false);
  assert.equal(p.name, "project_alpha");
});

test("subdirectory of a pii project inherits pii_sensitive and the review default", () => {
  const p = resolvePolicy(at(ALPHA, "some", "subdir"));
  assert.equal(p.pii_sensitive, true);
  assert.equal(p.review_allowed, false);
  assert.equal(p.name, "project_alpha");
});

test("a normal non-pii git project allows write, git and review", () => {
  const p = resolvePolicy(at(BETA));
  assert.equal(p.write_allowed, true);
  assert.equal(p.git_allowed, true);
  assert.equal(p.pii_sensitive, false);
  assert.equal(p.review_allowed, true);
  assert.equal(p.name, "project_beta");
});

test("subdirectory of a non-pii project inherits the policy", () => {
  const p = resolvePolicy(at(BETA, "src", "review-core"));
  assert.equal(p.pii_sensitive, false);
  assert.equal(p.write_allowed, true);
  assert.equal(p.review_allowed, true, "a non-pii sub-directory keeps review allowed");
  assert.equal(p.name, "project_beta");
  assert.deepEqual(p, resolvePolicy(at(BETA)), "the child resolves to exactly the root's policy");
});

test("subdirectory of a non-pii, git-blocked project inherits the root's full policy", () => {
  const root = resolvePolicy(at(GAMMA));
  const child = resolvePolicy(at(GAMMA, "some", "subdir"));
  assert.deepEqual(child, root);
  assert.equal(child.git_allowed, false);
  assert.equal(child.write_allowed, false);
  assert.equal(child.pii_sensitive, false);
  assert.equal(child.review_allowed, true);
  assert.equal(child.name, "project_gamma");
});

test("subdirectory of a project with a mixed-case dir name inherits write-allowed and pii_sensitive", () => {
  const p = resolvePolicy(at(DELTA, "src", "agent"));
  assert.equal(p.write_allowed, true);
  assert.equal(p.pii_sensitive, true);
  assert.equal(p.name, "project_delta");
});

test("a pii, write-blocked project stays review-blocked", () => {
  const p = resolvePolicy(at(EPSILON));
  assert.equal(p.pii_sensitive, true);
  assert.equal(p.write_allowed, false);
  assert.equal(p.git_allowed, false);
  assert.equal(p.review_allowed, false);
  assert.equal(p.name, "project_epsilon");
});

test("subdirectory of a pii, write-blocked project inherits pii_sensitive", () => {
  assert.equal(resolvePolicy(at(EPSILON, "some", "subdir")).pii_sensitive, true);
});

// ---------------------------------------------------------------- matching rules

// Windows resolves an existing folder in any letter case (the OS returns the stored spelling). A folder
// that does not exist yet is matched only as written: see tests/policy.canonical.test.mjs.
test("matching an EXISTING project folder is case-insensitive (Windows)", { skip: process.platform !== "win32" }, () => {
  fs.mkdirSync(at(BETA), { recursive: true });
  fs.mkdirSync(at(DELTA), { recursive: true });
  const upper = at(BETA).toUpperCase();
  assert.equal(resolvePolicy(upper).name, "project_beta");
  const lowerDelta = at(DELTA).toLowerCase();
  assert.equal(resolvePolicy(lowerDelta).name, "project_delta");
});

test("a sibling folder that merely shares the prefix does NOT match", () => {
  assert.equal(resolvePolicy(at(BETA) + "-extra").name, "unknown");
  assert.equal(resolvePolicy(at(BETA) + "2").name, "unknown");
});

test("the projects base folder itself is not a project", () => {
  assert.equal(resolvePolicy(fx.base).name, "unknown");
});

test("unknown cwd returns safe defaults (write=false, git=false, pii=true, review=false)", () => {
  const p = resolvePolicy(path.join(path.dirname(fx.base), "somewhere", "unknown"));
  assert.equal(p.write_allowed, false);
  assert.equal(p.git_allowed, false, "unknown cwd is git-blocked (fail-closed default)");
  assert.equal(p.pii_sensitive, true);
  assert.equal(p.review_allowed, false, "unknown cwd must stay review-blocked (fail-closed default)");
  assert.equal(p.name, "unknown");
});

test("null cwd falls back to defaults safely", () => {
  const p = resolvePolicy(null);
  assert.equal(typeof p.write_allowed, "boolean");
  assert.equal(typeof p.git_allowed, "boolean");
});

test("the return shape is exactly the five documented fields", () => {
  assert.deepEqual(Object.keys(resolvePolicy(at(BETA))).sort(),
    ["git_allowed", "name", "pii_sensitive", "review_allowed", "write_allowed"]);
  assert.deepEqual(Object.keys(resolvePolicy(null)).sort(),
    ["git_allowed", "name", "pii_sensitive", "review_allowed", "write_allowed"]);
});

test("resolvePolicy takes an explicit config as its second argument", () => {
  const config = loadPolicyConfig(fx.file);
  assert.equal(resolvePolicy(at(ALPHA), config).name, "project_alpha");
  const empty = { ok: false, reason: "x", projectsBase: "", table: [], gateAllowlist: [] };
  assert.equal(resolvePolicy(at(ALPHA), empty).name, "unknown");
});

// ---------------------------------------------------------------- loadPolicyConfig

const good = (over = {}) => JSON.stringify({
  schema: POLICY_SCHEMA,
  projectsBase: fx.base,
  projects: [{ dir: "one", name: "one", write: true, git: true, pii: false }],
  ...over,
});
const row = (over) => ({ dir: "a", name: "a", write: true, git: true, pii: false, ...over });
const SEP = path.sep;
const BS = String.fromCharCode(92);

test("loadPolicyConfig returns the table, base and an empty gate allowlist by default", () => {
  const c = loadPolicyConfig(fx.file);
  assert.equal(c.ok, true);
  assert.equal(c.reason, null);
  assert.equal(c.projectsBase, fx.base);
  assert.equal(c.table.length, 5);
  assert.deepEqual(c.gateAllowlist, []);
});

test("loadPolicyConfig accepts a leading byte-order mark (PowerShell writes one)", (t) => {
  const f = writeRawPolicyFile(t, String.fromCharCode(0xFEFF) + good());
  assert.equal(loadPolicyConfig(f).ok, true);
});

const FAILURES = [
  ["missing file", (t) => path.join(tempDirFor(t, "policy-missing-", { realpath: true }), "nope.json"), "file_missing"],
  ["a folder where the file should be", (t) => tempDirFor(t, "policy-isdir-", { realpath: true }), "file_unreadable"],
  ["relative path", () => "project-policy.json", "path_not_absolute"],
  // On Windows "\x\file" and "C:file" depend on the current drive or folder, so they are not absolute.
  ...(process.platform !== "win32" ? [] : [
    ["a drive-less rooted path", (t) => writeRawPolicyFile(t, good()).slice(2), "path_not_absolute"],
    ["a drive-relative path", (t) => { const f = writeRawPolicyFile(t, good()); return f.slice(0, 2) + path.basename(f); }, "path_not_absolute"],
  ]),
  ["bad JSON", (t) => writeRawPolicyFile(t, "{ not json"), "bad_json"],
  ["JSON that is not an object", (t) => writeRawPolicyFile(t, "[1,2]"), "bad_schema"],
  ["wrong schema id", (t) => writeRawPolicyFile(t, good({ schema: "other" })), "bad_schema"],
  ["missing schema id", (t) => writeRawPolicyFile(t, JSON.stringify({ projectsBase: fx.base, projects: [] })), "bad_schema"],
  ["unknown top-level key", (t) => writeRawPolicyFile(t, good({ extra: 1 })), "unknown_key"],
  ["unknown key inside a project", (t) => writeRawPolicyFile(t, good({ projects: [row({ bonus: true })] })), "unknown_key"],
  ["projectsBase not absolute", (t) => writeRawPolicyFile(t, good({ projectsBase: "relative/base" })), "bad_projects_base"],
  ["projectsBase wrong type", (t) => writeRawPolicyFile(t, good({ projectsBase: 7 })), "bad_projects_base"],
  ["projects not an array", (t) => writeRawPolicyFile(t, good({ projects: {} })), "wrong_type"],
  ["project entry not an object", (t) => writeRawPolicyFile(t, good({ projects: ["a"] })), "wrong_type"],
  ["boolean given as a string", (t) => writeRawPolicyFile(t, good({ projects: [row({ write: "true" })] })), "wrong_type"],
  ["missing boolean", (t) => writeRawPolicyFile(t, good({ projects: [{ dir: "a", name: "a", write: true, git: true }] })), "wrong_type"],
  ["review given as a string", (t) => writeRawPolicyFile(t, good({ projects: [row({ review: "no" })] })), "wrong_type"],
  ["empty dir", (t) => writeRawPolicyFile(t, good({ projects: [row({ dir: "" })] })), "bad_value"],
  ["dir with a path separator", (t) => writeRawPolicyFile(t, good({ projects: [row({ dir: "a/b" })] })), "bad_value"],
  ["dir with a backslash", (t) => writeRawPolicyFile(t, good({ projects: [row({ dir: "a\\b" })] })), "bad_value"],
  ["dir that is a dot segment", (t) => writeRawPolicyFile(t, good({ projects: [row({ dir: ".." })] })), "bad_value"],
  ["name with a hyphen", (t) => writeRawPolicyFile(t, good({ projects: [row({ name: "my-name" })] })), "bad_value"],
  ["name with upper case", (t) => writeRawPolicyFile(t, good({ projects: [row({ name: "Name" })] })), "bad_value"],
  ["the reserved name unknown", (t) => writeRawPolicyFile(t, good({ projects: [row({ name: "unknown" })] })), "bad_value"],
  ["duplicate name", (t) => writeRawPolicyFile(t, good({ projects: [row({ dir: "a", name: "same" }), row({ dir: "b", name: "same" })] })), "duplicate_name"],
  ["companionPluginRoot not a string", (t) => writeRawPolicyFile(t, good({ companionPluginRoot: 5 })), "wrong_type"],
  ["companionPluginRoot not absolute", (t) => writeRawPolicyFile(t, good({ companionPluginRoot: "relative/plugin" })), "bad_path"],
  ["companionPluginRoot empty", (t) => writeRawPolicyFile(t, good({ companionPluginRoot: "" })), "bad_path"],
  ["reaperExtraRoots not an array", (t) => writeRawPolicyFile(t, good({ reaperExtraRoots: "x" })), "wrong_type"],
  ["reaperExtraRoots entry not a string", (t) => writeRawPolicyFile(t, good({ reaperExtraRoots: [1] })), "wrong_type"],
  ["reaperExtraRoots entry not absolute", (t) => writeRawPolicyFile(t, good({ reaperExtraRoots: ["relative/dir"] })), "bad_path"],
  ["reaperExtraRoots entry empty", (t) => writeRawPolicyFile(t, good({ reaperExtraRoots: [""] })), "bad_path"],
  ["a VALID companionPluginRoot beside an invalid project (whole file rejected)", (t) => writeRawPolicyFile(t,
    good({ companionPluginRoot: fx.base, reaperExtraRoots: [fx.base], projects: [row({ name: "Bad Name" })] })), "bad_value"],
  ["duplicate dir, case-insensitively", (t) => writeRawPolicyFile(t, good({ projects: [row({ dir: "Same", name: "a" }), row({ dir: "sAME", name: "b" })] })), "duplicate_dir"],
  ["duplicate dir, non-ASCII case (Windows folds it)", (t) => writeRawPolicyFile(t, good({ projects: [row({ dir: "\u00e9t\u00e9", name: "a" }), row({ dir: "\u00c9T\u00c9", name: "b" })] })), "duplicate_dir"],
  ...[
    ["trailing dot", "proj."], ["trailing space", "proj "], ["only dots", "..."], ["device name", "CON"],
    ["device name with extension", "nul.txt"], ["device name, mixed case", "Com1"], ["printer device", "lpt9"],
    ["colon (alternate data stream)", "a:b"], ["wildcard", "a*b"], ["question mark", "a?b"], ["angle bracket", "a<b"],
    ["double quote", "a\"b"], ["pipe", "a|b"], ["control character", "a\u0001b"], ["8.3 short-name shape", "PROJEC~1"],
    ["decomposed (non-NFC) accent", "e\u0301t\u00e9"],
  ].map(([what, dir]) => [`dir that is Windows-ambiguous: ${what}`, (t) => writeRawPolicyFile(t, good({ projects: [row({ dir })] })), "bad_value"]),
  ...[
    ["a dot segment", (b) => b + SEP + "." + SEP + "x"], ["a dot-dot segment", (b) => b + SEP + ".." + SEP + "x"],
    ["a trailing separator", (b) => b + SEP], ["a doubled separator", (b) => b + SEP + SEP + "x"],
  ].map(([what, f]) => [`projectsBase with ${what}`, (t) => writeRawPolicyFile(t, good({ projectsBase: f(fx.base) })), "bad_projects_base"]),
  ...[
    ["a dot-dot segment", (b) => b + SEP + ".." + SEP + "x"], ["a trailing separator", (b) => b + SEP],
  ].flatMap(([what, f]) => [
    [`companionPluginRoot with ${what}`, (t) => writeRawPolicyFile(t, good({ companionPluginRoot: f(fx.base) })), "bad_path"],
    [`reaperExtraRoots entry with ${what}`, (t) => writeRawPolicyFile(t, good({ reaperExtraRoots: [f(fx.base)] })), "bad_path"],
  ]),
  ...(process.platform !== "win32" ? [] : [
    ["the \\?\ prefix", (b) => BS + BS + "?" + BS + b], ["the \\.\ prefix", (b) => BS + BS + "." + BS + b],
    ["forward slashes", (b) => b.split(BS).join("/")], ["no drive letter", (b) => b.slice(2)], ["a drive-relative form", (b) => b.slice(0, 2) + "x"],
    ["a trailing-dot segment", (b) => b + BS + "x."], ["a trailing-space segment", (b) => b + BS + "x "],
  ].flatMap(([what, f]) => [
    [`projectsBase with ${what}`, (t) => writeRawPolicyFile(t, good({ projectsBase: f(fx.base) })), "bad_projects_base"],
    [`companionPluginRoot with ${what}`, (t) => writeRawPolicyFile(t, good({ companionPluginRoot: f(fx.base) })), "bad_path"],
    [`reaperExtraRoots entry with ${what}`, (t) => writeRawPolicyFile(t, good({ reaperExtraRoots: [f(fx.base)] })), "bad_path"],
  ])),
  ["gateAllowlist naming a project that is not in the table", (t) => writeRawPolicyFile(t, good({ gateAllowlist: ["one", "two"] })), "gate_name_not_a_project"],
];

for (const [label, make, reason] of FAILURES) {
  test(`loadPolicyConfig fails safe (empty table) on: ${label}`, (t) => {
    const c = loadPolicyConfig(make(t));
    assert.equal(c.ok, false);
    assert.equal(c.reason, reason);
    assert.deepEqual(c.table, []);
    assert.deepEqual(c.gateAllowlist, []);
    assert.equal(c.projectsBase, "");
    assert.equal(c.companionPluginRoot, "", "a rejected file yields no companion plugin root");
    assert.deepEqual(c.reaperExtraRoots, [], "a rejected file yields no extra reaper roots");
  });
}

test("loadPolicyConfig refuses an oversized file", (t) => {
  const f = writeRawPolicyFile(t, "x".repeat(2 * 1024 * 1024));
  assert.equal(loadPolicyConfig(f).reason, "file_too_large");
});

// ---------------------------------------------------------------- gateAllowlist

test("gateAllowlist is optional and validated: names only, unique, never the reserved name", (t) => {
  const ok = loadPolicyConfig(writeRawPolicyFile(t, good({ gateAllowlist: ["one"] })));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.gateAllowlist, ["one"]);
  assert.equal(loadPolicyConfig(writeRawPolicyFile(t, good({ gateAllowlist: "one" }))).reason, "wrong_type");
  assert.equal(loadPolicyConfig(writeRawPolicyFile(t, good({ gateAllowlist: [3] }))).reason, "wrong_type");
  assert.equal(loadPolicyConfig(writeRawPolicyFile(t, good({ gateAllowlist: ["my-name"] }))).reason, "bad_value");
  assert.equal(loadPolicyConfig(writeRawPolicyFile(t, good({ gateAllowlist: ["unknown"] }))).reason, "bad_value");
  assert.equal(loadPolicyConfig(writeRawPolicyFile(t, good({ gateAllowlist: ["one", "one"] }))).reason, "duplicate_name");
  assert.equal(loadPolicyConfig(writeRawPolicyFile(t, good({ gateAllowlist: ["two"] }))).reason, "gate_name_not_a_project");
});

test("a dir that NFC-normalizes to another name (KELVIN SIGN normalizes to K) is refused, not merged", (t) => {
  const c = loadPolicyConfig(writeRawPolicyFile(t, good({ projects: [row({ dir: "\u212aappa", name: "b" })] })));
  assert.equal(c.reason, "bad_value");
});

test("isCanonicalAbsolutePath (Windows rules): drive paths, drive roots and UNC shares with or without the trailing separator", () => {
  const B = String.fromCharCode(92);
  const W = (...p) => p.join(B);
  for (const ok of [W("C:", "a", "b"), "C:" + B, W("c:", "x"), W("", "", "srv", "share"), W("", "", "srv", "share", ""), W("", "", "srv", "share", "x"), W("C:", "PROGRA~1")]) {
    assert.equal(isCanonicalAbsolutePath(ok, "win32"), true, JSON.stringify(ok));
  }
  for (const bad of [W("C:", "a", ""), W("C:", "a", ".", "b"), W("C:", "a.", "b"), "C:a", W("", "a"), W("", "", "?", "C:", "a"), W("", "", ".", "C:", "a"), "C:/a", W("", "", "srv")]) {
    assert.equal(isCanonicalAbsolutePath(bad, "win32"), false, JSON.stringify(bad));
  }
});

test("ordinary names with dots, spaces, tildes and non-ASCII letters are still accepted", (t) => {
  for (const dir of ["my.project", "Project Delta", "a~b", "v1.2 notes", "caf\u00e9", "\u65e5\u672c", "con-tracts", "nullable"]) {
    const c = loadPolicyConfig(writeRawPolicyFile(t, good({ projects: [row({ dir })] })));
    assert.equal(c.ok, true, `${JSON.stringify(dir)}: ${c.reason}`);
  }
});

// ---------------------------------------------------------------- companionPluginRoot / reaperExtraRoots

test("companionPluginRoot and reaperExtraRoots are optional (defaults: empty string, empty array)", () => {
  const c = loadPolicyConfig(fx.file);
  assert.equal(c.companionPluginRoot, "");
  assert.deepEqual(c.reaperExtraRoots, []);
});

test("a valid companionPluginRoot and reaperExtraRoots are returned as written", (t) => {
  const other = path.join(fx.base, "elsewhere");
  const c = loadPolicyConfig(writeRawPolicyFile(t, good({ companionPluginRoot: fx.base, reaperExtraRoots: [other, fx.base] })));
  assert.equal(c.ok, true);
  assert.equal(c.companionPluginRoot, fx.base);
  assert.deepEqual(c.reaperExtraRoots, [other, fx.base]);
});

// ---------------------------------------------------------------- file location

test("policyFilePath: the env var wins, else the home-folder default", () => {
  assert.equal(policyFilePath({ CODEX_MCP_POLICY_FILE: "/some/file.json" }), "/some/file.json");
  assert.equal(policyFilePath({}), path.join(os.homedir(), ".codex-mcp", "project-policy.json"));
  assert.equal(policyFilePath({ CODEX_MCP_POLICY_FILE: "" }), path.join(os.homedir(), ".codex-mcp", "project-policy.json"));
});

// ---------------------------------------------------------------- lazy load, cache, stderr

// Runs fn with process.stderr.write captured; returns the captured text.
function captureStderr(fn) {
  const real = process.stderr.write.bind(process.stderr);
  let text = "";
  process.stderr.write = (chunk) => { text += String(chunk); return true; };
  try { fn(); } finally { process.stderr.write = real; }
  return text;
}

function withEnvFile(file, fn) {
  const prev = process.env.CODEX_MCP_POLICY_FILE;
  process.env.CODEX_MCP_POLICY_FILE = file;
  _resetPolicyCacheForTests();
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CODEX_MCP_POLICY_FILE; else process.env.CODEX_MCP_POLICY_FILE = prev;
    _resetPolicyCacheForTests();
  }
}

test("a failed load makes every folder unknown and prints ONE stderr line per process, with the reason and no file contents", (t) => {
  const sentinel = "SENTINEL-FILE-CONTENT";
  const f = writeRawPolicyFile(t, `{ "${sentinel}": `);
  const err = captureStderr(() => withEnvFile(f, () => {
    assert.equal(resolvePolicy(at(BETA)).name, "unknown");
    assert.equal(resolvePolicy(at(ALPHA)).name, "unknown");
    assert.equal(resolvePolicy(null).name, "unknown");
  }));
  const lines = err.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one stderr line, got: ${JSON.stringify(err)}`);
  assert.match(lines[0], /bad_json/);
  assert.ok(!err.includes(sentinel), "the file contents must never reach stderr");
});

test("a missing file also fails safe with one stderr line", (t) => {
  const f = path.join(tempDirFor(t, "policy-missing-", { realpath: true }), "nope.json");
  const err = captureStderr(() => withEnvFile(f, () => {
    assert.equal(resolvePolicy(at(BETA)).name, "unknown");
    assert.equal(resolvePolicy(at(BETA)).name, "unknown");
  }));
  assert.equal(err.split("\n").filter(Boolean).length, 1);
  assert.match(err, /file_missing/);
});

test("a good file prints nothing to stderr", () => {
  const err = captureStderr(() => withEnvFile(fx.file, () => {
    assert.equal(resolvePolicy(at(BETA)).name, "project_beta");
  }));
  assert.equal(err, "");
});

test("the load is lazy and cached: edits to the file are not seen until the cache is reset", (t) => {
  const f = writeRawPolicyFile(t, good({ projects: [{ dir: "late", name: "late_one", write: true, git: true, pii: false }] }));
  withEnvFile(f, () => {
    const cwd = path.join(fx.base, "late");
    assert.equal(resolvePolicy(cwd).name, "late_one");
    fs.writeFileSync(f, good({ projects: [] }));
    assert.equal(resolvePolicy(cwd).name, "late_one", "cached for the life of the process");
    _resetPolicyCacheForTests();
    assert.equal(resolvePolicy(cwd).name, "unknown", "re-read after a reset");
  });
});

test("nothing is read at import time (setting the env var after import still takes effect)", (t) => {
  const f = writeRawPolicyFile(t, good({ projects: [{ dir: "later", name: "later_one", write: false, git: false, pii: false }] }));
  withEnvFile(f, () => {
    assert.equal(resolvePolicy(path.join(fx.base, "later", "x")).name, "later_one");
  });
});

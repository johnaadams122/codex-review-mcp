// tests/helpers/policy-fixture.mjs -- a synthetic project-policy settings file for tests.
//
// policy.mjs reads its project table from a settings file (env CODEX_MCP_POLICY_FILE, else a file in the
// user's home folder). A test that depends on a policy outcome calls installPolicyFixture(t) first: it
// writes a synthetic settings file into a temp folder, points CODEX_MCP_POLICY_FILE at it, resets the
// policy cache, and registers the undo with the test's cleanup hook. Every name below is synthetic.
//
// `projectsBase` is a real temp folder, so a test can also create real sub-folders under dirOf(name).
// Pass `{ projectsBase }` to make the base a folder the test already owns (for example the folder that
// holds a temp git repo), or `projectsBase: false` to leave it out of the table's reach.
//
// For a folder shared by a whole file, call it at MODULE TOP LEVEL with `{ after }` from node:test
// (see tempDirFor in test-cleanup.mjs).
import fs from "node:fs";
import path from "node:path";
import { onCleanup, tempDirFor } from "./test-cleanup.mjs";
import { _resetPolicyCacheForTests } from "../../policy.mjs";

export const POLICY_SCHEMA = "codex-mcp-project-policy-v1";

// pii + write + git, review defaults to !pii (blocked)
export const ALPHA = { dir: "project-alpha", name: "project_alpha", write: true, git: true, pii: true };
// plain non-pii git project
export const BETA = { dir: "project-beta", name: "project_beta", write: true, git: true, pii: false };
// write-blocked, no git, non-pii
export const GAMMA = { dir: "project-gamma", name: "project_gamma", write: false, git: false, pii: false };
// pii but review explicitly allowed; mixed-case dir with a space (the table match is case-insensitive)
export const DELTA = { dir: "Project Delta", name: "project_delta", write: true, git: false, pii: true, review: true };
// pii, write-blocked, review-blocked by default
export const EPSILON = { dir: "project-epsilon", name: "project_epsilon", write: false, git: false, pii: true };

export const DEFAULT_PROJECTS = [ALPHA, BETA, GAMMA, DELTA, EPSILON];

export function installPolicyFixture(t, { projects = DEFAULT_PROJECTS, gateAllowlist, projectsBase, companionPluginRoot, reaperExtraRoots } = {}) {
  const base = projectsBase === undefined || projectsBase === false || projectsBase === null
    ? tempDirFor(t, "policy-base-", { realpath: true })
    : projectsBase;
  const fileDir = tempDirFor(t, "policy-file-", { realpath: true });
  const file = path.join(fileDir, "project-policy.json");
  const config = { schema: POLICY_SCHEMA, projectsBase: base, projects };
  if (gateAllowlist !== undefined) config.gateAllowlist = gateAllowlist;
  if (companionPluginRoot !== undefined) config.companionPluginRoot = companionPluginRoot;
  if (reaperExtraRoots !== undefined) config.reaperExtraRoots = reaperExtraRoots;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const previous = process.env.CODEX_MCP_POLICY_FILE;
  process.env.CODEX_MCP_POLICY_FILE = file;
  _resetPolicyCacheForTests();
  onCleanup(t, () => {
    if (previous === undefined) delete process.env.CODEX_MCP_POLICY_FILE;
    else process.env.CODEX_MCP_POLICY_FILE = previous;
    _resetPolicyCacheForTests();
  });
  return {
    base,
    file,
    config,
    // absolute folder of a project row, optionally with sub-folders
    dirOf: (row, ...sub) => path.join(base, row.dir, ...sub),
  };
}

// Writes arbitrary text as a settings file in a temp folder and returns its path (for failure cases).
export function writeRawPolicyFile(t, text) {
  const dir = tempDirFor(t, "policy-raw-", { realpath: true });
  const file = path.join(dir, "project-policy.json");
  fs.writeFileSync(file, text);
  return file;
}

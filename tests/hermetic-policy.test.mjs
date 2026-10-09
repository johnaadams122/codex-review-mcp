import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import "./helpers/hermetic-policy.mjs";
import { loadPolicyConfig, policyFilePath, cachedPolicyConfig, resolvePolicy } from "../policy.mjs";

// A test file that imports the hermetic guard never reads the real settings file in the user's home folder.

test("the guard points CODEX_MCP_POLICY_FILE at a private, valid, empty-table settings file", () => {
  const f = policyFilePath(process.env);
  assert.ok(process.env.CODEX_MCP_POLICY_FILE, "the env var is set");
  assert.ok(!f.startsWith(path.join(os.homedir(), ".codex-mcp")), "not the home-folder default");
  const c = loadPolicyConfig(f);
  assert.equal(c.ok, true);
  assert.deepEqual(c.table, []);
  assert.deepEqual(c.gateAllowlist, []);
  assert.equal(c.companionPluginRoot, "");
  assert.deepEqual(c.reaperExtraRoots, []);
});

test("using the cached config prints nothing to stderr under the guard", () => {
  const real = process.stderr.write.bind(process.stderr);
  let seen = "";
  process.stderr.write = (c) => { seen += String(c); return true; };
  try {
    assert.equal(cachedPolicyConfig().ok, true);
    assert.equal(resolvePolicy(path.join(path.parse(process.cwd()).root, "anywhere")).name, "unknown");
  } finally { process.stderr.write = real; }
  assert.equal(seen, "");
});

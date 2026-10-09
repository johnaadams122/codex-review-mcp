#!/usr/bin/env node
// tools/check-policy-isolation.mjs -- prove no test reads the real project-policy settings file.
//
//   node tools/check-policy-isolation.mjs                          (every tests/*.test.mjs file)
//   node tools/check-policy-isolation.mjs tests/jobs.test.mjs ...   (just these files)
//   node tools/check-policy-isolation.mjs --good-file ...           (see below)
//
// policy.mjs reads <home>/.codex-mcp/project-policy.json when CODEX_MCP_POLICY_FILE is unset. This tool
// runs the tests with the home folder (HOME and USERPROFILE) pointed at a private scratch folder whose
// settings file is deliberately INVALID. Any test that reaches the home-folder file makes policy.mjs print
// its one fail-safe reason line, which this tool detects; a test that never reads it prints nothing.
// With --good-file the scratch file is instead VALID but wrong (registers no project, allowlists nothing,
// names a bogus companion plugin folder): the suite must then simply stay green.
//
// Exit 0 = tests passed and no test read the file; 1 = at least one test file read it (named, found by
// re-running the files one at a time); 2 = the tests failed or timed out. Tests that install a policy
// fixture, or import tests/helpers/hermetic-policy.mjs, never read the home file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const goodFile = args.includes("--good-file");
let files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  files = fs.readdirSync(path.join(REPO, "tests")).filter((n) => n.endsWith(".test.mjs")).sort().map((n) => path.join("tests", n));
}

const MARKER = "project policy file not loaded";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-test-polhome-"));
fs.mkdirSync(path.join(home, ".codex-mcp"));
const bogus = path.join(home, "no-such-plugin-folder");
const content = goodFile
  ? JSON.stringify({ schema: "codex-mcp-project-policy-v1", projectsBase: home, projects: [], gateAllowlist: [], companionPluginRoot: bogus, reaperExtraRoots: [bogus] })
  : "{ this is not json";
fs.writeFileSync(path.join(home, ".codex-mcp", "project-policy.json"), content);

const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.CODEX_MCP_POLICY_FILE;
delete env.CLAUDE_PLUGIN_ROOT;
delete env.NODE_TEST_CONTEXT;
const runFiles = (list) => spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", ...list],
  { cwd: REPO, env, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 });
const text = (r) => String(r.stdout ?? "") + String(r.stderr ?? "");

try {
  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(require(\"os\").homedir())"], { env, encoding: "utf8" });
  if (probe.stdout !== home) { console.error(`os.homedir() did not follow HOME/USERPROFILE (got a different folder); cannot prove isolation here`); process.exit(2); }
  const whole = runFiles(files);
  const failed = whole.status !== 0 || (whole.error && whole.error.code === "ETIMEDOUT");
  const touched = text(whole).includes(MARKER);
  console.log(`files: ${files.length}  home file: ${goodFile ? "valid but wrong" : "invalid (any read is detected)"}  test exit status: ${whole.status}`);
  const summary = String(whole.stdout ?? "").split(/\r?\n/).filter((l) => /^\S+ (tests|pass|fail|cancelled|skipped) \d+$/.test(l));
  for (const l of summary) console.log("  " + l.slice(2));
  let readers = [];
  if (!goodFile && touched) {
    for (const f of files) if (text(runFiles([f])).includes(MARKER)) readers.push(f);
  }
  if (!goodFile) {
    console.log(`test files that read the home settings file: ${readers.length}`);
    for (const f of readers) console.log("  " + f);
  }
  process.exitCode = failed ? 2 : touched ? 1 : 0;
} finally {
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => console.log(`could not remove ${home}; remove it by hand`));
}

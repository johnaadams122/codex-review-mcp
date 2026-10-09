#!/usr/bin/env node
// tools/check-test-temp-leaks.mjs -- run test files with the OS temp folder pointed at a private,
// empty folder, then report whatever the run left behind there.
//
//   node tools/check-test-temp-leaks.mjs                         (every tests/*.mjs file)
//   node tools/check-test-temp-leaks.mjs tests/direct.submit.test.mjs tests/gate-surface.test.mjs
//   node tools/check-test-temp-leaks.mjs --keep ...               (leave the private folder for a look)
//   node tools/check-test-temp-leaks.mjs --timeout-ms=600000 ...  (default 1200000; the run is killed after it)
//
// Exit 0 = the tests passed AND nothing was left; 1 = something was left (or the private folder could
// not be removed); 2 = the tests failed or timed out (leftovers are still listed). Windows os.tmpdir()
// reads TEMP then TMP, so both are redirected for the runner and every process it starts. It looks at
// the TOP level of the private folder, plus new e2e- folders under the repo's .superpowers (the one
// test that works under the repo). Every entry counts, including a folder production code writes into:
// tests point those at private folders (CODEX_REVIEW_LOG_DIR, CODEX_DIRECT_ROOT), so one found here is
// a test writing into the live server's folder. Toward the real %TEMP% it only creates and removes its
// own private folder, which is named codex-mcp-test-leakcheck-XXXXXX so an operator cleanup script (not part of this repository)
// can find one it failed to remove.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const timeoutArg = args.find((a) => a.startsWith("--timeout-ms="));
const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout-ms=".length)) : 1_200_000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { console.error(`bad ${timeoutArg}`); process.exit(2); }
let files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  files = fs.readdirSync(path.join(REPO, "tests")).filter((n) => n.endsWith(".mjs")).sort().map((n) => path.join("tests", n));
}

const SUPERPOWERS = path.join(REPO, ".superpowers");
const repoLocal = () => (fs.existsSync(SUPERPOWERS) ? fs.readdirSync(SUPERPOWERS).filter((n) => /^e2e-[A-Za-z0-9]{6}$/.test(n)) : []);
const repoLocalBefore = new Set(repoLocal());

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-test-leakcheck-"));
const env = { ...process.env, TEMP: root, TMP: root };
delete env.NODE_TEST_CONTEXT;
const run = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-reporter=spec", ...files],
  { cwd: REPO, env, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
const timedOut = Boolean(run.error && run.error.code === "ETIMEDOUT");
const out = String(run.stdout ?? "").split(/\r?\n/);
const INFO = String.fromCodePoint(0x2139);    // the spec reporter's summary marker
const CROSS = String.fromCodePoint(0x2716);   // the spec reporter's failure marker
const summary = out.filter((l) => l.startsWith(INFO + " ") && /^\S+ (tests|pass|fail|cancelled) \d+$/.test(l));

const left = fs.readdirSync(root).sort();
const repoLeft = repoLocal().filter((n) => !repoLocalBefore.has(n));
// Groups by the mkdtemp shape (a trailing six letters or digits), keeping the first real name so a
// plain folder name that merely ends that way (codex-mcp-reviews) still prints recognisably.
const groups = new Map();
for (const name of left) {
  const key = name.length > 6 && /[A-Za-z0-9]{6}$/.test(name) ? name.slice(0, -6) + "XXXXXX" : name;
  const g = groups.get(key) ?? { n: 0, first: name };
  g.n += 1;
  groups.set(key, g);
}
const note = timedOut ? ` (TIMED OUT after ${timeoutMs} ms; the run was killed)` : run.error ? ` (${run.error.message})` : "";
console.log(`files: ${files.length}  test exit status: ${run.status}${note}`);
for (const l of summary) console.log("  " + l.slice(2));
if (run.status !== 0) {
  for (const l of out.filter((x) => x.trimStart().startsWith(CROSS)).slice(0, 20)) console.log("  FAILED " + l.trim().slice(2));
}
console.log(`left in the private temp folder: ${left.length} top-level entr${left.length === 1 ? "y" : "ies"}`);
for (const [k, { n, first }] of [...groups].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
  console.log(`  ${String(n).padStart(4)}  ${k}${first === k ? "" : `  (e.g. ${first})`}`);
}
console.log(`new e2e- folders left under ${SUPERPOWERS}: ${repoLeft.length}${repoLeft.length ? " (" + repoLeft.join(", ") + ")" : ""}`);
let removeFailed = false;
if (keep) console.log(`kept: ${root}`);
else {
  try { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (e) { removeFailed = true; console.log(`could not remove the private folder ${root} (${e.code ?? e.message}); remove it by hand`); }
}
process.exitCode = run.status !== 0 || timedOut ? 2 : left.length > 0 || repoLeft.length > 0 || removeFailed ? 1 : 0;

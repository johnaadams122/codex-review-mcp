// direct-preflight.mjs -- check the direct-exec (sol/max) preconditions from a fresh
// process, printing WHY each requirement passes or fails. A local DNS resolver that fails to
// resolve a public hostname would fail the network-denial connectivity control (which PII
// cwds require) and show up only as an opaque direct_preconditions_unmet; the
// connectivity-control target is therefore a raw IP (1.1.1.1), which removes DNS from the check
// entirely -- see checkConnectivity in direct.mjs. Run this tool whenever a sol/max gate blocks with
// direct_preconditions_unmet:
//
//   node tools/direct-preflight.mjs           # full probe (one luna/low codex exec, ~30-60s)
//   node tools/direct-preflight.mjs --quick   # runtime/identity/connectivity only, no probe
//
// Read-only with respect to the repo; probe artifacts live in a temp dir and are deleted.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { randomUUID } from "node:crypto";
import {
  resolveDirectRuntime, statBinaryIdentity, buildDirectArgs, spawnSpecFor,
  buildChildEnv, PROBE_PROMPT, judgeWrite, judgeNetwork, VALIDATED_VERSIONS,
} from "../direct.mjs";

const quick = process.argv.includes("--quick");
let failures = 0;
const report = (label, ok, detail) => {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
};

// 1. runtime resolution (binary on PATH / CODEX_BIN, version parse, roots)
const rt = resolveDirectRuntime();
if (rt.error) {
  report("runtime resolution", false, rt.error);
  console.log("\nA cached runtime error blocks every direct admission for the life of the");
  console.log("process that hit it (direct.mjs resolveDirectRuntime caches the failure).");
  process.exit(1);
}
report("runtime resolution", true, `${rt.codexBin} (v${rt.codexVersion})`);

// 2. binary identity (stat + sha256 + version re-parse)
const id = statBinaryIdentity();
if (!id) { report("binary identity stat", false, "statBinaryIdentity returned null"); process.exit(1); }
report("binary identity stat", true, `v${id.version}, ${id.size} bytes, digest ${id.digest.slice(0, 12)}...`);

// 3. version gate
const manifest = VALIDATED_VERSIONS[id.version];
report("version validated", Boolean(manifest),
  Boolean(manifest) ? id.version : `${id.version} is not in VALIDATED_VERSIONS -- direct path blocked until a human adds it + its network manifest`);

// 4. connectivity control, with the underlying error surfaced (checkConnectivity itself
// swallows it). Target is a raw IP (1.1.1.1) specifically so this check
// does not depend on DNS at all -- a hostname target fails whenever the local
// resolver filters it, which judgeNetwork then reported as no_connectivity_control, blocking
// every PII direct admission.
const conn = await new Promise((resolve) => {
  const t0 = Date.now();
  const req = https.get("https://1.1.1.1", { timeout: 5000 }, (res) => {
    res.resume();
    resolve({ ok: typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 500,
      detail: `HTTP ${res.statusCode} in ${Date.now() - t0} ms` });
  });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false, detail: "timeout after 5000 ms" }); });
  req.on("error", (e) => resolve({ ok: false, detail: `${e.code ?? "error"}: ${e.message} (${Date.now() - t0} ms)` }));
});
report("connectivity control (https://1.1.1.1 from THIS process)", conn.ok, conn.detail);
if (!conn.ok) {
  console.log("       -> network-denial cannot verify; PII cwds (the pii rows of the project policy file)");
  console.log("          will block direct_preconditions_unmet. Non-PII direct runs are unaffected.");
  console.log("       -> a raw IP target should never fail on DNS -- if ENOTFOUND/ETIMEDOUT here,");
  console.log("          suspect a genuine outbound network problem, not a resolver filter.");
}

if (quick) {
  console.log(failures ? `\n${failures} check(s) failed` : "\nquick checks OK (probe not run; use the full mode to verify judgments)");
  process.exit(failures ? 1 : 0);
}

// Version gate FIRST, exactly like production revalidatePreconditions: an unvalidated version
// has no frozen network-disable manifest, and buildDirectArgs would spawn WITHOUT it -- never
// launch that probe (the production path returns before any spawn, and so does this tool).
if (!manifest) {
  console.log("\nprobe NOT run: version gate failed (no pinned network manifest for this version)");
  process.exit(1);
}

// 5. the real probe under the pinned argv, judged exactly as admission judges it
const dir = path.join(os.tmpdir(), `direct-preflight-${randomUUID()}`);
fs.mkdirSync(dir, { recursive: true });
try {
  fs.writeFileSync(path.join(dir, "probe-existing.txt"), "ORIGINAL", "utf8");
  const answerFile = path.join(dir, "probe-answer.txt");
  const args = buildDirectArgs({ model: "gpt-6-luna", effort: "low", cwd_real: dir, answerFile, version: id.version });
  const spec = spawnSpecFor(rt.codexBin, args);
  const t1 = Date.now();
  const events = await new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, {
      env: buildChildEnv(rt.codexHome, process.env), stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    const guard = setTimeout(() => { try { child.kill(); } catch { /* best-effort */ } }, 180000);
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(guard);
      const evs = [];
      for (const ln of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) {
        if (!ln.trim()) continue;
        try { evs.push(JSON.parse(ln)); } catch { /* judgments re-check shape */ }
      }
      resolve(evs);
    });
    child.stdin.on("error", () => {});
    child.stdin.write(PROBE_PROMPT);
    child.stdin.end();
  });
  console.log(`      (probe ran in ${Date.now() - t1} ms, ${events.length} events)`);
  const oracle = {
    probeWriteAbsent: !fs.existsSync(path.join(dir, "probe-write.txt")),
    probeExistingIntact: fs.existsSync(path.join(dir, "probe-existing.txt"))
      && fs.readFileSync(path.join(dir, "probe-existing.txt"), "utf8").trim() === "ORIGINAL",
  };
  const w = judgeWrite(events, oracle);
  const n = judgeNetwork(events, { connectivityOk: conn.ok, manifestPinned: Array.isArray(manifest?.networkDisableArgs) });
  report("write-denial judgment (gates ALL direct runs)", w.pass === true, w.pass === true ? `class=${w.class}` : w.why);
  report("network-denial judgment (additionally gates PII cwds)", n.pass === true, n.pass === true ? `class=${n.class}` : n.why);
  console.log("");
  console.log(`non-PII direct admission: ${w.pass === true ? "would PASS" : `would FAIL (${w.why})`}`);
  console.log(`PII direct admission:     ${w.pass === true && n.pass === true ? "would PASS" : `would FAIL (${w.pass !== true ? w.why : n.why})`}`);
  console.log("\nNOTE: a long-lived MCP server keeps a passing result until the Codex binary changes and");
  console.log("re-probes on the next admission after a failed one (retry-on-demand), so a fixed");
  console.log("environment heals it WITHOUT a restart -- but a server that cached a runtime");
  console.log("resolution ERROR (check 1) needs a respawn.");
  // exitCode, NOT process.exit(): exit() would skip the finally cleanup below.
  process.exitCode = (w.pass === true && n.pass === true && !failures) ? 0 : 1;
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

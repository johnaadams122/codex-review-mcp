// direct.mjs -- direct-exec transport. Talks to the codex CLI directly
// (`codex exec`, one-shot) for max-strength reviews only. Fail-CLOSED throughout: any
// ambiguity -> no dispatch / no pass. ASCII-only. Companion path untouched.

import { spawn as _spawn, spawnSync as _spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isPidAlive as _isPidAlive, buildTreeKillArgs } from "./jobs.mjs";

// ---------------- pinned constants ----------------

// Write-denial signature: two denial classes. (1) OS-sandbox denial, modelled on the
// recorded-shape probe fixture (tests/fixtures/direct/probe-events.jsonl): the
// command EXECUTED and Windows denied the filesystem write. (2) codex's policy layer,
// modelled on a second recorded-shape probe fixture
// (tests/fixtures/direct/probe-events-policyreject.jsonl): the command is REJECTED
// pre-execution ("blocked by policy", exit_code -1, command never ran). BOTH phrases only ever
// accompany a denied write; judgeWrite additionally requires the fs oracle (probe-write.txt
// absent, probe-existing.txt intact), so neither phrase alone can pass a run that actually wrote.
export const OS_DENIAL_SIGNATURE = /PermissionDenied|UnauthorizedAccessException/;
export const POLICY_DENIAL_SIGNATURE = /blocked by policy/;
export const WRITE_DENIAL_SIGNATURE = /PermissionDenied|UnauthorizedAccessException|blocked by policy/;

// Denial evidence class: a policy-layer refusal keeps
// a probe fail-closed but is NOT evidence the OS sandbox boundary was exercised -- the two
// classes are reported separately and no flag may claim "os" without os-class evidence on
// EVERY required denial event. "os" = the command executed and the OS denied it; "policy" =
// codex refused pre-execution (command never ran). OS is tested first: an output carrying both
// phrases proves the command DID reach the OS.
export function denialClassOf(output) {
  const s = String(output ?? "");
  if (OS_DENIAL_SIGNATURE.test(s)) return "os";
  if (POLICY_DENIAL_SIGNATURE.test(s)) return "policy";
  return null;
}

// Bootstrap artifacts: the network signature was null until the network-denial capture pinned it.
// While null the network judgment FAILED CLOSED -- networkDenialVerified could never become
// true, so PII direct runs stayed blocked. NEVER default these at runtime.
export const SIGNATURES = {
  write: WRITE_DENIAL_SIGNATURE,
  // Modelled on tests/fixtures/direct/probe-network-denial.txt (a recorded-shape fixture; its
  // .args.json sidecar records the manifest the fixture corresponds to). The denial text is
  // POLICY-class ("rejected: blocked by policy", exit_code -1): codex 0.144.1's policy layer
  // fronts the sandbox for shell fetches, so an OS/network-level denial text was not observable.
  // If a future run executes the fetch and the network layer denies it, this signature will
  // mismatch and the network judgment fails closed until it is updated -- intended.
  // codex 0.160.1 re-validation: the 0.160.1 capture (elevated sandbox) executes the fetch and the
  // network layer denies it ("Unable to connect to the remote server" -- OS/network-class, stronger than the
  // 0.144.1 policy-class rejection), so the pin accepts BOTH shapes. Still safe: judgeNetwork requires a
  // nonzero exit AND the connectivity control (the server reached the same host moments before).
  network: /rejected: blocked by policy|Unable to connect to the remote server/,
};

// Network-feature manifest for codex-cli 0.144.1, authored by hand from the 0.144.1
// reference only (no docs/config.md ships with the npm install): `codex --help`,
// `codex exec --help`, `codex features list` (live introspection of every feature's stage +
// effective default), and the live codex config keys.
// Each pair disables one network-capable feature found in the 0.144.1 feature-flag reference;
// tokens for "removed"-stage features are deliberately EXCLUDED (risk of the CLI rejecting an
// override key for a flag that no longer exists). FROZEN: any edit
// invalidates the provenance recorded beside tests/fixtures/direct/probe-network-denial.txt --
// re-derive SIGNATURES.network (the provenance pin test enforces this).
export const NETWORK_DISABLE_ARGS_0_144_1 = [
  // -- browser / computer control (real network reach via a real browser or CDP session) --
  "-c", "features.browser_use=false",
  "-c", "features.browser_use_external=false",
  "-c", "features.browser_use_full_cdp_access=false",
  "-c", "features.computer_use=false",
  "-c", "features.in_app_browser=false",
  // -- remote/network-named features (compaction, plugin fetch, MCP dependency install) --
  "-c", "features.remote_compaction_v2=false",
  "-c", "features.remote_plugin=false",
  "-c", "features.plugin_sharing=false",
  "-c", "features.plugins=false",
  "-c", "features.skill_mcp_dependency_install=false",
  "-c", "features.apps=false",
  // -- generation/API-fetch feature --
  "-c", "features.image_generation=false",
  // -- defense-in-depth: arbitrary-code / MCP-tool vectors not needed for a probe/review run --
  "-c", "features.hooks=false",
  "-c", "features.tool_call_mcp_elicitation=false",
  // -- already-false-by-default in 0.144.1; pinned explicitly so a future default flip within
  // THIS version string cannot silently re-enable them (belt-and-suspenders, non-removed stage
  // only) --
  "-c", "features.web_search_cached=false",
  "-c", "features.web_search_request=false",
  "-c", "features.standalone_web_search=false",
  "-c", "features.network_proxy=false",
  "-c", "features.respect_system_proxy=false",
];

// Manifest for codex-cli 0.160.1, authored by hand. Derivation: `codex features list` diffed between
// 0.144.1 and 0.160.1 (154 vs 92 flags). Carried over: every 0.144.1 token whose flag still
// exists in a non-removed stage. DROPPED: remote_compaction_v2 (stage now "removed"; a token for
// a removed flag risks the CLI rejecting the override). ADDED (new in 0.160.1 or newly
// default-on, and plausibly network-reaching): realtime_conversation (live voice/stream),
// daemon_auto_start, in_app_updates, in_app_chat, in_app_dictation, in_app_local_automation,
// system_proxy_fallback, skill_search.
export const NETWORK_DISABLE_ARGS_0_160_1 = [
  ...NETWORK_DISABLE_ARGS_0_144_1.flatMap((tok, i, a) =>
    // tokens come as ["-c", "key=value", ...] pairs; drop the pair whose value names the removed flag
    (i % 2 === 0 && a[i + 1] === "features.remote_compaction_v2=false") || tok === "features.remote_compaction_v2=false" ? [] : [tok]),
  "-c", "features.realtime_conversation=false",
  "-c", "features.daemon_auto_start=false",
  "-c", "features.in_app_updates=false",
  "-c", "features.in_app_chat=false",
  "-c", "features.in_app_dictation=false",
  "-c", "features.in_app_local_automation=false",
  "-c", "features.system_proxy_fallback=false",
  "-c", "features.skill_search=false",
];

// Exact-version validated set. Extending it REQUIRES a human to add the version AND
// its manually-authored network-feature manifest (argv tokens disabling every network-capable
// feature in that version's configuration reference). null manifest = not yet authored -> the
// network judgment fails closed (the write-only path may still verify).
export const VALIDATED_VERSIONS = {
  // NULL prototype: all three lookup sites (buildDirectArgs, manifestPinned, the version gate)
  // index this by a CLI-reported version string. A plain object literal inherits Object.prototype,
  // so an out-of-band binary reporting "constructor"/"toString"/"__proto__" as its version would
  // resolve a truthy inherited member and slip the version gate. Null-proto closes that at every
  // site with one change.
  __proto__: null,
  "0.144.1": { networkDisableArgs: NETWORK_DISABLE_ARGS_0_144_1 }, // reviewed manifest above
  // extraArgs: under --ignore-user-config
  // 0.160.1 loses the Windows sandbox mode that the user config supplies, and with no mode EVERY
  // shell command (reads included) is rejected "blocked by policy" -- a reviewer that cannot read
  // cannot verify claims. Verified live: with windows.sandbox="unelevated" reads work but a command can still DELETE an existing file; with "elevated" (sandbox users + ACLs + firewall rules set up once by an administrator) reads work and create/append/overwrite/DELETE are all denied. Elevated is required. With "unelevated" reads work
  // and a write is denied (exit 1, file not created). 0.144.1 needs no such argument.
  "0.160.1": { networkDisableArgs: NETWORK_DISABLE_ARGS_0_160_1, extraArgs: ["-c", 'windows.sandbox="elevated"'] },
};

// Read-fence argv: null until a passing candidate is pinned; null = prompt-level
// scope only (documented residual) and the argv omits it.
export const READ_FENCE = { args: null };

export const SUBMIT_DEADLINE_MS = 60000;
export const KILL_WAIT_MS = 10000;
export const STREAM_CLOSE_WAIT_MS = 2000;
export const POLL_TICK_MS = 3000;
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;
export const ANSWER_READ_CAP = 5 * 1024 * 1024;
export const RECEIPT_PARSE_CAP = 50 * 1024 * 1024;
export const REVALIDATION_CAP_MS = 180000;
export const ATTEST_RETRIES = 3;
export const ATTEST_RETRY_MS = 500;

// CODEX_DIRECT_LOG_CAP: default 50 MB, clamp [1 MB .. 1 GB].
export function parseLogCap(env = process.env) {
  const raw = parseInt(env.CODEX_DIRECT_LOG_CAP ?? "", 10);
  const v = Number.isFinite(raw) ? raw : 50 * 1024 * 1024;
  return Math.min(1024 * 1024 * 1024, Math.max(1024 * 1024, v));
}

// ---------------- executable + roots resolution (resolved ONCE) ----------------

// Deliberate test seam: a CODEX_BIN ending in .mjs/.js runs via the current node executable so
// integration tests can substitute a fake CLI without a .cmd shim (Windows spawn cannot exec
// scripts directly). Real deployments resolve to codex.exe / a PATH binary.
export function spawnSpecFor(bin, args) {
  return /\.(mjs|js)$/i.test(bin)
    ? { cmd: process.execPath, args: [bin, ...args] }
    : { cmd: bin, args };
}

// On Windows, spawn without a shell starts only a real executable: npm's extensionless sh shim and
// its .cmd wrapper (both put on PATH by an ordinary npm install) cannot be started that way, so only
// .exe/.com candidates count there. Elsewhere the bare name is tried first, as before.
function findOnPath(cmd, env = process.env, platform = process.platform) {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const winExts = exts.filter((e) => /^\.(exe|com)$/i.test(e));
  const candidates = platform === "win32" ? (winExts.length ? winExts : [".EXE", ".COM"]) : ["", ...exts];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of candidates) {
      const p = path.join(dir, cmd + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Version parse: first line of `<path> --version`, token after "codex-cli ".
export function parseCodexVersion(stdoutFirstLine) {
  const m = String(stdoutFirstLine ?? "").match(/codex-cli\s+(\S+)/);
  return m ? m[1] : null;
}

let _runtime = null;

// Resolved ONCE at first use: absolute realpath of the codex binary (CODEX_BIN if set, else
// first PATH hit -- spawn NEVER re-resolves "codex"), CODEX_HOME, sessionsRoot (the SAME
// resolved home is later passed to the child, so the root we search and the root the CLI writes
// agree by construction), and this instance's record dir. Failure -> { error } cached: every
// direct admission then fails direct_preconditions_unmet (no attestation root = no direct runs).
export function resolveDirectRuntime(deps = {}) {
  if (_runtime) return _runtime;
  const env = deps.env ?? process.env;
  const realpath = deps.realpath ?? fs.realpathSync;
  const spawnSyncFn = deps.spawnSync ?? _spawnSync;
  try {
    const rawBin = env.CODEX_BIN ?? findOnPath("codex", env);
    if (!rawBin) throw new Error("codex binary not found: CODEX_BIN is unset and PATH has no usable codex (on Windows only codex.exe or codex.com counts; set CODEX_BIN to the codex.exe an npm install ships in its vendor folder)");
    const codexBin = realpath(rawBin);
    const spec = spawnSpecFor(codexBin, ["--version"]);
    const r = spawnSyncFn(spec.cmd, spec.args, { encoding: "utf8", timeout: 15000 });
    const version = parseCodexVersion(String(r.stdout ?? "").split(/\r?\n/)[0]);
    if (!version) throw new Error("could not parse codex --version output");
    const codexHome = realpath(path.resolve(env.CODEX_HOME ?? path.join(os.homedir(), ".codex")));
    const sessionsRoot = path.join(codexHome, "sessions");
    const instanceId = `${process.pid}-${randomUUID()}`;
    // test-isolation seam; production never sets it
    const directRoot = env.CODEX_DIRECT_ROOT ?? path.join(os.tmpdir(), "codex-direct");
    const instanceDir = path.join(directRoot, instanceId);
    fs.mkdirSync(instanceDir, { recursive: true });
    // instance.json is best-effort: its loss degrades nothing but troubleshooting detail.
    try {
      fs.writeFileSync(path.join(instanceDir, "instance.json"), JSON.stringify({
        serverPid: process.pid, startedAt: new Date().toISOString(),
        sessionsRoot, codexVersion: version, codexBin,
      }), "utf8");
    } catch { /* best-effort */ }
    _runtime = { codexBin, codexVersion: version, codexHome, sessionsRoot, instanceId, instanceDir };
  } catch (e) {
    _runtime = { error: e.message };
  }
  return _runtime;
}

export function _resetDirectRuntime() {
  _runtime = null; _lastVersionStat = null;
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

// Fresh five-field identity: path fixed at resolution; size/mtime re-statted every call; digest
// (sha256 of the binary's bytes) recomputed on EVERY call; version re-parsed whenever size, mtime,
// OR digest changed since the last parse. Gating the version cache on the digest (not just
// size+mtime) closes a same-size/same-mtime swap to a DIFFERENT-version binary: otherwise the
// changed digest forces revalidation but a STALE allow-listed version rides the new binary through
// the version gate and dispatches with the wrong network-disable manifest.
// Returns null on any failure, incl. a read/hash throw (callers fail closed).
let _lastVersionStat = null; // { size, mtimeMs, digest, version }
export function statBinaryIdentity(deps = {}) {
  const rt = resolveDirectRuntime(deps);
  if (rt.error) return null;
  const statFn = deps.stat ?? fs.statSync;
  let st;
  try { st = statFn(rt.codexBin); } catch { return null; }
  // Byte digest FIRST, on EVERY call: the defense against a same-size/same-mtime binary swap, and
  // part of the version-cache key below. Any read/hash failure -> null (fail closed).
  const readBin = deps.readBin ?? fs.readFileSync;
  let digest;
  try { digest = createHash("sha256").update(readBin(rt.codexBin)).digest("hex"); } catch { return null; }
  let version;
  if (_lastVersionStat && _lastVersionStat.size === st.size && _lastVersionStat.mtimeMs === st.mtimeMs
      && _lastVersionStat.digest === digest) {
    version = _lastVersionStat.version;
  } else {
    const spawnSyncFn = deps.spawnSync ?? _spawnSync;
    const spec = spawnSpecFor(rt.codexBin, ["--version"]);
    let r;
    try { r = spawnSyncFn(spec.cmd, spec.args, { encoding: "utf8", timeout: 15000 }); } catch { return null; }
    version = parseCodexVersion(String(r.stdout ?? "").split(/\r?\n/)[0]);
    if (!version) return null;
    _lastVersionStat = { size: st.size, mtimeMs: st.mtimeMs, digest, version };
  }
  return { path: rt.codexBin, version, size: st.size, mtime: st.mtimeMs, digest };
}

export function identityEquals(a, b) {
  return Boolean(a && b && a.path === b.path && a.version === b.version
    && a.size === b.size && a.mtime === b.mtime && a.digest === b.digest);
}

// ---------------- 6c child environment (named allowlist; no wildcards) ----------------

const ENV_ALLOWLIST = [
  "SystemRoot", "windir", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
];

// Built, not inherited. Auth rides <CODEX_HOME>/auth.json (a file), so no
// OPENAI_*/CODEX_* env is needed or passed. Additions must be individual, by name, justified
// in a comment here.
export function buildChildEnv(codexHome, env = process.env) {
  const out = {};
  for (const k of ENV_ALLOWLIST) if (env[k] !== undefined) out[k] = env[k];
  out.CODEX_HOME = codexHome; // resolved home -- attestation root agreement
  return out;
}

// ---------------- pinned argv ----------------

export function buildDirectArgs({ model, effort, cwd_real, answerFile, version }) {
  const args = [
    "exec", "--sandbox", "read-only", "--ignore-user-config", "--json",
    "-o", answerFile, "--color", "never", "--skip-git-repo-check",
    "-C", cwd_real, "-m", model, "-c", `model_reasoning_effort=${effort}`,
  ];
  if (READ_FENCE.args) args.push(...READ_FENCE.args);
  const manifest = VALIDATED_VERSIONS[version];
  if (manifest && Array.isArray(manifest.extraArgs)) args.push(...manifest.extraArgs);
  if (manifest && Array.isArray(manifest.networkDisableArgs)) args.push(...manifest.networkDisableArgs);
  return args;
}

// ---------------- meta records (per-job serialized writes, monotonic ranks) ----------------

const STATE_RANK = { spawning: 0, running: 1, closing: 2, killing: 2, completed: 3, failed: 3, cancelled: 3 };

// Registry of LIVE jobs. In-memory control state only -- on-disk state NEVER triggers a kill.
const registry = new Map();
export function _registry() { return registry; } // test-only accessor

export function metaPath(dir) { return path.join(dir, "meta.json"); }

// Failure-detail log seam: failures that are caught-not-rethrown are still LOGGED.
// Default sink = stderr (safe for a stdio MCP server; stdout is the protocol channel). Consumed
// by the meta queue here and by the watcher/final-stat, stderr-log and finalize paths.
function logDiag(deps, msg) { ((deps && deps.log) ?? console.error)("a1-direct: " + msg); }

// Queue one meta write. State transitions are monotonic by rank: a stale lower-rank state in a
// late patch cannot roll back a terminal. Unique tmp name + rename. Post-spawn write failures
// are RECORDED (job.metaWriteError) and LOGGED, never fatal -- meta is housekeeping;
// the fatal pre-spawn writes (submit steps 1-2) do their own direct writes.
export function queueMetaWrite(job, patch, deps = {}) {
  const writeFile = deps.writeFile ?? fs.writeFileSync;
  const rename = deps.rename ?? fs.renameSync;
  const p = { ...patch };
  if (p.state !== undefined) {
    const cur = STATE_RANK[job.meta.state] ?? -1;
    const nxt = STATE_RANK[p.state] ?? -1;
    if (nxt < cur) delete p.state;
  }
  Object.assign(job.meta, p);
  const snapshot = JSON.stringify(job.meta);
  job.metaQueue = job.metaQueue.then(() => {
    const tmp = path.join(job.dir, `meta.json.${randomUUID()}.tmp`);
    writeFile(tmp, snapshot, "utf8");
    rename(tmp, metaPath(job.dir));
  }).catch((e) => {
    job.metaWriteError = String(e && e.message);
    logDiag(deps, `meta write failed (job ${job.meta.jobId}): ${job.metaWriteError}`);
  });
  return job.metaQueue;
}

// Reader: prefer meta.json; else the newest parseable meta.json.*.tmp (torn-write recovery).
export function readMeta(dir, deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const readdir = deps.readdir ?? fs.readdirSync;
  const statFn = deps.stat ?? fs.statSync;
  try { return JSON.parse(readFile(metaPath(dir))); } catch { /* fall through */ }
  let names;
  try { names = readdir(dir).filter((n) => /^meta\.json\..+\.tmp$/.test(n)); } catch { return null; }
  const byTime = names.map((n) => {
    try { return { n, t: statFn(path.join(dir, n)).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.t - a.t);
  for (const { n } of byTime) {
    try { return JSON.parse(readFile(path.join(dir, n))); } catch { /* next */ }
  }
  return null;
}

// ---------------- preconditions (single-flight revalidation, binary-identity bound) ----------------

let directPreconditions = null;
const singleFlight = new Map(); // identityKey -> shared Promise
let generationCounter = 0;

export function getDirectPreconditions() { return directPreconditions; }
export function _resetPreconditions() { directPreconditions = null; singleFlight.clear(); }
export function _setDirectPreconditions(p) { directPreconditions = p; } // test-only seeding

function identityKey(b) { return [b.path, b.version, b.size, b.mtime, b.digest].join("|"); }

// Probe prompt: fixed verbatim in code. create + modify + delete + fetch.
export const PROBE_PROMPT = [
  "You are a sandbox verification probe. Execute EXACTLY these four PowerShell commands, in",
  "order, each as its own shell command. Do not run any other mutation or network command.",
  "Report each command's outcome briefly.",
  "1. Set-Content -LiteralPath probe-write.txt -Value CANARY",
  "2. Add-Content -LiteralPath probe-existing.txt -Value X",
  "3. Remove-Item -LiteralPath probe-existing.txt",
  "4. Invoke-WebRequest https://1.1.1.1 -UseBasicParsing",
].join("\n");

// Event association (pinned): the FIRST item.completed command_execution whose
// `command` contains the substring key. Missing key event -> that flag FAILS.
export function findKeyEvent(events, key) {
  for (const ev of events) {
    if (ev && ev.type === "item.completed" && ev.item && ev.item.type === "command_execution"
        && typeof ev.item.command === "string" && ev.item.command.includes(key)) return ev.item;
  }
  return null;
}

// Write judgment: ALL THREE mutations denied via the filesystem oracle (create+modify+delete:
// probe-write.txt absent, probe-existing.txt intact) AND the create event shows nonzero exit +
// the pinned WRITE-DENIAL SIGNATURE. Ambiguity fails closed.
export function judgeWrite(events, oracle) {
  if (!Array.isArray(events)) return { pass: false, why: "malformed_trace" };
  if (!oracle.probeWriteAbsent) return { pass: false, why: "probe_write_created" };
  if (!oracle.probeExistingIntact) return { pass: false, why: "probe_existing_mutated" };
  const item = findKeyEvent(events, "probe-write.txt");
  if (!item) return { pass: false, why: "missing_key_event" };
  if (!(typeof item.exit_code === "number" && item.exit_code !== 0)) return { pass: false, why: "write_succeeded" };
  if (!SIGNATURES.write.test(String(item.aggregated_output ?? ""))) return { pass: false, why: "signature_mismatch" };
  // ALL THREE mutations denied: the fs oracle proves modify/delete OUTCOMES; the
  // probe-existing key event pins the event-level denial too (first such event, per the rule).
  const existing = findKeyEvent(events, "probe-existing.txt");
  if (!existing) return { pass: false, why: "missing_key_event" };
  if (!(typeof existing.exit_code === "number" && existing.exit_code !== 0)) return { pass: false, why: "mutation_succeeded" };
  if (!SIGNATURES.write.test(String(existing.aggregated_output ?? ""))) return { pass: false, why: "signature_mismatch" };
  // Evidence class: "os" ONLY when EVERY required denial event is os-class --
  // a single pre-execution policy refusal means the OS boundary was not fully exercised.
  const classes = [item, existing].map((e) => denialClassOf(e.aggregated_output));
  return { pass: true, class: classes.every((c) => c === "os") ? "os" : "policy" };
}

// Network judgment: fail-closed bootstrap (manifest + signature must be pinned), connectivity
// control (denial only creditable when the SERVER just reached the same host outside the
// sandbox), then nonzero exit + pinned NETWORK-DENIAL SIGNATURE on the fetch event.
export function judgeNetwork(events, { connectivityOk, manifestPinned }) {
  if (!manifestPinned) return { pass: false, why: "manifest_unpinned" };
  if (!SIGNATURES.network) return { pass: false, why: "signature_unpinned" };
  if (!connectivityOk) return { pass: false, why: "no_connectivity_control" };
  if (!Array.isArray(events)) return { pass: false, why: "malformed_trace" };
  const item = findKeyEvent(events, "1.1.1.1");
  if (!item) return { pass: false, why: "missing_key_event" };
  if (!(typeof item.exit_code === "number" && item.exit_code !== 0)) return { pass: false, why: "fetch_succeeded" };
  if (!SIGNATURES.network.test(String(item.aggregated_output ?? ""))) return { pass: false, why: "signature_mismatch" };
  // Evidence class: policy-class text reports "policy"; the 0.160.1 network-layer text
  // (the fetch ran and the connection was refused) reports "os".
  const out = String(item.aggregated_output ?? "");
  const netLayer = /Unable to connect to the remote server/.test(out) && !POLICY_DENIAL_SIGNATURE.test(out);
  return { pass: true, class: netLayer ? "os" : denialClassOf(out) };
}

// Connectivity control: the server process itself performs the same HTTPS GET.
// The target is a raw IP: a local DNS resolver that intermittently fails to resolve a public
// hostname would fail this control and block every PII direct admission with no real network
// problem. A raw IP removes DNS from this check entirely rather than betting on a particular
// hostname staying resolvable. 1.1.1.1 (Cloudflare) answers an HTTPS GET with a valid 3xx.
export function checkConnectivity(deps = {}) {
  if (deps.httpsGet) return deps.httpsGet("https://1.1.1.1");
  return new Promise((resolve) => {
    const req = https.get("https://1.1.1.1", { timeout: 5000 }, (res) => {
      res.resume();
      resolve(typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

// Tree-kill an own child pid. Rejects on launch failure OR a nonzero taskkill exit -- callers
// classify BOTH as kill_unverified (taskkill launch/exit failure -> deferral path,
// never a silent success). Also used by the kill road.
function killTree(pid, deps = {}) {
  const spawnFn = deps.spawn ?? _spawn;
  const [cmd, ...rest] = buildTreeKillArgs(pid);
  return new Promise((resolve, reject) => {
    try {
      const p = spawnFn(cmd, rest, { stdio: "ignore" });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`))));
    } catch (e) { reject(e); }
  });
}

// One throwaway-dir probe run under the pinned argv. The child handle and dir are
// registered on deps.probeControl so the 180s cap road in revalidatePreconditions can tree-kill
// + verify + clean up; this function keeps NO competing timer (single owner). Artifacts are
// also deleted in finally on natural settle.
async function runPreconditionProbe(identity, deps = {}) {
  const rt = resolveDirectRuntime(deps);
  if (rt.error) throw new Error(rt.error);
  const spawnFn = deps.spawn ?? _spawn;
  const control = deps.probeControl ?? {};
  const dir = path.join(rt.instanceDir, `probe-${randomUUID()}`);
  fs.mkdirSync(dir);
  control.dir = dir;
  try {
    fs.writeFileSync(path.join(dir, "probe-existing.txt"), "ORIGINAL", "utf8");
    const answerFile = path.join(dir, "probe-answer.txt");
    const connectivityOk = await checkConnectivity(deps);
    // Cancellation-completeness: the pre-spawn connectivity await is the last yield
    // point before the child exists. If the 180s cap fired while we were parked here, the shared
    // promise has already resolved FAIL and bumped the generation -- spawning now would leak an
    // unsupervised probe child that no cap road tracks. Refuse the spawn entirely and fail closed
    // (no child, no commit; the generation gate would drop the result anyway). finally cleans dir.
    if (control.expired) return { write: { pass: false, why: "revalidation_cap_expired" }, network: { pass: false, why: "revalidation_cap_expired" } };
    const args = buildDirectArgs({ model: "gpt-6-luna", effort: "low", cwd_real: dir, answerFile, version: identity.version });
    const spec = spawnSpecFor(rt.codexBin, args);
    const events = await new Promise((resolve, reject) => {
      const child = spawnFn(spec.cmd, spec.args, {
        env: buildChildEnv(rt.codexHome, deps.env ?? process.env), stdio: ["pipe", "pipe", "pipe"],
      });
      control.pid = child.pid;
      control.child = child;
      const chunks = [];
      child.stdout.on("data", (c) => chunks.push(c));
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("close", () => {
        const evs = [];
        for (const ln of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) {
          if (!ln.trim()) continue;
          try { evs.push(JSON.parse(ln)); } catch { /* non-JSON noise ignored; judgments re-check shape */ }
        }
        resolve(evs);
      });
      child.stdin.on("error", () => { /* EPIPE -> close resolves with what we got; judgments fail closed */ });
      child.stdin.write(PROBE_PROMPT);
      child.stdin.end();
    });
    const oracle = {
      probeWriteAbsent: !fs.existsSync(path.join(dir, "probe-write.txt")),
      probeExistingIntact: fs.existsSync(path.join(dir, "probe-existing.txt"))
        && fs.readFileSync(path.join(dir, "probe-existing.txt"), "utf8").trim() === "ORIGINAL",
    };
    const manifestPinned = Array.isArray(VALIDATED_VERSIONS[identity.version]?.networkDisableArgs);
    return {
      write: judgeWrite(events, oracle),
      network: judgeNetwork(events, { connectivityOk, manifestPinned }),
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cap road also deletes */ }
  }
}

// Single-flight revalidation with the generation protocol. Version gate FIRST: an
// unlisted version is blocked BEFORE any probe. Independent per-flag commit. Failure is never
// cached (entry cleared; next admission re-runs). On 180s expiry: tree-kill the probe child,
// verify, delete the throwaway dir, resolve the shared promise as FAIL; a probe finishing after
// supersession or timeout commits NOTHING (generation compare).
export async function revalidatePreconditions(freshIdentity, deps = {}) {
  if (!VALIDATED_VERSIONS[freshIdentity.version]) return { ok: false, why: "version_not_validated" };
  const key = identityKey(freshIdentity);
  if (singleFlight.has(key)) return singleFlight.get(key);
  const gen = ++generationCounter;
  const capMs = deps.revalidationCapMs ?? REVALIDATION_CAP_MS;
  const control = {};
  const probe = deps.runProbe ?? ((id, d) => runPreconditionProbe(id, d));
  const shared = (async () => {
    let capTimer;
    try {
      const result = await Promise.race([
        probe(freshIdentity, { ...deps, probeControl: control }),
        // On cap expiry, flag the shared probe control BEFORE resolving so a probe still parked
        // at its pre-spawn connectivity await sees control.expired and refuses to spawn.
        new Promise((resolve) => { capTimer = setTimeout(() => { control.expired = true; resolve({ timeout: true }); }, capMs); }),
      ]);
      if (result.timeout) {
        generationCounter++; // invalidate this generation: a late probe completion cannot commit
        try {
          if (control.child && control.child.exitCode === null) {
            await killTree(control.pid, deps);
            let alive;
            try { alive = (deps.isPidAlive ?? _isPidAlive)(control.pid); } catch { alive = null; }
            if (alive !== false) console.error(`a1-direct: probe kill unverified (pid ${control.pid})`);
          }
        } catch (e) { console.error(`a1-direct: probe kill failed: ${e.message}`); }
        try { if (control.dir) fs.rmSync(control.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        return { ok: false, why: "revalidation_timeout" };
      }
      if (gen !== generationCounter) return { ok: false, why: "superseded" }; // late commit -> no-op
      // The flag names its evidence honestly.
      // writeDenialVerified gates ALL direct runs (either class keeps the run fail-closed:
      // the fs oracle + denial events still hold); the *Class fields record whether the OS
      // boundary was actually exercised ("os") or codex refused pre-execution ("policy").
      // The old name sandboxWriteDenialVerified is GONE -- it claimed OS evidence it did not have.
      directPreconditions = {
        binary: { ...freshIdentity },
        writeDenialVerified: result.write.pass === true,
        writeDenialClass: result.write.class ?? null,
        // Judgment whys are RETAINED so failures can be explained: otherwise a failed
        // judgment committed only a false flag and the why (e.g. no_connectivity_control when
        // a local resolver failing the connectivity-control host) was discarded, so every
        // PII admission block read as an opaque direct_preconditions_unmet and cost a full
        // investigation. The connectivity-control host is a raw IP to remove DNS
        // from this check -- see checkConnectivity above.
        writeDenialWhy: result.write.pass === true ? null : (result.write.why ?? null),
        networkDenialVerified: result.network.pass === true,
        networkDenialClass: result.network.class ?? null,
        networkDenialWhy: result.network.pass === true ? null : (result.network.why ?? null),
        verifiedAt: new Date().toISOString(),
        generation: gen,
      };
      if (result.write.pass !== true || result.network.pass !== true) {
        logDiag(deps, "precondition probe judgment incomplete: "
          + `write=${result.write.pass === true ? "pass" : (result.write.why ?? "fail")} `
          + `network=${result.network.pass === true ? "pass" : (result.network.why ?? "fail")}`);
      }
      return { ok: true };
    } catch (e) {
      // The raw message may carry environment detail (absolute paths, CODEX_BIN) -- it is for
      // LOCAL stderr failure detail only; unsatisfiedWhy sanitizes what leaves the module.
      logDiag(deps, `revalidation failed: ${String(e && e.message)}`);
      return { ok: false, why: String(e && e.message) };
    } finally {
      clearTimeout(capTimer);
      singleFlight.delete(key);
    }
  })();
  singleFlight.set(key, shared);
  return shared;
}

// Refresh point = ADMISSION only. CURRENT iff the stored binary identity exactly
// equals a fresh re-stat; staleness is identity mismatch ONLY (no TTL). RETRY-ON-DEMAND: a
// still-false REQUIRED flag re-probes on the next admission -- a transient failure (e.g. a
// connectivity blip failing the network judgment) blocks one admission, never the binary's
// lifetime. Verified-true flags stay cached until the binary changes. Write-denial gates ALL
// direct runs; network-denial additionally gates PII.
export async function ensureDirectPreconditions({ pii = false } = {}, deps = {}) {
  const fresh = (deps.statIdentity ?? statBinaryIdentity)(deps);
  if (!fresh) return { ok: false, why: "identity_stat_failed" };
  const satisfied = (p) => Boolean(p && identityEquals(p.binary, fresh)
    && p.writeDenialVerified && (!pii || p.networkDenialVerified));
  let reval = null;
  if (!satisfied(directPreconditions)) reval = await revalidatePreconditions(fresh, deps);
  const p = directPreconditions;
  if (!satisfied(p)) return { ok: false, why: unsatisfiedWhy(p, fresh, pii, reval) };
  return { ok: true, binaryIdentity: { ...p.binary } };
}

// Explain why: name the FIRST unsatisfied requirement, in check order. A
// revalidation-level failure names itself, but ONLY through the allowlist below -- a probe
// throw's raw message can carry environment detail (absolute paths, CODEX_BIN) and the why
// ends up in blocked MCP payloads, so unexpected reasons collapse to a stable generic token
// (the raw text is already on stderr via the revalidation catch's logDiag).
const REVALIDATION_WHYS = new Set(["version_not_validated", "revalidation_timeout", "superseded"]);
function unsatisfiedWhy(p, fresh, pii, reval) {
  if (reval && reval.ok === false && reval.why) {
    return REVALIDATION_WHYS.has(reval.why) ? reval.why : "revalidation_error";
  }
  if (!p || !identityEquals(p.binary, fresh)) return "no_verified_preconditions_for_identity";
  if (!p.writeDenialVerified) {
    return p.writeDenialWhy ? `write_denial_unverified: ${p.writeDenialWhy}` : "write_denial_unverified";
  }
  if (pii && !p.networkDenialVerified) {
    return p.networkDenialWhy ? `network_denial_unverified: ${p.networkDenialWhy}` : "network_denial_unverified";
  }
  return "unsatisfied";
}

// ---------------- state machine + roads ----------------
// Live: spawning -> running -> closing|killing -> terminal(completed|failed|cancelled).
// failure_reason: timeout | nonzero_exit | spawn_error | stream_error | output_cap.
// Terminal visibility = road resolved: pollers only ever observe RESOLVED terminals.

function newJob({ jobId, dir, request, rt = {} }) {
  return {
    jobId, dir, request, rt,
    meta: {
      jobId, instanceId: rt.instanceId ?? null, pid: null, pii: Boolean(request.pii),
      cwd_real: request.cwd_real, model: request.model, effort: request.effort,
      thread_id: null, state: "spawning", kill_unverified: false, failure_reason: null,
      createdAt: new Date().toISOString(), terminalAt: null, codexVersion: rt.codexVersion ?? null,
    },
    metaQueue: Promise.resolve(), metaWriteError: null,
    child: null, resolved: false, intent: null, terminal: null, roadResolved: false,
    roadPromise: null, closeInfo: null, closeWaiters: [],
    timer: null, watcher: null, tee: null, errlog: null,
    preResolutionFail: null, _stdoutHead: "",
  };
}
export function _newJobForTest(args) { return newJob(args); } // test-only

export function clearJobTimers(job) {
  if (job.timer) clearTimeout(job.timer);
  if (job.watcher) clearInterval(job.watcher);
  job.timer = null; job.watcher = null;
}

// killTree is defined in the preconditions section: it REJECTS on launch failure
// or nonzero taskkill exit, which the roads below classify as kill_unverified.

function waitCloseOr(job, ms) {
  if (job.closeInfo) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
    job.closeWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

function flushStreams(job) {
  const ends = [];
  for (const s of [job.tee, job.errlog]) {
    if (!s || s.destroyed) continue;
    ends.push(new Promise((resolve) => { s.on("error", resolve); s.end(resolve); }));
  }
  return Promise.all(ends);
}
// Destroys both write streams and returns a promise that settles once each has emitted 'close'
// (its file handle is released) or after waitMs, whichever comes first. A caller that deletes the
// job dir must await it: on Windows a folder holding an open file cannot be removed. The timer is
// deliberately NOT unref'd: an awaited cleanup must finish even if nothing else keeps Node alive.
function closeStreams(job, waitMs = STREAM_CLOSE_WAIT_MS) {
  const closes = [];
  for (const s of [job.tee, job.errlog]) {
    if (!s || typeof s.destroy !== "function") continue;
    if (!s.closed && typeof s.once === "function") closes.push(new Promise((resolve) => s.once("close", resolve)));
    try { s.destroy(); } catch { /* best-effort */ }
  }
  if (closes.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, waitMs);
    Promise.all(closes).then(() => { clearTimeout(t); resolve(); });
  });
}

function watchTargets(job) {
  return [
    [path.join(job.dir, "events.jsonl"), job.request.logCap],
    [path.join(job.dir, "stderr.log"), job.request.logCap],
    [job.request.answerFile, ANSWER_READ_CAP],
  ];
}

// Mandatory final check at close: a breach found here WINS over completed. A stat error AT
// the final check: LOGGED, natural terminal stands (caps are a soft bound).
function finalSizeCheck(job, deps = {}) {
  const statFn = deps.stat ?? fs.statSync;
  for (const [f, cap] of watchTargets(job)) {
    try { if (statFn(f).size > cap) return true; } catch (e) { logDiag(deps, `final size stat failed: ${e.message}`); }
  }
  return false;
}

// Every-tick watcher (3s panel-tick cadence). stat errors during ticks: LOG + skip the tick.
export function startSizeWatcher(job, deps = {}) {
  const statFn = deps.stat ?? fs.statSync;
  const tick = deps.tickMs ?? POLL_TICK_MS;
  job.watcher = setInterval(() => {
    let breach = false;
    for (const [f, cap] of watchTargets(job)) {
      try { if (statFn(f).size > cap) { breach = true; break; } } catch (e) { logDiag(deps, `watcher stat failed: ${e.message}`); }
    }
    if (breach) {
      if (deps.onIntent) deps.onIntent("output_cap"); // test seam
      signalFailure(job, "output_cap", deps);
    }
  }, tick);
  if (job.watcher.unref) job.watcher.unref();
}

// Pre-resolution events convert the submit to a failure (CAS); post-resolution they are state
// machine inputs.
export function signalFailure(job, reason, deps = {}) {
  if (job.resolved) recordIntent(job, reason, deps);
  else if (job.preResolutionFail) job.preResolutionFail(reason);
}

const INTENT_TERMINAL = {
  timeout: { state: "failed", failure_reason: "timeout" },
  cancel: { state: "cancelled", failure_reason: null },
  stream_error: { state: "failed", failure_reason: "stream_error" },
  output_cap: { state: "failed", failure_reason: "output_cap" },
  spawn_error: { state: "failed", failure_reason: "spawn_error" },
};

// Road (b) -- record intent (CAS, first wins), kill own live handle only, verify, terminal.
// If ANY road (kill or natural) already owns the terminal, return it: a completed natural close
// stands; a recorded intent's terminal wins over a close arriving during its wait.
export function recordIntent(job, kind, deps = {}) {
  if (job.roadPromise) return job.roadPromise;
  job.intent = kind;
  job.roadPromise = executeKillRoad(job, kind, deps);
  return job.roadPromise;
}

async function executeKillRoad(job, kind, deps = {}) {
  const isAlive = deps.isPidAlive ?? _isPidAlive;
  queueMetaWrite(job, { state: "killing" }, deps);
  clearJobTimers(job);
  let unverified = false;
  const pid = job.child ? job.child.pid : null;
  if (job.child && job.child.exitCode === null) {
    try {
      await killTree(pid, deps);
      await waitCloseOr(job, deps.killWaitMs ?? KILL_WAIT_MS);
      let alive;
      try { alive = isAlive(pid); } catch { alive = null; }
      if (alive !== false) unverified = true; // alive OR errored check -> deferral, never silent success
    } catch { unverified = true; }             // taskkill launch failure -> kill_unverified
  }
  const t = INTENT_TERMINAL[kind] ?? INTENT_TERMINAL.spawn_error;
  job.terminal = { status: t.state, failure_reason: t.failure_reason, kill_unverified: unverified };
  closeStreams(job);
  await queueMetaWrite(job, {
    state: t.state, failure_reason: t.failure_reason, kill_unverified: unverified,
    terminalAt: new Date().toISOString(),
  }, deps);
  job.roadResolved = true;
  return job.terminal;
}

// Road (a) -- natural close: flush OUR write streams first, then the mandatory final size
// check; only a clean final check yields completed. nonzero exit -> failed(nonzero_exit).
export function onChildClose(job, code, deps = {}) {
  job.closeInfo = { code };
  for (const w of job.closeWaiters.splice(0)) w();
  if (job.roadPromise) return job.roadPromise; // kill road in flight -> its terminal wins
  job.roadPromise = naturalCloseRoad(job, code, deps);
  return job.roadPromise;
}

async function naturalCloseRoad(job, code, deps = {}) {
  queueMetaWrite(job, { state: "closing" }, deps);
  clearJobTimers(job);
  await flushStreams(job); // child stdio already drained by close; this pins OUR write flush
  if (job.teeFailed) {
    // Tee failure at ANY time is fatal. If it surfaced during/after this natural close,
    // signalFailure no-ops (this road already owns roadPromise) and flushStreams swallows the
    // stream error, so this flag is the ONLY signal the events trace is partial. A partial-trace
    // run must never be recorded completed.
    job.terminal = { status: "failed", failure_reason: "stream_error", kill_unverified: false };
  } else if (code === 0) {
    job.terminal = finalSizeCheck(job, deps)
      ? { status: "failed", failure_reason: "output_cap", kill_unverified: false }
      : { status: "completed", failure_reason: null, kill_unverified: false };
  } else {
    job.terminal = { status: "failed", failure_reason: "nonzero_exit", kill_unverified: false };
  }
  await queueMetaWrite(job, {
    state: job.terminal.status, failure_reason: job.terminal.failure_reason,
    terminalAt: new Date().toISOString(),
  }, deps);
  job.roadResolved = true;
  return job.terminal;
}

// ---------------- submitDirect (pinned sequence, CAS, internal 60s deadline) ----------------

function directError(reason, message) {
  return Object.assign(new Error(message ?? reason), { reason });
}

export async function submitDirect(prompt, opts = {}, deps = {}) {
  for (const k of ["model", "effort", "cwd_real", "pii", "timeoutMs", "binaryIdentity"]) {
    if (opts[k] === undefined || opts[k] === null) {
      throw directError("direct_preconditions_unmet", `submitDirect: missing required opt '${k}'`);
    }
  }
  const rt = resolveDirectRuntime(deps);
  if (rt.error) throw directError("direct_preconditions_unmet", rt.error);

  // Spawn preconditions: re-run realpath; re-stat the binary; preconditions flags CURRENT.
  const realpath = deps.realpath ?? fs.realpathSync;
  let again;
  try { again = realpath(opts.cwd_real); } catch { again = null; }
  if (again !== opts.cwd_real) throw directError("direct_preconditions_unmet", "cwd realpath mismatch at spawn");
  // The reviewed cwd must be DISJOINT from where the runtime writes: CODEX_HOME/sessions (rollout
  // receipts) and the job artifact tree both live OUTSIDE the read-only sandbox. If they overlap,
  // a nominally read-only review would deposit rollout/answer/meta files inside a write-blocked
  // (incl. PII) repo. Refuse fail-closed.
  const overlaps = (a, b) => { const r = path.relative(a, b); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  for (const wroot of [rt.codexHome, rt.instanceDir]) {
    if (wroot && (overlaps(wroot, opts.cwd_real) || overlaps(opts.cwd_real, wroot))) {
      throw directError("direct_preconditions_unmet", "codex home/artifact root overlaps the reviewed cwd");
    }
  }
  const fresh = (deps.statIdentity ?? statBinaryIdentity)(deps);
  if (!identityEquals(fresh, opts.binaryIdentity)) {
    throw directError("direct_preconditions_unmet", "binary identity changed since admission");
  }
  const p = getDirectPreconditions();
  if (!p || !identityEquals(p.binary, opts.binaryIdentity) || !p.writeDenialVerified
      || (opts.pii && !p.networkDenialVerified)) {
    throw directError("direct_preconditions_unmet", "6d flags not CURRENT for this identity");
  }

  sweepInstances(deps); // per-submit cadence

  const jobId = randomUUID();
  const dir = path.join(rt.instanceDir, jobId);
  const request = {
    model: opts.model, effort: opts.effort, cwd_real: opts.cwd_real, pii: Boolean(opts.pii),
    timeoutMs: opts.timeoutMs, logCap: parseLogCap(deps.env ?? process.env),
    answerFile: path.join(dir, "answer.txt"),
    // Pin the argv network manifest to the ADMITTED/probed identity version, NOT a cached runtime
    // version. lines 738-743 already enforce fresh-stat === opts.binaryIdentity, and the probe
    // validated exactly this version; using rt.codexVersion could ride a stale manifest after an
    // in-process binary update, leaving network features enabled on a PII run.
    version: opts.binaryIdentity.version,
  };
  const job = newJob({ jobId, dir, request, rt });
  return runSubmitSequence(job, prompt, deps);
}

async function runSubmitSequence(job, prompt, deps = {}) {
  const spawnFn = deps.spawn ?? _spawn;
  const rt = job.rt;
  let failed = null;
  const failOnce = (reason, msg) => { if (!failed) failed = directError(reason, msg ?? reason); };
  job.preResolutionFail = (reason) => failOnce(reason, `pre-resolution ${reason}`);

  // INTERNAL 60s submission deadline over steps 1-5: no external race.
  const deadline = setTimeout(() => failOnce("spawn_error", "submission deadline expired"),
    deps.submitDeadlineMs ?? SUBMIT_DEADLINE_MS);
  if (deadline.unref) deadline.unref();

  try {
    // (1) job dir, exclusive -- EEXIST throws.
    try { (deps.mkdir ?? fs.mkdirSync)(job.dir); } catch (e) { throw directError("spawn_error", `job dir: ${e.message}`); }
    // (2) meta state=spawning -- FATAL on failure (direct write; the queue serves post-spawn writes).
    try {
      const tmp = path.join(job.dir, `meta.json.${randomUUID()}.tmp`);
      (deps.writeFile ?? fs.writeFileSync)(tmp, JSON.stringify(job.meta), "utf8");
      (deps.rename ?? fs.renameSync)(tmp, metaPath(job.dir));
    } catch (e) { throw directError("spawn_error", `meta write: ${e.message}`); }

    // (3) spawn with handlers attached at spawn time.
    const args = buildDirectArgs({
      model: job.request.model, effort: job.request.effort, cwd_real: job.request.cwd_real,
      answerFile: job.request.answerFile, version: job.request.version,
    });
    const spec = spawnSpecFor(rt.codexBin, args);
    let child;
    try {
      child = spawnFn(spec.cmd, spec.args, {
        env: buildChildEnv(rt.codexHome, deps.env ?? process.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) { throw directError("spawn_error", `spawn: ${e.message}`); }
    job.child = child;
    const cws = deps.createWriteStream ?? fs.createWriteStream; // injectable seam (tee-failure tests)
    job.tee = cws(path.join(job.dir, "events.jsonl"), { flags: "a" });
    job.errlog = cws(path.join(job.dir, "stderr.log"), { flags: "a" });

    // Tee failure carries the receipt identity -> fail closed early (stream_error kill path).
    // Also flag it: a tee failure that surfaces DURING/AFTER the natural close would otherwise
    // be swallowed (signalFailure no-ops once a road owns roadPromise; flushStreams resolves on
    // error), letting a partial-trace run be recorded completed.
    job.tee.on("error", () => { job.teeFailed = true; signalFailure(job, "stream_error", deps); });
    // stderr.log failure -> LOG + reattach stderr to a draining sink (no pipe backpressure stall).
    job.errlog.on("error", () => {
      logDiag(deps, `stderr.log write failed (job ${job.meta.jobId}); stderr reattached to a draining sink`);
      try { child.stderr.unpipe(job.errlog); } catch { /* best-effort */ }
      try { child.stderr.on("data", () => {}); child.stderr.resume(); } catch { /* draining sink */ }
    });
    child.stdout.on("data", (chunk) => {
      const ok = job.tee.write(chunk, (err) => { if (err) { job.teeFailed = true; signalFailure(job, "stream_error", deps); } });
      // Honor write() backpressure: a pathologically verbose child must not grow live
      // memory unbounded. When the tee's buffer is full (write() === false), pause the child's
      // stdout and resume it on a single 'drain'. Fail-closed guards: never pause/resume a tee that
      // has already failed (teeFailed) -- the kill road owns that stream; a late drain must not
      // revive a killed child. The write-callback fires synchronously in the tee-failure path, so
      // teeFailed is already set here when the write errored.
      if (ok === false && !job.teeFailed) {
        try { child.stdout.pause(); } catch { /* best-effort: unbounded is the pre-existing behavior, never a false PASS */ }
        if (!job.teeDrainArmed) {
          job.teeDrainArmed = true;
          job.tee.once("drain", () => {
            job.teeDrainArmed = false;
            if (!job.teeFailed) { try { child.stdout.resume(); } catch { /* best-effort */ } }
          });
        }
      }
      captureThreadId(job, chunk, deps);
    });
    child.stderr.pipe(job.errlog);
    child.on("error", () => signalFailure(job, "spawn_error", deps));
    child.on("close", (code) => {
      if (!job.resolved) {
        job.closeInfo = { code };
        for (const w of job.closeWaiters.splice(0)) w();
        failOnce("spawn_error", "pre-resolution close");   // natural-close semantics are post-resolution only
      } else {
        onChildClose(job, code, deps);
      }
    });

    // (3a) prompt via stdin (no 32K argv ceiling).
    try {
      child.stdin.on("error", () => signalFailure(job, "stream_error", deps)); // EPIPE
      child.stdin.write(String(prompt ?? ""));
      child.stdin.end();
    } catch (e) { failOnce("stream_error", `stdin: ${e.message}`); }

    // (3b) kill timer; (3c) size watcher -- both may fire PRE-resolution (CAS -> failure).
    job.timer = setTimeout(() => signalFailure(job, "timeout", deps), job.request.timeoutMs);
    if (job.timer.unref) job.timer.unref();
    startSizeWatcher(job, deps);

    // Let synchronous-ish spawn failures surface before committing. The tick is a seam so tests
    // can hold the pre-resolution window open and race the deadline/timer/watcher against it.
    await (deps.preResolveTick ?? (() => new Promise((r) => setImmediate(r))))();
    if (failed) throw failed;

    // (4) meta pid/state running -- BEST-EFFORT (the one non-fatal step; fatal = 1,2,3,3a,5).
    queueMetaWrite(job, { pid: child.pid, state: "running" }, deps);

    // (5) registry insert; RESOLVE.
    if (failed) throw failed;
    registry.set(job.jobId, job);
    job.resolved = true;
    return { jobId: job.jobId };
  } catch (e) {
    await preResolutionKillRoad(job, deps);
    throw failed ?? e;
  } finally {
    clearTimeout(deadline);
  }
}

// Pre-resolution failure -> the KILL ROAD: kill own child if spawned, await
// verification; verified dead -> delete dir + throw; verification failure -> kill_unverified
// meta, RETAIN the dir (it is the sweep's pid-gated record).
async function preResolutionKillRoad(job, deps = {}) {
  clearJobTimers(job);
  const isAlive = deps.isPidAlive ?? _isPidAlive;
  let unverified = false;
  if (job.child && job.child.exitCode === null && !job.closeInfo) {
    try {
      await killTree(job.child.pid, deps);
      await waitCloseOr(job, deps.killWaitMs ?? KILL_WAIT_MS);
      let alive;
      try { alive = isAlive(job.child.pid); } catch { alive = null; }
      if (alive !== false) unverified = true;
    } catch { unverified = true; }
  }
  await closeStreams(job, deps.streamCloseWaitMs ?? STREAM_CLOSE_WAIT_MS);
  if (unverified) {
    try {
      Object.assign(job.meta, {
        state: "failed", failure_reason: "spawn_error", kill_unverified: true,
        pid: job.child ? job.child.pid : null, terminalAt: new Date().toISOString(),
      });
      const tmp = path.join(job.dir, `meta.json.${randomUUID()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(job.meta), "utf8");
      fs.renameSync(tmp, metaPath(job.dir));
    } catch { /* dir still retained; sweep pid-gate owns it */ }
  } else {
    try { (deps.rm ?? fs.rmSync)(job.dir, { recursive: true, force: true }); } catch { /* sweep ages it out */ }
  }
}

// First-line thread.started capture; meta write is best-effort (attestation falls back to the
// tee first line when meta lacks thread_id).
function captureThreadId(job, chunk, deps = {}) {
  if (job.meta.thread_id || job._threadScanned) return;
  job._stdoutHead = (job._stdoutHead + chunk.toString("utf8")).slice(0, 65536);
  const nl = job._stdoutHead.indexOf("\n");
  if (nl === -1) return;
  job._threadScanned = true;
  try {
    const ev = JSON.parse(job._stdoutHead.slice(0, nl));
    if (ev && ev.type === "thread.started" && typeof ev.thread_id === "string") {
      queueMetaWrite(job, { thread_id: ev.thread_id }, deps);
    }
  } catch { /* fall back to tee first line at attestation */ }
}

// ---------------- accessors ----------------

export function getDirectStatus(jobId) {
  const job = registry.get(jobId);
  if (!job) throw new Error(`unknown direct job: ${jobId}`);
  const t = job.roadResolved ? job.terminal : null;
  return {
    job: {
      status: t ? t.status : (job.meta.state === "spawning" ? "spawning" : "running"),
      pid: job.child ? job.child.pid : null,
      ...(t && t.failure_reason ? { failure_reason: t.failure_reason } : {}),
      ...(t && t.kill_unverified ? { kill_unverified: true } : {}),
      // display echo ONLY -- never an attestation source
      request: { model: job.request.model, effort: job.request.effort, cwd_real: job.request.cwd_real },
    },
  };
}

export function getDirectResult(jobId, deps = {}) {
  const job = registry.get(jobId);
  if (!job) throw new Error(`unknown direct job: ${jobId}`);
  const statFn = deps.stat ?? fs.statSync;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  let st;
  try { st = statFn(job.request.answerFile); } catch { throw new Error("result_error: answer file missing"); }
  if (st.size > ANSWER_READ_CAP) throw new Error("result_error: answer over the 5 MB cap");
  let text;
  try { text = readFile(job.request.answerFile); } catch { throw new Error("result_error: answer unreadable"); }
  if (!String(text).trim()) throw new Error("result_error: answer empty");
  return { output: String(text) };
}

export async function cancelDirect(jobId, deps = {}) {
  const job = registry.get(jobId);
  if (!job) throw new Error(`unknown direct job: ${jobId}`);
  await recordIntent(job, "cancel", deps); // resolves only after the road resolves
  return { cancelled: true, jobId };
}

// Corroboration search space: EXACTLY the command / aggregated_output string fields of
// item.completed command_execution events in the job's own events tee. No other records.
export function readCommandExecutionEvents(jobId, deps = {}) {
  const job = registry.get(jobId);
  if (!job) throw new Error(`unknown direct job: ${jobId}`);
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  let text;
  try { text = readFile(path.join(job.dir, "events.jsonl")); } catch { return []; }
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev && ev.type === "item.completed" && ev.item && ev.item.type === "command_execution") {
      out.push({ command: String(ev.item.command ?? ""), aggregated_output: String(ev.item.aggregated_output ?? "") });
    }
  }
  return out;
}

// ---------------- invocation attestation (attested-or-no-pass) ----------------

const THREAD_ID_RE = /^[0-9a-f-]{36}$/;

function threadIdOf(job, deps = {}) {
  if (job.meta.thread_id) return job.meta.thread_id;
  // Fallback: tee first line (meta writes are best-effort post-spawn).
  try {
    const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
    const first = String(readFile(path.join(job.dir, "events.jsonl"))).split(/\r?\n/)[0];
    const ev = JSON.parse(first);
    if (ev && ev.type === "thread.started" && typeof ev.thread_id === "string") return ev.thread_id;
  } catch { /* unattested */ }
  return null;
}

function findRolloutFiles(root, threadId, deps = {}) {
  const readdir = deps.readdir ?? fs.readdirSync;
  const want = new RegExp(`^rollout-.*-${threadId}\\.jsonl$`);
  const matches = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (want.test(e.name)) matches.push(p);
    }
  };
  walk(root, 0);
  return matches;
}

// Returns { model, effort } ONLY when the session rollout proves the exact requested pair on
// EVERY turn_context record (>=1 required). null on ANY deviation -- zero/multiple receipt
// matches, bad thread id, malformed records, downgraded turn, oversized receipt.
export async function directEffectiveStrength(jobId, deps = {}) {
  const job = registry.get(jobId);
  if (!job) return null;
  const threadId = threadIdOf(job, deps);
  if (!threadId || !THREAD_ID_RE.test(threadId)) return null;
  const root = job.rt && job.rt.sessionsRoot;
  if (!root) return null;
  let files = [];
  for (let i = 0; i < ATTEST_RETRIES; i++) {
    files = findRolloutFiles(root, threadId, deps);
    if (files.length > 0) break;
    await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? ATTEST_RETRY_MS));
  }
  if (files.length !== 1) return null; // zero after retries OR ambiguous multiple
  const statFn = deps.stat ?? fs.statSync;
  try { if (statFn(files[0]).size > RECEIPT_PARSE_CAP) return null; } catch { return null; }
  let text;
  try { text = (deps.readFile ?? ((p) => fs.readFileSync(p, "utf8")))(files[0]); } catch { return null; }
  let strengthRecords = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { return null; } // unrecognized shapes -> unattested
    if (!rec || rec.type !== "turn_context") continue;     // all other record types ignored
    const pl = rec.payload;
    if (!pl || typeof pl.model !== "string" || typeof pl.effort !== "string") return null;
    if (pl.model !== job.request.model || pl.effort !== job.request.effort) return null;
    strengthRecords++;
  }
  if (strengthRecords < 1) return null;
  return { model: job.request.model, effort: job.request.effort };
}

// ---------------- finalize + deletion-only housekeeping sweeps ----------------

// Awaited in the per-reviewer finally on every path; its own failure is caught and never
// reclassifies the reviewer. Order pinned (closes the stranded-entry class):
// (1) nonterminal -> cancelDirect first; (2) DROP THE REGISTRY ENTRY, always, unconditionally;
// (3) best-effort delete unless kill_unverified (the sweep's liveness recheck owns that dir).
export async function finalizeJob(jobId, deps = {}) {
  const job = registry.get(jobId);
  try {
    if (job && !job.roadResolved) await cancelDirect(jobId, deps);
  } catch (e) { logDiag(deps, `finalize failed (job ${jobId}): ${e && e.message}`); } // logged, never reclassifies
  registry.delete(jobId);
  try {
    let dir = job ? job.dir : null;
    if (!dir) {
      const rt = resolveDirectRuntime(deps);
      if (rt.error) return;
      dir = path.join(rt.instanceDir, jobId);
    }
    const meta = job ? job.meta : readMeta(dir, deps);
    if (meta && meta.kill_unverified) return; // retained: sweep pid-gate owns it
    // The cancel road destroys the log streams without waiting; release the files before deleting.
    if (job) await closeStreams(job, deps.streamCloseWaitMs ?? STREAM_CLOSE_WAIT_MS);
    (deps.rm ?? fs.rmSync)(dir, { recursive: true, force: true });
  } catch { /* best-effort; sweeps own the rest */ }
}

function newestMtimeDeep(dir, statFn) {
  let newest = statFn(dir).mtimeMs;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return newest; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      newest = Math.max(newest, e.isDirectory() ? newestMtimeDeep(p, statFn) : statFn(p).mtimeMs);
    } catch { /* skip */ }
  }
  return newest;
}

// Deletion-only housekeeping -- deletion is NOT a privacy control.
// Cadence: start + 15-min unref'd interval + per submit. Never throws.
export function sweepInstances(deps = {}) {
  try { sweepOwn(deps); sweepForeign(deps); } catch { /* never throws to callers */ }
}

function sweepOwn(deps = {}) {
  const rt = resolveDirectRuntime(deps);
  if (rt.error) return;
  const isAlive = deps.isPidAlive ?? _isPidAlive;
  const statFn = deps.stat ?? fs.statSync;
  const now = Date.now();
  let entries;
  try { entries = fs.readdirSync(rt.instanceDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (registry.has(e.name)) continue;             // live registry -> never touched
    const dir = path.join(rt.instanceDir, e.name);
    const meta = readMeta(dir, deps);
    const pid = meta && meta.pid;
    if (pid) {
      // PRECEDENCE (absolute): a recorded pid is deleted ONLY once confirmed dead; the age
      // rule NEVER overrides a live-or-unknown pid.
      let alive;
      try { alive = isAlive(pid); } catch { alive = true; } // unknown -> keep (fail-safe)
      if (alive) continue;
      const terminal = meta && (meta.state === "completed" || meta.state === "failed" || meta.state === "cancelled");
      // Eligibility (EXACT): terminal AND NOT kill_unverified, OR kill_unverified
      // (terminal by construction) -- both behind the pid-dead precedence gate above. A
      // NONTERMINAL record with a dead pid is RETAINED: only those two eligibility
      // classes; after this server dies, the foreign-tree rule owns the leftover.
      if (!terminal) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* next sweep */ }
    } else {
      // NO recorded pid: the 24h age rule only (submit-crash torn states; a mid-submit dir is
      // seconds old and never eligible).
      let mt;
      try { mt = newestMtimeDeep(dir, statFn); } catch { continue; }
      if (now - mt > SWEEP_AGE_MS) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* next sweep */ }
      }
    }
  }
}

function sweepForeign(deps = {}) {
  const rt = resolveDirectRuntime(deps);
  if (rt.error) return;
  const isAlive = deps.isPidAlive ?? _isPidAlive;
  const statFn = deps.stat ?? fs.statSync;
  const now = Date.now();
  const root = path.dirname(rt.instanceDir);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === rt.instanceId) continue;
    // Candidacy is gated on the EXACT minted instance-id shape (`<pid>-<uuidv4>`, see newInstance).
    // A recursive delete must never reach a sibling that isn't one of ours: if CODEX_DIRECT_ROOT
    // is ever mis-set to a broad directory (a leaked test env, a typo'd registration), non-instance
    // siblings (repos, Documents, ...) stay untouchable. The numeric-pid segment also closes the
    // old NaN-pid path where a non-numeric name parsed to NaN and was mis-classified as DEAD
    // (destructive-open + fail-unsafe identity branch).
    if (!/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.name)) continue;
    const tree = path.join(root, e.name);
    let serverPid = parseInt(e.name.split("-")[0], 10);
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(tree, "instance.json"), "utf8"));
      if (inst && Number.isFinite(inst.serverPid)) serverPid = inst.serverPid;
    } catch { /* instance.json loss -> name-derived pid, then the age rule */ }
    let alive;
    try { alive = Number.isFinite(serverPid) ? isAlive(serverPid) : false; } catch { alive = true; }
    if (alive) continue; // pid-reuse merely DELAYS housekeeping (fail-safe direction)
    let quiet;
    try { quiet = newestMtimeDeep(tree, statFn); } catch { continue; }
    if (now - quiet > SWEEP_AGE_MS) {
      try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* next sweep */ }
    }
  }
}

let sweepTimer = null;
export function startSweepInterval(deps = {}) {
  if (sweepTimer) return sweepTimer; // singleton
  sweepInstances(deps);
  sweepTimer = setInterval(() => sweepInstances(deps), SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref(); // never holds the process open
  return sweepTimer; // test seam; server-main ignores the return
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findKeyEvent, judgeWrite, judgeNetwork, PROBE_PROMPT,
  revalidatePreconditions, ensureDirectPreconditions,
  getDirectPreconditions, _resetPreconditions, _setDirectPreconditions,
  SIGNATURES, VALIDATED_VERSIONS, READ_FENCE, denialClassOf,
} from "../direct.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ID = { path: String.raw`C:\bin\codex.exe`, version: "0.144.1", size: 10, mtime: 20 };

function evCmd(command, exit_code, aggregated_output) {
  return { type: "item.completed", item: { type: "command_execution", command, exit_code, aggregated_output } };
}

test("event association: FIRST command_execution containing the key; missing key -> null", () => {
  const events = [
    { type: "item.completed", item: { type: "error", message: "noise" } },
    evCmd("powershell Set-Content -LiteralPath probe-write.txt -Value CANARY", 1, "UnauthorizedAccessException"),
    evCmd("second probe-write.txt mention", 0, "should not be read"),
  ];
  assert.equal(findKeyEvent(events, "probe-write.txt").exit_code, 1);
  assert.equal(findKeyEvent(events, "example.com"), null);
});

test("judgeWrite: PASS needs fs oracle + denied create event + denied mutation event + signatures; each alone fails", () => {
  const denyCreate = evCmd("Set-Content probe-write.txt", 1, "Set-Content : Access to the path 'probe-write.txt' is denied. UnauthorizedAccessException");
  const denyMutate = evCmd("Add-Content probe-existing.txt", 1, "Add-Content : Access to the path 'probe-existing.txt' is denied. PermissionDenied");
  const good = [denyCreate, denyMutate];
  const oracleOk = { probeWriteAbsent: true, probeExistingIntact: true };
  assert.equal(judgeWrite(good, oracleOk).pass, true);
  assert.equal(judgeWrite(good, { ...oracleOk, probeWriteAbsent: false }).pass, false);
  assert.equal(judgeWrite(good, { ...oracleOk, probeExistingIntact: false }).pass, false);
  assert.equal(judgeWrite([evCmd("Set-Content probe-write.txt", 0, "ok"), denyMutate], oracleOk).pass, false);
  assert.equal(judgeWrite([evCmd("Set-Content probe-write.txt", 1, "some other error"), denyMutate], oracleOk).pass, false);
  // ALL THREE mutations must show event-level denial: a missing or succeeded probe-existing
  // event fails even when the create was denied and the fs oracle looks intact.
  assert.equal(judgeWrite([denyCreate], oracleOk).why, "missing_key_event");
  assert.equal(judgeWrite([denyCreate, evCmd("Add-Content probe-existing.txt", 0, "ok")], oracleOk).why, "mutation_succeeded");
  assert.equal(judgeWrite([], oracleOk).why, "missing_key_event");
  assert.equal(judgeWrite(null, oracleOk).why, "malformed_trace");
});

test("the write-denial create event + signature hold on the captured os-class fixture", () => {
  const lines = fs.readFileSync(path.join(__dirname, "fixtures", "direct", "probe-events.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const item = findKeyEvent(lines, "probe-write.txt");
  assert.ok(item, "fixture must contain the probe-write.txt command event");
  assert.notEqual(item.exit_code, 0);
  assert.ok(SIGNATURES.write.test(item.aggregated_output));
});

test("the write-denial create event + signature hold on the captured policy-reject fixture", () => {
  const lines = fs.readFileSync(path.join(__dirname, "fixtures", "direct", "probe-events-policyreject.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const item = findKeyEvent(lines, "probe-write.txt");
  assert.ok(item, "fixture must contain the probe-write.txt command event");
  assert.notEqual(item.exit_code, 0);
  assert.ok(SIGNATURES.write.test(item.aggregated_output));
});

test("denialClassOf: os / policy / both-phrases->os / neither->null", () => {
  assert.equal(denialClassOf("Access to the path is denied. UnauthorizedAccessException"), "os");
  assert.equal(denialClassOf("Set-Content : PermissionDenied"), "os");
  assert.equal(denialClassOf("`powershell.exe -Command 'Set-Content ...'` rejected: blocked by policy"), "policy");
  // both phrases present = the command DID reach the OS -> os wins
  assert.equal(denialClassOf("PermissionDenied (policy banner: blocked by policy)"), "os");
  assert.equal(denialClassOf("some other error"), null);
  assert.equal(denialClassOf(null), null);
});

test("judgeWrite evidence class: os with the os-class bytes, policy on the whole policy-reject fixture, policy on a MIXED trace", () => {
  const oracleOk = { probeWriteAbsent: true, probeExistingIntact: true };
  const readFx = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "direct", name), "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  // The os-class capture predates the pinned probe protocol (its mutate event
  // targets secret-read-test.txt, not probe-existing.txt), so the os case pins the class rule
  // with that fixture's denial bytes on a protocol-shaped trace.
  const osBytes = findKeyEvent(readFx("probe-events.jsonl"), "probe-write.txt").aggregated_output;
  assert.equal(denialClassOf(osBytes), "os");
  const osVerdict = judgeWrite([
    evCmd("Set-Content probe-write.txt", 1, osBytes),
    evCmd("Add-Content probe-existing.txt", 1, osBytes),
  ], oracleOk);
  assert.equal(osVerdict.pass, true);
  assert.equal(osVerdict.class, "os");
  // The policy-reject fixture follows the pinned protocol -> whole-fixture judgeWrite.
  const policyVerdict = judgeWrite(readFx("probe-events-policyreject.jsonl"), oracleOk);
  assert.equal(policyVerdict.pass, true);
  assert.equal(policyVerdict.class, "policy");
  // one os-denied event + one policy-refused event: the OS boundary was NOT fully exercised
  const mixed = judgeWrite([
    evCmd("Set-Content probe-write.txt", 1, "Access is denied. UnauthorizedAccessException"),
    evCmd("Add-Content probe-existing.txt", -1, "rejected: blocked by policy"),
  ], oracleOk);
  assert.equal(mixed.pass, true);
  assert.equal(mixed.class, "policy");
});

test("a policy-class write denial still admits direct runs but records its class honestly", async () => {
  _resetPreconditions();
  const deps = {
    statIdentity: () => ID,
    runProbe: async () => ({ write: { pass: true, class: "policy" }, network: { pass: false, why: "signature_mismatch" } }),
  };
  const ok = await ensureDirectPreconditions({ pii: false }, deps);
  assert.equal(ok.ok, true);                              // the run is NOT blocked
  const p = getDirectPreconditions();
  assert.equal(p.writeDenialVerified, true);
  assert.equal(p.writeDenialClass, "policy");             // ...but nothing claims the OS boundary was exercised
  assert.equal("sandboxWriteDenialVerified" in p, false); // the old name claimed OS evidence it did not have -- gone
  _resetPreconditions();
});

test("network pin: the captured network-denial fixture matches SIGNATURES.network and rode the FINAL production argv", () => {
  const txt = fs.readFileSync(path.join(__dirname, "fixtures", "direct", "probe-network-denial.txt"), "utf8");
  assert.ok(SIGNATURES.network, "network signature must be pinned");
  assert.ok(SIGNATURES.network.test(txt));
  // 0.160.1 capture: the fetch EXECUTED and the network layer refused it -- not policy-class.
  assert.equal(denialClassOf(txt), null);
  assert.match(txt, /Unable to connect to the remote server/);
  // capture provenance: the fixture must have been captured under the FINAL production argv
  const capArgs = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "direct", "probe-network-denial.args.json"), "utf8"));
  if (READ_FENCE.args) for (const tok of READ_FENCE.args) assert.ok(capArgs.includes(tok), "network fixture captured without the pinned read fence -- re-run the network probe");
  for (const tok of VALIDATED_VERSIONS["0.160.1"].networkDisableArgs) assert.ok(capArgs.includes(tok), "network fixture captured without the manifest disables -- re-run the network probe");
});

test("judgeNetwork fails closed while bootstrap artifacts are unpinned", () => {
  const saved = SIGNATURES.network;
  SIGNATURES.network = null; // FORCE the unpinned state so this holds whether or not the signature is pinned
  try {
    const events = [evCmd("Invoke-WebRequest https://1.1.1.1", 1, "blocked")];
    assert.equal(judgeNetwork(events, { connectivityOk: true, manifestPinned: false }).why, "manifest_unpinned");
    assert.equal(judgeNetwork(events, { connectivityOk: true, manifestPinned: true }).why, "signature_unpinned");
  } finally { SIGNATURES.network = saved; }
});

test("judgeNetwork: connectivity control -- no outside connectivity means denial is not creditable", () => {
  const saved = SIGNATURES.network;
  SIGNATURES.network = /NETBLOCKED/;
  try {
    const events = [evCmd("Invoke-WebRequest https://1.1.1.1", 1, "NETBLOCKED")];
    assert.equal(judgeNetwork(events, { connectivityOk: false, manifestPinned: true }).why, "no_connectivity_control");
    assert.equal(judgeNetwork(events, { connectivityOk: true, manifestPinned: true }).pass, true);
    assert.equal(judgeNetwork([evCmd("Invoke-WebRequest https://1.1.1.1", 1, "dns fail")], { connectivityOk: true, manifestPinned: true }).why, "signature_mismatch");
    assert.equal(judgeNetwork([evCmd("Invoke-WebRequest https://1.1.1.1", 0, "200 OK")], { connectivityOk: true, manifestPinned: true }).why, "fetch_succeeded");
  } finally { SIGNATURES.network = saved; } // restore the MODULE value, NOT null -- the pinned regex must survive for later tests in this file
});

test("version gate: an unlisted version never probes, commits nothing", async () => {
  _resetPreconditions();
  const r = await revalidatePreconditions({ ...ID, version: "0.145.0" }, {});
  assert.equal(r.ok, false);
  assert.equal(r.why, "version_not_validated");
  assert.equal(getDirectPreconditions(), null);
});

test("version gate: prototype-chain member names are NOT validated versions (null-prototype allowlist)", async () => {
  for (const poison of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    _resetPreconditions();
    const r = await revalidatePreconditions({ ...ID, version: poison }, {});
    assert.equal(r.ok, false, poison);
    assert.equal(r.why, "version_not_validated", poison); // was truthy via Object.prototype before the null-proto fix
    assert.equal(getDirectPreconditions(), null, poison);
  }
});

test("single-flight: concurrent revalidations share one probe; independent per-flag commit", async () => {
  _resetPreconditions();
  let probeRuns = 0;
  const deps = {
    runProbe: async () => { probeRuns++; await new Promise((r) => setTimeout(r, 20));
      return { write: { pass: true }, network: { pass: false, why: "signature_unpinned" } }; },
  };
  const [a, b] = await Promise.all([
    revalidatePreconditions(ID, deps),
    revalidatePreconditions(ID, deps),
  ]);
  assert.equal(probeRuns, 1);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  const p = getDirectPreconditions();
  assert.equal(p.writeDenialVerified, true);
  assert.equal(p.networkDenialVerified, false);
});

test("failure is not cached: a failed revalidation re-runs on the next admission", async () => {
  _resetPreconditions();
  let n = 0;
  const deps = { runProbe: async () => { n++; if (n === 1) throw new Error("transient");
    return { write: { pass: true }, network: { pass: false } }; } };
  const r1 = await revalidatePreconditions(ID, deps);
  assert.equal(r1.ok, false);
  assert.equal(getDirectPreconditions(), null);
  const r2 = await revalidatePreconditions(ID, deps);
  assert.equal(r2.ok, true);
  assert.equal(n, 2);
});

test("ensureDirectPreconditions: verified flags cache; unmet REQUIRED flags re-probe on demand; stale identity re-validates", async () => {
  _resetPreconditions();
  const fresh = { ...ID };
  let revals = 0;
  const deps = {
    statIdentity: () => fresh,
    runProbe: async () => { revals++; return { write: { pass: true }, network: { pass: false } }; },
  };
  const ok = await ensureDirectPreconditions({ pii: false }, deps);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.binaryIdentity, fresh);
  assert.equal(revals, 1);
  const ok2 = await ensureDirectPreconditions({ pii: false }, deps);
  assert.equal(ok2.ok, true);
  assert.equal(revals, 1);              // satisfied flags stay cached -- no TTL, no re-probe
  const pii = await ensureDirectPreconditions({ pii: true }, deps);
  assert.equal(pii.ok, false);          // network still false -> PII blocked THIS admission...
  assert.equal(revals, 2);              // ...but it RE-PROBED: retry-on-demand, never sticky-false
  fresh.mtime = 99;                     // binary changed -> stale -> revalidate
  await ensureDirectPreconditions({ pii: false }, deps);
  assert.equal(revals, 3);
});

test("180s cap road: tree-kills the probe child, deletes the throwaway dir, resolves FAIL, retries on demand", async (t) => {
  _resetPreconditions();
  const killed = [];
  const dir = tempDirFor(t, "a1-probe-dir-");
  const deps = {
    revalidationCapMs: 30,
    runProbe: (id, d) => {
      d.probeControl.pid = 4242;
      d.probeControl.child = { exitCode: null };
      d.probeControl.dir = dir;
      return new Promise(() => {}); // never settles -- the cap road owns cleanup
    },
    spawn: (cmd, args) => { killed.push(args); return { on: (ev, fn) => { if (ev === "close") setTimeout(() => fn(0), 1); } }; },
    isPidAlive: () => false,
  };
  const r = await revalidatePreconditions(ID, deps);
  assert.equal(r.ok, false);
  assert.equal(r.why, "revalidation_timeout");
  assert.ok(killed.length === 1 && killed[0].includes("4242")); // taskkill /PID 4242 /T /F ran
  assert.equal(fs.existsSync(dir), false);                       // throwaway dir deleted
  assert.equal(getDirectPreconditions(), null);                  // nothing committed
  // next call re-runs (entry cleared, failure not cached)
  const r2 = await revalidatePreconditions(ID, { runProbe: async () => ({ write: { pass: true }, network: { pass: false } }) });
  assert.equal(r2.ok, true);
});

test("PROBE_PROMPT pins the four verbatim commands", () => {
  assert.ok(PROBE_PROMPT.includes("Set-Content -LiteralPath probe-write.txt -Value CANARY"));
  assert.ok(PROBE_PROMPT.includes("Add-Content -LiteralPath probe-existing.txt -Value X"));
  assert.ok(PROBE_PROMPT.includes("Remove-Item -LiteralPath probe-existing.txt"));
  assert.ok(PROBE_PROMPT.includes("Invoke-WebRequest https://1.1.1.1 -UseBasicParsing"));
});

test("failure reason: ensureDirectPreconditions names WHY it failed; whys persist on the record", async () => {
  // stat failure -> named
  _resetPreconditions();
  const s = await ensureDirectPreconditions({ pii: true }, { statIdentity: () => null });
  assert.equal(s.ok, false);
  assert.equal(s.why, "identity_stat_failed");
  // revalidation-level failure (version gate) passes its why through
  _resetPreconditions();
  const v = await ensureDirectPreconditions({ pii: true }, { statIdentity: () => ({ ...ID, version: "9.9.9" }) });
  assert.equal(v.ok, false);
  assert.equal(v.why, "version_not_validated");
  // a failure shape seen in practice: write verified, network judgment failed on the
  // connectivity control (the control host did not resolve) -> the PII refusal names it
  _resetPreconditions();
  const deps = {
    statIdentity: () => ID,
    runProbe: async () => ({ write: { pass: true, class: "policy" }, network: { pass: false, why: "no_connectivity_control" } }),
  };
  const n = await ensureDirectPreconditions({ pii: true }, deps);
  assert.equal(n.ok, false);
  assert.equal(n.why, "network_denial_unverified: no_connectivity_control");
  const p = getDirectPreconditions();
  assert.equal(p.networkDenialWhy, "no_connectivity_control");
  assert.equal(p.writeDenialWhy, null);
  // write-flag failure names its why too
  _resetPreconditions();
  const w = await ensureDirectPreconditions({ pii: false }, {
    statIdentity: () => ID,
    runProbe: async () => ({ write: { pass: false, why: "signature_mismatch" }, network: { pass: false } }),
  });
  assert.equal(w.ok, false);
  assert.equal(w.why, "write_denial_unverified: signature_mismatch");
  // a why-less judgment still yields the flag-level name (never undefined-in-a-string)
  _resetPreconditions();
  const bare = await ensureDirectPreconditions({ pii: true }, {
    statIdentity: () => ID,
    runProbe: async () => ({ write: { pass: true }, network: { pass: false } }),
  });
  assert.equal(bare.why, "network_denial_unverified");
  // a probe throw's raw message (may carry paths/env detail) never leaves the module:
  // non-allowlisted revalidation whys collapse to the stable revalidation_error token
  _resetPreconditions();
  const boom = await ensureDirectPreconditions({ pii: true }, {
    statIdentity: () => ID, log: () => {},
    runProbe: async () => { throw new Error("spawn C:/fixtures/private-area/codex.exe EPERM"); },
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.why, "revalidation_error");
  // allowlisted revalidation whys still pass through by name (timeout road)
  _resetPreconditions();
  const capped = await ensureDirectPreconditions({ pii: true }, {
    statIdentity: () => ID, revalidationCapMs: 20, isPidAlive: () => false,
    runProbe: () => new Promise(() => {}),
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.why, "revalidation_timeout");
  // success shape unchanged: no why key rides an ok admission
  _resetPreconditions();
  const ok = await ensureDirectPreconditions({ pii: false }, deps);
  assert.equal(ok.ok, true);
  assert.equal("why" in ok, false);
  _resetPreconditions();
});

test("_setDirectPreconditions seeds state for integration tests", () => {
  _resetPreconditions();
  _setDirectPreconditions({ binary: ID, writeDenialVerified: true, networkDenialVerified: true, verifiedAt: "t", generation: 1 });
  assert.equal(getDirectPreconditions().writeDenialVerified, true);
  _resetPreconditions();
});

test("0.160.1 candidate manifest: derived from 0.144.1 minus the removed flag plus the new network features", () => {
  const m = VALIDATED_VERSIONS["0.160.1"];
  const old = VALIDATED_VERSIONS["0.144.1"].networkDisableArgs;
  const flags = (a) => a.filter((_, i) => i % 2 === 1);
  assert.ok(!flags(m.networkDisableArgs).includes("features.remote_compaction_v2=false"), "removed flag must not be passed");
  for (const f of flags(old).filter((x) => x !== "features.remote_compaction_v2=false")) assert.ok(flags(m.networkDisableArgs).includes(f), "carried-over: " + f);
  for (const f of ["realtime_conversation", "daemon_auto_start", "in_app_updates", "system_proxy_fallback", "skill_search"]) assert.ok(flags(m.networkDisableArgs).includes(`features.${f}=false`), "new: " + f);
  assert.deepEqual(m.extraArgs, ["-c", 'windows.sandbox="elevated"']);
  assert.equal(VALIDATED_VERSIONS["0.144.1"].extraArgs, undefined, "0.144.1 argv must stay byte-identical");
});

test("buildDirectArgs: 0.160.1 carries the sandbox-mode arg, 0.144.1 does not", async () => {
  const { buildDirectArgs } = await import("../direct.mjs");
  const base = { model: "gpt-6-astra", effort: "max", cwd_real: "C:\\repo", answerFile: "C:\\a.txt" };
  const a160 = buildDirectArgs({ ...base, version: "0.160.1" });
  const a144 = buildDirectArgs({ ...base, version: "0.144.1" });
  assert.ok(a160.includes('windows.sandbox="elevated"'));
  assert.ok(!a144.some((x) => String(x).startsWith("windows.sandbox")));
  assert.ok(a160.includes("--sandbox") && a160[a160.indexOf("--sandbox") + 1] === "read-only");
});

test("judgeNetwork: 0.160.1 network-layer denial credits as os-class; policy text stays policy-class; success fails", () => {
  const ev = (out, code) => [{ type: "item.completed", item: { type: "command_execution", command: "Invoke-WebRequest https://1.1.1.1", aggregated_output: out, exit_code: code } }];
  const ok = { connectivityOk: true, manifestPinned: true };
  assert.deepEqual(judgeNetwork(ev("Invoke-WebRequest : Unable to connect to the remote server: ", 1), ok), { pass: true, class: "os" });
  assert.deepEqual(judgeNetwork(ev("rejected: blocked by policy", -1), ok), { pass: true, class: "policy" });
  assert.equal(judgeNetwork(ev("<html>301</html>", 0), ok).pass, false);
  assert.equal(judgeNetwork(ev("some other failure", 1), ok).why, "signature_mismatch");
});
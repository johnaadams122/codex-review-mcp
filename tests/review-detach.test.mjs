import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { mergeExtraEnv } from "../jobs.mjs";
import {
  discoveryKnobs, clampControlTimeout, deadBrokerEndpoint,
  dedupeById, matchTagged, matchUntagged, killProcessTreeVerified,
  submitDetachedReview, reviewLogDir, _internals, LOG_SWEEP_AGE_MS, LOG_SWEEP_MAX_FILES,
  DISCOVERY_TIMEOUT_DEFAULT_MS, DISCOVERY_TIMEOUT_FLOOR_MS,
  DISCOVERY_POLL_FLOOR_MS, CONTROL_CLAMP_FLOOR_MS
} from "../review-detach.mjs";
import { onCleanup, tempDirFor } from "./helpers/test-cleanup.mjs";

// The companion plugin folder has no built-in default: point it at the fixtures folder (the fake spawns
// in this file never run it, but submitDetachedReview resolves the path before spawning).
process.env.CLAUDE_PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Every submitDetachedReview in this file logs into a private folder, never the live server's
// <OS temp>/codex-mcp-reviews (the production sweep prunes that folder to its newest 400 files).
const LOG_DIR = tempDirFor({ after }, "rd-logs-");
process.env.CODEX_REVIEW_LOG_DIR = LOG_DIR;

test("mergeExtraEnv never mutates base when extra IS present (Task-2 triage minor)", () => {
  // An in-place-mutating mergeExtraEnv would pass every overlay test yet leak
  // overrides into process.env for later spawns.
  const base = { A: "1", DROP: "2" };
  const snapshot = { ...base };
  mergeExtraEnv(base, { B: 3, DROP: null });
  assert.deepEqual(base, snapshot);
});

test("killProcessTreeVerified: SYNC spawn throw still verifies via liveness (Task-5 triage minor)", async () => {
  // dead pid -> throw is absorbed, liveness check verifies
  const r1 = await killProcessTreeVerified(4242, {
    spawn: () => { throw new Error("EMFILE"); },
    isPidAlive: () => false,
    sleep: async () => {},
  });
  assert.deepEqual(r1, { verified: true });
  // still-alive pid -> throw absorbed, verification honestly fails
  const r2 = await killProcessTreeVerified(4242, {
    spawn: () => { throw new Error("EMFILE"); },
    isPidAlive: () => true,
    sleep: async () => {},
  });
  assert.equal(r2.verified, false);
});

test("sweepOldLogs also caps the FILE COUNT (newest kept)", (t) => {
  const dir = tempDirFor(t, "sweep-cap-");
  const nowMs = Date.now();
  const total = LOG_SWEEP_MAX_FILES + 5;
  for (let i = 0; i < total; i++) {
    const p = path.join(dir, "f" + String(i).padStart(4, "0") + ".log");
    fs.writeFileSync(p, "x");
    // stagger mtimes: f0000 oldest ... newest last; all inside the age window
    const mtime = new Date(nowMs - (total - i) * 1000);
    fs.utimesSync(p, mtime, mtime);
  }
  _internals.sweepOldLogs(dir, nowMs);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, LOG_SWEEP_MAX_FILES);
  assert.ok(!left.includes("f0000.log"), "oldest file must be swept by the count cap");
  assert.ok(left.includes("f" + String(total - 1).padStart(4, "0") + ".log"), "newest survives");
});

test("mergeExtraEnv overlays and stringifies values", () => {
  const out = mergeExtraEnv({ A: "1", B: "2" }, { B: 3, C: "x" });
  assert.equal(out.A, "1"); assert.equal(out.B, "3"); assert.equal(out.C, "x");
});

test("mergeExtraEnv null value deletes the key", () => {
  const out = mergeExtraEnv({ KEEP: "1", DROP: "2" }, { DROP: null });
  assert.equal(out.KEEP, "1");
  assert.ok(!("DROP" in out));
});

test("mergeExtraEnv with no extra returns a copy of base", () => {
  const base = { A: "1" };
  const out = mergeExtraEnv(base, undefined);
  assert.deepEqual(out, base);
  assert.notEqual(out, base);
});

test("discoveryKnobs defaults when env empty", () => {
  const k = discoveryKnobs({});
  assert.equal(k.timeoutMs, DISCOVERY_TIMEOUT_DEFAULT_MS);
  assert.equal(k.pollIntervalMs, 1500);
});

test("discoveryKnobs sanitizes garbage to defaults, enforces floors", () => {
  for (const bad of ["NaN", "0", "-5", "", "abc", "5000junk", "1.5"]) {
    const k = discoveryKnobs({ CODEX_REVIEW_DISCOVERY_TIMEOUT_MS: bad, CODEX_REVIEW_DISCOVERY_POLL_MS: bad });
    assert.equal(k.timeoutMs, DISCOVERY_TIMEOUT_DEFAULT_MS);
    assert.equal(k.pollIntervalMs, 1500);
  }
  assert.equal(discoveryKnobs({ CODEX_REVIEW_DISCOVERY_TIMEOUT_MS: "1" }).timeoutMs, DISCOVERY_TIMEOUT_FLOOR_MS);
  assert.equal(discoveryKnobs({ CODEX_REVIEW_DISCOVERY_POLL_MS: "1" }).pollIntervalMs, DISCOVERY_POLL_FLOOR_MS);
});

test("discoveryKnobs caps poll at timeout/2", () => {
  const k = discoveryKnobs({ CODEX_REVIEW_DISCOVERY_TIMEOUT_MS: "6000", CODEX_REVIEW_DISCOVERY_POLL_MS: "60000" });
  assert.equal(k.pollIntervalMs, 3000);
});

test("clampControlTimeout never returns a timer-less value", () => {
  assert.equal(clampControlTimeout(-100, 30000), CONTROL_CLAMP_FLOOR_MS);
  assert.equal(clampControlTimeout(0, NaN), CONTROL_CLAMP_FLOOR_MS);
  assert.equal(clampControlTimeout(NaN, 30000), CONTROL_CLAMP_FLOOR_MS);
  assert.equal(clampControlTimeout(500, 30000), CONTROL_CLAMP_FLOOR_MS);
  assert.equal(clampControlTimeout(45000, 30000), 30000);
  assert.equal(clampControlTimeout(2000, 30000), 2000);
});

// The dead named-pipe endpoint prefix ("pipe:" then a dotted pipe namespace path), assembled
// from parts.
const PIPE_PREFIX = "pipe:" + ["", "", ".", "pipe", ""].join("\\");

test("deadBrokerEndpoint: pins the FULL dead-pipe shape", () => {
  const ep = deadBrokerEndpoint("cmr-abc");
  assert.equal(ep, PIPE_PREFIX + "cmr-abc");           // exact literal shape
  // grammar pin: prefix + the pipe path + cmr- tag in the GENERATED charset
  // [a-z0-9-] (randomUUID lowercase hex + dashes), nothing after
  const ep2 = deadBrokerEndpoint("cmr-0f3a-bc12");
  assert.ok(ep2.startsWith(PIPE_PREFIX));
  assert.match(ep2.slice(PIPE_PREFIX.length), /^cmr-[a-z0-9-]+$/);
  assert.notEqual(ep, deadBrokerEndpoint("cmr-xyz"));      // unique per tag
});

const REC = (over = {}) => ({
  id: "review-abc-1", kind: "review", jobClass: "review", status: "running", pid: 4242,
  sessionId: "cmr-tag1", createdAt: "2026-07-22T15:00:10.000Z", ...over
});

test("dedupeById drops duplicate ids and null entries", () => {
  const a = REC(); const dup = REC({ status: "completed" });
  assert.deepEqual(dedupeById([a, dup, null, REC({ id: "review-b" })]).map(r => r.id),
    ["review-abc-1", "review-b"]);
});

const TAGGED = { tag: "cmr-tag1", childPid: 4242, kind: "review" };   // kind REQUIRED

test("matchTagged: running tagged record needs matching pid", () => {
  assert.equal(matchTagged([REC()], TAGGED).record.id, "review-abc-1");
  assert.equal(matchTagged([REC({ pid: 9 })], TAGGED).record, null);
  assert.equal(matchTagged([REC()], { ...TAGGED, tag: "cmr-OTHER" }).record, null);
});

test("matchTagged: terminal tagged record accepted without pid (pid nulled at finalize)", () => {
  const r = matchTagged([REC({ status: "completed", pid: null })], TAGGED);
  assert.equal(r.record.status, "completed");
});

test("matchTagged: filters foreign jobClass and mismatched kind; omitted kind matches NOTHING ", () => {
  assert.equal(matchTagged([REC({ jobClass: "task" })], TAGGED).record, null);
  assert.equal(matchTagged([REC({ kind: "adversarial-review" })], TAGGED).record, null);
  assert.equal(matchTagged([REC({ kind: "adversarial-review" })],
    { ...TAGGED, kind: "adversarial-review" }).record.id, "review-abc-1");
  // fail-closed contract: no kind -> no match, never wrong-kind attribution
  assert.equal(matchTagged([REC()], { tag: "cmr-tag1", childPid: 4242 }).record, null);
});

test("matchTagged: prefers pid-corroborated RUNNING over a terminal (nested-record defense)", () => {
  const nestedTerminal = REC({ id: "review-nested", status: "completed", pid: null, createdAt: "2026-07-22T15:00:20.000Z" });
  const m = matchTagged([nestedTerminal, REC()], TAGGED);
  assert.equal(m.record.id, "review-abc-1");
});

test("matchTagged: multiple tagged terminals -> earliest createdAt wins, multiple flagged", () => {
  const ours = REC({ status: "completed", pid: null });
  const nested = REC({ id: "review-nested", status: "completed", pid: null, createdAt: "2026-07-22T15:00:20.000Z" });
  const m = matchTagged([nested, ours], TAGGED);
  assert.equal(m.record.id, "review-abc-1");   // earliest createdAt
  assert.equal(m.multiple, true);
});

test("matchUntagged: running + review- prefix + pid + createdAt window", () => {
  const spawnedAtMs = Date.parse("2026-07-22T15:00:00.000Z");
  const nowMs = spawnedAtMs + 70000;
  const opts = { childPid: 4242, spawnedAtMs, nowMs };
  assert.equal(matchUntagged([REC({ sessionId: undefined })], opts).record.id, "review-abc-1");
  // stale frozen record with recycled pid: createdAt far before spawn -> rejected
  assert.equal(matchUntagged([REC({ sessionId: undefined, createdAt: "2026-07-22T09:00:00.000Z" })], opts).record, null);
  assert.equal(matchUntagged([REC({ sessionId: undefined, id: "task-x" })], opts).record, null);
  // future-dated record: upper bound is NOW, no forward slack (spec step 5)
  assert.equal(matchUntagged([REC({ sessionId: undefined, createdAt: new Date(nowMs + 5000).toISOString() })], opts).record, null);
  assert.equal(matchUntagged([REC({ sessionId: undefined, status: "completed" })], opts).record, null);
  assert.equal(matchUntagged([REC({ sessionId: undefined, pid: 9 })], opts).record, null);
  assert.equal(matchUntagged([REC({ sessionId: undefined, createdAt: "not-a-date" })], opts).record, null);
});

test("matchUntagged: pre-spawn record on a reused pid is rejected (no backward skew)", () => {
  const spawnedAtMs = Date.parse("2026-07-22T15:00:00.000Z");
  const nowMs = spawnedAtMs + 70000;
  const opts = { childPid: 4242, spawnedAtMs, nowMs };
  // A stranger's frozen "running" record created 30s BEFORE our spawn whose dead pid
  // the OS reused for OUR child: inside the old 60s backward-skew window, so the
  // pre-fix matcher attributed it to us. The lower bound is now spawnedAtMs exactly.
  const preSpawn = REC({ sessionId: undefined, createdAt: new Date(spawnedAtMs - 30000).toISOString() });
  assert.equal(matchUntagged([preSpawn], opts).record, null);
  // Boundary: created exactly AT spawnedAtMs is still ours (companion stamps createdAt
  // strictly after our spawn on the same clock).
  const atSpawn = REC({ sessionId: undefined, createdAt: new Date(spawnedAtMs).toISOString() });
  assert.equal(matchUntagged([atSpawn], opts).record.id, "review-abc-1");
});

test("matchTagged: NaN-createdAt terminal cannot win the tie-break in any input order", () => {
  const badDate = REC({ id: "review-bad", status: "completed", pid: null, createdAt: "not-a-date" });
  const goodDate = REC({ id: "review-good", status: "completed", pid: null, createdAt: "2026-07-22T15:00:10.000Z" });
  // Order 1: bad before good -> should still win with good (and multiple: true, fail-closed on non-finite)
  const m1 = matchTagged([badDate, goodDate], TAGGED);
  assert.equal(m1.record.id, "review-good");
  assert.equal(m1.multiple, true);
  // Order 2: good before bad -> same result (stable regardless of input order)
  const m2 = matchTagged([goodDate, badDate], TAGGED);
  assert.equal(m2.record.id, "review-good");
  assert.equal(m2.multiple, true);
  // Both bad dates -> no finite exists, fail-closed: record null + multiple true
  const m3 = matchTagged([badDate, REC({ id: "review-bad2", status: "completed", pid: null, createdAt: "not-a-date-either" })], TAGGED);
  assert.equal(m3.record, null);
  assert.equal(m3.multiple, true);
});

test("dedupeById: first occurrence wins on duplicate id (status preserved)", () => {
  const running = REC({ status: "running" });
  const completed = REC({ status: "completed" });
  const result = dedupeById([running, completed]);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "running");   // first occurrence's status preserved
});

test("matchTagged: kind-less records cannot match a kind-less call (fail-closed both sides)", () => {
  // Create a record without kind field (delete it from a copy)
  const kindLessRecord = (() => { const r = REC({ status: "completed", pid: null }); delete r.kind; return r; })();
  // Case 1: kind-less record + kind-less call -> record null (fail-closed)
  const m1 = matchTagged([kindLessRecord], { tag: "cmr-tag1", childPid: 4242 });   // no kind parameter
  assert.equal(m1.record, null);
  // Case 2: kind-less record + call with kind:"review" -> record null (undefined !== "review")
  const m2 = matchTagged([kindLessRecord], { tag: "cmr-tag1", childPid: 4242, kind: "review" });
  assert.equal(m2.record, null);
});

function fakeTaskkill({ exitCode = 0, emitError = false, never = false } = {}) {
  return () => {
    const p = new EventEmitter();
    setImmediate(() => {
      if (emitError) p.emit("error", new Error("spawn EPERM"));
      else if (!never) p.emit("close", exitCode);
    });
    return p;
  };
}

test("verified true when pid dies (even with nonzero taskkill exit)", async () => {
  const r = await killProcessTreeVerified(123, {
    spawn: fakeTaskkill({ exitCode: 128 }), isPidAlive: () => false, sleep: async () => {}
  });
  assert.equal(r.verified, true);
});

test("verified false when pid survives the poll", async () => {
  const r = await killProcessTreeVerified(123, {
    spawn: fakeTaskkill(), isPidAlive: () => true, sleep: async () => {}
  });
  assert.equal(r.verified, false);
});

test("taskkill spawn error still verifies via isPidAlive", async () => {
  const r = await killProcessTreeVerified(123, {
    spawn: fakeTaskkill({ emitError: true }), isPidAlive: () => false, sleep: async () => {}
  });
  assert.equal(r.verified, true);
});

test("wedged taskkill is bounded and does not hang", async () => {
  const r = await killProcessTreeVerified(123, {
    spawn: fakeTaskkill({ never: true }), isPidAlive: () => true, sleep: async () => {}, taskkillBoundMs: 20
  });
  assert.equal(r.verified, false);
});

test("no pid short-circuits verified", async () => {
  assert.equal((await killProcessTreeVerified(null, {})).verified, true);
});

// ---- sweepOldLogs + deps-injected submitDetachedReview unit tests ----

test("sweepOldLogs removes only files older than the age cutoff", (t) => {
  const dir = tempDirFor(t, "sweep-");
  const oldF = path.join(dir, "old.log"); const newF = path.join(dir, "new.log");
  fs.writeFileSync(oldF, "x"); fs.writeFileSync(newF, "x");
  const past = (Date.now() - LOG_SWEEP_AGE_MS - 60000) / 1000;
  fs.utimesSync(oldF, past, past);
  _internals.sweepOldLogs(dir);
  assert.ok(!fs.existsSync(oldF));
  assert.ok(fs.existsSync(newF));
});

// ---- CODEX_REVIEW_LOG_DIR: the test seam for the log folder ----

test("reviewLogDir: unset or blank CODEX_REVIEW_LOG_DIR -> the production folder, whole-folder sweep", () => {
  const production = { dir: path.join(os.tmpdir(), "codex-mcp-reviews"), ownFilesOnly: false };
  for (const env of [{}, { CODEX_REVIEW_LOG_DIR: "" }, { CODEX_REVIEW_LOG_DIR: "   " }]) {
    assert.deepEqual(reviewLogDir(env), production, JSON.stringify(env));
  }
});

test("reviewLogDir: CODEX_REVIEW_LOG_DIR set -> that folder, resolved, sweeping only this module's own files", (t) => {
  const dir = tempDirFor(t, "rd-seam-");
  assert.deepEqual(reviewLogDir({ CODEX_REVIEW_LOG_DIR: dir }), { dir, ownFilesOnly: true });
  assert.deepEqual(reviewLogDir({ CODEX_REVIEW_LOG_DIR: "  " + dir + " " }), { dir, ownFilesOnly: true },
    "surrounding spaces (a shell `set X=... `) do not move the folder");
  assert.deepEqual(reviewLogDir({ CODEX_REVIEW_LOG_DIR: "rd-rel-logs" }), { dir: path.resolve("rd-rel-logs"), ownFilesOnly: true });
});

// The seam's folder is only ever meant to be a private, empty one, but a mis-set value (a leaked test
// env, a typo) must not let the sweep delete someone else's files -- same rule as direct.mjs's sweep
// of CODEX_DIRECT_ROOT, which only touches names it minted.
test("sweepOldLogs ownFilesOnly: other files are neither removed nor counted toward the cap", (t) => {
  const dir = tempDirFor(t, "sweep-own-");
  const nowMs = Date.now();
  const old = new Date(nowMs - LOG_SWEEP_AGE_MS - 60000);
  const own = (ext) => "cmr-" + randomUUID() + ext;
  const write = (name, mtime) => { const p = path.join(dir, name); fs.writeFileSync(p, "x"); if (mtime) fs.utimesSync(p, mtime, mtime); return name; };
  const oldOwnLog = write(own(".log"), old);
  const oldOwnHandoff = write(own(".handoff.json"), old);
  const oldForeign = write("notes.txt", old);
  const lookalike = write("cmr-not-a-uuid.log", old);
  for (let i = 0; i < LOG_SWEEP_MAX_FILES + 5; i++) write("f" + String(i).padStart(4, "0") + ".log");
  const newOwn = write(own(".log"));
  _internals.sweepOldLogs(dir, nowMs, { ownFilesOnly: true });
  const left = new Set(fs.readdirSync(dir));
  assert.ok(!left.has(oldOwnLog) && !left.has(oldOwnHandoff), "this module's own old files are swept");
  assert.ok(left.has(oldForeign) && left.has(lookalike), "a file this module did not name survives, however old");
  assert.ok(left.has(newOwn), "other files do not count toward the cap, so a new own file survives");
  assert.equal(left.size, LOG_SWEEP_MAX_FILES + 5 + 3);
});

test("sweepOldLogs ownFilesOnly still caps this module's own files (newest kept)", (t) => {
  const dir = tempDirFor(t, "sweep-own-cap-");
  const nowMs = Date.now();
  const total = LOG_SWEEP_MAX_FILES + 5;
  const names = [];
  for (let i = 0; i < total; i++) {
    const name = "cmr-" + randomUUID() + ".log";
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x");
    const mtime = new Date(nowMs - (total - i) * 1000);   // names[0] oldest ... newest last, all inside the age window
    fs.utimesSync(p, mtime, mtime);
    names.push(name);
  }
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  _internals.sweepOldLogs(dir, nowMs, { ownFilesOnly: true });
  const left = new Set(fs.readdirSync(dir));
  assert.equal(left.size, LOG_SWEEP_MAX_FILES + 1);
  assert.ok(!left.has(names[0]), "oldest own file is swept by the count cap");
  assert.ok(left.has(names[total - 1]) && left.has("notes.txt"));
});

test("submitDetachedReview sweeps a CODEX_REVIEW_LOG_DIR folder of its own old files only", async (t) => {
  const dir = tempDirFor(t, "rd-sweep-");
  process.env.CODEX_REVIEW_LOG_DIR = dir;
  onCleanup(t, () => { process.env.CODEX_REVIEW_LOG_DIR = LOG_DIR; });
  const old = (Date.now() - LOG_SWEEP_AGE_MS - 60000) / 1000;
  const oldOwn = path.join(dir, "cmr-" + randomUUID() + ".log");
  const oldForeign = path.join(dir, "notes.txt");
  for (const p of [oldOwn, oldForeign]) { fs.writeFileSync(p, "x"); fs.utimesSync(p, old, old); }
  let tag = null;
  const r = await submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: (cmd, argv, opts) => { tag = opts.env.CODEX_COMPANION_SESSION_ID; return fakeChild(); },
    listJobsFn: async (extraEnv) => [{
      id: "review-sw1", kind: "review", jobClass: "review", status: "completed", pid: null,
      sessionId: extraEnv.CODEX_COMPANION_SESSION_ID, createdAt: new Date().toISOString()
    }],
    sleep: async () => {},
    killFn: async () => { throw new Error("must not kill on success"); }
  });
  assert.equal(r.job_id, "review-sw1");
  assert.ok(!fs.existsSync(oldOwn), "own old log swept");
  assert.ok(fs.existsSync(oldForeign), "a file this module did not name survives");
  assert.ok(fs.existsSync(path.join(dir, tag + ".log")), "the new log lands in the seam folder");
});

// ---- deps-injected submitDetachedReview unit tests (no real subprocess) ----

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 7777;
  c.unref = () => { c.unrefCalled = true; };
  return c;
}

// Test fix (instead of the literal `sleep: async
// () => {}`): a purely-synchronous-resolving fake sleep never yields to the
// macrotask/check phase, so a setImmediate-scheduled child.emit("exit"/"error")
// starves forever behind an unbroken microtask chain - empirically confirmed
// (node --test hangs on the real 5s+10s discovery/sweep budget, or a shorter
// probe: 0/37M+ iterations saw the event before the loop's own deadline). This
// is a test-harness artifact, not a production bug: the real defaultSleep
// uses setTimeout, which yields normally every call. yieldSleep still resolves
// on the next macrotask tick (no real delay -> tests stay fast) while letting
// FIFO-ordered pending immediates (the emitted exit/error) fire first.
const yieldSleep = async () => new Promise((r) => setImmediate(r));

test("spawn shape: detached, windowsHide, fd stdio, unref called, both env overrides beat sentinels", async () => {
  let captured = null;
  const child = fakeChild();
  // Pre-seed conflicting sentinels - in a clean env a wrong merge
  // order passes trivially; the overrides must OVERWRITE inherited values.
  process.env.CODEX_COMPANION_SESSION_ID = "stale-session-sentinel";
  process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = PIPE_PREFIX + "stale-endpoint-sentinel";
  try {
    const r = await submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
      spawn: (cmd, argv, opts) => { captured = opts; return child; },
      listJobsFn: async (extraEnv) => [{
        id: "review-shape1", kind: "review", jobClass: "review", status: "completed", pid: null,
        sessionId: extraEnv.CODEX_COMPANION_SESSION_ID, createdAt: new Date().toISOString()
      }],
      sleep: async () => {},
      killFn: async () => { throw new Error("must not kill on success"); }
    });
    assert.equal(r.job_id, "review-shape1");
    assert.equal(captured.detached, true);
    assert.equal(captured.windowsHide, true);
    assert.ok(Array.isArray(captured.stdio) && typeof captured.stdio[1] === "number", "stdout must be an fd");
    assert.equal(child.unrefCalled, true);
    // rev5: BOTH env overrides must ride the spawn - dropping the endpoint
    // silently re-enters killable shared-broker mode (only the live probe
    // would catch it otherwise).
    const tag = captured.env.CODEX_COMPANION_SESSION_ID;
    assert.ok(tag.startsWith("cmr-"));
    assert.notEqual(tag, "stale-session-sentinel");
    assert.equal(captured.env.CODEX_COMPANION_APP_SERVER_ENDPOINT, PIPE_PREFIX + tag);
  } finally {
    delete process.env.CODEX_COMPANION_SESSION_ID;
    delete process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  }
});

test("submitDetachedReview persists a tag handoff record post-spawn", async (t) => {
  const child = fakeChild();
  let capturedEnv = null;
  const cwd = tempDirFor(t, "handoff-cwd-");
  const r = await submitDetachedReview({ argv: ["review", "--json"], cwd }, {
    spawn: (cmd, argv, opts) => { capturedEnv = opts.env; return child; },
    listJobsFn: async (extraEnv) => [{
      id: "review-h1", kind: "review", jobClass: "review", status: "completed", pid: null,
      sessionId: extraEnv.CODEX_COMPANION_SESSION_ID, createdAt: new Date().toISOString()
    }],
    sleep: async () => {},
    killFn: async () => ({ verified: true })
  });
  assert.equal(r.job_id, "review-h1");
  const tag = capturedEnv.CODEX_COMPANION_SESSION_ID;
  const rec = JSON.parse(fs.readFileSync(path.join(LOG_DIR, tag + ".handoff.json"), "utf8"));
  assert.equal(rec.tag, tag);
  assert.equal(rec.childPid, 7777);
  assert.equal(rec.kind, "review");
  assert.equal(path.resolve(rec.cwd), path.resolve(cwd));
  assert.equal(rec.logFile, path.join(LOG_DIR, tag + ".log"));
});

test("kill disarmed once exit observed: killFn never fires, rejects child_failed", async () => {
  const child = fakeChild();
  let killed = false;
  const p = submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: () => { setImmediate(() => child.emit("exit", 3)); return child; },
    listJobsFn: async () => [],
    sleep: yieldSleep,
    killFn: async () => { killed = true; return { verified: true }; }
  });
  await assert.rejects(p, (e) => e.code === "review_child_failed");
  assert.equal(killed, false);
});

test("settle never trusts ONE empty read: late FAILED record beats child_failed ", async () => {
  const child = fakeChild();
  let calls = 0;
  const p = submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: () => { setImmediate(() => child.emit("exit", 3)); return child; },
    listJobsFn: async (extraEnv) => {
      calls += 1;
      // Interleaving (traced against the real code, yieldSleep in play):
      // calls 1-2 are consumed by the OUTER discovery loop, both empty, BEFORE
      // settleAfterExit is ever entered (state.exited flips true during call
      // 1's post-poll sleep, observed by discovery on its call-2 iteration).
      // call 3 is settle's OWN first read: genuinely empty, increments
      // emptyReads to 1 but must NOT trip the >=2 threshold. call 4 is
      // settle's second read and returns the terminal record. The <=2 cutoff
      // let ALL empty reads land pre-settle, so settle's first read (call 3)
      // found the terminal record immediately and never touched emptyReads at
      // all -- a single-read fail-fast mutant (emptyReads >= 1) passed
      // identically. <=3 forces exactly one genuinely-in-settle empty read
      // before the terminal record appears on the next call, which the
      // single-read mutant trips and the real >=2 code does not.
      if (calls <= 3) return [];
      return [{ id: "review-late1", kind: "review", jobClass: "review", status: "failed",
        pid: null, createdAt: new Date().toISOString(),
        sessionId: extraEnv.CODEX_COMPANION_SESSION_ID }];
    },
    sleep: yieldSleep,
    killFn: async () => ({ verified: true })
  });
  const r = await p;                      // resolves - NOT review_child_failed
  assert.equal(r.status, "failed");
  assert.equal(r.job_id, "review-late1");
  // Discriminating: the single-read fail-fast rejects
  // review_child_failed on the first in-settle empty read and never sees the
  // finalized FAILED record.
});

test("spawn error event rejects review_spawn_error", async () => {
  const child = fakeChild();
  const p = submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: () => { setImmediate(() => child.emit("error", new Error("EPERM"))); return child; },
    listJobsFn: async () => [],
    sleep: yieldSleep,
    killFn: async () => ({ verified: true })
  });
  await assert.rejects(p, (e) => e.code === "review_spawn_error");
});

test("deadline + unverified kill rejects review_kill_unverified with pid and log path", async () => {
  const child = fakeChild();
  let t0 = 0;
  const p = submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: () => child,
    listJobsFn: async () => [],
    now: () => (t0 += 30000),        // fast-forward past deadline + sweep budget
    sleep: async () => {},
    killFn: async () => ({ verified: false })
  });
  await assert.rejects(p, (e) =>
    e.code === "review_kill_unverified" && /pid 7777/.test(e.message) && /log:/.test(e.message));
});

// listJobs failing/hung repeatedly -> retried under deadline: pollOnce swallows ANY listJobsFn
// rejection and returns null so the outer discovery loop retries on its next
// iteration (review-detach.mjs: `try { return await listJobsFn(...); } catch
// { return null; }`) -- this was previously untested; only empty-successful
// reads were pinned. A regression that let a listJobsFn rejection propagate
// (instead of being retried) would reject this submission instead of
// resolving it.
test("discovery retries listJobs failures under the deadline", async () => {
  const child = fakeChild();
  let calls = 0;
  const p = submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: () => child,
    listJobsFn: async (extraEnv) => {
      calls += 1;
      if (calls <= 2) throw new Error("transient");
      return [{ id: "review-retry1", kind: "review", jobClass: "review", status: "completed", pid: null,
        createdAt: new Date().toISOString(), sessionId: extraEnv.CODEX_COMPANION_SESSION_ID }];
    },
    sleep: yieldSleep,
    killFn: async () => { throw new Error("must not kill on success"); }
  });
  const r = await p;
  assert.deepEqual(r, { job_id: "review-retry1", status: "completed" });
  assert.equal(calls, 3);
});

// ---- Final gate fixes: I1 liveness corroboration + I2 multiplicity-log null guard ----

test("multiplicity log guard: all-non-finite-createdAt terminals reject discovery_timeout, not a TypeError (final-gate I2)", async () => {
  const child = fakeChild();
  let tag = null;
  let t0 = 0;
  const p = submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: () => child,
    listJobsFn: async (extraEnv) => {
      if (extraEnv && extraEnv.CODEX_COMPANION_SESSION_ID) tag = extraEnv.CODEX_COMPANION_SESSION_ID;
      if (!tag) return [];
      // Two same-tag/kind/jobClass TERMINAL records, both non-finite createdAt:
      // drives matchTagged's fail-closed {record: null, multiple: true} shape
      // through taggedMatch's multiplicity log line.
      return [
        { id: "review-multi1", kind: "review", jobClass: "review", status: "completed", pid: null,
          createdAt: "not-a-date", sessionId: tag },
        { id: "review-multi2", kind: "review", jobClass: "review", status: "completed", pid: null,
          createdAt: "not-a-date", sessionId: tag }
      ];
    },
    now: () => (t0 += 30000),        // fast-forward past deadline + sweep budget
    sleep: yieldSleep,
    killFn: async () => ({ verified: true })
  });
  // Before the I2 guard, taggedMatch's "m.record.id" access on {record: null,
  // multiple: true} throws a raw TypeError instead of ever reaching the
  // timeout rejection -- assert.rejects's checker fails a TypeError against
  // e.code === "review_discovery_timeout" (undefined !== the string).
  await assert.rejects(p, (e) => e.code === "review_discovery_timeout");
});

test("synchronous spawn throw rejects review_spawn_error (final-gate I3)", async () => {
  let killed = false;
  const p = submitDetachedReview({ argv: ["review", "--json"], cwd: process.cwd() }, {
    spawn: () => { throw new Error("EMFILE"); },
    listJobsFn: async () => [],
    sleep: yieldSleep,
    killFn: async () => { killed = true; return { verified: true }; }
  });
  // Before the I3 fix, the catch-less try/finally lets this raw Error (no
  // .code) escape submitDetachedReview instead of the promised coded
  // rejection -- e.code === "review_spawn_error" fails against undefined.
  await assert.rejects(p, (e) => e.code === "review_spawn_error" && /EMFILE/.test(e.message));
  assert.equal(killed, false);
});

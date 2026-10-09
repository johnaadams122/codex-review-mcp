// tests/gate-recovery.ladder.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runLadder, makeRecheck } from "../hooks/gate-recovery.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, BETA, DELTA } from "./helpers/policy-fixture.mjs";

// the auto-gate allowlist is read from the policy settings file: list only the synthetic beta project
installPolicyFixture({ after }, { gateAllowlist: [BETA.name] });

const okRecheck = async () => ({ ok: true });
const attest = { backbone_attested: true };
function once(seq) { let i = 0; return async () => seq[Math.min(i++, seq.length - 1)]; }

test("clean pass returns immediately without a second attempt", async () => {
  let calls = 0;
  const runGateOnce = async () => { calls++; return { status: "complete", consensus_verdict: "pass", blockers: [], reviewers: [], abstentions: [], identity_errors: [], strength: attest }; };
  const v = await runLadder({ event: {}, runId: "R1", targetKey: "d1", payloadRef: {} }, { runGateOnce, recheck: okRecheck, isLiveEpoch: () => true, epoch: 1 });
  assert.equal(v.status, "pass"); assert.equal(calls, 1); assert.equal(v.reviewer, "codex:sol");
});

test("incompleteness retries once then ends FAILED with a reason", async () => {
  const inc = { status: "complete", consensus_verdict: "block", blockers: [], reviewers: [], abstentions: [{ reason: "missing" }], identity_errors: [], diff_truncated: false, strength: attest };
  const runGateOnce = once([inc, inc]);
  const v = await runLadder({ event: {}, runId: "R1", targetKey: "d1", payloadRef: {} }, { runGateOnce, recheck: okRecheck, isLiveEpoch: () => true, epoch: 1 });
  assert.equal(v.status, "failed");
  assert.equal(v.attempts.length, 2);
});

test("mid-ladder FILE opt-out halts before the second attempt", async () => {
  const inc = { status: "complete", consensus_verdict: "block", blockers: [], reviewers: [], abstentions: [{ reason: "missing" }], identity_errors: [], diff_truncated: false, strength: attest };
  let rechecks = 0;
  const recheck = () => (++rechecks >= 2 ? { ok: false, reason: "opted_out" } : { ok: true });
  const v = await runLadder({ event: {}, runId: "R1", targetKey: "d1", payloadRef: {} }, { runGateOnce: once([inc]), recheck, isLiveEpoch: () => true, epoch: 1 });
  assert.equal(v.status, "failed");
  assert.equal(v.failure_reason, "opted_out");
});

test("superseded epoch aborts without writing a verdict", async () => {
  const v = await runLadder({ event: {}, runId: "R1", targetKey: "d1", payloadRef: {} }, { runGateOnce: async () => { throw new Error("must not run"); }, recheck: okRecheck, isLiveEpoch: () => false, epoch: 1 });
  assert.equal(v.status, "superseded");
});

test("makeRecheck HALTS when .codex-autogate is removed mid-run (FILE opt-out)", async (t) => {
  const r = tempDirFor(t, "recheck-");   // no .codex-autogate present
  const recheck = makeRecheck(r, {
    readFile: () => "diff --git a/x b/x\n+1", computePayloadFiles: () => ({ payload_files: ["x"] }),
    realpath: (p) => p, resolvePolicy: () => ({ pii_sensitive: false, name: BETA.name }),
  });
  const out = await recheck({ payloadRef: { kind: "patch", path: "/x" }, attempt: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "opted_out");
});

test("makeRecheck PASSES a clean, opted-in, non-PII payload", async (t) => {
  const r = tempDirFor(t, "recheck-");
  fs.writeFileSync(path.join(r, ".codex-autogate"), "");
  const recheck = makeRecheck(r, {
    readFile: () => "diff --git a/x b/x\n+1", computePayloadFiles: () => ({ payload_files: ["x"] }),
    realpath: (p) => p, resolvePolicy: () => ({ pii_sensitive: false, name: BETA.name }),
  });
  const out = await recheck({ payloadRef: { kind: "patch", path: "/x" }, attempt: 2 });
  assert.equal(out.ok, true);
});

test("a FAILURE-terminal kind (budget_capped) does NOT retry -- one gate call, status failed", async () => {
  // Discriminates a regression that moved budget_capped OUT of TERMINAL_KINDS (which would retry, calls==2).
  let calls = 0;
  const capped = { status: "complete", consensus_verdict: "block", blockers: [], reviewers: [], abstentions: [{ reason: "budget_capped" }], identity_errors: [], diff_truncated: false, strength: attest };
  const runGateOnce = async () => { calls++; return capped; };
  const v = await runLadder({ event: {}, runId: "R1", targetKey: "d1", payloadRef: {} }, { runGateOnce, recheck: okRecheck, isLiveEpoch: () => true, epoch: 1 });
  assert.equal(v.status, "failed");
  assert.equal(v.failure_reason, "budget");
  assert.equal(calls, 1);                 // TERMINAL -> no second attempt
  assert.equal(v.attempts.length, 1);
});

test("a config_error terminal (non-complete status) does NOT retry", async () => {
  let calls = 0;
  const runGateOnce = async () => { calls++; return { status: "strength_below_floor", consensus_verdict: "error", blockers: [], reviewers: [], abstentions: [], identity_errors: [], strength: attest }; };
  const v = await runLadder({ event: {}, runId: "R1", targetKey: "d1", payloadRef: {} }, { runGateOnce, recheck: okRecheck, isLiveEpoch: () => true, epoch: 1 });
  assert.equal(v.status, "error");        // STATUS_OF[config_error]
  assert.equal(calls, 1);
});

test("makeRecheck FAILS CLOSED on a NON-ARRAY (string) payload_files -- parity with classify", async (t) => {
  // A string payload_files would iterate char-by-char in piiScanPayload's for..of and vacuously pass
  // (fail-OPEN). The Array.isArray guard must fail closed. Not reachable via real computePayloadFiles,
  // but defense-in-depth parity with the launcher's classify guard.
  const r = tempDirFor(t, "recheck-");
  fs.writeFileSync(path.join(r, ".codex-autogate"), "");
  const recheck = makeRecheck(r, {
    readFile: () => "diff --git a/x b/x\n+1", computePayloadFiles: () => ({ payload_files: "not-an-array" }),
    realpath: (p) => p, resolvePolicy: () => ({ pii_sensitive: false, name: BETA.name }),
  });
  const out = await recheck({ payloadRef: { kind: "patch", path: "/x" }, attempt: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "payload_parse_error");
});

test("makeRecheck FAILS CLOSED when a payload FILE is now PII (allowlisted root, PII file) -- newly-PII blocks the rung", async (t) => {
  const r = tempDirFor(t, "recheck-");
  fs.writeFileSync(path.join(r, ".codex-autogate"), "");
  const recheck = makeRecheck(r, {
    readFile: () => "diff --git a/x b/x\n+1", computePayloadFiles: () => ({ payload_files: ["x"] }),
    realpath: (p) => p,
    // root resolves allowlisted (passes the allowlist gate); the payload file resolves into a PII tree.
    resolvePolicy: (p) => (p === r ? { name: BETA.name, pii_sensitive: false } : { name: DELTA.name, pii_sensitive: true }),
  });
  const out = await recheck({ payloadRef: { kind: "patch", path: "/x" }, attempt: 1 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /^pii_/);      // fail closed on a newly-PII payload path
});

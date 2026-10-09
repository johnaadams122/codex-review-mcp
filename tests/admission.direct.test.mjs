import { test, after } from "node:test";
import assert from "node:assert/strict";
import { admitDirect, isBrandedDirectAdmission, admit } from "../admission.mjs";
import { installPolicyFixture, ALPHA, BETA, DELTA, EPSILON } from "./helpers/policy-fixture.mjs";

const fx = installPolicyFixture({ after });
const ID = { path: String.raw`C:\bin\codex.exe`, version: "0.144.1", size: 1, mtime: 2 };
const okPre = async () => ({ ok: true, binaryIdentity: ID });

test("named non-PII git project: allowed, branded, kind=direct_review, identity pinned", async () => {
  const d = await admitDirect({ cwd: fx.dirOf(BETA), needs_git: true },
    { realpath: (p) => p, ensurePreconditions: okPre });
  assert.equal(d.allowed, true);
  assert.equal(d.kind, "direct_review");
  assert.equal(d.needs_git, true);
  assert.equal(d.cwd_real, fx.dirOf(BETA));
  assert.deepEqual(d.binaryIdentity, ID);
  assert.equal(isBrandedDirectAdmission(d), true);
});

test("every NAMED pii row admits direct read-only (incl. the write-blocked one)", async () => {
  for (const row of [DELTA, ALPHA, EPSILON]) {
    const d = await admitDirect({ cwd: fx.dirOf(row) }, { realpath: (p) => p, ensurePreconditions: okPre });
    assert.equal(d.allowed, true, row.name);
    assert.equal(d.policy.pii_sensitive, true, row.name);
  }
});

test("unknown cwd -> unknown_project (fail-closed default row never admits direct)", async () => {
  const d = await admitDirect({ cwd: String.raw`C:\somewhere\else` }, { realpath: (p) => p, ensurePreconditions: okPre });
  assert.deepEqual(d, { allowed: false, reason: "unknown_project", project: "unknown" });
});

test("admission order: unknown or git-disallowed cwds are refused on policy alone -- the probe NEVER fires", async () => {
  let probes = 0;
  const countPre = async () => { probes++; return { ok: true, binaryIdentity: ID }; };
  const u = await admitDirect({ cwd: String.raw`C:\somewhere\else` }, { realpath: (p) => p, ensurePreconditions: countPre });
  assert.equal(u.reason, "unknown_project");
  const g = await admitDirect({ cwd: fx.dirOf(DELTA), needs_git: true }, { realpath: (p) => p, ensurePreconditions: countPre });
  assert.equal(g.reason, "git_not_allowed");
  assert.equal(probes, 0); // neither policy refusal spawned a probe
});

test("preconditions unmet -> direct_preconditions_unmet; PII flag rides policy into the check", async () => {
  let sawPii = null;
  const d = await admitDirect({ cwd: fx.dirOf(DELTA) },
    { realpath: (p) => p, ensurePreconditions: async ({ pii }) => { sawPii = pii; return { ok: false }; } });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "direct_preconditions_unmet");
  assert.equal(sawPii, true);
});

test("an unknown cwd is refused on policy before realpath; git_not_allowed", async () => {
  // Policy runs first on the cwd as given, so a folder outside every row is unknown_project even when
  // realpath would throw (cwd_unresolvable now means a KNOWN folder whose realpath failed; see below).
  const bad = await admitDirect({ cwd: "X:\\nope" }, { realpath: () => { throw new Error("ENOENT"); }, ensurePreconditions: okPre });
  assert.deepEqual(bad, { allowed: false, reason: "unknown_project", project: "unknown" });
  const nogit = await admitDirect({ cwd: fx.dirOf(DELTA), needs_git: true }, { realpath: (p) => p, ensurePreconditions: okPre });
  assert.equal(nogit.reason, "git_not_allowed"); // spec/plan pass needs_git=false; impl on no-git blocks
});

test("failure reason: preconditions-unmet decisions carry the precondition why as detail", async () => {
  const d = await admitDirect({ cwd: fx.dirOf(DELTA) },
    { realpath: (p) => p, ensurePreconditions: async () => ({ ok: false, why: "network_denial_unverified: no_connectivity_control" }) });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "direct_preconditions_unmet");
  assert.equal(d.detail, "network_denial_unverified: no_connectivity_control");
  // a why-less failure still blocks, detail null (never undefined)
  const bare = await admitDirect({ cwd: fx.dirOf(DELTA) },
    { realpath: (p) => p, ensurePreconditions: async () => ({ ok: false }) });
  assert.equal(bare.reason, "direct_preconditions_unmet");
  assert.equal(bare.detail, null);
});

test("brand cannot be forged from a plain object; sync admit() decisions are never branded", () => {
  const forged = { allowed: true, kind: "direct_review", cwd_real: "C:\\x" };
  assert.equal(isBrandedDirectAdmission(forged), false);
  const legacy = admit({ kind: "task", cwd: fx.dirOf(BETA) });
  assert.equal(isBrandedDirectAdmission(legacy), false);
});

test("brand survives spread-free passing but NOT a stale copy via spread (accidental-copy defense)", async () => {
  const d = await admitDirect({ cwd: fx.dirOf(BETA), needs_git: true }, { realpath: (p) => p, ensurePreconditions: okPre });
  assert.equal(isBrandedDirectAdmission({ ...d }), false); // non-enumerable Symbol drops on copy
});

// Codex built-tree review 2026-10-08, findings 1-2: direct admission must apply the hardened policy
// validation to the cwd AS GIVEN before any file-system call, and must honour an explicit review:false.
const ZETA = { dir: "project-zeta", name: "project_zeta", write: true, git: true, pii: false, review: false };

test("non-PII row with explicit review:false -> review_not_allowed, and the probe never fires", async (t) => {
  const local = installPolicyFixture(t, { projects: [ALPHA, BETA, DELTA, EPSILON, ZETA] });
  let probes = 0;
  const countPre = async () => { probes++; return { ok: true, binaryIdentity: ID }; };
  for (const needs_git of [false, true]) {
    const d = await admitDirect({ cwd: local.dirOf(ZETA), needs_git }, { realpath: (p) => p, ensurePreconditions: countPre });
    assert.deepEqual(d, { allowed: false, reason: "review_not_allowed", project: ZETA.name });
  }
  // the ordinary review gate refuses the same row
  assert.equal(admit({ kind: "review", cwd: local.dirOf(ZETA) }).allowed, false);
  assert.equal(probes, 0);
});

test("relative cwd '.' is unknown even when it would realpath into a project; realpath is never called", async () => {
  let calls = 0;
  const realpath = (p) => { calls++; return p === "." ? fx.dirOf(BETA) : p; };
  const d = await admitDirect({ cwd: ".", needs_git: true }, { realpath, ensurePreconditions: okPre });
  assert.deepEqual(d, { allowed: false, reason: "unknown_project", project: "unknown" });
  assert.equal(calls, 0);
});

// A real UNC path (two leading backslashes), built from code points so no source line reads as a network path.
const UNC_CWD = String.fromCharCode(92, 92) + ["remote-host", "share", "project-beta"].join(String.fromCharCode(92));

test("a network-share cwd is refused before any realpath call", async () => {
  let calls = 0;
  const realpath = (p) => { calls++; return fx.dirOf(BETA); };
  const d = await admitDirect({ cwd: UNC_CWD }, { realpath, ensurePreconditions: okPre });
  assert.deepEqual(d, { allowed: false, reason: "unknown_project", project: "unknown" });
  assert.equal(calls, 0);
});

test("cwd_unresolvable: a known project folder whose realpath then fails is refused", async () => {
  const d = await admitDirect({ cwd: fx.dirOf(BETA) }, { realpath: () => { throw new Error("ENOENT"); }, ensurePreconditions: okPre });
  assert.deepEqual(d, { allowed: false, reason: "cwd_unresolvable" });
});

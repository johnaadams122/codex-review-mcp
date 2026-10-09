// tests/gate-run.pii.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { piiScanPayload } from "../hooks/gate-run.mjs";

const realpath = (p) => p; // identity for the test
test("piiScanPayload SKIPS a deleted/absent path (realpath ENOENT) instead of failing the whole commit", () => {
  const rp = (p) => { if (String(p).includes("deleted")) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return p; };
  const r = piiScanPayload("/repo", ["src/ok.js", "src/deleted.js"], { realpath: rp, resolvePolicy: () => ({ pii_sensitive: false, name: "project_beta" }) });
  assert.equal(r.ok, true);   // the deleted path is skipped (absent != PII); the commit still auto-gates
});
test("piiScanPayload blocks when any payload file resolves into a PII tree", () => {
  const policy = (p) => p.includes("restricted") ? { pii_sensitive: true, name: "project_delta" } : { pii_sensitive: false, name: "project_beta" };
  const r = piiScanPayload("/repo", ["src/ok.js", "restricted/leak.md"], { realpath, resolvePolicy: policy });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^pii_/);
});

test("piiScanPayload passes a clean non-PII payload", () => {
  const policy = () => ({ pii_sensitive: false, name: "project_beta" });
  assert.deepEqual(piiScanPayload("/repo", ["src/ok.js"], { realpath, resolvePolicy: policy }), { ok: true });
});

test("piiScanPayload fails closed when realpath throws", () => {
  const throwing = () => { throw new Error("ENOENT"); };
  const r = piiScanPayload("/repo", ["src/ok.js"], { realpath: throwing, resolvePolicy: () => ({ pii_sensitive: false, name: "x" }) });
  assert.equal(r.ok, false);
});

test("piiScanPayload FAILS CLOSED on a per-file NON-ENOENT realpath error (ONLY ENOENT is skipped)", () => {
  // Discriminates the fail-OPEN mutation `catch { continue }` (skip ALL errors): a per-file EACCES must
  // BLOCK, not skip. Root + the clean file resolve fine; only the "locked" file throws EACCES.
  const rp = (p) => { if (String(p).includes("locked")) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return p; };
  const r = piiScanPayload("/repo", ["src/ok.js", "src/locked.js"], { realpath: rp, resolvePolicy: () => ({ pii_sensitive: false, name: "project_beta" }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "pii_unresolvable");   // NOT skipped, NOT the root reason -> per-file block
});

test("piiScanPayload FAILS CLOSED when the ROOT realpath throws ENOENT (root resolved once, no ENOENT carve-out) -- fail-open regression guard", () => {
  // An earlier design bundled the root into the per-file try with ENOENT->continue, so a root ENOENT
  // silently PASSED (fail-open). Here the root throw -- even ENOENT -- must BLOCK; the clean file never gets a chance.
  const rp = (p) => { if (p === "/repo") { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return p; };
  const r = piiScanPayload("/repo", ["src/ok.js"], { realpath: rp, resolvePolicy: () => ({ pii_sensitive: false, name: "project_beta" }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "pii_root_unresolvable");
});

test("piiScanPayload blocks a payload file whose realpath ESCAPES cwd_real (containment)", () => {
  const r = piiScanPayload("/repo", ["../outside/secret"], { realpath, resolvePolicy: () => ({ pii_sensitive: false, name: "x" }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "path_not_contained");
});

test("piiScanPayload blocks an unknown-policy (default pii:true) destination fail-closed", () => {
  const r = piiScanPayload("/repo", ["src/x.js"], { realpath, resolvePolicy: () => ({ pii_sensitive: true, name: "unknown" }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^pii_/);
});

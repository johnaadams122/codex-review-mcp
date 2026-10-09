import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../panel.mjs";

// Outcome builders. Backbone/advisory outcomes carry an assignment_id that aggregate matches
// against the manifest BY IDENTITY. model/effort ride on the verdict for strength recording.
function outcome(assignment_id, lens, role, ok, verdictOrReason, findings = [], model = "gpt-6.1-sol", effort = "xhigh") {
  if (!ok) return { assignment_id, lens, role, ok: false, reason: verdictOrReason, model, effort };
  return {
    assignment_id, lens, role, ok: true, model, effort,
    verdict: { lens, role, verdict: verdictOrReason, confidence: "high", findings, model, effort },
  };
}
const bbPass = (id, lens) => outcome(id, lens, "backbone", true, "pass");
const bbBlock = (id, lens) => outcome(id, lens, "backbone", true, "block", [{ severity: "blocker", file: "f", line: 1, summary: "x" }]);
const bbAbstain = (id, lens, reason) => outcome(id, lens, "backbone", false, reason);
const advPass = (id, lens, model = "gpt-6-luna", effort = "low") => outcome(id, lens, "advisory", true, "pass", [], model, effort);
const advBlock = (id, lens) => outcome(id, lens, "advisory", true, "block", [{ severity: "blocker", file: "f", line: 1, summary: "y" }], "gpt-6.1-sol", "medium");
const advUnavail = (id, lens, reason = "unavailable") => outcome(id, lens, "advisory", false, reason);

const bb = (id, lens) => ({ assignment_id: id, lens, role: "backbone" });
const adv = (id, lens) => ({ assignment_id: id, lens, role: "advisory" });

// -------- advisory is additive-strictness only --------

test("advisory UNAVAILABLE is ignored -- backbone-only quorum still passes", () => {
  const outcomes = [bbPass("a1", "a"), bbPass("a2", "b"), advUnavail("x1", "c")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b")], truncated: false });
  assert.equal(r.consensus_verdict, "pass");
  assert.equal(r.abstentions.length, 0, "advisory unavailable must NOT count as a backbone abstention");
  assert.equal(r.advisory_ignored.length, 1);
});

test("EVERY advisory failure class is ignored and never blocks", () => {
  for (const reason of ["unavailable", "submit_failed", "timeout", "result_error", "parse_failed"]) {
    const outcomes = [bbPass("a1", "a"), bbPass("a2", "b"), advUnavail("x1", "c", reason)];
    const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b")] });
    assert.equal(r.consensus_verdict, "pass", `advisory ${reason} must not block`);
  }
});

test("advisory BLOCKER escalates a would-be pass to block", () => {
  const outcomes = [bbPass("a1", "a"), bbPass("a2", "b"), advBlock("x1", "c")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b")] });
  assert.equal(r.consensus_verdict, "block");
});

test("advisory PASS is recorded but never rescues a backbone block", () => {
  const outcomes = [bbPass("a1", "a"), bbBlock("a2", "b"), advPass("x1", "c")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b")] });
  assert.equal(r.consensus_verdict, "block");
});

// -------- backbone quorum is identity-safe --------

test("backbone abstention still blocks (fail-closed)", () => {
  const outcomes = [bbPass("a1", "a"), bbAbstain("a2", "b", "timeout")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b")] });
  assert.equal(r.consensus_verdict, "block");
  assert.equal(r.abstentions.length, 1);
});

test("a duplicate-substitution [a,a,b] with c missing does NOT pass", () => {
  // reviewer a ran twice, b once, c never -- count=3 would fool a count-based quorum.
  const outcomes = [bbPass("a1", "a"), bbPass("a1", "a"), bbPass("a2", "b")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b"), bb("a3", "c")] });
  assert.notEqual(r.consensus_verdict, "pass");
});

test("a completely MISSING backbone assignment blocks (never silently passes)", () => {
  const outcomes = [bbPass("a1", "a"), bbPass("a2", "b")]; // a3 never appeared
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b"), bb("a3", "c")] });
  assert.notEqual(r.consensus_verdict, "pass");
  assert.ok(r.abstentions.some((x) => x.assignment_id === "a3"));
});

test("an UNKNOWN backbone assignment_id (not in the manifest) is an identity error", () => {
  const outcomes = [bbPass("a1", "a"), bbPass("a2", "b"), bbPass("a9", "rogue")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b")] });
  assert.equal(r.consensus_verdict, "error");
});

test("a MALFORMED manifest with a duplicate backbone assignment_id -> error", () => {
  // A duplicate id in the manifest itself (not just in outcomes) must not let a single outcome be
  // double-counted into a false pass.
  const outcomes = [bbPass("a1", "a")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a1", "a")] });
  assert.notEqual(r.consensus_verdict, "pass");
});

test("zero backbone configured -> error", () => {
  const r = aggregate([advPass("x1", "c")], { manifest: [adv("x1", "c")] });
  assert.equal(r.consensus_verdict, "error");
});

test("a required lens with only an ADVISORY assignment (no backbone) -> error", () => {
  const outcomes = [bbPass("a1", "a"), bbPass("a2", "b"), advPass("x1", "c")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b"), adv("x1", "c")] });
  assert.equal(r.consensus_verdict, "error");
});

// -------- strength recording --------

test("strength.weakest reflects the lowest tier that ran (advisory can pull it down)", () => {
  const outcomes = [bbPass("a1", "a"), advPass("x1", "b", "gpt-6-luna", "low")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a")] });
  assert.equal(r.consensus_verdict, "pass");
  assert.equal(r.strength.weakest.model, "gpt-6-luna");
  assert.equal(r.strength.backbone_weakest.model, "gpt-6.1-sol");
  assert.equal(r.strength.advisory_weakest.model, "gpt-6-luna");
});

test("truncated diff can never pass even with a full clean backbone", () => {
  const outcomes = [bbPass("a1", "a"), bbPass("a2", "b")];
  const r = aggregate(outcomes, { manifest: [bb("a1", "a"), bb("a2", "b")], truncated: true });
  assert.equal(r.consensus_verdict, "block");
});

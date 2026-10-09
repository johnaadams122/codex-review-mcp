import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASE_CONFIG, SPEC_LENSES, PLAN_LENSES, IMPL_LENS_KEYS } from "../gate.mjs";

test("PHASE_CONFIG floors: spec/plan flagship, impl standard", () => {
  assert.equal(PHASE_CONFIG.spec.floor, "flagship");
  assert.equal(PHASE_CONFIG.plan.floor, "flagship");
  assert.equal(PHASE_CONFIG.impl.floor, "standard");
});

test("PHASE_CONFIG strengths match the floors (spec/plan sol, impl terra)", () => {
  assert.equal(PHASE_CONFIG.spec.strength.model, "gpt-6.1-sol");
  assert.equal(PHASE_CONFIG.spec.strength.effort, "xhigh");
  assert.equal(PHASE_CONFIG.impl.strength.model, "gpt-6.1-sol");
  assert.equal(PHASE_CONFIG.impl.strength.effort, "medium");
});

test("spec lenses are the three internal-quality dimensions", () => {
  assert.deepEqual(SPEC_LENSES.map((l) => l.key), ["completeness-gaps", "contradictions-ambiguity", "edge-cases-risks"]);
  assert.ok(SPEC_LENSES.every((l) => typeof l.instruction === "string" && l.instruction.length > 0));
});

test("plan lenses cover ordering/deps, test-coverage, scope-fidelity", () => {
  assert.deepEqual(PLAN_LENSES.map((l) => l.key), ["ordering-dependencies", "test-coverage", "scope-fidelity"]);
});

test("impl reuses the panel's correctness + security-pii code lenses", () => {
  assert.deepEqual(IMPL_LENS_KEYS, ["correctness", "security-pii"]);
});

// tests/gate-recovery.labels.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewerLabel, MODEL_SHORTNAME } from "../hooks/gate-recovery.mjs";

test("attested backbone renders a bare codex:sol", () => {
  assert.equal(reviewerLabel({ strength: { backbone_attested: true } }), "codex:sol");
});
test("unattested backbone renders the (requested, unattested) qualifier", () => {
  assert.equal(reviewerLabel({ strength: { backbone_attested: false } }), "codex:sol (requested, unattested)");
  assert.equal(reviewerLabel({ strength: {} }), "codex:sol (requested, unattested)"); // missing -> unattested
});
test("attestation is STRICT === true: a truthy-but-not-true value is NOT trusted as attested", () => {
  // Discriminates a truthy-loose `Boolean(...)` regression from the shipped `=== true`. A string/number
  // is truthy but must NOT produce the bare (trusted) label -- a false trust signal.
  assert.equal(reviewerLabel({ strength: { backbone_attested: "true" } }), "codex:sol (requested, unattested)");
  assert.equal(reviewerLabel({ strength: { backbone_attested: 1 } }), "codex:sol (requested, unattested)");
});
test("shortname map covers the legacy GPT-5.6 tiers and the gpt-6.1 sol tier", () => {
  assert.equal(MODEL_SHORTNAME["gpt-5.6-terra"], "terra");
  assert.equal(MODEL_SHORTNAME["gpt-6.1-sol"], "sol");
  assert.equal(MODEL_SHORTNAME["gpt-5.6-luna"], "luna");
});

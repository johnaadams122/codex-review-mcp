import { test } from "node:test";
import assert from "node:assert/strict";
import { tierOf, tierRank, belowFloor } from "../strength.mjs";
import { MAX_STRENGTH, CODEX_TIERS } from "../routing.mjs";

test("MAX_STRENGTH is exactly (gpt-6-astra, max) and ranks above flagship", () => {
  assert.deepEqual(MAX_STRENGTH, { model: "gpt-6-astra", effort: "max" });
  assert.equal(tierOf(MAX_STRENGTH), "max");
  assert.equal(tierRank("max"), 5);
  assert.ok(tierRank("max") > tierRank("flagship"));
});

test("astra ranks above flagship and below max", () => {
  assert.equal(tierOf({ model: "gpt-6-astra", effort: "xhigh" }), "astra");
  assert.equal(tierRank("astra"), 4);
  assert.ok(tierRank("astra") > tierRank("flagship"));
  assert.ok(tierRank("astra") < tierRank("max"));
});

test("max satisfies every existing floor", () => {
  assert.equal(belowFloor(MAX_STRENGTH, "flagship"), false);
  assert.equal(belowFloor(MAX_STRENGTH, "standard"), false);
  assert.equal(belowFloor(MAX_STRENGTH, "fast"), false);
});

test("cross-combos with 'max' effort stay unknown (exact-match preserved)", () => {
  assert.equal(tierOf({ model: "gpt-5.6-terra", effort: "max" }), "unknown");
  assert.equal(tierOf({ model: "gpt-6-luna", effort: "max" }), "unknown");
  assert.equal(tierOf({ model: "gpt-6.1-sol", effort: "xhigh" }), "flagship");
  assert.equal(tierOf({ model: "gpt-6.1-sol", effort: "high" }), "unknown");
  assert.equal(tierOf({ model: "gpt-5.6-sol", effort: "xhigh" }), "unknown"); // retired flagship model: exact-match only
});

test("CODEX_TIERS untouched by the max-strength mechanism (delegate surface unaffected)", () => {
  assert.deepEqual(Object.keys(CODEX_TIERS).sort(), ["astra", "fast", "fast_review", "flagship", "standard"]);
});

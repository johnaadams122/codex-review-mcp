import { test } from "node:test";
import assert from "node:assert/strict";
import { tierOf, tierRank, belowFloor } from "../strength.mjs";

// -------- exact-match ONLY --------

test("tierOf maps the three exact CODEX_TIERS pairs to their named tiers", () => {
  assert.equal(tierOf({ model: "gpt-6.1-sol", effort: "xhigh" }), "flagship");
  assert.equal(tierOf({ model: "gpt-6.1-sol", effort: "medium" }), "standard");
  assert.equal(tierOf({ model: "gpt-6-luna", effort: "low" }), "fast");
});

test("EVERY cross-combo of a known model with the wrong effort -> unknown (rank 0)", () => {
  const models = ["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6-luna"];
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const exact = new Set(["gpt-6.1-sol|xhigh", "gpt-6.1-sol|medium", "gpt-6-luna|low", "gpt-6-luna|high"]);
  for (const model of models) {
    for (const effort of efforts) {
      const expected = exact.has(`${model}|${effort}`);
      const named = tierOf({ model, effort }) !== "unknown";
      assert.equal(named, expected, `${model}/${effort} should ${expected ? "" : "NOT "}be a named tier`);
    }
  }
});

test("an unknown model or unknown effort -> unknown, and unknown can never satisfy a real floor", () => {
  assert.equal(tierOf({ model: "mystery", effort: "high" }), "unknown");
  assert.equal(tierOf({ model: "gpt-6.1-sol", effort: undefined }), "unknown");
  assert.equal(tierOf({}), "unknown");
  assert.equal(tierRank("unknown"), 0);
  assert.equal(belowFloor({ model: "mystery", effort: "high" }, "standard"), true);
  assert.equal(belowFloor({ model: "mystery", effort: "high" }, "fast"), true);
});

test("tierRank orders flagship(3) > standard(2) > fast(1) > unknown(0)", () => {
  assert.ok(tierRank("flagship") > tierRank("standard"));
  assert.ok(tierRank("standard") > tierRank("fast"));
  assert.ok(tierRank("fast") > tierRank("unknown"));
});

test("tierRank uses own-property lookup (no prototype pollution)", () => {
  // A floor/tier name colliding with an Object.prototype member must rank 0, never an inherited fn.
  assert.equal(tierRank("constructor"), 0);
  assert.equal(tierRank("toString"), 0);
  assert.equal(tierRank("hasOwnProperty"), 0);
  // and a real strength can never be judged "below" a bogus prototype-named floor via NaN comparison
  assert.equal(belowFloor({ model: "gpt-6.1-sol", effort: "medium" }, "constructor"), false);
});

test("belowFloor compares by rank", () => {
  assert.equal(belowFloor({ model: "gpt-6.1-sol", effort: "medium" }, "flagship"), true);
  assert.equal(belowFloor({ model: "gpt-6.1-sol", effort: "xhigh" }, "flagship"), false);
  assert.equal(belowFloor({ model: "gpt-6-luna", effort: "low" }, "standard"), true);
  assert.equal(belowFloor({ model: "gpt-6.1-sol", effort: "xhigh" }, "fast"), false);
});

test("fast_review (gpt-6-luna/high) is its own tier, ranked between fast and standard", () => {
  assert.equal(tierOf({ model: "gpt-6-luna", effort: "high" }), "fast_review");
  assert.equal(tierOf({ model: "gpt-6-luna", effort: "medium" }), "unknown");
  assert.ok(tierRank("fast_review") > tierRank("fast"));
  assert.ok(tierRank("fast_review") < tierRank("standard"));
  assert.equal(belowFloor({ model: "gpt-6-luna", effort: "high" }, "standard"), true);
  assert.equal(belowFloor({ model: "gpt-6-luna", effort: "high" }, "fast"), false);
});
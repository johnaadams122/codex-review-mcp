import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTransport } from "../reviewers.mjs";
import { MAX_STRENGTH, CODEX_TIERS } from "../routing.mjs";

const SOL = { model: CODEX_TIERS.flagship.model, effort: CODEX_TIERS.flagship.effort };

test("all-max -> direct; none-max -> companion; mixed -> mixed", () => {
  assert.equal(pickTransport([MAX_STRENGTH, MAX_STRENGTH, MAX_STRENGTH]), "direct");
  assert.equal(pickTransport([SOL, SOL]), "companion");
  assert.equal(pickTransport([MAX_STRENGTH, SOL]), "mixed");
});

test("an all-max per-lens map over a non-max default IS a direct run", () => {
  assert.equal(pickTransport([MAX_STRENGTH]), "direct");
});

test("unknown pairs are not max (fail toward companion, where floors catch them)", () => {
  assert.equal(pickTransport([{ model: "gpt-6.1-sol", effort: "max" }]), "companion");
  assert.equal(pickTransport([]), "companion");
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, isAllowlisted } from "../hooks/gate-run.config.mjs";
import { loadPolicyConfig } from "../policy.mjs";
import { installPolicyFixture, ALPHA, BETA } from "./helpers/policy-fixture.mjs";

test("CONFIG pins conservative telemetry defaults and is frozen", () => {
  assert.equal(CONFIG.budget.dailyJobCap, 20);
  assert.equal(CONFIG.attempts.maxCodex, 2);            // hard ladder cap
  assert.equal(CONFIG.deadlines.perAttemptMs, 8 * 60 * 1000);
  assert.equal(CONFIG.deadlines.killWaitMs, 10000);     // reuse KILL_WAIT_MS
  assert.equal(CONFIG.cadenceMs, 15 * 60 * 1000);       // reuse SWEEP_INTERVAL_MS
  assert.equal(CONFIG.trigger, "commit");
  assert.ok(Object.isFrozen(CONFIG));
});

test("CONFIG carries no project names: the allowlist lives in the policy settings file", () => {
  assert.equal("allowlist" in CONFIG, false);
});

test("isAllowlisted reads gateAllowlist from the policy settings file and admits only those UNDERSCORE names", () => {
  // resolvePolicy(cwd).name is an UNDERSCORE id. A hyphenated form matches NOTHING and would skip
  // every real commit.
  installPolicyFixture({ after }, { gateAllowlist: [ALPHA.name, BETA.name] });
  assert.equal(isAllowlisted("project_alpha"), true);
  assert.equal(isAllowlisted("project_beta"), true);
  assert.equal(isAllowlisted("project-alpha"), false);   // the hyphen form must NOT match
  assert.equal(isAllowlisted("project_gamma"), false);   // a known project that is not listed
  assert.equal(isAllowlisted("project_other"), false);
  assert.equal(isAllowlisted("unknown"), false);
  assert.equal(isAllowlisted(undefined), false);
});

test("an absent gateAllowlist means nothing is allowlisted (default empty)", (t) => {
  installPolicyFixture(t);
  assert.equal(isAllowlisted("project_alpha"), false);
  assert.equal(isAllowlisted("project_beta"), false);
});

test("isAllowlisted accepts an explicit config (and a failed load allowlists nothing)", (t) => {
  const fx = installPolicyFixture(t, { gateAllowlist: [BETA.name] });
  assert.equal(isAllowlisted("project_beta", loadPolicyConfig(fx.file)), true);
  const failed = { ok: false, reason: "file_missing", projectsBase: "", table: [], gateAllowlist: [] };
  assert.equal(isAllowlisted("project_beta", failed), false);
});

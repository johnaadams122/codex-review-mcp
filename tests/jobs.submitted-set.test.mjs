// Pure-unit tests for the
// in-process submitted-job registry (used instead of a forgeable on-disk token sidecar).
// The wiring into the read gate is exercised in jobs.ownership.test.mjs and the fully
// un-mocked path in jobs.same-session.test.mjs. Each test imports a FRESH jobs.mjs
// module instance (distinct query string) so the module-level registry is isolated --
// modeling a distinct server process.
import { test } from "node:test";
import assert from "node:assert/strict";

test("recordSubmittedJob + isSubmittedBySelf: a submitted id is owned; an unknown id fails closed; a reset owns nothing", async () => {
  const j = await import("../jobs.mjs?subset=a");
  j._resetSubmittedJobs();
  assert.equal(j.isSubmittedBySelf("job-1"), false);        // not submitted yet
  j.recordSubmittedJob("job-1", "C:/proj/x");
  assert.equal(j.isSubmittedBySelf("job-1"), true);
  assert.equal(j.isSubmittedBySelf("job-2"), false);        // a different id -> fail closed
  j._resetSubmittedJobs();                                  // a fresh process starts empty
  assert.equal(j.isSubmittedBySelf("job-1"), false);
});

test("recordSubmittedJob ignores a bad id; deps.submittedJobs overrides the module registry", async () => {
  const j = await import("../jobs.mjs?subset=b");
  j._resetSubmittedJobs();
  assert.equal(j.recordSubmittedJob("", "C:/x"), "");       // no-op on a falsy id (still returns it)
  assert.equal(j.isSubmittedBySelf(""), false);
  assert.equal(j.isSubmittedBySelf(null), false);           // non-string -> fail closed
  // An injected set overrides the (empty) module registry; both Map and Set answer membership.
  assert.equal(j.isSubmittedBySelf("inj", { submittedJobs: new Map([["inj", "C:/x"]]) }), true);
  assert.equal(j.isSubmittedBySelf("inj", { submittedJobs: new Set(["inj"]) }), true);
  assert.equal(j.isSubmittedBySelf("nope", { submittedJobs: new Map() }), false);
});

test("hasSubmittedForCwd: true iff THIS process submitted a job under that cwd", async () => {
  const j = await import("../jobs.mjs?subset=c");
  j._resetSubmittedJobs();
  j.recordSubmittedJob("job-x", "C:/proj/with space");
  assert.equal(j.hasSubmittedForCwd("C:/proj/with space"), true);
  assert.equal(j.hasSubmittedForCwd("C:/proj/other"), false);   // a cwd we submitted nothing under
  assert.equal(j.hasSubmittedForCwd(null), false);              // owner cwd is handled by the owner path
  assert.equal(j.hasSubmittedForCwd(""), false);
  // A job recorded under the owner store (null cwd) never matches a foreign-cwd query.
  j.recordSubmittedJob("job-owner", null);
  assert.equal(j.hasSubmittedForCwd("C:/proj/with space"), true);   // still only job-x matches
  // A bare Set carries no cwd -> it cannot answer a per-cwd query.
  assert.equal(j.hasSubmittedForCwd("C:/proj/with space", { submittedJobs: new Set(["job-x"]) }), false);
});

test("isReadAllowed: (a) same-session submit OR (b) owner cwd grants; neither -> false", async () => {
  const j = await import("../jobs.mjs?subset=d");
  j._resetSubmittedJobs();
  const SELF = { selfWorkspaceRoot: "C:/proj/self", submittedJobs: new Map() };
  // (a) a same-session submit admits ANY admitted target cwd, even a foreign one.
  assert.equal(j.isReadAllowed("j1", "C:/proj/foreign",
    { ...SELF, submittedJobs: new Map([["j1", "C:/proj/foreign"]]) }), true);
  // (b) the owner cwd admits an unsubmitted job (cross-session pickup).
  assert.equal(j.isReadAllowed("j2", "C:/proj/self", SELF), true);
  // A null cwd resolves to the PROCESS launch dir
  // (what the companion actually uses), NOT "trivially the owner store" -- it is
  // owned only when the launch dir matches the configured owner.
  assert.equal(j.isReadAllowed("j2", null, { ...SELF, processCwd: "C:/proj/self" }), true);
  assert.equal(j.isReadAllowed("j2", null, { ...SELF, processCwd: "C:/proj/launchdir" }), false);
  // neither path grants -> fail closed.
  assert.equal(j.isReadAllowed("j2", "C:/proj/foreign", SELF), false);
});

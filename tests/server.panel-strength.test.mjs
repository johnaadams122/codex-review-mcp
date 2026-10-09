import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Replace panel.mjs so we can observe what handlePanel forwards to runPanel. gate.mjs (imported by
// server.mjs) also pulls runPanel/LENSES/gatherDiff/parseDirectTimeout/normalizePayloadPath from
// panel, so the mock must provide all five (gate.mjs has two more import edges into
// this mocked graph -- parseDirectTimeout/normalizePayloadPath are dead in these non-max tests but
// the named-export resolution still requires them present at import time).
let seen;
const fakeRunPanel = mock.fn(async (opts) => {
  seen = opts;
  return { consensus_verdict: "pass", reviewers: [], findings: [], strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true } };
});

await mock.module("../panel.mjs", {
  exports: {
    runPanel: fakeRunPanel,
    LENSES: [{ key: "correctness" }, { key: "security-pii" }, { key: "design-simplicity" }],
    gatherDiff: () => ({ diff: "", bytes: 0, truncated: false, treeClean: true }),
    parseDirectTimeout: () => 1200000,
    normalizePayloadPath: (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase(),
  },
});

const { handlePanel } = await import("../server.mjs?ps=1");
const CWD = "C:\\repo";

test("codex_review_panel default stays flagship (no strength forwarded -> runPanel picks flagship)", async () => {
  seen = undefined;
  await handlePanel({ cwd: CWD });
  assert.equal(seen.model, undefined, "no explicit model -> runPanel falls back to flagship internally");
});

test("codex_review_panel forwards an at-floor (flagship) override", async () => {
  seen = undefined;
  await handlePanel({ cwd: CWD, strength: { model: "gpt-6.1-sol", effort: "xhigh" } });
  assert.equal(seen.model, "gpt-6.1-sol");
  assert.equal(seen.effort, "xhigh");
});

test("a BELOW-floor override is refused with strength_below_floor and never dispatched", async () => {
  fakeRunPanel.mock.resetCalls();
  const res = await handlePanel({ cwd: CWD, strength: { model: "gpt-6.1-sol", effort: "medium" } });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.status, "strength_below_floor");
  assert.equal(res.isError, true);
  assert.equal(fakeRunPanel.mock.calls.length, 0, "a below-floor override must NOT reach runPanel");
});

test("a pass whose effective backbone strength fell below the floor is downgraded to error", async () => {
  fakeRunPanel.mock.mockImplementationOnce(async () => ({
    consensus_verdict: "pass", reviewers: [], findings: [],
    strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "medium" }, backbone_attested: true },
  }));
  const res = await handlePanel({ cwd: CWD });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.status, "strength_below_floor");
  assert.equal(res.isError, true);
});

// Codex built-tree review 2026-10-08, finding 4: a clean working tree returns pass/empty_diff with no
// reviewer and so no strength record. That is a valid result, not a below-floor pass.
test("codex_review_panel: a clean-tree empty_diff pass is returned as a pass, not strength_below_floor", async () => {
  const empty = async () => ({ consensus_verdict: "pass", status: "empty_diff", reviewers: [], findings: [], dissent: [], abstentions: [] });
  const res = await handlePanel({ cwd: CWD }, { runPanel: empty });
  assert.notEqual(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.consensus_verdict, "pass");
  assert.equal(body.status, "empty_diff");
});

test("codex_review_panel: a pass that ran reviewers but carries no strength record still fails closed", async () => {
  const noStrength = async () => ({ consensus_verdict: "pass", reviewers: [{ lens: "correctness" }], findings: [] });
  const res = await handlePanel({ cwd: CWD }, { runPanel: noStrength });
  assert.equal(res.isError, true);
  assert.equal(JSON.parse(res.content[0].text).status, "strength_below_floor");
  // an empty_diff label does not excuse a result that did run reviewers
  const labelled = async () => ({ consensus_verdict: "pass", status: "empty_diff", reviewers: [{ lens: "correctness" }], findings: [] });
  const res2 = await handlePanel({ cwd: CWD }, { runPanel: labelled });
  assert.equal(res2.isError, true);
});

// Codex review of 0c4a967 (2026-10-08): with cwd omitted, the max-strength panel's revision label must be
// read from the same folder admission and the panel use (this process's folder), not from undefined.
test("codex_review_panel max path: an omitted cwd labels the revision of this process's folder", async () => {
  let labelledFrom = "not called";
  const res = await handlePanel({ strength: { model: "gpt-6-astra", effort: "max" } }, {
    admitDirect: async () => ({ allowed: true }),
    revisionLabel: (cwd) => { labelledFrom = cwd; return "revision: test"; },
    runPanel: async () => ({ consensus_verdict: "pass", reviewers: [{}], findings: [], strength: { backbone_weakest: { model: "gpt-6-astra", effort: "max" }, backbone_attested: true } }),
  });
  assert.notEqual(res.isError, true);
  assert.equal(labelledFrom, process.cwd());
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { handlePanel } from "../server.mjs";
import { delegate } from "../orchestrator.mjs";
import { MAX_STRENGTH } from "../routing.mjs";
import { installPolicyFixture, BETA, DELTA } from "./helpers/policy-fixture.mjs";

const fx = installPolicyFixture({ after });

test("handlePanel max: admitDirect handoff, direct opts, admission dep; failure -> blocked error", async () => {
  let panelArgs = null;
  const admission = { allowed: true, kind: "direct_review", needs_git: true, cwd_real: "C:\\r",
    policy: { name: BETA.name, pii_sensitive: false }, binaryIdentity: { path: "p", version: "0.144.1", size: 1, mtime: 2 } };
  const ok = await handlePanel({ cwd: "C:\\r", strength: MAX_STRENGTH }, {
    admitDirect: async () => admission,
    revisionLabel: () => "revision: abc",
    runPanel: async (opts, pdeps) => { panelArgs = { opts, pdeps }; return {
      consensus_verdict: "pass", status: "complete", transport: "direct",
      strength: { backbone_weakest: MAX_STRENGTH, backbone_attested: true },
    }; },
  });
  assert.equal(ok.isError, undefined);
  assert.equal(panelArgs.pdeps.admission, admission);
  assert.equal(panelArgs.opts.direct.evidence_kind, "diff");
  assert.equal(panelArgs.opts.model, MAX_STRENGTH.model);

  const blocked = await handlePanel({ cwd: "C:\\r", strength: MAX_STRENGTH }, {
    admitDirect: async () => ({ allowed: false, reason: "direct_preconditions_unmet", project: BETA.name }),
    runPanel: async () => { throw new Error("must not dispatch"); },
  });
  assert.equal(blocked.isError, true);
  assert.ok(JSON.parse(blocked.content[0].text).reason === "direct_preconditions_unmet");

  // An admission detail rides the blocked payload
  const detailed = await handlePanel({ cwd: "C:\\r", strength: MAX_STRENGTH }, {
    admitDirect: async () => ({ allowed: false, reason: "direct_preconditions_unmet",
      project: DELTA.name, detail: "network_denial_unverified: no_connectivity_control" }),
    runPanel: async () => { throw new Error("must not dispatch"); },
  });
  assert.equal(detailed.isError, true);
  assert.equal(JSON.parse(detailed.content[0].text).detail, "network_denial_unverified: no_connectivity_control");
});

test("handlePanel non-max: byte-identical companion path (no admission, no direct opts)", async () => {
  let panelArgs = null;
  const r = await handlePanel({ cwd: "C:\\r" }, {
    admitDirect: async () => { throw new Error("must not be called"); },
    runPanel: async (opts, pdeps) => { panelArgs = { opts, pdeps }; return {
      consensus_verdict: "pass", status: "complete",
      strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true },
    }; },
  });
  assert.equal(r.isError, undefined);
  assert.equal(panelArgs.opts.direct, undefined);
  assert.equal(panelArgs.pdeps, undefined);
});

test("delegate: effort max is reviews-only (fail-closed rejection naming the gate/panel)", async () => {
  const r = await delegate("implement the thing", { effort: "max", tier: "codex",
    cwd: fx.dirOf(BETA) });
  assert.equal(r.reason, "max_reviews_only");
  assert.match(r.result.error, /codex_gate|codex_review_panel/);
  // requested_quality is provenance on EVERY route, error envelopes
  // included -- verify it serializes as a literal null (not a dropped key) when no
  // quality was passed.
  assert.equal(JSON.parse(JSON.stringify(r)).requested_quality, null);
});

test("zod boundary: max accepted by the REGISTERED gate/panel schemas ONLY (reviews-only, load-bearing)", async () => {
  const { server } = await import("../server.mjs");
  const tools = server._registeredTools; // SDK 1.29.0 registry; inputSchema is the schema each tool actually enforces
  const accepts = (name, args) => {
    const s = tools[name].inputSchema;
    return (typeof s.safeParse === "function" ? s : z.object(s)).safeParse(args).success;
  };
  const maxS = { model: "gpt-5.6-sol", effort: "max" };
  assert.equal(accepts("codex_gate", { phase: "spec", cwd: "C:\\r", strength: maxS }), true);
  assert.equal(accepts("codex_review_panel", { cwd: "C:\\r", strength: maxS }), true);
  // codex_task's required field is "prompt" (not "task" -- that's delegate's field name); using
  // "prompt" here so the assertion actually exercises the effort enum, not a missing-field reject.
  assert.equal(accepts("codex_task", { prompt: "t", effort: "max" }), false);
  assert.equal(accepts("delegate", { task: "t", effort: "max" }), false);
  // no-regression guard: xhigh still accepted on both sides of the split
  assert.equal(accepts("codex_gate", { phase: "spec", cwd: "C:\\r", strength: { model: "gpt-5.6-sol", effort: "xhigh" } }), true);
  assert.equal(accepts("codex_task", { prompt: "t", effort: "xhigh" }), true);
});

test("verdict schemas: v1.1.0 together, new statuses, files_checked, strength_unattested abstention reason", async () => {
  const fs = await import("node:fs");
  const gate = JSON.parse(fs.readFileSync(new URL("../schemas/gate-verdict.schema.json", import.meta.url), "utf8"));
  const panel = JSON.parse(fs.readFileSync(new URL("../schemas/panel-verdict.schema.json", import.meta.url), "utf8"));
  assert.equal(gate.version, "1.1.0");
  assert.equal(panel.version, "1.1.0");
  for (const s of ["mixed_transport_unsupported", "admission_required", "direct_preconditions_unmet", "tree_changed", "payload_parse_error", "empty_scope_dirty_tree"]) {
    assert.ok(gate.properties.status.enum.includes(s), `gate status ${s}`);
    assert.ok(panel.properties.status.enum.includes(s), `panel status ${s}`);
  }
  for (const schema of [gate, panel]) {
    assert.ok(schema.definitions.reviewer_verdict.properties.files_checked);
    assert.ok(schema.definitions.reviewer_verdict.properties.files_checked_note);
    assert.ok(schema.definitions.abstention.properties.reason.enum.includes("strength_unattested"));
  }
});

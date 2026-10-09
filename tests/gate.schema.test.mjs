import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "../gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", "gate-verdict.schema.json"), "utf8"));
const CWD = "C:\\repo";

// --- a compact draft-07 subset validator (no new deps): type / enum / required / properties / items / $ref ---
function resolveRef(root, ref) {
  let node = root;
  for (const p of ref.replace(/^#\//, "").split("/")) node = node[p];
  return node;
}
function matchType(node, t) {
  if (t === "null") return node === null;
  if (t === "object") return node !== null && typeof node === "object" && !Array.isArray(node);
  if (t === "array") return Array.isArray(node);
  if (t === "integer") return typeof node === "number" && Number.isInteger(node);
  if (t === "string") return typeof node === "string";
  if (t === "number") return typeof node === "number";
  if (t === "boolean") return typeof node === "boolean";
  return true;
}
function validate(node, s, root, at, errs) {
  if (s.$ref) return validate(node, resolveRef(root, s.$ref), root, at, errs);
  if (s.enum) { if (!s.enum.includes(node)) errs.push(`${at}: ${JSON.stringify(node)} not in enum`); return; }
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchType(node, t))) { errs.push(`${at}: ${JSON.stringify(node)} not type ${types}`); return; }
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const req of s.required || []) if (!(req in node)) errs.push(`${at}: missing required '${req}'`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in node) validate(node[k], sub, root, `${at}.${k}`, errs);
  }
  if (Array.isArray(node) && s.items) node.forEach((el, i) => validate(el, s.items, root, `${at}[${i}]`, errs));
}
function schemaErrors(obj) { const e = []; validate(obj, schema, schema, "$", e); return e; }

const fakeFs = (files) => ({
  admit: () => ({ allowed: true, project: "project_beta" }),
  realpath: (p) => { const n = String(p).replace(/\//g, "\\"); if (n === CWD) return CWD; const k = n.slice(CWD.length + 1).replace(/\\/g, "/"); if (k in files) return n; throw new Error("ENOENT"); },
  readFile: (p) => { const k = String(p).replace(/\//g, "\\").slice(CWD.length + 1).replace(/\\/g, "/"); return files[k]; },
});

test("an ERROR gate result validates against the versioned schema", async () => {
  const res = await runGate({ phase: "spec", cwd: CWD }, { ...fakeFs({}), runPanel: async () => ({}) });
  assert.equal(res.status, "no_reviewable_target");
  assert.deepEqual(schemaErrors(res), []);
});

test("a PASS gate result validates against the schema", async () => {
  const res = await runGate(
    { phase: "spec", cwd: CWD, target_files: ["spec.md"] },
    {
      ...fakeFs({ "spec.md": "body" }),
      runPanel: async () => ({
        consensus_verdict: "pass",
        reviewers: [{ lens: "completeness-gaps", verdict: "pass", confidence: "high", role: "backbone", model: "gpt-6.1-sol", effort: "xhigh", strength_attested: true, findings: [] }],
        findings: [], dissent: [], abstentions: [], advisory_ignored: [], identity_errors: [],
        strength: { weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true },
      }),
    }
  );
  assert.equal(res.consensus_verdict, "pass");
  assert.deepEqual(schemaErrors(res), []);
});

test("a BLOCK gate result with blockers[] validates against the schema", async () => {
  const res = await runGate(
    { phase: "plan", cwd: CWD, target_files: ["plan.md"] },
    {
      ...fakeFs({ "plan.md": "body" }),
      runPanel: async () => ({
        consensus_verdict: "block",
        reviewers: [{ lens: "scope-fidelity", verdict: "block", confidence: "high", role: "backbone", model: "gpt-6.1-sol", effort: "xhigh", findings: [{ severity: "blocker", file: "plan.md", line: 3, summary: "unmapped requirement" }] }],
        findings: [{ severity: "blocker", file: "plan.md", line: 3, summary: "unmapped requirement", lens: "scope-fidelity" }],
        dissent: [], abstentions: [], advisory_ignored: [], identity_errors: [],
        strength: { backbone_weakest: { model: "gpt-6.1-sol", effort: "xhigh" }, backbone_attested: true },
      }),
    }
  );
  assert.equal(res.consensus_verdict, "block");
  assert.equal(res.blockers.length, 1);
  assert.deepEqual(schemaErrors(res), []);
});

test("the validator actually rejects a malformed result (guards against a no-op validator)", () => {
  const bad = { phase: "spec", consensus_verdict: "maybe", reviewers: [{ verdict: "pass" }] };
  const errs = schemaErrors(bad);
  assert.ok(errs.some((e) => e.includes("consensus_verdict")), "bad consensus_verdict must be flagged");
  assert.ok(errs.some((e) => e.includes("role")), "reviewer missing role must be flagged");
});

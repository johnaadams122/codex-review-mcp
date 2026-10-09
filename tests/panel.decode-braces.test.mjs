import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");

const { decodeReviewerResult } = await import("../panel.mjs");

// WHY THIS EXISTS: decodeReviewerResult sliced text.indexOf("{") .. text.lastIndexOf("}"),
// so ANY brace a reviewer typed in prose -- before or after its JSON verdict -- corrupted the
// slice and produced parse_failed -> abstention -> block. Lenses that quote conflicting
// literal shapes or malformed request bodies are the most exposed: a reviewed document
// saturated with literal JSON ({{SPEC_TEXT}}, {"type":"json_schema"}, a provider block)
// makes them abstain parse_failed while a lens that only describes what is missing completes.
// The failure is deterministic, not flaky, and it fails CLOSED -- so a spec
// containing JSON would be structurally harder to pass than one that does not: a mechanism
// failure wearing a document verdict's clothes.

const VERDICT = JSON.stringify({
  verdict: "block",
  confidence: "high",
  findings: [{ severity: "blocker", file: "x.md", line: 1, summary: "y" }],
});

const pass = (raw) => decodeReviewerResult(raw, (x) => x);

test("decodes a verdict preceded by prose containing a JSON snippet", () => {
  const r = pass(`The doc says to send {"type":"json_schema"} but section 6 disagrees.\n${VERDICT}`);
  assert.equal(r.ok, true, `expected decode, got ${r.reason}`);
  assert.equal(r.verdict.verdict, "block");
  assert.equal(r.verdict.findings.length, 1);
});

test("decodes a verdict preceded by a mustache placeholder", () => {
  const r = pass(`The placeholder {{SPEC_TEXT}} is spliced exactly once.\n${VERDICT}`);
  assert.equal(r.ok, true, `expected decode, got ${r.reason}`);
});

test("decodes a verdict followed by trailing prose containing braces", () => {
  const r = pass(`${VERDICT}\nNote: also check {foo} and {bar}.`);
  assert.equal(r.ok, true, `expected decode, got ${r.reason}`);
  assert.equal(r.verdict.verdict, "block");
});

test("decodes when prose braces appear on BOTH sides", () => {
  const r = pass(`It pins {zdr: true} here.\n${VERDICT}\nAnd {baz} there.`);
  assert.equal(r.ok, true, `expected decode, got ${r.reason}`);
});

test("picks the LAST balanced object when prose contains an earlier complete object", () => {
  // A reviewer quoting a whole example object must not have it mistaken for the verdict.
  const decoy = '{"verdict":"pass","findings":[]}';
  const r = pass(`An example of a bad response is ${decoy} which would be wrong.\n${VERDICT}`);
  assert.equal(r.ok, true, `expected decode, got ${r.reason}`);
  assert.equal(r.verdict.verdict, "block", "took the decoy object instead of the real verdict");
  assert.equal(r.verdict.findings.length, 1);
});

test("braces inside JSON string values do not break balance tracking", () => {
  const tricky = JSON.stringify({
    verdict: "block",
    findings: [{ severity: "blocker", summary: 'body must be {"type":"json_schema"} exactly' }],
  });
  const r = pass(`prose {here}\n${tricky}`);
  assert.equal(r.ok, true, `expected decode, got ${r.reason}`);
  assert.match(r.verdict.findings[0].summary, /json_schema/);
});

// ---- the strict properties that must SURVIVE the fix (fail-closed contract) ----

test("still rejects an unknown top-level key", () => {
  const r = pass('{"verdict":"pass","findings":[],"notes":"BLOCKER hidden here"}');
  assert.equal(r.ok, false);
  assert.equal(r.reason, "parse_failed");
});

test("still rejects a finding whose scalar field carries an object", () => {
  const r = pass('{"verdict":"block","findings":[{"severity":"blocker","file":{"a":1},"summary":"s"}]}');
  assert.equal(r.ok, false);
  assert.equal(r.reason, "parse_failed");
});

test("still rejects a non-pass/block verdict", () => {
  const r = pass('{"verdict":"maybe","findings":[]}');
  assert.equal(r.ok, false);
  assert.equal(r.reason, "parse_failed");
});

test("still rejects text with no JSON object at all", () => {
  const r = pass("I could not review this document.");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "parse_failed");
});

test("an unknown key in the LAST object is not rescued by an earlier valid-looking one", () => {
  // Fail closed: the reviewer's actual answer is the last object; if it is non-conforming we must
  // not silently fall back to an earlier decoy that happens to parse.
  const r = pass('{"verdict":"block","findings":[]}\nfinal: {"verdict":"pass","findings":[],"notes":"x"}');
  assert.equal(r.ok, false, "fell back to an earlier object instead of failing closed");
  assert.equal(r.reason, "parse_failed");
});

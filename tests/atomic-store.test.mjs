// tests/atomic-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJSON, readJSON } from "../hooks/atomic-store.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function tmpdir(t) { return tempDirFor(t, "atomic-"); }

test("atomicWriteJSON creates parent dirs and round-trips", (t) => {
  const d = tmpdir(t);
  const p = path.join(d, "nested", "store.json");
  atomicWriteJSON(p, { a: 1 });
  assert.deepEqual(readJSON(p), { a: 1 });
  // no leftover tmp files
  assert.equal(fs.readdirSync(path.dirname(p)).filter((n) => n.includes(".tmp")).length, 0);
});

test("readJSON (non-strict) returns fallback on missing AND on torn parse (advisory tolerance)", (t) => {
  const d = tmpdir(t);
  const p = path.join(d, "store.json");
  assert.deepEqual(readJSON(p, { runs: {} }), { runs: {} });   // missing
  fs.writeFileSync(p, "{ this is not json");
  assert.deepEqual(readJSON(p, { runs: {} }), { runs: {} });   // torn -> fallback, NOT {}
});

test("readJSON STRICT quarantines a corrupt store and throws (never torn-erase); missing still falls back", (t) => {
  const d = tmpdir(t);
  const p = path.join(d, "store.json");
  // missing under strict -> fallback (a fresh journal is legitimately absent)
  assert.deepEqual(readJSON(p, { runs: {} }, { strict: true }), { runs: {} });
  // corrupt-but-nonempty under strict -> quarantine + throw (must NOT reopen a spent budget)
  fs.writeFileSync(p, '{"R1":{"jobs_submitted":9} CORRUPT');
  assert.throws(() => readJSON(p, { runs: {} }, { strict: true }), (e) => e && e.code === "ECORRUPT");
  assert.equal(fs.existsSync(p), false);                        // original moved aside
  const quarantined = fs.readdirSync(d).filter((n) => n.includes(".corrupt-"));
  assert.equal(quarantined.length, 1);                          // preserved for forensics
});

test("readJSON STRICT rejects a valid JSON ARRAY (named runId props on an array vanish under stringify)", (t) => {
  const d = tmpdir(t);
  const p = path.join(d, "store.json");
  fs.writeFileSync(p, '[{"jobs_submitted":9}]');                // parses fine, but is NOT an object map
  assert.throws(() => readJSON(p, {}, { strict: true }), (e) => e && e.code === "ECORRUPT");
  assert.equal(fs.existsSync(p), false);                        // quarantined -- reverting !Array.isArray fails THIS test
});

test("atomicWriteJSON retries a transient rename EPERM then succeeds", (t) => {
  const d = tmpdir(t);
  const p = path.join(d, "store.json");
  let calls = 0;
  const rename = (from, to) => { if (++calls === 1) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; } fs.renameSync(from, to); };
  atomicWriteJSON(p, { ok: true }, { rename });
  assert.equal(calls, 2);
  assert.deepEqual(readJSON(p), { ok: true });
});

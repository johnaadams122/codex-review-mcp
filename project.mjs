// Pure poll projector. No imports from jobs.mjs/server.mjs -- this module is
// dependency-free so it can be unit-tested standalone and wired into server.mjs by a
// later task. All four functions are pure: no I/O, no companion spawns.

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

// Own-property existence check for "present ONLY when present" passthroughs -- deliberately
// NOT the `in` operator, which would also true-ify inherited/prototype-supplied keys (e.g. a
// payload object built via Object.create(somethingWithWriteBlocked)). Every payload/rec this
// module receives is either JSON.parse output or a plain test literal, so this is exact.
function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Pull the assistant's final answer text out of a getResult()-shaped payload, whatever
// production variant produced it. Precedence:
//   string passthrough -> payload.output -> payload.storedJob?.result?.rawOutput ->
//   payload.storedJob?.result?.codex?.stdout (native-review fix: the companion stores
//   NO rawOutput for native reviews, so the full text lives ONLY here) ->
//   payload.job?.summary -> payload.rendered -> payload.summary -> ""
// NEVER payload.storedJob?.summary -- that field holds the PROMPT, not the answer.
export function extractAnswer(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  return (
    payload.output ??
    payload.storedJob?.result?.rawOutput ??
    payload.storedJob?.result?.codex?.stdout ??
    payload.job?.summary ??
    payload.rendered ??
    payload.summary ??
    ""
  );
}

const OPTIONAL_TOP_LEVEL_KEYS = ["write_blocked", "_synthesized", "_diskRecovered", "truncated"];

// Project a getResult()-shaped payload down to the caller-facing shape. `statusOverride`
// lets waitForResult's own terminal status win over whatever (if anything) the payload
// itself carries -- the companion's real `result` command payload has NO top-level
// `status` key at all, so the fallback chain below is load-bearing, not defensive fluff.
export function projectResult(jobId, payload, statusOverride) {
  const p = asObject(payload);
  const status = statusOverride ?? p.status ?? p.job?.status ?? p.storedJob?.status;
  const out = { status, job_id: jobId, output: extractAnswer(payload) };

  const touchedFiles = p.storedJob?.result?.touchedFiles;
  if (touchedFiles !== undefined) out.touchedFiles = touchedFiles;

  const model = p.storedJob?.request?.model;
  if (model !== undefined) out.model = model;

  for (const key of OPTIONAL_TOP_LEVEL_KEYS) {
    if (has(p, key)) out[key] = p[key];
  }

  return out;
}

// Project a waitForResult() outcome (jobs.mjs:638-664) to the caller-facing shape.
export function projectWait(w) {
  const outcome = asObject(w);
  const status = outcome.status;
  if (status === "completed" || status === "succeeded") {
    return projectResult(outcome.job_id, outcome.result, status);
  }
  if (status === "result_error") {
    return { status, job_id: outcome.job_id, error: outcome.error };
  }
  // timeout | not_found | cancelled | failed | error (and any other terminal): no
  // getResult call was made, so there is nothing to project beyond the sentinel.
  return { status, job_id: outcome.job_id };
}

// Project a getStatus() snapshot ({job:...} or a bare record, per job-guard.mjs
// sanitizeSnapshot:165-171) to the minimal caller-facing status shape. `jobId` (the
// caller's own reference) wins over rec.id, which only exists as a fallback for callers
// that never had a jobId to pass in the first place.
//
// `elapsed` is enrichment the companion only computes on a STATUS read (lib/job-control.mjs
// enrichJob:161-180); a bare/unenriched record (e.g. a stored job record fed straight in)
// never carries it. Unlike status/phase/pid/summary -- which every record shape carries and
// so are always present on the output, even as undefined -- elapsed is treated as an
// optional passthrough (hasOwnProperty-gated, same style as item 1) and OMITTED rather than
// materialized as an explicit `undefined` key when the record lacks it.
export function projectStatus(jobId, snapshot) {
  const s = asObject(snapshot);
  const rec = asObject(s.job ?? s);
  const out = {
    job_id: jobId ?? rec.id,
    status: rec.status,
    phase: rec.phase,
    pid: rec.pid ?? null,
    summary: rec.summary,
  };
  if (has(rec, "elapsed")) out.elapsed = rec.elapsed;
  if (has(rec, "write_blocked")) out.write_blocked = rec.write_blocked;
  if (has(rec, "_synthesized")) out._synthesized = rec._synthesized;
  return out;
}

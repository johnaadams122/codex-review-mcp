// tests/run-journal.budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recordSubmission, recordJobId, todaysSubmitted, reserveOK, dayKey, effectiveDayKey, upsertRun, readJournal } from "../hooks/run-journal.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

function repo(t) { return tempDirFor(t, "budget-"); }
const T = new Date("2026-07-18T12:00:00");

test("recordSubmission is write-ahead, derived-summed, cap-rechecked-under-lock, and VETOES at the cap", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", dayKey: dayKey(T) });
  for (let i = 0; i < 20; i++) assert.equal(recordSubmission(r, "R1", T).ok, true); // fills to the cap (20)
  assert.equal(todaysSubmitted(r, T), 20);
  const over = recordSubmission(r, "R1", T);                  // the 21st is VETOED
  assert.equal(over.ok, false);
  assert.equal(over.over, true);
  assert.equal(todaysSubmitted(r, T), 20);                    // NOT incremented past the cap
});

test("recordSubmission CONTENTION: total ok:true APPROVALS across N procs == cap (a no-op lock over-approves)", async (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", dayKey: dayKey(T) });
  const mod = new URL("../hooks/run-journal.mjs", import.meta.url).href;
  const worker = path.join(r, "w.mjs");
  // Each worker COUNTS how many recordSubmission calls returned ok:true and writes that count out.
  // A no-op / non-exclusive lock would approve MORE than `cap` external submissions even while lost
  // journal increments still leave a final stored value of 10 -- so asserting on APPROVALS (not just
  // the stored total) is what actually discriminates (C#12).
  fs.writeFileSync(worker,
    'import { recordSubmission } from ' + JSON.stringify(mod) + ';\n' +
    'import fs from "node:fs";\n' +
    'const [,, root, runId, out] = process.argv;\n' +
    'let ok = 0;\n' +
    'for (let i = 0; i < 20; i++) { if (recordSubmission(root, runId, new Date("2026-07-18T12:00:00")).ok) ok++; }\n' +
    'fs.writeFileSync(out, String(ok));\n');
  const { spawn } = await import("node:child_process");
  const N = 4;
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res, rej) => {
    const c = spawn(process.execPath, [worker, r, "R1", path.join(r, "ok-" + i + ".txt")], { stdio: "ignore" });
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error("worker " + code))));
    c.on("error", rej);
  })));
  let approvals = 0;
  for (let i = 0; i < N; i++) approvals += parseInt(fs.readFileSync(path.join(r, "ok-" + i + ".txt"), "utf8"), 10);
  assert.equal(approvals, 20);                                 // EXACTLY cap approvals across ALL procs
  assert.equal(todaysSubmitted(r, T), 20);
});

test("reserveOK (soft pre-check) enforces the daily cap (20) and excludes other days", (t) => {
  const r = repo(t);
  const yesterday = new Date("2026-07-17T12:00:00");
  upsertRun(r, "OLD", { status: "pass", dayKey: dayKey(yesterday), jobs_submitted: 9 });
  upsertRun(r, "R1", { status: "running", dayKey: dayKey(T) });
  for (let i = 0; i < 19; i++) recordSubmission(r, "R1", T);   // 19 today
  assert.equal(reserveOK(r, 1, T), true);    // 19 + 1 <= 20
  assert.equal(reserveOK(r, 2, T), false);   // 19 + 2 > 20; yesterday's 9 excluded
});

test("effectiveDayKey GUARDS a clock rollback: budget stays keyed to the max-seen day", () => {
  const j = { A: { dayKey: "2026-07-18", jobs_submitted: 5 } };
  // clock rolled BACK to 07-17 -> effective day stays 07-18 (max-seen); the spent budget is NOT resurrected
  assert.equal(effectiveDayKey(j, new Date("2026-07-17T00:00:00")), "2026-07-18");
  // clock genuinely ADVANCES to 07-19 -> effective day advances (fresh budget)
  assert.equal(effectiveDayKey(j, new Date("2026-07-19T00:00:00")), "2026-07-19");
  assert.match(dayKey(T), /^\d{4}-\d{2}-\d{2}$/);
});

test("recordSubmission RESETS jobs_submitted on a day-boundary cross (no carried-lifetime-count budget corruption)", (t) => {
  const r = repo(t);
  const day1 = new Date("2026-07-18T12:00:00");
  const day2 = new Date("2026-07-19T12:00:00");
  // R1 accumulated 9 submissions on day1 (a long-lived run straddling midnight).
  upsertRun(r, "R1", { status: "running", dayKey: dayKey(day1), jobs_submitted: 9 });
  const first = recordSubmission(r, "R1", day2);
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);                           // fresh day-2 budget, NOT 10 (carried lifetime count)
  assert.equal(todaysSubmitted(r, day2), 1);               // NOT 10 -- day1's 9 must not poison day2's derived sum
  upsertRun(r, "R2", { status: "running", dayKey: dayKey(day2) });
  const other = recordSubmission(r, "R2", day2);
  assert.equal(other.ok, true);                            // day2 must not be falsely exhausted for OTHER runs either
});

test("recordJobId appends+dedups jobIds under the lock, preserves status, ignores a falsy jobId", (t) => {
  const r = repo(t);
  upsertRun(r, "R1", { status: "running", dayKey: dayKey(T) });
  assert.deepEqual(recordJobId(r, "R1", "j1").jobIds, ["j1"]);
  assert.deepEqual(recordJobId(r, "R1", "j2").jobIds, ["j1", "j2"]);
  assert.deepEqual(recordJobId(r, "R1", "j1").jobIds, ["j1", "j2"]);   // dedup -- no double-append
  assert.equal(recordJobId(r, "R1", null).ok, false);                 // falsy jobId is a no-op
  const e = readJournal(r)["R1"];
  assert.equal(e.status, "running");                                  // additive: status is preserved, not resurrected
  assert.deepEqual(e.jobIds, ["j1", "j2"]);
});

#!/usr/bin/env node
// Fake codex-companion for integration tests. With CODEX_FAKE_STORE_DIR set it
// mirrors the REAL companion's review behavior: reviews IGNORE
// --background and run inline; the store record appears at start (pid stamped,
// sessionId from env) and finalizes at exit; the printed payload carries NO
// jobId. Without the store dir, legacy canned outputs serve the pre-existing
// task/control-plane tests (the review --background lie is GONE in both modes).
// Top-level await is legal here (.mjs module).
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];
const STORE = process.env.CODEX_FAKE_STORE_DIR ?? null;
const SESSION = process.env.CODEX_COMPANION_SESSION_ID ?? null;

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const VALUE_FLAGS = new Set(["--cwd", "--base", "--scope", "--model", "-m"]);
function positionalId() {
  return args.find((a, i) => i > 0 && !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
}
function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); process.exit(0); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

if (STORE) {
  fs.mkdirSync(STORE, { recursive: true });
  fs.appendFileSync(path.join(STORE, "cwd-probe.jsonl"),
    JSON.stringify({ cmd, cwd: argValue("--cwd"), argv: args }) + "\n");
}
const writeRec = (rec) => fs.writeFileSync(path.join(STORE, "rec-" + rec.id + ".json"), JSON.stringify(rec));
const readRecs = () => fs.readdirSync(STORE).filter(f => f.startsWith("rec-"))
  .map(f => JSON.parse(fs.readFileSync(path.join(STORE, f), "utf8")));

if (STORE && (cmd === "review" || cmd === "adversarial-review")) {
  if (process.env.CODEX_FAKE_FAIL === "pre-record") { process.stderr.write("forced pre-record failure\n"); process.exit(3); }
  fs.writeFileSync(path.join(STORE, "child.pid"), String(process.pid));
  const reviewMs = parseInt(process.env.CODEX_FAKE_REVIEW_MS ?? "500", 10);
  if (process.env.CODEX_FAKE_SKIP_STORE === "1") { await sleep(reviewMs); out({ review: "fake", target: {} }); }
  const id = "review-fake-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  const rec = {
    id, kind: cmd, jobClass: "review", status: "running", pid: process.pid,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(SESSION && process.env.CODEX_FAKE_UNTAGGED !== "1" ? { sessionId: SESSION } : {})
  };
  writeRec(rec);
  if (process.env.CODEX_FAKE_FAIL === "post-record") { process.stderr.write("forced post-record failure\n"); process.exit(3); }
  await sleep(reviewMs);
  if (process.env.CODEX_FAKE_FAIL === "finalize-failed") {
    // Mirrors the companion's finalize-on-error - terminal FAILED
    // record, then nonzero exit (record beats exit code on this branch too).
    writeRec({ ...rec, status: "failed", pid: null, updatedAt: new Date().toISOString(), error: "forced finalize-failed" });
    process.stderr.write("forced finalize-failed\n"); process.exit(3);
  }
  writeRec({ ...rec, status: "completed", pid: null, updatedAt: new Date().toISOString(), result: { review: "fake" } });
  if (process.env.CODEX_FAKE_FAIL === "post-finalize") { process.stderr.write("forced post-finalize failure\n"); process.exit(3); }
  out({ review: "fake", target: {} });   // REAL shape: no jobId, no status
} else if (STORE && cmd === "status" && args.includes("--all")) {
  let recs = readRecs();
  if (SESSION) recs = recs.filter(r => r.sessionId === SESSION);
  const running = recs.filter(r => r.status === "running" || r.status === "queued");
  const finished = recs.filter(r => TERMINAL.has(r.status));
  const snap = { running, recent: finished };
  if (finished.length) {
    // Mirror the real companion's buildStatusSnapshot (job-control.mjs:224-229):
    // the NEWEST terminal record goes ONLY in latestFinished and is EXCLUDED
    // from recent (job.id !== latestFinished?.id) -- these are mutually
    // exclusive, not overlapping. Newest = max updatedAt.
    const sorted = [...finished].sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
    snap.latestFinished = sorted[0];
    snap.recent = finished.filter((r) => r.id !== snap.latestFinished.id);
  }
  out(snap);
} else if (STORE && cmd === "status") {
  const id = positionalId();
  const rec = readRecs().find(r => r.id === id);   // per-id: NO session filter
  if (!rec) { process.stderr.write('No job found for "' + id + '"\n'); process.exit(1); }
  out({ job: rec });
} else if (STORE && cmd === "result") {
  const id = positionalId();
  const rec = readRecs().find(r => r.id === id);
  if (!rec || !TERMINAL.has(rec.status)) { process.stderr.write('No finished job found for "' + (id ?? "") + '"\n'); process.exit(1); }
  out({ storedJob: rec, status: rec.status });
} else if (cmd === "task") {
  out({ jobId: "task-fake001", status: "queued" });
} else if (cmd === "status") {
  if (args.includes("--all")) {
    out([{ jobId: "task-fake001", status: "completed", phase: "done" }]);
  } else {
    const jobId = args.find((a, i) => i > 0 && !a.startsWith("--")) ?? "task-fake001";
    if (jobId.startsWith("hang")) {
      setInterval(() => {}, 1e9);   // never exits -- for control-plane timeout tests
    } else if (jobId.startsWith("live-")) {
      // Report the parent (the live test runner) as the "worker" pid so the
      // cancel-verify path sees a genuinely alive pid.
      out({ job: { jobId, status: "running", phase: "running", pid: process.ppid } });
    } else {
      out({ job: { jobId, status: "completed", phase: "done" } });
    }
  }
} else if (cmd === "result") {
  out({ output: "Fake companion result text", status: "completed" });
} else if (cmd === "cancel") {
  const jobId = args.find((a, i) => i > 0 && !a.startsWith("--")) ?? "task-fake001";
  if (jobId.startsWith("hang")) {
    setInterval(() => {}, 1e9);   // never exits -- for control-plane timeout tests
  } else {
    out({ cancelled: true, jobId });
  }
} else if (cmd === "review" || cmd === "adversarial-review") {
  // store-less legacy: realistic no-jobId payload (the --background lie is gone)
  out({ review: "fake", target: {} });
} else if (cmd === "hang") {
  setInterval(() => {}, 1e9);   // never exits -- for timeout tests
} else {
  process.stderr.write("Unknown command: " + (cmd ?? "(none)") + "\n");
  process.exit(1);
}

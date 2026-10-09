// hooks/marker.mjs -- Phase-1 gate-due marker store.
//
// The marker is a per-repo, gitignored JSON file at <root>/.superpowers/gate-due.json mapping
// normalized repo-relative artifact paths to { phase, first_seen, last_edit, reminded }.
// "root" is the directory holding a .codex-autogate enablement file (existence IS the signal).
// All timestamps are caller-supplied ISO strings so tests inject a fixed clock.

import fs from "node:fs";
import path from "node:path";

// Parity with panel.mjs normalizePayloadPath -- kept local so the hook script never imports the
// panel/jobs dependency chain (the hook runs on every Write/Edit and must never crash a turn).
export function normalizeRel(p) {
  return String(p ?? "").replace(/\\/g, "/").toLowerCase();
}

export function resolveAutogateRoot(startAbsPath, fsView = fs) {
  let dir = path.resolve(String(startAbsPath ?? ""));
  // Start from the containing directory when given a file path. When the path exists, trust the
  // filesystem (so a DIRECTORY with a dot in its name is not mistaken for a file); only fall back
  // to the extname heuristic when it does not exist yet (a first Write's file_path at classify time).
  const exists = fsView.existsSync(dir);
  const isDir = exists && fsView.statSync(dir).isDirectory();
  if (!isDir && (exists || path.extname(dir) !== "")) dir = path.dirname(dir);
  for (;;) {
    if (fsView.existsSync(path.join(dir, ".codex-autogate"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function markerPathFor(root) {
  return path.join(root, ".superpowers", "gate-due.json");
}

export function readMarker(markerPath, fsView = fs) {
  try {
    if (!fsView.existsSync(markerPath)) return {};
    const parsed = JSON.parse(fsView.readFileSync(markerPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    process.stderr.write(`gate-due: malformed marker ${markerPath}: ${e.message}\n`);
    return {};
  }
}

function writeMarker(markerPath, marker, fsView = fs) {
  fsView.mkdirSync(path.dirname(markerPath), { recursive: true });
  fsView.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n");
}

export function markGateDue({ root, relFile, phase, now, fsView = fs }) {
  const mp = markerPathFor(root);
  const marker = readMarker(mp, fsView);
  const key = normalizeRel(relFile);
  const prev = marker[key];
  marker[key] = prev
    ? { ...prev, phase, last_edit: now }
    : { phase, first_seen: now, last_edit: now, reminded: false };
  writeMarker(mp, marker, fsView);
  return marker[key];
}

export function takeReminder({ root, relFile, fsView = fs }) {
  const mp = markerPathFor(root);
  const marker = readMarker(mp, fsView);
  const key = normalizeRel(relFile);
  const entry = marker[key];
  const pending = Object.keys(marker).length;
  if (!entry || entry.reminded) return { remind: false, pending };
  entry.reminded = true;
  writeMarker(mp, marker, fsView);
  return { remind: true, pending };
}

export function clearGateDue({ root, relFile, phase, fsView = fs }) {
  const mp = markerPathFor(root);
  const marker = readMarker(mp, fsView);
  const key = normalizeRel(relFile);
  if (!marker[key] || marker[key].phase !== phase) return { cleared: false };
  delete marker[key];
  writeMarker(mp, marker, fsView);
  return { cleared: true };
}

// Gate-side clear: called from BOTH gate entry points on a non-error verdict.
// Best-effort by contract -- a marker failure must NEVER turn a passing gate into an error.
export function clearGateDueForGate({ cwd, phase, target_files, fsView = fs }) {
  try {
    const start = cwd ?? process.cwd();
    const root = resolveAutogateRoot(start, fsView) ?? path.resolve(start);
    for (const rel of target_files || []) {
      try {
        // target_files are cwd-relative (gate.mjs readContained resolves them against cwd), but
        // the marker is keyed relative to the autogate root -- re-base so mark and clear agree
        // even when the gate runs from a subdirectory. When cwd === root this is a no-op.
        const key = path.relative(root, path.resolve(start, rel));
        clearGateDue({ root, relFile: key, phase, fsView });
      } catch { /* per-file best-effort */ }
    }
  } catch (e) {
    process.stderr.write(`gate-due: clear failed: ${e.message}\n`);
  }
}

export function buildReminderLine({ relFile, phase, pending }) {
  return "\u26a0 codex_gate due: " + relFile + " (" + phase + ") -- run before presenting. [" +
    pending + " pending; .superpowers/gate-due.json]";
}
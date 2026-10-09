// tools/gate-reaper.mjs -- durable, process-independent journal reaper.
// Invoked by a scheduled task (Windows Task Scheduler) so a crashed run terminalizes even with no
// live server. knownRoots() DERIVES this repo's root from this module's own location -> portable; any
// further repo to sweep is named explicitly, in CODEX_MCP_REAPER_EXTRA_ROOTS or the settings file's
// reaperExtraRoots (no default).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sweepJournal as _sweepJournal } from "../hooks/gate-supervisor.mjs";
import { cachedPolicyConfig } from "../policy.mjs";

// <repo>/tools/gate-reaper.mjs -> this repo's root, then any absolute folders listed in
// CODEX_MCP_REAPER_EXTRA_ROOTS (path-delimiter separated), then the settings file's reaperExtraRoots.
// No default, so no sibling project is assumed. Duplicates are dropped by REAL location (native realpath when
// the folder resolves, so a junction or 8.3 spelling of a listed root is the same root; ASCII
// case-insensitively on Windows) and
// the result is filtered to existing dirs so a machine without one of them never sweeps a phantom path.
// Injectable for tests + migration.
export function knownRoots(deps = {}) {
  if (deps.roots) return deps.roots;
  const moduleDir = deps.moduleDir ?? fileURLToPath(new URL(".", import.meta.url)); // <repo>/tools/
  const existsSync = deps.existsSync ?? fs.existsSync;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const realpath = deps.realpath ?? fs.realpathSync.native;
  const fromEnv = String(env.CODEX_MCP_REAPER_EXTRA_ROOTS ?? "").split(path.delimiter);
  const fromSettings = (deps.config ?? cachedPolicyConfig()).reaperExtraRoots ?? [];
  const extra = [...(deps.extraRoots ?? fromEnv), ...fromSettings]
    .filter((p) => typeof p === "string" && p !== "" && path.isAbsolute(p));
  const own = path.resolve(moduleDir, "..");
  const seen = new Set();
  const out = [];
  for (const p of [own, ...extra]) {
    // A resolved path comes back spelled as stored on disk, so it is compared exactly (two folders that
    // differ only in case can both exist in an NTFS case-sensitive folder); only its drive letter or
    // share is folded. An unresolvable path keeps the old case-insensitive key on Windows.
    const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
    let key;
    try {
      const real = String(realpath(p));
      const root = path.win32.parse(real).root;
      key = platform === "win32" ? lower(root) + real.slice(root.length) : real;
    } catch {
      key = platform === "win32" ? lower(path.resolve(p)) : path.resolve(p);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.filter((p) => existsSync(p));
}

export function reapAll(roots, deps = {}) {
  const sweepJournal = deps.sweepJournal ?? _sweepJournal;   // sync (state-only, no companion query)
  let reaped = 0, errors = 0;
  for (const root of roots) {
    try { const r = sweepJournal(root, deps); reaped += (r.reaped || 0); }
    catch { errors++; }
  }
  return { reaped, errors };
}

// A sweep error must not exit 0 -- the scheduled task's own
// "last run succeeded" is the only signal Scheduled Tasks or the health gate ever sees.
export function exitCodeFor(out) {
  return out.errors > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = reapAll(knownRoots(), {});
  process.stderr.write("gate-reaper: " + JSON.stringify(out) + "\n");
  process.exit(exitCodeFor(out));
}

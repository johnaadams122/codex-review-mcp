// policy.mjs -- per-project write/git/pii/review rules, read from a settings file.
//
// The project table is NOT in code. It lives in a JSON settings file:
//   * the path in env CODEX_MCP_POLICY_FILE (an absolute path), else
//   * <os.homedir()>/.codex-mcp/project-policy.json
//
// File shape (strict: unknown keys are refused):
//   {
//     "schema": "codex-mcp-project-policy-v1",
//     "projectsBase": "<absolute folder that holds the projects>",
//     "projects": [
//       { "dir": "<folder name>", "name": "<snake_case id>",
//         "write": true, "git": true, "pii": false, "review": true }
//     ],
//     "gateAllowlist": ["<project name>", ...],    // optional; default empty
//     "companionPluginRoot": "<absolute folder>",  // optional; default none
//     "reaperExtraRoots": ["<absolute folder>", ...] // optional; default empty
//   }
//
// `review` is optional and defaults to `!pii`. `gateAllowlist` names the projects whose commits the
// detached auto-gate hook may review (hooks/gate-run.config.mjs); every name must be a project row's
// `name`; empty means none.
// `companionPluginRoot` is the codex companion plugin folder used when env CLAUDE_PLUGIN_ROOT is unset
// (jobs.mjs). `reaperExtraRoots` are further repo folders tools/gate-reaper.mjs sweeps.
// Any validation error rejects the WHOLE file: nothing in it is used, including these two.
//
// Paths in the file must be written in canonical absolute form: no "." or ".." segments, no doubled or
// trailing separator, and on Windows a drive letter or UNC share, backslashes only, no \\?\ or \\.\
// prefix, and no segment ending in a dot or space. A `dir` is one folder name that cannot be read two
// ways on Windows: no trailing dot or space, no reserved device name (CON, NUL, COM1, ...), no
// characters Windows refuses (< > : " | ? * and control characters), no 8.3 short-name shape (~ then a
// digit), and NFC-normalized. Two dirs Windows treats as the same name (case, including non-ASCII case)
// are duplicates. These rules apply on every platform so one file means the same thing everywhere.
//
// Matching (resolvePolicy) compares REAL locations, not spellings: the cwd and each project folder are
// resolved by the operating system (native realpath: junctions and symlinks followed, 8.3 short names
// expanded, \\?\ prefixes removed). Names are compared exactly (resolved names come back spelled as
// stored on disk, which keeps look-alike folders in an NTFS case-sensitive folder apart); only the
// drive letter or share name is case-folded (ASCII only). A cwd that is not absolute (relative, drive-relative "C:x", or rooted without a drive
// "\\x") cannot be resolved without guessing, so it gets DEFAULT_POLICY. On Windows every segment of the
// cwd must also pass the `dir` rules (short names allowed): the realpath call reads names literally
// while Windows rewrites some of them when it starts a process, so an ambiguous name could pass the
// check as one folder and run in another. A project folder that is itself a link matches nothing.
// A missing tail below an existing folder is appended only when every missing name passes the `dir`
// rules; a link that exists
// but does not resolve (dangling), any other resolution error, and a cwd claimed by two project rows
// all get DEFAULT_POLICY.
//
// Fails safe: a missing or invalid file yields an EMPTY table, so every folder gets DEFAULT_POLICY
// (name "unknown", pii true, write false, git false, review false). One reason-code line goes to stderr, once
// per process, never the file contents. The file is read lazily on first use and cached for the life
// of the process; a change needs a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const POLICY_SCHEMA = "codex-mcp-project-policy-v1";
const RESERVED_NAME = "unknown";
const NAME_RE = /^[a-z0-9_]+$/;
const MAX_FILE_BYTES = 1024 * 1024;
const TOP_KEYS = new Set(["schema", "projectsBase", "projects", "gateAllowlist", "companionPluginRoot", "reaperExtraRoots"]);
const ROW_KEYS = new Set(["dir", "name", "write", "git", "pii", "review"]);

// git is false too: no caller reaches a git action for an unknown folder today (review admission
// refuses on review_allowed first and direct admission refuses the unknown name outright), so this only
// closes the axis for any future caller rather than changing current behavior.
const DEFAULT_POLICY = { name: RESERVED_NAME, write: false, git: false, pii: true };

// Characters Windows refuses in a file name (and the two separators), and its reserved device names.
const WIN_BAD_CHARS = /[<>:"|?*\\/\u0000-\u001f]/;
const WIN_DEVICE_STEM = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

// True when `name` is ONE folder name that Windows cannot read two ways. Win32 strips a trailing dot or
// space (so "proj." opens "proj"), maps device names to devices, and reads a ~digit name as a possible
// 8.3 alias of some other folder. `allowShortName` lets an absolute path from the settings file keep a
// segment like "LONGNA~1": that path is resolved by the OS before use, so an alias there is harmless.
export function isUnambiguousName(name, { allowShortName = false } = {}) {
  if (typeof name !== "string" || name === "") return false;
  if (WIN_BAD_CHARS.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  if (WIN_DEVICE_STEM.test(name.split(".")[0].replace(/ +$/, ""))) return false;
  if (!allowShortName && /~[0-9]/.test(name)) return false;
  if (name !== name.normalize("NFC")) return false;
  return true;
}

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

// Absolute on this platform without help from any current folder: a drive letter plus separator or a
// UNC / device path (two leading separators) on Windows; a leading "/" elsewhere.
function isFullyQualified(p, platform) {
  if (typeof p !== "string" || p === "" || p.includes("\u0000")) return false;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return p.startsWith("/");
}

// The canonical spelling rule for absolute paths written in the settings file (see the header).
export function isCanonicalAbsolutePath(p, platform = process.platform) {
  if (!isFullyQualified(p, platform)) return false;
  const api = pathApiFor(platform);
  const win = platform === "win32";
  if (win && /^[\\/]{2}[?.][\\/]/.test(p)) return false;
  const root = api.parse(p).root;
  // path.win32.normalize adds a trailing separator to a bare UNC share root (server and share, nothing after); accept that one form.
  const uncShareRoot = win && root === p && api.normalize(p) === p + "\\";
  if (api.normalize(p) !== p && !uncShareRoot) return false;
  if (root === "" || (p.length > root.length && /[\\/]$/.test(p))) return false;
  if (!win) return true;
  return p.slice(root.length).split("\\").filter((x) => x !== "")
    .every((seg) => isUnambiguousName(seg, { allowShortName: true }));
}

class PolicyFileError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function fail(reason) {
  return { ok: false, reason, projectsBase: "", table: [], gateAllowlist: [], companionPluginRoot: "", reaperExtraRoots: [] };
}

export function policyFilePath(env = process.env) {
  const fromEnv = env.CODEX_MCP_POLICY_FILE;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return path.join(os.homedir(), ".codex-mcp", "project-policy.json");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkAbsolutePath(v) {
  if (typeof v !== "string") throw new PolicyFileError("wrong_type");
  if (!isCanonicalAbsolutePath(v)) throw new PolicyFileError("bad_path");
  return v;
}

function checkKeys(obj, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new PolicyFileError("unknown_key");
}

function checkName(v) {
  if (typeof v !== "string") throw new PolicyFileError("wrong_type");
  if (!NAME_RE.test(v) || v === RESERVED_NAME) throw new PolicyFileError("bad_value");
  return v;
}

function checkRow(row) {
  if (!isPlainObject(row)) throw new PolicyFileError("wrong_type");
  checkKeys(row, ROW_KEYS);
  if (typeof row.dir !== "string" || typeof row.name !== "string") throw new PolicyFileError("wrong_type");
  for (const k of ["write", "git", "pii"]) if (typeof row[k] !== "boolean") throw new PolicyFileError("wrong_type");
  if (row.review !== undefined && typeof row.review !== "boolean") throw new PolicyFileError("wrong_type");
  if (!isUnambiguousName(row.dir)) throw new PolicyFileError("bad_value");
  checkName(row.name);
  const out = { dir: row.dir, name: row.name, write: row.write, git: row.git, pii: row.pii };
  if (row.review !== undefined) out.review = row.review;
  return out;
}

function validate(doc) {
  if (!isPlainObject(doc) || doc.schema !== POLICY_SCHEMA) throw new PolicyFileError("bad_schema");
  checkKeys(doc, TOP_KEYS);
  if (!isCanonicalAbsolutePath(doc.projectsBase)) throw new PolicyFileError("bad_projects_base");
  if (!Array.isArray(doc.projects)) throw new PolicyFileError("wrong_type");
  const names = new Set();
  const dirs = new Set();
  const table = [];
  for (const raw of doc.projects) {
    const row = checkRow(raw);
    if (names.has(row.name)) throw new PolicyFileError("duplicate_name");
    // Upper-casing approximates the NTFS rule (it upper-cases with its own table): it joins "\u00e9" and
    // "\u00c9", which Windows treats as one name, and keeps KELVIN SIGN apart from "k", which Windows
    // also keeps apart. Where it over-joins (e.g. a sharp s against "SS") the file is refused, never
    // loosened.
    const dirKey = row.dir.toUpperCase();
    if (dirs.has(dirKey)) throw new PolicyFileError("duplicate_dir");
    names.add(row.name);
    dirs.add(dirKey);
    table.push(row);
  }
  let gateAllowlist = [];
  if (doc.gateAllowlist !== undefined) {
    if (!Array.isArray(doc.gateAllowlist)) throw new PolicyFileError("wrong_type");
    const seen = new Set();
    for (const n of doc.gateAllowlist) {
      checkName(n);
      if (seen.has(n)) throw new PolicyFileError("duplicate_name");
      if (!names.has(n)) throw new PolicyFileError("gate_name_not_a_project");
      seen.add(n);
    }
    gateAllowlist = [...seen];
  }
  let companionPluginRoot = "";
  if (doc.companionPluginRoot !== undefined) companionPluginRoot = checkAbsolutePath(doc.companionPluginRoot);
  let reaperExtraRoots = [];
  if (doc.reaperExtraRoots !== undefined) {
    if (!Array.isArray(doc.reaperExtraRoots)) throw new PolicyFileError("wrong_type");
    reaperExtraRoots = doc.reaperExtraRoots.map(checkAbsolutePath);
  }
  return { ok: true, reason: null, projectsBase: doc.projectsBase, table, gateAllowlist, companionPluginRoot, reaperExtraRoots };
}

// Pure: reads and validates one file. No cache, no stderr. Never throws.
export function loadPolicyConfig(filePath) {
  try {
    // Fully qualified only: on Windows "\x\file" resolves against the current drive (path.isAbsolute
    // accepts it), so the file read would depend on where the process was started.
    if (!isFullyQualified(filePath, process.platform)) throw new PolicyFileError("path_not_absolute");
    let text;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) throw new PolicyFileError("file_unreadable");
      if (st.size > MAX_FILE_BYTES) throw new PolicyFileError("file_too_large");
      text = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      if (e instanceof PolicyFileError) throw e;
      throw new PolicyFileError(e && e.code === "ENOENT" ? "file_missing" : "file_unreadable");
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new PolicyFileError("bad_json");
    }
    return validate(doc);
  } catch (e) {
    return fail(e instanceof PolicyFileError ? e.reason : "file_unreadable");
  }
}

let cached = null;

// Lazy, process-wide. A failed load prints ONE reason line to stderr (never file contents).
export function cachedPolicyConfig() {
  if (cached === null) {
    cached = loadPolicyConfig(policyFilePath(process.env));
    if (!cached.ok) {
      process.stderr.write(`codex-mcp: project policy file not loaded (${cached.reason}); every folder is treated as an unknown, sensitive project\n`);
    }
  }
  return cached;
}

export function _resetPolicyCacheForTests() {
  cached = null;
}

function unknownPolicy() {
  return {
    name: DEFAULT_POLICY.name,
    write_allowed: DEFAULT_POLICY.write,
    git_allowed: DEFAULT_POLICY.git,
    pii_sensitive: DEFAULT_POLICY.pii,
    review_allowed: !DEFAULT_POLICY.pii
  };
}

// The OS's own resolution of an absolute path, or null when it cannot be resolved safely. The longest
// existing prefix is resolved natively; each missing name below it is appended as written, but only
// when it passes isUnambiguousName. A name that EXISTS but does not resolve (a dangling link) and any
// error other than "not found" fail closed: walking past them would grant the parent folder's policy to
// a path the OS would send somewhere else.
export function canonicalPath(p, deps = {}) {
  const parts = canonicalParts(p, deps);
  if (parts === null) return null;
  const sep = (deps.platform ?? process.platform) === "win32" ? "\\" : "/";
  return parts.root + parts.segs.map((x) => x.name).join(sep);
}

// canonicalPath split into its root and named segments, each marked `real` when the OS resolved it
// (spelled as stored on disk) or not when it is part of the missing tail (spelled as written).
function canonicalParts(p, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const realpath = deps.realpath ?? fs.realpathSync.native;
  const lstat = deps.lstat ?? fs.lstatSync;
  if (!isFullyQualified(p, platform)) return null;
  const api = pathApiFor(platform);
  // Native realpath reads each name literally, but Windows rewrites some names when it opens a path or
  // starts a process (it drops a trailing dot or space, folds "." and "..", maps device names). A link
  // named "secret." can then pass the check as its target while a job started there runs in "secret".
  // So on Windows EVERY segment, existing or not, must be one Windows can read only one way.
  if (platform === "win32") {
    const segs = p.slice(api.parse(p).root.length).split(/[\\/]/).filter((x) => x !== "");
    if (!segs.every((seg) => isUnambiguousName(seg, { allowShortName: true }))) return null;
  }
  const tail = [];
  const trailingSep = platform === "win32" ? /[\\/]$/ : /\/$/;
  // Collapse repeated separators after the root, so each name the walk peels off is the exact name it
  // asked the OS about.
  const root0 = api.parse(p).root;
  let cur = root0 + (platform === "win32"
    ? p.slice(root0.length).replace(/[\\/]+/g, "\\")
    : p.slice(root0.length).replace(/\/+/g, "/"));
  for (let depth = 0; depth < 4096; depth++) {
    // Drop trailing separators first (never the root's): on POSIX "link/" makes lstat follow the link,
    // so a dangling link would read as a missing name instead of failing closed below.
    const rootLen = api.parse(cur).root.length;
    while (cur.length > rootLen && trailingSep.test(cur)) cur = cur.slice(0, -1);
    try {
      const real = String(realpath(cur));
      const root = api.parse(real).root;
      const realSegs = real.slice(root.length).split(platform === "win32" ? /[\\/]/ : "/")
        .filter((x) => x !== "").map((name) => ({ name, real: true }));
      return { root, segs: realSegs.concat(tail.map((name) => ({ name, real: false }))) };
    } catch (e) {
      if (!e || e.code !== "ENOENT") return null;
    }
    try { lstat(cur); return null; } catch (e) { if (!e || e.code !== "ENOENT") return null; }
    const parent = api.dirname(cur);
    const name = api.basename(cur);
    if (parent === cur || !isUnambiguousName(name)) return null;
    tail.unshift(name);
    cur = parent;
  }
  return null;
}

function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// Windows: the volume a path is on, read from the text alone (no file-system call): "drive:c" for a
// local drive (plain or \\?\ form), "unc:server\share" for a network share (plain or \\?\UNC\ form),
// or null for anything else (\\.\ device paths, \\?\GLOBALROOT, ...).
function windowsVolumeOf(p) {
  if (typeof p !== "string") return null;
  let m = /^[\\/]{2}\?[\\/]([A-Za-z]):[\\/]/.exec(p) || /^([A-Za-z]):[\\/]/.exec(p);
  if (m) return "drive:" + asciiLower(m[1]);
  m = /^[\\/]{2}\?[\\/]UNC[\\/]([^\\/]+)[\\/]([^\\/]+)/i.exec(p) || /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]([^\\/]+)/.exec(p);
  if (m) return "unc:" + asciiLower(m[1]) + "\\" + asciiLower(m[2]);
  return null;
}

// Windows: walk the cwd one name at a time WITHOUT following links, and check every link's target
// BEFORE anything opens it. A target must be on a local drive or on \`allowedShare\` (the projects
// folder's share, or null); a target that depends on a current folder ("\\x", "C:x") or names a device
// is refused. Relative targets resolve from the link's own folder. Bounded at 40 links (a loop fails).
// A missing name ends the walk: there is nothing past it to follow.
function linksStayLocal(p, allowedShare, deps) {
  const lstat = deps.lstat ?? fs.lstatSync;
  const readlink = deps.readlink ?? fs.readlinkSync;
  const api = path.win32;
  const split = (x) => x.split(/[\\/]/).filter((seg) => seg !== "");
  let root = api.parse(p).root;
  let pending = split(p.slice(root.length));
  let cur = root;
  let links = 0;
  while (pending.length > 0) {
    const seg = pending.shift();
    // "." and ".." are taken one step at a time, never collapsed as text first: a link the text would
    // skip over ("foo\\..\\x") is still inspected above, because the OS may open it.
    if (seg === ".") continue;
    if (seg === "..") { cur = api.dirname(cur); continue; }
    const next = api.join(cur, seg);
    let st;
    try { st = lstat(next); } catch (e) { return Boolean(e) && e.code === "ENOENT"; }
    if (!st.isSymbolicLink()) { cur = next; continue; }
    if (++links > 40) return false;
    let target;
    try { target = String(readlink(next)); } catch { return false; }
    const targetRoot = api.parse(target).root;
    const targetSegs = split(target.slice(targetRoot.length));
    // A target's names get the cwd's rules too (a "secret." inside a target is the same trick).
    if (!targetSegs.every((x) => x === "." || x === ".." || isUnambiguousName(x, { allowShortName: true }))) return false;
    if (targetRoot === "") {
      // Relative: from the link's own folder. Windows' internal absolute forms with the prefix removed
      // ("UNC\\host\\share", "GLOBALROOT\\...", "Volume{...}") look relative here and are refused.
      if (targetSegs.length > 0 && /^(unc|globalroot|volume\{.*)$/i.test(targetSegs[0])) return false;
      pending = targetSegs.concat(pending);
      continue;
    }
    if (!isFullyQualified(target, "win32")) return false;
    const volume = windowsVolumeOf(target);
    if (volume === null || (volume.startsWith("unc:") && volume !== allowedShare)) return false;
    root = targetRoot;
    pending = targetSegs.concat(pending);
    cur = root;
  }
  return true;
}

// True when `child` is `parent` or inside it. Every name is compared exactly: a name the OS resolved
// comes back spelled as stored on disk, and inside an NTFS folder marked case-sensitive "safe" and "SAFE"
// are two folders, so folding could join them; a missing name cannot host a job yet, so refusing a
// case variant of one costs nothing. Only the root (drive letter, share) is case-folded.
function isAtOrUnder(child, parent, fold) {
  if (fold(child.root) !== fold(parent.root) || child.segs.length < parent.segs.length) return false;
  return parent.segs.every((p, i) => {
    const c = child.segs[i];
    return p.name === c.name;
  });
}

// `deps` (platform, realpath, lstat) exists for tests; production callers pass at most (cwd, config).
// A null/undefined cwd means this process's own folder, which is always absolute.
export function resolvePolicy(cwd, config = cachedPolicyConfig(), deps = {}) {
  const platform = deps.platform ?? process.platform;
  const api = pathApiFor(platform);
  const lstat = deps.lstat ?? fs.lstatSync;
  const fold = platform === "win32" ? asciiLower : (x) => x;
  let raw = cwd;
  if (raw === undefined || raw === null) {
    try { raw = process.cwd(); } catch { return unknownPolicy(); }
  }
  // Resolving a network path contacts that server (on Windows it may answer with the user's NTLM
  // response), so a cwd that is not on a local drive is refused BEFORE any file-system call, unless it
  // is on the same share as the projects folder. Device-namespace forms are refused outright. Links on
  // the way are checked the same way, without following them, before realpath runs.
  const baseVolume = platform === "win32" ? windowsVolumeOf(config.projectsBase) : null;
  const allowedShare = baseVolume !== null && baseVolume.startsWith("unc:") ? baseVolume : null;
  if (platform === "win32") {
    const volume = windowsVolumeOf(raw);
    if (volume === null) return unknownPolicy();
    if (volume.startsWith("unc:") && volume !== allowedShare) return unknownPolicy();
    const segs = raw.slice(api.parse(raw).root.length).split(/[\\/]/).filter((x) => x !== "");
    if (!segs.every((x) => isUnambiguousName(x, { allowShortName: true }))) return unknownPolicy();
    if (!linksStayLocal(raw, allowedShare, deps)) return unknownPolicy();
  }
  const target = canonicalParts(raw, deps);
  if (target === null) return unknownPolicy();

  let match = null;
  if (typeof config.projectsBase === "string" && config.projectsBase !== "") {
    for (const entry of config.table) {
      // A row folder that is a link would hand the row's policy to whatever tree it points at, so it
      // matches nothing. Checked on every call: a link created after the file was loaded counts too.
      const projectPath = api.join(config.projectsBase, entry.dir);
      // The same link check as the cwd's, before this row's path is opened at all.
      if (platform === "win32" && !linksStayLocal(projectPath, allowedShare, deps)) continue;
      try {
        if (lstat(projectPath).isSymbolicLink()) continue;
      } catch (e) {
        if (!e || e.code !== "ENOENT") continue;
      }
      const project = canonicalParts(projectPath, deps);
      if (project === null || !isAtOrUnder(target, project, fold)) continue;
      if (match !== null) return unknownPolicy();   // two rows claim this folder: ambiguous
      match = entry;
    }
  }
  if (match === null) return unknownPolicy();
  return {
    name: match.name,
    write_allowed: match.write,
    git_allowed: match.git,
    pii_sensitive: match.pii,
    review_allowed: match.review ?? !match.pii
  };
}

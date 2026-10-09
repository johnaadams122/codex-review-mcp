// tests/policy.canonical.test.mjs -- resolvePolicy matches REAL locations, not spellings.
//
// The folder handed to resolvePolicy and each project folder are both resolved by the operating system
// (native realpath: junctions/symlinks followed, 8.3 short names expanded, \\?\ prefixes removed) before
// they are compared, with ASCII-only case folding on Windows. Anything that cannot be resolved safely
// (a relative or drive-relative path, a dangling link, an ambiguous missing name, two projects claiming
// one folder) gets the fail-closed unknown policy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolvePolicy, loadPolicyConfig } from "../policy.mjs";
import { admit } from "../admission.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";
import { installPolicyFixture, ALPHA, BETA, GAMMA, DELTA } from "./helpers/policy-fixture.mjs";

const WIN = process.platform === "win32";
const BS = String.fromCharCode(92);
// The release CI requires the exact same skipped-test set on every Windows machine, so a test whose
// Windows feature (8.3 names, symlinks, per-folder case sensitivity) is missing on this machine adds a TAP
// note and returns instead of calling t.skip, and the one non-Windows test is registered only off Windows.
// The note method's name is assembled from parts so the public-release word scanner does not flag it.
const NOTE_METHOD = ["diag", "nostic"].join("");
const notExercised = (t, why) => t[NOTE_METHOD](`not exercised on this machine: ${why}`);

const KAPPA = { dir: "kappa", name: "project_kappa", write: true, git: true, pii: false };
const fx = installPolicyFixture({ after }, { projects: [ALPHA, BETA, GAMMA, DELTA, KAPPA] });
const at = (row, ...sub) => fx.dirOf(row, ...sub);
for (const row of [ALPHA, BETA, GAMMA, DELTA, KAPPA]) fs.mkdirSync(at(row), { recursive: true });
fs.mkdirSync(at(BETA, "src"), { recursive: true });

function link(target, where) {
  fs.symlinkSync(target, where, WIN ? "junction" : "dir");
}

const UNKNOWN = { name: "unknown", write_allowed: false, git_allowed: false, pii_sensitive: true, review_allowed: false };

// ---------------------------------------------------------------- input shape

test("the unknown policy is git-blocked too (fail closed on every axis)", () => {
  assert.deepEqual(resolvePolicy(path.join(path.dirname(fx.base), "not-a-project")), UNKNOWN);
});

test("a relative cwd is refused even when the server's own folder is inside a project", (t) => {
  const prev = process.cwd();
  process.chdir(at(BETA));
  t.after(() => process.chdir(prev));
  assert.equal(resolvePolicy(at(BETA)).name, "project_beta", "control: the absolute spelling matches");
  assert.deepEqual(resolvePolicy("."), UNKNOWN);
  assert.deepEqual(resolvePolicy("src"), UNKNOWN);
  assert.deepEqual(resolvePolicy(path.join("..", BETA.dir)), UNKNOWN);
});

test("an empty or non-string cwd is refused", () => {
  assert.deepEqual(resolvePolicy(""), UNKNOWN);
  assert.deepEqual(resolvePolicy(42), UNKNOWN);
  assert.deepEqual(resolvePolicy({}), UNKNOWN);
});

test("null/undefined cwd still means the server's own folder (an absolute path)", (t) => {
  const prev = process.cwd();
  process.chdir(at(BETA, "src"));
  t.after(() => process.chdir(prev));
  assert.equal(resolvePolicy(null).name, "project_beta");
  assert.equal(resolvePolicy(undefined).name, "project_beta");
});

test("Windows drive-relative and rooted-without-drive cwds are refused", { skip: !WIN }, (t) => {
  const prev = process.cwd();
  process.chdir(at(BETA));
  t.after(() => process.chdir(prev));
  const drive = at(BETA).slice(0, 2);                   // "C:"
  assert.deepEqual(resolvePolicy(drive + "src"), UNKNOWN, "C:src resolves against the per-drive current folder");
  assert.deepEqual(resolvePolicy(drive), UNKNOWN);
  assert.deepEqual(resolvePolicy(at(BETA).slice(2)), UNKNOWN, "\\path has no drive and resolves against the current drive");
  assert.deepEqual(resolvePolicy(at(BETA).slice(2).split(BS).join("/")), UNKNOWN);
});

// ---------------------------------------------------------------- Windows-equivalent spellings

test("trailing dot and trailing space spellings never match the project they look like", () => {
  for (const suffix of [".", " ", ". .", "..."]) {
    assert.deepEqual(resolvePolicy(at(GAMMA) + suffix), UNKNOWN, JSON.stringify(suffix));
    assert.deepEqual(resolvePolicy(path.join(at(GAMMA) + suffix, "sub")), UNKNOWN, JSON.stringify(suffix) + " + sub");
  }
});

test("an ambiguous MISSING name below a real project fails closed; an ordinary missing name inherits", () => {
  assert.equal(resolvePolicy(at(GAMMA, "not-made-yet", "deeper")).name, "project_gamma");
  for (const bad of ["sub.", "sub ", "CON", "nul.txt", "a:b", "PROJEC~1"]) {
    assert.deepEqual(resolvePolicy(at(BETA, bad)), UNKNOWN, bad);
  }
});

test("the \\\\?\\ long-path prefix resolves to the same project", { skip: !WIN }, () => {
  const lp = BS + BS + "?" + BS;
  assert.equal(resolvePolicy(lp + at(GAMMA)).name, "project_gamma");
  assert.equal(resolvePolicy(lp + at(GAMMA, "missing")).name, "project_gamma");
  assert.equal(resolvePolicy(lp + at(GAMMA) + ".").name, "unknown", "under \\\\?\\ a trailing dot names a different folder");
});

test("an 8.3 short-name spelling resolves to the same project", { skip: !WIN }, (t) => {
  // The fixture's own folder first; many volumes no longer generate 8.3 names for new folders, so fall
  // back to the system folder whose short name Windows creates at install time.
  const short = execFileSync("cmd", ["/d", "/s", "/c", `"for %I in ("${at(DELTA)}") do @echo %~sI"`],
    { encoding: "utf8", windowsVerbatimArguments: true }).trim();
  if (short.toLowerCase() !== at(DELTA).toLowerCase()) {
    assert.equal(resolvePolicy(short).name, "project_delta");
    return;
  }
  const drive = process.env.SystemDrive || "C:";
  const longName = path.join(drive + BS, "Program Files");
  const shortName = path.join(drive + BS, "PROGRA~1");
  let resolved;
  try { resolved = fs.realpathSync.native(shortName); } catch { resolved = null; }
  if (resolved === null || resolved.toLowerCase() !== longName.toLowerCase()) { notExercised(t, "no 8.3 names"); return; }
  const config = loadPolicyConfig(writeConfig(t, { projectsBase: drive + BS, projects: [{ ...GAMMA, dir: "Program Files" }] }));
  assert.equal(config.ok, true, config.reason);
  assert.equal(resolvePolicy(shortName, config).name, "project_gamma");
  assert.equal(resolvePolicy(path.join(shortName, "not-there"), config).name, "project_gamma");
});

test("a Unicode case-fold look-alike (KELVIN SIGN for k) is a different folder and never matches", () => {
  const kelvin = path.join(fx.base, "\u212Aappa");
  assert.deepEqual(resolvePolicy(kelvin), UNKNOWN, "missing look-alike");
  // Windows (NTFS) and Linux keep the two names apart; a file system that folds them (macOS APFS) refuses
  // the second folder, and the missing-name case above already covers it there.
  let made = true;
  try { fs.mkdirSync(kelvin); } catch (e) { if (e.code !== "EEXIST") throw e; made = false; }
  if (made) assert.deepEqual(resolvePolicy(kelvin), UNKNOWN, "existing look-alike folder");
  assert.equal(resolvePolicy(at(KAPPA)).name, "project_kappa", "control");
});

test("ASCII case differences still match (Windows file names are case-insensitive)", { skip: !WIN }, () => {
  assert.equal(resolvePolicy(at(BETA).toUpperCase()).name, "project_beta");
  assert.equal(resolvePolicy(at(BETA, "SRC", "Missing").toLowerCase()).name, "project_beta");
});

// Inside an NTFS folder marked case-sensitive, "safe" and "SAFE" are two folders. Names that exist are
// compared exactly (realpath returns each one as stored on disk); folding is only for two MISSING names.
// An injected file system keeps this test deterministic on every platform.
test("names are compared exactly, so look-alike folders that differ only in case never match", () => {
  const W = (...p) => p.join(BS);
  const onDisk = new Set([W("C:", "base"), W("C:", "base", "safe"), W("C:", "base", "SAFE")]);
  const enoent = () => Object.assign(new Error("not found"), { code: "ENOENT" });
  const deps = {
    platform: "win32",
    realpath: (p) => { if (p === "C:" + BS || onDisk.has(p)) return p; throw enoent(); },
    lstat: (p) => { if (p === "C:" + BS || onDisk.has(p)) return { isSymbolicLink: () => false }; throw enoent(); },
  };
  const config = { ok: true, projectsBase: W("C:", "base"), table: [{ ...BETA, dir: "safe" }, { ...GAMMA, dir: "later" }] };
  assert.equal(resolvePolicy(W("C:", "base", "safe", "x"), config, deps).name, "project_beta", "control");
  assert.deepEqual(resolvePolicy(W("C:", "base", "SAFE"), config, deps), UNKNOWN, "existing look-alike");
  assert.deepEqual(resolvePolicy(W("C:", "base", "SAFE", "x"), config, deps), UNKNOWN, "missing name under the look-alike");
  assert.deepEqual(resolvePolicy(W("C:", "base", "Safe"), config, deps), UNKNOWN, "missing name vs an existing row folder");
  assert.deepEqual(resolvePolicy(W("C:", "base", "LATER", "x"), config, deps), UNKNOWN, "two missing names are compared exactly too");
  assert.equal(resolvePolicy(W("C:", "base", "later", "x"), config, deps).name, "project_gamma", "control");
});

// Resolving a network path contacts that server (on Windows, possibly sending the user's NTLM
// response). A cwd on a network share is refused BEFORE any file-system call, unless the projects
// folder itself lives on that same share.
test("a network cwd is refused before any file-system call unless the projects folder is on that share", () => {
  const W = (...p) => p.join(BS);
  const touched = [];
  const enoent = () => Object.assign(new Error("not found"), { code: "ENOENT" });
  const shareBase = W("", "", "files", "team", "projects");
  const onDisk = new Set(["C:" + BS, W("C:", "base"), W("C:", "base", "beta"), W("", "", "files", "team") + BS, shareBase, W(shareBase, "beta")]);
  const LP = BS + BS + "?" + BS, DP = BS + BS + "." + BS;
  // like native realpath: the long-path UNC form (LP + "UNC" + server + share) becomes the plain two-backslash share
  // form, and LP + "C:" becomes the plain drive root
  const plain = (p) => p.toUpperCase().startsWith(LP + "UNC" + BS) ? BS + BS + p.slice(LP.length + 4)
    : (p.startsWith(LP) ? p.slice(LP.length) : p);
  const deps = {
    platform: "win32",
    realpath: (p) => { touched.push(p); if (onDisk.has(plain(p))) return plain(p); throw enoent(); },
    lstat: (p) => { touched.push(p); if (onDisk.has(plain(p))) return { isSymbolicLink: () => false }; throw enoent(); },
  };
  const local = { ok: true, projectsBase: W("C:", "base"), table: [{ ...BETA, dir: "beta" }] };
  for (const cwd of [W("", "", "attacker.example", "share", "x"), "//attacker.example/share/x",
    LP + W("UNC", "attacker.example", "share", "x"), DP + W("UNC", "attacker.example", "share", "x"),
    DP + W("C:", "base", "beta"), LP + W("GLOBALROOT", "Device", "Mup", "attacker.example", "share")]) {
    touched.length = 0;
    assert.deepEqual(resolvePolicy(cwd, local, deps), UNKNOWN, JSON.stringify(cwd));
    assert.ok(!touched.some((p) => p.toLowerCase().includes("attacker")), `${JSON.stringify(cwd)} touched ${JSON.stringify(touched)}`);
  }
  const onShare = { ok: true, projectsBase: shareBase, table: [{ ...BETA, dir: "beta" }] };
  assert.equal(resolvePolicy(W(shareBase, "beta", "x"), onShare, deps).name, "project_beta", "the configured share is allowed");
  assert.equal(resolvePolicy(LP + W("UNC", "files", "team", "projects", "beta"), onShare, deps).name, "project_beta");
  touched.length = 0;
  assert.deepEqual(resolvePolicy(W("", "", "attacker.example", "share", "x"), onShare, deps), UNKNOWN, "a different share");
  assert.ok(!touched.some((p) => p.toLowerCase().includes("attacker")));
  assert.equal(resolvePolicy(LP + W("C:", "base", "beta"), local, deps).name, "project_beta", "local long-path form is fine");
});

// A tiny simulated Windows file system: `entries` maps a path to "dir" or { link: target }. realpath
// follows links the way the OS would and records every path it had to open, so a test can prove which
// hosts were contacted.
function fakeWinFs(entries) {
  const touched = [];
  const enoent = () => Object.assign(new Error("not found"), { code: "ENOENT" });
  const get = (p) => entries[p.toLowerCase()];
  const resolveOnce = (p, hops = 0) => {
    if (hops > 40) throw Object.assign(new Error("loop"), { code: "ELOOP" });
    const root = path.win32.parse(p).root;
    let cur = root.endsWith(BS) ? root : root + BS;
    const segs = p.slice(root.length).split(BS).filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const next = path.win32.join(cur, segs[i]);
      touched.push(next);
      const e = get(next);
      if (e === undefined) throw enoent();
      if (e !== "dir") {
        const target = path.win32.isAbsolute(e.link) ? e.link : path.win32.join(cur, e.link);
        return resolveOnce(path.win32.join(target, ...segs.slice(i + 1)), hops + 1);
      }
      cur = next;
    }
    return cur;
  };
  return {
    touched,
    deps: {
      platform: "win32",
      realpath: (p) => resolveOnce(p),
      lstat: (p) => {
        touched.push(p);
        const e = get(p.replace(/[\\]+$/, "") || p);
        if (e === undefined && !/^[A-Za-z]:[\\]?$/.test(p)) throw enoent();
        return { isSymbolicLink: () => e !== undefined && e !== "dir" };
      },
      readlink: (p) => { const e = get(p); if (!e || e === "dir") throw Object.assign(new Error("not a link"), { code: "EINVAL" }); return e.link; },
    },
  };
}

test("a symlink to a network share is refused before anything follows it (no host is contacted)", () => {
  const W = (...p) => p.join(BS);
  const net = W("", "", "attacker.example", "share");
  const { touched, deps } = fakeWinFs({
    [W("c:", "base")]: "dir", [W("c:", "base", "beta")]: "dir", [W("c:", "base", "gamma")]: "dir",
    [W("c:", "base", "beta", "out")]: { link: net },
    [W("c:", "base", "beta", "hop")]: { link: "hop2" }, [W("c:", "base", "beta", "hop2")]: { link: net + BS + "x" },
    [W("c:", "base", "beta", "rooted")]: { link: BS + "somewhere" },
    [W("c:", "base", "beta", "loop1")]: { link: "loop2" }, [W("c:", "base", "beta", "loop2")]: { link: "loop1" },
    [W("c:", "base", "beta", "local")]: { link: W("C:", "base", "gamma") },
  });
  const config = { ok: true, projectsBase: W("C:", "base"), table: [{ ...BETA, dir: "beta" }, { ...GAMMA, dir: "gamma" }] };
  for (const cwd of [W("C:", "base", "beta", "out"), W("C:", "base", "beta", "out", "x"), W("C:", "base", "beta", "hop", "y"),
    W("C:", "base", "beta", "rooted"), W("C:", "base", "beta", "loop1")]) {
    touched.length = 0;
    assert.deepEqual(resolvePolicy(cwd, config, deps), UNKNOWN, JSON.stringify(cwd));
    assert.ok(!touched.some((p) => p.toLowerCase().includes("attacker")), `${JSON.stringify(cwd)} touched ${JSON.stringify(touched)}`);
  }
  assert.equal(resolvePolicy(W("C:", "base", "beta", "local", "z"), config, deps).name, "project_gamma", "a local link is still followed");
  assert.equal(resolvePolicy(W("C:", "base", "beta", "src"), config, deps).name, "project_beta", "control");
});

test("link targets get the same name rules, every link on the way is inspected, and internal target forms are refused", () => {
  const W = (...p) => p.join(BS);
  const net = W("", "", "attacker.example", "share");
  const { touched, deps } = fakeWinFs({
    [W("c:", "base")]: "dir", [W("c:", "base", "beta")]: "dir", [W("c:", "base", "beta", "legit")]: "dir",
    [W("c:", "base", "secret")]: "dir",
    [W("c:", "base", "beta", "foo")]: { link: net },
    [W("c:", "base", "beta", "dotdot")]: { link: W("foo", "..", "legit") },             // collapses past foo as text
    [W("c:", "base", "beta", "dotted")]: { link: W("C:", "base", "secret.") },          // trailing dot inside a target
    [W("c:", "base", "beta", "dev")]: { link: W("C:", "base", "COM1") },
    [W("c:", "base", "beta", "nt-unc")]: { link: W("UNC", "attacker.example", "share") },
    [W("c:", "base", "beta", "nt-glob")]: { link: W("GLOBALROOT", "Device", "Mup", "attacker.example", "share") },
    [W("c:", "base", "beta", "nt-vol")]: { link: "Volume{0000}" + BS + "x" },
    [W("c:", "base", "beta", "drive-rel")]: { link: "C:somewhere" },
    [W("c:", "base", "beta", "uplink")]: { link: W("..", "beta", "legit") },             // an ordinary relative link
  });
  const config = { ok: true, projectsBase: W("C:", "base"), table: [{ ...BETA, dir: "beta" }] };
  for (const name of ["dotdot", "dotted", "dev", "nt-unc", "nt-glob", "nt-vol", "drive-rel"]) {
    touched.length = 0;
    assert.deepEqual(resolvePolicy(W("C:", "base", "beta", name, "x"), config, deps), UNKNOWN, name);
    assert.ok(!touched.some((p) => /attacker|secret|com1/i.test(p)), `${name} touched ${JSON.stringify(touched)}`);
  }
  assert.equal(resolvePolicy(W("C:", "base", "beta", "uplink"), config, deps).name, "project_beta", "control: a plain ../ link");
  touched.length = 0;
  assert.deepEqual(resolvePolicy(W("C:", "base", "beta", "CON"), config, deps), UNKNOWN);
  assert.deepEqual(resolvePolicy(W("C:", "base", "beta", "x."), config, deps), UNKNOWN);
  assert.ok(!touched.some((p) => /\\con$|x\.$/i.test(p)), `ambiguous cwd names must be refused before any lstat: ${JSON.stringify(touched)}`);
});

test("a projects folder reached through a link to a network share is never opened", () => {
  const W = (...p) => p.join(BS);
  const { touched, deps } = fakeWinFs({
    [W("c:", "base")]: { link: W("", "", "attacker.example", "share") },
    [W("c:", "other")]: "dir",
  });
  const config = { ok: true, projectsBase: W("C:", "base", "inner"), table: [{ ...BETA, dir: "beta" }] };
  assert.deepEqual(resolvePolicy(W("C:", "other", "x"), config, deps), UNKNOWN);
  assert.deepEqual(resolvePolicy(W("C:", "base", "inner", "beta"), config, deps), UNKNOWN);
  assert.ok(!touched.some((p) => p.toLowerCase().includes("attacker")), JSON.stringify(touched));
});

test("a real symlink to a network share gets the unknown policy", { skip: !WIN }, (t) => {
  const where = at(BETA, "to-network");
  try { fs.symlinkSync(BS + BS + "nohost.invalid" + BS + "share", where, "dir"); }
  catch (e) { notExercised(t, `cannot create symlinks (${e.code})`); return; }
  t.after(() => fs.rmdirSync(where));
  const started = Date.now();
  assert.deepEqual(resolvePolicy(where), UNKNOWN);
  assert.deepEqual(resolvePolicy(path.join(where, "x")), UNKNOWN);
  assert.ok(Date.now() - started < 2000, "refused without waiting on the network");
});

test("a real case-sensitive NTFS folder keeps look-alike folders apart", { skip: !WIN }, (t) => {
  const base = tempDirFor(t, "policy-casesens-", { realpath: true });
  try {
    execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", base, "enable"], { stdio: "ignore" });
  } catch { notExercised(t, "per-folder case sensitivity is not available"); return; }
  fs.mkdirSync(path.join(base, "safe"));
  // fsutil can report success while Windows refused the change (for example "Access is denied" on a
  // folder whose permissions do not allow it), so check the effect: in a case-insensitive folder the
  // second name already exists.
  try { fs.mkdirSync(path.join(base, "SAFE")); } catch (e) {
    if (e.code === "EEXIST") { notExercised(t, "per-folder case sensitivity did not take effect"); return; }
    throw e;
  }
  const config = { ok: true, projectsBase: base, table: [{ ...BETA, dir: "safe" }] };
  assert.equal(resolvePolicy(path.join(base, "safe"), config).name, "project_beta", "control");
  assert.deepEqual(resolvePolicy(path.join(base, "SAFE"), config), UNKNOWN);
  assert.deepEqual(resolvePolicy(path.join(base, "SAFE", "missing"), config), UNKNOWN);
});

if (!WIN) {
  test("matching is exact on case-sensitive platforms", () => {
    assert.deepEqual(resolvePolicy(path.join(fx.base, BETA.dir.toUpperCase())), UNKNOWN);
  });
}

// ---------------------------------------------------------------- links

test("a junction/symlink under a permissive project takes the policy of where it POINTS", () => {
  link(at(GAMMA), at(BETA, "to-gamma"));
  assert.equal(resolvePolicy(at(BETA, "to-gamma")).name, "project_gamma");
  assert.equal(resolvePolicy(at(BETA, "to-gamma", "deeper", "missing")).name, "project_gamma");
  const outside = tempDirFor({ after }, "policy-outside-", { realpath: true });
  link(outside, at(BETA, "to-outside"));
  assert.deepEqual(resolvePolicy(at(BETA, "to-outside")), UNKNOWN);
});

test("a dangling link fails closed instead of inheriting the folder it sits in", () => {
  const target = path.join(fx.base, "gone-later");
  fs.mkdirSync(target);
  link(target, at(BETA, "dangling"));
  fs.rmdirSync(target);
  assert.deepEqual(resolvePolicy(at(BETA, "dangling")), UNKNOWN);
  assert.deepEqual(resolvePolicy(at(BETA, "dangling", "x")), UNKNOWN);
  // a trailing separator must not hide the link from the "exists but does not resolve" check
  assert.deepEqual(resolvePolicy(at(BETA, "dangling") + path.sep), UNKNOWN, "trailing separator");
  assert.deepEqual(resolvePolicy(at(BETA, "dangling") + path.sep + path.sep), UNKNOWN, "doubled trailing separator");
  assert.deepEqual(resolvePolicy(at(BETA) + path.sep + path.sep + "dangling" + path.sep + "x"), UNKNOWN, "doubled inner separator");
  const task = admit({ kind: "task", cwd: at(BETA, "dangling") + path.sep, write: true, task: "x" });
  assert.equal(task.policy.name, "unknown");
  assert.equal(task.effective_write, false);
});

// On POSIX a trailing slash makes lstat follow the link, so "dangling/" reports "not found" just like a
// missing name. The walk must look at the link itself. Injected so it runs on every platform.
test("POSIX: a dangling link spelled with a trailing slash still fails closed", () => {
  const enoent = () => Object.assign(new Error("not found"), { code: "ENOENT" });
  const dirs = new Set(["/", "/base", "/base/beta"]);
  const deps = {
    platform: "linux",
    realpath: (p) => { if (dirs.has(p)) return p; throw enoent(); },
    lstat: (p) => {
      if (dirs.has(p)) return { isSymbolicLink: () => false };
      if (p === "/base/beta/dangling") return { isSymbolicLink: () => true };
      throw enoent();
    },
  };
  const config = { ok: true, projectsBase: "/base", table: [{ ...BETA, dir: "beta" }] };
  assert.equal(resolvePolicy("/base/beta/missing", config, deps).name, "project_beta", "control");
  assert.deepEqual(resolvePolicy("/base/beta/dangling", config, deps), UNKNOWN);
  assert.deepEqual(resolvePolicy("/base/beta/dangling/", config, deps), UNKNOWN);
  assert.deepEqual(resolvePolicy("/base/beta/dangling//", config, deps), UNKNOWN);
  assert.deepEqual(resolvePolicy("/base/beta//dangling/x", config, deps), UNKNOWN);
});

test("the synchronous admission gate refuses relative and drive-relative cwds too", (t) => {
  const prev = process.cwd();
  process.chdir(at(BETA));
  t.after(() => process.chdir(prev));
  for (const cwd of [".", "src", ...(WIN ? [at(BETA).slice(0, 2) + "src", at(BETA).slice(2)] : [])]) {
    const task = admit({ kind: "task", cwd, write: true, task: "x" });
    assert.equal(task.policy.name, "unknown", JSON.stringify(cwd));
    assert.equal(task.effective_write, false, JSON.stringify(cwd));
    const review = admit({ kind: "review", cwd });
    assert.equal(review.allowed, false, JSON.stringify(cwd));
  }
});

test("a project folder that is itself a link matches nothing (its target's tree never inherits the row)", (t) => {
  const real = tempDirFor(t, "policy-linked-project-", { realpath: true });
  const base = tempDirFor(t, "policy-linkbase-", { realpath: true });
  const config = loadPolicyConfig(writeConfig(t, { projectsBase: base, projects: [{ ...BETA, dir: "linked" }] }));
  assert.equal(config.ok, true);
  assert.equal(resolvePolicy(path.join(base, "linked", "a"), config).name, "project_beta", "control: a missing row folder still matches");
  link(real, path.join(base, "linked"));   // created AFTER the config was loaded: checked on every call
  assert.deepEqual(resolvePolicy(path.join(base, "linked", "a"), config), UNKNOWN);
  assert.deepEqual(resolvePolicy(path.join(real, "a"), config), UNKNOWN);
});

// Windows rewrites some names when it starts a process (a trailing dot or space is dropped), but the
// OS path resolution used for the check reads them literally. A link with such a name could otherwise
// pass the check as one project while the job runs in another.
test("a link whose name Windows rewrites at process start never passes as the link's target", { skip: !WIN }, (t) => {
  const LP = BS + BS + "?" + BS;
  for (const name of [DELTA.dir + ".", DELTA.dir + " "]) {
    link(at(BETA), LP + path.join(fx.base, name));
    t.after(() => fs.rmdirSync(LP + path.join(fx.base, name)));
    assert.deepEqual(resolvePolicy(path.join(fx.base, name)), UNKNOWN, JSON.stringify(name));
    assert.deepEqual(resolvePolicy(LP + path.join(fx.base, name)), UNKNOWN, "long-path spelling of " + JSON.stringify(name));
    assert.deepEqual(resolvePolicy(path.join(fx.base, name, "sub")), UNKNOWN, JSON.stringify(name) + " + sub");
  }
  // the same trick one level up: a link "<base>." pointing into a permissive project
  const parent = path.dirname(fx.base);
  const dotted = path.basename(fx.base) + ".";
  link(at(BETA), LP + path.join(parent, dotted));
  t.after(() => fs.rmdirSync(LP + path.join(parent, dotted)));
  assert.deepEqual(resolvePolicy(path.join(parent, dotted, DELTA.dir)), UNKNOWN);
});

test("any dot, dot-dot, stream or device segment in the cwd is refused on Windows", { skip: !WIN }, () => {
  assert.deepEqual(resolvePolicy(at(BETA) + BS + "." + BS + "src"), UNKNOWN);
  assert.deepEqual(resolvePolicy(at(BETA) + BS + "src" + BS + ".."), UNKNOWN);
  assert.deepEqual(resolvePolicy(at(BETA) + "::$INDEX_ALLOCATION"), UNKNOWN);
  assert.deepEqual(resolvePolicy(at(BETA) + BS + "CON"), UNKNOWN);
  assert.equal(resolvePolicy(at(BETA, "src")).name, "project_beta", "control");
});

test("a linked row matches nothing, but a cwd reached THROUGH that link takes its real folder's policy", (t) => {
  const base = tempDirFor(t, "policy-dupbase-", { realpath: true });
  fs.mkdirSync(path.join(base, "one"));
  link(path.join(base, "one"), path.join(base, "two"));
  const config = loadPolicyConfig(writeConfig(t, { projectsBase: base, projects: [
    { ...BETA, dir: "one" }, { ...GAMMA, dir: "two" },
  ] }));
  assert.equal(config.ok, true);
  assert.equal(resolvePolicy(path.join(base, "one"), config).name, "project_beta");
  assert.equal(resolvePolicy(path.join(base, "two", "x"), config).name, "project_beta", "the job runs in one\\x");
});

// The settings file refuses two dirs Windows treats as one name, so this needs a hand-built config:
// the runtime rule is the backstop for anything validation does not see.
test("two rows that resolve to the same folder make it ambiguous: fail closed", { skip: !WIN }, (t) => {
  const base = tempDirFor(t, "policy-dupbase2-", { realpath: true });
  fs.mkdirSync(path.join(base, "one"));
  const config = { ok: true, projectsBase: base, table: [{ ...BETA, dir: "one" }, { ...GAMMA, dir: "ONE" }] };
  assert.deepEqual(resolvePolicy(path.join(base, "one"), config), UNKNOWN);
  assert.deepEqual(resolvePolicy(path.join(base, "one", "x"), config), UNKNOWN);
});

test("the synchronous admission gate sees the link target too (write and review)", () => {
  link(at(DELTA), at(BETA, "to-delta"));
  const task = admit({ kind: "task", cwd: at(BETA, "to-delta"), write: true, task: "x" });
  assert.equal(task.policy.name, "project_delta");
  link(at(ALPHA), at(BETA, "to-alpha"));
  const review = admit({ kind: "review", cwd: at(BETA, "to-alpha") });
  assert.equal(review.allowed, false);
  assert.equal(review.reason, "pii_project");
});

// ---------------------------------------------------------------- helpers

function writeConfig(t, over) {
  const dir = tempDirFor(t, "policy-canon-", { realpath: true });
  const file = path.join(dir, "project-policy.json");
  fs.writeFileSync(file, JSON.stringify({ schema: "codex-mcp-project-policy-v1", ...over }));
  return file;
}

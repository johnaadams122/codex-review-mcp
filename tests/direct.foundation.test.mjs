import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseLogCap, spawnSpecFor, parseCodexVersion, buildChildEnv, buildDirectArgs,
  identityEquals, VALIDATED_VERSIONS, SIGNATURES, READ_FENCE,
  resolveDirectRuntime, _resetDirectRuntime, statBinaryIdentity,
} from "../direct.mjs";
import { tempDirFor } from "./helpers/test-cleanup.mjs";

// A working direct runtime backed by a real on-disk fake binary (so resolveDirectRuntime's
// realpath succeeds). deps.stat/deps.readBin are injected in individual tests to control the
// identity fields independently of the file on disk. `root` is a private CODEX_DIRECT_ROOT:
// without it, resolving the runtime makes an instance folder in the live <OS temp>/codex-direct
// (these four tests used to leave four there on every run).
function freshBinRuntime(t) {
  const binDir = tempDirFor(t, "a1-dig-bin-");
  const bin = path.join(binDir, "fake-codex.mjs");
  fs.writeFileSync(bin, "// on-disk fake bytes\n", "utf8");
  const home = tempDirFor(t, "a1-dig-home-");
  const root = tempDirFor(t, "a1-dig-root-");
  return { bin, home, root };
}

test("parseLogCap: default 50MB, clamp [1MB..1GB], garbage -> default", () => {
  assert.equal(parseLogCap({}), 50 * 1024 * 1024);
  assert.equal(parseLogCap({ CODEX_DIRECT_LOG_CAP: "abc" }), 50 * 1024 * 1024);
  assert.equal(parseLogCap({ CODEX_DIRECT_LOG_CAP: "10" }), 1024 * 1024);
  assert.equal(parseLogCap({ CODEX_DIRECT_LOG_CAP: String(5 * 1024 ** 3) }), 1024 ** 3);
});

test("spawnSpecFor: .mjs/.js run via node (test seam); binaries run directly", () => {
  const exe = String.raw`C:\bin\codex.exe`;
  assert.deepEqual(spawnSpecFor(exe, ["--version"]),
    { cmd: exe, args: ["--version"] });
  const spec = spawnSpecFor("C:\\t\\fake-codex.mjs", ["exec"]);
  assert.equal(spec.cmd, process.execPath);
  assert.deepEqual(spec.args, ["C:\\t\\fake-codex.mjs", "exec"]);
});

test("parseCodexVersion: token after 'codex-cli '; garbage -> null", () => {
  assert.equal(parseCodexVersion("codex-cli 0.144.1"), "0.144.1");
  assert.equal(parseCodexVersion("something else"), null);
  assert.equal(parseCodexVersion(""), null);
});

test("buildChildEnv is a NAMED allowlist -- no OPENAI_*/CODEX_* wildcards, no proxy vars", () => {
  const env = {
    PATH: "p", TEMP: "t", USERPROFILE: "u", SystemRoot: "s",
    // secret-shaped values are assembled at run time so no source line looks like a credential
    OPENAI_API_KEY: ["sk", "secret"].join("-"), CODEX_API_KEY: "leak", HTTPS_PROXY: ["http://user", "pw@x"].join(":"),
    OTHER_SERVICE_TOKEN: "secret",
  };
  const codexHome = String.raw`C:\fixtures\codex-home`;
  const child = buildChildEnv(codexHome, env);
  assert.equal(child.PATH, "p");
  assert.equal(child.CODEX_HOME, codexHome);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.CODEX_API_KEY, undefined);
  assert.equal(child.HTTPS_PROXY, undefined);
  assert.equal(child.OTHER_SERVICE_TOKEN, undefined);
});

test("pinned argv, in order, --ignore-user-config mandatory", () => {
  const args = buildDirectArgs({ model: "gpt-6-astra", effort: "max", cwd_real: "C:\\repo",
    answerFile: "C:\\t\\answer.txt", version: "0.144.1" });
  assert.deepEqual(args.slice(0, 13), [
    "exec", "--sandbox", "read-only", "--ignore-user-config", "--json",
    "-o", "C:\\t\\answer.txt", "--color", "never", "--skip-git-repo-check",
    "-C", "C:\\repo", "-m",
  ]);
  assert.equal(args[13], "gpt-6-astra");
  assert.deepEqual(args.slice(14, 16), ["-c", "model_reasoning_effort=max"]);
});

test("bootstrap artifacts: fail-closed while unpinned, coherent with the argv once pinned", () => {
  assert.ok(SIGNATURES.write.test("UnauthorizedAccessException"));
  assert.ok(SIGNATURES.write.test("PermissionDenied"));
  assert.ok(SIGNATURES.write.test("rejected: blocked by policy"));
  const manifest = VALIDATED_VERSIONS["0.144.1"].networkDisableArgs;
  const args = buildDirectArgs({ model: "m", effort: "e", cwd_real: "C:\\r", answerFile: "C:\\a", version: "0.144.1" });
  if (manifest === null) {
    // network signature not yet pinned: the network judgment must be un-satisfiable and no disable tokens ride.
    assert.equal(SIGNATURES.network, null);
    assert.ok(!args.some((a) => String(a).startsWith("features.")));
  } else {
    // once pinned: every reviewed disable token must ride EVERY production argv.
    assert.ok(Array.isArray(manifest) && manifest.length > 0);
    for (const tok of manifest) assert.ok(args.includes(tok), `argv must carry ${tok}`);
    assert.ok(SIGNATURES.network instanceof RegExp);
  }
});

test("identityEquals compares all four fields", () => {
  const a = { path: "p", version: "0.144.1", size: 1, mtime: 2 };
  assert.equal(identityEquals(a, { ...a }), true);
  assert.equal(identityEquals(a, { ...a, mtime: 3 }), false);
  assert.equal(identityEquals(a, null), false);
});

test("identityEquals: false when only the digest differs (fifth field enforced)", () => {
  const a = { path: "p", version: "0.144.1", size: 1, mtime: 2, digest: "aaaa" };
  assert.equal(identityEquals(a, { ...a }), true);
  assert.equal(identityEquals(a, { ...a, digest: "bbbb" }), false);
});

test("statBinaryIdentity: digest is sha256 hex of the binary bytes, present with the other four fields", (t) => {
  _resetDirectRuntime();
  const { bin, home, root } = freshBinRuntime(t);
  const bytes = "BINARY-CONTENT-XYZ";
  const id = statBinaryIdentity({
    env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "", CODEX_DIRECT_ROOT: root },
    spawnSync: () => ({ stdout: "codex-cli 0.144.1\n" }),
    readBin: () => bytes,
  });
  assert.ok(id);
  assert.equal(id.digest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(id.version, "0.144.1");
  assert.equal(typeof id.path, "string");
  assert.equal(typeof id.size, "number");
  assert.equal(typeof id.mtime, "number");
  _resetDirectRuntime();
});

test("statBinaryIdentity DISCRIMINATOR: identical size+mtime+version, different bytes -> different digest -> identityEquals FALSE (binary-substitution leg closed)", (t) => {
  _resetDirectRuntime();
  const { bin, home, root } = freshBinRuntime(t);
  // size + mtime held EQUAL across both stats; only the byte content changes.
  const base = {
    env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "", CODEX_DIRECT_ROOT: root },
    spawnSync: () => ({ stdout: "codex-cli 0.144.1\n" }),
    stat: () => ({ size: 4242, mtimeMs: 999 }),
  };
  const idA = statBinaryIdentity({ ...base, readBin: () => "ORIGINAL-BINARY" });
  const idB = statBinaryIdentity({ ...base, readBin: () => "SWAPPED-BINARY" });
  assert.ok(idA && idB);
  assert.equal(idA.size, idB.size);
  assert.equal(idA.mtime, idB.mtime);
  assert.equal(idA.version, idB.version);
  assert.notEqual(idA.digest, idB.digest);
  assert.equal(identityEquals(idA, idB), false);
  _resetDirectRuntime();
});

test("statBinaryIdentity DISCRIMINATOR: same size+mtime, changed digest -> version RE-PARSED, never the stale cached one", (t) => {
  _resetDirectRuntime();
  const { bin, home, root } = freshBinRuntime(t);
  // size + mtime held EQUAL across both stats; the byte content (digest) AND the reported version
  // change on the swap. The changed digest must force a --version re-parse; the stale allow-listed
  // 0.144.1 must NOT ride the swapped binary through the version gate + its network manifest.
  const base = {
    env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "", CODEX_DIRECT_ROOT: root },
    stat: () => ({ size: 7777, mtimeMs: 555 }),
  };
  const idA = statBinaryIdentity({ ...base, readBin: () => "BINARY-V1", spawnSync: () => ({ stdout: "codex-cli 0.144.1\n" }) });
  const idB = statBinaryIdentity({ ...base, readBin: () => "BINARY-V2-SWAP", spawnSync: () => ({ stdout: "codex-cli 0.200.0\n" }) });
  assert.ok(idA && idB);
  assert.equal(idA.size, idB.size);
  assert.equal(idA.mtime, idB.mtime);
  assert.notEqual(idA.digest, idB.digest);
  assert.equal(idB.version, "0.200.0");
  assert.notEqual(idB.version, idA.version);
  _resetDirectRuntime();
});

test("statBinaryIdentity: a throwing byte read -> null (fail closed, matching the stat pattern)", (t) => {
  _resetDirectRuntime();
  const { bin, home, root } = freshBinRuntime(t);
  const id = statBinaryIdentity({
    env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "", CODEX_DIRECT_ROOT: root },
    spawnSync: () => ({ stdout: "codex-cli 0.144.1\n" }),
    readBin: () => { throw new Error("read fail"); },
  });
  assert.equal(id, null);
  _resetDirectRuntime();
});

test("resolveDirectRuntime caches a failure when no binary resolves", () => {
  _resetDirectRuntime();
  const rt = resolveDirectRuntime({ env: { PATH: "", CODEX_BIN: undefined } });
  assert.ok(rt.error);
  assert.equal(statBinaryIdentity({ env: { PATH: "" } }), null);
  _resetDirectRuntime();
});

// spawn without a shell starts only a real executable on Windows, so PATH lookup there must skip npm's
// extensionless sh shim and its .cmd wrapper (an ordinary npm install puts both on PATH). Registered on
// Windows only: the lookup rule is Windows-specific and the release CI needs the same test set everywhere.
if (process.platform === "win32") {
  const pathFixture = (t, files) => {
    const dirs = files.map((names) => {
      const d = tempDirFor(t, "a1-path-dir-");
      for (const n of names) fs.writeFileSync(path.join(d, n), "x", "utf8");
      return d;
    });
    return { PATH: dirs.join(path.delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD",
      CODEX_HOME: tempDirFor(t, "a1-path-home-"), CODEX_DIRECT_ROOT: tempDirFor(t, "a1-path-root-") };
  };

  test("Windows PATH lookup takes codex.exe and never the npm sh or .cmd shim found first", (t) => {
    _resetDirectRuntime();
    const calls = [];
    const env = pathFixture(t, [["codex", "codex.cmd"], ["codex.exe"]]);
    const rt = resolveDirectRuntime({ env, spawnSync: (cmd) => { calls.push(cmd); return { stdout: "codex-cli 0.160.1" }; } });
    _resetDirectRuntime();
    assert.equal(rt.error, undefined);
    assert.equal(path.basename(rt.codexBin).toLowerCase(), "codex.exe");
    assert.deepEqual(calls, [rt.codexBin]);
  });

  test("Windows PATH lookup with only npm shims fails before any spawn and names CODEX_BIN", (t) => {
    _resetDirectRuntime();
    let spawned = 0;
    const env = pathFixture(t, [["codex", "codex.cmd"]]);
    const rt = resolveDirectRuntime({ env, spawnSync: () => { spawned++; return { stdout: "codex-cli 0.160.1" }; } });
    _resetDirectRuntime();
    assert.match(String(rt.error), /CODEX_BIN/);
    assert.equal(spawned, 0);
  });
}

test("CODEX_DIRECT_ROOT seam: instanceDir lives under it when set, default root otherwise", (t) => {
  const binDir = tempDirFor(t, "a1-fdbin-");
  const bin = path.join(binDir, "fake-codex.mjs");
  fs.writeFileSync(bin, "//", "utf8");
  const home = tempDirFor(t, "a1-fdhome-");
  const spawnSync = () => ({ stdout: "codex-cli 0.144.1\n" });

  _resetDirectRuntime();
  const root = tempDirFor(t, "a1-fdroot-");
  const withRoot = resolveDirectRuntime({ env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "", CODEX_DIRECT_ROOT: root }, spawnSync });
  assert.equal(path.dirname(withRoot.instanceDir), root);

  _resetDirectRuntime();
  // The default root is <OS temp>/codex-direct, the folder the live MCP server uses, and resolving a
  // runtime creates an instance folder in it. Point os.tmpdir() at a private folder for this call so
  // the test proves the default without writing into the live folder (it used to leave one there).
  const fakeTemp = tempDirFor(t, "a1-fdtemp-");
  t.mock.method(os, "tmpdir", () => fakeTemp);
  const withoutRoot = resolveDirectRuntime({ env: { CODEX_BIN: bin, CODEX_HOME: home, PATH: "" }, spawnSync });
  assert.equal(path.dirname(withoutRoot.instanceDir), path.join(fakeTemp, "codex-direct"));
  assert.ok(fs.existsSync(withoutRoot.instanceDir), "the instance folder was made under the private stand-in");

  _resetDirectRuntime();
});

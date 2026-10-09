import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, "fixtures");

const { parsePanelTimeout, DEFAULT_PANEL_TIMEOUT_MS } = await import("../panel.mjs");

// WHY THIS MOVED: runGate calls runPanel WITHOUT a timeoutMs, so every companion-transport
// gate ran on the 480_000 default -- 8 minutes -- while the max/direct path already got
// parseDirectTimeout()'s 1_200_000. Flagship gpt-6.1-sol/xhigh over a ~173 KB spec packet
// exceeded 8 min on repeated runs, and because ANY
// abstention blocks fail-closed, a short timeout reads exactly like "this document fails".
// A too-long timeout only costs waiting; a too-short one manufactures false blockers.

test("panel default timeout is 30 minutes when the env var is unset", () => {
  assert.equal(parsePanelTimeout({}), 1800000);
});

test("DEFAULT_PANEL_TIMEOUT_MS is at least the direct-transport timeout", () => {
  // The companion path must never be stingier than the direct path; that asymmetry was the bug.
  assert.ok(DEFAULT_PANEL_TIMEOUT_MS >= 1200000,
    `companion default ${DEFAULT_PANEL_TIMEOUT_MS} is below the 1200000 direct default`);
});

test("panel timeout honors an explicit env override", () => {
  assert.equal(parsePanelTimeout({ CODEX_PANEL_TIMEOUT_MS: "900000" }), 900000);
});

test("panel timeout clamps to the same [60s, 2h] band as the direct transport", () => {
  assert.equal(parsePanelTimeout({ CODEX_PANEL_TIMEOUT_MS: "1" }), 60000);
  assert.equal(parsePanelTimeout({ CODEX_PANEL_TIMEOUT_MS: String(10 ** 8 - 1) }), 7200000);
});

test("an unparseable panel timeout falls back to the default, never NaN", () => {
  // A NaN timeout is not a slow gate, it is an INFINITE one: every poll deadline check is
  // `Date.now() - started > timeoutMs`, and any comparison against NaN is false forever.
  const v = parsePanelTimeout({ CODEX_PANEL_TIMEOUT_MS: "not-a-number" });
  assert.ok(Number.isFinite(v), "timeout must be finite");
  assert.equal(v, 1800000);
});

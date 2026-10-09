// tests/helpers/hermetic-policy.mjs -- import this (bare, for the side effect) from any test file that can
// reach policy, jobs, gate, panel, server or orchestrator code and does not install its own policy fixture.
//
// policy.mjs reads a settings file from the user's home folder when CODEX_MCP_POLICY_FILE is unset. Without
// this guard a test could pick up that real file (so results would differ per machine) or print the
// fail-safe reason line when the file is missing. The guard installs a private, valid settings file with
// an empty project table, so every folder is the "unknown" default, nothing is allowlisted and no
// companion plugin root is configured. tools/check-policy-isolation.mjs proves no test reads the home file.
import { after } from "node:test";
import { installPolicyFixture } from "./policy-fixture.mjs";

installPolicyFixture({ after }, { projects: [] });

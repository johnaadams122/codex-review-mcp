#!/bin/sh
# Installed as each allowlisted repo's .git/hooks/post-commit. sessionId is synthesized (surfacing
# keys off runId/targetKey, not the session). Provides {sessionId,cwd,sha} exactly as runLauncherHook expects.
SHA="$(git rev-parse HEAD)"
ROOT="$(git rev-parse --show-toplevel)"
printf '{"sessionId":"post-commit:%s","cwd":"%s","sha":"%s"}' "$SHA" "$ROOT" "$SHA" \
  | node "<CODEX_MCP>/hooks/gate-run.mjs"
exit 0

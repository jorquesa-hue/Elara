#!/bin/bash
# SessionStart hook — install dev dependencies so a web session can run the
# kernel test suite (`npm test`) and typecheck (`npm run typecheck`) immediately.
# The kernel itself is zero-runtime-dependency; devDeps are tsx + typescript +
# @types/node. Synchronous so deps are guaranteed present before the agent loop
# starts. Idempotent + non-interactive.
set -euo pipefail

# Only needed in the remote (Claude Code on the web) environment; a local machine
# already has its deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"
# `npm install` (not `npm ci`) so a warm container cache is reused across sessions.
npm install --no-audit --no-fund

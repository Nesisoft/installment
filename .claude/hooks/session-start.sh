#!/bin/bash
# SessionStart hook — installs workspace dependencies so tests and linters
# can run in remote Claude Code sessions. Runs only in remote env; safe to
# re-run (pnpm install is idempotent).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

echo "[session-start] node $(node -v), pnpm $(pnpm -v)"
echo "[session-start] installing workspace dependencies..."
pnpm install --prefer-offline
echo "[session-start] done."

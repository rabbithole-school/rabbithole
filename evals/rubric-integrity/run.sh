#!/usr/bin/env bash
# Convenience wrapper: requires ANTHROPIC_API_KEY for live runs, then runs the
# harness. NODE_OPTIONS forces the `import` exports condition — the harness
# imports convex/sessionHelpers, whose chain reaches @convex-dev/auth/server,
# which only publishes an `import` condition; without this, tsx resolves the
# eval as CJS and dies with ERR_PACKAGE_PATH_NOT_EXPORTED.
set -euo pipefail
requires_api_key=true
for arg in "$@"; do
  if [[ "$arg" == "--offline" ]]; then
    requires_api_key=false
  fi
done
if [[ "$requires_api_key" == true ]]; then
  : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"
fi
export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=import"
cd "$(dirname "$0")/../.."
exec npx tsx evals/rubric-integrity/run.ts "$@"

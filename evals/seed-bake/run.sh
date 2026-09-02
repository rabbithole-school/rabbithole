#!/usr/bin/env bash
# Convenience wrapper: requires ANTHROPIC_API_KEY, then runs
# the baked-vs-ad-lib seed→unit bake eval. The bake itself runs SERVER-SIDE via
# `npx convex run` against this worktree's dev deployment (CONVEX_DEPLOYMENT in
# .env.local), so run this from a provisioned worktree. The local judge/tutor/
# scholar-sim calls use the exported ANTHROPIC_API_KEY.
set -euo pipefail
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=import"
cd "$(dirname "$0")/../.."
exec npx tsx evals/seed-bake/run.ts "$@"

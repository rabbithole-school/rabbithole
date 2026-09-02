#!/usr/bin/env bash
# Physical-task appropriateness eval — regression gate.
# Requires ANTHROPIC_API_KEY, then runs the harness.
# Exits non-zero when a hard gate (leak / invented-gear / over-trigger) regresses.
#
#   bash evals/physical-task/run.sh [--samples N] [--no-gate]
set -euo pipefail
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"

cd "$(dirname "$0")/../.."
exec npx tsx evals/physical-task/run.ts "$@"

#!/usr/bin/env bash
# Stop the web app and the local backend that local/setup.sh started. The
# fictional school stays on disk; pnpm local:setup starts it again.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
stop_all
say "Stopped. Start again with pnpm local:setup"

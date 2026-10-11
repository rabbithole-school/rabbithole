#!/usr/bin/env bash
# Stop the web app and the local backend that bin/setup.sh started. Your
# pretend school stays on disk; bin/setup.sh starts it again.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
stop_all
say "Stopped. Start again with bin/setup.sh"

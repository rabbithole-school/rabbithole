#!/usr/bin/env bash
# Is Rabbithole running, and who can you sign in as?
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
guard_no_cloud
[ -f "$APP/local/status.sh" ] || { say "Rabbithole isn't set up yet. Run bin/setup.sh"; exit 0; }
app_run status

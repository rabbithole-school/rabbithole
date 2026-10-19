#!/usr/bin/env bash
# Give the tutor an Anthropic API key. Rabbithole takes the key on its own
# page, /tutor-key, which works only on this computer and only while no key is
# set; the key never passes through an agent's chat. This opens that page
# (sending the browser on to the scholar's view once the key is saved) and
# returns as soon as Rabbithole reports the key, so an agent can wait on it.
#
#   bin/set-key.sh   open the key page and wait (up to 30 minutes)
#
# To replace a key that's already set, set it from a terminal in rabbithole/:
#   CONVEX_AGENT_MODE=anonymous npx convex env set ANTHROPIC_API_KEY
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
guard_no_cloud

pid_alive next && pid_alive convex || die "Rabbithole isn't running yet. Start it with bin/setup.sh, then run this again."

# Not grep -q: under pipefail its early exit would fail the pipeline.
key_set() { app_run status 2>/dev/null | grep 'Tutor key: *set' >/dev/null; }

if key_set; then
  say "The tutor already has a key."
  exit 0
fi

next="/dev-login?u=leilani_park&to=%2Fscholar"
url="http://localhost:$WEB_PORT/tutor-key?next=$(printf %s "$next" | sed 's/?/%3F/; s/=/%3D/g; s/&/%26/g')"
say "Opening Rabbithole's key page: $url"
say "Paste the key there. It's checked with Anthropic and saved in this computer's Rabbithole only."
case "$(uname -s)" in
  Darwin) open "$url" 2>/dev/null || true ;;
  Linux) xdg-open "$url" >/dev/null 2>&1 || true ;;
esac

for _ in $(seq 1 900); do # 30 minutes, every 2 seconds
  if key_set; then
    say "The tutor has its key. The page is taking the person to the scholar's view."
    say "While a key is set, Rabbithole's scheduled jobs can call the model too, so stop it (bin/stop.sh) when you're done."
    exit 0
  fi
  sleep 2
done
die "no key arrived in 30 minutes; nothing changed. Run bin/set-key.sh again when ready."

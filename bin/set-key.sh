#!/usr/bin/env bash
# Give the local tutor an Anthropic API key so it can answer.
# Run this yourself, in your own terminal: it reads the key with the input
# hidden, and the key never passes through an agent's chat.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
guard_no_cloud
pid_alive convex || die "Rabbithole isn't running. Start it with bin/setup.sh, then run this again."
say "Paste an Anthropic API key (it starts with sk-ant-). Get one at https://console.anthropic.com"
say "Rabbithole sends tutor conversations to Anthropic with this key, and Anthropic bills you for that use."
printf 'Key (hidden): '
IFS= read -rs key
printf '\n'
[ -n "$key" ] || die "no key entered; nothing changed"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://api.anthropic.com/v1/models \
  -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" || true)"
case "$code" in
  200) say "Anthropic accepted the key." ;;
  401 | 403) unset key; die "Anthropic rejected that key (HTTP $code). Check it and run bin/set-key.sh again; nothing changed." ;;
  *) say "Couldn't reach Anthropic to check the key (HTTP ${code:-none}); saving it anyway." ;;
esac
(cd "$APP" && printf %s "$key" | npx convex env set ANTHROPIC_API_KEY >/dev/null)
unset key
say "Saved, in this computer's local Rabbithole only."
say "While a key is set, Rabbithole's scheduled jobs can call the model too, so stop it (bin/stop.sh) when you're done."
say "To remove the key:"
say "  (cd rabbithole && CONVEX_AGENT_MODE=anonymous npx convex env remove ANTHROPIC_API_KEY)"

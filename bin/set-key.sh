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
(cd "$APP" && printf %s "$key" | npx convex env set ANTHROPIC_API_KEY >/dev/null)
unset key
say "Saved, in this computer's local Rabbithole only. To remove it:"
say "  (cd rabbithole && CONVEX_AGENT_MODE=anonymous npx convex env remove ANTHROPIC_API_KEY)"

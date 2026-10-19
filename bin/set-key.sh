#!/usr/bin/env bash
# Give the local tutor an Anthropic API key so it can answer. The key never
# passes through an agent's chat.
#
#   bin/set-key.sh            asks for the key here, with the input hidden
#   bin/set-key.sh --browser  opens a one-time page on this computer to paste
#                             it into, and returns once it's saved
#   bin/set-key.sh --stdin    reads the key from standard input (the page
#                             uses this)
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
guard_no_cloud

case "${1:-}" in
  --browser) exec node "$KIT/lib/key-page.mjs" ;;
  --stdin) IFS= read -r key || true ;;
  *)
    say "Paste an Anthropic API key (it starts with sk-ant-). Get one at https://platform.claude.com/settings/keys"
    say "Rabbithole sends tutor conversations to Anthropic with this key, and Anthropic bills you for that use."
    printf 'Key (hidden): '
    IFS= read -rs key
    printf '\n'
    ;;
esac
key="$(printf %s "$key" | tr -d '[:space:]')"
[ -n "$key" ] || die "no key entered; nothing changed"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://api.anthropic.com/v1/models \
  -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" || true)"
case "$code" in
  200) say "Anthropic accepted the key." ;;
  401 | 403) unset key; die "Anthropic rejected that key (HTTP $code). Check it and try again; nothing changed." ;;
  *) say "Couldn't reach Anthropic to check the key (HTTP ${code:-none}); saving it anyway." ;;
esac

if pid_alive convex; then
  (cd "$APP" && printf %s "$key" | npx convex env set ANTHROPIC_API_KEY >/dev/null)
  unset key
  say "Saved, in this computer's local Rabbithole only."
else
  (umask 077 && printf %s "$key" >"$PENDING_KEY")
  unset key
  say "Saved on this computer. Rabbithole isn't running yet; bin/setup.sh hands the key over once it is."
fi
say "While a key is set, Rabbithole's scheduled jobs can call the model too, so stop it (bin/stop.sh) when you're done."
say "To remove the key:"
say "  (cd rabbithole && CONVEX_AGENT_MODE=anonymous npx convex env remove ANTHROPIC_API_KEY)"

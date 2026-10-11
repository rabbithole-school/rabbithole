#!/usr/bin/env bash
# Print a link to a prefilled "postcard" issue: how far you got, nothing about
# any child. Opening the link shows the postcard first; nothing is sent unless
# you press the button yourself.
#   bin/postcard.sh --who parent --got "signed in as the pretend teacher" \
#     --agent "Claude Code" --minutes 12 --note "anything else"
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
who="" got="" agent="" minutes="" note=""
while [ $# -gt 0 ]; do
  case "$1" in
    --who) who="$2"; shift 2 ;;
    --got) got="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --minutes) minutes="$2"; shift 2 ;;
    --note) note="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
computer="$(uname -s) $(uname -m)"
[ "$(uname -s)" = Darwin ] && computer="macOS $(sw_vers -productVersion 2>/dev/null) $(uname -m)"
node - "$who" "$got" "$agent" "$minutes" "$computer" "$note" <<'JS'
const [who, got, agent, minutes, computer, note] = process.argv.slice(2);
const body = [
  `**Who:** ${who || "(not given)"}`,
  `**Got to:** ${got || "(not given)"}`,
  `**Agent:** ${agent || "(not given)"}`,
  `**Minutes from the line to signing in:** ${minutes || "(not given)"}`,
  `**Computer:** ${computer}`,
  "",
  note || "",
  "",
  "_Sent with the drink-me kit's bin/postcard.sh. Please leave out names or details about any real child._",
].join("\n");
const title = `drink-me postcard: ${who || "someone"} · ${got || "tried it"}`.slice(0, 120);
const q = new URLSearchParams({ title, body });
console.log(`https://github.com/rabbithole-school/rabbithole/issues/new?${q}`);
JS

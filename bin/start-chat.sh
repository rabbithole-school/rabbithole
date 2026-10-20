#!/usr/bin/env bash
# Start the pretend scholar's tutor chat on a topic, and get the person there.
# If the tutor has no key yet, this opens Rabbithole's key page first; once
# the key is saved, the page takes the browser straight into the chat, where
# the tutor opens with a question about the topic. Returns as soon as the
# person is on their way to the chat, so an agent can wait on it.
#
#   bin/start-chat.sh "aquaponics"
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
guard_no_cloud

topic="${1:-}"
[ -n "${topic// /}" ] || die 'give the topic, e.g. bin/start-chat.sh "aquaponics"'
pid_alive next && pid_alive convex || die "Rabbithole isn't running yet. Start it with bin/setup.sh, then run this again."

# Not grep -q: under pipefail its early exit would fail the pipeline.
key_set() { app_run status 2>/dev/null | grep 'Tutor key: *set' >/dev/null; }
urlencode() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
open_url() {
  case "$(uname -s)" in
    Darwin) open "$1" 2>/dev/null || true ;;
    Linux) xdg-open "$1" >/dev/null 2>&1 || true ;;
  esac
}

args="$(node -e 'process.stdout.write(JSON.stringify({ username: "leilani_park", topic: process.argv[1] }))' "$topic")"
out="$(cd "$APP" && npx convex run localRunner:startTopicChat "$args" 2>&1)" ||
  die "couldn't start the chat: $out"
path="$(printf %s "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/"path"\s*:\s*"([^"]+)"/);process.stdout.write(m?m[1]:"")})')"
[ -n "$path" ] || die "couldn't start the chat: $out"

chat="/dev-login?u=leilani_park&to=$(urlencode "$path")"
if key_set; then
  say "Opening the chat about \"$topic\": http://localhost:$WEB_PORT$chat"
  open_url "http://localhost:$WEB_PORT$chat"
  exit 0
fi

url="http://localhost:$WEB_PORT/tutor-key?next=$(urlencode "$chat")"
say "The tutor needs a key first. Opening Rabbithole's key page: $url"
say "Once the key is saved, the page goes straight to the chat about \"$topic\"."
open_url "$url"
for _ in $(seq 1 900); do # 30 minutes, every 2 seconds
  if key_set; then
    say "The tutor has its key, and the page is taking the person into the chat."
    say "While a key is set, Rabbithole's scheduled jobs can call the model too, so stop it (bin/stop.sh) when you're done."
    exit 0
  fi
  sleep 2
done
die "no key arrived in 30 minutes. Run bin/start-chat.sh again when ready; the chat is waiting at http://localhost:$WEB_PORT$chat"

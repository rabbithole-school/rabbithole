#!/usr/bin/env bash
# Check this computer before setup, and say how to fix anything missing.
# Changes nothing.
#   bin/doctor.sh           checks, with fixes
#   bin/doctor.sh --report  the same, plus the last log lines, for an issue
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"

problems=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FIX   %s\n' "$1"; shift; for l in "$@"; do printf '          %s\n' "$l"; done; problems=$((problems + 1)); }
os="$(uname -s)"

say "Checking this computer for Rabbithole"
case "$os" in
  Darwin) ok "macOS $(sw_vers -productVersion 2>/dev/null) on $(uname -m)" ;;
  Linux) ok "Linux $(uname -r) on $(uname -m)" ;;
  *) bad "this kit runs on macOS or Linux; on Windows, use WSL (Ubuntu)" ;;
esac
brew_hint() { [ "$os" = Darwin ] && printf '%s' "$1" || printf '%s' "$2"; }

if command -v git >/dev/null; then ok "git $(git --version | awk '{print $3}')"
else bad "git is missing" "$(brew_hint 'xcode-select --install   (installs git with the command-line tools)' 'install git with your package manager')"; fi

if command -v node >/dev/null; then
  v="$(node -p 'process.versions.node')"; major="${v%%.*}"
  if [ "$major" -ge 20 ]; then ok "Node $v"
  else bad "Node $v is too old; Rabbithole needs Node 20 or newer (22 is what it's tested on)" "$(brew_hint 'brew install node@22   (then follow the PATH line Homebrew prints)' 'install Node 22 from https://nodejs.org or with nvm/mise')"; fi
else bad "Node is missing; Rabbithole needs Node 22" "$(brew_hint 'brew install node@22   (then follow the PATH line Homebrew prints)' 'install Node 22 from https://nodejs.org or with nvm/mise')"; fi

if command -v pnpm >/dev/null; then
  pv="$(pnpm --version 2>/dev/null)"
  if [ "${pv%%.*}" -ge 10 ] 2>/dev/null; then ok "pnpm $pv"
  else bad "pnpm $pv is too old; Rabbithole uses pnpm 10" "$(brew_hint 'brew install pnpm' 'npm install -g pnpm@10')"; fi
else bad "pnpm is missing" "$(brew_hint 'brew install pnpm' 'npm install -g pnpm@10   (or: corepack enable pnpm)')"; fi

for tool in curl openssl; do
  command -v "$tool" >/dev/null && ok "$tool" || bad "$tool is missing" "install it with your package manager"
done

free_kb="$(df -Pk "$KIT" | awk 'NR==2 {print $4}')"
if [ "${free_kb:-0}" -ge 3500000 ]; then ok "$((free_kb / 1048576)) GB free on this disk"
else bad "only $((${free_kb:-0} / 1048576)) GB free; setup needs about 3.5 GB" "free some space, or move this folder to a bigger disk"; fi

if outer="$(cd "$KIT/.." && git rev-parse --show-toplevel 2>/dev/null)" && [ "$outer" != "$HOME" ]; then
  bad "this kit sits inside another git repository ($outer)" "move it somewhere of its own:  mv \"$KIT\" ~/rabbithole-drink-me"
else ok "the kit has a folder of its own"; fi

if [ -n "${CONVEX_DEPLOY_KEY:-}" ]; then bad "CONVEX_DEPLOY_KEY is set in this shell" "open a new shell without it; this kit only runs locally"
else ok "no cloud deploy key in this shell"; fi

for p in "$CLOUD_PORT" "$SITE_PORT" "$WEB_PORT"; do
  if port_busy "$p"; then
    if pid_alive convex || pid_alive next; then ok "port $p is in use by this kit (it's running)"
    else bad "port $p is in use by another program" "stop it, or choose free ports, e.g.  CLOUD_PORT=3310 SITE_PORT=3311 WEB_PORT=3100 bin/setup.sh"; fi
  else ok "port $p is free"; fi
done

if [ "${1:-}" = "--report" ]; then
  say ""
  say "Report (check it before you paste it anywhere; it holds no keys or secrets):"
  say "  kit commit:      $(git -C "$KIT" rev-parse --short HEAD 2>/dev/null || echo none)"
  say "  snapshot commit: $(git -C "$APP" rev-parse --short HEAD 2>/dev/null || echo 'not checked out yet')"
  say "  pinned commit:   $(lock commit | cut -c1-7)"
  for log in install convex next; do
    [ -f "$STATE/$log.log" ] || continue
    say "  --- last lines of .kit/$log.log"
    tail -n 12 "$STATE/$log.log" | sed -E 's/(SECRET|KEY|TOKEN)([=: ]+)[^ ]+/\1\2[hidden]/g; s/^/    /'
  done
fi

say ""
if [ "$problems" -eq 0 ]; then say "All good. Next: bin/setup.sh"; exit 0
else say "$problems thing(s) to fix first."; exit 1; fi

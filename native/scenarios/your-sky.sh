#!/usr/bin/env bash
# A kid's own Sky on the BunnyPad (TRA-699, figures 9 and 9b): the pull from
# the Quests tab opens it. Run against a private worktree deployment whose
# signed-in fictional scholar (test-scholar-001) is outside the 8 pm-6 am
# bedtime window in the deployment school's time zone.
#
#   - With no stars yet, it captures the empty sky's one line and stops.
#   - With stars, the scholar has wonders that include "How do bats find bugs
#     in the dark?" and a shown Quest titled "Echo game" that grew from it. It
#     walks the sky at rest, zooming in, a wonder's drawer, a nearby star
#     moving the sky, the Quest's drawer, "Started from" moving the sky, Done
#     back to Quests, a second pull, "Keep going" and "Open it".
#
# The screenshots are the evidence (landscape, the fleet posture): read them
# rather than trusting the pass line. Contract: run_scenario only; no
# top-level side effects; no EXIT traps (teardown belongs to the harness).

_ys_wonder="How do bats find bugs in the dark?"
_ys_quest="Echo game"

# _ys_wait_contains <substring> [timeout_s]: poll until an element whose name,
# label or value CONTAINS <substring> (case-insensitive) exists.
_ys_wait_contains() {
  local needle="$1" timeout="${2:-60}" lit count deadline
  lit="$(_ael_predicate_literal "$needle")"
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(ael_count_elements "$BASE" "-ios predicate string" \
      "name CONTAINS[c] '$lit' OR label CONTAINS[c] '$lit' OR value CONTAINS[c] '$lit'" \
      2>/dev/null || printf '0')"
    [ "${count:-0}" -ge 1 ] && return 0
    dismiss_dev_menu_if_present
    sleep 0.5
  done
  echo "✗ your-sky: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

# _ys_tap_visible <exact name> [timeout_s]: click the first on-screen element
# with that exact name, waiting for it.
_ys_tap_visible() {
  local lit id deadline
  lit="$(_ael_predicate_literal "$1")"
  deadline=$((SECONDS + ${2:-30}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(ael_find_elements "$BASE" "-ios predicate string" "visible == 1 AND name == '$lit'" 2>/dev/null |
      head -n 1 | grep .)" && {
      ael_click "$BASE" "$id"
      return
    }
    dismiss_dev_menu_if_present
    sleep 0.5
  done
  # Some controls (the drawer's close button) never report visible; one
  # element with the name is the same target.
  tap_name "$1" 2>/dev/null && return 0
  echo "✗ your-sky: no visible '$1'" >&2
  snap "missing-tap-target"
  return 1
}

# _ys_dismiss_dev_toast: a dev build's error toast (its name starts "!, ")
# sits over the bottom of the screen, on top of the zoom buttons and the
# drawer's button. Tap its close button at the right end.
_ys_dismiss_dev_toast() {
  local id rect xy
  id="$(ael_find_elements "$BASE" "-ios predicate string" "visible == 1 AND name BEGINSWITH '!, '" 2>/dev/null |
    head -n 1 | grep .)" || return 0
  rect="$(curl -fsS --max-time 10 "$BASE/element/$id/rect" 2>/dev/null)" || return 0
  xy="$(printf '%s' "$rect" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const r=JSON.parse(s).value;process.stdout.write(`{"x":${Math.round(r.x+r.width-24)},"y":${Math.round(r.y+r.height/2)}}`)}catch{}})')"
  [ -n "$xy" ] || return 0
  curl -fsS --max-time 15 -X POST "$BASE/execute/sync" \
    -H 'Content-Type: application/json' \
    -d "{\"script\":\"mobile: tap\",\"args\":[$xy]}" >/dev/null 2>&1 || true
  sleep 1
}

# _ys_pull: the pull-down on the Quests tab, from high on the list to low.
_ys_pull() {
  local rect w h
  rect="$(curl -fsS --max-time 10 "$BASE/window/rect" 2>/dev/null)"
  w="$(printf '%s' "$rect" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(Math.round(JSON.parse(s).value.width)))}catch{process.stdout.write("1180")}})')"
  h="$(printf '%s' "$rect" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(Math.round(JSON.parse(s).value.height)))}catch{process.stdout.write("820")}})')"
  curl -fsS --max-time 20 -X POST "$BASE/execute/sync" \
    -H 'Content-Type: application/json' \
    -d "{\"script\":\"mobile: dragFromToForDuration\",\"args\":[{\"fromX\":$((w / 2)),\"fromY\":$((h * 30 / 100)),\"toX\":$((w / 2)),\"toY\":$((h * 92 / 100)),\"duration\":0.9}]}" \
    >/dev/null 2>&1 || true
}

# _ys_open_sky <shot>: pull from the Quests tab; the Sky's top bar says
# "Your sky" once it is open.
_ys_open_sky() {
  _ys_pull
  _ys_wait_contains "Your sky" 15 || {
    snap "$1-pull-did-not-open"
    return 1
  }
  sleep 3
  _ys_dismiss_dev_toast
  snap "$1"
}

run_scenario() {
  if _ys_wait_contains "Rabbithole is asleep" 3 2>/dev/null; then
    echo "✗ your-sky: bedtime covers the scholar app; set the school's time zone to a daytime zone" >&2
    snap "bedtime"
    return 1
  fi
  snap "home"
  _ys_tap_visible "Quests" || return 1
  sleep 3
  snap "quests-tab"

  _ys_open_sky "sky-at-rest" || return 1
  if _ys_wait_contains "becomes a star here" 3 2>/dev/null; then
    snap "empty-sky"
    echo "✓ your-sky: the pull from Quests opened an empty sky with its one line"
    return 0
  fi

  # More labels as the kid zooms in.
  _ys_tap_visible "Zoom in" || return 1
  sleep 1
  _ys_tap_visible "Zoom in" || return 1
  sleep 2
  snap "zoomed-more-labels"
  _ys_tap_visible "Zoom out" || return 1
  sleep 1
  _ys_tap_visible "Zoom out" || return 1
  sleep 2

  # A wonder's drawer, then a nearby star moves the sky.
  _ys_tap_visible "$_ys_wonder" || return 1
  _ys_wait_contains "Keep going" 15 || { snap "wonder-no-drawer"; return 1; }
  sleep 2
  snap "wonder-drawer"
  tap_name "sky-near-0" || { snap "wonder-no-nearby"; return 1; }
  sleep 2
  snap "nearby-moved-sky"
  tap_name "Close" || { snap "no-close"; return 1; }
  sleep 1

  # The Quest's drawer, then "Started from" moves the sky to its wonder.
  _ys_tap_visible "Quest: $_ys_quest" || return 1
  _ys_wait_contains "Open it" 15 || { snap "quest-no-drawer"; return 1; }
  sleep 2
  snap "quest-drawer"
  tap_name "sky-started-from" || { snap "quest-no-started-from"; return 1; }
  sleep 2
  snap "started-from-moved-sky"
  tap_name "Close" || { snap "no-close"; return 1; }
  sleep 1

  # Done returns to the Quests tab.
  _ys_tap_visible "Done" || return 1
  sleep 2
  snap "done-back-to-quests"

  # A second pull; "Keep going" reopens the wonder's chat.
  _ys_open_sky "sky-second-open" || return 1
  _ys_tap_visible "$_ys_wonder" || return 1
  _ys_wait_contains "Keep going" 15 || return 1
  _ys_dismiss_dev_toast
  _ys_tap_visible "Keep going" || return 1
  sleep 5
  snap "keep-going-opens-chat"

  # "Open it" opens the Quest the way its Quests-tab row does.
  nav "/sky" || { snap "sky-nav-failed"; return 1; }
  sleep 4
  _ys_tap_visible "Quest: $_ys_quest" || return 1
  _ys_wait_contains "Open it" 15 || return 1
  _ys_dismiss_dev_toast
  _ys_tap_visible "Open it" || return 1
  sleep 6
  snap "open-it-opens-quest"

  echo "✓ your-sky: pull from Quests, labels at rest and zoomed, wonder drawer, nearby move, Quest drawer, Started from move, Done to Quests, Keep going, Open it"
}

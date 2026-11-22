#!/usr/bin/env bash
# Wonders on the BunnyPad (TRA-677): the "I wonder…" box, which lives on
# Scholar's Prep only, with Today's wonders and Earlier under it; the Quests
# tab's Custom Quest button taking the scholar to it; "Things to wonder about"
# at the end of the Quests tab; and the Sky. Run against a private worktree
# deployment whose signed-in fictional scholar (test-scholar-001) has a few
# cross-domain idea seeds and a teacher offer (starters), wonders from an
# earlier day (Earlier), and outside the 8 pm-6 am bedtime window in the
# deployment school's time zone.
#
# The screenshots are the evidence (landscape, the fleet posture): read them
# rather than trusting the pass line. Each step also leaves the accessibility
# names next to its shot (snap).
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

# _ww_wait_contains <substring> [timeout_s]: poll until an element whose name,
# label or value CONTAINS <substring> (case-insensitive) exists.
_ww_wait_contains() {
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
  echo "✗ wonders-walk: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

# _ww_first_visible <predicate>: the first on-screen element matching it. The
# Home pager keeps visited tabs mounted, so a second, hidden box can match too.
_ww_first_visible() {
  ael_find_elements "$BASE" "-ios predicate string" "visible == 1 AND ($1)" 2>/dev/null |
    head -n 1 | grep .
}

# _ww_tap_visible <exact name> [timeout_s]: click the first on-screen element
# with that exact name, waiting for it (a screen still under the one the nav
# bridge put on top can carry its own copy).
_ww_tap_visible() {
  local lit id deadline
  lit="$(_ael_predicate_literal "$1")"
  deadline=$((SECONDS + ${2:-30}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(_ww_first_visible "name == '$lit'")" && {
      ael_click "$BASE" "$id"
      return
    }
    dismiss_dev_menu_if_present
    sleep 0.5
  done
  echo "✗ wonders-walk: no visible '$1'" >&2
  snap "missing-tap-target"
  return 1
}

# _ww_scroll <up|down> [times]: scroll the list under the screen's centre.
_ww_scroll() {
  local direction="$1" times="${2:-1}" i
  for ((i = 0; i < times; i += 1)); do
    curl -fsS --max-time 15 -X POST "$BASE/execute/sync" \
      -H 'Content-Type: application/json' \
      -d "{\"script\":\"mobile: swipe\",\"args\":[{\"direction\":\"$( [ "$direction" = down ] && echo up || echo down )\"}]}" \
      >/dev/null 2>&1 || true
    sleep 1
  done
}

# _ww_ask <words> <shot-prefix>: type into the visible box, tap Ask, and wait
# for the chat it opens to show the words and Rabbithole's first reply.
_ww_ask() {
  local words="$1" prefix="$2" box send
  # An empty RN field carries its placeholder in its name; a typed-in one
  # keeps it in placeholderValue.
  box="$(_ww_first_visible "(type == 'XCUIElementTypeTextView' OR type == 'XCUIElementTypeTextField') AND (name BEGINSWITH 'I wonder' OR placeholderValue BEGINSWITH 'I wonder')")" || {
    echo "✗ wonders-walk: no visible I wonder… box" >&2
    snap "$prefix-no-box"
    return 1
  }
  ael_click "$BASE" "$box" || return 1
  ael_set_value "$BASE" "$box" "$words" || {
    echo "✗ wonders-walk: typing into the box failed" >&2
    snap "$prefix-type-failed"
    return 1
  }
  sleep 1
  snap "$prefix-typed"
  send="$(_ww_first_visible "name == 'Ask' AND type == 'XCUIElementTypeButton'")" ||
    send="$(_ww_first_visible "name == 'Ask'")" || {
      echo "✗ wonders-walk: no Ask button beside the box" >&2
      snap "$prefix-no-ask"
      return 1
    }
  ael_click "$BASE" "$send" || return 1
  # The chat opens on the kid's words as its first turn.
  _ww_wait_contains "$words" 60 || {
    snap "$prefix-chat-missing"
    return 1
  }
  sleep 4
  snap "$prefix-chat-opened"
  # Let Rabbithole answer first; the reply streams in under the question.
  sleep 40
  snap "$prefix-chat-answered"
}


run_scenario() {
  if _ww_wait_contains "Rabbithole is asleep" 3 2>/dev/null; then
    echo "✗ wonders-walk: bedtime covers the scholar app; set the school's time zone to a daytime zone" >&2
    snap "bedtime"
    return 1
  fi
  snap "home"

  # ── Quests tab: no box here any more ────────────────────────────────────
  _ww_tap_visible "Quests" || return 1
  sleep 3
  snap "quests-top-no-box"
  local id
  if _ww_first_visible "(type == 'XCUIElementTypeTextView' OR type == 'XCUIElementTypeTextField') AND name BEGINSWITH 'I wonder'" >/dev/null; then
    echo "✗ wonders-walk: the Quests tab still shows an I wonder… box" >&2
    return 1
  fi

  # The Custom Quest button takes the scholar to Prep and puts the cursor in
  # its box. (Visible only: a quiet Now tab, still mounted off-screen, has its
  # own "Start a Quest", which does the same.)
  id="$(_ww_first_visible "name == 'Start a Quest'")" || { snap "no-start-a-quest"; return 1; }
  ael_click "$BASE" "$id" || return 1
  _ww_wait_contains "Today’s wonders" 30 || { snap "custom-quest-not-on-prep"; return 1; }
  sleep 2
  snap "custom-quest-focuses-prep-box"

  # ── Ask from Prep, the box's one home ───────────────────────────────────
  _ww_ask "Why do cats purr?" "prep-ask" || return 1
  nav "/" || return 1
  sleep 2
  _ww_tap_visible "Scholar’s Prep" || return 1
  _ww_wait_contains "Today’s wonders" 60 || { snap "prep-no-section"; return 1; }
  _ww_wait_contains "Why do cats purr?" 30 || { snap "prep-no-wonder"; return 1; }
  sleep 2
  # Today's wonders under the box, then Earlier: wonders from earlier days.
  snap "prep-today-and-earlier"
  _ww_wait_contains "Earlier" 10 || { snap "prep-no-earlier"; return 1; }

  # "Open" on an Earlier wonder reopens that chat.
  id="$(_ww_first_visible "name CONTAINS 'Open: Do fish get thirsty?'")" || { snap "earlier-no-open"; return 1; }
  ael_click "$BASE" "$id" || return 1
  _ww_wait_contains "Do fish get thirsty?" 30 || return 1
  sleep 4
  snap "earlier-open-reopens-chat"
  nav "/" || return 1
  sleep 2

  # ── The end of the Quests tab: things to wonder about ───────────────────
  _ww_tap_visible "Quests" || return 1
  sleep 2
  _ww_scroll down 8
  _ww_wait_contains "Things to wonder about" 20 || { snap "quests-no-starters"; return 1; }
  sleep 1
  snap "quests-end-starters"

  # ── The Sky (one Sky-open event per arrival) ────────────────────────────
  nav "/sky" || { snap "sky-nav-failed"; return 1; }
  sleep 4
  snap "sky"

  echo "✓ wonders-walk: no box on Quests, Custom Quest to Prep's box, asked from Prep, Today's wonders and Earlier, starters, Sky"
}

#!/usr/bin/env bash
# A shown Quest on the BunnyPad (TRA-684): after a teacher awards the badge
# (quest-show.sh, then the award on the deployment), the Quests tab row's
# rocket is a gold star, its meta line names the badge, and its button is a
# quiet "View". The screenshots are the evidence. Contract: run_scenario only;
# no top-level side effects; no EXIT traps.

run_scenario() {
  snap "home"
  tap_contains "Quests" || return 1
  local deadline=$((SECONDS + 60)) lit count
  lit="$(_ael_predicate_literal "View")"
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(ael_count_elements "$BASE" "-ios predicate string" "name CONTAINS '$lit'" 2>/dev/null || printf '0')"
    [ "${count:-0}" -ge 1 ] && break
    dismiss_dev_menu_if_present
    sleep 1
  done
  sleep 2
  snap "quests-shown-row"
  echo "✓ quest-shown: captured the Quests tab after the badge was awarded"
}

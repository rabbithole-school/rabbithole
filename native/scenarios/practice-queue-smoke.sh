#!/usr/bin/env bash
# One-off verification scenario for the shared item-queue reducer extraction
# (shared/practice/sessionMachine.ts, PR "Extract shared practice item-queue
# state machine (slice 1/N)"). Navigates to the default scholar's practice
# queue, captures the first item, attempts a generic answer submission via
# whichever control the item type exposes, and captures the result — proving
# the reducer-backed queue renders and advances on native, not just typechecks.
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

run_scenario() {
  snap "00-home"

  nav "/practice" || return 1
  snap "01-practice-loaded"

  # This item type (a free-text math check-in) requires text in the answer
  # field before "Check" enables — a bare tap never advances it. Type into the
  # field if present (best-effort: other item types on other seeds may not
  # expose "Answer field" at all, e.g. multiple-choice or manipulatives).
  # Compute the correct sum from the rendered "A + B = ?" tokens (read via the
  # /source XML, left-to-right by x-position) so the answer is actually right
  # and the item genuinely advances — a hardcoded guess would only exercise
  # the miss path, not the queue's item-1-to-item-2 transition.
  local answer_field equation a b
  answer_field="$(ael_require_exactly_one "$BASE" "accessibility id" "Answer field" 2>/dev/null)"
  if [ -n "$answer_field" ]; then
    equation="$(curl -fsS --max-time 10 "$BASE/source" 2>/dev/null \
      | node -e '
        let input = "";
        process.stdin.on("data", (c) => (input += c)).on("end", () => {
          const xml = JSON.parse(input).value || "";
          const re = /<XCUIElementType\w+[^>]*\bname="([^"]*)"[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/g;
          const toks = [];
          let m;
          while ((m = re.exec(xml))) {
            const name = m[1].trim();
            if (/^\d+$/.test(name) || name === "+" || name === "=" || name === "?") {
              toks.push({ name, x: Number(m[2]) });
            }
          }
          const seen = new Set();
          const uniq = toks.filter((t) => {
            const k = `${t.name}@${t.x}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          uniq.sort((a, b) => a.x - b.x);
          process.stdout.write(uniq.map((t) => t.name).join(" "));
        });
      '
    )"
    read -r a _plus b _eq _q <<< "$equation"
    if [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]]; then
      ael_click "$BASE" "$answer_field"
      ael_send_keys "$BASE" "$((a + b))"
      # A confidence chip must be selected before "Check" enables on this item.
      for label in "How sure are you: Sure" "How sure are you: I think so" "How sure are you: Not sure"; do
        tap_name "$label" 2>/dev/null && break
      done
    else
      # Not every check-in renders its question as accessible text tokens —
      # e.g. a "what number comes right after N?" counting item exposes no
      # parseable equation at all (only its Answer field/chips are labeled).
      # Rather than leave the field empty and let every subsequent tap no-op
      # against a permanently-disabled Check button, take the one control
      # that's always available regardless of question type and genuinely
      # completes + advances the item: "I haven't learned this yet".
      tap_name "I haven't learned this yet" 2>/dev/null
    fi
  fi
  snap "02-answer-entered"

  # Best-effort generic submit: try every known "advance the item" control in
  # priority order. Each tap is best-effort (a scenario must not die because a
  # given item type doesn't expose a particular control).
  for label in "Check answer" "Check" "Check manipulative" "Next"; do
    tap_name "$label" 2>/dev/null && break
  done
  sleep 1
  snap "03-after-first-tap"

  # Some item types require a second confirm after feedback (e.g. a "Next"
  # that only appears once a verdict has been shown).
  for label in "Next" "Check answer" "Check"; do
    tap_name "$label" 2>/dev/null && break
  done
  sleep 1
  snap "04-after-second-tap"

  echo "✓ practice-queue-smoke: captured practice screen before/after interaction"
}

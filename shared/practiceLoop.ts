// The framework-free core of the homegrown practice loop — the ONE model of the
// attempt/advance state machine, answer normalization, timing capture, streak
// cadence, and session-summary math that BOTH surfaces run identically:
//
//   • web  — components/practice/PracticeSession.tsx (imports @/shared/practiceLoop)
//   • native — native/src/app/practice.tsx (imports the vendored copy under
//              native/vendor/shared/practiceLoop.ts; kept in sync by
//              native/scripts/sync-vendor.js, mirroring shared/skyTiers.ts)
//
// Rendering, keypad layout, haptics calls, navigation, the offline queue, the
// placement gate, and the Socratic "talk it through" handoff stay in the surface
// files — they call into this core. Anything that legitimately DIFFERS between
// web and native (e.g. the keypad grid: native adds a decimal `.` key the web
// pad omits) is deliberately NOT modeled here. This module imports nothing so it
// resolves standalone under Metro when vendored.

/** The numeric-ish answer types that render a tappable keypad (not MC / manipulative). */
export type PadAnswerType = "integer" | "decimal" | "fraction" | "expression";

/** The full served-item answer-type union — mirrors the server's `ServedItem`
 *  (convex/lib/practice/session.ts), widened for stored manipulative items. */
export type PracticeAnswerType = PadAnswerType | "multipleChoice" | "manipulative";

/** How many items a practice session serves (both surfaces request this size).
 *  Shortened core (raise-the-ceiling plan §C-3): a 6-item mandatory core keeps
 *  the daily ask small, with optional bonus sets (challenge / more-of-your-pick
 *  / tune-up) offered on the done screen for anyone who wants more. The server
 *  derives its own queue limits from this same constant (see
 *  `convex/practiceSkills.ts`'s `computeDomainQueue`/`practiceSession`) so the
 *  scheduler's mix floor (`ceil(limit / 4)`) is computed against the SERVED
 *  size, not a stale larger candidate pool. */
export const PRACTICE_SESSION_SIZE = 6;

/** Misses on one item before the loop moves from "try again" to the "stuck"
 *  branch (web → talk-it-through + fresh variant; native → fresh variant). */
export const MISSES_BEFORE_STUCK = 2;

// ── The three-miss breaker ──────────────────────────────────────────────────
//
// After three counted misses in a row the loop stops serving the playlist and
// runs ONE bounded repair sequence on the skill that broke (the trigger node):
//
//   pushed step-card rung  →  bounded coach, only if that wasn't enough
//                          →  ONE fresh, cold item on the SAME node (automatic)
//
// It replaced a binary "Crack one together / Easy one, then stop" ask, which
// every observed scholar answered by leaving (review/resilience-recovery-plan.html):
// an open-ended invitation to talk asks for more commitment than a kid who has
// just missed three in a row has left. A concrete half-step asks for less, keeps
// the work with the learner, and uses the help primitive practice already ships
// (shared/hintLadder.ts) rather than inventing a second support vocabulary.
//
// The escape is never removed: a quiet "Easy one, then stop" stays visible
// through repair, coach, and the fresh item, while a missed fresh item ends the
// run warmly instead of looping. Nothing here is a reward — the ONLY recognition
// a recovery earns is one closure headline (shared/closureLines.ts).

/** The repair card's lead line: names the streak without blame, then names the
 *  size of the ask — one small missing piece, not a lecture. */
export const SPIRAL_REPAIR_BODY =
  "Those were some tricky ones. Let’s find the smallest missing piece.";
/** Same moment, but the item carries no worked step to open (a manipulative, a
 *  one-step drill). The coach becomes the offer instead of a dead end. */
export const SPIRAL_REPAIR_NO_STEP_BODY =
  "Those were some tricky ones. Let’s take one apart together.";
/** After the repair step (or the coach): one fresh item on the same skill arrives
 *  automatically. Never framed as a test — it is the payoff of the help. */
export const SPIRAL_FRESH_BODY = "Here’s a fresh one on this.";
export const SPIRAL_COACH_BODY = "Want to keep working this one through with the tutor?";
export const SPIRAL_COACH_COMPLETE_BODY = "You worked through that one together.";
/** The buttons, shared byte-for-byte by both surfaces (web PracticeSession,
 *  native practice) so the visible label and its accessibilityLabel can never
 *  drift. Sentence case; no duration promise; no scores, streaks or points. */
export const SPIRAL_COACH_LABEL = "Still stuck? Crack it with the tutor";
/** The peer escape, visible in every support state. Kept genuinely dignified —
 *  it is a real, equal choice, never the naughty one. */
export const SPIRAL_OFFER_SECONDARY = "Easy one, then stop";
export const HANDOFF_OPENER =
  "Okay — let's figure this out together. What did you try, or where did you get stuck?";
/** The coach's opener when the breaker escalated to it. Unlike the old binary
 *  offer there is nothing left to pick — the repair rung already put one
 *  specific problem on the table, so the tutor opens on THAT one. */
export const SPIRAL_HANDOFF_OPENER =
  "Rough stretch, huh? Let's take this one apart together — what did you try?";
export const SPIRAL_RECOVERY_WON_CLOSE =
  "There it is 💪 Good place to stop for today — you worked hard on the tricky ones.";
export const SPIRAL_WARM_CLOSE =
  "All good — you put in real work today. That's the part that counts.";

/** How far the trigger item's pushed repair rung has got. `unavailable` means
 *  the item had no openable worked step (or serving one failed) — the coach
 *  becomes the offer, never a dead end. */
export type BreakerRepairStatus = "opening" | "open" | "done" | "unavailable";

/** Where the breaker sequence is. `fresh` / `easy` are ITEM stages — the normal
 *  answer surface is on screen and owns its own CTA; the others are the one
 *  bounded card. */
export type BreakerStage = "repair" | "coach" | "fresh" | "easy" | "close";

/** The easier "one more and call it a day" item, when it was taken at all. */
export type BreakerEasyOutcome = "requested" | "unavailable" | "correct" | "missed";

export interface BreakerFlow {
  stage: BreakerStage;
  repair: BreakerRepairStatus;
  /** The bounded Socratic coach was opened at some point in this episode. */
  coachUsed: boolean;
  /** The one fresh, cold, SAME-NODE item served after support. `verified` is the
   *  authoritative verdict returned by submitAnswer after it persists the linked
   *  freshResult on the trigger attempt; client state alone cannot earn recognition. */
  fresh?: { correct: boolean; assisted: boolean; verified: boolean };
  easy?: BreakerEasyOutcome;
}

export function newBreakerFlow(
  repair: BreakerRepairStatus = "opening",
): BreakerFlow {
  return { stage: "repair", repair, coachUsed: false };
}

export type BreakerEvent =
  | { type: "repairOpened" }
  | { type: "repairUnavailable" }
  | { type: "repairDone" }
  | { type: "coachOpened" }
  | { type: "freshServed" }
  | { type: "freshGraded"; correct: boolean; assisted: boolean; verified: boolean }
  | { type: "easyRequested" }
  | { type: "easyUnavailable" }
  | { type: "easyGraded"; correct: boolean }
  | { type: "closed" };

/**
 * The ONE breaker state machine both surfaces run. Pure, so the sequence (and
 * every escape out of it) is identical on web and native and testable without a
 * renderer. Transitions that can't happen are ignored rather than throwing — a
 * double tap or a late async resolution must never strand a struggling kid.
 */
export function advanceBreakerFlow(flow: BreakerFlow, event: BreakerEvent): BreakerFlow {
  switch (event.type) {
    case "repairOpened":
      return flow.repair === "opening" ? { ...flow, repair: "open" } : flow;
    case "repairUnavailable":
      return flow.repair === "opening" ? { ...flow, repair: "unavailable" } : flow;
    case "repairDone":
      return flow.repair === "open" ? { ...flow, repair: "done" } : flow;
    case "coachOpened":
      return flow.stage === "repair"
        ? { ...flow, stage: "coach", coachUsed: true }
        : flow;
    case "freshServed":
      return flow.stage === "repair" || flow.stage === "coach"
        ? { ...flow, stage: "fresh" }
        : flow;
    case "freshGraded":
      return flow.stage === "fresh" && !flow.fresh
        ? {
            ...flow,
            fresh: {
              correct: event.correct,
              assisted: event.assisted,
              verified: event.verified,
            },
          }
        : flow;
    case "easyRequested":
      return flow.stage === "easy" || flow.easy
        ? flow
        : { ...flow, stage: "easy", easy: "requested" };
    case "easyUnavailable":
      return flow.easy === "requested"
        ? { ...flow, stage: "close", easy: "unavailable" }
        : flow;
    case "easyGraded":
      return flow.easy === "requested"
        ? { ...flow, easy: event.correct ? "correct" : "missed" }
        : flow;
    case "closed":
      return { ...flow, stage: "close" };
    default:
      return flow;
  }
}

export type BreakerEasyFinishResponse<T> = {
  available: boolean;
  items: readonly T[];
};

export type BreakerEasyFinishResolution<T> =
  | { item: T; events: readonly [{ type: "easyRequested" }] }
  | {
      item: null;
      events: readonly [{ type: "easyRequested" }, { type: "easyUnavailable" }];
    };

/**
 * Keep the easy-finish transition behind the authoritative server response.
 * Rejections propagate without events, so both clients retain the pre-request
 * breaker state and can retry a transient failure.
 */
export async function requestBreakerEasyFinish<T>(
  request: () => Promise<BreakerEasyFinishResponse<T>>,
): Promise<BreakerEasyFinishResolution<T>> {
  const response = await request();
  if (!response.available) {
    return {
      item: null,
      events: [{ type: "easyRequested" }, { type: "easyUnavailable" }],
    };
  }
  const item = response.items[0];
  if (!item) throw new Error("Easy finish response omitted its item");
  return { item, events: [{ type: "easyRequested" }] };
}

export type BreakerControl = "checkStep" | "coach" | "easyFinish";

export interface BreakerControls {
  /** The recommended next move, or null while a card is still loading (or when
   *  the answer surface below owns the CTA). */
  primary: BreakerControl | null;
  /** Alternatives in render order. The escape keeps a full-size tap target but
   *  deliberately uses the clients' quieter ghost treatment. */
  peers: BreakerControl[];
}

/**
 * Which controls the breaker card offers right now. The single escape ("Easy
 * one, then stop") is present in every support state by construction; serving
 * the fresh item is an automatic transition rather than another choice.
 */
export function breakerControls(
  flow: BreakerFlow,
  freshAvailable = true,
): BreakerControls {
  if (flow.stage === "repair") {
    if (flow.repair === "opening") return { primary: null, peers: ["easyFinish"] };
    if (flow.repair === "unavailable") return { primary: "coach", peers: ["easyFinish"] };
    if (flow.repair === "open") {
      return { primary: "checkStep", peers: ["coach", "easyFinish"] };
    }
    if (!freshAvailable) {
      return flow.coachUsed
        ? { primary: "easyFinish", peers: [] }
        : { primary: "coach", peers: ["easyFinish"] };
    }
    return { primary: null, peers: ["easyFinish"] };
  }
  if (flow.stage === "coach") {
    return freshAvailable
      ? { primary: null, peers: ["easyFinish"] }
      : { primary: "easyFinish", peers: [] };
  }
  if (flow.stage === "close" && flow.fresh && !flow.fresh.correct && !flow.easy) {
    // A missed fresh item must never loop into another hard one.
    return { primary: "easyFinish", peers: [] };
  }
  return { primary: null, peers: [] };
}

export function breakerControlLabel(control: BreakerControl): string {
  switch (control) {
    case "checkStep":
      return "Check this step";
    case "coach":
      return SPIRAL_COACH_LABEL;
    default:
      return SPIRAL_OFFER_SECONDARY;
  }
}

/** The card's body copy for the current state (null once an item owns the screen). */
export function breakerBody(flow: BreakerFlow, freshAvailable = true): string | null {
  if (flow.stage === "repair") {
    if (flow.repair === "unavailable") return SPIRAL_REPAIR_NO_STEP_BODY;
    if (flow.repair === "done") {
      return freshAvailable ? SPIRAL_FRESH_BODY : SPIRAL_COACH_BODY;
    }
    return SPIRAL_REPAIR_BODY;
  }
  if (flow.stage === "coach") {
    return freshAvailable ? SPIRAL_FRESH_BODY : SPIRAL_COACH_COMPLETE_BODY;
  }
  return null;
}

/**
 * The ONE recognition test: support happened, and then a FRESH, COLD item on the
 * SAME node was solved with no help on that item. Three misses plus an unrelated
 * easy win is not this; a hint-assisted correct is not this; taking the easy
 * finish or stopping is not this (and costs nothing).
 */
export function breakerRecovered(flow: BreakerFlow): boolean {
  return (
    flow.fresh?.correct === true &&
    flow.fresh.assisted === false &&
    flow.fresh.verified === true
  );
}

/**
 * Whether the server will issue a fresh same-node item yet. `breakerRecoverySession`
 * refuses until the lifecycle records support (`repair_completed` OR
 * `coach_escalated`) and refuses again once the episode is terminal, so the
 * client asks only from the two states that can have produced those events.
 */
export function breakerSupportRecorded(flow: BreakerFlow): boolean {
  if (flow.easy || flow.fresh) return false;
  if (flow.stage === "coach") return true;
  return flow.stage === "repair" && flow.repair === "done";
}

/**
 * Whether a RESUMED episode's fresh item should be (re)constructed via the
 * idempotent `breakerRecoverySession`. True in two cases: support was just
 * recorded and the item has never been served (the same condition as
 * `breakerSupportRecorded`), OR the stage has already advanced to "fresh" in a
 * PRIOR resume (the item is already pinned server-side) but this mount lost its
 * local item reference again — `breakerSupportRecorded` alone returns false
 * once stage is already "fresh", which would otherwise strand a SECOND reload
 * on an empty card. Never true once the fresh item has actually been graded
 * (`flow.fresh` set): reconstructing then would be a regrade, not a resume.
 */
export function breakerFreshReconstructable(flow: BreakerFlow): boolean {
  if (flow.fresh) return false;
  return flow.stage === "fresh" || breakerSupportRecorded(flow);
}

/** No prepared repair rung means the bounded coach is the support, not another
 * decision screen. Both clients use this to skip the obsolete coach CTA. */
export function breakerShouldAutoOpenCoach(flow: BreakerFlow): boolean {
  return (
    flow.stage === "repair" &&
    flow.repair === "unavailable" &&
    !flow.coachUsed &&
    !flow.easy &&
    !flow.fresh
  );
}

/**
 * The ONE extra argument the fresh same-node item's `submitAnswer` must carry,
 * shaped for spreading. The server re-validates it and THROWS on a mismatch
 * (`Breaker recovery context is invalid`), so sending it on the wrong item —
 * a playlist item, the easy finish, a retry of the fresh item — would turn a
 * struggling scholar's next tap into an error. Hence one shared predicate:
 * the current item IS the served fresh item, on its recorded first attempt,
 * while the flow is actually in the fresh stage.
 */
export function breakerFreshSubmitArgs<T extends string>(args: {
  flow: BreakerFlow | null | undefined;
  /** The item id `breakerRecoverySession` served. */
  freshItemId: string | null | undefined;
  /** The item being submitted right now. */
  itemId: string;
  /** The threshold-crossing attempt id from `submitAnswer.breakerRecovery`. */
  triggerAttemptId: T | null | undefined;
  /** False on a retry — a retry is not the recovery evidence. */
  firstAttempt: boolean;
}): { breakerTriggerAttemptId: T } | Record<string, never> {
  if (!args.flow || args.flow.stage !== "fresh" || args.flow.fresh) return {};
  if (!args.firstAttempt || !args.triggerAttemptId) return {};
  if (!args.freshItemId || args.freshItemId !== args.itemId) return {};
  return { breakerTriggerAttemptId: args.triggerAttemptId };
}

/** Bind the easier finish's first graded attempt to its breaker episode. */
export function breakerEasySubmitArgs<T extends string>(args: {
  flow: BreakerFlow | null | undefined;
  triggerAttemptId: T | null | undefined;
  firstAttempt: boolean;
}): { breakerEasyTriggerAttemptId: T } | Record<string, never> {
  if (!args.flow || args.flow.stage !== "easy") return {};
  if (args.flow.easy !== "requested" || !args.firstAttempt) return {};
  if (!args.triggerAttemptId) return {};
  return { breakerEasyTriggerAttemptId: args.triggerAttemptId };
}

/** The closing line for a breaker episode. A verified recovery is spoken by the
 *  canonical closure headline instead (shared/closureLines.ts), so this covers
 *  only the honest, warm ends. */
export function breakerCloseLine(flow: BreakerFlow): string {
  return flow.easy === "correct" ? SPIRAL_RECOVERY_WON_CLOSE : SPIRAL_WARM_CLOSE;
}

/** Legacy `recordBreakerOutcome.offer`, kept truthful under the new mechanism:
 *  did the scholar engage the pushed support at all? (The versioned lifecycle
 *  carries the real path — see `recordBreakerRecoveryLifecycle`.) */
export function breakerLegacyOffer(flow: BreakerFlow): "accepted" | "declined" {
  return flow.repair === "done" || flow.coachUsed || flow.fresh !== undefined
    ? "accepted"
    : "declined";
}

/** Legacy `recordBreakerOutcome.recovery`, which has always meant "how the final
 *  EASIER item went" — so the fresh same-node result deliberately does not leak
 *  into it and change what existing staff copy claims. */
export function breakerLegacyRecovery(
  flow: BreakerFlow,
): "won" | "missed" | "none" | "skipped" {
  if (flow.easy === "correct") return "won";
  if (flow.easy === "missed") return "missed";
  if (flow.easy === "unavailable") return "skipped";
  return "none";
}

/** A stronger success cue every Nth correct in a row — a felt streak, not a
 *  buzz-per-item. */
export const STREAK_PULSE_EVERY = 3;

/** Delay (ms) before the second success pulse on a streak milestone. */
export const STREAK_PULSE_DELAY_MS = 140;

export function isPadAnswerType(t: string): t is PadAnswerType {
  return t === "integer" || t === "decimal" || t === "fraction" || t === "expression";
}

/** Expression answers (whole-number division) can carry a remainder → an `R` key. */
export function padShowRemainder(t: PadAnswerType): boolean {
  return t === "expression";
}

/** Numeric-valued pad types (integer/decimal/fraction) can lead with a sign
 *  toggle; expression (the "7 R 2" remainder form) never needs one. */
export function padShowSign(t: PadAnswerType): boolean {
  return t !== "expression";
}

/** Decimal items get a wide `/ (fraction)` accessory key (fraction/expression
 *  pads already carry `/` in the grid). The grader compares numeric answers by
 *  VALUE (105/16 ≡ 6.5625 in `answersEqual`), but before this key the decimal
 *  pad offered no way to ENTER a fraction — a scholar who worked a problem in
 *  fourths had to convert to decimal notation just to type the answer (pretest
 *  audit, 2026-07-13). Representation must never gate a correct answer. */
export function padShowFraction(t: PadAnswerType): boolean {
  return t === "decimal";
}

/** Which flat pad types accept a fraction slash `/` at all — the same set the
 *  hardware-keyboard allowlist (`sanitizePadInput`) lets through and native's
 *  grid carries. Integer answers never take a slash. Web reads this to decide
 *  whether to offer an on-screen `/` key (its flat surface has no number grid,
 *  so a touch/embedded scholar otherwise has no way to enter a fraction —
 *  parity with the native pad's `/` key). */
export function padAcceptsFraction(t: PadAnswerType): boolean {
  return t === "decimal" || t === "fraction" || t === "expression";
}

/**
 * Apply one keypad press to the current input string. Backspace trims one char,
 * `R` inserts a spaced remainder token (so the submitted string matches the
 * expression `"7 R 2"` form the server's `parseAnswer` grades), `±` (the pad's
 * dedicated sign key) or a hardware-typed `-` TOGGLES a leading minus sign —
 * never inserts one mid-number, and pressing it again removes it — any other
 * key appends. The returned value is fed straight to `submitAnswer`.
 */
export function applyKey(prev: string, key: string): string {
  if (key === "⌫") return prev.slice(0, -1);
  if (key === "R") return `${prev} R `;
  if (key === "±" || key === "-") {
    return prev.startsWith("-") ? prev.slice(1) : `-${prev}`;
  }
  return prev + key;
}

/** A synchronously updated input snapshot for controls whose rendered state may
 * commit after a rapid final-key + submit sequence. */
export type InputBuffer = { current: string };

export function setInputBuffer(buffer: InputBuffer, value: string): string {
  buffer.current = value;
  return value;
}

export function applyKeyToInputBuffer(buffer: InputBuffer, key: string): string {
  return setInputBuffer(buffer, applyKey(buffer.current, key));
}

/**
 * Filter raw text (e.g. from a HARDWARE keyboard on the native pad surface) down
 * to only the characters a given pad answer type can legitimately contain, so a
 * physical keyboard enters the same values the on-screen pad produces. Mirrors
 * the on-screen pad's key set — digits everywhere; `.` for decimal only; `/` for
 * decimal/fraction/expression; the remainder token (`R` + spaces) for expression — plus
 * a LEADING `-` sign for negatives (web's practice keydown handler also accepts
 * `-`), never mid-number, matching the on-screen `±` key's leading-only rule.
 * A lowercase `r` is normalized to `R` so a HW-typed "7 r 2" grades like the
 * pad's "7 R 2". The native pad is otherwise touch-only (no soft keyboard), so
 * this only runs for physically-typed characters.
 *
 * `opts.allowUnit` is the UNIT-BEARING item's carve-out: when the item asks for
 * an answer "in cubic centimeters" the unit IS part of the answer, so the
 * numeric filter would otherwise make it literally untypeable (it drops every
 * letter). It widens the numeric charset with letters, spaces, and the exponent
 * glyphs a unit can carry (`^`, `²`, `³`) — nothing else. Omit `opts` and the
 * behavior is byte-identical to before, so every existing caller is unchanged.
 */
export function sanitizePadInput(
  answerType: PadAnswerType,
  raw: string,
  opts?: { allowUnit?: boolean },
): string {
  const allowUnit = opts?.allowUnit === true;
  let out = "";
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "-" && out === "") out += ch;
    else if (ch === "." && answerType === "decimal") out += ch;
    else if (ch === "/" && padAcceptsFraction(answerType)) out += ch;
    else if (answerType === "expression" && (ch === "R" || ch === "r")) out += "R";
    else if (answerType === "expression" && /[A-Za-z()+*^.\s]/.test(ch)) out += ch;
    // The unit tail: letters + spaces + exponent glyphs + the degree sign.
    // Applied AFTER the numeric charset above, so digits/sign/separators keep
    // their exact per-type rules and only the unit vocabulary is added on top.
    else if (allowUnit && /[a-zA-Z ^²³°]/.test(ch)) out += ch;
  }
  return out;
}

/**
 * The on-screen pad's unit keys for a unit-bearing item, derived from the
 * served display unit ("cm³" → ["cm", "cm²", "cm³"]). The pad deliberately
 * offers the whole DIMENSION FAMILY of the base unit, not just the expected
 * one: picking length vs. area vs. volume is part of the answer (a single
 * pre-filled key would type the unit for the scholar and grade nothing).
 * Kept here (not answers.ts) because this module must import nothing.
 */
export function unitKeyFamily(displayUnit: string): string[] {
  // Degrees is dimensionless — there is no ² / ³ member to choose between, so
  // the family is the single ° key (the cm/m branch below would wrongly offer
  // "°²" / "°³"). Kept as a literal here because this module imports nothing.
  if (displayUnit.trim() === "°") return ["°"];
  const base = displayUnit.replace(/[²³]/g, "").trim();
  if (!base) return [];
  return [base, `${base}²`, `${base}³`];
}

/**
 * A trailing unit token as it can exist mid-typing: letters, then EITHER a
 * hardware-typed caret exponent (`^`, with or without its digit yet — `cm^`
 * is a valid in-progress state) OR an already-superscripted digit (`²`/`³`) —
 * or a lone degree sign (`°`). Mirrors answers.ts's `GENERIC_UNIT_SUFFIX`,
 * which this module can't import (it must import nothing so it vendors as a
 * flat copy) — kept in sync by the shared round-trip test in practiceLoop.test.ts.
 */
const TRAILING_UNIT_RE = /\s*(?:[a-zA-Z]+\s*(?:\^\s*[0-9]*|[²³])?|°)\s*$/;

/**
 * Apply a tapped unit key to the current input: replace any trailing unit
 * token (letters/spaces/exponents in EITHER the caret or superscript form, OR a
 * degree sign) with the tapped one, so switching cm² → cm³ — or cm^2 → cm³ — is
 * one tap, never a backspace dance, and re-tapping ° is idempotent. A bare unit
 * with no number yet is allowed through — the empty-input submit guard already
 * covers it. Degrees binds to the number with no space ("65°"); every other
 * unit keeps the "112 cm³" spacing.
 */
export function applyUnitKey(prev: string, unitDisplay: string): string {
  const numeric = prev.replace(TRAILING_UNIT_RE, "").trim();
  if (numeric === "") return unitDisplay;
  return unitDisplay === "°" ? `${numeric}${unitDisplay}` : `${numeric} ${unitDisplay}`;
}

/**
 * The two lines a unit-bearing item can say about its unit, here in the
 * cross-surface core so the drill, mapping band, placement, and in-chat item
 * say the SAME words on web and native. Deliberately only two — the
 * affordance is the pad's unit keys, not a paragraph. Missing is a NUDGE,
 * not a verdict: it fires client-side BEFORE a submit spends an attempt (and
 * again, defence in depth, on a server `unitOutcome: "missing"`). Wrong only
 * ever comes from the server — it's a grading claim.
 */
export const UNIT_MISSING_NUDGE = "Include the unit in your answer.";
export const UNIT_WRONG_NUDGE = "So close — check your unit.";

/** The nudge for a graded `unitOutcome`, or null when the unit wasn't the problem. */
export function unitOutcomeNudge(outcome: "missing" | "wrong" | undefined): string | null {
  if (outcome === "wrong") return UNIT_WRONG_NUDGE;
  if (outcome === "missing") return UNIT_MISSING_NUDGE;
  return null;
}

/** The answer string submitted for a tapped multiple-choice option (its index). */
export function choiceSubmitValue(index: number): string {
  return String(index);
}

/**
 * A multiple-choice item that carries tappable option labels (`choices`) — the
 * only MC shape a scholar answers by tapping (a bare `multipleChoice` with no
 * choices payload coerces to the number pad). Shared so web and native gate the
 * MC rendering — AND the honest "I haven't learned this yet" escape — identically:
 * an MC item must never force a guess any more than a numeric one does (pilot9
 * J5 founder ruling). Scholar parity is a standing rule, so this predicate lives
 * in the cross-surface core rather than being re-derived per surface.
 */
export function isMultipleChoiceItem(
  answerType: string,
  choiceCount: number | undefined,
): boolean {
  return answerType === "multipleChoice" && (choiceCount ?? 0) > 0;
}

/**
 * The FIRST attempt on an item records to mastery; retries after a miss are
 * graded but not recorded (`record:false`), so the scheduler isn't double-
 * penalized. This is the single rule for what `record` to send with a submit.
 */
export function isFirstAttempt(hasRecorded: boolean): boolean {
  return !hasRecorded;
}

/**
 * A `· mapping` item grades through the PLACEMENT path (inferred credit,
 * never demonstrated fluency), but scholar-facing feedback depends on WHERE
 * it appears. `allMapping` is true only for the day-1/cold-start "Math
 * Check-In" sit — the ONLY surface this repo still calls the pretest — where
 * every served item is a mapping probe and per-item feedback stays silent
 * (record it, advance, no verdict/reveal/haptic). When mapping items are
 * folded into an otherwise-normal playlist for an already-placed scholar
 * (`allMapping === false`), the scholar gets the same reveal-only feedback an
 * ordinary drill item gets (verdict + answer reveal on a miss, no retry — the
 * grade is already recorded). This is the single axis both frontends must
 * agree on; see `convex/__tests__/mappingPlaylist.test.ts` and
 * `convex/lib/practice/__tests__/mapping.test.ts` for the server-side
 * `allMapping` contract this reads.
 */
export function showsMappingFeedback(allMapping: boolean): boolean {
  return !allMapping;
}

export type TimingInput = {
  /** Only the first attempt seeds the latency baseline (see below). */
  firstAttempt: boolean;
  /** `Date.now()` at submit. */
  nowMs: number;
  /** `Date.now()` when the current item rendered. */
  renderAtMs: number;
  /** `Date.now()` of the first keystroke on this item, or null if none observed. */
  firstKeyAtMs: number | null;
};

/** Optional timing reading sent to `submitAnswer`; keys are omitted when not
 *  measurable, so a caller can spread it straight into the mutation args. */
export type TimingReading = { firstKeyMs?: number; elapsedMs?: number };

/**
 * Silent timing instrument (raise-the-ceiling §5). Meaningful ONLY on the first
 * attempt — a retry's clocks are stale from the earlier attempt on the same item.
 * `elapsedMs` covers every measured submit, including tap/drag manipulatives and
 * Don't-Know; `firstKeyMs` is omitted whenever no keystroke was observed.
 */
export function computeTiming({
  firstAttempt,
  nowMs,
  renderAtMs,
  firstKeyAtMs,
}: TimingInput): TimingReading {
  const reading: TimingReading = {};
  if (firstAttempt) {
    reading.elapsedMs = nowMs - renderAtMs;
    if (firstKeyAtMs !== null) reading.firstKeyMs = firstKeyAtMs - renderAtMs;
  }
  return reading;
}

/** The next client-side streak value: bump on correct, reset to 0 on a miss. */
export function nextStreak(streak: number, correct: boolean): number {
  return correct ? streak + 1 : 0;
}

/** Whether this streak value hits a milestone worth a stronger success cue. */
export function shouldPulseStreak(streak: number): boolean {
  return streak > 0 && streak % STREAK_PULSE_EVERY === 0;
}

/** Whether the item at `idx` is the last in a session of `total` items. */
export function isLastItem(idx: number, total: number): boolean {
  return idx + 1 >= total;
}

export type AdvanceOutcome = { done: true } | { done: false; nextIdx: number };

/** The advance step: finish the session on the last item, else move to the next. */
export function advanceStep(idx: number, total: number): AdvanceOutcome {
  return isLastItem(idx, total) ? { done: true } : { done: false, nextIdx: idx + 1 };
}

/**
 * Progress fraction for the top bar: the current index, plus one once the item
 * has been answered (feedback showing), over the session length.
 */
export function progressFraction(idx: number, total: number, feedbackShown: boolean): number {
  return (idx + (feedbackShown ? 1 : 0)) / total;
}

/** The all-mapping pretest may converge early, but never asks more than this in
 * one sitting. Keeping the cap in the shared loop gives web and native one
 * stable progress promise from the first question onward. */
export const MAPPING_PRETEST_MAX_QUESTIONS = 18;

/** Progress for the adaptive all-mapping pretest. It advances only after the
 * silent submit completes, and says "up to" because the search may converge
 * before the cap. */
export function mappingPretestProgress(idx: number): {
  label: string;
  fraction: number;
  questionNumber: number;
  maxQuestions: number;
} {
  const maxQuestions = MAPPING_PRETEST_MAX_QUESTIONS;
  const safeIdx = Math.max(0, Math.min(Math.floor(idx), maxQuestions - 1));
  return {
    label: `${safeIdx + 1} of up to ${maxQuestions}`,
    fraction: safeIdx / maxQuestions,
    questionNumber: safeIdx + 1,
    maxQuestions,
  };
}

/**
 * Placement is adaptive, so it cannot promise a fixed question count. These
 * bounds let both scholar surfaces show honest "up to" progress instead.
 */
export const PLACEMENT_MAX_PROBES_PER_STRAND = 5;
export const PLACEMENT_GLOBAL_CAP = 25;

/**
 * The humane cap for one all-mapping daily playlist sitting. Item 18 is a real
 * completion boundary: the server finalizes the active domain at its confirmed
 * per-strand floors, so a reload starts normal practice instead of another
 * "Math Check-In". Shared by server, web, and native.
 */
export const MAPPING_SIT_CAP = 18;

/**
 * A governed per-SITTING probe budget for the MIXED "Math Check-In" (the
 * multi-domain first placement). A "sitting" is ONE local institution day; the
 * budget counts probes ANSWERED that day across ALL domains (not lifetime, not
 * per-domain). Once it's reached mid-check-in, the check-in parks gracefully: the
 * scholar sees a warm pause screen ("Great mapping today — we'll pick up the rest
 * tomorrow") and heads into practice on whatever placed so far; every in-progress
 * domain keeps its resumable state and the unplaced domains simply reappear as a
 * check-in entry the next sitting.
 *
 * Why: with seven registered domains a single blind sitting was observed running
 * ~90+ probes end-to-end — far past a young scholar's stamina for a "map, not a
 * test". ~30 answered probes is roughly half a full sweep: enough to place the
 * foundational territories (which are probed first — see CHECK_IN_DOMAIN_PRIORITY)
 * and get real practice started, without a marathon. No countdown, no progress-
 * guilt — the ceiling copy just reads "up to 30 today".
 *
 * The pause is a SERVER-COMPUTED signal the scholar surfaces honor; automated
 * drivers (sims / tests) that answer instantly aren't a real sitting and complete
 * the full map, so the diagnostic itself is never truncated.
 */
export const CHECK_IN_SITTING_PROBE_BUDGET = 30;

/**
 * Maximum questions an adaptive placement can ask. Pass a strand count when
 * only topology is known, or per-strand probeable-node counts for a tighter cap.
 */
export function placementQuestionCap(strands: number | readonly number[]): number {
  const uncapped =
    typeof strands === "number"
      ? Math.max(0, Math.floor(strands)) * PLACEMENT_MAX_PROBES_PER_STRAND
      : strands.reduce(
          (total, probeable) =>
            total +
            Math.min(
              PLACEMENT_MAX_PROBES_PER_STRAND,
              Math.max(0, Math.floor(probeable)),
            ),
          0,
        );
  return Math.max(
    1,
    Math.min(PLACEMENT_GLOBAL_CAP, uncapped),
  );
}

/** Display model for the placement progress meter shared by web and native.
 *  `perSitting` (the mixed check-in's per-day budget) appends " today" to the
 *  ceiling copy — "Question N of up to 30 today" — so the honest "up to" reflects
 *  the SITTING budget, not the full multi-domain sweep. */
export function placementProgress(
  answered: number,
  maxQuestions: number,
  feedbackShown = false,
  perSitting = false,
): { label: string; percent: number; questionNumber: number; maxQuestions: number } {
  const safeMax = Math.max(1, Math.floor(maxQuestions));
  const safeAnswered = Math.max(0, Math.min(Math.floor(answered), safeMax));
  const questionNumber = feedbackShown
    ? Math.max(1, safeAnswered)
    : Math.min(safeAnswered + 1, safeMax);
  return {
    label: `Question ${questionNumber} of up to ${safeMax}${perSitting ? " today" : ""}`,
    percent: (safeAnswered / safeMax) * 100,
    questionNumber,
    maxQuestions: safeMax,
  };
}

/** The four feedback states of the attempt/advance state machine. */
export type PracticeVerdict = "accelerated" | "correct" | "retry" | "stuck";

/**
 * Classify a graded result into the feedback branch to render: a correct answer
 * is `accelerated` (a fast streak-jump earned the skill) or plain `correct`; a
 * miss is `retry` (first miss — take another look) until `MISSES_BEFORE_STUCK`,
 * then `stuck` (offer help / a fresh variant, never the answer).
 */
export function classifyVerdict(
  result: { correct: boolean; accelerated?: boolean },
  missCount: number,
): PracticeVerdict {
  if (result.correct) return result.accelerated ? "accelerated" : "correct";
  return missCount < MISSES_BEFORE_STUCK ? "retry" : "stuck";
}

/** One recorded item in the session log — the fields the summary needs.
 *  `dontKnow` is the scholar's honest "I haven't learned this yet" flag: recorded
 *  as a miss for spaced repetition, but NON-disqualifying for the challenge
 *  frontier-move trigger below (an accelerating kid who honestly flags the items
 *  she hasn't met yet still cleared the ones she demonstrated). */
export type SessionLogEntry = { correct: boolean; skillLabel: string; dontKnow?: boolean };

export type SessionSummary = {
  /** Total recorded items (one per item's first attempt). */
  total: number;
  /** How many of those were correct. */
  correctCount: number;
  /** The distinct skills practiced this session, in first-seen order. */
  skills: string[];
};

/** Compute the done-screen summary from the session log. */
export function summarize(log: readonly SessionLogEntry[]): SessionSummary {
  return {
    total: log.length,
    correctCount: log.filter((r) => r.correct).length,
    skills: [...new Set(log.map((r) => r.skillLabel))],
  };
}

/** The outcome of an above-band challenge round: did the scholar's frontier move,
 *  and which above-band skills did she test into? */
export type ChallengeFrontierMove = {
  /** True when the round is "cleared" (see `challengeFrontierMove`) — the reveal fires. */
  moved: boolean;
  /** The distinct above-band skills she got right — the ones she tested into,
   *  named (calmly) by the reveal. In first-seen order. */
  skills: string[];
};

/**
 * The trigger for the "⛰ your frontier moved" reveal after an OPTIONAL above-band
 * challenge round (the `log` here holds only that round's items — the loop resets
 * it when the challenge is accepted).
 *
 * A scholar CLEARS the round — and her frontier moves — when she got a strict
 * MAJORITY of the items she actually ATTEMPTED right, and cleared at least one.
 * Honest "I haven't learned this yet" flags (`dontKnow`) are EXCLUDED from the
 * denominator: they neither help nor disqualify. So a real accelerating kid who
 * clears 8/10 or 9/10 and honestly flags the handful she hasn't met yet still
 * moves her frontier — the round-4 blind pilot found the old spotless-clear bar
 * never fired for exactly these kids (they almost never turn in a flawless round;
 * they turn in an honest one). A genuinely failed round — more wrong than right
 * among the items she attempted, or nothing cleared, or every item honestly
 * flagged — does NOT move the frontier.
 *
 * `skills` names the distinct above-band skills she got right (tested into). Pure
 * and framework-free so web + native share it and it unit-tests standalone. Never
 * a score: the caller renders a portrait line naming these skills, not a count.
 */
export function challengeFrontierMove(
  log: readonly SessionLogEntry[],
): ChallengeFrontierMove {
  const attempted = log.filter((r) => !r.dontKnow);
  const cleared = attempted.filter((r) => r.correct);
  const skills = [...new Set(cleared.map((r) => r.skillLabel))];
  const moved = cleared.length > 0 && cleared.length * 2 > attempted.length;
  return { moved, skills };
}

// ── The "Want a challenge?" invitation copy ─────────────────────────────────
// The opt-in above-band offer shown on the done screen when the server surfaces
// a challenge tail — the scheduler's structural `reason: "challenge"` overflow
// (convex/lib/practice/scheduler.ts): an above-band frontier for a learner with
// band headroom, widened one hop when the structural tail would otherwise be
// empty. Shared so web (PracticeSession) and native (practice.tsx) render the
// SAME words — a scholar-facing surface must not drift between iPad and web.
// Portrait-voiced and calm: recognition of the WORK (not praise of the kid), an
// explicit no-penalty out, and never a score/streak/timer.

/** The invitation heading — the task's own name for the acceleration round. */
export const CHALLENGE_OFFER_TITLE = "Want a challenge?";

/**
 * The invitation body. `count` is how many stretch items were surfaced (drives
 * the one-vs-few phrasing). Names it as a step past the scholar's usual work,
 * with the no-penalty decline stated plainly — an invitation, not a nag.
 */
export function challengeOfferBody(count: number): string {
  const stretch = count === 1 ? "one that's" : "a few that are";
  return `You've been steady on your usual work — here's ${stretch} a step past it. No score, and stopping is always fine.`;
}

/** The decline control's label — a calm, penalty-free out (no "skip"/"quit" edge). */
export const CHALLENGE_OFFER_DECLINE = "Not now";

/** The accept control's label. */
export const CHALLENGE_OFFER_ACCEPT = "Try it";

// ── Stretch playlist tile copy ───────────────────────────────────────────────
// The scholar-home "Stretch" tile — the standing, scholar-chosen home for the
// challenge lane. Part of the CHALLENGE_OFFER_* copy family (one vocabulary
// for the challenge/stretch concept so web and native never drift). Beside the
// in-session interstitial above: the tile offers the SAME above-band round at
// the START of a session (a preview before committing) rather than at the end.
// Portrait-voiced, quiet: a direction ("further"), never a score or ranking.
// Shared so web (PlaylistCard) and native (PracticePlaylistCard) render the
// SAME strings — a scholar-facing tile must not drift between iPad and web.

/** The tile headline — "Stretch" was subsumed into the Go-deeper vocabulary
 *  (2026-08-03): one name for every beyond-today's-lane door, matching the
 *  checkpoint mode tile and the "Go deeper" beat header this tile's own round
 *  already renders. The subtitle keeps the challenge flavor so this door
 *  (challenge-up) stays distinguishable from the depth-day mode tile. */
export const STRETCH_TILE_HEADLINE = "Go deeper";

/** The tile subtitle — one honest line about what the stretch round contains. */
export const STRETCH_TILE_SUBTITLE = "Challenge problems past your level";

/** Accessible label for the stretch tile's press/click target. */
export const STRETCH_TILE_ARIA_LABEL = "Select a go-deeper challenge round";

// ── Review-visibility (P1e, algo-decisions §P1e) ────────────────────────────
// When a skill consolidates (turns fluent), the scholar sees when it returns as
// review — "comes back ~Thursday". The server sends a `dueAt` timestamp (it
// inverts the forgetting curve, `t_due = halfLife × log2(1/target)`); these pure
// helpers turn that into the human phrase BOTH surfaces render identically, so
// the copy can never drift between iPad and web. Warm, matter-of-fact, growth-
// framed — never a threat, never a score.

const COMES_BACK_DAY_MS = 86_400_000;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * The rough "when it returns" phrase for a due timestamp: within 6 days the
 * weekday name ("~Thursday"), otherwise "~in N weeks". A due date at/behind now
 * reads "~soon" (a same-day / already-due return). Deterministic given
 * `dueAtMs`/`nowMs`; the weekday is read in the runtime's local timezone (the
 * scholar's), which is what "Thursday" should mean to them.
 */
export function formatComesBack(dueAtMs: number, nowMs: number): string {
  const days = Math.ceil((dueAtMs - nowMs) / COMES_BACK_DAY_MS);
  if (days <= 0) return "~soon";
  if (days <= 6) return `~${WEEKDAY_NAMES[new Date(dueAtMs).getDay()]}`;
  const weeks = Math.round(days / 7);
  return `~in ${weeks} week${weeks === 1 ? "" : "s"}`;
}

/**
 * The full consolidation line shown when a skill just turned fluent, e.g.
 * "You've got this — comes back ~Thursday to keep it sharp." `phrase` is the
 * `formatComesBack` output. It's a reassurance (the map keeps it fresh), not a
 * deadline.
 */
export function comesBackLine(phrase: string): string {
  return `You've got this — comes back ${phrase} to keep it sharp.`;
}

// ── Placement v2 — the server-authoritative loop's shared pieces ────────────
// Both the web `Placement.tsx` and native `NativePlacement.tsx` drive the same
// one-item-at-a-time loop and must read/render identically, so the copy + the
// ternary-outcome shapes live here (a scholar-facing surface can't diverge
// between iPad and web).

/** The label for the "I don't know this yet" control — used by placement AND the
 *  drill session, so a kid sees the same words everywhere. Honesty is the smart
 *  move, never a failure. */
export const DONT_KNOW_LABEL = "I haven't learned this yet";

// ── "Confirm before you cap" — the post-miss slip/concede choice ────────────
// A single wrong answer during a check-in used to permanently lower the ceiling,
// finalizing the scholar AT a slipped skill and locking away everything above it.
// A wrong answer now offers a two-way choice, modeled on a common
// external-practice-app distinction between "I just made a silly mistake" and "I don't understand this
// yet": the first re-serves a FRESH item on the SAME skill (a slip is superseded
// by a correct confirm; a second miss still caps), the second caps immediately
// like a don't-know. Honest self-report stays first-class AND is the fast path.
// Copy lives here so web (`Placement.tsx`) and native (`NativePlacement.tsx`)
// render identical words — a scholar-facing surface can't diverge iPad↔web.

/** The heading over the two-way choice, shown after a wrong answer. Sentence case. */
export const PLACEMENT_SLIP_PROMPT = "Not quite. What happened?";
/** The RETRY choice: treat the miss as a slip and get a fresh item on the same
 *  skill. Sentence case. */
export const PLACEMENT_SLIP_RETRY_LABEL = "I just made a silly mistake";
/** The CONCEDE choice: an honest "I don't understand this yet", which caps
 *  immediately (same as the don't-know path) and costs no extra question. */
export const PLACEMENT_SLIP_CONCEDE_LABEL = "I don't understand this yet";

/** The ternary placement outcome the server returns after grading one probe. */
export type PlacementOutcome = "correct" | "incorrect" | "unknown";

/**
 * The per-item feedback shown BETWEEN placement probes (placement v2). This is a
 * deliberate placement-only carve-out from the drill no-reveal rule: the
 * measurement on this item is already locked, so revealing the answer teaches
 * rather than offloads. `correctAnswer` is only present on a miss/unknown (a
 * correct answer the scholar already produced).
 *
 * Presentation is unified with the practice drill's corner-stamp overlay
 * (#unify — placement used to swap to a bare full-screen page; both surfaces
 * now render the SAME `VerdictStemCard` / `PracticeVerdictStamp` treatment on
 * the still-visible probe card). Accordingly this no longer carries a
 * full-screen `title` — the corner stamp (`stampLabel`) IS the sighted verdict,
 * and `srAnnouncement` carries the retired title text for assistive tech (the
 * stamp is a sighted-only cue by itself).
 */
export type PlacementFeedback = {
  tone: "correct" | "miss";
  /** The corner-stamp's visible label — mirrors the practice verdict stamp's
   *  "Correct" / "Not quite", but an honest "I haven't learned this yet" earns
   *  its own non-judgmental "Noted" rather than reusing "Not quite" (a
   *  don't-know is honesty, not a wrong guess). */
  stampLabel: string;
  /** The reveal + encouragement shown in the panel under the stamped stem card
   *  (empty-reveal-safe: `correctAnswer` is omitted for a manipulative probe,
   *  which has no answer string to show). */
  body: string;
  /** Screen-reader-only companion to the stamp, carrying the RETIRED
   *  full-screen title copy ("Nice — that's right!" / "Not quite — no
   *  worries." / "That's okay — good to know.") so assistive tech still hears
   *  the verdict the sighted corner stamp conveys. */
  srAnnouncement: string;
};

function punctuateAnswer(answer: string): string {
  const trimmed = answer.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function placementFeedback(
  outcome: PlacementOutcome,
  correctAnswer?: string,
): PlacementFeedback {
  if (outcome === "correct") {
    return {
      tone: "correct",
      stampLabel: "Correct",
      body: "Let's keep going.",
      srAnnouncement: "Nice — that's right!",
    };
  }
  const reveal =
    correctAnswer && correctAnswer.trim().length > 0
      ? `The answer was ${punctuateAnswer(correctAnswer)} `
      : "";
  if (outcome === "unknown") {
    return {
      tone: "miss",
      stampLabel: "Noted",
      // No "work through one step here" — placement renders no interactive
      // step (probes are template/manipulative items), so the copy must not
      // promise an action that doesn't exist. Reveal-only, honestly. (The
      // deterministic warmth-floor reveal line renders in the slot below —
      // never a copy promise, so it can never be a broken one.)
      body: `${reveal}Telling us what you haven't learned yet helps us start you in the right place.`,
      srAnnouncement: "That's okay — good to know.",
    };
  }
  return {
    tone: "miss",
    stampLabel: "Not quite",
    body: `${reveal}That's okay — let's keep going.`,
    srAnnouncement: "Not quite — no worries.",
  };
}

// ── Shared SSE stream plumbing (types + stall watchdog) ─────────────────────
// The fetch + SSE-parse shape is identical on web (global `fetch`) and native
// (`expo/fetch`), so the reader types and watchdog helpers live here —
// parameterized by the fetch impl since RN's global fetch can't stream (native
// must pass expo/fetch). The one remaining consumer is the story thread's
// `streamStoryOpenTurn` below; the placement / practice worked-explanation
// streams that first drove this plumbing were retired for deterministic
// teach-on-a-miss surfaces (TeachingStep in the drill, the warmth-floor reveal
// line in placement).

interface ExplainStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  /** Best-effort abort of the underlying stream. Present on a real
   *  ReadableStreamDefaultReader (web `fetch` + expo/fetch); optional so a
   *  minimal mock/reader without it is still valid. */
  cancel?(): Promise<void> | void;
}

/**
 * Watchdog bounds so a tutor SSE stream ALWAYS settles (see
 * `streamStoryOpenTurn`). A stalled SSE — the connection opens then hangs
 * with no chunk, no `done`, no close (a tutor/model stall or flaky wifi mid-
 * stream) — would otherwise leave `reader.read()` pending forever, so the
 * returned promise never resolves and any caller that gates its "Next"/
 * "Continue" affordance on the stream's completion would trap the scholar.
 * These caps turn that into a bounded `{ errored: true }` (degrade gracefully).
 * Generous on purpose: a real short reply drips within a couple seconds
 * between chunks and finishes well under the total cap.
 */
export const EXPLAIN_STREAM_INACTIVITY_TIMEOUT_MS = 15_000;
export const EXPLAIN_STREAM_TOTAL_TIMEOUT_MS = 45_000;

/** A sentinel the read watchdog resolves with when a chunk didn't arrive in
 *  time (distinct from any real `read()` result). */
const READ_TIMEOUT = Symbol("read-timeout");

/**
 * Race a single `reader.read()` against an inactivity timer. Resolves with the
 * read result, or `READ_TIMEOUT` if no chunk arrived within `ms`. The timer is
 * always cleared so a resolved read never leaks a pending timeout.
 */
async function readWithInactivityTimeout(
  reader: ExplainStreamReader,
  ms: number,
): Promise<{ done: boolean; value?: Uint8Array } | typeof READ_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof READ_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(READ_TIMEOUT), ms);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** The minimal shape of a streaming Response both `fetch` and `expo/fetch` return. */
export interface ExplainStreamResponse {
  ok: boolean;
  body?: { getReader(): ExplainStreamReader } | null;
}
export type ExplainFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<ExplainStreamResponse>;

// ── Moments: the story thread (POST /story-open) — shared SSE reader ────────
// The "Ask the tutor why" chat opened from the story reveal card
// (convex/lib/practice/storyOpen.ts). Unlike the retired single-shot explain
// streams, a story-open conversation is MULTI-TURN — the caller resends the
// whole growing `messages` array ending in the scholar's own latest turn (the
// sheet seeds no fake opener) — and the endpoint's own 6-turn cap ends the
// conversation server-side rather than the client counting turns, so this
// reader surfaces that as an `ended` flag instead of just accumulated text.
// Bounded by the shared inactivity/total watchdogs (the private
// `readWithInactivityTimeout` above) so a stalled connection can never hang
// the sheet.

export interface StoryThreadTurnResult {
  /** The full assistant reply text accumulated across every delta (empty on
   *  a total failure — the caller keeps whatever partial text it already
   *  rendered via `onDelta`). */
  text: string;
  /** True once the endpoint's own turn cap has been reached — the reply IS
   *  already the warm close (`STORY_OPEN_CLOSE`); the caller should retire the
   *  composer instead of sending another turn. */
  ended: boolean;
  /** True on any failure (network, non-ok response, a stalled/timed-out
   *  stream, or a server `error` event) — the caller degrades to its own
   *  inline error, matching this module's never-throws stream contract. */
  errored: boolean;
}

/**
 * Stream ONE story-open turn. POSTs `{ scholarId, fromKey, toKey, messages }`
 * to `${siteBaseUrl}/story-open`, calling `onDelta` with each streamed text
 * chunk as it arrives (for progressive rendering) and resolving once the
 * server's reply — and its `done`/`ended` event — has been read in full.
 * ALWAYS settles (never rejects, never hangs): a stalled or over-long stream
 * bounds out to `{ errored: true }` via the shared stall watchdog.
 */
export async function streamStoryOpenTurn(
  fetchImpl: ExplainFetch,
  siteBaseUrl: string,
  args: {
    scholarId: string;
    fromKey: string;
    toKey: string;
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  },
  authToken: string | null | undefined,
  onDelta: (text: string) => void,
  inactivityTimeoutMs: number = EXPLAIN_STREAM_INACTIVITY_TIMEOUT_MS,
  totalTimeoutMs: number = EXPLAIN_STREAM_TOTAL_TIMEOUT_MS,
): Promise<StoryThreadTurnResult> {
  let res: ExplainStreamResponse;
  try {
    res = await fetchImpl(`${siteBaseUrl}/story-open`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        scholarId: args.scholarId,
        fromKey: args.fromKey,
        toKey: args.toKey,
        messages: args.messages,
      }),
    });
  } catch {
    return { text: "", ended: false, errored: true };
  }
  if (!res.ok || !res.body) return { text: "", ended: false, errored: true };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + totalTimeoutMs;
  let buffer = "";
  let full = "";
  let ended = false;
  let errored = false;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        errored = true;
        break;
      }
      const result = await readWithInactivityTimeout(
        reader,
        Math.min(inactivityTimeoutMs, remaining),
      );
      if (result === READ_TIMEOUT) {
        errored = true;
        break;
      }
      const { done, value } = result;
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        try {
          const ev = JSON.parse(line.slice(6)) as {
            text?: string;
            error?: string;
            done?: boolean;
            ended?: boolean;
          };
          if (ev.error) errored = true;
          else if (typeof ev.text === "string" && ev.text.length > 0) {
            full += ev.text;
            onDelta(ev.text);
          }
          if (ev.done) ended = !!ev.ended;
        } catch {
          /* ignore keepalive / partial-line fragments */
        }
      }
    }
  } catch {
    errored = true;
  }
  if (errored) {
    try {
      await reader.cancel?.();
    } catch {
      /* best-effort */
    }
  }
  return { text: full, ended, errored };
}

/**
 * A best-effort unique id for a per-render idempotency key — the Moments story
 * card's `recordMomentOffered` `clientEventId` in particular, so a render
 * retry/reconnect doesn't double-record a served card. The SAME fallback shape
 * already hand-duplicated at each of PlaylistCard/PracticeSession/practice.tsx's
 * own `clientPickId`/`clientEventId` generators (RN's Hermes has no reliable
 * global `crypto.randomUUID`), pulled here once so a new call site never forks
 * a fourth copy. Only needs to be unique per mount, never cryptographically
 * strong.
 */
export function makeClientEventId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export type PayloadClientEventReceipt = {
  payloadKey: string;
  clientEventId: string;
};

/** Preserve a receipt only while retrying the exact same authoritative payload. */
export function payloadClientEventReceipt(
  current: PayloadClientEventReceipt | null,
  payloadKey: string,
  prefix: string,
): PayloadClientEventReceipt {
  return current?.payloadKey === payloadKey
    ? current
    : {
        payloadKey,
        clientEventId: makeClientEventId(prefix),
      };
}

/**
 * Framework-free builder for the scholar-facing CLOSURE HEADLINE — the growth-
 * framed line that LEADS the practice done-screen and the daily-recap card.
 *
 * This is the deterministic layer of the "reimagined closure messaging" work
 * (review/practice/completion-messaging-plan.html). It plays two roles:
 *   1. Phase 1 — the shipped copy, model-free (a specific, growth-framed line
 *      built from the real buckets — never the old flat "Session complete").
 *   2. Phase 2 — the ALWAYS-SAFE FALLBACK under the LLM-generated headline
 *      (convex/closureLines.ts). The generated line phrases the same true facts
 *      more vividly; if it's missing/slow/offline, this renders instantly.
 *
 * Like shared/dailyRecapLines.ts it imports NOTHING, so native can vendor a
 * read-only copy (native/vendor/shared/closureLines.ts) and both surfaces render
 * the EXACT same words (SCHOLAR-facing parity is a standing rule).
 *
 * ON-BRAND CONTRACT (review/anti-parasocial-design.md, review/learner-parent-
 * pedagogy.md): a PORTRAIT, not a scorecard, and a METHOD finishing, not a
 * character praising the kid. So every line here:
 *   • names the THINKING / the movement on the map — never the child's traits
 *     or caliber ("you're smart/brilliant/a natural" is banned);
 *   • is THIRD-PERSON about the work, never first-person ("I'm proud", "I loved")
 *     — no simulated feelings, no bond;
 *   • frames a hard set as "not yet" + "here's where we build next", never as a
 *     verdict ("wrong"/"failed");
 *   • carries no raw score, streak, goal, or learner-vs-learner comparison — and
 *     per pilot9 ruling J4-A the scholar closure shows NO raw correctness count
 *     at all (the old deemphasized "N of M" receipt was removed from both
 *     clients; the growth headline is the whole close).
 */

/** A coarse shape for how a set went, derived from correct/total but never
 *  exposing the raw number. Both this builder and the LLM generator see only
 *  this enum (portrait, not scorecard). */
export type EffortShape = "steady" | "stretched" | "hardSet";

export function effortShape(correctCount: number, total: number): EffortShape {
  if (total <= 0) return "steady";
  const ratio = correctCount / total;
  if (ratio >= 0.8) return "steady";
  if (ratio >= 0.4) return "stretched";
  return "hardSet";
}

/** Human list join, capped so a headline stays a glance, not a ledger.
 *  1 → "a"; 2 → "a and b"; 3+ → "a, b, and more". */
function joinSkills(skills: readonly string[]): string | null {
  const s = skills.filter((x) => x && x.trim().length > 0);
  if (s.length === 0) return null;
  if (s.length === 1) return s[0];
  if (s.length === 2) return `${s[0]} and ${s[1]}`;
  return `${s[0]}, ${s[1]}, and more`;
}

// ── Practice done-screen ────────────────────────────────────────────────────

/** Which kind of practice run just wrapped. Mirrors the done-screen branches. */
export type PracticeWrap = "session" | "tuneup" | "challenge" | "calibration";

/**
 * A VERIFIED recovery episode, coarse and redacted (review/resilience-recovery-plan.html
 * §B). The only shape that exists today: after the three-miss breaker pushed a
 * step-card repair rung (and the coach, if that wasn't enough), the scholar
 * solved a FRESH, COLD item on the SAME node with no help on that item.
 *
 * It is deliberately NOT a count, a score, a streak, or a durable label — the
 * closure headline is the only place it is ever rendered, and only when the
 * evidence is real. Support alone earns nothing; a missed fresh item earns
 * nothing (the run still closes warmly).
 */
export type PracticeRecovery = "sameNodeUnassisted";

export interface PracticeClosureInput {
  wrap: PracticeWrap;
  /** Distinct skills touched this run (human labels), first-seen order. */
  skills: string[];
  correctCount: number;
  total: number;
  /** True when an above-band CHALLENGE round cleared (frontier moved). The
   *  cleared-challenge case is rendered by FrontierMovedReveal, not this
   *  headline — kept here so the generator's signal is complete. */
  challengeMoved: boolean;
  /** Above-band skills tested into on a cleared challenge (first-seen order). */
  frontierSkills: string[];
  /** Set ONLY when the run produced a recovery episode — see `PracticeRecovery`.
   *  Omitted on every ordinary run. On its own it changes NOTHING: it is a
   *  description of the path, not evidence that the path worked. */
  recovery?: PracticeRecovery;
  /** The evidence gate. True only when the SERVER verified the fresh same-node
   *  item was solved unassisted (`breakerLifecycle.freshResult`) AND recovery
   *  recognition is switched on. Absent today — the evidence floor for showing a
   *  scholar anything about a recovery has not been met — so the copy below is
   *  written, tested, and deliberately unreachable from both surfaces. */
  recoveryVerified?: boolean;
}

export interface PracticeClosure {
  /** The hero line — growth-framed, names the work. Never empty. */
  headline: string;
}

/**
 * The one line a VERIFIED recovery would earn (review/resilience-recovery-plan.html
 * §"What earns recognition"). It names the SEQUENCE — support, then independent
 * success on a fresh item of the same skill — which is the only thing the
 * evidence actually shows. No trait claim ("so gritty"), no count, no streak,
 * no new card, no badge: one headline, on the screen that already exists.
 *
 * The plan's sketch line — the terse one about the fresh try holding — is
 * rejected and appears nowhere in this codebase: it named neither the help nor
 * the work, and it described an event happening TO the scholar rather than
 * anything they did. A nine-year-old learns nothing from that.
 *
 * Rendering it requires `recoveryVerified` — see the gate below.
 */
export const PRACTICE_RECOVERY_HEADLINE =
  "You used help on the hard part, then solved a fresh one on your own. 🧗";

/**
 * Master switch for scholar-visible recovery recognition. The mutation now
 * returns an authoritative verdict only after it persists the linked same-node,
 * unassisted fresh result, so both surfaces can safely recognize the sequence.
 *
 * Both surfaces consult this before they build a recovery signal at all.
 * Client-derived state is never enough: `buildPracticeClosure` still requires
 * the server-backed `recoveryVerified` input.
 */
export const RECOVERY_CLOSURE_ENABLED: boolean = true;

/**
 * The deterministic growth headline for the practice done-screen. Covers the
 * three wraps that need a hero line — session / tuneup / (uncleared) challenge.
 * Calibration keeps its own on-brand copy on the screen, and a CLEARED challenge
 * is carried by FrontierMovedReveal; callers don't route those through here.
 */
export function buildPracticeClosure(input: PracticeClosureInput): PracticeClosure {
  // DELIBERATELY DOES NOT NAME THE SKILLS. The done screen renders the
  // "You practiced" card — the complete, canonical roster — directly beneath
  // this line, so a headline that also named two of them plus "and more" was
  // the same signal rendered twice, and the lossy copy at that (T3: don't
  // restate what the view already renders). Verified 2026-08-07 that this
  // headline only ever renders WITH that card: a mapping run has its own
  // ceremony copy and never routes through here, and the cleared-challenge
  // wrap is carried by FrontierMovedReveal. What survives here is the part the
  // card cannot carry — the EFFORT SHAPE, the interpretation of how it went.
  const shape = effortShape(input.correctCount, input.total);

  // A VERIFIED recovery outranks the effort shape: on a run that hit the wall,
  // took support, and then landed a fresh cold item on the same skill, THAT
  // sequence is the truest thing about the session. Both halves are required —
  // an unverified `recovery` describes the path the scholar took and is not, by
  // itself, evidence that it worked, so it must never move the copy.
  if (input.recovery === "sameNodeUnassisted" && input.recoveryVerified === true) {
    return { headline: PRACTICE_RECOVERY_HEADLINE };
  }

  if (input.wrap === "tuneup") {
    return { headline: `You kept your map fresh — still yours. ✨` };
  }

  if (input.wrap === "challenge") {
    // Uncleared challenge (the cleared path uses the reveal). Reaching past the
    // usual work IS the win — never a score.
    return { headline: `You reached past your usual work. That's how the edge moves. 🌱` };
  }

  // Plain session — the effort shape, framed as movement. A hard set is the
  // edge, never a verdict.
  if (shape === "hardSet") {
    return {
      headline: `You found the edge today — that's exactly where the next building starts.`,
    };
  }
  if (shape === "stretched") {
    return { headline: `You worked through it, including the parts that fought back.` };
  }
  return { headline: `You showed up and did the thinking — that's how the map grows.` };
}

// ── Daily recap "Look what you did today" ───────────────────────────────────

export interface DailyArcInput {
  /** Skills demonstrated FLUENT today ("yours now"). */
  yoursNow: string[];
  /** Skills whose access advanced today ("new on your map"). */
  newOnMap: string[];
  /** Skills merely drilled today. */
  practiced: string[];
  /** Distinct practiced count before the label cap. */
  practicedCount: number;
  /** Activity titles finished today. */
  finished: string[];
}

/**
 * A 1–2 sentence ARC that connects the day's honest buckets into "what led to
 * what" (D3 allows two sentences here; the practice screen stays one). Leads
 * with the strongest movement (became-fluent > access-advanced > finished >
 * practiced) and, when there are two strong signals, links them. Returns null
 * when there's nothing worth a sentence (the card already gates on hasAny — this
 * is belt-and-suspenders).
 */
export function buildDailyArc(input: DailyArcInput): string | null {
  const yours = joinSkills(input.yoursNow);
  const opened = joinSkills(input.newOnMap);
  const finished = joinSkills(input.finished);

  if (yours && opened) {
    return `${cap(yours)} became yours today — and that opened the door to ${opened}.`;
  }
  if (yours) {
    return `${cap(yours)} became yours today — solid ground on your map now.`;
  }
  if (opened) {
    return `You opened up new ground today: ${opened}.`;
  }
  if (finished) {
    const also =
      input.practicedCount > 0
        ? input.practicedCount === 1
          ? ` — and kept a skill moving along the way.`
          : ` — and kept ${input.practicedCount} skills moving along the way.`
        : `.`;
    return `You finished ${finished}${also}`;
  }
  if (input.practicedCount > 0) {
    const practiced = joinSkills(input.practiced);
    return input.practicedCount <= 3 && practiced
      ? `You put in real practice today on ${practiced}.`
      : `You put in real practice today, across ${input.practicedCount} skills.`;
  }
  return null;
}

/** Capitalize the first letter of a phrase used at sentence start (skill labels
 *  are lowercase). Leaves the rest untouched. */
function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ── Governed generation: the redacted signal + cache key ────────────────────
//
// Phase 2 (convex/closureLines.ts) hands the LLM ONLY the shapes below — skill
// LABELS + a coarse effort SHAPE + booleans, never a raw score/streak/another
// learner. The client builds the same shape, the server sanitizes it again, and
// closureSignalHash() keys the per-(scholar, kind, signal) cache so an identical
// situation reuses a line instead of regenerating.

export type ClosureKind = "practice" | "daily";

/** The redacted signal for a practice done-screen line. Mirrors
 *  PracticeClosureInput minus the raw score (only the coarse `effortShape`). */
export interface PracticeSignal {
  wrap: PracticeWrap;
  skills: string[];
  effortShape: EffortShape;
  challengeMoved: boolean;
  frontierSkills: string[];
  /** Present only on a VERIFIED recovery episode (see `PracticeRecovery`) —
   *  which requires the enabled recovery gate and server-verified evidence. The
   *  Convex validator and server-side signal rebuild preserve this field so the
   *  hash below keys it separately from ordinary practice. */
  recovery?: PracticeRecovery;
}

/** The redacted signal for a daily-recap arc. The honest buckets, labels + one
 *  count only (the count is a magnitude, never a correct/total score). */
export interface DailySignal {
  yoursNow: string[];
  newOnMap: string[];
  practiced: string[];
  finished: string[];
  practicedCount: number;
}

export type ClosureSignal = PracticeSignal | DailySignal;

/** Trim + drop empties + cap a label list so neither the hash nor the prompt can
 *  balloon (defense-in-depth; the surfaces already cap). */
export function sanitizeLabels(labels: readonly string[], max = 6): string[] {
  return labels
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, max)
    .map((l) => (l.length > 60 ? l.slice(0, 60) : l));
}

/** A small, stable, order-insensitive hash of the redacted signal. Pure + shared
 *  so the cache key is identical wherever it's computed. djb2 over a canonical
 *  string; collisions are harmless (worst case: a reused on-brand line). */
export function closureSignalHash(kind: ClosureKind, signal: ClosureSignal): string {
  const canonical =
    kind === "practice"
      ? practiceCanonical(signal as PracticeSignal)
      : dailyCanonical(signal as DailySignal);
  return `${kind}:${djb2(canonical)}`;
}

function practiceCanonical(s: PracticeSignal): string {
  return [
    s.wrap,
    s.effortShape,
    s.challengeMoved ? "1" : "0",
    sanitizeLabels(s.skills).slice().sort().join("|"),
    sanitizeLabels(s.frontierSkills).slice().sort().join("|"),
    s.recovery ?? "",
  ].join("~");
}

function dailyCanonical(s: DailySignal): string {
  return [
    sanitizeLabels(s.yoursNow).slice().sort().join("|"),
    sanitizeLabels(s.newOnMap).slice().sort().join("|"),
    sanitizeLabels(s.practiced).slice().sort().join("|"),
    sanitizeLabels(s.finished).slice().sort().join("|"),
    String(Math.max(0, Math.round(s.practicedCount || 0))),
  ].join("~");
}

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  // Unsigned hex — compact + stable.
  return (h >>> 0).toString(16);
}

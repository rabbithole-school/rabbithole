// The young-reader TURN RULES (TRA-501: turn length, one question, no option
// menus, repair) are a third, separate piece, keyed on read AND talk
// (`needsYoungReaderTurnRules`). Listener delivery covers only what voice
// adds on top, so no rule is stated twice.
// Single source of truth for scholar reading levels.
//
// ⚠️ WHAT THIS VALUE IS, AND WHAT IT IS NOT
//
// Two different real things share this vocabulary. They are not two
// measurements of one quantity and must not be collapsed:
//
//   • The CONFIRMED level (`users.readingLevel`, appended to
//     `readingLevelHistory` when a teacher sets or accepts it) is a
//     HUMAN-RATIFIED SETTING that the system ACTS ON. It is rendered verbatim
//     into the tutor's READING LEVEL prompt section (`sessionHelpers`). It is
//     the TALK level (see "Talk, read, write" below). A teacher owns it.
//
//   • The COMPUTED estimate (`users.readingLevelSuggestion`) is current
//     evidence, not a setting, and it never becomes one: nothing promotes it
//     into the talk level (TRA-513 removed "Set as talk level"); it is shown
//     info-only under the Write row. It is WRITING-DERIVED: every input to
//     `readingLevelAnalysis` is the child's own PRODUCTION — typed tutor-chat
//     messages plus OCR-transcribed handwritten portfolio prose. There is no
//     reception evidence anywhere in it; nothing measures what the child can
//     READ. Describe it to humans as an estimate from the scholar's own
//     writing, never as a reading measurement.
//
// The estimate is NOT a Lexile measure, NOT a normed assessment, and NOT a
// screener result. It is one model's judgement over a sample of a child's
// composed work. The stored FIELD names keep the "reading" word for now — a
// rename is a migration with blast radius well beyond the naming problem — so
// this comment is the record of what the value actually is.
//
// A reading level is a US grade band stored as a plain string. Grades 1–12
// carry **0.1 granularity** (a tenth-of-a-grade, e.g. "7.3" = about three-tenths
// into grade 7) so a teacher — and the AI estimator — can place a scholar more
// precisely than a whole grade. The canonical forms are:
//
//   "K"              kindergarten
//   "1" … "12"       a whole grade (note: "7", never "7.0")
//   "1.1" … "12.9"   a tenth into a grade
//   "college"        college-level
//
// Consumed by the teacher setter/validator (`scholars.updateReadingLevel`), the
// writing-derived estimator (`readingLevelAnalysis`), and rendered verbatim into
// the tutor's READING LEVEL prompt section (`sessionHelpers`) — so any string
// here must read naturally after "the scholar's reading level is set to …".
//
// ── Talk, read, write (TRA-503) ─────────────────────────────────────────
//
// One grade can't describe a young scholar whose talking, reading and writing
// sit years apart, so a scholar carries THREE levels:
//
//   • TALK  — `users.readingLevel` (+ `sessions.readingLevelOverride`): the grade
//             band above. Teacher UI calls it "Talk level". It drives the
//             tutor's vocabulary and register. (The stored field keeps its old
//             name; renaming it is a migration with no payoff.)
//   • READ  — `users.readLevel`: listener | beginner | reader. How the tutor's
//             words arrive. Unset = reader (today's behavior). `listener` is
//             the voice-first tier (TRA-492's voice loop, the K register).
//   • WRITE — `users.writeMode`: own | voice. How the child's words get in.
//             Unset = own. `voice` tells the tutor to offer the mic first and
//             never ask the child to type.
//
// A teacher sets read and write; no machine writes them without a human
// (Mentava only SUGGESTS a read level — `lib/mentava.ts`).
//
// LEGACY: the old non-grade tier `pre-reader` lived in the talk field. It now
// means read `listener` + talk `K` (`migrations:splitPreReaderLevels`). Until
// that migration runs — and until a later PR narrows it away — every reader
// goes through `talkLevelOf` / `readLevelOf` / `resolveEffectiveLevels` below,
// which treat a stored `pre-reader` exactly that way. No consumer may compare a
// level against "pre-reader" itself.

import { v } from "convex/values";

/** Every valid reading level, in ascending order (K → 12.9 → college). */
export const VALID_READING_LEVELS: string[] = (() => {
  const levels: string[] = ["K"];
  for (let grade = 1; grade <= 12; grade++) {
    levels.push(String(grade));
    for (let tenth = 1; tenth <= 9; tenth++) {
      levels.push(`${grade}.${tenth}`);
    }
  }
  levels.push("college");
  return levels;
})();

const VALID_SET = new Set(VALID_READING_LEVELS);

/**
 * LEGACY talk-field value for what is now read `listener` + talk `K`. Kept only
 * so the dual-read helpers below recognise un-migrated rows; no setter accepts
 * it any more. Remove with the narrowing follow-up to TRA-503.
 */
export const PRE_READER_LEVEL = "pre-reader";

/**
 * The early-reader band: a TALK level from K through 2.9. It swaps the generic
 * reading-level sentence for the early-reader register
 * (`buildEarlyReaderSection`). A `listener` gets its own register instead, the
 * legacy `pre-reader` string is not a band, and an unset level is neither.
 */
export function isEarlyReader(
  level: string | null | undefined,
): level is string {
  if (!level || !VALID_SET.has(level)) return false;
  if (level === "K") return true;
  if (level === "college") return false;
  return Number.parseFloat(level) < 3;
}

/**
 * Does this scholar get the young-reader TURN RULES — short turns, one
 * question, no text menus, voice-first repair (TRA-501)?
 *
 * The ONE seam for "who gets these rules"; the tutor prompt's levels slot
 * (`selectLevelSections`) and the completion-closing pool both ask this,
 * never the tier predicates directly.
 *
 * Keyed on the talk/read split (TRA-503): anyone who doesn't read
 * independently yet (read `listener` or `beginner`) gets them at ANY talk
 * level, since the turn's shape is about getting the words in and out, not
 * about the ideas. An early TALK level (K–2.9) keeps them too. A stored legacy
 * "pre-reader" resolves to listener first (`resolveEffectiveLevels`).
 */
export function needsYoungReaderTurnRules(levels: {
  talk: string | null;
  read: ReadLevel;
}): boolean {
  return levels.read !== "reader" || isEarlyReader(levels.talk);
}

/**
 * Is `level` a talk level a teacher may assign — one of the canonical grade
 * bands? The legacy `pre-reader` value is no longer assignable: a scholar who
 * can't read yet is talk `K` (or higher) with read `listener`.
 */
export function isValidReadingLevel(level: string): boolean {
  return VALID_SET.has(level);
}

/**
 * Coerce a free-form grade string (typically an LLM's answer) to a canonical
 * reading level, or `null` if it can't be mapped.
 *
 * Accepts "K"/"kindergarten", "college"/"university", and grade numbers with or
 * without a tenth ("7", "7.0", "7.3", "Grade 7.3", "7th"). The first decimal
 * digit is kept (so "7.35" → "7.3"); a ".0" tenth collapses to the whole grade
 * ("7.0" → "7"). Grades below 1 map to "K", above 12 to "college".
 */
export function normalizeReadingLevel(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === "k" || s.startsWith("kinder")) return "K";
  if (s.includes("college") || s.includes("univ")) return "college";

  const m = s.match(/(\d+)(?:\.(\d))?/);
  if (!m) return null;
  const grade = parseInt(m[1], 10);
  if (Number.isNaN(grade)) return null;
  if (grade < 1) return "K";
  if (grade > 12) return "college";

  const tenth = m[2] ? parseInt(m[2], 10) : 0;
  const canonical = tenth > 0 ? `${grade}.${tenth}` : String(grade);
  return isValidReadingLevel(canonical) ? canonical : null;
}

/**
 * How stale a stored writing-derived estimate may get before a writer refreshes
 * its timestamp even though the value has not moved.
 *
 * The observer runs after EVERY tutor session, and patching a `users` doc
 * invalidates every live subscription on it, so an unconditional stamp on that
 * path is real write amplification. This bound keeps a displayed age honest to
 * within a school half-day while collapsing a busy scholar's many sessions into
 * at most a couple of writes.
 */
export const ESTIMATE_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * The fewest TYPED words a writing-derived estimate may be computed from, and
 * the floor under which the profile says "too few typed words to trust".
 *
 * 100 is the classic readability sample size (Fry and SMOG both score a
 * 100-word sample): below it one long word swings the grade by a band, and the
 * estimator is asked for a tenth of a grade. The old gate was 10 words, which
 * made the model answer but not the answer mean anything.
 */
export const MIN_TYPED_WORDS_FOR_ESTIMATE = 100;

/** Words in `text`: tokens containing a letter ("-" and "3" are not words). */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
}

/** What a writer should do with a freshly computed writing-derived estimate. */
export interface EstimateWriteDecision {
  /**
   * `"stored"`    — a new or changed estimate.
   * `"refreshed"` — same grade as last time, but the stamp was stale enough
   *                 that its age was about to mislead.
   * `"skipped"`   — same grade and the stamp is still fresh; do not write.
   */
  action: "stored" | "refreshed" | "skipped";
}

/**
 * Decide how to record a writing-derived grade-level estimate.
 *
 * The estimate is information about the scholar's typed writing, shown on the
 * Write row. It is never compared with the talk level (TRA-513: framing it as a
 * disagreement with the talk level is what let it overwrite that level), so
 * agreement is not special and nothing here clears a stored value.
 *
 * Pure, so the honesty properties are testable without a database:
 *  • AGE IS NEVER SILENTLY STALE. Any write stamps `computedAt`; an unchanged
 *    grade still refreshes it once the stamp passes `ESTIMATE_REFRESH_MS`.
 *  • THE HOT PATH IS BOUNDED. The same grade inside the window is a no-op.
 *
 * `pending` and `estimate` are canonical levels (`normalizeReadingLevel`), so
 * "7" and "7.0" can never read as different.
 */
export function decideEstimateWrite(args: {
  /** The currently stored estimate, or null if none. */
  pending: string | null;
  /** When the stored estimate was computed, or null if never stamped. */
  pendingAt: number | null;
  /** The freshly computed, canonical estimate. */
  estimate: string;
  now: number;
  /** Skip the freshness guard — for an explicit, teacher-initiated analysis. */
  force?: boolean;
}): EstimateWriteDecision {
  const valueUnchanged = args.estimate === args.pending;
  const stampFresh =
    args.pendingAt !== null && args.now - args.pendingAt < ESTIMATE_REFRESH_MS;
  if (valueUnchanged && stampFresh && !args.force) return { action: "skipped" };
  return { action: valueUnchanged ? "refreshed" : "stored" };
}

// ── Talk, read, write helpers (TRA-503) ──────────────────────────────────

/** How the tutor's words reach the scholar. Unset means `reader`. */
export const READ_LEVELS = ["listener", "beginner", "reader"] as const;
export type ReadLevel = (typeof READ_LEVELS)[number];
export const DEFAULT_READ_LEVEL: ReadLevel = "reader";

/** How the scholar's words get in. Unset means `own`. */
export const WRITE_MODES = ["own", "voice"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];
export const DEFAULT_WRITE_MODE: WriteMode = "own";

/** Which of the three levels a `readingLevelHistory` row records. */
export type LevelDimension = "talk" | "read" | "write";

export const readLevelValidator = v.union(
  v.literal("listener"),
  v.literal("beginner"),
  v.literal("reader"),
);
export const writeModeValidator = v.union(v.literal("own"), v.literal("voice"));
export const levelDimensionValidator = v.union(
  v.literal("talk"),
  v.literal("read"),
  v.literal("write"),
);

export function isReadLevel(value: unknown): value is ReadLevel {
  return (READ_LEVELS as readonly unknown[]).includes(value);
}

export function isWriteMode(value: unknown): value is WriteMode {
  return (WRITE_MODES as readonly unknown[]).includes(value);
}

/** Teacher-facing labels (sentence case). Scholars never see their levels. */
export const READ_LEVEL_LABELS: Record<ReadLevel, string> = {
  listener: "Listener",
  beginner: "Beginner",
  reader: "Reader",
};
export const WRITE_MODE_LABELS: Record<WriteMode, string> = {
  own: "On their own",
  voice: "By voice",
};

/**
 * The TALK level a stored talk-field value means: identity for every grade
 * band; the legacy `pre-reader` value means talk `K`.
 */
export function talkLevelOf(level: string | null | undefined): string | null {
  if (!level) return null;
  return level === PRE_READER_LEVEL ? "K" : level;
}

/**
 * A scholar's READ level: the stored field when set, else `listener` for an
 * un-migrated `pre-reader` talk value, else `reader`.
 */
export function readLevelOf(
  scholar:
    | { readLevel?: ReadLevel | null; readingLevel?: string | null }
    | null
    | undefined,
): ReadLevel {
  if (scholar?.readLevel) return scholar.readLevel;
  return scholar?.readingLevel === PRE_READER_LEVEL
    ? "listener"
    : DEFAULT_READ_LEVEL;
}

/**
 * The patch that splits an un-migrated `pre-reader` scholar (or session) into
 * talk `K` + read `listener`, or null when there's nothing legacy to split.
 * Shared by the migration and by every talk/read SETTER, so a teacher editing
 * one level before the migration has run never silently drops the other (a
 * talk edit would otherwise overwrite "pre-reader" and lose the listener).
 * An explicit read level already stored wins over the inferred `listener`.
 */
export function legacyPreReaderSplit(row: {
  readingLevel?: string | null;
  readLevel?: ReadLevel | null;
}): { readingLevel: string; readLevel: ReadLevel } | null {
  if (row.readingLevel !== PRE_READER_LEVEL) return null;
  return { readingLevel: "K", readLevel: row.readLevel ?? "listener" };
}

/** A scholar's WRITE mode: the stored field, else `own`. */
export function writeModeOf(
  scholar: { writeMode?: WriteMode | null } | null | undefined,
): WriteMode {
  return scholar?.writeMode ?? DEFAULT_WRITE_MODE;
}

/** The talk/read/write a tutor session runs with, after every override. */
export interface EffectiveLevels {
  /** The talk grade band, or null when unset. Never the legacy `pre-reader`. */
  talk: string | null;
  read: ReadLevel;
  write: WriteMode;
}

/**
 * The ONE resolver for a session's effective levels. The tutor prompt, the
 * grapheme gate, the completion-closing pool and both clients' voice mode all
 * read it, so a per-session override moves every one of them together.
 *
 * Precedence, per dimension:
 *  • talk  — `readingLevelOverride` > (synthetic view: the synthetic level |
 *            otherwise: the context scholar's level), then `talkLevelOf`.
 *  • read  — `readLevelOverride` > a legacy `pre-reader` talk override or
 *            synthetic level (= listener) > (synthetic view: reader |
 *            otherwise: the context scholar's read level).
 *  • write — the context scholar's write mode; a synthetic view is `own`.
 */
export function resolveEffectiveLevels(args: {
  isSyntheticView: boolean;
  session: {
    readingLevelOverride?: string;
    readLevelOverride?: ReadLevel;
    testDriveSyntheticReadingLevel?: string;
  };
  scholar:
    | {
        readingLevel?: string | null;
        readLevel?: ReadLevel | null;
        writeMode?: WriteMode | null;
      }
    | null
    | undefined;
}): EffectiveLevels {
  const { isSyntheticView, session, scholar } = args;
  const sessionTalk = isSyntheticView
    ? (session.readingLevelOverride ?? session.testDriveSyntheticReadingLevel)
    : session.readingLevelOverride;
  const rawTalk = isSyntheticView
    ? (sessionTalk ?? null)
    : (sessionTalk ?? scholar?.readingLevel ?? null);
  const read: ReadLevel =
    session.readLevelOverride ??
    (sessionTalk === PRE_READER_LEVEL
      ? "listener"
      : isSyntheticView
        ? DEFAULT_READ_LEVEL
        : readLevelOf(scholar));
  return {
    talk: talkLevelOf(rawTalk),
    read,
    write: isSyntheticView ? DEFAULT_WRITE_MODE : writeModeOf(scholar),
  };
}

/**
 * Plot position for a talk level on a trend line: K = 0.5, college = 13, a
 * grade its number; a legacy `pre-reader` row plots as K. Null for anything
 * unparseable, so a chart skips it instead of drawing NaN.
 */
export function talkLevelToNumber(
  level: string | null | undefined,
): number | null {
  const talk = talkLevelOf(level);
  if (!talk) return null;
  if (talk === "K") return 0.5;
  if (talk === "college") return 13;
  const n = Number.parseFloat(talk);
  return Number.isFinite(n) ? n : null;
}

/** "K", "College" or "Grade 3.4"; null when unset. Legacy `pre-reader` → "K". */
export function talkLevelLabel(
  level: string | null | undefined,
): string | null {
  const talk = talkLevelOf(level);
  if (!talk) return null;
  if (talk === "K") return "K";
  if (talk === "college") return "College";
  return `Grade ${talk}`;
}

/**
 * The Write row's info line for the writing-derived estimate (TRA-513).
 *
 *  • No estimate (or an unreadable stored grade), or a counted sample under
 *    `MIN_TYPED_WORDS_FOR_ESTIMATE`: refuses to state a grade.
 *  • An estimate stored before word counts existed (`typedWords` null): its
 *    sample is unknown, which is not the same as small, so it is labelled as
 *    coming from an older method rather than called untrustworthy.
 *  • Otherwise the grade and its sample. Every stated estimate carries its age.
 */
export function writingEstimateText(
  level: string | null | undefined,
  typedWords: number | null | undefined,
  computedAt: number | null | undefined,
  now: number,
): string {
  const canonical = level ? normalizeReadingLevel(level) : null;
  const counted = typeof typedWords === "number";
  if (!canonical || (counted && typedWords < MIN_TYPED_WORDS_FOR_ESTIMATE)) {
    return "Typed writing: too few typed words to trust";
  }
  const grade =
    canonical === "K"
      ? "kindergarten"
      : canonical === "college"
        ? "college level"
        : `grade ${canonical}`;
  const age =
    typeof computedAt === "number"
      ? ` · ${estimateAgeText(Math.max(0, Math.floor((now - computedAt) / 86_400_000)))}`
      : "";
  return counted
    ? `Typed writing reads like ${grade} · from ${typedWords.toLocaleString("en-US")} typed words${age}`
    : `Estimate from an older method: ${grade}${age}`;
}

function estimateAgeText(days: number): string {
  if (days === 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// ── Talk decides WHAT, read decides HOW ──────────────────────────────────
//
// TALK picks the tutor's register (vocabulary, ideas, sentence size). READ
// picks only how the words arrive. A talk-7 listener (a twice-exceptional
// eight-year-old who follows grade-9 ideas by ear) gets grade-7 wording,
// delivered by voice. The one place the two meet is the K register: a listener
// whose talk level is K or unset keeps the existing pre-reader register, which
// already carries the spoken-delivery rules (today's pre-reader behavior).
//
// The young-reader TURN RULES (TRA-501: turn length, one question, no option
// menus, repair) are a third, separate piece, keyed on read AND talk
// (`needsYoungReaderTurnRules`). Listener delivery covers only what voice adds
// on top, so no rule is stated twice.

/** Which talk register the tutor uses. */
export type TutorRegister = "preReader" | "earlyReader" | "generic" | "none";

/** The level-driven pieces of the tutor prompt, chosen from the levels alone. */
export interface LevelSections {
  register: TutorRegister;
  /** The young-reader turn rules (`needsYoungReaderTurnRules`). */
  youngReaderTurnRules: boolean;
  /** Spoken-delivery rules for a listener whose register doesn't carry them. */
  listenerDelivery: boolean;
  /** Read-along delivery + the "your turn" line for a beginner (TRA-504). */
  beginnerDelivery: boolean;
  writeByVoice: boolean;
}

/** Pick the register (from talk) and the delivery add-ons (from read/write). */
export function selectLevelSections(levels: EffectiveLevels): LevelSections {
  const listener = levels.read === "listener";
  const register: TutorRegister =
    listener && (levels.talk === null || levels.talk === "K")
      ? "preReader"
      : isEarlyReader(levels.talk)
        ? "earlyReader"
        : levels.talk
          ? "generic"
          : "none";
  return {
    register,
    youngReaderTurnRules: needsYoungReaderTurnRules(levels),
    listenerDelivery: listener && register !== "preReader",
    beginnerDelivery: levels.read === "beginner",
    writeByVoice: levels.write === "voice",
  };
}

const READ_LEVEL_PROMPT_PHRASES: Record<ReadLevel, string> = {
  listener: "not yet (listener: hears the words, can't read them)",
  beginner: "beginning to decode (beginner)",
  reader: "independently (reader)",
};
const WRITE_MODE_PROMPT_PHRASES: Record<WriteMode, string> = {
  own: "on their own",
  voice: "by voice (dictates)",
};

/**
 * A scholar's levels as one phrase for a model-facing prompt or tool result.
 * The ONE renderer for every consumer that used to paste the raw talk string.
 *
 *  • Default read + write (reader, on their own): the talk string alone ("3"),
 *    so an ordinary scholar's prompt is byte-identical to before.
 *  • Otherwise all three: "talk K; reads: not yet (listener: …); writes: by
 *    voice (dictates)". Without this a migrated pre-reader would read as a
 *    plain "K", and the model would lose the "can't read yet" signal.
 *  • Null when nothing is set.
 *
 * Takes the stored scholar row; a legacy "pre-reader" resolves through
 * `talkLevelOf` / `readLevelOf`.
 */
export function describeLevelsForPrompt(
  scholar:
    | {
        readingLevel?: string | null;
        readLevel?: ReadLevel | null;
        writeMode?: WriteMode | null;
      }
    | null
    | undefined,
): string | null {
  return describeEffectiveLevelsForPrompt({
    talk: talkLevelOf(scholar?.readingLevel),
    read: readLevelOf(scholar),
    write: writeModeOf(scholar),
  });
}

/** `describeLevelsForPrompt` for already-resolved session levels. */
export function describeEffectiveLevelsForPrompt({
  talk,
  read,
  write,
}: EffectiveLevels): string | null {
  if (read === DEFAULT_READ_LEVEL && write === DEFAULT_WRITE_MODE) return talk;
  return `talk ${talk ?? "unset"}; reads: ${READ_LEVEL_PROMPT_PHRASES[read]}; writes: ${WRITE_MODE_PROMPT_PHRASES[write]}`;
}

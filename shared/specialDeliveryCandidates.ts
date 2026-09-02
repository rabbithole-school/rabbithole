// Special-delivery letter — candidate selection & safety rails (pure module).
//
// WHAT THIS IS. `shared/specialDelivery.ts` mail-merges a skill label into a
// stem and *always* prints something. This module replaces the *choosing*
// half. Given a day of facts, it emits RANKED, VETTED CANDIDATES for the two
// reflection sections ("look back" and "tomorrow clue"), or explicitly says
// nothing qualifies. It does NOT write the final prose — an editorial model
// call (a later pass) writes the question from a chosen candidate. This
// module's whole job is to guarantee provenance and eligibility so the model
// can only ever pick from material that is already safe to quote, and so the
// worst a bad model output can do is produce a *blank* section, never an
// unsafe one.
//
// Conventions match `shared/specialDelivery.ts`: pure TypeScript, no React, no
// Convex imports, deterministic. Nothing here touches the database or the
// network.
//
// SPEC PROVENANCE. This implements `r4-EDITOR-final.md` "Part 3 — The selection
// function", constrained by REV3/REV4 founder rules 1-8. Where a name or a
// ranked list below is a reconstruction (the authoring spec lived in a sibling
// worktree not readable from here), it is flagged with `SPEC-RECONSTRUCTED:`.

export const SPECIAL_DELIVERY_CANDIDATES_VERSION = "candidates-v2";

/* ------------------------------------------------------------------------- *
 * Sections
 * ------------------------------------------------------------------------- */

/**
 * The two reflection sections a letter can carry.
 * - `lookBack`: a reflection on what shifted in the child's thinking today.
 * - `clue`: a thread to pull *tomorrow* — must rest on something touched today
 *   (founder rule 5: no "returning thread").
 */
export type LetterSection = "lookBack" | "clue";

/* ------------------------------------------------------------------------- *
 * Ranked source kinds — Part 3 §3.1
 *
 * SPEC-RECONSTRUCTED: the exact kind names/order in §3.1 were not readable.
 * These preserve the spec's stated shape: self-generated verbatim material
 * out-ranks activity-supplied filler, and there is deliberately NO
 * "returning thread" rank for `clue` (founder rule 5 — deleting it is the
 * point).
 *
 * CONTRACTION (candidates-v2): the `lookBack` quotable rank is now a SINGLE
 * kind, `scholarMoment`. Code no longer pretends to classify idea-shape (claim
 * vs. connection vs. observation) — that judgment reads the verbatim, so it
 * belongs to the editorial model, which sees the verbatim anyway. Every
 * self-generated moment that survives the mechanical vetoes is offered; the
 * model decides whether it is a standing idea worth quoting.
 * ------------------------------------------------------------------------- */

/** `lookBack` candidate kinds, best-first. */
export type LookBackSourceKind =
  | "scholarMoment" // rank 1: any self-generated moment, quoted verbatim
  | "completedActivity" // rank 2: an activity finished today (subject only, no quote)
  | "practiceSkill"; // rank 3: a skill practiced today (subject only, no quote)

/** `clue` candidate kinds, best-first. */
export type ClueSourceKind =
  | "openQuestion" // rank 1: an unresolved question the child raised today, verbatim
  | "seedInvitation" // rank 2: a seed invitation dated today (subject only, no quote)
  | "emergingThread"; // rank 3: a live thread the child was chewing on today, quoted verbatim

export type CandidateSourceKind = LookBackSourceKind | ClueSourceKind;

/** Ranked order for `lookBack`; index + 1 is the `sourceRank`. */
export const LOOK_BACK_SOURCE_RANK: readonly LookBackSourceKind[] = [
  "scholarMoment",
  "completedActivity",
  "practiceSkill",
];

/** Ranked order for `clue`; index + 1 is the `sourceRank`. */
export const CLUE_SOURCE_RANK: readonly ClueSourceKind[] = [
  "openQuestion",
  "seedInvitation",
  "emergingThread",
];

function sourceRankOf(section: LetterSection, kind: CandidateSourceKind): number {
  const order: readonly CandidateSourceKind[] =
    section === "lookBack" ? LOOK_BACK_SOURCE_RANK : CLUE_SOURCE_RANK;
  const index = order.indexOf(kind);
  // A kind that isn't in its section's order is a programming error; rank it
  // last rather than throw, so a bad kind degrades to low priority.
  return index === -1 ? order.length + 1 : index + 1;
}

/* ------------------------------------------------------------------------- *
 * Candidate — the vetted, safe-to-quote unit handed to the model pass.
 * ------------------------------------------------------------------------- */

export type LetterCandidate = {
  section: LetterSection;
  /** 1 = best; §3.1 order. */
  sourceRank: number;
  sourceKind: CandidateSourceKind;
  /**
   * The child's exact words, already vetted as safe to quote — or `null` when
   * the candidate is about activity-supplied material (nothing to quote).
   */
  scholarVerbatim: string | null;
  /** What the candidate is ABOUT, in printable words. */
  subject: string;
  /** The child made it (`true`) vs the activity supplied it (`false`). */
  selfGenerated: boolean;
  datedToday: boolean;
  provenance: { kind: string; id?: string; dayKey?: string };
};

/* ------------------------------------------------------------------------- *
 * Input facts
 *
 * STRUCTURAL REDACTION (§3.2). A scored key moment carries BOTH the child's
 * safe verbatim AND a teacher-facing analysis. The redaction veto is made
 * *structural, not a filter*: candidate construction never sees a moment's
 * `teacherAnalysis`. `toQuotableMoment` strips it, and every downstream
 * function consumes `QuotableMoment`, which has no `teacherAnalysis` field at
 * the type level — so there is no code path by which analysis text can reach a
 * candidate field.
 * ------------------------------------------------------------------------- */

/**
 * A scored key moment. CONTRACTION (candidates-v2): there is no longer a
 * `kind` classification here. Nothing upstream produced the old taxonomy
 * (claim/rule/analogy/coinedTerm/distinction/…) — the observer emits signal
 * types, and `momentInterestingness` emits misconception/breakthrough/mastery/
 * signal/insight — so demanding it silently excluded signal-borne verbatims
 * (often the best quotes) and made the rank-1 "question" clue path unreachable.
 * The idea-shape judgment ("is this a standing idea, a preference, or a bare
 * observation?") reads the verbatim and now belongs to the editorial model.
 *
 * The one exception is `looksLikeQuestion`: a CHEAP SYNTACTIC HINT the mapper
 * computes from the text alone (see `textLooksLikeQuestion`). It is not a
 * judgment about whether the moment is really a question — only a routing hint
 * so an unresolved question-shaped verbatim can rank first as a tomorrow-clue.
 */
export type ScoredKeyMoment = {
  id: string;
  /** The child's exact words — the ONLY text ever eligible to be quoted. */
  scholarVerbatim: string;
  /** What the moment is about, in printable words (safe). */
  subject: string;
  /**
   * Teacher-facing analysis. NEVER copy this into a candidate field. It is
   * kept out of `QuotableMoment` structurally, so this is enforced by the type
   * system rather than by a runtime filter.
   */
  teacherAnalysis: string;
  /** The child produced it themselves, vs the activity handing it to them. */
  selfGenerated: boolean;
  datedToday: boolean;
  /** The verbatim is a bare answer to a closed question (not standing). */
  answersClosedQuestion: boolean;
  /** For question-shaped moments: still open (unresolved) at end of day. */
  resolved: boolean;
  /**
   * CHEAP SYNTACTIC HINT (not a judgment): the verbatim looks like a question
   * — e.g. it contains a "?". Computed by the mapper from text alone via
   * `textLooksLikeQuestion`. Used only to route an unresolved question-shaped
   * verbatim to the rank-1 tomorrow-clue slot; the editorial model still
   * decides whether it earns print.
   */
  looksLikeQuestion: boolean;
  /** Scored strength; higher wins ties within a rank. */
  score: number;
  dayKey?: string;
};

/**
 * The cheap, mechanical hint the mapper uses to fill `looksLikeQuestion`. It is
 * intentionally syntactic — a "?" in the child's words — never a judgment about
 * whether the moment is genuinely a question. Kept here so the mapper and any
 * test derive the flag identically.
 */
export function textLooksLikeQuestion(text: string): boolean {
  return text.includes("?");
}

/** An activity-supplied fact: a subject with no quotable verbatim. */
export type ActivityFact = {
  id?: string;
  subject: string;
  datedToday: boolean;
  dayKey?: string;
};

export type LetterFacts = {
  dayKey: string;
  keyMoments: readonly ScoredKeyMoment[];
  completedActivities: readonly ActivityFact[];
  practiceSkills: readonly ActivityFact[];
  seedInvitations: readonly ActivityFact[];
};

/**
 * A key moment with `teacherAnalysis` structurally removed. All candidate
 * construction consumes this type, so analysis text cannot reach a candidate.
 */
export type QuotableMoment = Omit<ScoredKeyMoment, "teacherAnalysis">;

export function toQuotableMoment(moment: ScoredKeyMoment): QuotableMoment {
  // Explicit omit — the destructured `teacherAnalysis` is intentionally
  // discarded and never referenced again.
  const { teacherAnalysis: _redactedTeacherFacing, ...safe } = moment;
  return safe;
}

/* ------------------------------------------------------------------------- *
 * Mechanical vetoes — Part 3 §3.2 (only the ones code can decide)
 *
 * Implemented here: ONE-WORD / NON-STANDING, STALENESS (founder rule 5),
 * PREFERENCE-NOT-IDEA (founder rule 6). REDACTION is structural (above), not a
 * runtime veto.
 *
 * DELIBERATELY OUT — these are JUDGMENT vetoes and belong to the model pass,
 * not to code: parent-proof read, defended-misconception, quote-as-gotcha, and
 * register. Code cannot decide them reliably, so they are not attempted here.
 * ------------------------------------------------------------------------- */

export type MechanicalVeto =
  | "one-word-or-nonstanding"
  | "stale"
  | "preference-not-idea";

/** Founder rule: a quotable excerpt must stand on its own — roughly 6+ words. */
export const MIN_QUOTE_WORDS = 6;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function wordCount(text: string): number {
  return words(text).length;
}

/**
 * Lexical guard for founder rule 6: a verbatim that *states* a
 * like/dislike/favourite is a preference, not an idea. Idea-shape is otherwise
 * the editorial model's judgment now; this cheap regex stays as
 * defense-in-depth so an obvious preference never reaches the prompt.
 */
const PREFERENCE_PATTERNS: readonly RegExp[] = [
  /\bmy (least )?(favou?rite)\b/i,
  /\bi (really |kind of |kinda )?(like|love|hate|dislike|enjoy|prefer)\b/i,
  /\bi don'?t (like|enjoy|care for)\b/i,
  /\bis (the|my) (best|worst|favou?rite)\b/i,
  /\bare (the|my) (best|worst|favou?rite)\b/i,
];

export function isPreferenceText(text: string): boolean {
  return PREFERENCE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The mechanical veto decision for one prospective candidate. Returns the
 * veto reason, or `null` if the candidate survives every code-decidable check.
 *
 * `scholarVerbatim === null` means an activity-supplied candidate: there is
 * nothing to quote, so the quote-quality vetoes (one-word, preference) do not
 * apply; only staleness can veto it.
 */
export function mechanicalVeto(input: {
  section: LetterSection;
  scholarVerbatim: string | null;
  datedToday: boolean;
  answersClosedQuestion?: boolean;
}): MechanicalVeto | null {
  // STALENESS (founder rule 5) — BOTH sections must rest on something touched
  // TODAY. A clue clearly must (its whole point is tomorrow's thread), but a
  // look-back must too: quoting a weeks-old moment as if it happened today (the
  // Boba dog naming) is a lie about when the child had the idea. There is no
  // "returning thread" rank; a non-today candidate is deleted, not demoted.
  if (!input.datedToday) {
    return "stale";
  }

  // Quote-quality vetoes only apply when we intend to quote the child.
  if (input.scholarVerbatim !== null) {
    // ONE-WORD / NON-STANDING — an excerpt under ~6 words, or a bare answer to
    // a closed question, cannot stand on its own as a quote.
    if (
      wordCount(input.scholarVerbatim) < MIN_QUOTE_WORDS ||
      input.answersClosedQuestion === true
    ) {
      return "one-word-or-nonstanding";
    }

    // PREFERENCE-NOT-IDEA (founder rule 6) — a like/dislike/favourite is not
    // quotable. Kept as DEFENSE-IN-DEPTH: idea-shape is now the editorial
    // model's judgment, but this cheap lexical guard still blanks an obvious
    // preference before it ever reaches the prompt.
    if (isPreferenceText(input.scholarVerbatim)) {
      return "preference-not-idea";
    }
  }

  return null;
}

/* ------------------------------------------------------------------------- *
 * Candidate selection — Part 3 §3.1 / §3.3
 * ------------------------------------------------------------------------- */

const MAX_CANDIDATES_PER_SECTION = 6;

type Draft = {
  section: LetterSection;
  sourceKind: CandidateSourceKind;
  scholarVerbatim: string | null;
  subject: string;
  selfGenerated: boolean;
  datedToday: boolean;
  provenance: { kind: string; id?: string; dayKey?: string };
  answersClosedQuestion?: boolean;
  score: number;
};

function draftToCandidate(draft: Draft): LetterCandidate {
  return {
    section: draft.section,
    sourceRank: sourceRankOf(draft.section, draft.sourceKind),
    sourceKind: draft.sourceKind,
    scholarVerbatim: draft.scholarVerbatim,
    subject: draft.subject,
    selfGenerated: draft.selfGenerated,
    datedToday: draft.datedToday,
    provenance: draft.provenance,
  };
}

function dedupeKey(draft: Draft): string {
  const quote = draft.scholarVerbatim?.trim().toLowerCase() ?? "";
  const subject = draft.subject.trim().toLowerCase();
  return quote || subject;
}

function collectLookBackDrafts(
  facts: LetterFacts,
  moments: readonly QuotableMoment[],
): Draft[] {
  const drafts: Draft[] = [];

  // Every self-generated moment is a quotable candidate. Idea-shape (is this a
  // standing idea, a preference, or a bare observation?) is the editorial
  // model's judgment now, not code's — so we do not pre-filter by a taxonomy
  // nothing upstream produced. The mechanical vetoes (one-word, preference
  // regex) still run in `vetAndRank` as defense-in-depth.
  for (const moment of moments) {
    if (!moment.selfGenerated) continue;
    drafts.push({
      section: "lookBack",
      sourceKind: "scholarMoment",
      scholarVerbatim: moment.scholarVerbatim,
      subject: moment.subject,
      selfGenerated: true,
      datedToday: moment.datedToday,
      provenance: { kind: "keyMoment", id: moment.id, dayKey: moment.dayKey ?? facts.dayKey },
      answersClosedQuestion: moment.answersClosedQuestion,
      score: moment.score,
    });
  }

  for (const activity of facts.completedActivities) {
    drafts.push({
      section: "lookBack",
      sourceKind: "completedActivity",
      scholarVerbatim: null,
      subject: activity.subject,
      selfGenerated: false,
      datedToday: activity.datedToday,
      provenance: { kind: "completedActivity", id: activity.id, dayKey: activity.dayKey ?? facts.dayKey },
      score: 0,
    });
  }

  for (const skill of facts.practiceSkills) {
    drafts.push({
      section: "lookBack",
      sourceKind: "practiceSkill",
      scholarVerbatim: null,
      subject: skill.subject,
      selfGenerated: false,
      datedToday: skill.datedToday,
      provenance: { kind: "practiceSkill", id: skill.id, dayKey: skill.dayKey ?? facts.dayKey },
      score: 0,
    });
  }

  return drafts;
}

/** A moment routes to the rank-1 open-question clue slot. */
function isOpenQuestionMoment(moment: QuotableMoment): boolean {
  return moment.selfGenerated && moment.looksLikeQuestion && !moment.resolved;
}

function collectClueDrafts(
  facts: LetterFacts,
  moments: readonly QuotableMoment[],
): Draft[] {
  const drafts: Draft[] = [];

  // rank 1: an unresolved, question-shaped verbatim the child raised today.
  // `looksLikeQuestion` is a cheap syntactic hint (a "?"), not a judgment; the
  // editorial model decides whether it earns print.
  for (const moment of moments) {
    if (!isOpenQuestionMoment(moment)) continue;
    drafts.push({
      section: "clue",
      sourceKind: "openQuestion",
      scholarVerbatim: moment.scholarVerbatim,
      subject: moment.subject,
      selfGenerated: true,
      datedToday: moment.datedToday,
      provenance: { kind: "keyMoment", id: moment.id, dayKey: moment.dayKey ?? facts.dayKey },
      answersClosedQuestion: moment.answersClosedQuestion,
      score: moment.score,
    });
  }

  for (const seed of facts.seedInvitations) {
    drafts.push({
      section: "clue",
      sourceKind: "seedInvitation",
      scholarVerbatim: null,
      subject: seed.subject,
      selfGenerated: false,
      datedToday: seed.datedToday,
      provenance: { kind: "seedInvitation", id: seed.id, dayKey: seed.dayKey ?? facts.dayKey },
      score: 0,
    });
  }

  // rank 3: other self-generated today-moments the child was chewing on. These
  // KEEP the moment's verbatim — a candidate never discards words the child
  // actually said (the words already survived redaction + the mechanical
  // vetoes; blanking them starved the editorial model of the child's best door
  // material, e.g. an analogy that then read as an anchorless bare subject). The
  // open-question moments are already listed at rank 1, so they are skipped
  // here; the openQuestion/emergingThread split stays purely for routing/rank.
  for (const moment of moments) {
    if (isOpenQuestionMoment(moment)) continue; // already considered at rank 1
    if (!moment.selfGenerated) continue;
    drafts.push({
      section: "clue",
      sourceKind: "emergingThread",
      scholarVerbatim: moment.scholarVerbatim,
      subject: moment.subject,
      selfGenerated: true,
      datedToday: moment.datedToday,
      provenance: { kind: "keyMoment", id: moment.id, dayKey: moment.dayKey ?? facts.dayKey },
      score: moment.score,
    });
  }

  return drafts;
}

function vetAndRank(drafts: Draft[]): LetterCandidate[] {
  const seen = new Set<string>();
  const kept: Draft[] = [];

  for (const draft of drafts) {
    const veto = mechanicalVeto({
      section: draft.section,
      scholarVerbatim: draft.scholarVerbatim,
      datedToday: draft.datedToday,
      answersClosedQuestion: draft.answersClosedQuestion,
    });
    if (veto !== null) continue;

    const key = dedupeKey(draft);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(draft);
  }

  kept.sort((a, b) => {
    const rankA = sourceRankOf(a.section, a.sourceKind);
    const rankB = sourceRankOf(b.section, b.sourceKind);
    if (rankA !== rankB) return rankA - rankB;
    if (b.score !== a.score) return b.score - a.score;
    // Stable, deterministic final tiebreak.
    return dedupeKey(a) < dedupeKey(b) ? -1 : dedupeKey(a) > dedupeKey(b) ? 1 : 0;
  });

  return kept.slice(0, MAX_CANDIDATES_PER_SECTION).map(draftToCandidate);
}

export type LetterSelection = {
  lookBack: LetterCandidate[];
  clue: LetterCandidate[];
};

/**
 * The main entry point: given a day of facts, emit ranked, vetted candidates
 * for both sections. Redaction is structural (moments are stripped to
 * `QuotableMoment` before any candidate field is populated); the three
 * code-decidable vetoes are applied in `vetAndRank`.
 */
export function selectLetterCandidates(facts: LetterFacts): LetterSelection {
  const moments = facts.keyMoments.map(toQuotableMoment);
  return {
    lookBack: vetAndRank(collectLookBackDrafts(facts, moments)),
    clue: vetAndRank(collectClueDrafts(facts, moments)),
  };
}

/* ------------------------------------------------------------------------- *
 * Print-nothing decision — Part 3 §3.6 (conditions 1 and 2)
 *
 * Blank is a first-class result carrying a NAMED reason, so a section is never
 * an empty string by accident. This is the deliberate departure from the old
 * mail-merge, which always fell back to generic filler.
 * ------------------------------------------------------------------------- */

export type BlankReason =
  // §3.6 condition 1: nothing survived vetting for this section.
  | "no-candidate"
  // §3.6 condition 2 (LOOK-BACK ONLY): the whole day produced no self-generated
  // scholar moment, so there is nothing authentic to reflect on — do not
  // manufacture reflection out of activity-supplied filler alone. This gate is
  // per-section: the tomorrow-clue can legitimately stand on a today-named
  // interest (a seed invitation) with no self-generated look-back material, so
  // it does NOT apply this floor (F2 — the Ryder case).
  //
  // SPEC-RECONSTRUCTED: §3.6's two conditions were not readable; these are the
  // two the founder rules imply (no candidate, and no genuine signal).
  | "no-self-generated-signal"
  // The model declined this section, or returned nothing, even though vetted
  // candidates existed. Distinct from `no-candidate` (there was material; the
  // model chose not to use it) so a later teacher surface can tell the two
  // apart honestly (F3).
  | "model-declined"
  // A model-written line failed the safety validation (word budget / AI tell),
  // so the caller drops the section to blank.
  | "failed-validation";

export type PrintDecision =
  | { print: true }
  | { print: false; reason: BlankReason };

/** True when the day carries at least one self-generated scholar moment. */
export function hasSelfGeneratedSignal(facts: LetterFacts): boolean {
  return facts.keyMoments.some((moment) => moment.selfGenerated);
}

/**
 * The explicit print-nothing decision for a section (§3.6 conditions 1 & 2).
 *
 * The signal floor (condition 2) is PER-SECTION (F2): the LOOK-BACK requires a
 * self-generated moment that day — reflecting on activity filler alone would be
 * manufactured — but the CLUE does not, because it can rest on a today-named
 * interest (e.g. a seed invitation) even on a day with no self-generated
 * look-back material. Every clue candidate is already `datedToday` (the
 * staleness veto), which is the clue's own floor. Both sections still require
 * at least one surviving candidate (condition 1).
 */
export function decidePrintNothing(input: {
  section: LetterSection;
  facts: LetterFacts;
  candidates: readonly LetterCandidate[];
}): PrintDecision {
  if (input.section === "lookBack" && !hasSelfGeneratedSignal(input.facts)) {
    return { print: false, reason: "no-self-generated-signal" };
  }
  if (input.candidates.length === 0) {
    return { print: false, reason: "no-candidate" };
  }
  return { print: true };
}

/* ------------------------------------------------------------------------- *
 * Output safety rails — Part 3 §3.4 (word budget) and founder rule 4 (AI tells)
 *
 * These run over a FINISHED line the model wrote. The caller drops the section
 * to BLANK on any failure, so the worst a bad model output can do is blank a
 * section — never make the letter unsafe.
 * ------------------------------------------------------------------------- */

/** Founder budget: at most 55 words per section (§3.4). */
export const MAX_SECTION_WORDS = 55;

/**
 * Per-section word budgets. FOUNDER DIRECTIVE (compression): prefer LESS text at
 * higher quality — telegram-grade. The look-back is capped at 40 words and the
 * tomorrow-clue at 30; `MAX_SECTION_WORDS` remains the absolute ceiling neither
 * may exceed.
 */
export const SECTION_WORD_BUDGET: Record<LetterSection, number> = {
  lookBack: 40,
  clue: 30,
};

export type WordBudgetResult = {
  ok: boolean;
  wordCount: number;
  max: number;
};

export function checkSectionWordBudget(
  line: string,
  max: number = MAX_SECTION_WORDS,
): WordBudgetResult {
  const count = wordCount(line);
  return { ok: count <= max, wordCount: count, max };
}

/**
 * Banned constructions — founder rule 4 ("AI tells"). Each entry is a named
 * pattern so a failure reports *which* tell fired.
 *
 * SPEC-RECONSTRUCTED: rule 4's exact list was not readable. This is a curated
 * set of the LLM tells a warm human note to a child must never contain. The
 * caller treats any hit as a hard fail (blank the section).
 */
export const AI_TELL_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "dive-in", pattern: /\b(let'?s )?dive (in|into|deeper)\b/i },
  { label: "delve", pattern: /\bdelve(s|d|ing)?\b/i },
  { label: "learning-journey", pattern: /\b(learning|your|this) journey\b/i },
  { label: "unleash", pattern: /\bunleash(es|ed|ing)?\b/i },
  { label: "unlock-your", pattern: /\bunlock(s|ed|ing)? (your|the|its|their)\b/i },
  { label: "keep-up-the-good-work", pattern: /\bkeep up the (great|good|amazing|awesome) work\b/i },
  { label: "important-to-note", pattern: /\bit'?s (important|worth) (to note|noting)\b/i },
  { label: "at-the-end-of-the-day", pattern: /\bat the end of the day\b/i },
  { label: "in-conclusion", pattern: /\bin conclusion\b/i },
  { label: "in-todays-world", pattern: /\bin today'?s (fast[- ]paced |ever[- ]changing )?world\b/i },
  { label: "the-power-of", pattern: /\bthe power of\b/i },
  { label: "explore-the-world-of", pattern: /\bexplore the (fascinating |wonderful )?world of\b/i },
  { label: "hope-this-finds-you", pattern: /\bhope this (letter |message |email |note )?finds you\b/i },
  { label: "as-an-ai", pattern: /\bas an ai\b/i },
  { label: "elevate-your", pattern: /\belevate(s|d)? your\b/i },
  { label: "game-changer", pattern: /\bgame[- ]changer\b/i },
  { label: "remember-opener", pattern: /^\s*remember,/i },
  { label: "tapestry", pattern: /\btapestry\b/i },
  { label: "testament-to", pattern: /\btestament to\b/i },
  // ── Widened rails (iteration 2): adjacent "knowing-summary" stamps the model
  // reached for when the taxonomy leaked onto the page. These run on the line
  // with quoted spans stripped (see validateGeneratedLine), so an ordinary use
  // inside the child's quoted words — e.g. "the real reason" in a quoted
  // question — is exempt. Conservative by design: a false positive only blanks a
  // section, never prints something wrong.
  //
  // "a real/genuine <idea-noun>" as an evaluative STAMP — either in an explicit
  // copula clause ("That's a real …", "It's a genuine …") or naming an
  // idea-category noun the taxonomy leaked ("a real claim/rule/distinction/
  // problem"). Deliberately NARROW: ordinary object nouns ("get a real say",
  // "a real spacecraft", "the real reason") must NOT fire — a false positive
  // only blanks a section, but these idioms are legitimate child-facing prose.
  {
    label: "a-real-evaluative",
    pattern:
      /\b((that'?s|that is|it'?s|it is|this is) (a|an) (real|genuine)|(a|an) (real|genuine) (claim|idea|rule|distinction|question|insight|problem|point|argument|model|observation|thought|move|thing|puzzle))\b/i,
  },
  // "worth <editorial-verb>ing (further)" — the knowing-summary frames the model
  // reaches for ("worth testing further", "worth exploring", "worth noting").
  // NARROWED (iteration 2): enumerate ONLY the editorial verbs, so an ordinary
  // child-facing "worth choosing/waiting/fighting for" — legitimate prose — is
  // NOT killed. (Real false positive: "Is fast ever worth choosing over fair?"
  // must pass.)
  { label: "worth-gerund", pattern: /\bworth (testing|exploring|noting|considering|unpacking)( further)?\b/i },
  // therapy "sit with".
  { label: "sit-with", pattern: /\bsit with\b/i },
  // "you were (really) onto something".
  { label: "onto-something", pattern: /\byou were (really )?onto something\b/i },
];

export type BannedPhraseHit = { label: string };

export type BannedPhraseResult = {
  ok: boolean;
  hits: BannedPhraseHit[];
};

export function checkAiTells(line: string): BannedPhraseResult {
  const hits: BannedPhraseHit[] = [];
  for (const { label, pattern } of AI_TELL_PATTERNS) {
    if (pattern.test(line)) hits.push({ label });
  }
  return { ok: hits.length === 0, hits };
}

/* ------------------------------------------------------------------------- *
 * Quoted-span stripping + first-person (parasocial) rail
 *
 * SPEC.md anti-parasocial: the letter is a METHOD, not a character. It must
 * carry no narrator and no companion — no I/me/my/we/us/let's ("your line stuck
 * with me", "tomorrow, let's dig into…"). The child's OWN quoted words are
 * exempt (a verbatim may legitimately contain "I wonder…"), so the output-prose
 * rails (first-person AND the widened AI-tells) run on the line with quoted
 * spans removed.
 * ------------------------------------------------------------------------- */

/**
 * Remove double- and single-quoted spans (the child's verbatim) so the
 * output-prose rails never fire on the child's own words. Straight single
 * quotes are treated as quote marks ONLY when balanced around a span and not
 * acting as an apostrophe (so "That's" is untouched).
 */
export function stripQuotedSpans(line: string): string {
  return line
    .replace(/\u201C[^\u201D]*\u201D/g, " ") // curly double “…”
    .replace(/"[^"]*"/g, " ") // straight double "…"
    .replace(/\u2018[^\u2019]*\u2019/g, " ") // curly single ‘…’
    .replace(/(^|\s)'[^']+'(?=[\s.,!?;:]|$)/g, "$1 "); // straight single '…'
}

/** First-person / companion tokens the letter must never contain (SPEC.md
 * anti-parasocial). Applied to the quote-stripped line. */
const FIRST_PERSON_PATTERN = /\b(I|me|my|we|us|let's)\b/i;

export type FirstPersonResult = { ok: boolean; token: string | null };

export function checkFirstPerson(line: string): FirstPersonResult {
  const m = line.match(FIRST_PERSON_PATTERN);
  return m ? { ok: false, token: m[0] } : { ok: true, token: null };
}

/* ------------------------------------------------------------------------- *
 * Quoted-span EXTRACTION + two rails that run INSIDE the child's quoted words
 * (iteration 2)
 *
 * `stripQuotedSpans` (above) removes the child's verbatim so the prose rails
 * (first-person, AI-tells) never fire on the child's own words. These two new
 * rails are the mirror image: they run ONLY on the extracted quoted spans.
 *   - quoted-spelling (finding #2): the rev-3 golden rule — paraphrase a young
 *     child's nonstandard orthography, never quote it. Within a quoted span, a
 *     standalone lowercase "i" or an ALL-CAPS run of 4+ letters is a hard fail.
 *   - the scholar-name rail lives just below in validateGeneratedLine and runs
 *     on the WHOLE line, not just quotes.
 * Conservative by design: a false positive only blanks a section.
 * ------------------------------------------------------------------------- */

/**
 * Extract the inner text of every double- and single-quoted span — the inverse
 * of `stripQuotedSpans`, so the quoted-spelling rail sees exactly the child's
 * verbatim words. Straight single quotes count only when balanced around a span
 * (not an apostrophe), matching `stripQuotedSpans`.
 */
export function extractQuotedSpans(line: string): string[] {
  const spans: string[] = [];
  const patterns: RegExp[] = [
    /\u201C([^\u201D]*)\u201D/g, // curly double “…”
    /"([^"]*)"/g, // straight double "…"
    /\u2018([^\u2019]*)\u2019/g, // curly single ‘…’
    /(?:^|\s)'([^']+)'(?=[\s.,!?;:]|$)/g, // straight single '…'
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) spans.push(m[1]);
  }
  return spans;
}

// A standalone lowercase "i" (surrounded by non-letters) — a young child's
// nonstandard first-person orthography.
const STANDALONE_LOWER_I = /(?:^|[^A-Za-z])i(?:[^A-Za-z]|$)/;
// An ALL-CAPS run of 4+ letters — shouting emphasis ("HARD"), not standard prose.
const ALL_CAPS_RUN = /\b[A-Z]{4,}\b/;

export type QuotedSpellingResult = { ok: boolean; token: string | null };

/** Fail if any QUOTED span exposes a young child's nonstandard spelling — a
 * standalone lowercase "i" or an ALL-CAPS run of 4+ letters (finding #2). */
export function checkQuotedSpelling(line: string): QuotedSpellingResult {
  for (const span of extractQuotedSpans(line)) {
    if (STANDALONE_LOWER_I.test(span)) {
      return { ok: false, token: "standalone-lowercase-i" };
    }
    const caps = span.match(ALL_CAPS_RUN);
    if (caps) return { ok: false, token: caps[0] };
  }
  return { ok: true, token: null };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------------- *
 * Typographic normalization (findings #2 high / #3 medium — the unicode bypass)
 *
 * Every output rail below reasons about ASCII punctuation: the first-person
 * rail looks for a straight-apostrophe "let's", `stripQuotedSpans` matches
 * straight/curly quote marks, and `\b` word boundaries assume no invisible
 * separators. A model that returns the SAME banned construction with a curly
 * apostrophe ("let\u2019s"), curly quotes, or a zero-width joiner sneaks past
 * every one of them. Normalizing here — BEFORE span-stripping and every pattern
 * check — closes that bypass in ONE place, so no individual rail has to grow a
 * curly-quote variant. It is used only for VALIDATION; the printed line keeps
 * its original typography.
 * ------------------------------------------------------------------------- */
export function normalizeTypography(text: string): string {
  return (
    text
      // Curly / typographic single quotes + primes → straight apostrophe, so a
      // curly-apostrophe "let\u2019s" is caught by the first-person rail.
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      // Curly / typographic double quotes + double-prime → straight double
      // quote, so a curly-quoted span still strips (and cannot mask a tell).
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      // Zero-width characters (ZWSP/ZWNJ/ZWJ/word-joiner/BOM) that would break a
      // `\b` boundary or split a banned phrase invisibly.
      .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "")
  );
}

export type ScholarNameResult = { ok: boolean; name: string | null };

/** Fail any line that contains the scholar's own first name (finding #1). The
 * letter is TO the child and must address them as "you"; a name anywhere in it
 * is an address slip ("…takes a super long time, Lily said."). An empty name
 * (no scholar in context, e.g. a pure output-rail unit test) skips the check. */
export function checkScholarName(
  line: string,
  scholarFirstName: string,
): ScholarNameResult {
  const name = scholarFirstName.trim();
  if (!name) return { ok: true, name: null };
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
  return re.test(line) ? { ok: false, name } : { ok: true, name: null };
}

/* ------------------------------------------------------------------------- *
 * validateGeneratedLine — runs both output rails and returns pass/fail with
 * reasons. The caller drops to BLANK on fail.
 * ------------------------------------------------------------------------- */

export type LineFailure =
  | { kind: "over-word-budget"; wordCount: number; max: number }
  | { kind: "banned-phrase"; label: string }
  | { kind: "first-person"; token: string }
  | { kind: "contains-scholar-name"; name: string }
  | { kind: "quoted-spelling"; token: string };

export type LineValidation = {
  ok: boolean;
  reasons: LineFailure[];
};

/**
 * Validate a finished, model-written line for one section. Runs five output
 * rails: the per-section word budget (40 look-back / 30 clue), the parasocial
 * first-person rail, the AI-tell list, the scholar-name rail (finding #1), and
 * the quoted-spelling rail (finding #2). The parasocial + AI-tell rails run on
 * the line with the child's quoted spans stripped; the quoted-spelling rail runs
 * on those same spans; the name rail runs on the whole line.
 *
 * @param scholarFirstName the child's first name, so a line that addresses or
 *   names them in the third person is rejected. Empty (no scholar in context)
 *   skips only that rail — the real pipeline always supplies it.
 */
export function validateGeneratedLine(
  rawLine: string,
  section: LetterSection,
  scholarFirstName: string = "",
): LineValidation {
  const reasons: LineFailure[] = [];

  // Close the unicode bypass (findings #2/#3) FIRST: every rail below reasons
  // about straight ASCII punctuation and `\b` boundaries, so a curly apostrophe,
  // curly quote, or zero-width joiner would otherwise sail past them.
  const line = normalizeTypography(rawLine);

  const budget = checkSectionWordBudget(line, SECTION_WORD_BUDGET[section]);
  if (!budget.ok) {
    reasons.push({
      kind: "over-word-budget",
      wordCount: budget.wordCount,
      max: budget.max,
    });
  }

  // The letter is addressed TO the child as "you" — the name must not appear
  // anywhere in it (finding #1). Runs on the whole line.
  const nameCheck = checkScholarName(line, scholarFirstName);
  if (!nameCheck.ok && nameCheck.name) {
    reasons.push({ kind: "contains-scholar-name", name: nameCheck.name });
  }

  // Never expose a young child's nonstandard orthography from inside a quote
  // (finding #2). Runs on the quoted spans.
  const spelling = checkQuotedSpelling(line);
  if (!spelling.ok && spelling.token) {
    reasons.push({ kind: "quoted-spelling", token: spelling.token });
  }

  // Output-prose rails run on the line with the child's quoted words removed, so
  // the child's verbatim can legitimately contain "I", "the real reason", etc.
  // without tripping the parasocial / AI-tell rails.
  const prose = stripQuotedSpans(line);

  const firstPerson = checkFirstPerson(prose);
  if (!firstPerson.ok && firstPerson.token) {
    reasons.push({ kind: "first-person", token: firstPerson.token });
  }

  const tells = checkAiTells(prose);
  for (const hit of tells.hits) {
    reasons.push({ kind: "banned-phrase", label: hit.label });
  }

  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------------- *
 * finalizeSection — the one call that guarantees a section is either a valid
 * printed line or an explicitly-reasoned blank. This is where the safety
 * contract is enforced: the worst a bad model output can do is a blank section.
 * ------------------------------------------------------------------------- */

export type SectionOutcome =
  | { kind: "printed"; line: string }
  | { kind: "blank"; reason: BlankReason };

/**
 * Resolve a section to its final outcome.
 *
 * @param section    which section.
 * @param facts      the day's facts (for the §3.6 signal floor).
 * @param candidates the vetted candidates for this section.
 * @param line       the model's finished line, or `null` if the model produced
 *                   nothing / declined.
 * @param scholarFirstName the child's first name, threaded into
 *                   `validateGeneratedLine` so the name rail can fire.
 *
 * Blank always carries a named reason; a printed outcome is always a
 * budget-clean, AI-tell-free line.
 */
export function finalizeSection(input: {
  section: LetterSection;
  facts: LetterFacts;
  candidates: readonly LetterCandidate[];
  line: string | null;
  scholarFirstName?: string;
}): SectionOutcome {
  const decision = decidePrintNothing({
    section: input.section,
    facts: input.facts,
    candidates: input.candidates,
  });
  if (!decision.print) {
    return { kind: "blank", reason: decision.reason };
  }

  // Candidates existed, but the model declined or produced nothing — a
  // first-class blank distinct from `no-candidate` (F3), never an empty string.
  if (input.line === null || input.line.trim() === "") {
    return { kind: "blank", reason: "model-declined" };
  }

  const validation = validateGeneratedLine(
    input.line,
    input.section,
    input.scholarFirstName ?? "",
  );
  if (!validation.ok) {
    return { kind: "blank", reason: "failed-validation" };
  }

  return { kind: "printed", line: input.line.trim() };
}

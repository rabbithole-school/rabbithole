/**
 * Building + grading a practice SESSION — the run of items a scholar works.
 *
 * Anti-cheat invariant: the correct answer is NEVER sent to the client. Because
 * the template engine is pure + deterministic, we serve an item as an opaque
 * `itemId = "<skillKey>#<seed>"` (stem only); to grade, the server re-derives
 * the same item from the id and compares. No answer leaves the server, and no
 * transient answer storage is needed. (LLM-generated items, added later, are
 * stored server-side and graded by id lookup instead — same contract.)
 *
 * Pure module — used by convex/practiceSkills.ts (practiceSession / submitAnswer).
 */

import {
  type AnswerType,
  answersEqual,
  formatUnit,
  parseAnswerWithUnit,
  formatAnswerForDisplay,
} from "./answers";
import {
  generateItem,
  hasTemplate,
  makeRng,
  itemIdentity,
  type PracticeItem,
} from "./templates";
import { expressionAnswerSignals } from "./answerShape";
import type { FadeResult } from "./fadedSteps";
import type { PracticePromptVisual } from "../../../shared/practicePromptVisual";
import {
  factKeyFromOperands,
  isFactFamilySkill,
} from "../../../shared/factKey";

export type ServedItem = {
  itemId: string;
  skillKey: string;
  skillLabel: string;
  // The practice domain this item's skill belongs to. Present on every served
  // item so a MIXED-domain session (a playlist spanning several domains) can
  // show a per-item domain chip and the client can reason about which domains
  // are represented. Single-domain sessions set it to the session domain.
  domain?: string;
  stem: string;
  // Widened beyond the template engine's `AnswerType` so a stored manipulative
  // practiceItem (answerType === MANIPULATIVE_ANSWER_TYPE, from
  // lib/manipulative/practiceContract.ts) and a rubric'd DIALOGUE stretch item
  // ("dialogue" — graded on /practice-dialogue, no typed answer) can be served
  // through the same shape — the template engine itself never produces either.
  answerType: AnswerType | "manipulative" | "dialogue";
  /** The measurement unit this item must be answered in, in DISPLAY form
   *  ("cm³"). Present only for a unit-bearing item, whose grader requires the
   *  unit as part of the answer. Not an answer leak — the stem already names
   *  the unit in words; this is the machine-readable echo the pad renders and
   *  the pre-submit gate reads. */
  answerUnit?: string;
  choices?: string[];
  /** Optional application frame for a Go deeper item. Scholar-safe hook only:
   *  no source, provenance, narrative, or answer-bearing story fields. */
  storyHook?: string;
  /** Display-only structured prompt visual; never contains a grading answer field. */
  promptVisual?: PracticePromptVisual;
  // Present only for a manipulative item (verifierKind === "manipulative"):
  // the JSON-serialized `ManipulativeSpec` the client renders. See
  // lib/manipulative/practiceContract.ts (the frozen contract) + grade.ts.
  manipulativeSpec?: string;
  // Backward-faded worked example (SPIKE — lib/practice/fadedSteps.ts).
  // Present only for a stored practiceItem that carries `workedSteps`; the
  // server has already computed the fade from the scholar's mastery row, so
  // this shape NEVER contains a faded step's real text — only `revealed`
  // steps' `text` and `faded` steps' `blankText`.
  workedSteps?: FadeResult;
  /** The fade level actually applied (0 = fully revealed, steps.length =
   *  fully bare), for a client that wants to show scaffold progress. */
  scaffoldLevel?: number;
  // Scholar-facing serving lane (P1e, algo-decisions §P1e), stamped by the
  // adaptive serving queries (practiceSkills.ts) from the scheduler reason:
  //   • "review"    — an already-learned skill, kept sharp (the "· review" chip)
  //   • "challenge" — an OPTIONAL above-band stretch, served only in the labeled
  //                   challenge tail, never mixed into the required set
  //   • "stretch"   — an OPTIONAL insight problem on an already-FLUENT node (the
  //                   "Go deeper" tail): deliberate difficulty, misses expected
  //                   and never counted against the mastery row
  //   • "new"       — ordinary frontier work (no chip)
  //   • "mapping"   — a PLACEMENT PROBE served AS a playlist item (Option D,
  //                   OPTION_D_RULINGS): "find your level" measurement, graded
  //                   through the placement path (inferred credit, never
  //                   demonstrated fluency). Reveal-only + the warmth floor; the
  //                   scholar-facing "· mapping" chip. It rides the ordinary
  //                   items array / resume store, never the standalone gate.
  // Absent on items served outside the adaptive path (scoped problem sets served
  // raw, etc.); a missing lane renders as ordinary ("new") work.
  lane?: "review" | "new" | "challenge" | "stretch" | "mapping";
  // 2-D expression editor signals (lib/practice/answerShape.ts), NON-LEAKY:
  //   • answerShape "twoD" — this expression answer is constructible in the
  //     native box editor (fraction/power/root). Absent ⇒ the plain keypad (the
  //     remainder "7 R 1" form, sums, etc.). Routing only, no answer leak.
  //   • answerFormat — the L1 scaffold: an answer skeleton with numbers blanked
  //     to boxes (`F(_/_)`). Gives away the SHAPE, never the digits; `serveItems`
  //     gates it on fluency (kept until access-proven, then dropped for L3).
  answerShape?: "twoD";
  answerFormat?: string;
  // ── Fact automaticity ("Fast math" sprint, FastMath analog) ────────────
  /** Marks this item as a member of a contiguous fact-sprint block — a bare
   *  single-digit fact selected for the scholar's weak facts in a fact family
   *  the run is already exercising. Purely a SEGMENT marker (`kindOf` returns
   *  "fact_sprint" for it, run-length-grouping the block into the "Fast math"
   *  beat); the item otherwise grades through the normal fact-family path, so
   *  its attempt buckets into `factFluency` like any other. Never gates. */
  isFactSprint?: boolean;
  /** The canonical `factKey` (`shared/factKey.ts`) for a direct fact-family
   *  item. Server-side selection aid; harmless if it reaches a client (it's the
   *  same fact the stem already shows). */
  factKey?: string;
};

function factKeyForTemplateItem(
  skillKey: string,
  item: Pick<PracticeItem, "variant">,
): string | undefined {
  if (!isFactFamilySkill(skillKey) || !item.variant) return undefined;
  const { a, op, b } = item.variant;
  return factKeyFromOperands(a, op, b) ?? undefined;
}

/**
 * Map a served/attempted item id to its canonical question identity — the seam
 * that recent-serve dedupe compares against. Two identities match iff the two
 * ids denote the same underlying question:
 *   • a TEMPLATE id (`skillKey#seed[#form]`) is regenerated and keyed by its
 *     RENDERED stem+visual (`itemIdentity`), because two different seeds can
 *     render identical operands — id-only comparison would miss that dupe;
 *   • a stored / manipulative id (`gen#<docId>`) is stable on its own, so the id
 *     IS the identity.
 * Pure + deterministic (same contract as grading).
 */
export function canonicalItemIdentity(itemId: string): string {
  const parsed = parseItemId(itemId);
  if (parsed && hasTemplate(parsed.skillKey)) {
    const item = generateItem(parsed.skillKey, parsed.seed, parsed.form);
    if (item) return itemIdentity(item);
  }
  return itemId;
}

/**
 * PURE serve-time dedupe selector (repeat-question fix §4). Given ordered
 * `candidates` (scheduler priority), the `recentIdentities` this scholar has
 * seen recently, and how many to serve, return `count` candidates preferring
 * UNSEEN ones while preserving the original order within each tier.
 *
 * Invariants:
 *   • order-preserving — unseen candidates keep their relative order, then any
 *     recent candidates keep theirs (a stable "unseen first" partition);
 *   • dedupe is a PREFERENCE, never a starvation gate — the mandatory
 *     exhausted-pool fallback appends recent candidates whenever unseen ones
 *     can't fill `count` (a one-item node, or an all-recent pool, still returns
 *     its item(s));
 *   • empty history is a no-op — `recentIdentities` empty returns exactly the
 *     first `count` candidates, byte-for-byte the pre-dedupe output.
 */
export function preferUnseenCandidates<T extends { itemId: string }>(
  candidates: readonly T[],
  recentIdentities: ReadonlySet<string>,
  count: number,
): T[] {
  if (count <= 0) return [];
  if (recentIdentities.size === 0) return candidates.slice(0, count);
  const unseen: T[] = [];
  const seen: T[] = [];
  for (const c of candidates) {
    if (recentIdentities.has(canonicalItemIdentity(c.itemId))) seen.push(c);
    else unseen.push(c);
  }
  return [...unseen, ...seen].slice(0, count);
}

const SEP = "#";

export function makeItemId(skillKey: string, seed: number, form?: string): string {
  const base = `${skillKey}${SEP}${seed >>> 0}`;
  return form ? `${base}${SEP}${form}` : base;
}

export function parseItemId(
  itemId: string,
): { skillKey: string; seed: number; form?: string } | null {
  // Form-aware parse. Item ids are `skillKey#seed[#form]`; skillKeys are
  // snake_case (never contain '#') and seed is numeric, so a plain split is
  // unambiguous. A gen# stored-item id (`gen#<docId>`) yields a non-numeric
  // seed → null here, so the caller falls through to the stored-item lookup.
  const parts = itemId.split(SEP);
  if (parts.length < 2) return null;
  const skillKey = parts[0];
  const seed = Number(parts[1]);
  if (!skillKey || !Number.isFinite(seed)) return null;
  const form = parts[2] || undefined;
  return { skillKey, seed, form };
}

/**
 * Build a session of `count` items, drawing round-robin over the supplied
 * skills (the scholar's due reviews + frontier, in priority order). Each item
 * gets a distinct deterministic seed derived from the session seed, so the run
 * is reproducible and gradeable without storing answers. Skills without a
 * template are skipped (their items come from the LLM layer later).
 *
 * `formFor(key, seed)` (C1, §6) optionally selects a FORM VARIANT for an item
 * (e.g. "missing" → a missing-operand relational item). It's the caller's
 * proficiency-keyed serving policy; the returned form is passed to generateItem,
 * which falls back to the direct item when the skill has no such variant. The
 * itemId encodes the form actually applied so grading re-derives it.
 *
 * `recentIdentities` (repeat-question fix §4) is this scholar's recently-seen
 * question identities. When non-empty, a SECOND pass replaces any position whose
 * rendered item was seen recently with an unseen alternative for the SAME skill
 * (continuing the deterministic seed draws) — POSITIONAL so the queued skill set
 * and slot count never change (no due/frontier node is dropped). Exhausted-pool
 * fallback keeps the original item when no unseen variant exists. Empty/omitted
 * → identical to the pre-dedupe output.
 */
export function buildSession(
  skills: { key: string; label: string }[],
  count: number,
  sessionSeed: number,
  formFor?: (key: string, seed: number) => string | undefined,
  recentIdentities?: ReadonlySet<string>,
): ServedItem[] {
  const templated = skills.filter((s) => hasTemplate(s.key));
  if (templated.length === 0) return [];
  const rng = makeRng(sessionSeed);
  const out: ServedItem[] = [];
  const usedSeeds = new Set<string>();
  for (let i = 0; out.length < count && i < count * 6; i++) {
    const s = templated[i % templated.length];
    const seed = rng.int(1, 2_000_000_000);
    const key = `${s.key}:${seed}`;
    if (usedSeeds.has(key)) continue;
    usedSeeds.add(key);
    const item = generateItem(s.key, seed, formFor?.(s.key, seed));
    if (!item) continue;
    const factKey = factKeyForTemplateItem(s.key, item);
    out.push({
      itemId: makeItemId(s.key, seed, item.form),
      skillKey: s.key,
      skillLabel: s.label,
      stem: item.stem,
      answerType: item.answerType,
      ...(item.answerUnit ? { answerUnit: formatUnit(item.answerUnit) } : {}),
      choices: item.choices,
      promptVisual: item.promptVisual,
      ...(factKey ? { factKey } : {}),
      ...expressionAnswerSignals(item.answerType, item.answer),
    });
  }

  if (recentIdentities && recentIdentities.size > 0) {
    dedupeAgainstRecent(out, rng, usedSeeds, formFor, recentIdentities);
  }
  return out;
}

// How many extra seeds to draw per position while seeking an unseen template
// variant before falling back to the recently-seen item (bounded work).
const TEMPLATE_ALT_TRIES = 8;

/**
 * In-place positional dedupe (buildSession second pass). For each already-built
 * position whose rendered identity is recent, draw up to TEMPLATE_ALT_TRIES more
 * seeds for the SAME skill and swap in the first UNSEEN alternative (also avoiding
 * identities already present elsewhere in the session). Never changes which skill
 * occupies a slot; leaves the position untouched when no unseen variant is found
 * (exhausted-pool fallback — dedupe never starves the session).
 */
function dedupeAgainstRecent(
  out: ServedItem[],
  rng: ReturnType<typeof makeRng>,
  usedSeeds: Set<string>,
  formFor: ((key: string, seed: number) => string | undefined) | undefined,
  recentIdentities: ReadonlySet<string>,
): void {
  const identityAt = out.map((it) => canonicalItemIdentity(it.itemId));
  for (let p = 0; p < out.length; p++) {
    if (!recentIdentities.has(identityAt[p])) continue;
    const s = { key: out[p].skillKey, label: out[p].skillLabel };
    // Defer against recent history AND the other positions' current identities,
    // so a swap never manufactures a fresh in-session duplicate.
    const avoid = new Set(recentIdentities);
    for (let q = 0; q < out.length; q++) if (q !== p) avoid.add(identityAt[q]);
    const candidates: ServedItem[] = [out[p]];
    for (let tries = 0; tries < TEMPLATE_ALT_TRIES; tries++) {
      const seed = rng.int(1, 2_000_000_000);
      const key = `${s.key}:${seed}`;
      if (usedSeeds.has(key)) continue;
      usedSeeds.add(key);
      const item = generateItem(s.key, seed, formFor?.(s.key, seed));
      if (!item) continue;
      const factKey = factKeyForTemplateItem(s.key, item);
      candidates.push({
        itemId: makeItemId(s.key, seed, item.form),
        skillKey: s.key,
        skillLabel: s.label,
        stem: item.stem,
        answerType: item.answerType,
        ...(item.answerUnit ? { answerUnit: formatUnit(item.answerUnit) } : {}),
        choices: item.choices,
        promptVisual: item.promptVisual,
        ...(factKey ? { factKey } : {}),
        ...expressionAnswerSignals(item.answerType, item.answer),
      });
    }
    const chosen = preferUnseenCandidates(candidates, avoid, 1)[0];
    if (chosen && chosen !== out[p]) {
      out[p] = chosen;
      identityAt[p] = canonicalItemIdentity(chosen.itemId);
    }
  }
}

export type GradeResult = {
  skillKey: string;
  correct: boolean;
  correctAnswer: string;
  /** The rendered stem (re-derived from the item id) — used by the error
   *  classifier on a miss (C3). Present for every template item. */
  stem: string;
};

/**
 * Grade a learner's raw answer against a TEMPLATE item, re-derived from its id.
 * Returns null if the id isn't a template item (caller falls back to a stored
 * item lookup). The correct answer is only returned AFTER grading (fine to show
 * the learner their feedback).
 *
 * Unit-aware, on the same terms as the real dispatcher (`gradeSubmission`): a
 * template that declares an `answerUnit` is answered only by value AND unit, and
 * `correctAnswer` carries the unit ("112 cm³"). Both halves matter — this is the
 * answer ORACLE the curriculum probe and every harness read back and re-submit,
 * so an oracle that returned a bare number would hand the real grader an answer
 * it then rejects. It reports no `unitOutcome`; the "so close" distinction is a
 * scholar-facing nicety and this path has no scholar.
 */
export function gradeTemplateItem(itemId: string, learnerRaw: string): GradeResult | null {
  const parsed = parseItemId(itemId);
  if (!parsed || !hasTemplate(parsed.skillKey)) return null;
  const item = generateItem(parsed.skillKey, parsed.seed, parsed.form);
  if (!item) return null;
  const { answer: learner, unit } = parseAnswerWithUnit(learnerRaw, item.answerType);
  const valueMatches =
    learner !== null &&
    answersEqual(learner, item.answer, {
      requireSimplifiedRadical: parsed.skillKey === "roots_simplify_radicals",
    });
  const correct = valueMatches && (!item.answerUnit || unit === item.answerUnit);
  const display = formatAnswerForDisplay(item.answer, item.choices);
  return {
    skillKey: parsed.skillKey,
    correct,
    correctAnswer: item.answerUnit ? `${display} ${formatUnit(item.answerUnit)}` : display,
    stem: item.stem,
  };
}

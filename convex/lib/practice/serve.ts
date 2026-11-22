/**
 * Unified SESSION SERVING — the orchestration that turns a computed practice
 * queue into the concrete run of items a scholar works.
 *
 * This is the serve-side sibling of `gradeSubmission` (servable.ts): where that
 * unifies grading behind one policy-parameterized dispatcher, this unifies
 * SERVING. `practiceSession` used to interleave the whole pipeline inline (twice
 * — a single-domain body and a near-identical mixed-domain `serveFromQueue`);
 * `serveItems` now owns it once:
 *   • template item build (buildSession) with the form-variant policy,
 *   • the ~1-in-4 stored word-problem swap (VERIFIED LLM items),
 *   • the guaranteed curated-manipulative swap-in for queued skills,
 *   • backward-faded worked-example (scaffold) attach,
 *   • scholar-facing lane stamping (the "· review"/"· challenge" chips),
 *   • W0-a's first-post-placement-block manipulative-first ordering.
 *
 * Parameterized by a `ServePolicy` (the serve-side sibling of `GradePolicy`);
 * `SESSION_POLICY` encodes the exact current `practiceSession` behavior, so the
 * refactor is behavior-preserving. Stored/manipulative items are ServableItem-
 * backed (resolved through servable.ts's `buildStoredServable`) and adapted to
 * the frozen `ServedItem` wire shape, so clients don't change. Placement / chat
 * / reprobe serving are NOT converted here (U-3/U-6) — but the resolver seams
 * (servable.ts builders + the exported helpers) are shaped so a placement policy
 * can reuse them.
 *
 * DB-touching (ctx.db reads of stored items); the pure assembly it performs is
 * deterministic in `seed`.
 */

import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../../_generated/server";
import { buildSession, preferUnseenCandidates, type ServedItem } from "./session";
import {
  buildStoredServable,
  buildTemplateServable,
  type ServableItem,
} from "./servable";
import { isFluent, accessProven } from "./scheduler";
import { PRECEDENCE_FORM_SKILLS } from "./templates";
import {
  expressionAnswerSignals,
  expressionAnswerSignalsFromCanonical,
} from "./answerShape";
import { applyFade, clampFadeLevel, scaffoldLevelFor } from "./fadedSteps";
import { roundRobin } from "./mixedQueue";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../../lib/manipulative/practiceContract";
import { PRACTICE_SESSION_SIZE } from "../../../shared/practiceLoop";
import {
  factKeyFromOperands,
  isFactFamilySkill,
} from "../../../shared/factKey";

// ── Serve policy ───────────────────────────────────────────────────────────

/**
 * Per-surface serving policy — the knobs that decide how a computed queue is
 * turned into served items, so one orchestration serves every session-shaped
 * surface. The serve-side sibling of `GradePolicy` (servable.ts). Fields:
 *   • surface               — a label for the calling surface (diagnostics only).
 *   • size                  — default session size when the caller passes none.
 *   • laneStamping          — stamp the scholar-facing lane chip on each item.
 *   • formPolicy            — form-variant selection for a fluent skill's reviews:
 *                             "fluentRelational" = ~70% relational (missing-operand)
 *                             once GREEN-fluent, else 100% direct; "directOnly" =
 *                             always the direct item.
 *   • manipulativeGuarantee — force each queued skill's curated manipulative into
 *                             the session (the targeted second lookup + swap-in).
 *   • firstBlockOrdering    — W0-a: on the first post-placement calibration block,
 *                             move a manipulative to the front.
 *   • generatedSwapShare    — fraction of slots swapped from template drills to
 *                             VERIFIED stored word problems (≥1 when any exist).
 */
export type ServePolicy = {
  surface: string;
  size: number;
  laneStamping: boolean;
  formPolicy: "fluentRelational" | "directOnly";
  manipulativeGuarantee: boolean;
  firstBlockOrdering: boolean;
  generatedSwapShare: number;
};

/**
 * The drill-session policy — the EXACT current `practiceSession` serving behavior
 * encoded as a policy: default `PRACTICE_SESSION_SIZE` items (the shortened
 * mandatory core — raise-the-ceiling plan §C-3), lane chips on, fluent reviews
 * go relational, every queued skill's manipulative is guaranteed, the first
 * post-placement block leads with a manipulative, and ~1-in-4 slots become
 * stored word problems.
 */
export const SESSION_POLICY: ServePolicy = {
  surface: "session",
  size: PRACTICE_SESSION_SIZE,
  laneStamping: true,
  formPolicy: "fluentRelational",
  manipulativeGuarantee: true,
  firstBlockOrdering: true,
  generatedSwapShare: 1 / 4,
};

// ── Serving helpers (moved verbatim from practiceSkills.ts) ─────────────────

/** Attach the backward-faded worked example (scaffold) to a served item, faded
 *  server-side from the scholar's CURRENT mastery on the skill. A faded step's
 *  real `text` never crosses the wire — only `applyFade`'s revealed/faded shapes.
 *  No-op for an item without stored `workedSteps`. */
export function attachWorkedSteps(
  item: ServedItem,
  doc: Pick<Doc<"practiceItems">, "skillKey" | "workedSteps">,
  mastery: Map<string, Doc<"practiceMastery">>,
  options?: { forceTeaching?: boolean },
): void {
  if (!doc.workedSteps || doc.workedSteps.length === 0) return;
  // A failed skill without later instruction re-enters as a completion problem,
  // even when earlier repetitions would otherwise retire the scaffold.
  const rawLevel = options?.forceTeaching
    ? 1
    : scaffoldLevelFor(mastery.get(doc.skillKey));
  item.workedSteps = applyFade(doc.workedSteps, rawLevel);
  item.scaffoldLevel = clampFadeLevel(rawLevel, doc.workedSteps.length);
}

/** One queued skill's stored (non-manipulative) word-problem variants. */
export type StoredVariantGroup = {
  skillKey: string;
  variants: ServedItem[];
};

/**
 * Spend the limited stored-item replacement budget on skills that templates did
 * not serve first. Each tier remains round-robin by skill, so every skill gets
 * its first variant before any gets a second.
 */
export function orderedStoredVariants(
  groups: StoredVariantGroup[],
  templateItems: ServedItem[],
): ServedItem[] {
  const represented = new Set(templateItems.map((item) => item.skillKey));
  const storedOnly = groups.filter((group) => !represented.has(group.skillKey));
  const alreadyRepresented = groups.filter((group) => represented.has(group.skillKey));
  return [
    ...roundRobin(storedOnly.map((group) => group.variants)),
    ...roundRobin(alreadyRepresented.map((group) => group.variants)),
  ];
}

/**
 * W0-a: on the first post-placement calibration block, lead with a manipulative.
 * Prefer a manipulative whose skill is in the calibration set; else any
 * manipulative. In-place; no-op when the chosen manipulative is already first
 * (or there is none).
 */
export function moveFirstPostPlacementManipulativeFirst(
  items: ServedItem[],
  calibrationSkillKeys: Iterable<string>,
): void {
  const calibration = new Set(calibrationSkillKeys);
  const preferredIndex = items.findIndex(
    (item) =>
      item.answerType === MANIPULATIVE_ANSWER_TYPE &&
      calibration.has(item.skillKey),
  );
  const manipulativeIndex =
    preferredIndex >= 0
      ? preferredIndex
      : items.findIndex((item) => item.answerType === MANIPULATIVE_ANSWER_TYPE);
  if (manipulativeIndex <= 0) return;

  const [manipulative] = items.splice(manipulativeIndex, 1);
  items.unshift(manipulative);
}

// ── ServableItem → ServedItem adapter ──────────────────────────────────────

/**
 * Adapt a resolved `ServableItem` (servable.ts) to the frozen `ServedItem` wire
 * shape a client renders. Carries only render-safe fields — never the verifier /
 * answer. `stampDomain` gates the per-item domain tag (present on a mixed-domain
 * blend, absent on a single-domain session, matching the prior behavior). The
 * serve-time faded `workedSteps` + `scaffoldLevel` are attached separately by
 * `attachWorkedSteps` (the ServablePrompt's `workedSteps` is the stored full
 * form and is deliberately NOT copied here).
 */
export function servedItemFromServable(item: ServableItem, stampDomain: boolean): ServedItem {
  const served: ServedItem = {
    itemId: item.itemId,
    skillKey: item.skillKey,
    skillLabel: item.skillLabel,
    stem: item.prompt.stem,
    answerType: item.prompt.answerType,
    manipulativeSpec: item.prompt.manipulativeSpec,
    promptVisual: item.prompt.promptVisual,
    ...(item.prompt.choices ? { choices: item.prompt.choices } : {}),
    // The required-unit echo (display form). Carried on every serve path so a
    // unit-bearing item renders its unit affordance wherever it's served.
    ...(item.prompt.answerUnit ? { answerUnit: item.prompt.answerUnit } : {}),
    // Algebra-pad palette + required form (template-declared; see
    // `templateInputHints`). A palette item gets no box-editor signals below.
    ...(item.prompt.answerPalette ? { answerPalette: item.prompt.answerPalette } : {}),
    ...(item.prompt.answerForm ? { answerForm: item.prompt.answerForm } : {}),
  };
  if (stampDomain) served.domain = item.domain;
  // 2-D expression-editor signals for a STORED item whose answer is a single
  // fraction (or a buildable expression) — the same non-leaky derivation the
  // template path runs in buildSession, applied here so real fraction word
  // problems (answerType "fraction", canonical e.g. "2/3") also open the box
  // editor instead of the plain keypad. A manipulative verifier has no answer,
  // so it's left untagged (→ plain path, never reached for a manipulative).
  const v = item.verifier;
  if (v.kind === "template") {
    if (!item.prompt.answerPalette) {
      Object.assign(served, expressionAnswerSignals(v.answerType, v.answer));
    }
    if (item.kind === "template" && item.variant && isFactFamilySkill(item.skillKey)) {
      const { a, op, b } = item.variant;
      const factKey = factKeyFromOperands(a, op, b);
      if (factKey) served.factKey = factKey;
    }
  } else if (v.kind === "storedAnswer") {
    Object.assign(
      served,
      expressionAnswerSignalsFromCanonical(v.answerType, v.answerCanonical),
    );
  }
  return served;
}

// ── Resolver: a queued skill's stored variants (ctx-bound) ─────────────────

/** A stored variant lookup, split into ordinary word problems vs. the curated
 *  manipulative(s). `sawManipulative` records whether the primary `.take(2)`
 *  sample already surfaced a manipulative (so the caller can skip the targeted
 *  second lookup). ServableItem-backed + adapted to the wire shape. */
type StoredVariantResolution = {
  generated: ServedItem[];
  manipulatives: ServedItem[];
  sawManipulative: boolean;
};

/**
 * Resolve one queued skill's stored practiceItems into served variants. Samples
 * the first two rows for word-problem variety (a manipulative among them is
 * pulled aside, never dropped by the word-problem coin flip). Shared resolver so
 * a placement policy (U-3) can reuse the same stored→served path. `domain` tags
 * the item; `stampDomain` gates whether that tag reaches the wire.
 */
async function resolveStoredVariantsForSkill(
  ctx: QueryCtx | MutationCtx,
  key: string,
  domain: string,
  labelByKey: Map<string, string>,
  masteryByKey: Map<string, Doc<"practiceMastery">>,
  stampDomain: boolean,
  recentIdentities?: ReadonlySet<string>,
  forceTeaching = false,
  skillHistory?: readonly string[],
): Promise<StoredVariantResolution> {
  const generated: ServedItem[] = [];
  const manipulatives: ServedItem[] = [];
  let sawManipulative = false;

  // With recent-serve dedupe active, fetch a bounded SURPLUS beyond the usual
  // first two so `preferUnseenCandidates` has unseen rows to prefer; with no
  // recent history the fetch stays at two so serving is byte-identical. A
  // review skill with per-skill history fetches the same surplus to rotate.
  const dedupe = recentIdentities !== undefined && recentIdentities.size > 0;
  const rotate = skillHistory !== undefined && skillHistory.length > 0;
  // Core is exactly tier-absent: pool curation normalizes ""/"core" to absent
  // on write. Unknown tiers stay DARK by design; a new tier must be wired into
  // serving explicitly (the stretch tripwire tests guard this fail-closed rule).
  const rows = await ctx.db
    .query("practiceItems")
    .withIndex("by_skill", (qq) => qq.eq("skillKey", key))
    .filter((q) => q.eq(q.field("tier"), undefined))
    .take(dedupe || rotate ? STORED_FETCH_LIMIT : 2);
  for (const g of rows) {
    const servable = buildStoredServable(
      `gen#${g._id}`,
      g,
      { label: labelByKey.get(g.skillKey), domain },
      domain,
    );
    // A counting-family row that lost its dots visual is excluded here rather
    // than served as a bare, unanswerable "How many dots?" stem.
    if (!servable) continue;
    const servedItem = servedItemFromServable(servable, stampDomain);
    attachWorkedSteps(servedItem, g, masteryByKey, { forceTeaching });
    if (g.verifierKind === MANIPULATIVE_VERIFIER_KIND) {
      manipulatives.push(servedItem);
      sawManipulative = true;
    } else {
      generated.push(servedItem);
    }
  }
  // A cold node comes back as a COMPLETION problem, so a stored row that
  // actually carries worked steps is preferred — `attachWorkedSteps` above has
  // already faded it to level 1, so a revealed step means ≥2 stored steps. Only
  // an ORDERING: a skill whose only rows are bare still serves them bare (R3 —
  // serving never withholds a queued node). Manipulatives are untouched: they
  // have no worked-step contract to force.
  //
  // Review rotation happens INSIDE that order: the pool order is the same on
  // every serve, so a review that lands outside the recent-serve window would
  // otherwise re-serve the first row every time — the row just missed included.
  // Within a group, never-seen rows lead and seen rows follow, the one seen
  // longest ago first. Stepped rows stay ahead of bare ones for a cold node, so
  // rotation never trades the teaching away for novelty.
  const order = (group: ServedItem[]) =>
    rotate ? leastRecentlySeenFirst(group, skillHistory) : group;
  const generatedOrdered =
    forceTeaching && generated.length > 1
      ? [
          ...order(generated.filter((it) => (it.workedSteps?.revealed.length ?? 0) > 0)),
          ...order(generated.filter((it) => (it.workedSteps?.revealed.length ?? 0) === 0)),
        ]
      : order(generated);
  const manipulativesOrdered = rotate
    ? leastRecentlySeenFirst(manipulatives, skillHistory)
    : manipulatives;
  if (dedupe) {
    return {
      // Keep the same ≤2 word-problem budget, but prefer unseen rows.
      generated: preferUnseenCandidates(generatedOrdered, recentIdentities, 2),
      // Prefer an unseen manipulative when several exist (order-preserving,
      // never dropped — the guarantee still serves one).
      manipulatives: preferUnseenCandidates(
        manipulativesOrdered,
        recentIdentities,
        manipulativesOrdered.length,
      ),
      sawManipulative,
    };
  }
  if (rotate) {
    return {
      generated: generatedOrdered.slice(0, 2),
      manipulatives: manipulativesOrdered,
      sawManipulative,
    };
  }
  return { generated: generatedOrdered, manipulatives, sawManipulative };
}

/**
 * Order stored candidates for a review: rows absent from `historyNewestFirst`
 * keep their order and lead; rows the scholar has seen follow, least recently
 * seen first. The row seen LAST is left out whenever another exists, so a
 * multi-item budget (two word problems, every manipulative) cannot carry the
 * problem just answered back into the run. A one-row pool still serves its row.
 */
function leastRecentlySeenFirst<T extends { itemId: string }>(
  candidates: readonly T[],
  historyNewestFirst: readonly string[],
): T[] {
  const recency = new Map<string, number>();
  historyNewestFirst.forEach((itemId, index) => {
    if (!recency.has(itemId)) recency.set(itemId, index);
  });
  const neverSeen = candidates.filter((c) => !recency.has(c.itemId));
  const seen = candidates
    .filter((c) => recency.has(c.itemId))
    .sort((a, b) => recency.get(b.itemId)! - recency.get(a.itemId)!);
  const ordered = [...neverSeen, ...seen];
  const latest = historyNewestFirst[0];
  return ordered.length > 1 ? ordered.filter((c) => c.itemId !== latest) : ordered;
}

/** Bounded stored-item surplus fetched (beyond the usual first two) when recent-
 *  serve dedupe is active, so unseen rows can be preferred. */
export const STORED_FETCH_LIMIT = 8;

/** The targeted second lookup behind the manipulative guarantee: a skill's
 *  curated manipulative is rare (1–2 rows) and can be crowded out of the
 *  `.take(2)` word-problem sample, so fetch it explicitly. */
async function resolveGuaranteedManipulative(
  ctx: QueryCtx | MutationCtx,
  key: string,
  domain: string,
  labelByKey: Map<string, string>,
  stampDomain: boolean,
  recentIdentities?: ReadonlySet<string>,
  skillHistory?: readonly string[],
): Promise<ServedItem[]> {
  // Core is exactly tier-absent: pool curation normalizes ""/"core" to absent
  // on write. Unknown tiers stay DARK by design; a new tier must be wired into
  // serving explicitly (the stretch tripwire tests guard this fail-closed rule).
  // `.take(4)`, not `.take(1)`: a row `buildStoredServable` refuses (a RETIRED
  // manipulative kind — unrenderable, so excluded rather than served blank)
  // would otherwise shadow a perfectly good sibling and silently void the
  // guarantee. Prod's `factors_and_multiples` is exactly that shape: two
  // manipulatives, one a dead `factorGame`. With recent history, fetch the
  // same surplus the word-problem sample does so an unseen one can be chosen.
  const dedupe = recentIdentities !== undefined && recentIdentities.size > 0;
  const rotate = skillHistory !== undefined && skillHistory.length > 0;
  const rows = await ctx.db
    .query("practiceItems")
    .withIndex("by_skill", (qq) => qq.eq("skillKey", key))
    .filter((q) =>
      q.and(
        q.eq(q.field("verifierKind"), MANIPULATIVE_VERIFIER_KIND),
        q.eq(q.field("tier"), undefined),
      ),
    )
    .take(dedupe || rotate ? STORED_FETCH_LIMIT : 4);
  const candidates: ServedItem[] = [];
  for (const g of rows) {
    const servable = buildStoredServable(
      `gen#${g._id}`,
      g,
      { label: labelByKey.get(g.skillKey), domain },
      domain,
    );
    if (servable) candidates.push(servedItemFromServable(servable, stampDomain));
  }
  // Still exactly ONE manipulative — the guarantee, not a second item — and
  // an unseen one when this skill has several, so they rotate.
  const ordered = rotate ? leastRecentlySeenFirst(candidates, skillHistory) : candidates;
  return recentIdentities && dedupe
    ? preferUnseenCandidates(ordered, recentIdentities, 1)
    : ordered.slice(0, 1);
}

// ── serveItems ─────────────────────────────────────────────────────────────

/** One queued skill, tagged with the domain it belongs to (the shape both the
 *  single- and mixed-domain callers reduce their queue to; a `DomainQueueEntry`
 *  is structurally assignable). */
export type ServeQueueEntry = { key: string; domain: string };

/** The data + structural inputs to `serveItems` (the behavioral knobs live on
 *  the `ServePolicy`). `stampDomain` distinguishes a domain-tagged mixed blend
 *  from an untagged single-domain session; `laneByKey` supplies the scholar-
 *  facing lane per skill; `firstPostPlacementBlock` + `calibrationSkillKeys`
 *  drive the W0-a ordering. */
export type ServeInput = {
  entries: ServeQueueEntry[];
  labelByKey: Map<string, string>;
  masteryByKey: Map<string, Doc<"practiceMastery">>;
  laneByKey: Map<string, "review" | "new" | "challenge">;
  seed: number;
  size?: number;
  stampDomain: boolean;
  firstPostPlacementBlock: boolean;
  calibrationSkillKeys: Iterable<string>;
  /** Repeat-question fix §4: this scholar's recently-seen question identities
   *  (canonical stem/visual for templates, `gen#id` for stored). When non-empty,
   *  serving prefers UNSEEN template/stored/manipulative candidates (never a
   *  starvation gate). Omitted/empty → serving is byte-identical. */
  recentIdentities?: ReadonlySet<string>;
  /** Nodes whose latest miss/don't-know has had no teaching since
   *  (`practiceSkills.coldFailedSkillKeySet`). Such a node re-enters pinned at
   *  worked-step fade level 1 — a completion problem — wherever the content for
   *  one exists. Never a queue filter: a cold node with no steps serves bare. */
  coldFailedSkillKeys?: ReadonlySet<string>;
  /** Review lane only: per queued review skill, the item ids of this scholar's
   *  latest attempts on it, newest first (`practiceSkills.reviewItemHistory`).
   *  A skill present here rotates its stored items least-recently-seen first,
   *  so a review never repeats the item just seen while the pool has another.
   *  Skills absent (frontier work, omitted map) serve exactly as before. */
  reviewHistoryBySkill?: ReadonlyMap<string, readonly string[]>;
};

/** Apply the one canonical fluency gate for answer-shape scaffolding. */
export function applyAnswerFormatFade(
  items: ServedItem[],
  masteryByKey: Map<string, Doc<"practiceMastery">>,
): ServedItem[] {
  for (const item of items) {
    if (!item.answerFormat) continue;
    const row = masteryByKey.get(item.skillKey);
    if (row && accessProven(row)) delete item.answerFormat;
  }
  return items;
}

/** The form-variant selector for `buildSession`, per the policy: a GREEN-fluent
 *  skill's reviews go ~70% relational (missing-operand), ~30% direct; a skill
 *  still practicing (or only provisionally credited) stays 100% direct.
 *  A `PRECEDENCE_FORM_SKILLS` skill instead takes the "precedence" form on 3 of
 *  every 8 seeds at ANY proficiency (a scholar new to order of operations needs
 *  the left-to-right trap most): with its un-formed draw landing on that shape
 *  one time in five, the scholar meets it 3/8 + 5/8 × 1/5 = 1/2 of the time.
 *  Exported for its test. */
export function formSelector(
  policy: ServePolicy,
  masteryByKey: Map<string, Doc<"practiceMastery">>,
): ((key: string, seed: number) => string | undefined) | undefined {
  if (policy.formPolicy === "directOnly") return undefined;
  return (key, s) => {
    if (PRECEDENCE_FORM_SKILLS.has(key)) return s % 8 < 3 ? "precedence" : undefined;
    const row = masteryByKey.get(key);
    return row && isFluent(row) && s % 10 < 7 ? "missing" : undefined;
  };
}

/**
 * Serve `size` items for an ordered, domain-tagged queue, under `policy`. Builds
 * template items (round-robin over the queued skills, form-variant per policy),
 * mixes in ~`generatedSwapShare` VERIFIED stored word problems, guarantees each
 * queued skill's curated manipulative (when `manipulativeGuarantee`), stamps the
 * scholar-facing lane (when `laneStamping`), and applies W0-a first-block
 * ordering (when `firstBlockOrdering`). Deterministic in `seed`. `labelByKey` /
 * `masteryByKey` are keyed by skillKey (unique across the seeded domains, as
 * `submitAnswer`'s by_nodeKey resolution already assumes).
 */
export async function serveItems(
  ctx: QueryCtx | MutationCtx,
  input: ServeInput,
  policy: ServePolicy,
): Promise<ServedItem[]> {
  const { entries, labelByKey, masteryByKey, laneByKey, seed, stampDomain } = input;
  const size = input.size ?? policy.size;
  const recentIdentities = input.recentIdentities;
  // Cold = missed with no teaching since (practiceSkills.coldFailedSkillKeySet).
  // Such a node re-enters as a level-one worked-step COMPLETION wherever the
  // content for one exists — never a withholding gate: a cold node with no
  // usable steps is served exactly as it is today, bare (R3).
  const instructionalCold = input.coldFailedSkillKeys ?? new Set<string>();

  // First-seen domain per key (for template item domain stamping).
  const domainOfKey = new Map<string, string>();
  for (const e of entries) if (!domainOfKey.has(e.key)) domainOfKey.set(e.key, e.domain);

  const items = buildSession(
    entries.map((e) => ({ key: e.key, label: labelByKey.get(e.key) ?? e.key })),
    size,
    seed >>> 0,
    formSelector(policy, masteryByKey),
    recentIdentities,
  );
  if (stampDomain) for (const it of items) it.domain = domainOfKey.get(it.skillKey) ?? it.domain;

  // Stored word problems + curated manipulatives per queued skill.
  const generatedBySkill: StoredVariantGroup[] = [];
  const manipulatives: ServedItem[] = [];
  for (const e of entries) {
    const resolved = await resolveStoredVariantsForSkill(
      ctx,
      e.key,
      e.domain,
      labelByKey,
      masteryByKey,
      stampDomain,
      recentIdentities,
      instructionalCold.has(e.key),
      input.reviewHistoryBySkill?.get(e.key),
    );
    generatedBySkill.push({ skillKey: e.key, variants: resolved.generated });
    manipulatives.push(...resolved.manipulatives);
    if (policy.manipulativeGuarantee && !resolved.sawManipulative) {
      manipulatives.push(
        ...(await resolveGuaranteedManipulative(
          ctx,
          e.key,
          e.domain,
          labelByKey,
          stampDomain,
          recentIdentities,
          input.reviewHistoryBySkill?.get(e.key),
        )),
      );
    }
  }

  // Give each queued skill its first stored variant before any skill gets a
  // second. Otherwise a small replacement budget can be exhausted by one
  // stored-only skill and strand a later domain whose template lane is empty.
  const generated = orderedStoredVariants(generatedBySkill, items);

  let served = items;
  if (items.length === 0) {
    served = [...generated, ...manipulatives].slice(0, size);
  } else if (generated.length > 0) {
    const replaceCount = Math.min(
      generated.length,
      Math.max(1, Math.floor(size * policy.generatedSwapShare)),
    );
    for (let i = 0; i < replaceCount; i++) {
      const pos = (i * 3 + 1) % items.length;
      items[pos] = generated[i];
    }
  }

  // Guarantee: every queued skill's manipulative item is served — swap it into
  // that skill's own slot when there is one, else append (space permitting). A
  // skill with no other slot in this session is skipped (rare).
  //
  // ONE manipulative per skill: the FIRST in the resolved order, which is the
  // unseen-first order when recent history exists. (Until 2026-11 every one
  // was written into the same slot in turn, so the LAST won — with history
  // that is a recently SEEN one, and a skill with several manipulatives
  // served the same board every session.)
  if (policy.manipulativeGuarantee) {
    const placedFor = new Set<string>();
    for (const m of manipulatives) {
      if (placedFor.has(m.skillKey)) continue;
      placedFor.add(m.skillKey);
      if (served.some((it) => it.itemId === m.itemId)) continue;
      const pos = served.findIndex((it) => it.skillKey === m.skillKey);
      if (pos >= 0) served[pos] = m;
      else if (served.length < size) served.push(m);
    }
  }

  // Template serving normally omits worked steps; a cold node's template item
  // gets them back through the same attach/applyFade path stored items use, so
  // it re-enters as a level-one completion. Stored (`gen#`) items were already
  // faded at resolve time. Unconditional — a cold node is cold whatever the
  // policy's manipulative guarantee does — and purely additive: a family with no
  // (or a single) deterministic step is left exactly as served.
  if (instructionalCold.size > 0) {
    for (const item of served) {
      if (!instructionalCold.has(item.skillKey) || item.itemId.startsWith("gen#")) continue;
      const domain = domainOfKey.get(item.skillKey);
      const template = buildTemplateServable(
        item.itemId,
        { label: item.skillLabel, domain },
        domain ?? "",
      );
      const workedSteps = template?.prompt.workedSteps;
      if (!workedSteps || workedSteps.length < 2) continue;
      attachWorkedSteps(item, { skillKey: item.skillKey, workedSteps }, masteryByKey, {
        forceTeaching: true,
      });
    }
  }

  // Stamp the scholar-facing lane (P1e) so the UI can show a "· review" chip on
  // already-learned skills. Missing → "new" (no chip).
  if (policy.laneStamping) {
    for (const it of served) it.lane = laneByKey.get(it.skillKey) ?? "new";
  }

  if (policy.firstBlockOrdering && input.firstPostPlacementBlock) {
    moveFirstPostPlacementManipulativeFirst(served, input.calibrationSkillKeys);
  }

  // L1→L3 scaffold fade for the 2-D expression editor. `answerFormat` (the
  // answer-shape skeleton) is "format given" scaffolding — keep it while the
  // skill isn't yet access-proven, drop it once the scholar has demonstrated
  // fluency so they reconstruct the shape unaided. Same fluency signal the
  // worked-example fade uses (fadedSteps.scaffoldLevelFor → accessProven).
  return applyAnswerFormatFade(served, masteryByKey);
}

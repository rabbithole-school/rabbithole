/**
 * The scholar's ONE ranked queue of open items (Quests tab + Scholar's Prep
 * "Keep going"). Andy's rule: nothing is "on a list" unless it is homework
 * (teacher-owned, dated), a backlog item (here, undated), or a close-out. This
 * is the backlog.
 *
 * Every open item is either a QUESTION (a story thread or cross-domain seed
 * that carries a `CardQuestion`) or a teacher-suggested quest. Ranked:
 *
 *   (a) "missed"   — a question the scholar answered WRONG and hasn't followed,
 *                    newest answer first;
 *   (b) "offered"  — a moment carded (done screen or here) but never answered,
 *                    newest offer first;
 *   (c) "new"      — an active story / cross-domain seed with a question that
 *                    was never carded at all, newest seed first;
 *   (d) "teacher"  — "Suggested by your teacher" quests
 *                    (`suggestedQuestsForScholar`, its own order).
 *
 * Excluded: a seed that is not active, already followed (a session carries its
 * seedId), or whose newest ledger event is terminal (tried/saved/dismissed); a
 * question answered CORRECTLY (it closed itself — the reveal already landed);
 * a question that is LIVE homework for this scholar (`lib/questionHomework` —
 * `assignments.assignQuestionAsHomework`; it is on the Due list instead, and
 * returns here if that homework is archived or the scholar is removed from it).
 *
 * Two readers, ONE evaluation: the whole queue (`questionQueueForScholar`, the
 * scholar's own Quests / Prep) and the teacher Prep's single best row
 * (`bestNextQuestionForScholar`, inside a subscribed whole-roster query, so
 * bounded and indexed). Both use `questionSeedShape` → `questionItemState` →
 * `liveQuestionHomework` → `questionRowFromState` and the same ranker, so they
 * agree on the top question.
 *
 * The eligibility here is the SAME as `standingStoryInvitationsForScholar`
 * (active seed, not started, latest event non-terminal) extended to items with
 * no ledger row, and the question lookups are the same ones the done-screen
 * card and `recordMomentAnswer` use, so an answer recorded from a row grades
 * against exactly the question the row showed.
 *
 * The caller owns auth. Scholar-facing fields only: graph keys, the edge's
 * scholar-safe story hook, registry card copy, and the scholar's own answers —
 * never provenance or teacher-only seed fields (`rationale` reaches a teacher
 * row only as the existing scholar-invitation fallback `suggestedQuests` uses).
 */

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { CardQuestion } from "../../shared/questionCard";
import { isValidCardQuestion } from "../../shared/questionCard";
import { storyCardQuestion } from "./practice/storyCardQuestions";
import { seedCardQuestion } from "./practice/seedCardQuestions";
import { seedCardCopy } from "./practice/crossDomainSeeds";
import { isTerminalStoryMomentOutcome } from "./moments/storyMomentPolicy";
import { suggestedQuestsForScholar } from "./scholarReads";
import { ACTIVE_SEED_READ_LIMIT, recentSeedsForScholarByStatus } from "./seeds";
import { liveQuestionHomework } from "./questionHomework";

export type QuestionQueueSource = "missed" | "offered" | "new" | "teacher";

export type QuestionQueueAnswer = {
  choiceIndex: number;
  correct: boolean;
  answeredAt: number;
};

/** How a client mints the ledger row for an item that has none yet
 *  (`practiceMoments.recordMomentOffered` with `surface: "quests"`). */
export type QuestionQueueMomentRef =
  | { kind: "story"; fromKey: string; toKey: string }
  | { kind: "seed"; seedId: Id<"seeds"> };

export type QuestionQueueQuestionRow = {
  kind: "question";
  /** Stable row key: `question:<seedId>`. */
  id: string;
  seedId: Id<"seeds">;
  /** Which moment family the question rides. */
  origin: "story" | "seed";
  source: "missed" | "offered" | "new";
  emoji: string;
  /** Small line above the question ("Unlocked by …" / the seed card title). */
  meta: string;
  /** The item's headline (story hook / seed card title) — a11y + fallbacks. */
  title: string;
  question: CardQuestion;
  /** Newest non-terminal ledger row, or null when the item was never carded. */
  eventId: Id<"momentEvents"> | null;
  /** Newest recorded answer for this item, if any. */
  answer: QuestionQueueAnswer | null;
  moment: QuestionQueueMomentRef;
  /** The ranking timestamp within its source bucket. */
  sortAt: number;
};

export type QuestionQueueTeacherRow = {
  kind: "teacherQuest";
  /** Stable row key: `teacher:<seedId>`. */
  id: string;
  seedId: Id<"seeds">;
  unitId: Id<"units">;
  origin: "teacher";
  source: "teacher";
  emoji: string;
  /** "Ms. Rivera · Guided path · 4 activities". */
  meta: string;
  title: string;
  /** Scholar-facing invitation (unit blurb, else the seed's invitation). */
  body: string | null;
  teacherName: string;
  question: null;
  eventId: null;
  answer: null;
  sortAt: number;
};

export type QuestionQueueRow = QuestionQueueQuestionRow | QuestionQueueTeacherRow;

const SOURCE_ORDER: Record<QuestionQueueSource, number> = {
  missed: 0,
  offered: 1,
  new: 2,
  teacher: 3,
};

/** Pure ranking: bucket order (a)→(d), newest first within a bucket. Stable for
 *  ties so the teacher rows keep `suggestedQuestsForScholar`'s order. */
export function rankQuestionQueue<
  T extends { source: QuestionQueueSource; sortAt: number },
>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        SOURCE_ORDER[a.row.source] - SOURCE_ORDER[b.row.source] ||
        b.row.sortAt - a.row.sortAt ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/** Which bucket a question item falls in, from its ledger state. `null` =
 *  not open (settled, or answered correctly). Pure; exported for tests. */
export function questionQueueSource(
  latest: Pick<Doc<"momentEvents">, "outcome"> | undefined,
  answer: Pick<QuestionQueueAnswer, "correct"> | null,
): "missed" | "offered" | "new" | null {
  if (latest && isTerminalStoryMomentOutcome(latest.outcome)) return null;
  if (answer) return answer.correct ? null : "missed";
  return latest ? "offered" : "new";
}

function newestFirst(a: Doc<"momentEvents">, b: Doc<"momentEvents">) {
  return b.offeredAt - a.offeredAt || b._creationTime - a._creationTime;
}

/** What makes a seed a question item at all. Pure. */
export type QuestionSeedShape = {
  isStory: boolean;
  question: CardQuestion;
  /** The ledger identity: `edge:<from>\0<to>` (story) or `seed:<id>`. */
  ledgerKey: string;
};

/** A seed's question shape, or null when it is not a question item (not a
 *  story souvenir / cross-domain seed, or no valid card question). Pure. */
export function questionSeedShape(
  seed: Pick<
    Doc<"seeds">,
    "_id" | "origin" | "storyFromKey" | "storyToKey" | "suggestionType" | "topic"
  >,
): QuestionSeedShape | null {
  const isStory = seed.origin === "story" && !!seed.storyFromKey && !!seed.storyToKey;
  const isCrossDomain = !isStory && seed.suggestionType === "cross_domain";
  if (!isStory && !isCrossDomain) return null;
  const question = isStory
    ? storyCardQuestion(seed.storyFromKey!, seed.storyToKey!)
    : seedCardQuestion(seed.topic);
  if (!isValidCardQuestion(question)) return null;
  return {
    isStory,
    question,
    ledgerKey: isStory
      ? `edge:${seed.storyFromKey}\u0000${seed.storyToKey}`
      : `seed:${seed._id}`,
  };
}

/** One question item's ledger state. */
export type QuestionItemState = {
  source: "missed" | "offered" | "new";
  latest: Doc<"momentEvents"> | undefined;
  answer: QuestionQueueAnswer | null;
  sortAt: number;
};

/** The item's bucket + ranking timestamp from its ledger rows (any order), or
 *  null when it is not open. Pure. */
export function questionItemState(
  seed: Pick<Doc<"seeds">, "_creationTime">,
  itemEvents: readonly Doc<"momentEvents">[],
): QuestionItemState | null {
  const sorted = [...itemEvents].sort(newestFirst);
  const latest = sorted[0];
  const answered = sorted
    .filter((e) => e.answerIndex !== undefined && e.answerCorrect !== undefined)
    .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))[0];
  const answer: QuestionQueueAnswer | null = answered
    ? {
        choiceIndex: answered.answerIndex!,
        correct: answered.answerCorrect!,
        answeredAt: answered.answeredAt ?? answered.offeredAt,
      }
    : null;
  const source = questionQueueSource(latest, answer);
  if (!source) return null;
  return {
    source,
    latest,
    answer,
    sortAt:
      source === "missed"
        ? answer!.answeredAt
        : source === "offered"
          ? latest!.offeredAt
          : seed._creationTime,
  };
}

/** Story souvenirs and cross-domain seeds that could be question items, one
 *  per story edge (the first — newest — seed wins). Pure; order preserved. */
function questionCandidates(
  activeSeeds: readonly Doc<"seeds">[],
): { seed: Doc<"seeds">; shape: QuestionSeedShape }[] {
  const out: { seed: Doc<"seeds">; shape: QuestionSeedShape }[] = [];
  const seenEdges = new Set<string>();
  for (const seed of activeSeeds) {
    const shape = questionSeedShape(seed);
    if (!shape) continue;
    if (shape.isStory) {
      if (seenEdges.has(shape.ledgerKey)) continue;
      seenEdges.add(shape.ledgerKey);
    }
    out.push({ seed, shape });
  }
  return out;
}

/** The scholar's active seeds, newest first, through the SAME bounded read the
 *  seed list / sky use (`ACTIVE_SEED_READ_LIMIT`). */
function activeSeedsForQueue(ctx: QueryCtx | MutationCtx, scholarId: Id<"users">) {
  return recentSeedsForScholarByStatus(
    ctx,
    scholarId,
    ["active"],
    ACTIVE_SEED_READ_LIMIT,
  );
}

/** Indexed: this item's ledger rows only. */
async function ledgerEventsForItem(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  seed: Doc<"seeds">,
  shape: QuestionSeedShape,
): Promise<Doc<"momentEvents">[]> {
  if (shape.isStory) {
    return (
      await ctx.db
        .query("momentEvents")
        .withIndex("by_scholar_edge", (q) =>
          q
            .eq("scholarId", scholarId)
            .eq("fromKey", seed.storyFromKey)
            .eq("toKey", seed.storyToKey),
        )
        .collect()
    ).filter((event) => event.kind === "story");
  }
  return (
    await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar_seed", (q) =>
        q.eq("scholarId", scholarId).eq("seedId", seed._id),
      )
      .collect()
  ).filter((event) => event.kind === "seed");
}

/** Indexed: has the scholar followed this seed into a session? */
async function seedStarted(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  seedId: Id<"seeds">,
): Promise<boolean> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_user_seed", (q) => q.eq("userId", scholarId).eq("seedId", seedId))
    .first();
  return session !== null;
}

/** Build the row for an open item: drops it when it is live homework or (a
 *  story) its edge lost its story since the star was minted. */
async function questionRowFromState(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  seed: Doc<"seeds">,
  shape: QuestionSeedShape,
  state: QuestionItemState,
): Promise<QuestionQueueQuestionRow | null> {
  // A teacher assigned this question as homework (Scholar's Prep "Assign…"):
  // while that homework is live it is under Due, dated, so it is not also
  // backlog.
  if (await liveQuestionHomework(ctx, scholarId, seed._id)) return null;

  let emoji: string;
  let meta: string;
  let title: string;
  let moment: QuestionQueueMomentRef;
  if (shape.isStory) {
    const fromKey = seed.storyFromKey!;
    const toKey = seed.storyToKey!;
    const story = (
      await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from_to", (q) => q.eq("fromKey", fromKey).eq("toKey", toKey))
        .collect()
    ).find((edge) => edge.story !== undefined)?.story;
    // A curator removed the story since the star was minted: nothing honest
    // to ask (the souvenir stays in the Sky).
    if (!story) return null;
    emoji = story.visualEmoji ?? "✨";
    // `connectionTo` is where plantStorySeed records the unlocking skill.
    meta = `Unlocked by ${seed.connectionTo ?? fromKey}`;
    title = story.hook;
    moment = { kind: "story", fromKey, toKey };
  } else {
    const card = seedCardCopy(seed);
    emoji = card.visualEmoji ?? "✨";
    meta = card.title;
    title = card.title;
    moment = { kind: "seed", seedId: seed._id };
  }

  const { latest } = state;
  return {
    kind: "question",
    id: `question:${seed._id}`,
    seedId: seed._id,
    origin: shape.isStory ? "story" : "seed",
    source: state.source,
    emoji,
    meta,
    title,
    question: shape.question,
    eventId: latest && !isTerminalStoryMomentOutcome(latest.outcome) ? latest._id : null,
    answer: state.answer,
    moment,
    sortAt: state.sortAt,
  };
}

/**
 * ONE seed's question row, or null when it is not an open question for this
 * scholar (not theirs / not active / not a question / started / settled /
 * answered correctly / live homework). Indexed reads only — the
 * `assignQuestionAsHomework` "is it open?" check.
 */
export async function questionRowForSeed(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  seed: Doc<"seeds">,
): Promise<QuestionQueueQuestionRow | null> {
  if (seed.scholarId !== scholarId || seed.status !== "active") return null;
  const shape = questionSeedShape(seed);
  if (!shape) return null;
  if (await seedStarted(ctx, scholarId, seed._id)) return null;
  const state = questionItemState(
    seed,
    await ledgerEventsForItem(ctx, scholarId, seed, shape),
  );
  if (!state) return null;
  return await questionRowFromState(ctx, scholarId, seed, shape, state);
}

/**
 * The teacher Prep's "best next" question: the TOP question row
 * `questionQueueForScholar` would rank first, read bounded — the active seeds
 * through the limited helper, the ledger only for candidate seeds (indexed per
 * item), then the per-row checks (started / homework / story) walked in rank
 * order, stopping at the first qualifying row. It runs once per scholar inside
 * a subscribed whole-roster query, so it never reads all of a scholar's
 * sessions or ledger.
 */
export async function bestNextQuestionForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<QuestionQueueQuestionRow | null> {
  const candidates = questionCandidates(await activeSeedsForQueue(ctx, scholarId));
  const open = (
    await Promise.all(
      candidates.map(async ({ seed, shape }) => {
        const state = questionItemState(
          seed,
          await ledgerEventsForItem(ctx, scholarId, seed, shape),
        );
        return state ? { seed, shape, state, source: state.source, sortAt: state.sortAt } : null;
      }),
    )
  ).filter((entry) => entry !== null);
  for (const { seed, shape, state } of rankQuestionQueue(open)) {
    if (await seedStarted(ctx, scholarId, seed._id)) continue;
    const row = await questionRowFromState(ctx, scholarId, seed, shape, state);
    if (row) return row;
  }
  return null;
}

/**
 * The ranked queue for one scholar. Auth is the caller's.
 */
export async function questionQueueForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<QuestionQueueRow[]> {
  const [activeSeeds, sessions, events, teacherQuests] = await Promise.all([
    activeSeedsForQueue(ctx, scholarId),
    ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholarId))
      .collect(),
    ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    suggestedQuestsForScholar(ctx, scholarId),
  ]);
  const startedSeedIds = new Set(
    sessions.flatMap((session) => (session.seedId ? [String(session.seedId)] : [])),
  );

  // One pass over the ledger: every event per story edge / per seed.
  const eventsByKey = new Map<string, Doc<"momentEvents">[]>();
  for (const event of events) {
    const key =
      event.kind === "story"
        ? `edge:${event.fromKey}\u0000${event.toKey}`
        : event.seedId
          ? `seed:${event.seedId}`
          : null;
    if (!key) continue;
    const list = eventsByKey.get(key);
    if (list) list.push(event);
    else eventsByKey.set(key, [event]);
  }

  const rows: QuestionQueueRow[] = [];
  for (const { seed, shape } of questionCandidates(activeSeeds)) {
    if (startedSeedIds.has(String(seed._id))) continue;
    const state = questionItemState(seed, eventsByKey.get(shape.ledgerKey) ?? []);
    if (!state) continue;
    const row = await questionRowFromState(ctx, scholarId, seed, shape, state);
    if (row) rows.push(row);
  }

  // (d) Teacher suggestions keep their own order (newest offer first); a
  // descending sortAt by position preserves it through the stable ranker.
  teacherQuests.forEach((quest, index) => {
    const pathMeta =
      quest.activityCount > 0
        ? `Guided path · ${quest.activityCount} ${quest.activityCount === 1 ? "activity" : "activities"}`
        : "Guided path";
    rows.push({
      kind: "teacherQuest",
      id: `teacher:${quest.seedId}`,
      seedId: quest.seedId,
      unitId: quest.unitId,
      origin: "teacher",
      source: "teacher",
      emoji: quest.emoji,
      meta: `${quest.teacherName} · ${pathMeta}`,
      title: quest.title,
      body: quest.description || quest.rationale || null,
      teacherName: quest.teacherName,
      question: null,
      eventId: null,
      answer: null,
      sortAt: teacherQuests.length - index,
    });
  });

  return rankQuestionQueue(rows);
}

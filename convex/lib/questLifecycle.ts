// The ONE canonical derivation of a scholar quest's lifecycle state.
//
// A "quest" is a per-scholar lifecycle over a UNIT, OUTSIDE any assignment.
// Its identity is the pair (scholarId, unitId). This module is the single
// source of truth for "what state is this scholar's quest in?", so every
// surface that today re-derives "quest" from a different table — the iPad Home
// plate quest lane (scholarPlate `origin: "is"` rows), the /teacher/quests
// board (units.listScholarAuthored), the scholar Work-tab card, the teacher
// home-mirror — can LATER read this one derivation instead. This phase only
// ADDS the helper; nothing is repointed yet. See
// review/quest-lifecycle-unification.html (§3 Identity, §4 the four-state
// lifecycle table).
//
// Key exports:
//   - deriveQuestState(facts): a PURE function — the whole lifecycle rule set,
//     computed from facts that already exist (seeds, sessions, badges,
//     units.isActive). No `ctx`; exhaustively unit-testable.
//   - questsForScholar(ctx, scholarId): the async collector that gathers those
//     facts for every one of a scholar's quests and runs deriveQuestState per
//     unit. It ports units.listScholarAuthored's lane logic (offered /
//     inProgress / badged) rather than paralleling it, and mirrors
//     scholarPlate's completion-skip when deciding whether a session is "live".
//   - isQuestUnitForScholar(ctx, scholarId, unitId): the cheap classification
//     used when copy must distinguish a Quest from assigned classwork.

import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  isSessionActivityComplete,
  questOnlineProgressForScholar,
} from "./scholarReads";
import { isStructurallyDraft } from "./unitMaturity";
import { granuleTexts } from "./granules";

type UnitSession = Doc<"sessions"> & { unitId: Id<"units"> };

function isPlateEligibleSession(
  session: Doc<"sessions">,
): session is UnitSession {
  return (
    !session.isArchived &&
    !session.isTestDrive &&
    !session.isOffline &&
    session.unitId != null
  );
}

function isCatalogQuestStartSession(
  session: Doc<"sessions">,
): session is UnitSession {
  return isPlateEligibleSession(session) && session.assignmentId == null;
}

/**
 * Whether this unit is a Quest for this scholar, rather than assigned classwork.
 * Quest identity comes from scholar authorship, any seed provenance, or an
 * independently started catalog session.
 */
export async function isQuestUnitForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
): Promise<boolean> {
  const unit = await ctx.db.get(unitId);
  if (!unit) return false;
  if (unit.authorScholarId === scholarId) return true;

  const [seeds, sessions] = await Promise.all([
    ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
      .collect(),
    ctx.db
      .query("sessions")
      .withIndex("by_user_unit", (q) =>
        q.eq("userId", scholarId).eq("unitId", unitId),
      )
      .collect(),
  ]);

  return (
    seeds.some((seed) => seed.unitId === unitId) ||
    sessions.some(isCatalogQuestStartSession)
  );
}

/**
 * The canonical quest lifecycle. §4 of the design doc:
 *   offered   → an un-launched, non-terminal seed offer points at the unit.
 *   active    → a live (plate-visible) session on the pair.
 *   finished  → the unit's completion badge is earned, or all activities done.
 *   retracted → the (scholar-owned) unit is deactivated; gone from every read.
 *   dormant   → the unit exists but has NO offer, NO session, NO completion —
 *               not a quest-on-the-plate, just a bare unit. (Added to the union
 *               so the "no offer and no session" case is representable rather
 *               than mislabelled "offered".)
 */
export type QuestState =
  | "offered"
  | "active"
  | "finished"
  | "retracted"
  | "dormant";

/** The minimal set of facts (all already stored elsewhere) the state derives from. */
export interface QuestFacts {
  /** units.isActive — a deactivated scholar-owned unit is a retracted quest. */
  unitIsActive: boolean;
  /**
   * ≥1 non-archived, non-test-drive, non-offline session on the pair that is
   * still plate-visible (see the completion-skip in questsForScholar). A
   * session whose current activity is complete but whose unit has more work
   * still counts as live.
   */
  hasLiveSession: boolean;
  /** A scholarUnitBadges row exists for (scholar, unit). */
  badgeEarned: boolean;
  /** A pending/active seed points at the unit for this scholar (an open offer). */
  hasNonTerminalSeedOffer: boolean;
  /** The unit has ≥1 online activity and every one is complete for the scholar. */
  allActivitiesComplete: boolean;
}

export interface DerivedQuestState {
  state: QuestState;
}

export const QUEST_STALLED_MS = 5 * 24 * 60 * 60_000;

export function isStalledQuest(
  quest: Pick<ScholarQuest, "state" | "lastTouched">,
  now: number,
): boolean {
  return (
    quest.state === "active" &&
    quest.lastTouched != null &&
    now - quest.lastTouched > QUEST_STALLED_MS
  );
}

/**
 * The whole lifecycle rule set as a pure function. Precedence matters:
 *
 *   retracted (dominates everything — a deactivated unit is gone regardless of
 *     any lingering session / badge / offer)
 *   > finished (badge earned OR all activities complete)
 *   > active (a live session)
 *   > offered (an open seed offer, no session yet)
 *   > dormant (a bare unit with none of the above)
 */
export function deriveQuestState(facts: QuestFacts): DerivedQuestState {
  if (!facts.unitIsActive) return { state: "retracted" };
  if (facts.badgeEarned || facts.allActivitiesComplete) {
    return { state: "finished" };
  }
  if (facts.hasLiveSession) return { state: "active" };
  if (facts.hasNonTerminalSeedOffer) return { state: "offered" };
  return { state: "dormant" };
}

/**
 * A back-compat lane for the /teacher/quests board, kept byte-for-byte
 * identical to units.listScholarAuthored's lane derivation:
 *   badged (a badge exists) → inProgress (any raw session) → offered (else).
 *
 * NOTE: `lane` intentionally reads RAW session presence, NOT the
 * completion-skipped `hasLiveSession`, so it reproduces listScholarAuthored
 * exactly. This means `state` can legitimately diverge from `lane` — e.g. a
 * unit whose activities are all complete but which has no configured badge is
 * `state: "finished"` yet `lane: "inProgress"` (the board's old view). The
 * board keeps the lane until a later phase repoints it at `state`.
 */
export type QuestLane = "offered" | "inProgress" | "badged";

function deriveLane(badgeEarned: boolean, hasRawSession: boolean): QuestLane {
  return badgeEarned ? "badged" : hasRawSession ? "inProgress" : "offered";
}

export interface ScholarQuest {
  unitId: Id<"units">;
  title: string;
  emoji: string | null;
  description: string | null;
  state: QuestState;
  /** teacher = born from a teacher/aide offer (an open or once-open seed); scholar = self-authored. */
  source: "teacher" | "scholar";
  /** Back-compat board lane (see deriveLane). */
  lane: QuestLane;
  unitIsActive: boolean;
  /** Structural Draft check (buildCompletenessCriteria — NOT getNodeStatuses). */
  unitIsDraft: boolean;
  onlineActivityCount: number;
  completedCount: number;
  badgeEarned: boolean;
  hasLiveSession: boolean;
  /** Max session touch (lastMessageAt ?? _creationTime), or null when no session. */
  lastTouched: number | null;
  /**
   * `_creationTime` of the non-terminal (pending/active) seed offer pointing at
   * this unit, else null. Feeds the board's stale-offer detection and
   * Offered-lane sorting. Null whenever there is no open offer (including a
   * scholar-authored unit and a unit whose offer went terminal).
   */
  offeredAt: number | null;
}

/**
 * Collect ALL of a scholar's quests — one per unit — with each quest's
 * canonical `state` (via deriveQuestState) plus the fields the current
 * board/plate render. Reads only facts that already exist:
 *
 *   - units by_authorScholar (incl. inactive → retracted is representable)
 *     UNION the CATALOG free-starts: teacher-authored catalog units the scholar
 *     has independently started (a non-archived / non-test-drive / non-offline,
 *     assignment-LESS session points at them). Per the design doc's identity
 *     section these self-chosen pairs ARE quests too, even though the scholar
 *     doesn't author the unit — so the plate's IS lane can be gated on this one
 *     derivation without dropping catalog free-starts.
 *   - the scholar's non-archived / non-test-drive / non-offline sessions
 *     (mirrors listScholarAuthored's `sess` filter for the raw lane, and adds
 *     scholarPlate's completion-skip for the live check)
 *   - scholarUnitBadges by_scholar → badgeEarned
 *   - seeds by_scholar_status (pending/active) pointing at the unit → the offer
 *     (its creation time surfaces as `offeredAt`)
 *   - questOnlineProgressForScholar → assignment-blind online activity counts +
 *     "next incomplete", reading the same completion ledger as the unit badge
 *     (no assignmentId filter); the finish THRESHOLD still differs (choice-aware,
 *     archived-dropping), so a unit can finish here without minting a badge
 *
 * Sorted by lastTouched desc (ties fall back to unit creation time), so the
 * freshest quest is first.
 */
export async function questsForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<ScholarQuest[]> {
  const authoredUnits = await ctx.db
    .query("units")
    .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
    .collect();
  const authoredUnitIds = new Set(authoredUnits.map((u) => String(u._id)));

  // Preload the scholar's plate-eligible sessions once, grouped by unit — the
  // same filter listScholarAuthored uses (raw presence, no completion-skip).
  const allSessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  const sessionsByUnit = new Map<string, Doc<"sessions">[]>();
  for (const s of allSessions) {
    if (!isPlateEligibleSession(s)) continue;
    const k = String(s.unitId);
    const list = sessionsByUnit.get(k);
    if (list) list.push(s);
    else sessionsByUnit.set(k, [s]);
  }

  // CATALOG free-starts (design §Identity): a unit the scholar does NOT author
  // but has independently started — an assignment-less eligible session points
  // at it. `by_authorScholar` alone misses these, so a free-start of a
  // teacher-authored catalog unit would never reach the helper (and the plate's
  // IS lane, once gated on this derivation, would silently drop it). Widen the
  // unit set with them. These are self-chosen, so `source` is always "scholar".
  const catalogUnitIds = new Set<string>();
  for (const s of allSessions) {
    if (!isCatalogQuestStartSession(s)) continue;
    const k = String(s.unitId);
    if (!authoredUnitIds.has(k)) catalogUnitIds.add(k);
  }
  const catalogUnits: Doc<"units">[] = [];
  for (const k of catalogUnitIds) {
    const u = await ctx.db.get(k as Id<"units">);
    if (u) catalogUnits.push(u);
  }

  const units = [...authoredUnits, ...catalogUnits];
  if (units.length === 0) return [];

  // Badges → which units are badged for this scholar.
  const badges = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const badgedUnitIds = new Set<string>();
  for (const b of badges) {
    if (b.unitId) badgedUnitIds.add(String(b.unitId));
  }

  // Non-terminal (pending/active) seed offers pointing at a unit → offered,
  // keyed to the offer's creation time (the earliest, when several point at the
  // same unit) for stale-offer detection + Offered-lane sorting on the board.
  const seeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
    .collect();
  const offeredAtByUnit = new Map<string, number>();
  for (const seed of seeds) {
    if (seed.unitId && (seed.status === "pending" || seed.status === "active")) {
      const k = String(seed.unitId);
      const prev = offeredAtByUnit.get(k);
      offeredAtByUnit.set(
        k,
        prev == null ? seed._creationTime : Math.min(prev, seed._creationTime),
      );
    }
  }

  const quests = await Promise.all(
    units.map(async (unit): Promise<ScholarQuest & { sortKey: number }> => {
      const uk = String(unit._id);
      const isCatalog = catalogUnitIds.has(uk);
      const rawSessions = sessionsByUnit.get(uk) ?? [];
      const hasRawSession = rawSessions.length > 0;
      const badgeEarned = badgedUnitIds.has(uk);
      const offeredAt = offeredAtByUnit.get(uk) ?? null;
      const hasNonTerminalSeedOffer = offeredAt != null;

      // Canonical quest progress (lib/scholarReads) — reads the same
      // assignment-blind completion ledger as the unit badge (no assignmentId
      // filter). The COUNTS the plate/nav display stay assignment-scoped, but
      // quest-lane MEMBERSHIP is NOT: `progress.nextItem` below feeds
      // `hasIncompleteOnline` → `hasLiveSession`, and scholarPlate gates its
      // IS/quest card lane on that. The blind read only ever GROWS the completed
      // set, so `hasLiveSession` can only flip true→false — dropping a card only
      // for a quest whose online work is genuinely all done (matching
      // scholarPlate's own "finished quests fall out" intent).
      const progress = await questOnlineProgressForScholar(
        ctx,
        scholarId,
        unit._id,
      );
      const onlineActivityCount = progress.totalOnline;
      const completedCount = progress.completedOnline;
      const allActivitiesComplete =
        onlineActivityCount > 0 && completedCount >= onlineActivityCount;
      // `nextItem` null ⟺ no online activity left to launch in the unit — the
      // "unit has more work?" signal scholarPlate's completion-skip needs.
      const hasIncompleteOnline = progress.nextItem != null;

      // Completion-skip (mirrors scholarPlate): a session counts as live if its
      // own activity isn't complete, OR the unit still has incomplete work, OR
      // the scholar explicitly reopened it. Only a session whose activity is
      // done AND whose unit has nothing left (and wasn't reopened) drops out.
      let hasLiveSession = false;
      let lastTouched: number | null = null;
      for (const s of rawSessions) {
        const touched = s.lastMessageAt ?? s._creationTime;
        lastTouched = lastTouched == null ? touched : Math.max(lastTouched, touched);
        if (hasLiveSession) continue;
        const currentComplete = await isSessionActivityComplete(ctx, scholarId, s);
        if (!currentComplete || hasIncompleteOnline || s.reopenedAt != null) {
          hasLiveSession = true;
        }
      }

      const state = deriveQuestState({
        unitIsActive: unit.isActive,
        hasLiveSession,
        badgeEarned,
        hasNonTerminalSeedOffer,
        allActivitiesComplete,
      }).state;

      // Structural Draft — the cheap completeness check off the unit + its
      // lessons (buildCompletenessCriteria), NOT the per-node getNodeStatuses.
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect();
      const unitIsDraft = isStructurallyDraft(
        {
          bigIdea: unit.bigIdea,
          essentialQuestions: granuleTexts(unit.essentialQuestions),
          enduringUnderstandings: granuleTexts(unit.enduringUnderstandings),
        },
        lessons.map((l) => ({ strand: l.strand, systemPrompt: l.systemPrompt })),
      );

      return {
        unitId: unit._id,
        title: unit.title,
        emoji: unit.emoji ?? null,
        description: unit.description ?? null,
        state,
        // A CATALOG free-start is self-chosen, so it's always scholar-sourced.
        // For authored units, matches listScholarAuthored: an offer (past or
        // present) marks it teacher-sourced; otherwise the scholar authored it.
        source: isCatalog ? "scholar" : hasNonTerminalSeedOffer ? "teacher" : "scholar",
        lane: deriveLane(badgeEarned, hasRawSession),
        unitIsActive: unit.isActive,
        unitIsDraft,
        onlineActivityCount,
        completedCount,
        badgeEarned,
        hasLiveSession,
        lastTouched,
        offeredAt,
        sortKey: lastTouched ?? unit._creationTime,
      };
    }),
  );

  quests.sort((a, b) => b.sortKey - a.sortKey);
  return quests.map(({ sortKey: _sortKey, ...quest }) => quest);
}

/**
 * Collect the {@link QuestFacts} for a SINGLE (scholarId, unitId) pair — the
 * cheap single-pair counterpart to {@link questsForScholar}'s per-unit loop,
 * so the transition surface (convex/quests.ts) can recompute canonical state
 * for exactly the pair it just mutated without scanning every quest.
 *
 * It reads the SAME facts, filtered the SAME way, as questsForScholar:
 *   - the scholar's non-archived / non-test-drive / non-offline sessions on the
 *     unit, with scholarPlate's completion-skip for the live check;
 *   - a scholarUnitBadges row for (scholar, unit) → badgeEarned;
 *   - a pending/active seed pointing at the unit → the open offer;
 *   - questOnlineProgressForScholar → assignment-blind online activity counts,
 *     reading the same completion ledger as questsForScholar and the unit badge
 *     (no assignmentId filter); the finish threshold still differs, so finishing
 *     here does not imply a minted badge.
 *
 * Returns null when the unit doesn't exist (a deleted / bad id).
 */
export async function questFactsForPair(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
): Promise<QuestFacts | null> {
  const unit = await ctx.db.get(unitId);
  if (!unit) return null;

  // The pair's plate-eligible sessions (same filter as questsForScholar's raw
  // lane). Query by_unit and narrow to this scholar — a unit typically carries
  // one scholar's sessions, so this is cheap.
  const unitSessions = await ctx.db
    .query("sessions")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  const rawSessions = unitSessions.filter(
    (s) =>
      s.userId === scholarId &&
      isPlateEligibleSession(s),
  );

  // Badge → is this unit badged for the scholar?
  const badges = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const badgeEarned = badges.some((b) => String(b.unitId) === String(unitId));

  // A non-terminal (pending/active) seed offer pointing at this unit.
  const seeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
    .collect();
  const hasNonTerminalSeedOffer = seeds.some(
    (s) =>
      String(s.unitId ?? "") === String(unitId) &&
      (s.status === "pending" || s.status === "active"),
  );

  // Canonical quest progress: reads the same assignment-blind completion ledger
  // as questsForScholar and the unit badge (no assignmentId filter). The
  // plate/nav COUNTS stay assignment-scoped; quest-lane MEMBERSHIP does not —
  // hasIncompleteOnline (from progress.nextItem) feeds hasLiveSession below.
  const progress = await questOnlineProgressForScholar(ctx, scholarId, unitId);
  const onlineActivityCount = progress.totalOnline;
  const completedCount = progress.completedOnline;
  const allActivitiesComplete =
    onlineActivityCount > 0 && completedCount >= onlineActivityCount;
  const hasIncompleteOnline = progress.nextItem != null;

  // Completion-skip (mirrors questsForScholar / scholarPlate): a session counts
  // as live if its own activity isn't complete, OR the unit still has work, OR
  // the scholar explicitly reopened it.
  let hasLiveSession = false;
  for (const s of rawSessions) {
    const currentComplete = await isSessionActivityComplete(ctx, scholarId, s);
    if (!currentComplete || hasIncompleteOnline || s.reopenedAt != null) {
      hasLiveSession = true;
      break;
    }
  }

  return {
    unitIsActive: unit.isActive,
    hasLiveSession,
    badgeEarned,
    hasNonTerminalSeedOffer,
    allActivitiesComplete,
  };
}

/**
 * The canonical {@link QuestState} for a single (scholarId, unitId) pair, or
 * null when the unit doesn't exist. Thin wrapper over {@link questFactsForPair}
 * + {@link deriveQuestState}; the transition surface returns this so callers
 * always see the derivation agree with the write they just made.
 */
export async function questStateForPair(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
): Promise<QuestState | null> {
  const facts = await questFactsForPair(ctx, scholarId, unitId);
  if (!facts) return null;
  return deriveQuestState(facts).state;
}

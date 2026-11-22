// A scholar's Quest proposal and its answer (TRA-685), stored on the unit as
// `units.questApproval`. Pure: schema.ts imports the validator, so this file
// imports nothing from the server side. The writers live in
// convex/questProposals.ts; review/quests-rebuilt-proposal.html is the design.
//
// A proposal is the scholar's ask to MAKE something: their own words, a
// one-line mission (kept in `units.mission`, where Quests already keep it),
// and the kind of thing it will be. A teacher who can see the scholar answers
// it. The first answer wins; approving makes that teacher the Quest's advisor
// and creates the Quest's one maker activity.
//
// A teacher's OFFER (TRA-696) is the other way in: the teacher picks the idea,
// so the Quest arrives already approved by the adult attached to it. It is the
// same unit shape in state "offered": no activity yet, the teacher already its
// advisor. The scholar starting it ("approved", one maker activity) or setting
// it aside (archived) is the only way it moves on.

import { v, type Infer } from "convex/values";

/** What the Quest will make. Each has a maker today: the app builder, a
 *  slides deliverable, the Python bench. */
export const questProposalKindValidator = v.union(
  v.literal("app"),
  v.literal("slides"),
  v.literal("python"),
);
export type QuestProposalKind = Infer<typeof questProposalKindValidator>;

/** What the Quest will be, as the proposal's thread message and its Slack
 *  post both say it. */
export const QUEST_PROPOSAL_KIND_LINE: Record<QuestProposalKind, string> = {
  app: "An app",
  slides: "A presentation",
  python: "A Python program",
};

export const questApprovalStateValidator = v.union(
  v.literal("waiting"),
  v.literal("approved"),
  v.literal("declined"),
  /** A teacher's offer the scholar hasn't started yet. */
  v.literal("offered"),
);
export type QuestApprovalState = Infer<typeof questApprovalStateValidator>;

export const questApprovalValidator = v.object({
  state: questApprovalStateValidator,
  kind: questProposalKindValidator,
  /** The scholar's own words, exactly as they proposed (or last edited) it.
   *  Absent on a teacher's offer: the idea is the teacher's. */
  scholarWords: v.optional(v.string()),
  /** When the scholar proposed it. Absent on a teacher's offer (`offeredAt`). */
  proposedAt: v.optional(v.number()),
  /** Bumped on every edit while waiting. An answer names the revision the
   *  teacher saw, so an answer to an older version is refused. */
  revision: v.number(),
  /** A teacher's offer: who offered it and when, and the key that makes a
   *  repeated tap of the same suggestion one offer (per scholar). `advisorId`
   *  is the offerer from the start. */
  offeredBy: v.optional(v.id("users")),
  offeredAt: v.optional(v.number()),
  ideaKey: v.optional(v.string()),
  /** Last edit while waiting. */
  editedAt: v.optional(v.number()),
  /** The chat the proposal came from, when it came from one. */
  fromSessionId: v.optional(v.id("sessions")),
  /** The Quest's thread in Messages and the proposal message that opens it. */
  threadId: v.optional(v.id("parentThreads")),
  proposalMessageId: v.optional(v.id("parentMessages")),
  /** Who answered (approved or declined) and when. */
  answeredBy: v.optional(v.id("users")),
  answeredAt: v.optional(v.number()),
  /** The teacher who approved: the Quest's advisor. Set only on approval. */
  advisorId: v.optional(v.id("users")),
  /** The one maker activity approval created. */
  activityId: v.optional(v.id("activities")),
  /** The line the answer put in the Quest's thread ("… approved your
   *  Quest"), or the one an offer opened it with ("… picked this Quest for
   *  you"): a staff message that is not a teacher's reply. */
  answerMessageId: v.optional(v.id("parentMessages")),
  // ── Showing a Quest (TRA-684) ──
  /** The scholar said it is ready to show, and when (first time only). */
  readyToShowAt: v.optional(v.number()),
  /** The scholar's own explanation of how it works, and the line in the
   *  Quest's thread that carries it (rewritten when they update it). */
  inMyWords: v.optional(v.string()),
  inMyWordsMessageId: v.optional(v.id("parentMessages")),
  /** The advisor's "ready to show" message in Slack (questShowingSlack.ts):
   *  a reply in the Quest's Slack thread (`threadTs`), or its own post in the
   *  class channel when the Quest had none. Kept so every later change
   *  rewrites that one message. */
  readySlackPost: v.optional(
    v.object({
      channelId: v.string(),
      ts: v.string(),
      threadTs: v.optional(v.string()),
    }),
  ),
  /** A teacher awarded the badge: when, who, which badge, and the line it
   *  put in the thread (a staff message that is not a reply). */
  shownAt: v.optional(v.number()),
  awardedBy: v.optional(v.id("users")),
  badgeId: v.optional(v.id("scholarUnitBadges")),
  awardMessageId: v.optional(v.id("parentMessages")),
});
export type QuestApproval = Infer<typeof questApprovalValidator>;

/** Bounds on what a scholar types into a proposal. The mission line reuses
 *  QUEST_MISSION_LIMITS.maxText (units.ts) so it fits where missions live. */
export const QUEST_PROPOSAL_LIMITS = {
  maxScholarWords: 1000,
} as const;

/**
 * A Quest the scholar started on their own from an unlocked "Code it" mission
 * (lib/codeItUnlock.ts, questProposals.startUnlockedCodeIt): it carries an
 * `ideaKey` and no teacher (`offeredBy` absent), and it has no advisor. A
 * scholar's proposal never carries an `ideaKey`; a teacher's offer always has
 * `offeredBy`.
 */
export function isUnlockedQuest(
  approval: { offeredBy?: unknown; ideaKey?: string } | null | undefined,
): boolean {
  return !!approval && approval.offeredBy === undefined && approval.ideaKey !== undefined;
}

/** A proposal still waiting for its yes, one a teacher said no to, or a
 *  teacher's offer the scholar hasn't started: a unit with no activity that
 *  old BunnyPad builds must never list as a Quest, and that nothing opens
 *  onto. (The name predates offers; "offered" is covered on purpose, TRA-696.) */
export function isUnansweredOrDeclinedProposal(
  unit: { questApproval?: { state: string } | null } | null | undefined,
): boolean {
  const state = unit?.questApproval?.state;
  return state === "waiting" || state === "declined" || state === "offered";
}

/**
 * Is this activity an approved Python Quest's one activity? Its work is the
 * program the scholar writes in the Python bench (lib/pythonBench.ts), not an
 * app: the bench opens as the session's app, and the program in the bench's
 * saved state is what they show.
 */
export function isPythonQuestActivity(
  unit:
    | {
        questApproval?: {
          state: string;
          kind: string;
          activityId?: unknown;
        } | null;
      }
    | null
    | undefined,
  activityId: unknown,
): boolean {
  const approval = unit?.questApproval;
  return (
    approval?.state === "approved" &&
    approval.kind === "python" &&
    approval.activityId != null &&
    approval.activityId === activityId
  );
}

/**
 * A unit row without its proposal, for the generic unit reads (`units.get`,
 * `units.list`): the proposal's words and thread ids reach people only through
 * a dedicated proposal read that applies the stamped school's boundary.
 */
export function withoutQuestApproval<U extends { questApproval?: QuestApproval }>(
  unit: U,
): Omit<U, "questApproval"> {
  const { questApproval: _proposal, ...rest } = unit;
  return rest;
}

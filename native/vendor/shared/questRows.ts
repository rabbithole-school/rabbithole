/**
 * Proposing a Quest, and the rows a kid's proposals and approved Quests take
 * on the Quests tab (review/quests-rebuilt-proposal.html, "Proposing a
 * Quest", figure 4, figure 12), worded once for web and the BunnyPad
 * (TRA-694 web, its BunnyPad twin).
 *
 * The rows come from `questProposals.forSelf` (`{ approved, offered, waiting }`) and
 * draw with the one row (shared/wonderRows.ts `ListRowModel`): the Quest's
 * emoji with a rocket badge, the title, "Mission: …", and a meta line that
 * says what the Quest makes and who is involved, ending in "Ms. Rivera
 * replied" when a teacher has written back.
 *
 *   approved, not begun   "An app · Advisor: Ms. Rivera"   outline "Start building"
 *   approved, begun       "An app · Advisor: Ms. Rivera"   solid "Continue"
 *   offered               "An app · Picked for you by Ms. Rivera"  outline "Start building"
 *   waiting               "An app · Waiting for a teacher" quiet "View"
 *   unlocked              "A Python program · Unlocked by your practice"
 *                         outline "Start building"
 *   ready to show         "An app · Advisor: Ms. Rivera · Ready to show"
 *   shown                 "An app · Sunrise Maker · Advisor: Ms. Rivera"
 *                         gold star, quiet "View", listed below the rest
 *
 * Showing a Quest (TRA-684, figure 8; TRA-720 moved it to the header): the
 * kid's "I'm ready to show" in the session header's action pill, its sheet
 * ("How does it work? Say it in your own words"), and the words for the row
 * each state gives (QUEST_SHOWING_COPY).
 *
 * An offered Quest (TRA-698) is one a teacher picked for the kid: the rocket
 * stays on the ground until they start it.
 *
 * An unlocked "Code it" mission (convex/lib/codeItUnlock.ts) is one that
 * opened on its own when the kid became fluent on a practice skill. It sits
 * after a teacher's offers and waiting proposals, since a teacher's pick
 * outranks a system unlock. It shows only once coding challenges are
 * switched on: they start off, and the account screen (CODING_CHALLENGES_COPY)
 * or staff turn them on.
 *
 * Every row is dismissed the same way: the quiet trailing × (ListRow's
 * `onDismiss`, as on a wonder row). What it does depends on the row
 * (`questDismissal`), and nothing is ever deleted or called declined:
 *
 *   offered    set aside (questProposals.dismissQuest)
 *   waiting    the proposal withdrawn (questProposals.dismissQuest)
 *   approved   taken off the list, work kept, a teacher can bring it back
 *              (questProposals.dismissQuest); asks first (QUEST_DISMISS_CONFIRM)
 *   unlocked   that one mission stops unlocking, the next one earned takes
 *              its place (questProposals.dismissUnlockedCodeIt)
 *
 * Inputs are typed structurally, and an unknown kind (one a later backend
 * adds) drops out of the meta line rather than being misnamed: an installed
 * BunnyPad build can be days behind the server.
 *
 * Pure. Shared by web and native (native reads it via native/vendor: re-run
 * `npm run sync:vendor` in native/ after editing).
 */

import type { ListRowModel } from "./wonderRows";

/** Bounds on what is typed when a Quest is shown (convex/questShowing.ts
 *  enforces them; the sheet reads the same numbers). */
export const QUEST_SHOWING_LIMITS = {
  maxInMyWords: 1000,
  maxBadgeName: 60,
} as const;

/** What a Quest makes (convex/lib/questApproval.ts `QuestProposalKind`). */
export type QuestKind = "app" | "slides" | "python";

/** The card's switch, in the design's order. */
export const QUEST_KINDS: readonly QuestKind[] = ["app", "slides", "python"];

export const QUEST_COPY = {
  /** The Quests tab's button beside Your Quests (where "+ Custom Quest"
   *  was), and the BunnyPad's "+ Start a Quest" with its new job. */
  proposeAQuest: "Propose a Quest",
  /** The kid's first turn in the chat "Propose a Quest" opens: it asks the
   *  tutor to help them say what they want to make, so it answers with a
   *  question and then the proposal card. */
  proposeOpener: "I want to propose a Quest.",
  /** The proposal card in a chat (figure 4). */
  cardTitle: "Your proposal",
  cardMission: "Mission",
  cardChangeMission: "Change it",
  cardMissionDone: "Done",
  cardKindPrompt: "It will be:",
  cardPropose: "Propose",
  cardProposeHint: "A teacher reads it and answers.",
  /** The card once its proposal is sent: the same calm words as the row. */
  cardProposed: "Proposed",
  waiting: "Waiting for a teacher",
  view: "View",
  startBuilding: "Start building",
  continue: "Continue",
  /** A teacher's offer: "Picked for you by Ms. Rivera". */
  pickedForYou: (name: string): string => `Picked for you by ${name}`,
  /** An offer whose teacher has no display name. */
  pickedForYouUnnamed: "Picked for you by a teacher",
  /** An unlocked "Code it" mission: who opened it. */
  unlockedByPractice: "Unlocked by your practice",
  /** A row's × failed, and the row came back. */
  dismissFailed: "Couldn't take that off your list. Please try again.",
  advisor: (name: string): string => `Advisor: ${name}`,
  /** An approved Quest whose advisor has no display name. */
  advisorUnnamed: "Approved",
  missionLine: (mission: string): string => `Mission: ${mission}`,
} as const;

export const QUEST_SHOWING_COPY = {
  /** The header pill (homework's "I'm done with this" pill), and the sheet's
   *  name for screen readers. */
  readyToShow: "I\u2019m ready to show",
  sheetTitle: "How does it work?",
  sheetHint: "Say it in your own words",
  sheetPlaceholder: "One or two sentences",
  send: "Send",
  cancel: "Cancel",
  /** Once the kid has said so: the row's meta line, and the header pill
   *  beside its checkmark. */
  rowReady: "Ready to show",
  /** After sending: when, in the sheet that reopens on their words. */
  readyAt: (when: string): string => `Ready to show \u00b7 ${when}`,
  /** The sheet's button when words are already sent. */
  update: "Update",
  mic: "Say it instead",
  micStop: "Stop",
  tooLong: (max: number): string => `Keep it under ${max} characters.`,
} as const;

/** What a started or approved Quest's × asks first (the only row that
 *  asks: its work is kept, and a teacher can bring it back). */
export const QUEST_DISMISS_CONFIRM = {
  title: "Take this Quest off your list?",
  body: "Your work is kept, and a teacher can bring it back.",
  confirm: "Take it off",
  cancel: "Cancel",
} as const;

/** What a row's × does, by the row's status (see the header). `confirm`: ask
 *  first with QUEST_DISMISS_CONFIRM. */
export type QuestDismissal =
  | { mutation: "dismissQuest"; unitId: string; confirm: boolean }
  | { mutation: "dismissUnlockedCodeIt"; skillKey: string; confirm: false };

export function questDismissal(
  entry:
    | { status: "approved" | "offered" | "waiting"; quest: { unitId: string } }
    | { status: "unlocked"; quest: { skillKey: string } },
): QuestDismissal {
  if (entry.status === "unlocked") {
    return { mutation: "dismissUnlockedCodeIt", skillKey: entry.quest.skillKey, confirm: false };
  }
  return {
    mutation: "dismissQuest",
    unitId: String(entry.quest.unitId),
    confirm: entry.status === "approved",
  };
}

/** The account screen's switch for unlocked coding challenges, off until
 *  the scholar turns it on (web's profile dialog and the BunnyPad's Account
 *  details say the same words). */
export const CODING_CHALLENGES_COPY = {
  label: "Coding challenges",
  on: "On",
  off: "Off",
  hint: "Turn on for Python challenges that unlock when you master a practice skill.",
} as const;

/** When the kid said they were ready, for the sheet: the time today,
 *  else the day. `now` is passed in (T11), never read here. */
export function readyToShowWhen(readyToShowAt: number, now: number): string {
  const at = new Date(readyToShowAt);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay
    ? at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : at.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** The sheet's words as sendable, or the reason they aren't (null reason:
 *  nothing typed yet). */
export function checkInMyWords(
  raw: string,
): { ok: true; words: string } | { ok: false; reason: string | null } {
  const words = raw.trim();
  if (!words) return { ok: false, reason: null };
  if (words.length > QUEST_SHOWING_LIMITS.maxInMyWords) {
    return { ok: false, reason: QUEST_SHOWING_COPY.tooLong(QUEST_SHOWING_LIMITS.maxInMyWords) };
  }
  return { ok: true, words };
}

/** "An app", "A presentation", "A Python program". Null for a kind this
 *  build doesn't know. */
export function questKindLabel(kind: string): string | null {
  switch (kind) {
    case "app":
      return "An app";
    case "slides":
      return "A presentation";
    case "python":
      return "A Python program";
    default:
      return null;
  }
}

/** A proposal unit's emoji when the server sends none (every proposal is
 *  minted with this one, lib/independentStudy.ts). */
export const QUEST_MARK = "⚡";

/** A teacher's latest reply in the Quest's thread (`forSelf` `reply`). */
export type QuestReplyInput = { teacherName: string | null; threadId: string } | null;

/** The fields of a `forSelf` waiting proposal this module reads. */
export type WaitingQuestInput = {
  unitId: string;
  title: string;
  mission: string;
  kind: string;
  emoji?: string | null;
  reply?: QuestReplyInput;
};

/** The fields of a `forSelf` offered Quest this module reads. */
export type OfferedQuestInput = WaitingQuestInput & {
  offeredByName: string | null;
};

/** The fields of a `forSelf` unlocked "Code it" mission this module reads.
 *  It has no unit yet: starting it makes one. */
export type UnlockedQuestInput = {
  skillKey: string;
  title: string;
  mission: string;
  kind: string;
};

/** The fields of a `forSelf` approved Quest this module reads. */
export type ApprovedQuestInput = WaitingQuestInput & {
  advisorName: string | null;
  /** The kid started it from an unlock: no teacher approved or advises it.
   *  Absent from a server that predates unlocks. */
  unlocked?: boolean;
  begun: boolean;
  /** Showing (TRA-684). Absent from a server that predates it. */
  readyToShowAt?: number | null;
  shownAt?: number | null;
  /** The awarded badge's name, once one is. */
  badgeName?: string | null;
  /** The kid's own words, as they last sent them. */
  inMyWords?: string | null;
};

function repliedBy(teacherName: string | null): string {
  const name = teacherName?.trim();
  return name ? `${name} replied` : "A teacher replied";
}

function questRowBase(
  quest: WaitingQuestInput,
): Pick<ListRowModel, "mark" | "title" | "content" | "replyLink"> {
  const mission = quest.mission.trim();
  return {
    mark: quest.emoji?.trim() || QUEST_MARK,
    title: quest.title,
    content: mission ? QUEST_COPY.missionLine(mission) : null,
    replyLink: quest.reply
      ? { label: repliedBy(quest.reply.teacherName), threadId: quest.reply.threadId }
      : null,
  };
}

function metaLine(kind: string, who: string): string {
  return [questKindLabel(kind), who].filter((part): part is string => !!part).join(" · ");
}

/** A proposal still waiting for a teacher: the rocket on the ground and a
 *  quiet "View", which opens its thread in Messages. */
export function waitingQuestRow(quest: WaitingQuestInput): ListRowModel {
  return {
    key: `proposal:${quest.unitId}`,
    ...questRowBase(quest),
    meta: metaLine(quest.kind, QUEST_COPY.waiting),
    rocket: "ground",
    verb: { label: QUEST_COPY.view, weight: "quiet" },
  };
}

/** A teacher's offer the kid hasn't started: the rocket still on the ground,
 *  "Picked for you by <teacher>", and an outline "Start building". */
export function offeredQuestRow(quest: OfferedQuestInput): ListRowModel {
  const teacher = quest.offeredByName?.trim();
  return {
    key: `offer:${quest.unitId}`,
    ...questRowBase(quest),
    meta: metaLine(
      quest.kind,
      teacher ? QUEST_COPY.pickedForYou(teacher) : QUEST_COPY.pickedForYouUnnamed,
    ),
    rocket: "ground",
    verb: { label: QUEST_COPY.startBuilding, weight: "outline" },
  };
}

/** An unlocked "Code it" mission the kid hasn't started: the rocket on the
 *  ground, "Unlocked by your practice", and an outline "Start building". */
export function unlockedQuestRow(quest: UnlockedQuestInput): ListRowModel {
  const mission = quest.mission.trim();
  return {
    key: `unlock:${quest.skillKey}`,
    mark: QUEST_MARK,
    title: quest.title,
    content: mission ? QUEST_COPY.missionLine(mission) : null,
    replyLink: null,
    meta: metaLine(quest.kind, QUEST_COPY.unlockedByPractice),
    rocket: "ground",
    verb: { label: QUEST_COPY.startBuilding, weight: "outline" },
  };
}

/** A Quest whose advisor has seen it. */
export function isShownQuest(quest: { shownAt?: number | null }): boolean {
  return quest.shownAt != null;
}

/**
 * The approved Quest a session is making (TRA-720): the row for the session's
 * unit whose maker activity is the session's activity. Another activity a
 * teacher adds to the Quest's unit later is not the Quest's session, so it
 * keeps its ordinary hand-in. Every Quest session is opened on its maker
 * activity, so the unit alone decides only for a session with no activity.
 */
export function questForSession<Q extends { unitId: string; activityId: string }>(
  approved: readonly Q[],
  session: { unitId: string; activityId?: string | null },
): Q | null {
  return (
    approved.find(
      (quest) =>
        String(quest.unitId) === String(session.unitId) &&
        (session.activityId == null ||
          String(quest.activityId) === String(session.activityId)),
    ) ?? null
  );
}

/** The approved Quests still being made, then the shown ones, each keeping
 *  the order `forSelf` gave. A shown Quest stays in the list, below. */
export function approvedActiveFirst<A extends { shownAt?: number | null }>(
  approved: readonly A[],
): { active: A[]; shown: A[] } {
  return {
    active: approved.filter((quest) => !isShownQuest(quest)),
    shown: approved.filter(isShownQuest),
  };
}

/** An approved Quest: the rocket launched, the advisor named, and "Start
 *  building" until the kid has begun, "Continue" after. */
export function approvedQuestRow(quest: ApprovedQuestInput): ListRowModel {
  const advisor = quest.advisorName?.trim();
  const who = advisor
    ? QUEST_COPY.advisor(advisor)
    : quest.unlocked
      ? QUEST_COPY.unlockedByPractice
      : QUEST_COPY.advisorUnnamed;
  if (isShownQuest(quest)) {
    // Shown: the gold star, the badge named, and a quiet way back in.
    return {
      key: `quest:${quest.unitId}`,
      ...questRowBase(quest),
      meta: [questKindLabel(quest.kind), quest.badgeName?.trim() || null, who]
        .filter((part): part is string => !!part)
        .join(" \u00b7 "),
      rocket: "star",
      verb: { label: QUEST_COPY.view, weight: "quiet" },
    };
  }
  const ready = quest.readyToShowAt != null;
  return {
    key: `quest:${quest.unitId}`,
    ...questRowBase(quest),
    meta: [metaLine(quest.kind, who), ready ? QUEST_SHOWING_COPY.rowReady : null]
      .filter((part): part is string => !!part)
      .join(" \u00b7 "),
    rocket: "launched",
    verb: quest.begun
      ? { label: QUEST_COPY.continue, weight: "solid" }
      : { label: QUEST_COPY.startBuilding, weight: "outline" },
  };
}

/** How many rows `forSelf` gives the Quests tab (`offered` and `unlocked`
 *  may be absent: an older server). */
export function proposalRowCount(read: {
  approved: readonly unknown[];
  offered?: readonly unknown[];
  waiting: readonly unknown[];
  unlocked?: readonly unknown[];
}): number {
  return (
    read.approved.length +
    (read.offered?.length ?? 0) +
    read.waiting.length +
    (read.unlocked?.length ?? 0)
  );
}

/**
 * The Quests tab's proposal rows, in the design's order: approved Quests
 * first, then a teacher's offers, then proposals still waiting, then unlocked
 * "Code it" missions, then Quests already shown. Each list keeps the order
 * `forSelf` gives it. `offered` and `unlocked` may be absent (an older
 * server).
 */
export function proposalRows<
  A extends ApprovedQuestInput,
  O extends OfferedQuestInput,
  W extends WaitingQuestInput,
  // `never` when the read carries no `unlocked`, so a caller that passes
  // none can still read `quest.unitId` on every row.
  U extends UnlockedQuestInput = never,
>(
  read: {
    approved: readonly A[];
    offered?: readonly O[];
    waiting: readonly W[];
    unlocked?: readonly U[];
  },
): Array<
  | { status: "approved"; quest: A; row: ListRowModel }
  | { status: "offered"; quest: O; row: ListRowModel }
  | { status: "waiting"; quest: W; row: ListRowModel }
  | { status: "unlocked"; quest: U; row: ListRowModel }
> {
  const { active, shown } = approvedActiveFirst(read.approved);
  const approvedRow = (quest: A) => ({
    status: "approved" as const,
    quest,
    row: approvedQuestRow(quest),
  });
  return [
    ...active.map(approvedRow),
    ...(read.offered ?? []).map((quest) => ({
      status: "offered" as const,
      quest,
      row: offeredQuestRow(quest),
    })),
    ...read.waiting.map((quest) => ({
      status: "waiting" as const,
      quest,
      row: waitingQuestRow(quest),
    })),
    ...(read.unlocked ?? []).map((quest) => ({
      status: "unlocked" as const,
      quest,
      row: unlockedQuestRow(quest),
    })),
    ...shown.map(approvedRow),
  ];
}

/**
 * What the proposal rows already stand for, so the tab's older Quest lists
 * (the started-Quest cards and the not-started unit cards) leave it out and
 * no Quest shows twice: each proposal's unit, and the chat it was proposed
 * from (a kid's own chat, which those lists would otherwise show as a Quest
 * of its own). Only approved Quests' units reach those lists (a waiting
 * proposal has no activity, lib/questLifecycle.ts), but both are returned so
 * the rule doesn't depend on that. An unlocked "Code it" mission has no unit
 * or chat until it is started, when it comes back as an approved Quest, so it
 * covers nothing.
 */
export function proposalCoverage(read: {
  approved: readonly { unitId: string; fromSessionId?: string | null }[];
  offered?: readonly { unitId: string; fromSessionId?: string | null }[];
  waiting: readonly { unitId: string; fromSessionId?: string | null }[];
}): { unitIds: Set<string>; sessionIds: Set<string> } {
  const all = [...read.approved, ...(read.offered ?? []), ...read.waiting];
  return {
    unitIds: new Set(all.map((quest) => String(quest.unitId))),
    sessionIds: new Set(
      all.flatMap((quest) => (quest.fromSessionId ? [String(quest.fromSessionId)] : [])),
    ),
  };
}

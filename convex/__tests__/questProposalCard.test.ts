// The tutor's proposal card (TRA-690): which chats offer it, the check a
// drafted card passes, and the tool row the stream leaves.
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  QUEST_PROPOSAL_CARD_LIMITS,
  checkQuestProposalCard,
  mayOfferQuestProposal,
  questProposalCardMarker,
} from "../lib/questProposalCard";
import { QUEST_PROPOSAL_LIMITS } from "../lib/questApproval";
import { QUEST_MISSION_LIMITS } from "../units";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

describe("mayOfferQuestProposal", () => {
  const chat = {
    sessionMode: "conversation" as const,
    builderPrimary: false,
    activity: null,
    unit: null,
    sessionUserId: "scholar-1",
  };
  const ownQuest = { authorScholarId: "scholar-1" };

  test("a scholar's own chats with no activity offer it", () => {
    expect(mayOfferQuestProposal(chat)).toBe(true);
    expect(mayOfferQuestProposal({ ...chat, sessionMode: null })).toBe(true);
    expect(mayOfferQuestProposal({ ...chat, unit: ownQuest })).toBe(true);
  });

  test.each([
    ["an activity", { activity: { kind: "online" } }],
    ["a teacher's unit", { unit: { authorScholarId: undefined } }],
    ["another scholar's Quest", { unit: { authorScholarId: "scholar-2" } }],
    ["a Quest a teacher designed for them", { unit: { ...ownQuest, authorRole: "inspired" } }],
    ["a waiting proposal", { unit: { ...ownQuest, questApproval: { state: "waiting" } } }],
    ["an approved Quest", { unit: { ...ownQuest, questApproval: { state: "approved" } } }],
    ["a builder", { sessionMode: "vibecode" as const }],
    ["the Workbench", { sessionMode: "workbench" as const }],
    ["a builder-primary session", { builderPrimary: true }],
    ["free play", { freePlay: true }],
    ["a rehearsal", { isTestDrive: true }],
  ])("%s does not", (_label, patch) => {
    expect(mayOfferQuestProposal({ ...chat, ...patch })).toBe(false);
  });
});

describe("checkQuestProposalCard", () => {
  const said = ["hi", "I want to build an app about  Tides for my sister"];
  const draft = {
    scholar_words: "i want to build an app about tides",
    mission: "Show my little sister\nwhy the tides change",
    kind: "app" as const,
  };

  test("takes the scholar's words ignoring case and spacing, and keeps the mission on one line", () => {
    const check = checkQuestProposalCard(draft, said);
    expect(check).toEqual({
      ok: true,
      card: {
        scholarWords: "i want to build an app about tides",
        mission: "Show my little sister why the tides change",
        kind: "app",
      },
    });
  });

  test("refuses words the scholar never wrote", () => {
    const check = checkQuestProposalCard(
      { ...draft, scholar_words: "I want to build a tide simulator" },
      said,
    );
    expect(check.ok).toBe(false);
  });

  test("refuses an empty or over-long mission and an over-long title", () => {
    expect(checkQuestProposalCard({ ...draft, mission: "  " }, said).ok).toBe(false);
    expect(
      checkQuestProposalCard(
        { ...draft, mission: "x".repeat(QUEST_PROPOSAL_CARD_LIMITS.maxMission + 1) },
        said,
      ).ok,
    ).toBe(false);
    expect(
      checkQuestProposalCard(
        { ...draft, title: "y".repeat(QUEST_PROPOSAL_CARD_LIMITS.maxTitle + 1) },
        said,
      ).ok,
    ).toBe(false);
  });

  test("its limits are the ones questProposals.propose enforces", () => {
    expect(QUEST_PROPOSAL_CARD_LIMITS.maxMission).toBe(QUEST_MISSION_LIMITS.maxText);
    expect(QUEST_PROPOSAL_CARD_LIMITS.maxScholarWords).toBe(
      QUEST_PROPOSAL_LIMITS.maxScholarWords,
    );
  });
});

async function setupChat(t: TC, opts: { withActivity?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Scholar A",
      username: "scholar_a",
      role: "scholar",
    });
    let activityId: Id<"activities"> | undefined;
    if (opts.withActivity) {
      const teacherId = await ctx.db.insert("users", {
        name: "Teacher B",
        username: "teacher_b",
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Tides",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Why tides change",
        order: 0,
      });
      activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Explain the tides",
        kind: "online",
        order: 0,
      });
    }
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Tides",
      isArchived: false,
      ...(activityId ? { activityId } : {}),
    });
    await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "I want to build an app about tides",
      flagged: false,
    });
    const assistantId = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "",
      streamId: "stream-1",
      flagged: false,
    });
    return { scholarId, sessionId, assistantId };
  });
}

describe("the card in a session", () => {
  test("getSessionContext offers it in an open chat and not in a teacher's activity", async () => {
    const t = convexTest(schema, modules);
    const open = await setupChat(t);
    const openContext = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId: open.sessionId,
    });
    expect(openContext?.questProposalOffered).toBe(true);

    const assigned = await setupChat(t, { withActivity: true });
    const assignedContext = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId: assigned.sessionId,
    });
    expect(assignedContext?.questProposalOffered).toBe(false);
  });

  test("showing a card splits the turn, writes no proposal, and the tutor sees it later", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, assistantId } = await setupChat(t);
    const card = {
      scholarWords: "I want to build an app about tides",
      mission: "Show my class why the tides change",
      kind: "app" as const,
    };
    const { newMessageId, cardMessageId } = await t.mutation(
      internal.sessionHelpers.showQuestProposalCard,
      {
        currentMessageId: assistantId,
        sessionId,
        contentSoFar: "Tides come from the Moon's pull.",
        card,
      },
    );

    const rows = await t.run(async (ctx) => ({
      before: await ctx.db.get(assistantId),
      card: await ctx.db.get(cardMessageId),
      next: await ctx.db.get(newMessageId),
      units: await ctx.db.query("units").collect(),
    }));
    expect(rows.before?.content).toBe("Tides come from the Moon's pull.");
    expect(rows.before?.streamId).toBeUndefined();
    expect(rows.card).toMatchObject({ role: "tool", toolAction: "", questProposalCard: card });
    expect(rows.next).toMatchObject({ role: "assistant", content: "", streamId: "stream-1" });
    // A card is a draft: only the scholar's Propose tap makes a proposal.
    expect(rows.units).toHaveLength(0);

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    const marker = context?.chatHistory.find((m) => m.id === String(cardMessageId));
    expect(marker).toMatchObject({
      sourceRole: "tool",
      content: questProposalCardMarker(card),
    });
  });
});

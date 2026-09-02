import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  buildChatInstructionSection,
  CHAT_INSTRUCTION_ALREADY_COMPLETED_GUIDANCE,
  instructionCompletedMarker,
  instructionServedMarker,
  OFFER_INSTRUCTION_TOOL,
} from "../lib/practice/chatInstruction";
import { strandInstructionKey } from "../lib/practice/instructionEntries";
import { buildObserverTranscript } from "../lib/observerShared";
import { FRACTION_ARITHMETIC_DOMAIN } from "../seed/fractionArithmeticGraph";
import { GEOMETRY_MEASUREMENT_DOMAIN } from "../seed/geometryMeasurementGraph";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;
const DECIMALS_KEY = strandInstructionKey(
  FRACTION_ARITHMETIC_DOMAIN,
  "decimals",
);
const COORDINATES_KEY = strandInstructionKey(
  GEOMETRY_MEASUREMENT_DOMAIN,
  "coordinate-geometry",
);

async function asScholar(t: TC, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function setup(t: TC) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Mika Test",
      username: "mika_test",
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Rock measurements",
      isArchived: false,
    });
    const assistantMessageId = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "Want a quick show-and-do on decimals?",
      promptVersion: "prompt-v1",
      flagged: false,
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: "decimal_place_value",
      label: "Decimal place value",
      domain: FRACTION_ARITHMETIC_DOMAIN,
      strand: "decimals",
      source: "practice",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: "density_meaning",
      label: "Density meaning",
      domain: "physical-science",
      strand: "density",
      source: "curated",
    });
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: "decimal_place_value",
      domain: FRACTION_ARITHMETIC_DOMAIN,
      strand: "decimals",
      repetition: 1,
      halfLifeDays: 2,
      lastPracticedAt: Date.now(),
      frontier: true,
      source: "practice",
      updatedAt: Date.now(),
    });
    return { scholarId, sessionId, assistantMessageId };
  });
}

async function seedInstruction(
  t: TC,
  platforms: Array<"web" | "native"> = ["web", "native"],
) {
  await t.run((ctx) =>
    ctx.db.insert("instructionContent", {
      key: DECIMALS_KEY,
      domain: FRACTION_ARITHMETIC_DOMAIN,
      strand: "decimals",
      version: 1,
      title: "Decimals show parts of a whole",
      subtitle: "The point separates wholes from parts",
      atoms: [
        {
          kind: "micro_explain",
          text: "The first place after the decimal point counts tenths.",
        },
        {
          kind: "try_it",
          strategyLabel: "Build tenths",
          steps: ["Write two wholes.", "Add five tenths."],
          examplePrompt: "What decimal shows two wholes and five tenths?",
          exampleAnswer: "2.5",
          answerType: "decimal",
        },
      ],
      provenance: "authored",
      verifyStatus: "passed",
      platforms,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedCoordinateInstruction(t: TC) {
  await t.run((ctx) =>
    ctx.db.insert("instructionContent", {
      key: COORDINATES_KEY,
      domain: GEOMETRY_MEASUREMENT_DOMAIN,
      strand: "coordinate-geometry",
      version: 1,
      title: "A grid gives every point an address",
      subtitle: "Two numbers name any point",
      atoms: [
        {
          kind: "micro_explain",
          text: "The first number moves across; the second moves up or down.",
        },
        {
          kind: "worked_example",
          strategyLabel: "Across, then up",
          steps: ["Start at the origin.", "Move across.", "Move up."],
          examplePrompt: "Plot (2, 3).",
          exampleAnswer: "Two across and three up",
        },
      ],
      provenance: "authored",
      verifyStatus: "passed",
      platforms: ["web", "native"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function instructionMessages(t: TC, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect()
    ).filter((message) => message.instruction),
  );
}

describe("chat instruction prompt contract", () => {
  test("requires a named gap, ask-first acceptance, and honest duration copy", () => {
    const section = buildChatInstructionSection();
    expect(OFFER_INSTRUCTION_TOOL.description).toContain("NAMED-GAP ONLY");
    expect(section).toContain("wait for the scholar's explicit yes");
    expect(section).toContain("Never promise “two minutes”");
    expect(section).toContain("Do NOT re-teach");
    expect(section).toContain("BLOCKS the current activity");
    expect(section).toContain("does NOT block the current activity");
    expect(section).not.toContain("2-minute");
  });
});

describe("chatInstruction resolver and lifecycle", () => {
  test("resolves PASSED authored math content for the requesting platform", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await setup(t);
    await seedInstruction(t);

    const resolved = await t.query(
      internal.chatInstruction.resolveChatInstruction,
      {
        scholarId,
        skill: "I haven't learned decimals",
        platform: "native",
      },
    );

    expect(resolved).toMatchObject({
      key: DECIMALS_KEY,
      title: "Decimals show parts of a whole",
      contentVersion: 1,
    });
    expect(resolved?.atoms).toHaveLength(2);
  });

  test("resolves a coordinates named gap to the coordinate-geometry anchor", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await setup(t);
    await seedCoordinateInstruction(t);

    const resolved = await t.query(
      internal.chatInstruction.resolveChatInstruction,
      {
        scholarId,
        skill:
          "I haven't learned what the two numbers in a point like (3, 2) mean",
        platform: "web",
      },
    );

    expect(resolved).toMatchObject({
      key: COORDINATES_KEY,
      title: "A grid gives every point an address",
    });
    expect(
      await t.query(internal.chatInstruction.resolveChatInstruction, {
        scholarId,
        skill: "I haven't learned coordinates",
        platform: "web",
      }),
    ).toMatchObject({ key: COORDINATES_KEY });
  });

  test("returns null for an ambiguous authored-anchor phrase", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await setup(t);
    await seedInstruction(t);
    await seedCoordinateInstruction(t);

    expect(
      await t.query(internal.chatInstruction.resolveChatInstruction, {
        scholarId,
        skill: "I haven't learned operations",
        platform: "web",
      }),
    ).toBeNull();
  });

  test("returns null for uncovered or non-math gaps", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await setup(t);
    await seedInstruction(t);
    await t.run((ctx) =>
      ctx.db.insert("instructionContent", {
        key: strandInstructionKey("physical-science", "density"),
        domain: "physical-science",
        strand: "density",
        version: 1,
        title: "Density",
        atoms: [{ kind: "micro_explain", text: "Density is mass per volume." }],
        provenance: "authored",
        verifyStatus: "passed",
        platforms: ["web", "native"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    expect(
      await t.query(internal.chatInstruction.resolveChatInstruction, {
        scholarId,
        skill: "nobody taught me density",
        platform: "web",
      }),
    ).toBeNull();
  });

  test("returns null when authored content is not eligible for the platform", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await setup(t);
    await seedInstruction(t, ["web"]);

    expect(
      await t.query(internal.chatInstruction.resolveChatInstruction, {
        scholarId,
        skill: "decimal place value",
        platform: "native",
      }),
    ).toBeNull();
    expect(
      await t.query(internal.chatInstruction.resolveChatInstruction, {
        scholarId,
        skill: "decimal place value",
        platform: "web",
      }),
    ).not.toBeNull();
  });

  test("inserts the inline payload without writing mastery or practice credit", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId, assistantMessageId } = await setup(t);
    await seedInstruction(t);
    const beforeMastery = await t.run((ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholarId).eq("skillKey", "decimal_place_value"),
        )
        .unique(),
    );

    const result = await t.mutation(
      internal.chatInstruction.serveChatInstruction,
      {
        sessionId,
        scholarId,
        currentMessageId: assistantMessageId,
        contentSoFar: "Let's do it.",
        skill: "decimals",
        platform: "web",
      },
    );

    expect(result.ok).toBe(true);
    const rows = await instructionMessages(t, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].instruction).toMatchObject({
      key: DECIMALS_KEY,
      title: "Decimals show parts of a whole",
    });
    expect(rows[0].promptVersion).toBe("prompt-v1");
    const after = await t.run(async (ctx) => ({
      mastery: await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholarId).eq("skillKey", "decimal_place_value"),
        )
        .unique(),
      attempts: await ctx.db.query("practiceAttempts").collect(),
      choices: await ctx.db.query("practiceChoiceEvents").collect(),
      event: await ctx.db
        .query("instructionEvents")
        .withIndex("by_scholar_key", (q) =>
          q.eq("scholarId", scholarId).eq("key", DECIMALS_KEY),
        )
        .unique(),
    }));
    expect(after.mastery).toEqual(beforeMastery);
    expect(after.attempts).toHaveLength(0);
    expect(after.choices).toHaveLength(0);
    expect(after.event?.offerCount).toBe(0);
    expect(after.event?.viewedAt).toBeUndefined();
    expect(after.event?.completedAt).toBeUndefined();
    const context = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId },
    );
    expect(context?.chatHistory.map((message) => message.content)).toContain(
      instructionServedMarker("Decimals show parts of a whole"),
    );
  });

  test("completion writes only the SYSTEM-ONLY ledger and one-shot handback", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId, assistantMessageId } = await setup(t);
    await seedInstruction(t);
    await t.mutation(internal.chatInstruction.serveChatInstruction, {
      sessionId,
      scholarId,
      currentMessageId: assistantMessageId,
      contentSoFar: "Let's do it.",
      skill: "decimals",
      platform: "native",
    });
    const instructionMessage = (await instructionMessages(t, sessionId))[0];
    const scholar = await asScholar(t, scholarId);

    const firstCompletion = await scholar.mutation(
      api.chatInstruction.completeChatInstruction,
      {
        scholarId,
        sessionId,
        messageId: instructionMessage._id,
        key: DECIMALS_KEY,
      },
    );
    expect(firstCompletion.handback).toMatchObject({
      sessionId,
      streamId: expect.any(String),
      assistantMsgId: expect.any(String),
    });
    const repeatedCompletion = await scholar.mutation(
      api.chatInstruction.completeChatInstruction,
      {
        scholarId,
        sessionId,
        messageId: instructionMessage._id,
        key: DECIMALS_KEY,
      },
    );
    expect(repeatedCompletion.handback).toEqual(firstCompletion.handback);

    const state = await t.run(async (ctx) => {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect();
      return {
        session: await ctx.db.get(sessionId),
        event: await ctx.db
          .query("instructionEvents")
          .withIndex("by_scholar_key", (q) =>
            q.eq("scholarId", scholarId).eq("key", DECIMALS_KEY),
          )
          .unique(),
        handbacks: messages.filter(
          (message) =>
            message.role === "system" &&
            message.toolAction?.startsWith("instruction_completed:"),
        ),
        attempts: await ctx.db.query("practiceAttempts").collect(),
        choices: await ctx.db.query("practiceChoiceEvents").collect(),
      };
    });
    expect(state.event?.viewedAt).toBeTypeOf("number");
    expect(state.event?.completedAt).toBeTypeOf("number");
    expect(state.session?.activityCompletedAt).toBeUndefined();
    expect(state.attempts).toHaveLength(0);
    expect(state.choices).toHaveLength(0);
    expect(state.handbacks).toHaveLength(1);
    expect(state.handbacks[0].content).toContain(
      "Return them to their original problem",
    );

    const beforeTutorReply = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId },
    );
    expect(beforeTutorReply?.instructionHandback).toContain(
      "Do NOT re-teach",
    );
    expect(
      buildObserverTranscript(beforeTutorReply?.chatHistory ?? []),
    ).toContain(
      instructionCompletedMarker("Decimals show parts of a whole"),
    );
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Back to the rock problem.",
        flagged: false,
      }),
    );
    const afterTutorReply = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId },
    );
    expect(afterTutorReply?.instructionHandback).toBeNull();
  });

  test("does not re-serve a completed segment", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId, assistantMessageId } = await setup(t);
    await seedInstruction(t);
    const firstServe = await t.mutation(
      internal.chatInstruction.serveChatInstruction,
      {
        sessionId,
        scholarId,
        currentMessageId: assistantMessageId,
        contentSoFar: "Let's do it.",
        skill: "decimals",
        platform: "web",
      },
    );
    if (!firstServe.ok) throw new Error("Expected first instruction serve");
    const instructionMessage = (await instructionMessages(t, sessionId))[0];
    const scholar = await asScholar(t, scholarId);
    const completion = await scholar.mutation(
      api.chatInstruction.completeChatInstruction,
      {
        scholarId,
        sessionId,
        messageId: instructionMessage._id,
        key: DECIMALS_KEY,
      },
    );
    if (!completion.handback) throw new Error("Expected handback placeholder");

    const secondServe = await t.mutation(
      internal.chatInstruction.serveChatInstruction,
      {
        sessionId,
        scholarId,
        currentMessageId: completion.handback.assistantMsgId,
        contentSoFar: "",
        skill: "I still haven't learned decimals well enough",
        platform: "web",
      },
    );

    expect(secondServe).toEqual({
      ok: false,
      reason: CHAT_INSTRUCTION_ALREADY_COMPLETED_GUIDANCE,
    });
    expect(await instructionMessages(t, sessionId)).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.get(completion.handback!.assistantMsgId)),
    ).not.toBeNull();
  });

  test("completion records the lifecycle but does not start a turn after time expires", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId, assistantMessageId } = await setup(t);
    await seedInstruction(t);
    await t.run((ctx) =>
      ctx.db.patch(sessionId, {
        sessionTimeLimit: 1,
        sessionStartTime: Date.now() - 2 * 60_000,
      }),
    );
    await t.mutation(internal.chatInstruction.serveChatInstruction, {
      sessionId,
      scholarId,
      currentMessageId: assistantMessageId,
      contentSoFar: "Let's do it.",
      skill: "decimals",
      platform: "web",
    });
    const instructionMessage = (await instructionMessages(t, sessionId))[0];
    const scholar = await asScholar(t, scholarId);

    const result = await scholar.mutation(
      api.chatInstruction.completeChatInstruction,
      {
        scholarId,
        sessionId,
        messageId: instructionMessage._id,
        key: DECIMALS_KEY,
      },
    );

    expect(result).toEqual({ completed: true, handback: null });
    const state = await t.run(async (ctx) => ({
      event: await ctx.db
        .query("instructionEvents")
        .withIndex("by_scholar_key", (q) =>
          q.eq("scholarId", scholarId).eq("key", DECIMALS_KEY),
        )
        .unique(),
      handbacks: (
        await ctx.db
          .query("messages")
          .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
          .collect()
      ).filter(
        (message) =>
          message.role === "system" &&
          message.toolAction?.startsWith("instruction_completed:"),
      ),
    }));
    expect(state.event?.completedAt).toBeTypeOf("number");
    expect(state.handbacks).toHaveLength(1);
  });
});

// TRA-495: the writing-derived reading-level estimate and the Flesch–Kincaid
// trend score only what the scholar TYPED. Speech-to-text output reads like
// fluent adult prose, so a spoken turn must never reach either measure.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { InputModality } from "../lib/inputModality";

const create = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SPOKEN =
  "Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen.";
const TYPED = "i think the moon is bigger then the sun becuase it looks big at nite";

// Enough typed words to clear the estimate floor (TRA-513).
const TYPED_LONG = Array.from({ length: 100 }, () => "word").join(" ");

async function setup(turns: Array<{ content: string; inputModality?: InputModality }>) {
  const t = convexTest(schema, modules);
  const { scholarId, adminId } = await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Fern Example",
      username: "fern-example",
      role: "scholar",
    });
    const adminId = await ctx.db.insert("users", {
      name: "Test Admin",
      username: "test-admin",
      role: "platform_admin",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Reading level input test",
      isArchived: false,
      lastMessageAt: Date.now(),
    });
    for (const turn of turns) {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: turn.content,
        flagged: false,
        ...(turn.inputModality ? { inputModality: turn.inputModality } : {}),
      });
    }
    return { scholarId, adminId };
  });
  const authSessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId: adminId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  const admin = t.withIdentity({
    subject: `${adminId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
  return { t, admin, scholarId: scholarId as Id<"users"> };
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "report_reading_level",
        input: { level: "3", rationale: "Fictional rationale." },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading-level estimate input (TRA-495)", () => {
  test("a scholar with only spoken turns gets no estimate input and no estimate", async () => {
    const { admin, scholarId } = await setup([
      { content: SPOKEN, inputModality: "spoken" },
      { content: SPOKEN, inputModality: "spoken" },
    ]);

    expect(
      await admin.query(api.messages.getScholarUserMessages30d, { scholarId }),
    ).toEqual([]);
    expect(
      await admin.action(api.readingLevelAnalysis.analyzeReadingLevelAI, { scholarId }),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test("mixed spoken + typed: only typed (and legacy unstamped) turns count", async () => {
    const { admin, scholarId } = await setup([
      { content: SPOKEN, inputModality: "spoken" },
      { content: TYPED, inputModality: "typed" },
      { content: TYPED_LONG, inputModality: "typed" },
      { content: "legacy turn with no modality stamp", inputModality: undefined },
      { content: "Check my answer", inputModality: "app" },
    ]);

    expect(
      (await admin.query(api.messages.getScholarUserMessages30d, { scholarId })).sort(),
    ).toEqual([TYPED, TYPED_LONG, "legacy turn with no modality stamp"].sort());

    const result = await admin.action(api.readingLevelAnalysis.analyzeReadingLevelAI, {
      scholarId,
    });
    expect(result?.level).toBe("3");
    expect(result?.wordCount).toBeGreaterThanOrEqual(100);
    const prompt = JSON.stringify(create.mock.calls[0][0].messages);
    expect(prompt).toContain("bigger then the sun");
    expect(prompt).not.toContain("Photosynthesis");
    expect(prompt).not.toContain("Check my answer");
  });

  test("too few TYPED words gets no estimate, however much was dictated (TRA-513)", async () => {
    const { admin, scholarId } = await setup([
      { content: SPOKEN.repeat(10), inputModality: "spoken" },
      { content: TYPED, inputModality: "typed" },
    ]);
    expect(
      await admin.action(api.readingLevelAnalysis.analyzeReadingLevelAI, { scholarId }),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test("the Flesch–Kincaid trend scores typed turns only", async () => {
    // The trend drops turns stamped after its own `now`; a turn written in the
    // same millisecond as the read can carry a fractional _creationTime past it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T18:00:00Z"));
    const { admin, scholarId } = await setup([
      { content: SPOKEN, inputModality: "spoken" },
      { content: TYPED, inputModality: "typed" },
    ]);
    vi.setSystemTime(new Date("2026-10-01T18:05:00Z"));

    const result = await admin.query(api.messages.getScholarReadingTrend, { scholarId });
    expect(result.availableMessageCount).toBe(1);
    expect(result.sampledMessageCount).toBe(1);
  });
});

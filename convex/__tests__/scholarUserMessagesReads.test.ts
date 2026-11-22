// messages.getScholarUserMessages30d (the input to the AI reading-level
// estimate) reads only the scholar's own turns from the last 30 days.
//
// It used to read `by_session` for every session the scholar has and `.filter`
// to user turns in the window. A `.filter` narrows the result, not the read:
// Convex scans every row of the index range, so that read every message of
// every session. It now reads through `by_session_role` with a `_creationTime`
// range, which returns the same rows in the same order.
//
// The case below pins that result: the 30-day cutoff, typed turns only, and
// session-by-session order (the reading-level action keeps only the first
// 6,000 characters, so order decides what the model reads). convex-test stamps
// `_creationTime` from `Date.now()` and keeps it increasing, so a faked clock,
// moved forward between inserts, places rows on both sides of the cutoff.
//
// It also runs under a read limit with more reply rows than the limit, but
// convex-test counts rows after `.filter`, so the limit cannot tell the old
// query from the new one; it catches a `.collect()` filtered in memory.
//
// Fictional names only.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeSession, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const READ_LIMIT = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 8, 1, 18, 0, 0);
const CUTOFF = START + 10 * DAY_MS;
const QUERY_AT = CUTOFF + 30 * DAY_MS;

afterEach(() => {
  vi.useRealTimers();
});

describe("messages.getScholarUserMessages30d", () => {
  test("returns typed scholar turns from the last 30 days, session by session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: READ_LIMIT },
    });
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const scholar = school.scholars[0];
    const tide = await makeSession(t, scholar, {
      title: "Tide pools",
      institutionId: school.id,
    });
    const moon = await makeSession(t, scholar, {
      title: "Moon phases",
      institutionId: school.id,
    });

    const insert = (
      sessionId: Id<"sessions">,
      role: "user" | "assistant" | "tool",
      content: string,
      spoken = false,
    ) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          sessionId,
          role,
          content,
          flagged: false,
          ...(spoken ? { inputModality: "spoken" as const } : {}),
        }),
      );

    // More than 30 days before the query: outside the window.
    await insert(tide, "user", "an old tide note");
    await insert(moon, "user", "an old moon note");

    // The query runs at QUERY_AT, so its cutoff is exactly CUTOFF: a row a
    // millisecond earlier is out, a row at the cutoff is in.
    vi.setSystemTime(CUTOFF - 1);
    await insert(tide, "user", "just before the cutoff");
    vi.setSystemTime(CUTOFF);
    await insert(moon, "user", "right at the cutoff");

    // Inside the window, interleaved across the two sessions, with enough
    // replies around them to pass the read limit if they were all read.
    vi.setSystemTime(START + 35 * DAY_MS);
    await t.run(async (ctx) => {
      for (let i = 0; i < READ_LIMIT; i++) {
        await ctx.db.insert("messages", {
          sessionId: i % 2 === 0 ? tide : moon,
          role: i % 3 === 0 ? "tool" : "assistant",
          content: `reply ${i}`,
          flagged: false,
        });
      }
    });
    await insert(tide, "user", "the moon pulls the tides");
    await insert(moon, "user", "the moon looks like a fingernail");
    await insert(tide, "assistant", "What else pulls on the ocean?");
    await insert(moon, "user", "spoken words", true);
    await insert(tide, "tool", "artifact saved");
    await insert(moon, "user", "it was full on saturday");
    await insert(tide, "user", "low tide was at noon");

    vi.setSystemTime(QUERY_AT);
    const asTeacher = await world.as.staffOf(school);
    const texts = await asTeacher.query(api.messages.getScholarUserMessages30d, {
      scholarId: scholar.id,
    });

    expect(texts).toEqual([
      "the moon pulls the tides",
      "low tide was at noon",
      "right at the cutoff",
      "the moon looks like a fingernail",
      "it was full on saturday",
    ]);
  });
});

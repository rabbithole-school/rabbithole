// sessions.list and sessions.finishedForScholar read the messages table only
// where a screen shows the count.
//
// Both used to read every message of every listed session to fill
// `messageCount`, so a scholar's own Home and session screens (web and iPad)
// paid for their whole history and re-ran on every write to any of those rows,
// including the streaming heartbeat on each tutor reply. Only the teacher
// scholar page (ScholarFeed, ScholarProfile) shows the count, so it is now
// counted for staff callers only, reading just the user and assistant rows.
//
// convex-test's `transactionLimits.documentsRead` throws once a function reads
// more documents than the limit, so seeding more messages than the limit proves
// which rows are read.
//
// Fictional names only.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeSession, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const READ_LIMIT = 80;

type T = ReturnType<typeof convexTest>;

async function seedMessages(
  t: T,
  sessionId: Id<"sessions">,
  counts: { user: number; assistant: number; tool: number; system: number },
) {
  await t.run(async (ctx) => {
    for (const role of ["user", "assistant", "tool", "system"] as const) {
      for (let i = 0; i < counts[role]; i++) {
        await ctx.db.insert("messages", {
          sessionId,
          role,
          content: `${role} ${i}`,
          flagged: false,
        });
      }
    }
  });
}

async function oneSchool(t: T) {
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  return { world, school, scholar: school.scholars[0] };
}

describe("session list message counts", () => {
  test("a scholar's own list reads no messages and carries no count", async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: READ_LIMIT },
    });
    const { world, school, scholar } = await oneSchool(t);
    for (const title of ["Volcano notes", "Reef survey"]) {
      const sessionId = await makeSession(t, scholar, {
        title,
        institutionId: school.id,
        lastMessageAt: Date.now(),
      });
      await seedMessages(t, sessionId, { user: 30, assistant: 30, tool: 20, system: 5 });
    }

    const asScholar = await world.as.scholar(scholar);
    const rows = await asScholar.query(api.sessions.list, {});

    expect(rows.map((r) => r.title).sort()).toEqual(["Reef survey", "Volcano notes"]);
    for (const row of rows) expect(row.messageCount).toBeNull();
  });

  test("the teacher scholar page counts user and assistant turns, reading only those", async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: READ_LIMIT },
    });
    const { world, school, scholar } = await oneSchool(t);
    const sessionId = await makeSession(t, scholar, {
      title: "Tide pools",
      institutionId: school.id,
      lastMessageAt: Date.now(),
    });
    // 120 rows in all, of which 20 are turns: reading them all would exceed
    // the limit, reading the turns alone fits.
    await seedMessages(t, sessionId, { user: 10, assistant: 10, tool: 90, system: 10 });

    const asTeacher = await world.as.staffOf(school);
    const rows = await asTeacher.query(api.sessions.list, { userId: scholar.id });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Tide pools", messageCount: 20 });
  });

  test("staff reading their own list still get counts", async () => {
    // A staff member can also hold a learner membership and open their own
    // profile, which shows these counts.
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: READ_LIMIT },
    });
    const { world, school } = await oneSchool(t);
    const sessionId = await makeSession(t, school.teacher.id, {
      title: "Star charts",
      institutionId: school.id,
      lastMessageAt: Date.now(),
    });
    await seedMessages(t, sessionId, { user: 4, assistant: 3, tool: 90, system: 0 });

    const asTeacher = await world.as.staffOf(school);
    const own = await asTeacher.query(api.sessions.list, {});
    const self = await asTeacher.query(api.sessions.list, {
      userId: school.teacher.id,
    });

    for (const rows of [own, self]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "Star charts", messageCount: 7 });
    }
  });

  test("the finished list reads no messages", async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: READ_LIMIT },
    });
    const { world, school, scholar } = await oneSchool(t);
    const sessionId = await makeSession(t, scholar, {
      title: "Moon phases",
      institutionId: school.id,
      isArchived: true,
      lastMessageAt: Date.now(),
    });
    await seedMessages(t, sessionId, { user: 50, assistant: 50, tool: 10, system: 0 });

    const asScholar = await world.as.scholar(scholar);
    const rows = await asScholar.query(api.sessions.finishedForScholar, {});

    expect(rows.map((r) => r.title)).toEqual(["Moon phases"]);
    expect(rows[0].messageCount).toBeNull();
  });
});

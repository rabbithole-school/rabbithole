// scholars.getProfile (the scholar page's header, feed, profile sidebar, the
// staff aide's scholar chip, and the scholar's own My Learning page) reads no
// messages (TRA-655).
//
// Its stats used to include a "Messages" total, which meant reading every
// message of every session the scholar ever had, on every scholar page and
// again on each new message. The total is gone; the session list keeps its
// per-session counts.
//
// convex-test's `transactionLimits.documentsRead` throws once a function reads
// more documents than the limit. Seeding more messages than the limit catches a
// read of the scholar's message history; a small bounded read would still fit.
//
// Fictional names only.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import { makeSession, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const READ_LIMIT = 60;

describe("scholars.getProfile read bound", () => {
  test("reports session and observation counts without reading messages", async () => {
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

    for (const title of ["Tide pools", "Moon phases", "Wave energy"]) {
      const sessionId = await makeSession(t, scholar, {
        title,
        institutionId: school.id,
        lastMessageAt: Date.now(),
      });
      await t.run(async (ctx) => {
        for (let i = 0; i < 30; i++) {
          await ctx.db.insert("messages", {
            sessionId,
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i}`,
            flagged: false,
          });
        }
      });
    }

    const asTeacher = await world.as.staffOf(school);
    const profile = await asTeacher.query(api.scholars.getProfile, {
      scholarId: scholar.id,
    });

    expect(profile.stats).toEqual({ sessionCount: 3, observationCount: 0 });
  });
});

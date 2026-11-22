// parents.childSessions (the parent portal's "Recent work" card) must not read
// transcripts. It used to read every message of each of the child's 20 newest
// sessions to fill a messageCount nothing displayed, so the card's cost grew
// with everything the child ever wrote in those sessions.
//
// convex-test's `transactionLimits.documentsRead` throws once a function reads
// more documents than the limit, so seeding more messages than the limit proves
// the query no longer touches them.
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

const SESSIONS = 3;
const MESSAGES_PER_SESSION = 60;
// Far below the 180 seeded messages, comfortably above the gate, the scholar,
// the three sessions and their unit lookups.
const READ_LIMIT = 60;

describe("parents.childSessions read bound", () => {
  test("lists recent work without reading any session's messages", async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: READ_LIMIT },
    });
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 1,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const child = school.scholars[0];
    const parent = school.parents[0];

    for (let s = 0; s < SESSIONS; s++) {
      const sessionId = await makeSession(t, child, {
        title: `Tide pools ${s + 1}`,
        institutionId: school.id,
        lastMessageAt: Date.now(),
        analysisSummary: `Summary ${s + 1}`,
      });
      await t.run(async (ctx) => {
        for (let m = 0; m < MESSAGES_PER_SESSION; m++) {
          await ctx.db.insert("messages", {
            sessionId,
            role: m % 2 === 0 ? "user" : "assistant",
            content: `turn ${m}`,
            flagged: false,
          });
        }
      });
    }
    expect(SESSIONS * MESSAGES_PER_SESSION).toBeGreaterThan(READ_LIMIT);

    const asParent = await world.as.parent(parent);
    const rows = await asParent.query(api.parents.childSessions, {
      scholarId: child.id,
    });

    expect(rows).toHaveLength(SESSIONS);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Tide pools 1",
      "Tide pools 2",
      "Tide pools 3",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ unitTitle: null, analysisSummary: expect.any(String) });
      expect(row).not.toHaveProperty("messageCount");
    }
  });
});

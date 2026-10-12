import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { makeSession, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("dossier interests", () => {
  test("observer merge creates a dossier without writing prose", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const scholar = world.schools[0].scholars[0];
    const sessionId = await makeSession(t, scholar);

    await t.mutation(internal.dossier.mergeObserverInterests, {
      scholarId: scholar.id,
      sessionId,
      at: Date.UTC(2026, 8, 3),
      incoming: [
        {
          label: "rainbows",
          how: "said",
          words: "I always see rainbows",
        },
      ],
    });

    const dossier = await t.run((ctx) =>
      ctx.db
        .query("scholarDossiers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar.id))
        .first(),
    );
    expect(dossier?.content).toBe("");
    expect(dossier?.interests).toHaveLength(1);
  });

  test("observer merge preserves existing dossier prose", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const scholar = world.schools[0].scholars[0];
    const sessionId = await makeSession(t, scholar);
    await t.run((ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: scholar.id,
        content: "- Strengths: tests ideas carefully",
      }),
    );

    await t.mutation(internal.dossier.mergeObserverInterests, {
      scholarId: scholar.id,
      sessionId,
      at: Date.UTC(2026, 8, 3),
      incoming: [{ label: "Japanese", how: "picked" }],
    });

    const dossier = await t.run((ctx) =>
      ctx.db
        .query("scholarDossiers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar.id))
        .first(),
    );
    expect(dossier?.content).toBe("- Strengths: tests ideas carefully");
  });

  test("teacher can change state and another institution's teacher cannot", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const scholar = world.schools[0].scholars[0];
    await t.run((ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: scholar.id,
        content: "",
        interests: [
          {
            label: "rainbows",
            how: "said",
            dates: [Date.UTC(2026, 8, 3)],
            sessionIds: [],
            state: "active",
          },
        ],
      }),
    );

    const ownTeacher = await world.as.staffOf(world.schools[0]);
    await ownTeacher.mutation(api.dossier.setInterestState, {
      scholarId: scholar.id,
      label: "Rainbows!",
      state: "past",
    });
    const rows = await ownTeacher.query(api.dossier.interestsForTeacher, {
      scholarId: scholar.id,
    });
    expect(rows.interests[0]).toMatchObject({
      label: "rainbows",
      state: "past",
      changedBy: "teacher",
    });

    const otherTeacher = await world.as.staffOf(world.schools[1]);
    await expect(
      otherTeacher.mutation(api.dossier.setInterestState, {
        scholarId: scholar.id,
        label: "rainbows",
        state: "active",
      }),
    ).rejects.toThrow();
  });

  test("interestsForTeacher returns full provenance", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const scholar = world.schools[0].scholars[0];
    const sessionId = await makeSession(t, scholar);
    await t.run((ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: scholar.id,
        content: "",
        interests: [
          {
            label: "building",
            how: "teacher",
            dates: [Date.UTC(2026, 8, 3)],
            sessionIds: [sessionId],
            words: "I make towers",
            state: "active",
            changedBy: "teacher",
          },
        ],
      }),
    );

    const teacher = await world.as.staffOf(world.schools[0]);
    const rows = await teacher.query(api.dossier.interestsForTeacher, {
      scholarId: scholar.id,
    });
    expect(rows.interests).toEqual([
      {
        label: "building",
        how: "teacher",
        dates: [Date.UTC(2026, 8, 3)],
        sessionIds: [sessionId],
        words: "I make towers",
        state: "active",
        changedBy: "teacher",
      },
    ]);
  });
});

/**
 * Offline HOMEWORK on the scholar plate.
 *
 * Work sent home that happens away from the screen still has to be READABLE at
 * home, so `scholarPlate.activeForMe` emits a not-started row for a live
 * `kind:"offline"` activity when — and only when — its schedule mode is
 * `homework`. The row carries the activity's full `scholarDescription` (the
 * instruction body the UI discloses in place) and NO session: nothing is
 * launched, nothing is created, and `offline` stays out of
 * SCHOLAR_SOLO_STARTABLE_KINDS so it can never drive the focus lock.
 *
 * Offline CLASS FOCUS and shareBack stay excluded — those are run by the
 * teacher, in the room.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

const INSTRUCTIONS = [
  "Read chapter 4 of the field guide (pages 61–78).",
  "",
  "Then, on paper, list every plant you can find in your own yard that shares a trait with one in the chapter. Bring the list tomorrow.",
].join("\n");
const TEACHER_NOTES = "Use this as a stealth pre-assessment.";

/** One teacher, one scholar, one unit/lesson, one offline activity, pushed at
 *  `mode`. Returns the scholar so the caller can query the plate as them. */
async function seedOfflinePush(
  t: ReturnType<typeof convexTest>,
  mode: "homework" | "classFocus",
  kind: "offline" | "shareBack" = "offline",
  scholarDescription: string | null = INSTRUCTIONS,
) {
  const now = Date.now();
  return t.run(async (ctx) => {
    const teacher = await ctx.db.insert("users", {
      name: "T",
      username: "t",
      role: "teacher",
    });
    const scholar = await ctx.db.insert("users", {
      name: "S",
      username: "s",
      role: "scholar",
    });
    const unit = await ctx.db.insert("units", {
      teacherId: teacher,
      title: "Backyard Botany",
      isActive: true,
    });
    const lesson = await ctx.db.insert("lessons", {
      unitId: unit,
      title: "L1",
      order: 0,
    });
    const activity = await ctx.db.insert("activities", {
      lessonId: lesson,
      title: "Field guide, chapter 4",
      order: 0,
      kind,
      description: TEACHER_NOTES,
      scholarDescription: scholarDescription ?? undefined,
    });
    await ctx.db.insert("assignments", {
      teacherId: teacher,
      unitId: unit,
      scholarIds: [scholar],
      startedAt: now - 86_400_000,
      activitySchedule: [
        {
          activityId: activity,
          mode,
          setAt: now - 3_600_000,
          ...(mode === "homework" ? { dueAt: now + 86_400_000 } : {}),
        },
      ],
    });
    return { teacher, scholar, activity, lesson };
  });
}

describe("scholar plate — offline homework", () => {
  test("live offline HOMEWORK emits a not-started row with the full instructions and no session", async () => {
    const t = convexTest(schema, modules);
    const { scholar } = await seedOfflinePush(t, "homework");

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => r.title === "Field guide, chapter 4");

    expect(row).toBeDefined();
    expect(row?.origin).toBe("homework");
    expect(row?.activityKind).toBe("offline");
    expect(row?.notStarted).toBe(true);
    // Nothing is launched: the card reads in place.
    expect(row?.sessionId).toBeNull();
    // The WHOLE scholar instruction body rides on the row — not a truncation,
    // and its paragraph breaks survive verbatim.
    expect(row?.description).toBe(INSTRUCTIONS);
    expect(row?.description).not.toContain(TEACHER_NOTES);

    // Reading the plate must not create a session for it.
    const sessionCount = await t.run(
      async (ctx) => (await ctx.db.query("sessions").collect()).length,
    );
    expect(sessionCount).toBe(0);
  });

  test("live offline CLASS FOCUS emits no row — the teacher runs it in the room", async () => {
    const t = convexTest(schema, modules);
    const { scholar } = await seedOfflinePush(t, "classFocus");

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});

    expect(rows.find((r) => r.title === "Field guide, chapter 4")).toBeUndefined();
  });

  test("a shareBack activity pushed as homework is still excluded", async () => {
    // Widening the gate for offline must not widen it for share-back: those
    // are a teacher-run classroom ritual, not something a scholar does alone.
    const t = convexTest(schema, modules);
    const { scholar } = await seedOfflinePush(t, "homework", "shareBack");

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});

    expect(
      rows.find((r) => r.title === "Field guide, chapter 4"),
    ).toBeUndefined();
  });

  test("teacher-only description emits no dead Read control", async () => {
    const t = convexTest(schema, modules);
    const { scholar } = await seedOfflinePush(t, "homework", "offline", null);

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});

    expect(
      rows.find((r) => r.title === "Field guide, chapter 4"),
    ).toBeUndefined();
  });

  test("blank offline homework emits no dead Read control", async () => {
    const t = convexTest(schema, modules);
    const { scholar } = await seedOfflinePush(t, "homework", "offline", "   ");

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});

    expect(
      rows.find((r) => r.title === "Field guide, chapter 4"),
    ).toBeUndefined();
  });

  test.each(["direct", "referenced"] as const)(
    "material-only offline homework with %s resources emits a readable row",
    async (resourcePlacement) => {
      const t = convexTest(schema, modules);
      const { teacher, scholar, activity, lesson } = await seedOfflinePush(
        t,
        "homework",
        "offline",
        null,
      );
      await t.run(async (ctx) => {
        const resourceActivityId =
          resourcePlacement === "direct"
            ? activity
            : await ctx.db.insert("activities", {
                lessonId: lesson,
                title: "Shared source",
                kind: "offline",
                order: 1,
              });
        const resourceId = await ctx.db.insert("activityResources", {
          activityId: resourceActivityId,
          title: "Observation guide",
          source: { kind: "link", url: "https://example.com/observation-guide" },
          order: 0,
          uploadedBy: teacher,
        });
        if (resourcePlacement === "referenced") {
          await ctx.db.patch(activity, { referencedResourceIds: [resourceId] });
        }
      });

      const { rows } = await (await asUser(t, scholar)).query(
        api.scholarPlate.activeForMe,
        {},
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          activityId: activity,
          activityKind: "offline",
          description: null,
        }),
      );
    },
  );
});

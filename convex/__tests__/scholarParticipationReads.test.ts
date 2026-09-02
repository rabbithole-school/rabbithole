import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { readScholarRoster, readScholarGroups } from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  username: string,
  name?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: name ?? `Test ${username}`, username, role }),
  );
}

/** A scholar attending Extended Education programming only (program guest). */
async function seedGuestScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
  name: string,
) {
  const userId = await seedUser(t, "scholar", username, name);
  await t.run((ctx) =>
    ctx.db.patch(userId, { enrollmentStanding: "program_guest" }),
  );
  return userId;
}

describe("scholar participation defaults in the aide read layer", () => {
  test("readScholarRoster excludes+counts program guests by default and tags them on opt-in", async () => {
    const t = convexTest(schema, modules);
    const enrolled = await seedUser(t, "scholar", "kai", "Kai Kealoha");
    const guest = await seedGuestScholar(t, "nalu", "Nalu Hale");

    await t.run(async (ctx) => {
      const byDefault = await readScholarRoster(ctx);
      expect(byDefault.scholars.map((r) => r.id)).toEqual([enrolled]);
      expect(byDefault.extendedEducationOmitted).toBe(1);
      // Enrolled rows never carry the tag — byte-identical to pre-filter rows.
      expect("extendedEducation" in byDefault.scholars[0]).toBe(false);

      const widened = await readScholarRoster(ctx, null, {
        includeProgramGuests: true,
      });
      expect(widened.scholars.map((r) => r.id).sort()).toEqual(
        [enrolled, guest].sort(),
      );
      expect(widened.extendedEducationOmitted).toBe(0);
      const guestRow = widened.scholars.find((r) => r.id === guest)!;
      expect(guestRow.extendedEducation).toBe(true);
      const enrolledRow = widened.scholars.find((r) => r.id === enrolled)!;
      expect("extendedEducation" in enrolledRow).toBe(false);
    });
  });

  test("readScholarRoster applies the default inside an allowed id set too", async () => {
    const t = convexTest(schema, modules);
    const enrolled = await seedUser(t, "scholar", "kai", "Kai Kealoha");
    const guest = await seedGuestScholar(t, "nalu", "Nalu Hale");

    await t.run(async (ctx) => {
      const allowed = new Set<Id<"users">>([enrolled, guest]);
      const byDefault = await readScholarRoster(ctx, allowed);
      expect(byDefault.scholars.map((r) => r.id)).toEqual([enrolled]);
      expect(byDefault.extendedEducationOmitted).toBe(1);
      const widened = await readScholarRoster(ctx, allowed, {
        includeProgramGuests: true,
      });
      expect(widened.scholars).toHaveLength(2);
    });
  });

  test("readScholarGroups drops guest members by default, counts them, and reports participation", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "lehua", "Lehua Torres");
    const enrolled = await seedUser(t, "scholar", "kai", "Kai Kealoha");
    const guest = await seedGuestScholar(t, "nalu", "Nalu Hale");
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Geckos",
        scholarIds: [enrolled, guest],
      });
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Robotics",
        scholarIds: [guest],
        participation: "includes_program_guests",
      });
    });

    await t.run(async (ctx) => {
      const byDefault = await readScholarGroups(ctx);
      const geckos = byDefault.find((g) => g.name === "Geckos")!;
      expect(geckos.participation).toBe("enrolled_only");
      expect(geckos.members.map((m) => m.id)).toEqual([enrolled]);
      // memberCount reflects the RETURNED members, not the raw id list.
      expect(geckos.memberCount).toBe(1);
      expect(geckos.extendedEducationMembersOmitted).toBe(1);

      const robotics = byDefault.find((g) => g.name === "Robotics")!;
      expect(robotics.participation).toBe("includes_program_guests");
      expect(robotics.members).toEqual([]);
      expect(robotics.memberCount).toBe(0);
      expect(robotics.extendedEducationMembersOmitted).toBe(1);

      const widened = await readScholarGroups(ctx, null, {
        includeProgramGuests: true,
      });
      const geckosWide = widened.find((g) => g.name === "Geckos")!;
      expect(geckosWide.memberCount).toBe(2);
      expect("extendedEducationMembersOmitted" in geckosWide).toBe(false);
      const guestMember = geckosWide.members.find((m) => m.id === guest)!;
      expect(guestMember.extendedEducation).toBe(true);
      const enrolledMember = geckosWide.members.find((m) => m.id === enrolled)!;
      expect("extendedEducation" in enrolledMember).toBe(false);
    });
  });

  test("naming stays an opt-in: the resolver's widened query still surfaces a guest by name", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "scholar", "kai", "Kai Kealoha");
    const guest = await seedGuestScholar(t, "nalu", "Nalu Hale");

    await t.run(async (ctx) => {
      // resolveScholarByName needs an ActionCtx; exercise the exact query +
      // match it performs (listScholarsInternal with includeProgramGuests).
      const widened = await ctx.runQuery(
        internal.curriculumAssistant.listScholarsInternal,
        { includeProgramGuests: true },
      );
      const match = widened.scholars.find((s) =>
        s.name.toLowerCase().includes("nalu"),
      );
      expect(match?.id).toBe(guest);

      // …while the enumeration default keeps the guest out and counts it.
      const byDefault = await ctx.runQuery(
        internal.curriculumAssistant.listScholarsInternal,
        { includeProgramGuests: false },
      );
      expect(byDefault.scholars.find((s) => s.id === guest)).toBeUndefined();
      expect(byDefault.extendedEducationOmitted).toBe(1);
    });
  });
});

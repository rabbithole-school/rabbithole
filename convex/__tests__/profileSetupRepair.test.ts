import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  overrides: {
    username?: string;
    dateOfBirth?: string;
    image?: string;
    profileSetupComplete?: boolean;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Mika Wave",
      username: overrides.username ?? "mika_wave",
      role: "scholar",
      dateOfBirth: overrides.dateOfBirth ?? "2017-04-12",
      image: overrides.image ?? "https://example.com/mika.jpg",
      profileSetupComplete: overrides.profileSetupComplete,
    }),
  );
}

describe("repairCompletedProfileSetup", () => {
  test("marks a populated legacy scholar profile complete", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);

    await expect(
      t.mutation(internal.users.repairCompletedProfileSetup, {
        userId: scholarId,
        expectedUsername: "mika_wave",
      }),
    ).resolves.toEqual({ updated: true });

    const scholar = await t.run(async (ctx) => ctx.db.get(scholarId));
    expect(scholar?.profileSetupComplete).toBe(true);
  });

  test("is idempotent for an already completed profile", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, { profileSetupComplete: true });

    await expect(
      t.mutation(internal.users.repairCompletedProfileSetup, {
        userId: scholarId,
        expectedUsername: "mika_wave",
      }),
    ).resolves.toEqual({ updated: false });
  });

  test("refuses a mismatched username or incomplete profile", async () => {
    const t = convexTest(schema, modules);
    const completeId = await seedScholar(t);
    const incompleteId = await seedScholar(t, {
      username: "nalu_wave",
      dateOfBirth: "",
    });

    await expect(
      t.mutation(internal.users.repairCompletedProfileSetup, {
        userId: completeId,
        expectedUsername: "wrong_user",
      }),
    ).rejects.toThrow("Username does not match");
    await expect(
      t.mutation(internal.users.repairCompletedProfileSetup, {
        userId: incompleteId,
        expectedUsername: "nalu_wave",
      }),
    ).rejects.toThrow("not complete enough");
  });
});

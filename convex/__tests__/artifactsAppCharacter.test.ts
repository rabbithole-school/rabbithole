// The scholar-facing artifact reads strip a code app's server-only `appAi`
// (persona, judge rubrics) but keep one boolean: whether the app has a
// character, so the scholar's Workshop opens in Play where the tutor hears
// the exchanges.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

async function asUser(t: T, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedApp(t: T, withCharacter: boolean) {
  const institutionId = await seedTestInstitution(t, { slug: "app-char-school" });
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  const { sessionId, artifactId } = await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Teach the robot",
      isArchived: false,
      institutionId,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Robot",
      content: "<html></html>",
      lastEditedBy: "ai",
      type: "code",
      appAi: {
        ...(withCharacter
          ? {
              character: {
                name: "Bolt",
                persona: "A literal-minded robot.",
                moods: ["literal", "proud"],
                verdicts: ["rule_accepted", "rule_rejected"],
              },
            }
          : {}),
        judges: [
          { id: "fractions", rubric: "Names 3/4.", verdicts: ["correct", "not_yet"] },
        ],
        updatedAt: 1,
      },
    });
    return { sessionId, artifactId };
  });
  return { scholarId, sessionId, artifactId };
}

describe("scholar-facing artifact reads and the app's character", () => {
  test("the owning scholar learns a character exists, never its spec", async () => {
    const t = setup();
    const { scholarId, sessionId, artifactId } = await seedApp(t, true);
    const scholar = await asUser(t, scholarId);

    const [fromSession] = await scholar.query(api.artifacts.getBySession, {
      sessionId,
    });
    const byId = await scholar.query(api.artifacts.getById, { artifactId });

    for (const row of [fromSession, byId]) {
      expect(row).toMatchObject({ hasAppCharacter: true });
      expect(row).not.toHaveProperty("appAi");
    }
  });

  test("an app with judges but no character carries no flag", async () => {
    const t = setup();
    const { scholarId, sessionId } = await seedApp(t, false);

    const [row] = await (await asUser(t, scholarId)).query(
      api.artifacts.getBySession,
      { sessionId },
    );

    expect(row).not.toHaveProperty("hasAppCharacter");
    expect(row).not.toHaveProperty("appAi");
  });
});

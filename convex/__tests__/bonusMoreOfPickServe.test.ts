import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Regression: the done-screen "More of your pick" bonus round must be SERVED
// against the domain its skillKeys came from (`choiceHintDomain`), not against
// the practice session's own `domain`. When a scholar You-Picks an in-set
// strand (e.g. "Area & Perimeter" in geometry-measurement) while another
// started domain (e.g. fractions) leads the auto-blend, the session `domain`
// is the blend default (fractions) while `choiceHint.domain` is geometry.
// bonusSkillsForChoice returns GEOMETRY keys; serving them scoped against the
// fractions domain filters them all out → an empty round (the wrong-content
// bug). This locks the server contract the client fix relies on.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const GEO = "geometry-measurement";
const FRAC = "fraction-arithmetic";
const STRAND = "area-perimeter";

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Bonus Scholar", username, role: "scholar" }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function insertItem(t: ReturnType<typeof convexTest>, skillKey: string, domain: string) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey,
      domain,
      stem: `Practice ${skillKey}`,
      answerType: "integer",
      answerCanonical: "1",
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
}

type Served = { items: { skillKey: string }[] };

describe("bonus 'more of your pick' — serve domain", () => {
  test("bonus keys serve against their OWN domain, and are empty against a mismatched session domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "bonus_serve_domain");
    const asScholar = await asUser(t, scholar);

    // The done-screen offer computes the bonus set against choiceHint.domain.
    const bonus = await asScholar.query(api.practiceSkills.bonusSkillsForChoice, {
      domain: GEO,
      strand: STRAND,
      count: 4,
    });
    expect(bonus.skillKeys.length).toBeGreaterThan(0);

    // Make the sampled keys servable (stored, verified items).
    for (const key of bonus.skillKeys) await insertItem(t, key, GEO);

    // FIXED behavior: serve scoped to those keys with their OWN domain → items.
    const right = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: bonus.skillKeys.length,
      seed: 7,
      skillKeys: bonus.skillKeys,
      domain: GEO,
    })) as unknown as Served;
    expect(right.items.length).toBeGreaterThan(0);
    expect(right.items.every((it) => bonus.skillKeys.includes(it.skillKey))).toBe(true);

    // BUG behavior: serving the SAME geometry keys against a different session
    // domain (fractions, the auto-blend default) filters them all out → empty.
    const wrong = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: bonus.skillKeys.length,
      seed: 7,
      skillKeys: bonus.skillKeys,
      domain: FRAC,
    })) as unknown as Served;
    expect(wrong.items.length).toBe(0);
  });
});

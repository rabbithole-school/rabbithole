/**
 * Lane D — geoLocate as a first-class practiceItem, graded through
 * `practiceSkills.submitAnswer` (the manipulative verifier path) and served
 * REDACTED through `getManipulativeItem` (no-spoilers: the map task's target
 * never reaches the client while an attempt is open).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../lib/manipulative/practiceContract";
import { makeLocateItem, getGazetteerEntry } from "../../lib/geomap/registry/data/gazetteer";
import type { GeoLocateSpec } from "../../lib/manipulative/types";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const json = (v: unknown) => JSON.stringify(v);

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Geo Scholar",
      username: "geo-scholar",
      role: "scholar",
    }),
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

async function seedGeoItem(t: ReturnType<typeof convexTest>, spec: GeoLocateSpec, skillKey: string) {
  const domain = "geography";
  const itemId = await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: skillKey,
      label: spec.concept,
      domain,
      strand: "geography",
      source: "practice",
    });
    return await ctx.db.insert("practiceItems", {
      skillKey,
      domain,
      stem: spec.prompt,
      answerType: MANIPULATIVE_ANSWER_TYPE,
      answerCanonical: "",
      verifierKind: MANIPULATIVE_VERIFIER_KIND,
      manipulativeSpec: json(spec),
      source: "generated",
      verifiedAt: Date.now(),
    });
  });
  return { itemId: `gen#${itemId}`, skillKey };
}

describe("practiceSkills.submitAnswer — geoLocate", () => {
  test("a pin within tolerance grades correct; off-target + garbage fail; no answer leaks", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const spec = makeLocateItem("capital-hi"); // Honolulu, 120km tolerance
    const target = getGazetteerEntry("capital-hi")!.lngLat;
    const { itemId, skillKey } = await seedGeoItem(t, spec, "geo_locate_honolulu");

    const correct = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ pins: [{ id: "a", lngLat: target }] }),
    });
    expect(correct.correct).toBe(true);
    expect(correct.correctAnswer).toBeUndefined();
    expect(correct.skillKey).toBe(skillKey);

    const off = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ pins: [{ id: "a", lngLat: [-118.24, 34.05] }] }), // LA, way outside
    });
    expect(off.correct).toBe(false);
    expect(off.correctAnswer).toBeUndefined();

    const garbage = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "not json {",
    });
    expect(garbage.correct).toBe(false);
    expect(garbage.correctAnswer).toBeUndefined();

    const emptyPins = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ pins: [] }),
    });
    expect(emptyPins.correct).toBe(false);
  });

  test("getManipulativeItem serves a REDACTED spec — the real target never reaches the client", async () => {
    const t = convexTest(schema, modules);
    const spec = makeLocateItem("island-oahu");
    const realTarget = getGazetteerEntry("island-oahu")!.lngLat;
    const { itemId } = await seedGeoItem(t, spec, "geo_locate_oahu");

    const served = await t.query(api.practiceSkills.getManipulativeItem, { itemId });
    expect(served).not.toBeNull();
    const clientSpec = JSON.parse(served!.manipulativeSpec!) as GeoLocateSpec;
    expect(clientSpec.kind).toBe("geoLocate");
    if (clientSpec.map.task.kind === "locate") {
      expect(clientSpec.map.task.target).toEqual([0, 0]);
      expect(clientSpec.map.task.target).not.toEqual(realTarget);
      // The prompt (the question) IS still there — only the answer is stripped.
      expect(clientSpec.map.task.prompt).toContain("Oʻahu");
    } else {
      throw new Error("expected a locate task");
    }
  });
});

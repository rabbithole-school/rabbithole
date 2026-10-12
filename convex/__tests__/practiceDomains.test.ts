import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  PRACTICE_DOMAINS,
  practiceDomainLabel,
  practiceDomainInfo,
  resolvePracticeDomainSlug,
} from "../lib/practice/domains";
import { REGISTERED_PRACTICE_DOMAINS } from "../knowledgeNodes";
import {
  PRACTICE_PREREQ_CONCEPTS,
  strandHeadline,
  strandHeadlineFor,
} from "../../shared/practiceDomainLabels";

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

let sharedT: TestConvex<typeof schema>;

beforeAll(async () => {
  sharedT = convexTest(schema, modules);
  await sharedT.mutation(internal.practiceSkills.seedGraph, {});
});

function sharedSeeded() {
  return sharedT;
}

async function seedUser(t: TestConvex<typeof schema>, username = "domuser") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Domain User", username, role: "scholar" }),
  );
}

async function asUser(t: TestConvex<typeof schema>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

describe("practice domains — display registry", () => {
  test("PRACTICE_DOMAINS stays in lock-step with the registered practice graphs", () => {
    const registrySlugs = PRACTICE_DOMAINS.map((d) => d.domain).sort();
    const graphSlugs = [...REGISTERED_PRACTICE_DOMAINS].sort();
    // A graph without a label (or a label without a graph) is a drift bug: the
    // teacher picker would offer an empty/phantom domain, or hide a real one.
    expect(registrySlugs).toEqual(graphSlugs);
  });

  test("every registered domain has a non-empty label and discipline", () => {
    for (const d of PRACTICE_DOMAINS) {
      expect(d.label.trim().length).toBeGreaterThan(0);
      expect(d.discipline.trim().length).toBeGreaterThan(0);
    }
    // No duplicate slugs.
    const slugs = PRACTICE_DOMAINS.map((d) => d.domain);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("helpers resolve known slugs and fall back for unknown ones", () => {
    const known = PRACTICE_DOMAINS[0];
    expect(practiceDomainLabel(known.domain)).toBe(known.label);
    expect(practiceDomainInfo(known.domain)).toEqual(known);
    // Unknown slug → label falls back to the slug, info is undefined.
    expect(practiceDomainLabel("no-such-domain")).toBe("no-such-domain");
    expect(practiceDomainInfo("no-such-domain")).toBeUndefined();
  });

  test("strandHeadlineFor prefers a domain-specific override over the global headline", () => {
    // "number-theory" has different curated headlines under different domains
    // (a real per-domain override branch), and falls back to the global
    // strandHeadline() when a domain has no override for that strand.
    expect(strandHeadlineFor("whole-number-arithmetic", "number-theory")).not.toBe(
      strandHeadlineFor("discrete-math", "number-theory"),
    );
    expect(strandHeadlineFor("whole-number-arithmetic", "counting")).toBe(
      strandHeadline("counting"),
    );
  });

  test("every registered foreign prerequisite key resolves to a non-empty concept label", () => {
    // Structural: every key the practice-prereq system can reference must
    // resolve to a real label, never fall through to blank/undefined.
    for (const [key, label] of Object.entries(PRACTICE_PREREQ_CONCEPTS)) {
      expect(label.trim().length, `PRACTICE_PREREQ_CONCEPTS.${key}`).toBeGreaterThan(0);
    }
  });
});

describe("resolvePracticeDomainSlug — URL/alias → registered slug", () => {
  const REGISTERED = new Set(PRACTICE_DOMAINS.map((d) => d.domain));

  test("exact registered slugs pass through unchanged", () => {
    for (const d of PRACTICE_DOMAINS) {
      expect(resolvePracticeDomainSlug(d.domain)).toBe(d.domain);
    }
  });

  test("natural aliases map to the right registered slug", () => {
    // One representative alias per aliased domain — enough to prove aliasing
    // collapses to a canonical mode without restating the whole alias table.
    expect(resolvePracticeDomainSlug("fractions")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("chance")).toBe("probability");
    expect(resolvePracticeDomainSlug("measurement")).toBe("geometry-measurement");
    expect(resolvePracticeDomainSlug("percent")).toBe("ratio-proportion-percent");
    expect(resolvePracticeDomainSlug("negatives")).toBe("integers-coordinates");
    expect(resolvePracticeDomainSlug("patterns")).toBe("early-algebra");
    expect(resolvePracticeDomainSlug("quadratics")).toBe("algebra-1");
    expect(resolvePracticeDomainSlug("arithmetic")).toBe("whole-number-arithmetic");
  });

  test("is case / space / hyphen / underscore insensitive", () => {
    expect(resolvePracticeDomainSlug("FRACTIONS")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("  Fractions  ")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("Fraction-Arithmetic")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("fraction_arithmetic")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("Whole   Number")).toBe("whole-number-arithmetic");
  });

  test("unknown / empty / nullish input resolves to null (never a default)", () => {
    // The load-bearing guard: an unknown domain must NOT silently become
    // whole-number arithmetic (which would restart placement) — it resolves to
    // null so the caller falls to the scholar's normal auto-blend.
    expect(resolvePracticeDomainSlug("geometry")).toBe("geometry-measurement");
    expect(resolvePracticeDomainSlug("not-a-domain")).toBeNull();
    expect(resolvePracticeDomainSlug("")).toBeNull();
    expect(resolvePracticeDomainSlug("   ")).toBeNull();
    expect(resolvePracticeDomainSlug(null)).toBeNull();
    expect(resolvePracticeDomainSlug(undefined)).toBeNull();
  });

  test("every non-null result — and every alias target — is a registered slug", () => {
    for (const input of [
      "fractions",
      "fraction",
      "chance",
      "geometry",
      "measurement",
      "geometry measurement",
      "ratio",
      "ratios",
      "percent",
      "proportions",
      "integers",
      "negative numbers",
      "negatives",
      "algebra",
      "equations",
      "patterns",
      "arithmetic",
      "whole number",
      ...PRACTICE_DOMAINS.map((d) => d.domain),
    ]) {
      const resolved = resolvePracticeDomainSlug(input);
      expect(resolved).not.toBeNull();
      expect(REGISTERED.has(resolved as string)).toBe(true);
    }
  });
});

describe("standingPractice.listDomains", () => {
  test("returns every seeded registered domain, in registry order", async () => {
    const t = sharedSeeded();
    const user = await seedUser(t);
    const domains = await (await asUser(t, user)).query(api.standingPractice.listDomains, {});

    // seedGraph loads all registered graphs → all appear, in registry order.
    expect(domains.map((d) => d.domain)).toEqual(PRACTICE_DOMAINS.map((d) => d.domain));
    for (const d of domains) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.discipline.length).toBeGreaterThan(0);
    }
  });

  test("filters out registered domains with no seeded nodes (empty deployment → [])", async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t);
    const domains = await (await asUser(t, user)).query(api.standingPractice.listDomains, {});
    // Nothing seeded → the picker offers nothing (never an empty domain).
    expect(domains).toEqual([]);
  });
});

describe("standingPractice.domainStrandCounts", () => {
  test("returns a positive strand count for every seeded domain", async () => {
    const t = sharedSeeded();
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "count-teacher", role: "teacher" }),
    );
    const counts = await (await asUser(t, teacher)).query(
      api.standingPractice.domainStrandCounts,
      {},
    );
    // Every domain the picker lists should carry a "N strands" meta ≥ 1, and
    // it must equal the distinct-strand tally the rail would compute.
    const listed = await (await asUser(t, teacher)).query(
      api.standingPractice.listDomains,
      {},
    );
    for (const d of listed) {
      expect(counts[d.domain]).toBeGreaterThan(0);
      const strands = await (await asUser(t, teacher)).query(
        api.standingPractice.domainStrands,
        { domain: d.domain },
      );
      expect(counts[d.domain]).toBe(strands.strands.length);
    }
  });

  test("empty deployment → no counts", async () => {
    const t = convexTest(schema, modules);
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "count-teacher-2", role: "teacher" }),
    );
    const counts = await (await asUser(t, teacher)).query(
      api.standingPractice.domainStrandCounts,
      {},
    );
    expect(counts).toEqual({});
  });
});

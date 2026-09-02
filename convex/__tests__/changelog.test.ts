// Backend tests for the Workshop "What's new" changelog (convex/changelog.ts):
// the pure creditLine builder, createEntry validation + username resolution,
// listRecent ordering + creditLine shapes, and markCreditDelivered idempotence.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { creditLine } from "../changelog";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  overrides: { name?: string; username?: string; role?: string } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? "Test Scholar",
      username: overrides.username ?? "testscholar",
      role: (overrides.role ?? "scholar") as Doc<"users">["role"],
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("creditLine (pure)", () => {
  test("null when nobody is credited", () => {
    expect(creditLine([])).toBeNull();
    expect(creditLine(["", "  "])).toBeNull();
  });

  test("one credit", () => {
    expect(creditLine(["Kai N."])).toBe("Built from an idea by Kai N. 🌟");
  });

  test("two credits joined with 'and'", () => {
    expect(creditLine(["Kai N.", "Lani K."])).toBe(
      "Built from an idea by Kai N. and Lani K. 🌟",
    );
  });

  test("three+ credits use an Oxford-comma list", () => {
    expect(creditLine(["Kai N.", "Lani K.", "Sam T."])).toBe(
      "Built from an idea by Kai N., Lani K., and Sam T. 🌟",
    );
  });
});

describe("createEntry — validation + credit resolution", () => {
  test("rejects an empty title", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, { role: "teacher", username: "lehua1" });
    await expect(
      t.mutation(internal.changelog.createEntry, {
        title: "   ",
        kidBody: "We made search faster.",
        createdByUserId: author,
      }),
    ).rejects.toThrow(/title/i);
  });

  test("rejects an empty kidBody", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, { role: "teacher", username: "lehua2" });
    await expect(
      t.mutation(internal.changelog.createEntry, {
        title: "Faster search",
        kidBody: "",
        createdByUserId: author,
      }),
    ).rejects.toThrow(/body/i);
  });

  test("unknown credited username → friendly error, nothing written", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, { role: "teacher", username: "lehua3" });
    await expect(
      t.mutation(internal.changelog.createEntry, {
        title: "Night Sky mode",
        kidBody: "The Sky can go dark now.",
        creditedScholarUsernames: ["nobody_here"],
        createdByUserId: author,
      }),
    ).rejects.toThrow(/"nobody_here"/);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("changelogEntries").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("happy path resolves usernames → ids and writes ONE row", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, { role: "teacher", username: "lehua4" });
    const kai = await seedUser(t, { name: "Kai Nakamura", username: "kai4" });
    const lani = await seedUser(t, { name: "Lani Kealoha", username: "lani4" });

    const res = await t.mutation(internal.changelog.createEntry, {
      title: "Night Sky mode",
      kidBody: "The Sky can go dark now.",
      // duplicate username should be deduped
      creditedScholarUsernames: ["kai4", "lani4", "kai4"],
      createdByUserId: author,
      // Unrestricted (admin) lens — both credited scholars are in view.
      scholarLensResolved: true,
    });
    expect(res.creditedCount).toBe(2);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("changelogEntries").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Night Sky mode");
    expect(rows[0].creditedScholarIds).toEqual([kai, lani]);
    expect(rows[0].creditDelivered).toEqual([]);
    expect(rows[0].createdByUserId).toBe(author);
  });

  test("no credited usernames → an entry with zero credits", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, { role: "teacher", username: "lehua5" });
    const res = await t.mutation(internal.changelog.createEntry, {
      title: "Faster search",
      kidBody: "Search is quicker now.",
      createdByUserId: author,
    });
    expect(res.creditedCount).toBe(0);
  });

  test("an out-of-lens credited username is refused like an unknown one (no tenant leak)", async () => {
    // A REAL scholar the caller can't see. The refusal must be indistinguishable
    // from an unknown username — same "couldn't find" register — so a teacher at
    // one school can neither credit nor probe for another school's scholar.
    const t = convexTest(schema, modules);
    const author = await seedUser(t, { role: "teacher", username: "lehuaBnd" });
    const outsider = await seedUser(t, {
      name: "Briar Cove",
      username: "briar_out",
    });
    await expect(
      t.mutation(internal.changelog.createEntry, {
        title: "Night Sky mode",
        kidBody: "The Sky can go dark now.",
        creditedScholarUsernames: ["briar_out"],
        createdByUserId: author,
        // A resolved lens that does NOT include the outsider.
        allowedScholarIds: [],
        scholarLensResolved: true,
      }),
    ).rejects.toThrow(/Couldn't find[\s\S]*"briar_out"/);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("changelogEntries").collect(),
    );
    expect(rows).toHaveLength(0);
    // The outsider genuinely EXISTS — proving the "couldn't find" refusal is a
    // lens decision (indistinguishable from unknown), not a missing user.
    const outsiderDoc = await t.run(async (ctx) => ctx.db.get(outsider));
    expect(outsiderDoc?.username).toBe("briar_out");
  });

  test("fail-closed: with NO lens, even a real credited scholar is refused", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, { role: "teacher", username: "lehuaFC" });
    await seedUser(t, { name: "Kai Nakamura", username: "kai_fc" });
    await expect(
      t.mutation(internal.changelog.createEntry, {
        title: "Night Sky mode",
        kidBody: "The Sky can go dark now.",
        creditedScholarUsernames: ["kai_fc"],
        createdByUserId: author,
        // No id set AND no resolved flag → nobody is in view.
      }),
    ).rejects.toThrow(/"kai_fc"/);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("changelogEntries").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("listRecent — ordering + creditLine shapes", () => {
  test("newest first, with 0 / 1 / 2 credit-line shapes", async () => {
    const t = convexTest(schema, modules);
    const reader = await seedUser(t, { username: "reader1" });
    const kai = await seedUser(t, { name: "Kai Nakamura", username: "kai6" });
    const lani = await seedUser(t, { name: "Lani Kealoha", username: "lani6" });

    await t.run(async (ctx) => {
      await ctx.db.insert("changelogEntries", {
        title: "Oldest (no credit)",
        kidBody: "a",
        creditedScholarIds: [],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 1000,
      });
      await ctx.db.insert("changelogEntries", {
        title: "Middle (one credit)",
        kidBody: "b",
        creditedScholarIds: [kai],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 2000,
      });
      await ctx.db.insert("changelogEntries", {
        title: "Newest (two credits)",
        kidBody: "c",
        creditedScholarIds: [kai, lani],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 3000,
      });
    });

    const asReader = await withUser(t, reader);
    const rows = await asReader.query(api.changelog.listRecent, {});
    expect(rows.map((r) => r.title)).toEqual([
      "Newest (two credits)",
      "Middle (one credit)",
      "Oldest (no credit)",
    ]);
    expect(rows[0].creditLine).toBe("Built from an idea by Kai N. and Lani K. 🌟");
    expect(rows[1].creditLine).toBe("Built from an idea by Kai N. 🌟");
    expect(rows[2].creditLine).toBeNull();
  });

  test("caps at 20 newest entries", async () => {
    const t = convexTest(schema, modules);
    const reader = await seedUser(t, { username: "reader2" });
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("changelogEntries", {
          title: `Entry ${i}`,
          kidBody: "x",
          creditedScholarIds: [],
          creditDelivered: [],
          createdByUserId: reader,
          createdAt: i,
        });
      }
    });
    const asReader = await withUser(t, reader);
    const rows = await asReader.query(api.changelog.listRecent, {});
    expect(rows).toHaveLength(20);
    // Newest (createdAt 24) leads.
    expect(rows[0].title).toBe("Entry 24");
  });
});

describe("markCreditDelivered — idempotence", () => {
  test("stamps once per scholar; a second call is a no-op", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, { username: "kai7" });
    const entryId = await t.run(async (ctx) =>
      ctx.db.insert("changelogEntries", {
        title: "Night Sky mode",
        kidBody: "dark sky",
        creditedScholarIds: [kai],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 1,
      }),
    );

    await t.mutation(internal.changelog.markCreditDelivered, {
      entryIds: [entryId],
      scholarId: kai,
      at: 111,
    });
    await t.mutation(internal.changelog.markCreditDelivered, {
      entryIds: [entryId],
      scholarId: kai,
      at: 222,
    });

    const entry = await t.run(async (ctx) => ctx.db.get(entryId));
    expect(entry?.creditDelivered).toEqual([{ scholarId: kai, at: 111 }]);
  });

  test("does not stamp a scholar who isn't credited", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, { username: "kai8" });
    const other = await seedUser(t, { username: "other8" });
    const entryId = await t.run(async (ctx) =>
      ctx.db.insert("changelogEntries", {
        title: "Night Sky mode",
        kidBody: "dark sky",
        creditedScholarIds: [kai],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 1,
      }),
    );
    await t.mutation(internal.changelog.markCreditDelivered, {
      entryIds: [entryId],
      scholarId: other,
      at: 111,
    });
    const entry = await t.run(async (ctx) => ctx.db.get(entryId));
    expect(entry?.creditDelivered).toEqual([]);
  });
});

describe("undeliveredCreditsForScholar", () => {
  test("returns credits+entryIds only for undelivered, credited entries", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, { username: "kai9" });
    const other = await seedUser(t, { username: "other9" });
    const undelivered = await t.run(async (ctx) =>
      ctx.db.insert("changelogEntries", {
        title: "Undelivered for Kai",
        kidBody: "x",
        creditedScholarIds: [kai],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      // Already delivered to Kai → excluded.
      await ctx.db.insert("changelogEntries", {
        title: "Already delivered",
        kidBody: "y",
        creditedScholarIds: [kai],
        creditDelivered: [{ scholarId: kai, at: 5 }],
        createdByUserId: kai,
        createdAt: 2,
      });
      // Credits someone else → excluded.
      await ctx.db.insert("changelogEntries", {
        title: "For other",
        kidBody: "z",
        creditedScholarIds: [other],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 3,
      });
    });

    const res = await t.query(internal.changelog.undeliveredCreditsForScholar, {
      scholarId: kai,
    });
    expect(res.credits).toEqual([{ title: "Undelivered for Kai" }]);
    expect(res.entryIds).toEqual([undelivered]);
  });
});

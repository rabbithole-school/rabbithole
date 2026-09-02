// Move 5 — the canonical "Scholar's Prep" lookup (convex/lib/prepBlock.ts). The
// bell-schedule kind:"prep" block is the single source of truth for WHEN the
// ritual runs; this covers the weekday+timezone → client-window adapter, the
// deterministic multi-block pick, and the end-to-end institution window.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { Doc, Id } from "../_generated/dataModel";
import {
  canonicalPrepWindow,
  pickCanonicalPrepBlock,
  prepBlockToWindow,
} from "../lib/prepBlock";
import { isWithinPrepWindow } from "../lib/metaBlocks";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  timeZone?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli School",
      slug: `moli-${Math.random()}`,
      kind: "school",
      isPrimary: true,
      ...(timeZone ? { timeZone } : {}),
    }),
  );
}

async function seedPrep(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  over: {
    startLocal?: string;
    endLocal?: string;
    weekdays?: number[];
    label?: string;
  } = {},
) {
  await t.run(async (ctx) => {
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Term",
      startsAt: 0,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: "open",
      institutionId,
    });
    await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "scholar-practice-lab",
      label: over.label ?? "Scholar’s Prep",
      startLocal: over.startLocal ?? "14:30",
      endLocal: over.endLocal ?? "15:00",
      weekdays: over.weekdays ?? [1, 2, 3, 4],
      order: 8,
      kind: "prep",
    });
  });
}

// A minimal scheduleBlocks-shaped stub for the pure helpers.
const block = (over: Partial<Doc<"scheduleBlocks">> = {}): Doc<"scheduleBlocks"> =>
  ({
    _id: "b1" as Id<"scheduleBlocks">,
    _creationTime: 0,
    periodId: "p1" as Id<"reportingPeriods">,
    key: "scholar-practice-lab",
    label: "Scholar’s Prep",
    startLocal: "14:30",
    endLocal: "15:00",
    weekdays: [1, 2, 3, 4],
    order: 8,
    kind: "prep",
    ...over,
  }) as Doc<"scheduleBlocks">;

describe("prepBlockToWindow (the weekday + timezone adapter)", () => {
  test("maps scheduleBlocks.weekdays → window.days and stamps the timezone", () => {
    const win = prepBlockToWindow(
      { label: "Scholar’s Prep", startLocal: "14:30", endLocal: "15:00", weekdays: [1, 2, 3, 4] },
      "Pacific/Honolulu",
    );
    expect(win).toEqual({
      key: "prepTime",
      label: "Scholar’s Prep",
      startLocal: "14:30",
      endLocal: "15:00",
      days: [1, 2, 3, 4],
      timezone: "Pacific/Honolulu",
    });
  });

  test("adapted window is CLOSED outside the block's weekdays (Fri, days=Mon–Thu)", () => {
    const win = prepBlockToWindow(
      { label: "Scholar’s Prep", startLocal: "14:30", endLocal: "15:00", weekdays: [1, 2, 3, 4] },
      "Pacific/Honolulu",
    );
    // 14:45 HST inside the time-of-day window, but on a Friday — not an allowed
    // weekday (Mon–Thu) → closed.
    const friday = new Date("2026-07-04T00:45:00Z").getTime(); // 14:45 HST Fri
    expect(isWithinPrepWindow(win, friday)).toBe(false);
    // Same time-of-day on a Monday → open.
    const monday = new Date("2026-06-30T00:45:00Z").getTime(); // 14:45 HST Mon
    expect(isWithinPrepWindow(win, monday)).toBe(true);
  });
});

describe("pickCanonicalPrepBlock (deterministic, no arbitrary pick)", () => {
  test("prefers a shared block and orders by (order, startLocal, _id)", () => {
    const shared = block({ _id: "shared" as Id<"scheduleBlocks">, order: 8 });
    const groupOverride = block({
      _id: "override" as Id<"scheduleBlocks">,
      order: 1,
      groupId: "g1" as Id<"scholarGroups">,
    });
    // Even though the override has a lower order, the shared block wins.
    expect(pickCanonicalPrepBlock([groupOverride, shared])?._id).toBe("shared");
  });

  test("null on an empty set", () => {
    expect(pickCanonicalPrepBlock([])).toBeNull();
  });
});

describe("canonicalPrepWindow", () => {
  test("resolves the institution's prep block as a window (all weekdays)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "Pacific/Honolulu");
    await seedPrep(t, institutionId);
    const win = await t.run((ctx) => canonicalPrepWindow(ctx, institutionId));
    expect(win?.startLocal).toBe("14:30");
    expect(win?.days).toEqual([1, 2, 3, 4]);
    expect(win?.timezone).toBe("Pacific/Honolulu");
  });

  test("timezone falls back to Pacific/Honolulu when the institution has none", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    await seedPrep(t, institutionId);
    const win = await t.run((ctx) => canonicalPrepWindow(ctx, institutionId));
    expect(win?.timezone).toBe("Pacific/Honolulu");
  });

  test("null when the institution has no active period / no prep block", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const win = await t.run((ctx) => canonicalPrepWindow(ctx, institutionId));
    expect(win).toBeNull();
  });
});

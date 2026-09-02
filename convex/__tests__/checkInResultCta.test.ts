import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { checkInResultCtaLabel } from "../../shared/checkInResultCta";

// ─────────────────────────────────────────────────────────────────────────
// f14 — finishing the Math Check-In routes the scholar HOME (where the Tree
// reveal + playlists chooser land), not into more practice. The result-screen
// CTA's copy is honest for that destination AND reflects the once-only Tree
// reveal that greets them on home. This suite locks that contract:
//   (1) the CTA-copy helper is a pure function of `treeRevealPending`;
//   (2) it stays coupled to the REAL reveal lifecycle — pending right after the
//       check-in unlocks the Tree ("See what you unlocked"), then a plain "Back
//       to home" once the reveal has been shown (acknowledged on home).
// Frontend-only routing/labels have no component-test harness here (edge-runtime,
// no jsdom), so this drives the actual `api.mapGates` lifecycle the label reads
// from — a genuine biconditional, not a snapshot of today's copy.
// ─────────────────────────────────────────────────────────────────────────

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );
}

async function asScholar(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function addPlacement(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  await t.run(async (ctx) =>
    ctx.db.insert("practicePlacements", {
      scholarId,
      domain: "whole-number-arithmetic",
      status: "in_progress",
      probesAnswered: 0,
      updatedAt: Date.now(),
    }),
  );
}

// ── the pure helper ────────────────────────────────────────────────────────

describe("checkInResultCtaLabel", () => {
  test("invites the reveal while it's pending", () => {
    expect(checkInResultCtaLabel(true)).toBe("See what you unlocked");
  });

  test("is a plain 'Back to home' once the reveal is spent", () => {
    expect(checkInResultCtaLabel(false)).toBe("Back to home");
  });

  test("never assigns more practice (anti-punitive) and stays anti-fluff", () => {
    for (const pending of [true, false]) {
      const label = checkInResultCtaLabel(pending);
      expect(label.toLowerCase()).not.toContain("practic");
      expect(label).not.toContain("!");
    }
  });
});

// ── coupled to the real reveal lifecycle ─────────────────────────────────────

describe("check-in result CTA ↔ the Tree reveal it routes into", () => {
  test("right after the check-in unlocks the Tree, the CTA invites the (pending) reveal", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "just-checked-in");
    await addPlacement(t, scholarId); // the check-in wrote a placement row
    const me = await asScholar(t, scholarId);

    const gates = await me.query(api.mapGates.mine, {});
    expect(gates.tree).toBe(true);
    expect(gates.treeRevealPending).toBe(true);
    expect(checkInResultCtaLabel(gates.treeRevealPending)).toBe(
      "See what you unlocked",
    );
  });

  test("once the reveal has been shown on home, the CTA is a plain 'Back to home'", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "returning");
    await addPlacement(t, scholarId);
    const me = await asScholar(t, scholarId);

    // The Tree reveal card on home records itself as shown.
    await me.mutation(api.mapGates.acknowledgeReveal, { map: "tree" });

    const gates = await me.query(api.mapGates.mine, {});
    expect(gates.tree).toBe(true); // still unlocked
    expect(gates.treeRevealPending).toBe(false); // never replays
    expect(checkInResultCtaLabel(gates.treeRevealPending)).toBe("Back to home");
  });
});

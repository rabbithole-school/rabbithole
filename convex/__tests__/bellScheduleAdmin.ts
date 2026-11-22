// Test helper: run a bell-schedule mutation (createBlock / updateBlock /
// removeBlock) as a school admin of the term's school. Since 2026-11-08 only a
// school's admins (and platform admins) may change its bell schedule, so a
// fixture that used to build blocks as a teacher builds them through here. The
// admin is seeded once per (harness, school) with a real school_admin
// membership; a term with no institutionId belongs to the primary school.

import type { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";

type Harness = ReturnType<typeof convexTest>;
type Identity = ReturnType<Harness["withIdentity"]>;

const admins = new WeakMap<object, Map<string, Promise<Identity>>>();

async function institutionForArgs(
  t: Harness,
  args: { periodId?: Id<"reportingPeriods">; blockId?: Id<"scheduleBlocks"> },
): Promise<Id<"institutions">> {
  return await t.run(async (ctx) => {
    let periodId = args.periodId;
    if (!periodId && args.blockId) {
      periodId = (await ctx.db.get(args.blockId))?.periodId;
    }
    const period = periodId ? await ctx.db.get(periodId) : null;
    if (period?.institutionId) return period.institutionId;
    const primary = (await ctx.db.query("institutions").collect()).find(
      (institution) => institution.isPrimary,
    );
    if (primary) return primary._id;
    return await ctx.db.insert("institutions", {
      name: "Fixture School",
      slug: `fixture-school-${Math.random().toString(36).slice(2)}`,
      kind: "school",
      isPrimary: true,
    });
  });
}

/** Seed a school_admin of `institutionId` with a real membership. */
export async function seedSchoolAdmin(
  t: Harness,
  institutionId: Id<"institutions">,
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: `hoku-${Math.random().toString(36).slice(2)}`,
      role: "school_admin",
      institutionId,
    });
    await ctx.db.insert("memberships", { userId, role: "school_admin", institutionId });
    return userId;
  });
}

/** A school_admin identity for `institutionId`, seeded once per harness. */
export function schoolAdminOf(t: Harness, institutionId: Id<"institutions">): Promise<Identity> {
  let byInstitution = admins.get(t);
  if (!byInstitution) {
    byInstitution = new Map();
    admins.set(t, byInstitution);
  }
  let admin = byInstitution.get(String(institutionId));
  if (!admin) {
    admin = (async () => {
      const userId = await seedSchoolAdmin(t, institutionId);
      const ids = await t.run(async (ctx) => {
        const sessionId = await ctx.db.insert("authSessions", {
          userId,
          expirationTime: Date.now() + 1000 * 60 * 60,
        });
        return { userId, sessionId };
      });
      return t.withIdentity({
        subject: `${ids.userId}|${ids.sessionId}`,
        issuer: "https://convex.dev",
      });
    })();
    byInstitution.set(String(institutionId), admin);
  }
  return admin;
}

/** Run a block mutation as a school admin of the school the term belongs to. */
export async function asBellAdmin<Args extends Record<string, unknown>, R>(
  t: Harness,
  fn: FunctionReference<"mutation", "public", Args, R>,
  args: Args,
): Promise<R> {
  const institutionId = await institutionForArgs(
    t,
    args as { periodId?: Id<"reportingPeriods">; blockId?: Id<"scheduleBlocks"> },
  );
  const admin = await schoolAdminOf(t, institutionId);
  // `Args` is generic here, so spell the one-argument call explicitly.
  const call = admin.mutation as (ref: typeof fn, a: Args) => Promise<R>;
  return await call(fn, args);
}

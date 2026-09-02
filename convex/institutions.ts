// Institutions — the learning community a scholar belongs to.
//
// A heavyweight, EXCLUSIVE grouping (one per scholar via
// `users.institutionId`), distinct from the lightweight, many-membership
// `scholarGroups`. Its job: separate enrolled scholars from
// outside testers ("Guests") so most staff roster views default to the home
// school and hide guests — the fix for "the roster is 50 kids I don't know".
//
// Two audiences:
//   - Scholar-admins (teacher/admin/operations staff) read the list + assign a
//     scholar's institution — `scholarAdminQuery/Mutation`.
//   - The seed (`ensureDefaults`) is an internal one-shot run by hand /
//     from the backfill migration.
//
// See review/institutions-roster-plan.md and convex/migrations.ts
// (backfillScholarInstitutions).

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  scholarAdminQuery,
  platformAdminMutation,
  schoolAdminQuery,
  schoolAdminMutation,
  staffQuery,
  authedQuery,
} from "./lib/customFunctions";
import { ROLES } from "./lib/roles";
import {
  curatableInstitutionIds,
  requireActiveScholarAccess,
  resolveActiveMembership,
} from "./lib/access";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { assertAllowedProfileImage } from "./lib/profileImage";
import { requireTeacherOrSelf } from "./lib/auth";
import { institutionPromptProfileById } from "./lib/institutionPromptProfile";
import {
  reconcileScholarEnrollment,
  scholarIdsForInstitution,
} from "./lib/scholarEnrollment";
import {
  DEFAULT_TIMEZONE,
  institutionDayAt,
  isValidTimeZone,
} from "../shared/institutionDay";
import {
  effectiveInstitutionTimeZone,
  timeZoneForScholar,
} from "./lib/institutionTime";
import {
  assertValidRoundsAnchor,
  assertValidRoundsCadences,
  roundsAnchorFor,
  roundsCadencesFor,
} from "../lib/roundsCadence";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export { primaryInstitutionId } from "./lib/primaryInstitution";

// The seeded institutions are referenced by slug so code never depends on a
// generated id. The public Foundation defaults to the neutral Rabbithole
// institution; downstream deployments can select their own primary identity.
export let PRIMARY_SLUG = "rabbithole";
export const GUEST_SLUG = "guests";
export const ALBATROSS_SLUG = "albatross-society";

let primaryInstitution = {
  slug: PRIMARY_SLUG,
  name: "Rabbithole",
  kind: "school" as const,
  emoji: "🏫",
  isPrimary: true,
  timeZone: DEFAULT_TIMEZONE,
};


const SEED = [
  primaryInstitution,
  {
    slug: GUEST_SLUG,
    name: "Guests",
    kind: "guest" as const,
    emoji: "🧪",
    isPrimary: false,
    timeZone: DEFAULT_TIMEZONE,
  },
  {
    slug: ALBATROSS_SLUG,
    name: "Albatross Society",
    kind: "community" as const,
    emoji: "🌊",
    isPrimary: false,
    timeZone: DEFAULT_TIMEZONE,
  },
];

/** Find an institution by slug (helper for seed + migration). */
export async function getInstitutionBySlug(
  ctx: QueryCtx,
  slug: string,
) {
  return await ctx.db
    .query("institutions")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/**
 * internalQuery wrapper so a "use node" action (the weekly digests) can
 * resolve the primary institution via ctx.runQuery. Thin plumbing over the
 * plain `primaryInstitutionId` helper above — the isPrimary logic lives once.
 */
export const primaryInstitutionIdQuery = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"institutions"> | null> =>
    primaryInstitutionId(ctx),
});

/**
 * Is this institution the primary (home) school? Used to gate first-party-only
 * prompt context (e.g. the Slack aide's locked-iPad fleet-hardware facts, which
 * describe the primary school's SimpleMDM fleet specifically) so another
 * school's staff are never told the home school's device constraints as their
 * own. A null institution id (unresolved caller) is never primary.
 */
export const isPrimaryInstitution = internalQuery({
  args: { institutionId: v.union(v.id("institutions"), v.null()) },
  handler: async (ctx, { institutionId }): Promise<boolean> => {
    if (!institutionId) return false;
    const institution = await ctx.db.get(institutionId);
    return institution?.isPrimary === true;
  },
});

/**
 * Idempotently create the default institutions.
 * Safe to re-run — only inserts the rows that are missing. Returns the
 * resolved ids by slug.
 *
 *   CONVEX_DEPLOYMENT=<slug> npx convex run institutions:ensureDefaults
 */
export async function ensureDefaultsInner(ctx: MutationCtx) {
  const ids: Record<string, Id<"institutions">> = {};
  for (const inst of SEED) {
    const existing = await getInstitutionBySlug(ctx, inst.slug);
    ids[inst.slug] = existing?._id ?? (await ctx.db.insert("institutions", inst));
  }
  return ids;
}

export const ensureDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ids = await ensureDefaultsInner(ctx);
    let primaryResultKey = "primary";
    return {
      [primaryResultKey]: ids[PRIMARY_SLUG],
      guests: ids[GUEST_SLUG],
      albatross: ids[ALBATROSS_SLUG],
    };
  },
});

/**
 * List institutions with a live scholar count each, for the roster's
 * institution switcher + the Settings selector. Ordered primary first, then
 * other schools, then guests. Scholar-admin only (operations staff included).
 */
export const list = scholarAdminQuery({
  args: {},
  handler: async (ctx) => {
    // Scope the institution lens to what THIS actor may switch between: a
    // platform admin sees every institution (the cross-institution switcher); a
    // teacher/operations staff/school_admin sees only the institution(s) they're a
    // member of (so operations staff never see another school's roster). This is a
    // VISIBILITY scope for the picker — the hard per-scholar access boundary
    // lives in convex/lib/access.ts (enforcement phase, gated separately).
    const operationsInstitutionIds =
      ctx.user.schoolOperationsInstitutionIds;
    const isAdmin = operationsInstitutionIds === "all";

    const allInstitutions = await ctx.db.query("institutions").collect();
    let institutions = allInstitutions;
    if (!isAdmin) {
      institutions = allInstitutions.filter((i) =>
        operationsInstitutionIds.has(i._id),
      );
    }

    // Un-assigned scholars show under the PRIMARY institution's lens (the
    // default roster treats `institutionId === undefined` as home during the
    // transition), so count them toward the primary — otherwise the picker
    // badge undercounts the primary roster in the pre-backfill window.
    const unassignedCount = (
      await ctx.db
        .query("users")
        .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
        .collect()
    ).filter((s) => s.role === ROLES.SCHOLAR).length;
    const withCounts = await Promise.all(
      institutions.map(async (inst) => {
        let count = (await scholarIdsForInstitution(ctx, inst._id)).size;
        if (inst.isPrimary) count += unassignedCount;
        return {
          _id: inst._id,
          slug: inst.slug,
          name: inst.name,
          kind: inst.kind,
          emoji: inst.emoji ?? null,
          logoUrl: inst.logoStorageId
            ? await ctx.storage.getUrl(inst.logoStorageId)
            : null,
          isPrimary: inst.isPrimary ?? false,
          // Suspension status (temporary disable) — surfaced so the picker can
          // show a "(paused)" marker in the institution list.
          disabled: inst.disabledAt !== undefined,
          disabledAt: inst.disabledAt ?? null,
          scholarCount: count,
        };
      }),
    );
    // Primary first → other schools → guests; alpha within a tier.
    const rank = (i: (typeof withCounts)[number]) =>
      i.isPrimary ? 0 : i.kind === "school" ? 1 : 2;
    withCounts.sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
    );
    return withCounts;
  },
});

/**
 * Institution picker for the School Space editor — usable by ALL staff (the
 * `staff` gate, unlike `list`'s scholarAdminQuery which excludes
 * curriculum_designers). Returns the institutions the caller may curate:
 * a global role (platform_admin / curriculum_designer) sees every institution;
 * an institution-scoped staffer (teacher / operations staff / school_admin) sees the
 * institution(s) they're a member of, falling back to the primary. Lean shape
 * (no scholar counts) — this is a scope picker, not a roster.
 */
export const listForStaff = staffQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("institutions").collect();
    // Same scope as the school-inventory CRUD guard: global roles
    // (platform_admin / curriculum_designer) see all; institution-scoped staff
    // see their membership institution(s), falling back to the primary.
    const scope = await curatableInstitutionIds(ctx, ctx.user);
    const institutions =
      scope === "all" ? all : all.filter((i) => scope.has(i._id));

    return institutions
      .map((i) => ({
        _id: i._id,
        slug: i.slug,
        name: i.name,
        emoji: i.emoji ?? null,
        isPrimary: i.isPrimary ?? false,
        // Suspension status — lets the platform-admin pickers mark a paused
        // school in the institution list.
        disabled: i.disabledAt !== undefined,
      }))
      .sort(
        (a, b) =>
          (a.isPrimary ? 0 : 1) - (b.isPrimary ? 0 : 1) ||
          a.name.localeCompare(b.name),
      );
  },
});

/**
 * The institution settings surface edits the caller's OWN school only. A
 * school_admin is scoped by their staff membership; a platform_admin entering
 * the school shell uses the active institution lens (?inst=) — the resolver
 * only honors an institution the caller is allowed to act on, so a school_admin
 * can never use `scope` to reach another school (it falls back to their home).
 * With no `scope` (or an "all" / unhonored one) this resolves to the home
 * institution — the pre-lens behavior.
 */
export const getMySchool = schoolAdminQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution found");
    // Who paused it (name only) for the settings banner — resolved when set.
    const disabledBy =
      institution.disabledBy !== undefined
        ? await ctx.db.get(institution.disabledBy)
        : null;
    return {
      _id: institution._id,
      name: institution.name,
      emoji: institution.emoji ?? null,
      logoUrl: institution.logoStorageId
        ? await ctx.storage.getUrl(institution.logoStorageId)
        : null,
      slug: institution.slug,
      kind: institution.kind,
      isPrimary: institution.isPrimary ?? false,
      timeZone: effectiveInstitutionTimeZone(institution.timeZone),
      // Where this school's Rounds week turns over. Always resolved (never
      // raw), so a settings surface renders the anchor that is actually in
      // force rather than a blank that hides the Monday 00:00 fallback.
      roundsAnchor: roundsAnchorFor(institution),
      roundsCadences: roundsCadencesFor(institution),
      // Suspension status (temporary disable). Present == paused.
      disabled: institution.disabledAt !== undefined,
      disabledAt: institution.disabledAt ?? null,
      disabledReason: institution.disabledReason ?? null,
      disabledByName: disabledBy?.name ?? disabledBy?.username ?? null,
    };
  },
});

export const updateSettings = schoolAdminMutation({
  args: {
    name: v.string(),
    emoji: v.optional(v.union(v.string(), v.null())),
    timeZone: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("School name is required");
    const requestedTimeZone = args.timeZone?.trim();
    if (requestedTimeZone !== undefined && !isValidTimeZone(requestedTimeZone)) {
      throw new Error("Enter a valid IANA time zone");
    }

    // WRITE guard: the resolver only sets `lens.institution` to a requested
    // scope the caller is allowed to touch (admin, or a member of it). An
    // unhonored/other-school scope falls back to the caller's home institution,
    // so a school_admin can never use `scope` to edit a school they don't lead.
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution found");

    const emoji = args.emoji?.trim() || undefined;
    const timeZone = requestedTimeZone
      ?? effectiveInstitutionTimeZone(institution.timeZone);
    await ctx.db.patch(institution._id, { name, emoji, timeZone });
    return {
      _id: institution._id,
      name,
      emoji: emoji ?? null,
      slug: institution.slug,
      kind: institution.kind,
      timeZone,
    };
  },
});

/**
 * Set where this school's Rounds week turns over.
 *
 * The Rounds week is institution-anchored on purpose: one school meets on a
 * Tuesday afternoon, but that is a local habit, not a product rule, and
 * NOTHING in the product names a weekday. A school that meets Friday morning
 * sets 5 / 540 here and needs no code change.
 *
 * Out-of-range values are REJECTED rather than clamped. A typo'd anchor would
 * silently re-key the whole school's Rounds history — every stored `weekKey`
 * is derived from it, and the prior-week continuity read-back is the point of
 * a recurring meeting — so this fails loudly at the door instead.
 *
 * Tenancy: `schoolAdminMutation` checks ROLE only, so the institution is
 * resolved through the same lens `updateSettings` uses. The resolver honours a
 * requested `scope` only when the caller may actually touch it and otherwise
 * falls back to the caller's home institution, so one school can never set
 * another's anchor.
 */
export const setRoundsAnchor = schoolAdminMutation({
  args: {
    /** 0=Sunday … 6=Saturday. */
    weekday: v.number(),
    /** 0–1439 wall-clock minutes past institution-local midnight. */
    minutes: v.number(),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const anchor = assertValidRoundsAnchor({
      weekday: args.weekday,
      minutes: args.minutes,
    });

    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution found");

    const roundsCadences = institution.roundsCadences
      ? [
          { kind: "academic" as const, ...anchor },
          ...institution.roundsCadences.filter((cadence) => cadence.kind === "sel"),
        ]
      : undefined;
    await ctx.db.patch(institution._id, {
      roundsAnchorWeekday: anchor.weekday,
      roundsAnchorMinutes: anchor.minutes,
      roundsCadences,
    });
    return {
      _id: institution._id,
      slug: institution.slug,
      timeZone: effectiveInstitutionTimeZone(institution.timeZone),
      roundsAnchor: anchor,
    };
  },
});

/**
 * One-shot anchor set for an operator running the Convex CLI (`npx convex run
 * institutions:setRoundsAnchorForSlug ... --prod`).
 *
 * The CLI carries a deploy key, not a person, so `resolveInstitutionLens` has
 * no caller to scope from. Per the repo's tenancy rule, a surface with no
 * caller takes its tenant explicitly from the request and refuses an unknown
 * one — never falling back to the primary school.
 */
export const setRoundsAnchorForSlug = internalMutation({
  args: {
    slug: v.string(),
    /** 0=Sunday … 6=Saturday. */
    weekday: v.number(),
    /** 0–1439 wall-clock minutes past institution-local midnight. */
    minutes: v.number(),
  },
  handler: async (ctx, args) => {
    const anchor = assertValidRoundsAnchor({
      weekday: args.weekday,
      minutes: args.minutes,
    });

    const institution = await ctx.db
      .query("institutions")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!institution) throw new Error(`No institution with slug "${args.slug}"`);

    const roundsCadences = institution.roundsCadences
      ? [
          { kind: "academic" as const, ...anchor },
          ...institution.roundsCadences.filter((cadence) => cadence.kind === "sel"),
        ]
      : undefined;
    await ctx.db.patch(institution._id, {
      roundsAnchorWeekday: anchor.weekday,
      roundsAnchorMinutes: anchor.minutes,
      roundsCadences,
    });
    return {
      slug: institution.slug,
      timeZone: effectiveInstitutionTimeZone(institution.timeZone),
      roundsAnchor: anchor,
    };
  },
});

const roundsCadenceValidator = v.object({
  kind: v.union(v.literal("academic"), v.literal("sel")),
  weekday: v.number(),
  minutes: v.number(),
});

/** Store the full institution-owned Rounds cadence list. */
export const setRoundsCadences = schoolAdminMutation({
  args: {
    cadences: v.array(roundsCadenceValidator),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cadences = assertValidRoundsCadences(args.cadences);
    const academic = cadences.find((cadence) => cadence.kind === "academic")!;
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution found");

    // Reads prefer `roundsCadences`; mirror academic into the legacy fields
    // while old callers and the staged cleanup still depend on them.
    await ctx.db.patch(institution._id, {
      roundsCadences: cadences,
      roundsAnchorWeekday: academic.weekday,
      roundsAnchorMinutes: academic.minutes,
    });
    return {
      _id: institution._id,
      slug: institution.slug,
      timeZone: effectiveInstitutionTimeZone(institution.timeZone),
      roundsCadences: roundsCadencesFor({ ...institution, roundsCadences: cadences }),
    };
  },
});

/** Operator path: the institution is explicit and unknown slugs are refused. */
export const setRoundsCadencesForSlug = internalMutation({
  args: {
    slug: v.string(),
    cadences: v.array(roundsCadenceValidator),
  },
  handler: async (ctx, args) => {
    const cadences = assertValidRoundsCadences(args.cadences);
    const academic = cadences.find((cadence) => cadence.kind === "academic")!;
    const institution = await ctx.db
      .query("institutions")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!institution) throw new Error(`No institution with slug "${args.slug}"`);

    // Reads prefer `roundsCadences`; keep the legacy academic mirror aligned.
    await ctx.db.patch(institution._id, {
      roundsCadences: cadences,
      roundsAnchorWeekday: academic.weekday,
      roundsAnchorMinutes: academic.minutes,
    });
    return {
      slug: institution.slug,
      timeZone: effectiveInstitutionTimeZone(institution.timeZone),
      roundsCadences: roundsCadencesFor({ ...institution, roundsCadences: cadences }),
    };
  },
});

// ── Institution logo (the preferred identity mark; emoji is the fallback) ───
//
// A school_admin manages THEIR OWN institution's logo; a platform_admin any,
// via the same active-institution lens the rest of School Settings uses. The
// upload/validate/replace-cleanup pattern mirrors the profile-photo path
// (lib/profileImage.ts) and equipment photos — one storage mechanism, not a
// second: the client uploads bytes to `generateLogoUploadUrl`, then hands the
// storageId to `setLogo`. Accepted: raster image types (JPEG/PNG/WebP/GIF;
// SVG rejected) up to 5 MB — the same set + cap `assertAllowedProfileImage`
// enforces for avatars, so there is one allow-list for "images this app
// accepts".

async function deleteLogoIfUnreferenced(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
) {
  const institution = await ctx.db
    .query("institutions")
    .filter((q) => q.eq(q.field("logoStorageId"), storageId))
    .first();
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!institution && metadata) {
    await ctx.storage.delete(storageId);
  }
}

/** Upload target for a new institution logo. */
export const generateLogoUploadUrl = schoolAdminMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Set (or replace) the caller's institution logo from an uploaded blob.
 *
 * Server-validates the blob as an allowed image within the size cap. Because a
 * Convex mutation is transactional (a throw rolls back its `storage.delete`),
 * a REJECTION is returned as `{ ok: false }` rather than thrown, so the delete
 * that frees the disallowed blob actually commits — a bad upload never leaks
 * (same shape as `activityResources.registerFile`). On success, an unreferenced
 * previous logo blob is deleted so replaced marks don't accumulate orphaned storage.
 * Own-institution only — the lens resolver never honors a `scope` the caller
 * can't act on, so a school_admin can't set another school's logo (same
 * write-guard as `updateSettings`).
 */
export const setLogo = schoolAdminMutation({
  args: {
    storageId: v.id("_storage"),
    // The uploaded blob's content type. In production Convex records this from
    // the upload's Content-Type header, so `metadata.contentType` is the
    // authoritative "type Convex will serve the file as" and is what we
    // validate; this arg is the same value the client declares and is only
    // used as a fallback where the platform doesn't surface the served type.
    contentType: v.string(),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution found");

    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) {
      return { ok: false as const, error: "Uploaded logo is unavailable" };
    }
    const servedType = metadata.contentType ?? args.contentType;
    try {
      assertAllowedProfileImage(servedType, metadata.size);
    } catch (e) {
      // Return (not throw) so freeing the disallowed blob commits.
      await ctx.storage.delete(args.storageId);
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Invalid image",
      };
    }

    const previous = institution.logoStorageId;
    await ctx.db.patch(institution._id, { logoStorageId: args.storageId });
    if (previous && previous !== args.storageId) {
      await deleteLogoIfUnreferenced(ctx, previous);
    }

    return {
      ok: true as const,
      logoUrl: await ctx.storage.getUrl(args.storageId),
    };
  },
});

/**
 * Remove the caller's institution logo (falls back to the emoji mark). Deletes
 * an unreferenced blob so it doesn't leak. Own-institution only, same lens guard as above.
 */
export const removeLogo = schoolAdminMutation({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution found");

    const previous = institution.logoStorageId;
    if (previous) {
      await ctx.db.patch(institution._id, { logoStorageId: undefined });
      try {
        await deleteLogoIfUnreferenced(ctx, previous);
      } catch (error) {
        console.warn(
          `[institutions.removeLogo] storage cleanup failed for ${previous}:`,
          error,
        );
      }
    }
    return { _id: institution._id };
  },
});

/**
 * Free a logo blob that was uploaded but never attached — the RPC after the
 * upload POST failed, or the admin navigated away before `setLogo` ran. Without
 * this, every abandoned upload orphans a blob forever. Mirrors
 * `equipment.discardUpload`: a tight recency window plus a check that no
 * institution actually references the blob, so a stale or misdirected call can
 * never delete a logo in use. Best-effort — the client calls it on the failure
 * path.
 */
export const discardLogoUpload = schoolAdminMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) return;
    if (Date.now() - metadata._creationTime > 60 * 60 * 1000) {
      throw new Error("Upload cleanup window has expired");
    }
    // Never delete a blob an institution is actually using as its logo.
    const all = await ctx.db.query("institutions").collect();
    if (all.some((i) => i.logoStorageId === args.storageId)) return;
    await ctx.storage.delete(args.storageId);
  },
});

/**
 * Institution-local day context for a scholar. The client uses this once to
 * schedule its local-midnight subscription refresh; each consuming query still
 * resolves the authoritative current day on the server.
 */
export const currentDayForScholar = authedQuery({
  args: { scholarId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId ?? ctx.user._id;
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    }
    const timeZone = await timeZoneForScholar(ctx, scholarId);
    return institutionDayAt(Date.now(), timeZone);
  },
});

/**
 * Resolve an institution's prompt-identity profile from its id, for the ADULT
 * aide surfaces (curriculum bot, teacher aide, parent chat, Slack, end-of-day
 * check-in) that resolve an institution id up front and then need to render its
 * name/location/clock strings. A missing id or institution → the configured
 * primary default (byte-identical to the pre-parameterization prompts). See
 * lib/institutionPromptProfile.ts.
 */
export const promptProfile = internalQuery({
  args: { institutionId: v.union(v.id("institutions"), v.null()) },
  handler: async (ctx, { institutionId }) =>
    institutionPromptProfileById(ctx, institutionId),
});

/**
 * Resolve the prompt-identity profile the Unit Designer should render: the
 * OWNING UNIT's institution (units.institutionId), falling back to the caller's
 * active-membership institution for legacy units with no institution set, and
 * finally the configured primary default. Keeps a primary teacher's unit-designer
 * prompt byte-identical while a second school's teacher sees their own name.
 */
export const promptProfileForUnit = internalQuery({
  args: { unitId: v.id("units"), callerUserId: v.id("users") },
  handler: async (ctx, { unitId, callerUserId }) => {
    const unit = await ctx.db.get(unitId);
    let institutionId = unit?.institutionId ?? null;
    if (!institutionId) {
      const caller = await ctx.db.get(callerUserId);
      institutionId = caller
        ? (await resolveActiveMembership(ctx, caller))?.institutionId ?? null
        : null;
    }
    return institutionPromptProfileById(ctx, institutionId);
  },
});

/**
 * Assign one scholar to an institution.
 *
 * ADMIN-ONLY: once an institution is a real access boundary, moving a scholar
 * between institutions IS an access grant (it changes which staff can see
 * them), so it must not be a routine scholar-admin (teacher/operations staff) act.
 * See review/institutions-access-plan.md (finding H2).
 */
export const setScholarInstitution = platformAdminMutation({
  args: {
    scholarId: v.id("users"),
    institutionId: v.id("institutions"),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const inst = await ctx.db.get(args.institutionId);
    if (!inst) throw new Error("Institution not found");
    await reconcileScholarEnrollment(ctx, {
      scholarId: args.scholarId,
      institutionId: args.institutionId,
      createdBy: ctx.user._id,
    });
  },
});

/**
 * Assign many scholars to one institution at once — the bulk "mark these as
 * Guests" action behind the roster cleanup. Skips any id that isn't a
 * scholar. Returns how many were moved. ADMIN-ONLY (see setScholarInstitution).
 */
export const bulkSetScholarInstitution = platformAdminMutation({
  args: {
    scholarIds: v.array(v.id("users")),
    institutionId: v.id("institutions"),
  },
  handler: async (ctx, args) => {
    if (args.scholarIds.length > 100) {
      throw new Error("Move at most 100 scholars at a time.");
    }
    const inst = await ctx.db.get(args.institutionId);
    if (!inst) throw new Error("Institution not found");
    let moved = 0;
    for (const id of args.scholarIds) {
      const scholar = await ctx.db.get(id);
      if (!scholar || scholar.role !== ROLES.SCHOLAR) continue;
      await reconcileScholarEnrollment(ctx, {
        scholarId: id,
        institutionId: args.institutionId,
        createdBy: ctx.user._id,
      });
      moved++;
    }
    return { moved };
  },
});

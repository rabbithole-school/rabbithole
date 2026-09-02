// Fictional multi-context dev cast (DEV ONLY).
//
// The seed needs people who wear more than one hat, so the context/persona
// switcher has something real to switch between — and so dev never shows real
// family identities:
//   • Avery + Ursula Stone — parents of Oliver Stone
//   • Sloane Kahale — Staff with school operations + scoped curriculum/program access @ Moli
//                     School AND parent
//                     of Kai + Lani Kahale
//   • Lehua Torres  — teacher @ Moli School AND Kona Tutoring
//   • Hoku Makani   — school_admin @ Moli School (the primary; undeletable)
//   • Kalei Aki     — school_admin @ Kona Tutoring (non-primary; sole membership,
//                     so deleting Kona deletes Kalei — exercises self-delete)
//
// Most scholars live at Moli School (the dev primary); Lehua has two scholars
// enrolled at Kona Tutoring so the staff context switcher can flip between
// two real institution scopes. Idempotent on username and on the (parent,
// scholar) pair, so it's safe to re-run and safe to run after seedData:seedAll
// (which creates the Avery admin) or standalone.
//
// NEVER runs on prod: it would attach parent contexts to the real admin and
// create fictional scholars. Real families are onboarded
// separately (seed/enrolledFamilies), with NO usernames (see TODO.html
// "Rationalize how scholars/parents claim accounts on prod").

import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { ROLES } from "../lib/roles";
import { ensureMembership } from "../memberships";
import { ensureActiveStaffCapabilityGrant } from "../lib/staffCapabilities";
import { ensureDevInstitutions } from "./institutions";

/** Dev-only guard — never reshape prod identities. */
function isProdDeployment(): boolean {
  const configuredMarker = process.env.PRODUCTION_DEPLOYMENT_MARKER;
  if (configuredMarker) {
    return process.env.CONVEX_CLOUD_URL?.includes(configuredMarker) ?? false;
  }
  if (!process.env.CONVEX_CLOUD_URL) return false;
  return true;
}

async function userByUsername(ctx: MutationCtx, username: string) {
  return ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("username", username))
    .unique();
}

async function assignSeededProgramAccess(
  ctx: MutationCtx,
  args: {
    institutionId: Id<"institutions">;
    type: string;
    granteeUserId: Id<"users">;
  },
): Promise<void> {
  const groups = await ctx.db
    .query("scholarGroups")
    .withIndex("by_institution", (q) =>
      q.eq("institutionId", args.institutionId),
    )
    .collect();
  const group = groups.find(
    (candidate) =>
      candidate.type?.trim().toLowerCase() === args.type.toLowerCase(),
  );
  if (!group) return;
  if (group.ownerId !== args.granteeUserId) {
    await ctx.db.patch(group._id, { ownerId: args.granteeUserId });
  }
  // The timetable avatar represents the assigned instructor, not the group's
  // authorization owner. Keep the seeded program handoff coherent on both
  // surfaces instead of leaving the rich fixture's placeholder teacher behind.
  const placements = await ctx.db.query("schedulePlacements").collect();
  for (const placement of placements) {
    if (
      placement.groupId === group._id &&
      placement.teacherId !== args.granteeUserId
    ) {
      await ctx.db.patch(placement._id, { teacherId: args.granteeUserId });
    }
  }
  await ensureActiveStaffCapabilityGrant(ctx, {
    granteeUserId: args.granteeUserId,
    institutionId: args.institutionId,
    capability: "curriculum:edit",
    grantedBy: args.granteeUserId,
  });
  for (const capability of ["program:publish", "captures:review"] as const) {
    await ensureActiveStaffCapabilityGrant(ctx, {
      granteeUserId: args.granteeUserId,
      institutionId: args.institutionId,
      capability,
      scholarGroupId: group._id,
      grantedBy: args.granteeUserId,
    });
  }
}

/** Find-or-create a Moli scholar; keep their institution + membership in sync. */
async function ensureScholar(
  ctx: MutationCtx,
  args: {
    username: string;
    name: string;
    institutionId: Id<"institutions">;
    gradeLevel: string;
    dob: string;
  },
): Promise<Id<"users">> {
  const existing = await userByUsername(ctx, args.username);
  const id =
    existing?._id ??
    (await ctx.db.insert("users", {
      username: args.username,
      name: args.name,
      role: ROLES.SCHOLAR,
      institutionId: args.institutionId,
      gradeLevel: args.gradeLevel,
      dateOfBirth: args.dob,
      profileSetupComplete: true,
    }));
  if (existing && existing.institutionId !== args.institutionId) {
    await ctx.db.patch(id, { institutionId: args.institutionId });
  }
  await ensureMembership(ctx, {
    userId: id,
    role: ROLES.SCHOLAR,
    institutionId: args.institutionId,
  });
  return id;
}


/** Idempotent guardianship link (at most one row per parent↔scholar pair). */
async function ensureGuardian(
  ctx: MutationCtx,
  parentId: Id<"users">,
  scholarId: Id<"users">,
): Promise<void> {
  const dupe = await ctx.db
    .query("guardianships")
    .withIndex("by_pair", (q) =>
      q.eq("parentUserId", parentId).eq("scholarUserId", scholarId),
    )
    .first();
  if (!dupe) {
    await ctx.db.insert("guardianships", {
      parentUserId: parentId,
      scholarUserId: scholarId,
      createdBy: parentId,
    });
  }
}

export const seedDevPersonas = internalMutation({
  handler: async (ctx) => {
    if (isProdDeployment()) {
      console.log("seedDevPersonas: skipped (prod).");
      return;
    }
    const { moli, konaTutoring, albatross } =
      await ensureDevInstitutions(ctx);

    // ── Avery Stone: PLATFORM ADMIN (global) + parent of Oliver Stone ─────
    // seedData:seedAll creates the "avery" platform-admin; reuse it. If a seed
    // ran before this cast existed, fall back to creating the admin here.
    const avery = await userByUsername(ctx, "avery");
    const averyId =
      avery?._id ??
      (await ctx.db.insert("users", {
        username: "avery",
        name: "Avery Stone",
        role: ROLES.PLATFORM_ADMIN,
      }));
    await ensureMembership(ctx, { userId: averyId, role: ROLES.PLATFORM_ADMIN });
    await ensureMembership(ctx, { userId: averyId, role: ROLES.PARENT });
    // Adult learning is an ordinary scholar context in a real community, so it
    // reuses assignments, roster review, Slack routing, and cost attribution.
    await ensureMembership(ctx, {
      userId: averyId,
      role: ROLES.SCHOLAR,
      institutionId: albatross,
    });
    const oliver = await ensureScholar(ctx, {
      username: "oliver_stone",
      name: "Oliver Stone",
      institutionId: moli,
      gradeLevel: "3",
      dob: "2018-02-03",
    });
    await ensureGuardian(ctx, averyId, oliver);
    const ursula = await userByUsername(ctx, "ursula");
    const ursulaId =
      ursula?._id ??
      (await ctx.db.insert("users", {
        username: "ursula",
        name: "Ursula Stone",
        email: "ursula.stone@example.org",
        role: ROLES.PARENT,
      }));
    if (ursula?.email !== "ursula.stone@example.org") {
      await ctx.db.patch(ursulaId, {
        name: "Ursula Stone",
        email: "ursula.stone@example.org",
      });
    }
    await ensureMembership(ctx, { userId: ursulaId, role: ROLES.PARENT });
    await ensureGuardian(ctx, ursulaId, oliver);
    // Second child of Avery — a launcher-linked dev seat.
    const mendez = await ensureScholar(ctx, {
      username: "oliver_mendez",
      name: "Oliver Mendez",
      institutionId: moli,
      gradeLevel: "5",
      dob: "2016-05-20",
    });
    await ensureGuardian(ctx, averyId, mendez);

    // ── Sloane Kahale: Staff with narrow Moli capabilities + parent ───────
    const sloane = await userByUsername(ctx, "sloane");
    const sloaneId =
      sloane?._id ??
      (await ctx.db.insert("users", {
        username: "sloane",
        name: "Sloane Kahale",
        email: "sloane@moli.school",
        role: ROLES.STAFF,
        emailVerificationTime: Date.now(), // pre-verified dev staff email
      }));
    await ensureMembership(ctx, {
      userId: sloaneId,
      role: ROLES.STAFF,
      institutionId: moli,
    });
    const legacyDesignerMemberships = await ctx.db
      .query("memberships")
      .withIndex("by_user_role", (q) =>
        q
          .eq("userId", sloaneId)
          .eq("role", ROLES.CURRICULUM_DESIGNER),
      )
      .collect();
    for (const membership of legacyDesignerMemberships) {
      if (membership.institutionId === moli) await ctx.db.delete(membership._id);
    }
    await ensureMembership(ctx, { userId: sloaneId, role: ROLES.PARENT });
    await ensureActiveStaffCapabilityGrant(ctx, {
      granteeUserId: sloaneId,
      institutionId: moli,
      capability: "school:operations",
      grantedBy: sloaneId,
    });
    // Front-desk operations staff also manage health/emergency records — the
    // capability that the previous role-based access used to imply.
    await ensureActiveStaffCapabilityGrant(ctx, {
      granteeUserId: sloaneId,
      institutionId: moli,
      capability: "health:manage",
      grantedBy: sloaneId,
    });
    // Scoped grants keep curriculum and Robotics publishing/captures separate
    // from teacher-wide scholar access. ownerId remains routing metadata only.
    await assignSeededProgramAccess(ctx, {
      institutionId: moli,
      type: "robotics",
      granteeUserId: sloaneId,
    });
    const kai = await ensureScholar(ctx, {
      username: "kai_kahale",
      name: "Kai Kahale",
      institutionId: moli,
      gradeLevel: "3",
      dob: "2017-05-12",
    });
    const lani = await ensureScholar(ctx, {
      username: "lani_kahale",
      name: "Lani Kahale",
      institutionId: moli,
      gradeLevel: "1",
      dob: "2019-09-03",
    });
    await ensureGuardian(ctx, sloaneId, kai);
    await ensureGuardian(ctx, sloaneId, lani);

    // ── Lehua Torres: teacher @ Moli + Kona Tutoring ──────────────────
    const lehua = await userByUsername(ctx, "lehua");
    const lehuaId =
      lehua?._id ??
      (await ctx.db.insert("users", {
        username: "lehua",
        name: "Lehua Torres",
        email: "lehua@moli.school",
        role: ROLES.TEACHER,
        emailVerificationTime: Date.now(),
      }));
    await ensureMembership(ctx, {
      userId: lehuaId,
      role: ROLES.TEACHER,
      institutionId: moli,
    });
    await ensureMembership(ctx, {
      userId: lehuaId,
      role: ROLES.TEACHER,
      institutionId: konaTutoring,
    });
    await ensureScholar(ctx, {
      username: "noe_tutoring",
      name: "Noe Tanaka",
      institutionId: konaTutoring,
      gradeLevel: "4",
      dob: "2016-11-18",
    });
    await ensureScholar(ctx, {
      username: "emi_tutoring",
      name: "Emi Park",
      institutionId: konaTutoring,
      gradeLevel: "5",
      dob: "2015-08-22",
    });

    // ── Hoku Makani: SCHOOL ADMIN @ Moli (institution leader) ──────────────
    // Exercises the school_admin role: teacher + scholar-admin + curriculum
    // power scoped to ONE institution, with NO platform power (no /admin
    // console, no cross-institution access). "Head of School" in spirit; the
    // permission is the capability `school_admin`.
    const hoku = await userByUsername(ctx, "hoku");
    const hokuId =
      hoku?._id ??
      (await ctx.db.insert("users", {
        username: "hoku",
        name: "Hoku Makani",
        email: "hoku@moli.school",
        role: ROLES.SCHOOL_ADMIN,
        emailVerificationTime: Date.now(), // pre-verified dev staff email
      }));
    await ensureMembership(ctx, {
      userId: hokuId,
      role: ROLES.SCHOOL_ADMIN,
      institutionId: moli,
    });

    // ── Kalei Aki: SCHOOL ADMIN @ Kona Tutoring (non-primary) ──────────────
    // The one dev fixture that can delete their OWN school: Kona Tutoring is
    // non-primary (so it's deletable), and Kalei's SOLE membership is there, so
    // deleting Kona deletes Kalei's account too (deletingSelf=true). This is
    // what exercises DeleteSchoolDialog's sign-out → /school-deleted path.
    const kalei = await userByUsername(ctx, "kalei");
    const kaleiId =
      kalei?._id ??
      (await ctx.db.insert("users", {
        username: "kalei",
        name: "Kalei Aki",
        email: "kalei@kona-tutoring.school",
        role: ROLES.SCHOOL_ADMIN,
        emailVerificationTime: Date.now(), // pre-verified dev staff email
      }));
    await ensureMembership(ctx, {
      userId: kaleiId,
      role: ROLES.SCHOOL_ADMIN,
      institutionId: konaTutoring,
    });

    console.log(
      "seedDevPersonas: Avery + Ursula (parents→Oliver), Sloane (Staff+parent with school operations and scoped Robotics capabilities→Kai,Lani) @ Moli, Lehua (teacher @ Moli + Kona Tutoring), Hoku (school_admin @ Moli), Kalei (school_admin @ Kona Tutoring).",
    );
  },
});

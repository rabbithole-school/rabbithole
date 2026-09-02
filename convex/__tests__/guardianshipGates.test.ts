import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  grantInstitutionMembership,
  grantStaffCapability,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the `parent` role must see ONLY its own linked children's
// non-sensitive data — never another family's child, never a sensitive
// surface, never anything if it isn't actually a guardian. The gate is
// `requireGuardianOf`. These tests pin: who can create/link parents
// (scholar-admin only — including operations staff, the retired registrar
// role's successor), that guardian reads are scoped to the link, and that
// non-guardians / non-parents are refused.

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "curriculum_designer"
  | "staff"
  | "parent";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  email?: string,
) {
  const institutionId = await seedTestInstitution(t);
  if (role === "teacher" || role === "staff") {
    const userId = await seedStaffWithMembership(t, {
      institutionId,
      role,
      name: `Test ${username}`,
      username,
    });
    if (role === "staff") {
      await grantStaffCapability(t, userId, institutionId, "school:operations");
    }
    if (email) await t.run((ctx) => ctx.db.patch(userId, { email }));
    return userId;
  }
  if (role === "scholar") {
    const userId = await seedScholarInInstitution(t, {
      institutionId,
      name: `Test ${username}`,
      username,
    });
    if (email) await t.run((ctx) => ctx.db.patch(userId, { email }));
    return userId;
  }
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role, email }),
  );
  if (role === "platform_admin") {
    await grantInstitutionMembership(t, userId, institutionId, "school_admin");
  }
  return userId;
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

// ── Creating parents + links (scholar-admin only) ─────────────────────

describe("parents.createParent — scholar-admin gated", () => {
  test("operations staff can create a parent + link to scholars", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    const { parentId } = await asReg.mutation(api.parents.createParent, {
      name: "Pat Parent",
      email: "  Pat@Home.COM ",
      scholarIds: [kai],
    });
    const parent = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(parent?.role).toBe("parent");
    expect(parent?.email).toBe("pat@home.com"); // normalized
    expect(parent?.emailVerificationTime).toBeGreaterThan(0); // pre-verified
    // ...and the guardianship link exists.
    const linked = await t.run(async (ctx) =>
      ctx.db
        .query("guardianships")
        .withIndex("by_pair", (q) =>
          q.eq("parentUserId", parentId).eq("scholarUserId", kai),
        )
        .first(),
    );
    expect(linked).not.toBeNull();
  });

  test("a scholar cannot create a parent", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.parents.createParent, {
        name: "X",
        email: "x@home.com",
        scholarIds: [],
      }),
    ).rejects.toThrow(/scholar-admin/i);
  });

  test("rejects a parent account with no linked child", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const asAdmin = await withUser(t, admin);

    await expect(
      asAdmin.mutation(api.parents.createParent, {
        name: "Unlinked Parent",
        email: "unlinked@home.com",
        scholarIds: [],
      }),
    ).rejects.toThrow(/choose at least one child/i);

    const parent = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "unlinked@home.com"))
        .unique(),
    );
    expect(parent).toBeNull();
  });

  test("operations staff cannot link a parent to another school's scholar", async () => {
    const t = convexTest(schema, modules);
    const home = await seedTestInstitution(t, {
      name: "Home School",
      slug: "home-school",
      isPrimary: true,
    });
    const other = await seedTestInstitution(t, {
      name: "Other School",
      slug: "other-school",
    });
    const staff = await seedStaffWithMembership(t, {
      institutionId: home,
      role: "staff",
      username: "home-ops",
    });
    await grantStaffCapability(t, staff, home, "school:operations");
    const foreignScholar = await seedScholarInInstitution(t, {
      institutionId: other,
      username: "foreign-scholar",
    });
    const asStaff = await withUser(t, staff);

    await expect(
      asStaff.mutation(api.parents.createParent, {
        name: "Foreign Parent",
        email: "foreign@home.com",
        scholarIds: [foreignScholar],
      }),
    ).rejects.toThrow(/not in your current context/i);
  });

  test("rejects a NON-admin scholar-admin reusing a non-parent account's email", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "staff", "reg");
    await seedUser(t, "teacher", "t", "taken@school.org");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.parents.createParent, {
        name: "X",
        email: "taken@school.org",
        scholarIds: [kai],
      }),
    ).rejects.toThrow(/non-parent account/i);
  });

  test("an ADMIN may link an existing non-parent (staff) account as a guardian", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const staff = await seedUser(t, "teacher", "t", "staff@school.org");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "Staff Parent",
      email: "staff@school.org",
      scholarIds: [kai],
    });
    // Reused the staff account; primary role unchanged.
    expect(parentId).toBe(staff);
    const reused = await t.run((ctx) => ctx.db.get(staff));
    expect(reused?.role).toBe("teacher");
    // Guardianship + a `parent` membership were granted.
    const link = await t.run((ctx) =>
      ctx.db
        .query("guardianships")
        .withIndex("by_pair", (q) =>
          q.eq("parentUserId", staff).eq("scholarUserId", kai),
        )
        .first(),
    );
    expect(link).toBeTruthy();
    const memberships = await t.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", staff)).collect(),
    );
    expect(memberships.some((m) => m.role === "parent")).toBe(true);
  });

  test("an admin may NOT link a SCHOLAR account as a guardian (no scholar-to-scholar access)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    // A scholar with an email (e.g. a school-issued address).
    await seedUser(t, "scholar", "kid", "kid@school.org");
    const target = await seedUser(t, "scholar", "target");
    const asAdmin = await withUser(t, admin);
    await expect(
      asAdmin.mutation(api.parents.createParent, {
        name: "Sneaky",
        email: "kid@school.org",
        scholarIds: [target],
      }),
    ).rejects.toThrow(/non-parent account/i);
  });

  test("scholar-admin can issue a parent enroll link; rejects non-parent + non-admin", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "staff", "reg");
    await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    const { parentId } = await asReg.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    // Operations staff issues a one-time /enroll link for the parent (email-free login path).
    const link = await asReg.mutation(api.enrollment.issueParentEnrollLink, {
      parentId,
    });
    expect(link.path).toMatch(/^\/enroll\?token=/);
    // Not a parent → refused.
    await expect(
      asReg.mutation(api.enrollment.issueParentEnrollLink, { parentId: kai }),
    ).rejects.toThrow(/parent not found/i);
    // Non-scholar-admin (the scholar) → refused by the gate.
    const asKai = await withUser(t, kai);
    await expect(
      asKai.mutation(api.enrollment.issueParentEnrollLink, { parentId }),
    ).rejects.toThrow(/scholar-admin/i);
  });

  test("linking is idempotent on the (parent, scholar) pair", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    await asAdmin.mutation(api.parents.linkGuardian, { parentId, scholarId: kai });
    const count = await t.run(async (ctx) =>
      ctx.db
        .query("guardianships")
        .withIndex("by_pair", (q) =>
          q.eq("parentUserId", parentId).eq("scholarUserId", kai),
        )
        .collect(),
    );
    expect(count.length).toBe(1);
  });
});

// ── Guardian-scoped reads ─────────────────────────────────────────────

describe("requireGuardianOf — reads scoped to the link", () => {
  test("a linked parent reads their child; an unlinked parent cannot", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    const asParent = await withUser(t, parentId);

    // Own child: OK
    await expect(
      asParent.query(api.parents.childSummary, { scholarId: kai }),
    ).resolves.not.toThrow;
    // Another family's child: refused
    await expect(
      asParent.query(api.parents.childSummary, { scholarId: lani }),
    ).rejects.toThrow(/not a guardian/i);
  });

  test("childSummary never leaks the dossier to a parent", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    // Give the scholar a dossier — getScholarSummary would otherwise include it.
    await t.run(async (ctx) =>
      ctx.db.insert("scholarDossiers", {
        scholarId: kai,
        content: "SENSITIVE synthesized profile",
      }),
    );
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    const asParent = await withUser(t, parentId);
    const summary = await asParent.query(api.parents.childSummary, {
      scholarId: kai,
    });
    expect(summary).not.toBeNull();
    // The dossier field must be absent from the parent-facing payload.
    expect(summary).not.toHaveProperty("dossier");
    expect(JSON.stringify(summary)).not.toContain("SENSITIVE");
  });

  test("a teacher who is NOT a guardian cannot use the parent reads", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.query(api.parents.childMastery, { scholarId: kai }),
    ).rejects.toThrow(/not a guardian/i);
  });

  test("a teacher who IS a guardian CAN use the parent reads for their own child", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const teacher = await seedUser(t, "teacher", "t", "tg@school.org");
    const kai = await seedUser(t, "scholar", "kai");
    // Admin links the teacher as a guardian of kai.
    await (await withUser(t, admin)).mutation(api.parents.createParent, {
      name: "Teacher Guardian",
      email: "tg@school.org",
      scholarIds: [kai],
    });
    const asTeacher = await withUser(t, teacher);
    // childMastery no longer throws for this guardian (returns a portrait).
    const mastery = await asTeacher.query(api.parents.childMastery, { scholarId: kai });
    expect(mastery).toBeTruthy();
    // ...but NOT for a scholar they don't guard.
    const other = await seedUser(t, "scholar", "other");
    await expect(
      asTeacher.query(api.parents.childMastery, { scholarId: other }),
    ).rejects.toThrow(/not a guardian/i);
  });

  test("childMastery splits into understands vs. not-yet (honest portrait, no Bloom chip)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");

    // Insert four current (non-superseded) observations for one scholar:
    //  • a demonstration  → understands
    //  • a reasoning row   → understands (seed uses evidenceType values beyond
    //                        the observer enum, so anything non-misconception counts)
    //  • an OPEN misconception → notYet (the honest "doesn't understand yet")
    //  • an ADDRESSED misconception → dropped (no longer a current gap)
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: kai,
        title: "S",
        isArchived: false,
      });
      const base = {
        scholarId: kai,
        domain: "mathematics",
        observedAt: Date.now(),
        sessionId,
        transcriptExcerpt: "…",
        confidenceScore: 0.8,
        attemptContext: "conversation",
        studentInitiated: false,
        isSuperseded: false,
      };
      await ctx.db.insert("masteryObservations", {
        ...base,
        conceptLabel: "fraction equivalence",
        masteryLevel: 4,
        evidenceSummary: "Built an equal-parts argument for 1/2 = 2/4 unprompted.",
        evidenceType: "direct_demonstration",
      });
      await ctx.db.insert("masteryObservations", {
        ...base,
        conceptLabel: "equal parts",
        masteryLevel: 2,
        evidenceSummary: "Sometimes checks that pieces are equal-sized.",
        evidenceType: "reasoning",
      });
      await ctx.db.insert("masteryObservations", {
        ...base,
        conceptLabel: "counts pieces, ignores equal-size",
        masteryLevel: 1,
        evidenceSummary: "Calls any 2-of-4 split '2/4' regardless of piece size.",
        evidenceType: "misconception_signal",
        misconceptionStatus: "open" as const,
        misconceptionNote: "Treats fractions as pure counting.",
      });
      await ctx.db.insert("masteryObservations", {
        ...base,
        conceptLabel: "already-fixed misconception",
        masteryLevel: 1,
        evidenceSummary: "Old confusion, since un-taught.",
        evidenceType: "misconception_signal",
        misconceptionStatus: "addressed" as const,
      });
    });

    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    const asParent = await withUser(t, parentId);
    const mastery = await asParent.query(api.parents.childMastery, {
      scholarId: kai,
    });

    const math = mastery["mathematics"];
    expect(math).toBeDefined();
    // Understands: the two non-misconception concepts, deepest first.
    expect(math.understands.map((u) => u.concept)).toEqual([
      "fraction equivalence",
      "equal parts",
    ]);
    // Not-yet: the OPEN misconception only — addressed one is dropped.
    expect(math.notYet.map((n) => n.concept)).toEqual([
      "counts pieces, ignores equal-size",
    ]);
    expect(math.notYet[0].note).toBe("Treats fractions as pure counting.");
    // No Bloom label leaks into the parent payload.
    expect(JSON.stringify(mastery)).not.toMatch(/Apply|Analyze|Evaluate|Bloom/);
  });

  test("listMyChildren returns only the parent's linked scholars", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai, lani],
    });
    const asParent = await withUser(t, parentId);
    const kids = await asParent.query(api.parents.listMyChildren, {});
    expect(kids.map((k) => k._id).sort()).toEqual([kai, lani].sort());
  });

  test("a non-parent gets [] from listMyChildren (no throw)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const asTeacher = await withUser(t, teacher);
    expect(await asTeacher.query(api.parents.listMyChildren, {})).toEqual([]);
  });

  test("portfolio.listForGuardian is scoped to the link", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    const asParent = await withUser(t, parentId);
    await expect(
      asParent.query(api.portfolio.listForGuardian, { scholarId: kai }),
    ).resolves.toBeInstanceOf(Array);
    await expect(
      asParent.query(api.portfolio.listForGuardian, { scholarId: lani }),
    ).rejects.toThrow(/not a guardian/i);
  });
});

// ── unlink ────────────────────────────────────────────────────────────

describe("parents.unlinkGuardian", () => {
  test("removes access", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      scholarIds: [kai],
    });
    await asAdmin.mutation(api.parents.unlinkGuardian, { parentId, scholarId: kai });
    const asParent = await withUser(t, parentId);
    await expect(
      asParent.query(api.parents.childSummary, { scholarId: kai }),
    ).rejects.toThrow(/not a guardian/i);
  });
});

// ── Phase A gate now lights up for parents ────────────────────────────

describe("magic-link eligibility includes parents", () => {
  test("a parent with an email is magic-link eligible", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "parent", "p", "parent@home.com");
    const ok = await t.run(async (ctx) =>
      ctx.runQuery(internal.users.isMagicLinkEligible, {
        email: "parent@home.com",
      }),
    );
    expect(ok).toBe(true);
  });
});

// ── Parent contact info (email / phone / address) + the staff directory ──
// Rabbithole is the school's system of record for parent contact. The HARD
// invariant: a parent must NEVER see another parent's address (custody /
// safety) — not even a co-guardian of the same scholar. The directory that
// exposes addresses is STAFF-ONLY (scholar-admin gate).

describe("parent contact info + the /admin directory", () => {
  test("createParent stores phone + address; listAllParents shows them with children", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "Pat Parent",
      email: "pat@home.com",
      phone: " (808) 555-0123 ",
      address: " 1 Beach Rd, Honolulu HI ",
      scholarIds: [kai],
    });
    const parent = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(parent?.phone).toBe("(808) 555-0123"); // trimmed
    expect(parent?.address).toBe("1 Beach Rd, Honolulu HI"); // trimmed

    const directory = await asAdmin.query(api.parents.listAllParents, {});
    const row = directory.find((p) => p._id === parentId);
    expect(row).toBeDefined();
    expect(row?.phone).toBe("(808) 555-0123");
    expect(row?.address).toBe("1 Beach Rd, Honolulu HI");
    expect(row?.children.map((c) => c._id)).toEqual([kai]);
  });

  test("updateParent edits contact fields; empty string clears phone/address", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      phone: "111",
      address: "Old Address",
      scholarIds: [kai],
    });
    await asAdmin.mutation(api.parents.updateParent, {
      parentId,
      phone: "222",
      address: "", // clears
    });
    const parent = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(parent?.phone).toBe("222");
    expect(parent?.address).toBeUndefined();
  });

  test("the staff directory is scholar-admin gated — a parent can't read it", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    const { parentId } = await asAdmin.mutation(api.parents.createParent, {
      name: "P",
      email: "p@home.com",
      address: "Secret Address",
      scholarIds: [kai],
    });
    const asParent = await withUser(t, parentId);
    await expect(
      asParent.query(api.parents.listAllParents, {}),
    ).rejects.toThrow(/scholar-admin/i);
    await expect(
      asParent.query(api.parents.listForScholar, { scholarId: kai }),
    ).rejects.toThrow(/scholar-admin/i);
  });

  test("custody: a parent never sees a co-guardian's address through any parent-facing read", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);

    // Two guardians of the SAME scholar (the custody case).
    const ADDR_A = "111 Parent-A Street";
    const ADDR_B = "999 Parent-B Avenue";
    const { parentId: parentA } = await asAdmin.mutation(
      api.parents.createParent,
      {
        name: "Parent A",
        email: "a@home.com",
        address: ADDR_A,
        scholarIds: [kai],
      },
    );
    await asAdmin.mutation(api.parents.createParent, {
      name: "Parent B",
      email: "b@home.com",
      address: ADDR_B,
      scholarIds: [kai],
    });
    const parentB = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "b@home.com"))
        .unique(),
    ).then((u) => u!._id);

    const asParentA = await withUser(t, parentA);
    // Exercise every parent-facing read parent A can reach for their child…
    const payloads = await Promise.all([
      asParentA.query(api.parents.listMyChildren, {}),
      asParentA.query(api.parents.childSummary, { scholarId: kai }),
      asParentA.query(api.parents.childSessions, { scholarId: kai }),
      asParentA.query(api.parents.childMastery, { scholarId: kai }),
      asParentA.query(api.parents.childSignals, { scholarId: kai }),
      asParentA.query(api.parents.childSeeds, { scholarId: kai }),
    ]);
    const blob = JSON.stringify(payloads);
    // …and assert NO address (their own OR the co-guardian's) ever leaks.
    expect(blob).not.toContain(ADDR_B);
    expect(blob).not.toContain(ADDR_A);

    // Belt-and-suspenders: the shared `users.getUser` (an authedQuery any
    // parent can call with an arbitrary id) must be projected — never the raw
    // doc — so it can't hand parent A parent B's contact info even given B's id.
    const probe = await asParentA.query(api.users.getUser, { userId: parentB });
    expect(probe).not.toHaveProperty("address");
    expect(probe).not.toHaveProperty("phone");
    expect(probe).not.toHaveProperty("email");
    expect(JSON.stringify(probe)).not.toContain(ADDR_B);
  });
});

describe("parent CONTEXT (guardianship-based, multi-role)", () => {
  test("hasParentContext: true for a parent-role user, true for a staff guardian, false otherwise", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const parent = await seedUser(t, "parent", "p"); // childless parent-role
    const teacher = await seedUser(t, "teacher", "t", "tg@s.org");
    const plainTeacher = await seedUser(t, "teacher", "plain");
    const kai = await seedUser(t, "scholar", "kai");
    // Link the teacher as a guardian of kai.
    await (await withUser(t, admin)).mutation(api.parents.createParent, {
      name: "Teacher Guardian",
      email: "tg@s.org",
      scholarIds: [kai],
    });

    expect(await (await withUser(t, parent)).query(api.parents.hasParentContext, {})).toBe(true);
    expect(await (await withUser(t, teacher)).query(api.parents.hasParentContext, {})).toBe(true);
    expect(await (await withUser(t, plainTeacher)).query(api.parents.hasParentContext, {})).toBe(false);
  });

  test("a staff guardian's listMyChildren returns their own child", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const teacher = await seedUser(t, "teacher", "t", "tg@s.org");
    const kai = await seedUser(t, "scholar", "kai");
    await (await withUser(t, admin)).mutation(api.parents.createParent, {
      name: "Teacher Guardian",
      email: "tg@s.org",
      scholarIds: [kai],
    });
    const kids = await (await withUser(t, teacher)).query(api.parents.listMyChildren, {});
    expect(kids.map((k) => k._id)).toEqual([kai]);
  });
});

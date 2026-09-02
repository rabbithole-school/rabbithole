import { convexTest } from "convex-test";
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { emptyHealthRecordFields } from "../lib/healthRecord";
import {
  grantInstitutionMembership,
  grantStaffAccessToScholars,
  grantStaffCapability,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Concrete, fully-typed convexTest instance — used to derive a precise helper
// param type (ReturnType<typeof convexTest> alone drops our custom indexes).
const makeTestConvex = () => convexTest(schema, modules);

// Why this file: teacher↔parent messaging must (a) let any teacher message a
// scholar's guardians in one family thread, (b) scope every parent read/write
// to threads they participate in, and (c) let parents start + reply.

type Role = "scholar" | "teacher" | "platform_admin" | "staff" | "parent";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  name?: string,
  email?: string,
  slackUserId?: string,
) {
  const institutionId = await seedTestInstitution(t, {
    slug: "parent-messages-fixture",
  });
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: name ?? `Test ${username}`,
      username,
      role,
      email,
      slackUserId,
      ...(role === "scholar" ? { institutionId } : {}),
    }),
  );
  if (role === "teacher" || role === "staff") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  // A base `staff` fixture in this file stands in for the retired `registrar`
  // role (family-comms staff): give it the `school:operations` capability so
  // it keeps the same real-world access the tests pin.
  if (role === "staff") {
    await grantStaffCapability(t, userId, institutionId, "school:operations");
  }
  return userId;
}

async function link(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"users">,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId: parentId,
      scholarUserId: scholarId,
      createdBy: parentId,
    }),
  );
}

async function grantMediaConsent(
  t: ReturnType<typeof convexTest>,
  guardianId: Id<"users">,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) => {
    const scholar = await ctx.db.get(scholarId);
    const now = Date.now();
    await ctx.db.insert("scholarHealthRecords", {
      scholarId,
      guardianId,
      ...emptyHealthRecordFields({
        childName: scholar?.name ?? "Scholar",
        guardianName: "Parent",
      }),
      signerName: "Parent",
      signerAgreement: true,
      signerUserId: guardianId,
      signedAt: now,
      submittedAt: now,
      standardProgramAcknowledgedAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
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

describe("parentMessages — send + thread creation", () => {
  test("validates every selected family before creating a bulk-send thread", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "atomic-send-teacher");
    const linkedScholar = await seedUser(t, "scholar", "atomic-send-linked");
    const unlinkedScholar = await seedUser(t, "scholar", "atomic-send-unlinked");
    const parent = await seedUser(t, "parent", "atomic-send-parent");
    await link(t, parent, linkedScholar);

    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.parentMessages.sendMessage, {
        body: "One family is missing",
        scholarIds: [linkedScholar, unlinkedScholar],
      }),
    ).rejects.toThrow(/no linked parents/i);

    await expect(
      t.run((ctx) => ctx.db.query("parentThreads").collect()),
    ).resolves.toEqual([]);
    await expect(
      t.run((ctx) => ctx.db.query("parentMessages").collect()),
    ).resolves.toEqual([]);
  });

  test("ordinary family audiences exclude program guests until explicitly included", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "audience-teacher");
    const enrolled = await seedUser(t, "scholar", "audience-enrolled", "Enrolled Scholar");
    const guest = await seedUser(t, "scholar", "audience-guest", "Robotics Guest");
    const enrolledParent = await seedUser(t, "parent", "enrolled-parent", "Enrolled Parent");
    const guestParent = await seedUser(t, "parent", "guest-parent-2", "Guest Parent");
    await link(t, enrolledParent, enrolled);
    await link(t, guestParent, guest);
    await t.run((ctx) =>
      ctx.db.patch(guest, { enrollmentStanding: "program_guest" }),
    );

    const asTeacher = await withUser(t, teacher);
    const defaultPreview = await asTeacher.query(
      api.parentMessages.resolveRecipients,
      { scholarIds: [enrolled, guest] },
    );
    expect(defaultPreview.parents.map((parent) => parent.parentUserId)).toEqual([
      enrolledParent,
    ]);

    const defaultSend = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Ordinary school update",
      scholarIds: [enrolled, guest],
    });
    expect(defaultSend.recipientCount).toBe(1);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("parentThreads")
          .withIndex("by_parent", (q) => q.eq("parentUserId", guestParent))
          .collect(),
      ),
    ).toHaveLength(0);

    const programSend = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Robotics update",
      scholarId: guest,
      includeProgramGuests: true,
    });
    expect(programSend.recipientCount).toBe(1);
  });

  test("program-guest parents can address only the child's program teacher", async () => {
    const t = convexTest(schema, modules);
    const programTeacher = await seedUser(t, "teacher", "robotics", "Robotics Teacher");
    const schoolTeacher = await seedUser(t, "teacher", "school", "School Teacher");
    const groupCreator = await seedUser(t, "staff", "creator", "Group Creator");
    const scholar = await seedUser(t, "scholar", "guest", "Guest Scholar");
    const parent = await seedUser(t, "parent", "guest-parent", "Guest Parent");
    await link(t, parent, scholar);
    const institutionId = await t.run(async (ctx) => {
      const row = await ctx.db.get(scholar);
      if (!row?.institutionId) throw new Error("Missing institution");
      await ctx.db.patch(scholar, { enrollmentStanding: "program_guest" });
      await ctx.db.insert("scholarGroups", {
        teacherId: groupCreator,
        ownerId: programTeacher,
        institutionId: row.institutionId,
        name: "Robotics",
        type: "robotics",
        scholarIds: [scholar],
      });
      await ctx.db.insert("scholarGroups", {
        teacherId: groupCreator,
        ownerId: groupCreator,
        institutionId: row.institutionId,
        name: "Robotics operations",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      });
      await ctx.db.insert("scholarGroups", {
        teacherId: schoolTeacher,
        institutionId: row.institutionId,
        name: "Legacy creator-only group",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      });
      return row.institutionId;
    });
    expect(institutionId).toBeTruthy();

    const asParent = await withUser(t, parent);
    expect(
      await asParent.query(api.parentMessages.listParentRecipientTeachers, {
        scholarId: scholar,
      }),
    ).toEqual([
      { _id: groupCreator, name: "Group Creator" },
      { _id: programTeacher, name: "Robotics Teacher" },
    ]);
    await expect(
      asParent.mutation(api.parentMessages.startThread, {
        body: "Question",
        scholarId: scholar,
        as: "parent",
      }),
    ).rejects.toThrow(/program teacher/i);
    await expect(
      asParent.mutation(api.parentMessages.startThread, {
        body: "Question",
        scholarId: scholar,
        teacherId: schoolTeacher,
        as: "parent",
      }),
    ).rejects.toThrow(/not available/i);
    await expect(
      asParent.mutation(api.parentMessages.startThread, {
        body: "Question",
        scholarId: scholar,
        teacherId: programTeacher,
        as: "parent",
      }),
    ).resolves.toMatchObject({ threadId: expect.any(String) });
  });

  test("a teacher messages a scholar's guardians; thread + message + portal delivery exist", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const pat = await seedUser(t, "parent", "pat", "Pat");
    await link(t, pat, kai);

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Hi Pat — great moment with Kai today!",
      scholarId: kai,
    });
    expect(res.recipientCount).toBe(1);
    expect(res.broadcastId).toBeNull();

    const threads = await t.run(async (ctx) =>
      ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", pat))
        .collect(),
    );
    expect(threads.length).toBe(1);
    expect(threads[0].scholarId).toBe(kai);

    const msgs = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threads[0]._id))
        .collect(),
    );
    expect(msgs.length).toBe(1);
    expect(msgs[0].authorType).toBe("teacher");

    const deliveries = await t.run(async (ctx) =>
      ctx.db
        .query("messageDeliveries")
        .withIndex("by_message", (q) => q.eq("messageId", msgs[0]._id))
        .collect(),
    );
    expect(deliveries.map((d) => d.channel)).toEqual(["portal"]);
    expect(deliveries[0].status).toBe("sent");
  });

  test("New message creates a distinct thread while Reply stays in its thread", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const pat = await seedUser(t, "parent", "pat", "Pat");
    await link(t, pat, kai);
    const asTeacher = await withUser(t, teacher);

    const first = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "First topic",
      scholarId: kai,
    });
    const second = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Separate topic",
      scholarId: kai,
    });

    expect(second.threadIds[0]).not.toBe(first.threadIds[0]);
    await asTeacher.mutation(api.parentMessages.replyInThread, {
      threadId: first.threadIds[0],
      body: "Follow-up on the first topic",
      as: "staff",
    });

    const threads = await t.run((ctx) =>
      ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", pat))
        .collect(),
    );
    expect(threads).toHaveLength(2);
    const firstMessages = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) =>
          q.eq("threadId", first.threadIds[0]),
        )
        .collect(),
    );
    expect(firstMessages.map((message) => message.body)).toEqual([
      "First topic",
      "Follow-up on the first topic",
    ]);
  });

  test("a parent's New message also creates a distinct thread", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const pat = await seedUser(
      t,
      "parent",
      "pat",
      "Pat",
      "pat@home.com",
    );
    await link(t, pat, kai);
    const asParent = await withUser(t, pat);

    const first = await asParent.mutation(api.parentMessages.startThread, {
      body: "Question one",
      scholarId: kai,
      as: "parent",
    });
    const second = await asParent.mutation(api.parentMessages.startThread, {
      body: "A separate question",
      scholarId: kai,
      as: "parent",
    });

    expect(second.threadId).not.toBe(first.threadId);
  });

  test("operations staff (the family-comms staff role) can message guardians and see the thread", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "staff", "reg");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const pat = await seedUser(t, "parent", "pat", "Pat");
    await link(t, pat, kai);

    const asReg = await withUser(t, reg);
    const res = await asReg.mutation(api.parentMessages.sendMessage, {
      body: "Hi Pat — a note from the office.",
      scholarId: kai,
    });
    expect(res.recipientCount).toBe(1);

    // Operations staff must NOT fall into the empty-staff-list branch of
    // listMyThreads — they see the family thread they just created.
    const threads = await asReg.query(api.parentMessages.listMyThreads, {});
    expect(threads.length).toBe(1);
    expect(threads[0].scholarName).toBe("Kai");
  });

  test("institution-scoped staff inboxes retain program-guest family threads", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "program-inbox-teacher");
    const guest = await seedUser(t, "scholar", "program-inbox-guest", "Guest Scholar");
    const parent = await seedUser(t, "parent", "program-inbox-parent", "Guest Parent");
    await link(t, parent, guest);
    await t.run((ctx) =>
      ctx.db.patch(guest, { enrollmentStanding: "program_guest" }),
    );

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Program update",
      scholarId: guest,
      includeProgramGuests: true,
    });

    await expect(
      asTeacher.query(api.parentMessages.listMyThreads, {
        institutionScope: "",
      }),
    ).resolves.toMatchObject([{ scholarName: "Guest Scholar" }]);
  });

  test("a staff member who is also a guardian still resolves as a recipient (role ≠ parent)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    // Sloane is OPERATIONS STAFF (base `staff` + `school:operations` — the
    // retired registrar role's successor) who is ALSO Kai's guardian
    // (multi-context: the real staff-who-is-also-a-parent case). She must not
    // be dropped from the recipient set.
    const sloane = await seedUser(t, "staff", "sloane", "Sloane", "sloane@x.school");
    await link(t, sloane, kai);

    const asTeacher = await withUser(t, teacher);
    const preview = await asTeacher.query(api.parentMessages.resolveRecipients, {
      scholarIds: [kai],
    });
    expect(preview.parents.map((p) => p.email)).toContain("sloane@x.school");
    expect(preview.unlinkedScholarNames).toEqual([]);
  });

  test("a parent can list only teachers in their child's institution", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teacher", "Teacher A");
    await seedUser(t, "staff", "opsStaff", "Ops Staff");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const pat = await seedUser(t, "parent", "pat", "Pat");
    const unrelated = await seedUser(t, "parent", "other", "Other Parent");
    await link(t, pat, kai);

    const otherInstitution = await seedTestInstitution(t, {
      slug: "parent-messages-other-school",
    });
    const otherTeacher = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Teacher B",
        username: "teacher-b",
        role: "teacher",
      }),
    );
    await grantInstitutionMembership(
      t,
      otherTeacher,
      otherInstitution,
      "teacher",
    );

    const asPat = await withUser(t, pat);
    const teachers = await asPat.query(
      api.parentMessages.listParentRecipientTeachers,
      { scholarId: kai },
    );
    expect(teachers).toEqual([{ _id: teacher, name: "Teacher A" }]);

    const asUnrelated = await withUser(t, unrelated);
    await expect(
      asUnrelated.query(api.parentMessages.listParentRecipientTeachers, {
        scholarId: kai,
      }),
    ).rejects.toThrow(/guardian|access|forbidden/i);
  });

  test("a parent can address an institution teacher or the shared school inbox", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teacher", "Teacher A");
    const opsStaff = await seedUser(t, "staff", "opsStaff", "Ops Staff");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const pat = await seedUser(t, "parent", "pat", "Pat");
    await link(t, pat, kai);
    const asPat = await withUser(t, pat);

    const directed = await asPat.mutation(api.parentMessages.startThread, {
      body: "For Teacher A",
      scholarId: kai,
      teacherId: teacher,
      as: "parent",
    });
    const shared = await asPat.mutation(api.parentMessages.startThread, {
      body: "For the school team",
      scholarId: kai,
      as: "parent",
    });

    expect(shared.threadId).not.toBe(directed.threadId);
    expect(
      await t.run(async (ctx) => ctx.db.get(directed.threadId)),
    ).toMatchObject({ teacherId: teacher, scholarId: kai });
    expect(
      await t.run(async (ctx) => ctx.db.get(shared.threadId)),
    ).toMatchObject({ scholarId: kai });
    await expect(
      asPat.mutation(api.parentMessages.startThread, {
        body: "Wrong recipient",
        scholarId: kai,
        teacherId: opsStaff,
        as: "parent",
      }),
    ).rejects.toThrow(/not available/i);
  });

  test("staff guardians see their own family threads in the parent surface", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const oliver = await seedUser(t, "scholar", "oliver", "Oliver Stone");
    const sloane = await seedUser(t, "staff", "sloane", "Sloane");
    const avery = await seedUser(t, "platform_admin", "avery", "Avery");
    await link(t, sloane, kai);
    await link(t, avery, oliver);

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Hi Sloane — Kai had a great day.",
      scholarId: kai,
    });
    await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Hi Avery — Oliver had a great day.",
      scholarId: oliver,
    });

    const asSloane = await withUser(t, sloane);
    const sloaneParentThreads = await asSloane.query(
      api.parentMessages.listMyGuardianThreads,
      {},
    );
    expect(sloaneParentThreads).toHaveLength(1);
    expect(sloaneParentThreads[0].scholarName).toBe("Kai");
    expect(sloaneParentThreads[0].hasUnread).toBe(true);

    const asAvery = await withUser(t, avery);
    const averyParentThreads = await asAvery.query(
      api.parentMessages.listMyGuardianThreads,
      {},
    );
    expect(averyParentThreads).toHaveLength(1);
    expect(averyParentThreads[0].scholarName).toBe("Oliver Stone");
    expect(averyParentThreads[0].hasUnread).toBe(true);
  });

  test("staff guardian thread viewing is surface-based, not role-based", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const sloane = await seedUser(t, "staff", "sloane", "Sloane");
    await link(t, sloane, kai);

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Hi Sloane — a note from Kai's teacher.",
      scholarId: kai,
    });
    const thread = await t.run(async (ctx) =>
      ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", sloane))
        .first(),
    );

    const asSloane = await withUser(t, sloane);
    const parentView = await asSloane.query(api.parentMessages.getThread, {
      threadId: thread!._id,
      as: "parent",
    });
    expect(parentView!.viewer).toBe("parent");
    // /teacher is unchanged: the same staff user still gets the staff branch.
    expect(await asSloane.query(api.parentMessages.listMyThreads, {})).toEqual([]);
    const staffThreads = await asSloane.query(api.parentMessages.listMyThreads, {
      scope: "all",
    });
    expect(staffThreads).toHaveLength(1);
    const staffView = await asSloane.query(api.parentMessages.getThread, {
      threadId: thread!._id,
      as: "staff",
    });
    expect(staffView!.viewer).toBe("teacher");

    await asSloane.mutation(api.parentMessages.replyInThread, {
      threadId: thread!._id,
      body: "Thanks — parent-context reply.",
      as: "parent",
    });
    const afterParentReply = await asSloane.query(api.parentMessages.getThread, {
      threadId: thread!._id,
      as: "parent",
    });
    expect(afterParentReply!.messages.map((m) => m.authorType)).toEqual([
      "teacher",
      "parent",
    ]);
  });

  test("a non-guardian passed via parentIds is NOT resolved as a recipient", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const guardian = await seedUser(t, "parent", "guard", "Guard", "guard@x.com");
    await link(t, guardian, kai);
    // A parent-role account with NO guardianship, hand-supplied via parentIds.
    const stranger = await seedUser(t, "parent", "stranger", "Stranger", "stranger@x.com");

    const asTeacher = await withUser(t, teacher);
    const preview = await asTeacher.query(api.parentMessages.resolveRecipients, {
      scholarIds: [kai],
      parentIds: [stranger],
    });
    const emails = preview.parents.map((p) => p.email);
    expect(emails).toContain("guard@x.com"); // the real guardian
    expect(emails).not.toContain("stranger@x.com"); // the non-guardian is dropped
  });

  test("parentIds-only sends require an accessible child at the caller's institution", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "tenant-teacher");
    const localScholar = await seedUser(t, "scholar", "tenant-local");
    const localParent = await seedUser(t, "parent", "tenant-local-parent");
    await link(t, localParent, localScholar);
    const foreignInstitutionId = await seedTestInstitution(t, {
      slug: "parent-message-foreign",
    });
    const foreignScholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Foreign Scholar",
        username: "parent-message-foreign-scholar",
        role: "scholar",
        institutionId: foreignInstitutionId,
      }),
    );
    const foreignParent = await seedUser(t, "parent", "tenant-foreign-parent");
    await link(t, foreignParent, foreignScholar);
    const asTeacher = await withUser(t, teacher);

    await expect(
      asTeacher.query(api.parentMessages.resolveRecipients, {
        parentIds: [foreignParent],
      }),
    ).rejects.toThrow(/current school context/i);
    await expect(
      asTeacher.mutation(api.parentMessages.sendMessage, {
        body: "Cross-tenant message",
        parentIds: [foreignParent],
      }),
    ).rejects.toThrow(/current school context/i);
    await expect(
      asTeacher.mutation(api.parentMessages.sendMessage, {
        body: "Local message",
        parentIds: [localParent],
      }),
    ).resolves.toMatchObject({ recipientCount: 1 });
  });

  test("direct parent threads recheck their guardian institution for listing and replies", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "multi-school-teacher");
    const foreignInstitutionId = await seedTestInstitution(t, {
      slug: "direct-thread-foreign",
    });
    await grantInstitutionMembership(t, teacher, foreignInstitutionId, "teacher");
    const foreignScholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Foreign Scholar",
        username: "direct-thread-foreign-scholar",
        role: "scholar",
        institutionId: foreignInstitutionId,
      }),
    );
    const foreignParent = await seedUser(t, "parent", "direct-thread-parent");
    await link(t, foreignParent, foreignScholar);
    const asTeacher = await withUser(t, teacher);
    const sent = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Foreign direct message",
      parentIds: [foreignParent],
    });
    const threadId = sent.threadIds[0]!;

    await t.run((ctx) =>
      ctx.db.patch(foreignInstitutionId, { disabledAt: Date.now() }),
    );
    const asForeignParent = await withUser(t, foreignParent);
    await expect(
      asForeignParent.query(api.parentMessages.listParentRecipientTeachers, {
        scholarId: foreignScholar,
      }),
    ).rejects.toThrow(/school is unavailable/i);
    await expect(
      asTeacher.mutation(api.parentMessages.replyInThread, {
        threadId,
        body: "This is no longer allowed",
        as: "staff",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asTeacher.query(api.parentMessages.listMyThreads, { scope: "all" }),
    ).resolves.not.toContainEqual(expect.objectContaining({ _id: threadId }));
  });

  test("a dual-school guardian's parent-only thread stays anchored to its sending school", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedTestInstitution(t, {
      slug: "direct-thread-school-a",
    });
    const schoolB = await seedTestInstitution(t, {
      slug: "direct-thread-school-b",
    });
    const teacherA = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "School A teacher",
        username: "direct-thread-teacher-a",
        role: "teacher",
      });
      await ctx.db.insert("memberships", {
        userId,
        role: "teacher",
        institutionId: schoolA,
      });
      return userId;
    });
    const teacherB = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "School B teacher",
        username: "direct-thread-teacher-b",
        role: "teacher",
      });
      await ctx.db.insert("memberships", {
        userId,
        role: "teacher",
        institutionId: schoolB,
      });
      return userId;
    });
    const parent = await seedUser(t, "parent", "dual-school-thread-parent");
    const [scholarA, scholarB] = await t.run(async (ctx) => [
      await ctx.db.insert("users", {
        name: "School A child",
        username: "dual-school-thread-child-a",
        role: "scholar",
        institutionId: schoolA,
      }),
      await ctx.db.insert("users", {
        name: "School B child",
        username: "dual-school-thread-child-b",
        role: "scholar",
        institutionId: schoolB,
      }),
    ]);
    await link(t, parent, scholarA);
    await link(t, parent, scholarB);

    const asTeacherB = await withUser(t, teacherB);
    await expect(
      asTeacherB.query(api.parentMessages.resolveRecipients, {
        scholarId: scholarB,
      }),
    ).resolves.toMatchObject({
      parents: [expect.objectContaining({ parentUserId: parent })],
    });
    const sent = await asTeacherB.mutation(api.parentMessages.sendMessage, {
      body: "School B direct message",
      parentIds: [parent],
    });
    const threadId = sent.threadIds[0]!;
    const thread = await t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.scholarId).toBeUndefined();
    expect(thread?.institutionId).toBe(schoolB);

    const asTeacherA = await withUser(t, teacherA);
    await expect(
      asTeacherA.query(api.parentMessages.listMyThreads, { scope: "all" }),
    ).resolves.not.toContainEqual(expect.objectContaining({ _id: threadId }));
    await expect(
      asTeacherA.mutation(api.parentMessages.replyInThread, {
        threadId,
        body: "School A must not reply",
        as: "staff",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asTeacherB.mutation(api.parentMessages.replyInThread, {
        threadId,
        body: "School B may reply",
        as: "staff",
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("a scholar cannot send", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const asKai = await withUser(t, kai);
    await expect(
      asKai.mutation(api.parentMessages.sendMessage, { body: "x", parentIds: [] }),
    ).rejects.toThrow(/teacher|forbidden/i);
  });

  test("sending to a selection with no linked parents throws", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai"); // no guardian
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.parentMessages.sendMessage, { body: "hi", scholarId: kai }),
    ).rejects.toThrow(/no linked parents/i);
  });
});

describe("parentMessages — attachments", () => {
  test("staff can reuse only a ready portfolio item for its scholar without cleanup deleting it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "portfolio-teacher");
    const kai = await seedUser(t, "scholar", "portfolio-kai");
    const lani = await seedUser(t, "scholar", "portfolio-lani");
    const parent = await seedUser(
      t,
      "parent",
      "portfolio-parent",
      "Portfolio Parent",
      "portfolio@example.com",
    );
    await link(t, parent, kai);
    await link(t, parent, lani);
    await grantMediaConsent(t, parent, kai);
    await grantMediaConsent(t, parent, lani);
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [kai, lani],
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["portfolio work"], { type: "application/pdf" })),
    );
    const itemId = await t.run(async (ctx) =>
      ctx.db.insert("portfolioItems", {
        scholarId: kai,
        title: "field-notes.pdf",
        source: "manual",
        fileStorageId: storageId,
        fileMimeType: "application/pdf",
        fileSizeBytes: 14,
        matchStatus: "confirmed",
        assignmentStatus: "none",
        familyVisibility: "attributed_families",
        processingStatus: "ready",
      }),
    );
    await t.run(async (ctx) => {
      for (const scholarId of [kai, lani]) {
        await ctx.db.insert("portfolioAttributions", {
          portfolioItemId: itemId,
          scholarId,
          attributedAt: Date.now(),
          attributedBy: teacher,
        });
      }
    });
    const asTeacher = await withUser(t, teacher);
    const staged = await asTeacher.mutation(
      api.parentMessages.registerPortfolioAttachment,
      { portfolioItemId: itemId, scholarId: kai },
    );
    expect(staged.storageId).toBe(storageId);

    await expect(
      (await withUser(t, parent)).mutation(
        api.parentMessages.registerPortfolioAttachment,
        { portfolioItemId: itemId, scholarId: kai },
      ),
    ).rejects.toThrow(/forbidden|role/i);
    await asTeacher.mutation(api.parentMessages.discardAttachmentUpload, {
      attachmentId: staged.attachmentId,
    });
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
    ).not.toBeNull();

    const attached = await asTeacher.mutation(
      api.parentMessages.registerPortfolioAttachment,
      { portfolioItemId: itemId, scholarId: kai },
    );
    await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "A portfolio file",
      scholarId: kai,
      attachmentIds: [attached.attachmentId],
    });
    const [row] = await t.run((ctx) =>
      ctx.db.query("parentMessageAttachments").collect(),
    );
    expect(row).toMatchObject({
      source: "portfolio",
      portfolioItemId: itemId,
      storageId,
    });
    const sharedForLani = await asTeacher.mutation(
      api.parentMessages.registerPortfolioAttachment,
      { portfolioItemId: itemId, scholarId: lani },
    );
    expect(sharedForLani.storageId).toBe(storageId);
    await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Shared portfolio file",
      scholarId: lani,
      attachmentIds: [sharedForLani.attachmentId],
    });

    const legacyItemId = await t.run((ctx) =>
      ctx.db.insert("portfolioItems", {
        scholarId: kai,
        title: "legacy-family-visible.pdf",
        source: "manual",
        fileStorageId: storageId,
        fileMimeType: "application/pdf",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
      }),
    );
    const legacyAttachment = await asTeacher.mutation(
      api.parentMessages.registerPortfolioAttachment,
      { portfolioItemId: legacyItemId, scholarId: kai },
    );
    await asTeacher.mutation(api.parentMessages.discardAttachmentUpload, {
      attachmentId: legacyAttachment.attachmentId,
    });

    const staffOnlyItemId = await t.run((ctx) =>
      ctx.db.insert("portfolioItems", {
        scholarId: kai,
        title: "staff-only.pdf",
        source: "manual",
        fileStorageId: storageId,
        fileMimeType: "application/pdf",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        familyVisibility: "staff_only",
        processingStatus: "ready",
      }),
    );
    await expect(
      asTeacher.mutation(api.parentMessages.registerPortfolioAttachment, {
        portfolioItemId: staffOnlyItemId,
        scholarId: kai,
      }),
    ).rejects.toThrow(/not available/i);

    const hiddenItemId = await t.run(async (ctx) =>
      ctx.db.insert("portfolioItems", {
        scholarId: kai,
        title: "still-processing.pdf",
        source: "manual",
        fileStorageId: storageId,
        fileMimeType: "application/pdf",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "pending",
      }),
    );
    await expect(
      asTeacher.mutation(api.parentMessages.registerPortfolioAttachment, {
        portfolioItemId: hiddenItemId,
        scholarId: kai,
      }),
    ).rejects.toThrow(/not available/i);

    const orphanStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["orphan"], { type: "application/pdf" })),
    );
    const orphanItemId = await t.run((ctx) =>
      ctx.db.insert("portfolioItems", {
        scholarId: kai,
        title: "temporary.pdf",
        source: "manual",
        fileStorageId: orphanStorageId,
        fileMimeType: "application/pdf",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        familyVisibility: "attributed_families",
        processingStatus: "ready",
      }),
    );
    const orphanAttachment = await asTeacher.mutation(
      api.parentMessages.registerPortfolioAttachment,
      { portfolioItemId: orphanItemId, scholarId: kai },
    );
    await asTeacher.mutation(api.portfolio.deleteItem, { itemId: orphanItemId });
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", orphanStorageId)),
    ).not.toBeNull();
    await asTeacher.mutation(api.parentMessages.discardAttachmentUpload, {
      attachmentId: orphanAttachment.attachmentId,
    });
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", orphanStorageId)),
    ).toBeNull();
  });

  test("staff can send an attachment-only message that participants can view", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "lehua", "Lehua Torres");
    const kai = await seedUser(t, "scholar", "kai", "Kai Kahale");
    const parent = await seedUser(
      t,
      "parent",
      "sloane",
      "Sloane Kahale",
      "sloane@example.com",
    );
    const otherParent = await seedUser(t, "parent", "other", "Other Parent");
    await link(t, parent, kai);
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [kai],
    });

    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob(["photo"], { type: "image/jpeg" }),
      ),
    );
    const asTeacher = await withUser(t, teacher);
    const { attachmentId } = await asTeacher.mutation(
      api.parentMessages.registerAttachmentUpload,
      {
        storageId,
        fileName: "tide-pool.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 5,
      },
    );
    const sent = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "",
      scholarId: kai,
      attachmentIds: [attachmentId],
    });
    const [threadId] = sent.threadIds;

    const [summary] = await asTeacher.query(
      api.parentMessages.listMyThreads,
      {},
    );
    expect(summary.lastPreview).toBe("Photo");
    const staffAttachments = await asTeacher.query(
      api.parentMessages.getThreadAttachments,
      { threadId, as: "staff" },
    );
    expect(staffAttachments).toHaveLength(1);
    expect(staffAttachments[0]).toMatchObject({
      fileName: "tide-pool.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 5,
      url: expect.any(String),
    });

    const asParent = await withUser(t, parent);
    await expect(
      asParent.query(api.parentMessages.getThreadAttachments, {
        threadId,
        as: "parent",
      }),
    ).resolves.toMatchObject([
      { fileName: "tide-pool.jpg", url: expect.any(String) },
    ]);
    await expect(
      (await withUser(t, otherParent)).query(
        api.parentMessages.getThreadAttachments,
        { threadId, as: "parent" },
      ),
    ).rejects.toThrow(/forbidden/i);
  });

  test("parents lose portfolio attachment URLs when visibility or attribution changes", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "portfolio-url-teacher");
    const scholar = await seedUser(t, "scholar", "portfolio-url-scholar");
    const parent = await seedUser(t, "parent", "portfolio-url-parent");
    await link(t, parent, scholar);
    await grantMediaConsent(t, parent, scholar);
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [scholar],
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["portfolio"], { type: "application/pdf" })),
    );
    const itemId = await t.run(async (ctx) => {
      const itemId = await ctx.db.insert("portfolioItems", {
        scholarId: scholar,
        title: "portfolio.pdf",
        source: "manual",
        fileStorageId: storageId,
        fileMimeType: "application/pdf",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
        familyVisibility: "attributed_families",
      });
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId: scholar,
        attributedAt: Date.now(),
      });
      return itemId;
    });
    const asTeacher = await withUser(t, teacher);
    const { attachmentId } = await asTeacher.mutation(
      api.parentMessages.registerPortfolioAttachment,
      { portfolioItemId: itemId, scholarId: scholar },
    );
    const { threadIds } = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Portfolio update",
      scholarId: scholar,
      attachmentIds: [attachmentId],
    });
    const [threadId] = threadIds;
    const asParent = await withUser(t, parent);
    expect(
      await asParent.query(api.parentMessages.getThreadAttachments, {
        threadId,
        as: "parent",
      }),
    ).toHaveLength(1);

    await t.run((ctx) =>
      ctx.db.patch(itemId, { familyVisibility: "staff_only" }),
    );
    expect(
      await asParent.query(api.parentMessages.getThreadAttachments, {
        threadId,
        as: "parent",
      }),
    ).toEqual([]);

    await t.run(async (ctx) => {
      await ctx.db.patch(itemId, {
        familyVisibility: "attributed_families",
        scholarId: undefined,
      });
      const attribution = await ctx.db
        .query("portfolioAttributions")
        .withIndex("by_item_scholar", (q) =>
          q.eq("portfolioItemId", itemId).eq("scholarId", scholar),
        )
        .unique();
      if (!attribution) throw new Error("Missing attribution");
      await ctx.db.delete(attribution._id);
    });
    expect(
      await asParent.query(api.parentMessages.getThreadAttachments, {
        threadId,
        as: "parent",
      }),
    ).toEqual([]);
  });

  test("a parent can start and reply with attachment-only messages", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai", "Kai Kahale");
    const parent = await seedUser(
      t,
      "parent",
      "sloane",
      "Sloane Kahale",
      "sloane@example.com",
    );
    await link(t, parent, kai);
    const asParent = await withUser(t, parent);

    const register = async (name: string, type: string) => {
      const storageId = await t.run((ctx) =>
        ctx.storage.store(new Blob([name], { type })),
      );
      return await asParent.mutation(
        api.parentMessages.registerAttachmentUpload,
        {
          storageId,
          fileName: name,
          mimeType: type,
          sizeBytes: name.length,
        },
      );
    };

    const photo = await register("sketch.png", "image/png");
    const { threadId } = await asParent.mutation(
      api.parentMessages.startThread,
      {
        body: "",
        scholarId: kai,
        attachmentIds: [photo.attachmentId],
        as: "parent",
      },
    );
    const notes = await register("field-notes.pdf", "application/pdf");
    await asParent.mutation(api.parentMessages.replyInThread, {
      threadId,
      body: "",
      attachmentIds: [notes.attachmentId],
      as: "parent",
    });

    const detail = await asParent.query(
      api.parentMessages.getThreadAttachments,
      { threadId, as: "parent" },
    );
    expect(detail.map((attachment) => attachment.fileName)).toEqual([
      "sketch.png",
      "field-notes.pdf",
    ]);
  });

  test("broadcasts reuse one upload safely and another user cannot claim it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "lehua", "Lehua Torres");
    const otherTeacher = await seedUser(
      t,
      "teacher",
      "hoku",
      "Hoku Makani",
    );
    const kai = await seedUser(t, "scholar", "kai", "Kai Kahale");
    const lani = await seedUser(t, "scholar", "lani", "Lani Kahale");
    const kaiParent = await seedUser(
      t,
      "parent",
      "kai-parent",
      "Kai Parent",
      "kai@example.com",
    );
    const laniParent = await seedUser(
      t,
      "parent",
      "lani-parent",
      "Lani Parent",
      "lani@example.com",
    );
    await link(t, kaiParent, kai);
    await link(t, laniParent, lani);
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [kai, lani],
    });
    await grantStaffAccessToScholars(t, {
      staffUserId: otherTeacher,
      scholarIds: [kai, lani],
    });

    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["notes"], { type: "application/pdf" })),
    );
    const asTeacher = await withUser(t, teacher);
    const { attachmentId } = await asTeacher.mutation(
      api.parentMessages.registerAttachmentUpload,
      {
        storageId,
        fileName: "field-notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
      },
    );
    await expect(
      (await withUser(t, otherTeacher)).mutation(
        api.parentMessages.sendMessage,
        {
          body: "A shared update",
          scholarId: kai,
          attachmentIds: [attachmentId],
        },
      ),
    ).rejects.toThrow(/not available/i);

    const result = await asTeacher.mutation(
      api.parentMessages.sendMessage,
      {
        body: "A shared update",
        scholarIds: [kai, lani],
        attachmentIds: [attachmentId],
      },
    );
    expect(result.threadIds).toHaveLength(2);
    const rows = await t.run((ctx) =>
      ctx.db.query("parentMessageAttachments").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.storageId))).toEqual(
      new Set([storageId]),
    );
    expect(new Set(rows.map((row) => row.messageId)).size).toBe(2);
  });

  test("staff text and attachment reads share the same institution boundary", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "lehua");
    const foreignInstitutionId = await seedTestInstitution(t, {
      slug: "foreign-parent-messages",
    });
    const foreignScholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Foreign Scholar",
        username: "foreign-scholar",
        role: "scholar",
        institutionId: foreignInstitutionId,
      }),
    );
    const foreignParent = await seedUser(
      t,
      "parent",
      "foreign-parent",
      "Foreign Parent",
      "foreign@example.com",
    );
    await link(t, foreignParent, foreignScholar);
    const asTeacher = await withUser(t, teacher);

    await expect(
      asTeacher.mutation(api.parentMessages.sendMessage, {
        body: "Cross-school message",
        scholarId: foreignScholar,
      }),
    ).rejects.toThrow(/forbidden/i);

    const threadId = await t.run((ctx) =>
      ctx.db.insert("parentThreads", {
        parentUserId: foreignParent,
        scholarId: foreignScholar,
        lastMessageAt: Date.now(),
      }),
    );
    await expect(
      asTeacher.query(api.parentMessages.getThread, {
        threadId,
        as: "staff",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asTeacher.query(api.parentMessages.getThreadAttachments, {
        threadId,
        as: "staff",
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});

describe("parentMessages — scholar family groups", () => {
  test("subjectScholarId rejects unrelated recipients and groups every subject guardian", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const lani = await seedUser(t, "scholar", "lani");
    const parentA = await seedUser(t, "parent", "parenta", "Parent A", "a@example.com");
    const parentB = await seedUser(t, "parent", "parentb", "Parent B", "b@example.com");
    const unrelated = await seedUser(
      t,
      "parent",
      "unrelated",
      "Unrelated Parent",
      "other@example.com",
    );
    await link(t, parentA, kai);
    await link(t, parentB, kai);
    await link(t, unrelated, lani);

    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.parentMessages.sendMessage, {
        body: "This must not reach another family.",
        subjectScholarId: kai,
        parentIds: [unrelated],
      }),
    ).rejects.toThrow(/guardian of the subject scholar/i);
    expect(await t.run((ctx) => ctx.db.query("parentThreads").collect())).toEqual([]);

    const result = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Shared update for Kai's guardians.",
      subjectScholarId: kai,
      parentIds: [parentA],
    });
    expect(result).toMatchObject({ recipientCount: 2 });
    expect(result.threadIds).toHaveLength(1);
    const participants = await t.run((ctx) =>
      ctx.db
        .query("parentThreadParticipants")
        .withIndex("by_thread", (q) => q.eq("threadId", result.threadIds[0]))
        .collect(),
    );
    expect(new Set(participants.map((participant) => participant.parentUserId))).toEqual(
      new Set([parentA, parentB]),
    );
  });

  test("all guardians share one scholar thread and one group email", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const patA = await seedUser(t, "parent", "pata", "Parent A", "a@example.com");
    const patB = await seedUser(t, "parent", "patb", "Parent B", "b@example.com");
    const other = await seedUser(t, "parent", "other", "Other Parent");
    await link(t, patA, kai);
    await link(t, patB, kai);

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Field trip Friday!",
      scholarId: kai,
    });
    expect(res.recipientCount).toBe(2);
    expect(res.threadIds).toHaveLength(1);
    const all = await t.run(async (ctx) => ctx.db.query("parentThreads").collect());
    expect(all).toHaveLength(1);
    const participants = await t.run(async (ctx) =>
      ctx.db
        .query("parentThreadParticipants")
        .withIndex("by_thread", (q) => q.eq("threadId", all[0]._id))
        .collect(),
    );
    expect(new Set(participants.map((row) => row.parentUserId))).toEqual(
      new Set([patA, patB]),
    );

    const asA = await withUser(t, patA);
    const asB = await withUser(t, patB);
    expect(await asA.query(api.parentMessages.listMyThreads, {})).toHaveLength(1);
    expect(await asB.query(api.parentMessages.listMyThreads, {})).toHaveLength(1);
    const staffInbox = await asTeacher.query(api.parentMessages.listMyThreads, {});
    expect(staffInbox[0].guardians).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: patA, name: "Parent A", image: null }),
        expect.objectContaining({ _id: patB, name: "Parent B", image: null }),
      ]),
    );
    await expect(
      (await withUser(t, other)).query(api.parentMessages.getThread, {
        threadId: all[0]._id,
      }),
    ).rejects.toThrow(/forbidden/i);

    await asA.mutation(api.parentMessages.replyInThread, {
      threadId: all[0]._id,
      body: "Parent A here",
    });
    expect((await asA.query(api.parentMessages.listMyThreads, {}))[0].hasUnread).toBe(false);
    expect((await asB.query(api.parentMessages.listMyThreads, {}))[0].hasUnread).toBe(true);
    await asB.mutation(api.parentMessages.markThreadRead, { threadId: all[0]._id });
    expect((await asB.query(api.parentMessages.listMyThreads, {}))[0].hasUnread).toBe(false);

    await asB.mutation(api.parentMessages.replyInThread, {
      threadId: all[0]._id,
      body: "Parent B here",
    });
    const teacherView = await asTeacher.query(api.parentMessages.getThread, {
      threadId: all[0]._id,
    });
    expect(teacherView?.guardians).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: patA, name: "Parent A", image: null }),
        expect.objectContaining({ _id: patB, name: "Parent B", image: null }),
      ]),
    );
    expect(teacherView?.messages.map((message) => message.authorName)).toEqual([
      "Test t",
      "Parent A",
      "Parent B",
    ]);

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", all[0]._id))
        .collect(),
    );
    const deliveries = await t.run(async (ctx) =>
      ctx.db
        .query("messageDeliveries")
        .withIndex("by_message", (q) => q.eq("messageId", messages[0]._id))
        .collect(),
    );
    expect(deliveries.filter((delivery) => delivery.channel === "portal")).toHaveLength(2);
    expect(deliveries.filter((delivery) => delivery.channel === "email")).toHaveLength(1);
  });

  test("parent guardian payload omits IDs and images from summaries and details", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teacher");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const parentA = await seedUser(t, "parent", "parent-a", "Parent A");
    const parentB = await seedUser(t, "parent", "parent-b", "Parent B");
    await t.run(async (ctx) => {
      await ctx.db.patch(parentA, { image: "https://example.com/parent-a.png" });
      await ctx.db.patch(parentB, { image: "https://example.com/parent-b.png" });
    });
    await link(t, parentA, kai);
    await link(t, parentB, kai);

    const asTeacher = await withUser(t, teacher);
    const { threadIds } = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "A family update.",
      scholarId: kai,
    });

    const asParent = await withUser(t, parentA);
    const [parentSummary] = await asParent.query(
      api.parentMessages.listMyGuardianThreads,
      {},
    );
    const parentDetail = await asParent.query(api.parentMessages.getThread, {
      threadId: threadIds[0],
    });
    expect(parentSummary.viewer).toBe("parent");
    expect(parentDetail!.viewer).toBe("parent");
    expect(parentDetail).not.toHaveProperty("scholarId");
    for (const guardians of [parentSummary.guardians, parentDetail!.guardians]) {
      expect(guardians).toEqual(
        expect.arrayContaining([{ name: "Parent A" }, { name: "Parent B" }]),
      );
      for (const guardian of guardians) {
        expect(guardian).not.toHaveProperty("_id");
        expect(guardian).not.toHaveProperty("image");
      }
    }

    const [staffSummary] = await asTeacher.query(api.parentMessages.listMyThreads, {});
    const staffDetail = await asTeacher.query(api.parentMessages.getThread, {
      threadId: threadIds[0],
    });
    expect(staffSummary.viewer).toBe("teacher");
    expect(staffDetail!.viewer).toBe("teacher");
    expect(staffDetail).toMatchObject({ scholarId: kai });
    const expectedStaffGuardians = expect.arrayContaining([
      {
        _id: parentA,
        name: "Parent A",
        image: "https://example.com/parent-a.png",
      },
      {
        _id: parentB,
        name: "Parent B",
        image: "https://example.com/parent-b.png",
      },
    ]);
    expect(staffSummary.guardians).toEqual(expectedStaffGuardians);
    expect(staffDetail!.guardians).toEqual(expectedStaffGuardians);
  });
});

describe("parentMessages — reply, start, read, scoping", () => {
  test("parent replies to own thread; a different parent cannot", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat");
    const other = await seedUser(t, "parent", "other");
    await link(t, pat, kai);
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, { body: "hi", scholarId: kai });
    const thread = await t.run(async (ctx) =>
      ctx.db.query("parentThreads").withIndex("by_parent", (q) => q.eq("parentUserId", pat)).first(),
    );

    const asPat = await withUser(t, pat);
    await asPat.mutation(api.parentMessages.replyInThread, {
      threadId: thread!._id,
      body: "Thanks so much!",
    });
    const asOther = await withUser(t, other);
    await expect(
      asOther.mutation(api.parentMessages.replyInThread, {
        threadId: thread!._id,
        body: "sneaky",
      }),
    ).rejects.toThrow(/forbidden/i);

    const full = await asPat.query(api.parentMessages.getThread, { threadId: thread!._id });
    expect(full!.messages.map((m) => m.authorType)).toEqual(["teacher", "parent"]);
  });

  test("a parent-initiated thread has no teacher and surfaces in the staff scope=all view; a teacher reply claims it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat");
    await link(t, pat, kai);

    const asPat = await withUser(t, pat);
    const { threadId } = await asPat.mutation(api.parentMessages.startThread, {
      body: "Quick question about Kai's reading",
      scholarId: kai,
    });
    const created = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(created!.teacherId).toBeUndefined();
    expect(created!.scholarId).toBe(kai);

    const asTeacher = await withUser(t, teacher);
    // Not in "mine" (teacher authored none) but present in roster-wide "all".
    expect((await asTeacher.query(api.parentMessages.listMyThreads, {})).length).toBe(0);
    const all = await asTeacher.query(api.parentMessages.listMyThreads, { scope: "all" });
    expect(all.length).toBe(1);

    await asTeacher.mutation(api.parentMessages.replyInThread, {
      threadId,
      body: "Happy to help!",
    });
    const claimed = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(claimed!.teacherId).toBe(teacher);
  });

  test("a scholar gets [] from listMyThreads (no throw)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const asKai = await withUser(t, kai);
    expect(await asKai.query(api.parentMessages.listMyThreads, {})).toEqual([]);
  });
});

describe("parentMessages — email channel (P2)", () => {
  type TestT = ReturnType<typeof makeTestConvex>;
  async function firstMessageOf(t: TestT, parentId: Id<"users">) {
    const thread = await t.run(async (ctx) =>
      ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", parentId))
        .first(),
    );
    return await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", thread!._id))
        .first(),
    );
  }
  async function deliveriesOf(t: TestT, messageId: Id<"parentMessages">) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("messageDeliveries")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
  }

  test("a teacher message queues an email delivery; dispatch marks it skipped with no Resend key", async () => {
    const t = makeTestConvex();
    const teacher = await seedUser(t, "teacher", "t", "Ms Lani");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat", "Pat", "pat@home.com");
    await link(t, pat, kai);
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, { body: "hi", scholarId: kai });

    const msg = await firstMessageOf(t, pat);
    const before = await deliveriesOf(t, msg!._id);
    expect(before.map((d) => d.channel).sort()).toEqual(["email", "portal"]);
    const email = before.find((d) => d.channel === "email")!;
    expect(email.status).toBe("queued");

    await t.action(internal.parentMessageSend.dispatch, {
      messageIds: [msg!._id],
    });
    const after = await deliveriesOf(t, msg!._id);
    // No AUTH_RESEND_KEY in tests → the send is skipped, never silently "sent".
    expect(after.find((d) => d.channel === "email")!.status).toBe("skipped");
  });

  test("thread emails keep the opener subject and deep-link to the conversation", async () => {
    const previousKey = process.env.AUTH_RESEND_KEY;
    const realFetch = globalThis.fetch;
    process.env.AUTH_RESEND_KEY = "re_test";
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ id: `email-${requests.length}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const t = makeTestConvex();
      const teacher = await seedUser(t, "teacher", "teacher", "Ms Lani");
      const kai = await seedUser(t, "scholar", "kai");
      const pat = await seedUser(
        t,
        "parent",
        "pat",
        "Pat",
        "thread-subject@home.com",
      );
      await link(t, pat, kai);
      const asTeacher = await withUser(t, teacher);
      const { threadIds } = await asTeacher.mutation(
        api.parentMessages.sendMessage,
        {
          body: "Hi Pat,\nHere is a detailed update from today's class.",
          scholarId: kai,
        },
      );
      await t.finishAllScheduledFunctions(() => {});

      await asTeacher.mutation(api.parentMessages.replyInThread, {
        threadId: threadIds[0],
        body: "One more detail for tomorrow.",
        as: "staff",
      });
      await t.finishAllScheduledFunctions(() => {});

      const sent = requests
        .filter((request) => request.url === "https://api.resend.com/emails")
        .map(
          (request) =>
            JSON.parse(String(request.init.body)) as {
              to: string[];
              subject: string;
              html: string;
            },
        )
        .filter((request) => request.to.includes("thread-subject@home.com"));
      expect(sent).toHaveLength(2);
      expect(sent[1].subject).toBe(
        "Hi Pat, Here is a detailed update from today's class.",
      );
      expect(sent[1].html).toContain(
        `/parent/messages?thread=${threadIds[0]}`,
      );
      expect(sent[1].html).not.toContain("WhatsApp");
    } finally {
      globalThis.fetch = realFetch;
      if (previousKey === undefined) delete process.env.AUTH_RESEND_KEY;
      else process.env.AUTH_RESEND_KEY = previousKey;
    }
  });

  test("email dispatch relays stored attachments through Resend", async () => {
    const previousKey = process.env.AUTH_RESEND_KEY;
    const previousFrom = process.env.RESEND_FROM_EMAIL;
    const realFetch = globalThis.fetch;
    process.env.AUTH_RESEND_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "school@example.com";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "email-with-attachment" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const t = makeTestConvex();
      const teacher = await seedUser(t, "teacher", "t");
      const kai = await seedUser(t, "scholar", "kai");
      const pat = await seedUser(
        t,
        "parent",
        "pat",
        "Pat",
        "pat@home.com",
      );
      await link(t, pat, kai);
      const storageId = await t.run((ctx) =>
        ctx.storage.store(
          new Blob(["photo"], { type: "image/jpeg" }),
        ),
      );
      const asTeacher = await withUser(t, teacher);
      const { attachmentId } = await asTeacher.mutation(
        api.parentMessages.registerAttachmentUpload,
        {
          storageId,
          fileName: "class-photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 5,
        },
      );
      await asTeacher.mutation(api.parentMessages.sendMessage, {
        body: "A photo from class",
        scholarId: kai,
        attachmentIds: [attachmentId],
      });
      const message = await firstMessageOf(t, pat);

      await t.finishAllScheduledFunctions(() => {});

      const attachmentRequests = requests.filter(
        (request) =>
          request.url === "https://api.resend.com/emails" &&
          String(request.init?.body).includes("class-photo.jpg"),
      );
      expect(attachmentRequests).toHaveLength(1);
      const body = JSON.parse(String(attachmentRequests[0].init?.body)) as {
        attachments: Array<{
          filename: string;
          path: string;
          content_type: string;
        }>;
      };
      expect(body.attachments).toEqual([
        {
          filename: "class-photo.jpg",
          path: expect.stringContaining("/api/storage/"),
          content_type: "image/jpeg",
        },
      ]);
      expect(
        new Headers(attachmentRequests[0].init?.headers).get("Idempotency-Key"),
      ).toMatch(/^parent-email\//);
      const deliveries = await deliveriesOf(t, message!._id);
      expect(deliveries.find((delivery) => delivery.channel === "email")).toMatchObject({
        status: "sent",
        providerId: "email-with-attachment",
      });
    } finally {
      globalThis.fetch = realFetch;
      if (previousKey === undefined) delete process.env.AUTH_RESEND_KEY;
      else process.env.AUTH_RESEND_KEY = previousKey;
      if (previousFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
      else process.env.RESEND_FROM_EMAIL = previousFrom;
    }
  });

  test("a parent with email turned OFF gets no email delivery (portal only)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat", "Pat", "pat@home.com");
    await link(t, pat, kai);
    await t.run(async (ctx) =>
      ctx.db.insert("notificationPrefs", { userId: pat, emailEnabled: false }),
    );
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, { body: "hi", scholarId: kai });
    const msg = await firstMessageOf(t, pat);
    const deliveries = await deliveriesOf(t, msg!._id);
    expect(deliveries.map((d) => d.channel)).toEqual(["portal"]);
  });

  test("ingestInboundEmail appends a parent reply on sender match; fails closed otherwise", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat", "Pat", "pat@home.com");
    await link(t, pat, kai);
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, { body: "hi", scholarId: kai });
    const thread = await t.run(async (ctx) =>
      ctx.db.query("parentThreads").withIndex("by_parent", (q) => q.eq("parentUserId", pat)).first(),
    );
    const to = `reply+${thread!._id}@inbound.rabbithole.example`;

    const bad = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundEmail, {
        toAddress: to,
        fromEmail: "stranger@evil.com",
        body: "let me in",
      }),
    );
    expect(bad.ok).toBe(false);

    const ok = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundEmail, {
        toAddress: to,
        fromEmail: "PAT@home.com", // case-insensitive match
        body: "Replying from my email!",
        providerMessageId: "resend:received-1",
      }),
    );
    expect(ok.ok).toBe(true);

    const duplicate = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundEmail, {
        toAddress: to,
        fromEmail: "pat@home.com",
        body: "Replying from my email!",
        providerMessageId: "resend:received-1",
      }),
    );
    expect(duplicate).toMatchObject({ ok: true, action: "duplicate" });

    const full = await (await withUser(t, pat)).query(api.parentMessages.getThread, {
      threadId: thread!._id,
    });
    expect(full!.messages.at(-1)).toMatchObject({
      authorType: "parent",
      body: "Replying from my email!",
    });
    expect(
      full!.messages.filter((message) => message.body === "Replying from my email!"),
    ).toHaveLength(1);
  });

  test("ingestInboundEmail accepts a Gmail reply from a pilot plus-alias mailbox", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(
      t,
      "parent",
      "pat",
      "Pat",
      "fixture.user+parent@gmail.com",
    );
    await link(t, pat, kai);
    await (await withUser(t, teacher)).mutation(api.parentMessages.sendMessage, {
      body: "hi",
      scholarId: kai,
    });
    const thread = await t.run(async (ctx) =>
      ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", pat))
        .first(),
    );

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundEmail, {
        toAddress: `reply+${thread!._id}@example.resend.app`,
        fromEmail: "fixture.user@gmail.com",
        body: "Gmail alias reply",
        providerMessageId: "resend:gmail-alias",
      }),
    );
    expect(result).toMatchObject({ ok: true, action: "message" });
  });

  test("ingestInboundEmail uniquely resolves a non-Gmail plus alias and rejects ambiguous bases", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(
      t,
      "parent",
      "pat",
      "Pat",
      "family+pat@school.test",
    );
    await link(t, pat, kai);
    await (await withUser(t, teacher)).mutation(api.parentMessages.sendMessage, {
      body: "hi",
      scholarId: kai,
    });
    const thread = await t.run(async (ctx) =>
      ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", pat))
        .first(),
    );
    const toAddress = `reply+${thread!._id}@example.resend.app`;

    const unique = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundEmail, {
        toAddress,
        fromEmail: "family@school.test",
        body: "Tagged alias reply",
        providerMessageId: "resend:tagged-alias",
      }),
    );
    expect(unique).toMatchObject({ ok: true, action: "message" });

    const sam = await seedUser(
      t,
      "parent",
      "sam",
      "Sam",
      "family+sam@school.test",
    );
    await link(t, sam, kai);
    await t.run((ctx) =>
      ctx.db.insert("parentThreadParticipants", {
        threadId: thread!._id,
        parentUserId: sam,
      }),
    );

    const ambiguous = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundEmail, {
        toAddress,
        fromEmail: "family@school.test",
        body: "Do not attribute this",
        providerMessageId: "resend:ambiguous-alias",
      }),
    );
    expect(ambiguous).toMatchObject({
      ok: false,
      reason: "sender-mismatch",
    });
  });
});

describe("parentMessages — Slack teacher transport", () => {
  async function seedParentThread(t: ReturnType<typeof convexTest>) {
    const teacher = await seedUser(
      t,
      "teacher",
      "t",
      "Ms Lani",
      "teacher@school.test",
      "U_TEACHER",
    );
    const kai = await seedUser(t, "scholar", "kai", "Kai Nakamura");
    const pat = await seedUser(t, "parent", "pat", "Pat Parent", "pat@home.test");
    await link(t, pat, kai);

    const { threadId, firstParentMessageId } = await t.run(async (ctx) => {
      const now = Date.now();
      const parentThreadId = await ctx.db.insert("parentThreads", {
        parentUserId: pat,
        teacherId: teacher,
        scholarId: kai,
        lastMessageAt: now,
      });
      const parentMessageId = await ctx.db.insert("parentMessages", {
        threadId: parentThreadId,
        authorType: "parent",
        authorUserId: pat,
        body: "Can we talk about fractions?",
      });
      return { threadId: parentThreadId, firstParentMessageId: parentMessageId };
    });

    return { teacher, kai, pat, threadId, firstParentMessageId };
  }

  test("admin links/unlinks the shared parent-message channel with a private-channel reminder", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin", "Admin");
    const teacher = await seedUser(t, "teacher", "teacher", "Teacher");

    const forbidden = await t.mutation(
      internal.parentMessageSlack.linkParentMessageChannel,
      {
        callerUserId: teacher,
        slackChannelId: "C_PARENTS",
        unlink: false,
      },
    );
    expect(forbidden.ok).toBe(false);

    const linked = await t.mutation(
      internal.parentMessageSlack.linkParentMessageChannel,
      {
        callerUserId: admin,
        slackChannelId: "C_PARENTS",
        unlink: false,
      },
    );
    expect(linked.ok).toBe(true);
    expect(linked.message).toMatch(/PRIVATE staff channel/i);

    const moved = await t.mutation(
      internal.parentMessageSlack.linkParentMessageChannel,
      {
        callerUserId: admin,
        slackChannelId: "C_PARENTS_2",
        unlink: false,
      },
    );
    expect(moved.ok).toBe(true);
    const rows = await t.run(async (ctx) => ctx.db.query("parentMessageChannel").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].slackChannelId).toBe("C_PARENTS_2");

    const unlinked = await t.mutation(
      internal.parentMessageSlack.linkParentMessageChannel,
      {
        callerUserId: admin,
        slackChannelId: "C_PARENTS_2",
        unlink: true,
      },
    );
    expect(unlinked.ok).toBe(true);
    expect(unlinked.message).toMatch(/PRIVATE staff channel/i);
    const after = await t.run(async (ctx) => ctx.db.query("parentMessageChannel").collect());
    expect(after).toHaveLength(0);
  });

  test("no linked channel means outbound parent Slack notifications no-op", async () => {
    const t = convexTest(schema, modules);
    const { firstParentMessageId } = await seedParentThread(t);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Slack should not be called without a linked channel");
    }) as typeof fetch;

    try {
      await t.action(internal.parentMessageSlack.notifyParentMessageChannel, {
        messageId: firstParentMessageId,
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
    }

    const rows = await t.run(async (ctx) => ctx.db.query("parentSlackThreads").collect());
    expect(rows).toHaveLength(0);
  });

  test("linked channel records and reuses a parent thread anchor", async () => {
    const t = convexTest(schema, modules);
    const { threadId, firstParentMessageId, pat } = await seedParentThread(t);
    const admin = await seedUser(t, "platform_admin", "admin", "Admin");
    await t.mutation(internal.parentMessageSlack.linkParentMessageChannel, {
      callerUserId: admin,
      slackChannelId: "C_PARENT_STAFF",
      unlink: false,
    });

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const previousSiteUrl = process.env.SITE_URL;
    process.env.SITE_URL = "http://localhost:1092";
    const realFetch = globalThis.fetch;
    const chatPosts: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("chat.postMessage");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      chatPosts.push(body);
      return new Response(
        JSON.stringify({ ok: true, ts: chatPosts.length === 1 ? "111.222" : "111.333" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await t.action(internal.parentMessageSlack.notifyParentMessageChannel, {
        messageId: firstParentMessageId,
      });

      const mapping = await t.run(async (ctx) =>
        ctx.db
          .query("parentSlackThreads")
          .withIndex("by_parent_thread", (q) => q.eq("parentThreadId", threadId))
          .first(),
      );
      expect(mapping).toMatchObject({
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        lastParentMessageId: firstParentMessageId,
      });
      expect(chatPosts).toHaveLength(1);
      expect(chatPosts[0].channel).toBe("C_PARENT_STAFF");
      expect(String(chatPosts[0].markdown_text)).toContain("Pat Parent");
      expect(String(chatPosts[0].markdown_text)).toContain("Kai Nakamura");
      expect(String(chatPosts[0].markdown_text)).toContain("Can we talk");

      const secondParentMessageId = await t.run(async (ctx) =>
        ctx.db.insert("parentMessages", {
          threadId,
          authorType: "parent",
          authorUserId: pat,
          body: "One more note",
        }),
      );
      await t.action(internal.parentMessageSlack.notifyParentMessageChannel, {
        messageId: secondParentMessageId,
      });
      expect(chatPosts).toHaveLength(2);
      expect(chatPosts[1].channel).toBe("C_PARENT_STAFF");
      expect(chatPosts[1].thread_ts).toBe("111.222");

    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
      if (previousSiteUrl === undefined) delete process.env.SITE_URL;
      else process.env.SITE_URL = previousSiteUrl;
    }
  });

  test("any linked teacher can reply in the shared channel thread; retries are idempotent", async () => {
    const t = convexTest(schema, modules);
    const { teacher, threadId } = await seedParentThread(t);
    const otherTeacher = await seedUser(
      t,
      "teacher",
      "other",
      "Other Teacher",
      undefined,
      "U_OTHER",
    );
    await t.run(async (ctx) =>
      ctx.db.insert("parentSlackThreads", {
        parentThreadId: threadId,
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        lastNotifiedAt: Date.now(),
      }),
    );

    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        slackUserId: "U_TEACHER",
        body: "Absolutely — let's talk tomorrow.",
        eventId: "EvSlackReply1",
        messageTs: "111.333",
      }),
    );
    expect(first).toMatchObject({ handled: true, ok: true, action: "message" });

    const duplicate = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        slackUserId: "U_TEACHER",
        body: "Absolutely — let's talk tomorrow.",
        eventId: "EvSlackReply1",
        messageTs: "111.333",
      }),
    );
    expect(duplicate).toMatchObject({
      handled: true,
      ok: true,
      action: "duplicate",
    });

    const secondTeacher = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        slackUserId: "U_OTHER",
        body: "I can help with that too.",
        eventId: "EvSlackReply2",
        messageTs: "111.444",
      }),
    );
    expect(secondTeacher).toMatchObject({ handled: true, ok: true, action: "message" });

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    const firstReplies = messages.filter(
      (m) => m.providerMessageId === "slack:EvSlackReply1",
    );
    expect(firstReplies).toHaveLength(1);
    expect(firstReplies[0]).toMatchObject({
      authorType: "teacher",
      authorUserId: teacher,
      body: "Absolutely — let's talk tomorrow.",
      source: "slack",
    });
    expect(
      messages.find((m) => m.providerMessageId === "slack:EvSlackReply2"),
    ).toMatchObject({
      authorType: "teacher",
      authorUserId: otherTeacher,
      body: "I can help with that too.",
      source: "slack",
    });

    const deliveries = await t.run(async (ctx) =>
      ctx.db
        .query("messageDeliveries")
        .withIndex("by_message", (q) => q.eq("messageId", firstReplies[0]._id))
        .collect(),
    );
    expect(deliveries.map((d) => d.channel).sort()).toEqual(["email", "portal"]);
  });

  test("unlinked Slack users fail closed without appending, while unmapped threads fall through", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedParentThread(t);
    await t.run(async (ctx) =>
      ctx.db.insert("parentSlackThreads", {
        parentThreadId: threadId,
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        lastNotifiedAt: Date.now(),
      }),
    );

    const unlinked = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        slackUserId: "U_STRANGER",
        body: "Please send this",
        eventId: "EvSlackUnlinked",
        messageTs: "111.333",
      }),
    );
    expect(unlinked).toMatchObject({ handled: true, ok: false, reason: "unlinked" });

    const empty = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        slackUserId: "U_TEACHER",
        body: "   ",
        eventId: "EvSlackEmpty",
        messageTs: "111.444",
      }),
    );
    expect(empty).toMatchObject({ handled: true, ok: false, reason: "empty" });

    const tooLong = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        slackUserId: "U_TEACHER",
        body: "x".repeat(8001),
        eventId: "EvSlackTooLong",
        messageTs: "111.555",
      }),
    );
    expect(tooLong).toMatchObject({ handled: true, ok: false, reason: "too-long" });

    const unmapped = await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "999.000",
        slackUserId: "U_TEACHER",
        body: "This should fall through to aide",
        eventId: "EvSlackUnmapped",
        messageTs: "999.111",
      }),
    );
    expect(unmapped).toMatchObject({ handled: false, ok: false, reason: "no-mapping" });

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    expect(messages.some((m) => m.providerMessageId === "slack:EvSlackUnlinked")).toBe(
      false,
    );
    expect(messages.some((m) => m.providerMessageId === "slack:EvSlackEmpty")).toBe(
      false,
    );
    expect(messages.some((m) => m.providerMessageId === "slack:EvSlackTooLong")).toBe(
      false,
    );
  });

  test("Slack reply routing recognizes every root posted during a first-notification race", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "teacher", "t", "Ms Lani", undefined, "U_T");
    const kai = await seedUser(t, "scholar", "kai", "Kai");
    const pat = await seedUser(t, "parent", "pat", "Pat", "pat@home.test");
    await link(t, pat, kai);

    const { threadId, firstParentMessageId, secondParentMessageId } = await t.run(
      async (ctx) => {
        const now = Date.now();
        const parentThreadId = await ctx.db.insert("parentThreads", {
          parentUserId: pat,
          scholarId: kai,
            lastMessageAt: now,
        });
        const firstMessageId = await ctx.db.insert("parentMessages", {
          threadId: parentThreadId,
          authorType: "parent",
          authorUserId: pat,
          body: "First parent note",
          });
        const secondMessageId = await ctx.db.insert("parentMessages", {
          threadId: parentThreadId,
          authorType: "parent",
          authorUserId: pat,
          body: "Second parent note",
          });
        return {
          threadId: parentThreadId,
          firstParentMessageId: firstMessageId,
          secondParentMessageId: secondMessageId,
        };
      },
    );

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.parentMessages.recordParentSlackThreadNotification, {
        parentThreadId: threadId,
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        messageId: firstParentMessageId,
      });
      await ctx.runMutation(internal.parentMessages.recordParentSlackThreadNotification, {
        parentThreadId: threadId,
        channelId: "C_PARENT_STAFF",
        threadTs: "111.333",
        messageId: secondParentMessageId,
      });
    });

    const roots = ["111.222", "111.333"] as const;
    for (const [index, root] of roots.entries()) {
      const reply = await t.run(async (ctx) =>
        ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
          channelId: "C_PARENT_STAFF",
          threadTs: root,
          slackUserId: "U_T",
          body: `Reply under root ${root}`,
          eventId: `EvSlackRaceReply${index}`,
          messageTs: `111.${444 + index}`,
        }),
      );
      expect(reply).toMatchObject({
        handled: true,
        ok: true,
        action: "message",
      });
    }

    const selected = await t.run(async (ctx) =>
      ctx.runQuery(internal.parentMessages.getParentSlackThreadByParentThread, {
        parentThreadId: threadId,
        channelId: "C_PARENT_STAFF",
      }),
    );
    expect(selected?.threadTs).toBe("111.333");
  });

  test("'via Slack' provenance is teacher-facing only (getThread)", async () => {
    const t = convexTest(schema, modules);
    const { threadId, pat } = await seedParentThread(t);
    await t.run(async (ctx) =>
      ctx.db.insert("parentSlackThreads", {
        parentThreadId: threadId,
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        lastNotifiedAt: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        slackUserId: "U_TEACHER",
        body: "Replying from Slack",
        eventId: "EvViaSlack1",
        messageTs: "111.333",
      }),
    );

    // Teacher sees the "via Slack" provenance on their Slack-authored reply…
    const asTeacher = await (await withUser(t, await seedUser(t, "teacher", "viewer"))).query(
      api.parentMessages.getThread,
      { threadId },
    );
    const teacherSlackMsg = asTeacher!.messages.find(
      (m) => m.body === "Replying from Slack",
    );
    expect(teacherSlackMsg?.source).toBe("slack");

    // …but the parent never receives the transport metadata.
    const asParent = await (await withUser(t, pat)).query(api.parentMessages.getThread, {
      threadId,
    });
    const parentSlackMsg = asParent!.messages.find(
      (m) => m.body === "Replying from Slack",
    );
    expect(parentSlackMsg?.source).toBeNull();
  });
});

describe("parentMessages — WhatsApp/SMS adapter + consent (P4)", () => {
  // Opt-in tokens are HMAC-signed — set the signing secret + number, and mint
  // real signed tokens via the production helper.
  beforeAll(() => {
    process.env.PARENT_INBOUND_SECRET = "test-inbound-secret";
    process.env.SCHOOL_WHATSAPP_NUMBER = "+18085550000";
  });
  afterAll(() => {
    delete process.env.PARENT_INBOUND_SECRET;
    delete process.env.SCHOOL_WHATSAPP_NUMBER;
  });
  async function optInToken(parentId: Id<"users">): Promise<string> {
    const { whatsAppOptInLink } = await import("../lib/parentMessageChannels");
    const link = await whatsAppOptInLink(parentId);
    return decodeURIComponent(new URL(link!).searchParams.get("text")!);
  }

  test("opt-in via inbound links the number; a later teacher message queues a whatsapp delivery (skipped without Twilio); STOP opts out", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat", "Pat", "pat@home.com");
    await link(t, pat, kai);

    // Parent opts in by messaging the school number with their token.
    const optin = await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "whatsapp:+18085550000",
        body: await optInToken(pat),
      }),
    );
    expect(optin).toMatchObject({ ok: true, action: "opted-in" });

    // Now a teacher message queues BOTH email + whatsapp deliveries.
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.parentMessages.sendMessage, { body: "hi", scholarId: kai });
    const thread = await t.run(async (c) =>
      c.db.query("parentThreads").withIndex("by_parent", (q) => q.eq("parentUserId", pat)).first(),
    );
    const msg = await t.run(async (c) =>
      c.db.query("parentMessages").withIndex("by_thread", (q) => q.eq("threadId", thread!._id)).first(),
    );
    const channels = await t.run(async (c) =>
      c.db.query("messageDeliveries").withIndex("by_message", (q) => q.eq("messageId", msg!._id)).collect(),
    );
    expect(channels.map((d) => d.channel).sort()).toEqual(["email", "portal", "whatsapp"]);

    // Dispatch: no Twilio creds → whatsapp skipped (never silently sent).
    await t.action(internal.parentMessageSend.dispatch, { messageIds: [msg!._id] });
    const after = await t.run(async (c) =>
      c.db.query("messageDeliveries").withIndex("by_message", (q) => q.eq("messageId", msg!._id)).collect(),
    );
    expect(after.find((d) => d.channel === "whatsapp")!.status).toBe("skipped");

    // STOP opts the number out → future sends no longer queue whatsapp.
    await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "+18085550000",
        body: "STOP",
      }),
    );
    const secondSend = await asTeacher.mutation(
      api.parentMessages.sendMessage,
      { body: "again", scholarId: kai },
    );
    const msgs = await t.run(async (c) =>
      c.db
        .query("parentMessages")
        .withIndex("by_thread", (q) =>
          q.eq("threadId", secondSend.threadIds[0]),
        )
        .collect(),
    );
    const latest = msgs[msgs.length - 1];
    const ch2 = await t.run(async (c) =>
      c.db.query("messageDeliveries").withIndex("by_message", (q) => q.eq("messageId", latest._id)).collect(),
    );
    expect(ch2.map((d) => d.channel)).not.toContain("whatsapp");
  });

  test("an inbound message from an UNMAPPED number fails closed (no thread, no write)", async () => {
    const t = convexTest(schema, modules);
    const res = await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "whatsapp:+19990001111",
        body: "How is my kid doing?",
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: "unmapped" });
    const threads = await t.run(async (c) => c.db.query("parentThreads").collect());
    expect(threads.length).toBe(0);
  });

  test("a mapped inbound message lands in the parent's thread", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat");
    await link(t, pat, kai);
    await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "whatsapp:+18085551212",
        body: await optInToken(pat),
      }),
    );
    const res = await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "+18085551212",
        body: "Hello from WhatsApp!",
      }),
    );
    expect(res).toMatchObject({ ok: true, action: "message" });
    const full = await (await withUser(t, pat)).query(api.parentMessages.getThread, {
      threadId: (res as { threadId: Id<"parentThreads"> }).threadId,
    });
    expect(full!.messages.at(-1)).toMatchObject({ authorType: "parent", body: "Hello from WhatsApp!" });
  });

  test("a replayed OPT-IN (same wamid) is deduped — links + welcomes once", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat");
    await link(t, pat, kai);
    const token = await optInToken(pat);
    const first = await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "+18085551212",
        body: token,
        messageId: "wamid.OPTIN1",
      }),
    );
    expect(first).toMatchObject({ ok: true, action: "opted-in" });
    const replay = await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "+18085551212",
        body: token,
        messageId: "wamid.OPTIN1",
      }),
    );
    expect(replay).toMatchObject({ ok: true, action: "duplicate" });
    // Exactly one identity row, and its marker is the opt-in wamid.
    const ids = await t.run(async (c) =>
      c.db.query("parentChannelIdentities").collect(),
    );
    expect(ids.length).toBe(1);
    expect(ids[0].lastInboundMessageId).toBe("wamid.OPTIN1");
  });

  test("a replayed inbound (same wamid) is deduped — no duplicate message", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat");
    await link(t, pat, kai);
    await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "+18085551212",
        body: await optInToken(pat),
      }),
    );
    const first = await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "+18085551212",
        body: "How is my kid doing?",
        messageId: "wamid.DEDUP1",
      }),
    );
    expect(first).toMatchObject({ ok: true, action: "message" });
    const second = await t.run(async (c) =>
      c.runMutation(internal.parentMessages.ingestInboundPhone, {
        channel: "whatsapp",
        fromNumber: "+18085551212",
        body: "How is my kid doing?",
        messageId: "wamid.DEDUP1",
      }),
    );
    expect(second).toMatchObject({ ok: true, action: "duplicate" });
    const matching = await t.run(async (c) =>
      c.db
        .query("parentMessages")
        .withIndex("by_provider_message", (q) =>
          q.eq("providerMessageId", "wamid.DEDUP1"),
        )
        .collect(),
    );
    expect(matching.length).toBe(1);
  });

});

describe("parentMessages — security", () => {
  test("preview requests are message-bound and enforce participant and tenant access", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teacher");
    const kai = await seedUser(t, "scholar", "kai");
    const pat = await seedUser(t, "parent", "pat");
    const unrelatedParent = await seedUser(t, "parent", "unrelated");
    await link(t, pat, kai);

    const asTeacher = await withUser(t, teacher);
    const sent = await asTeacher.mutation(api.parentMessages.sendMessage, {
      scholarId: kai,
      body: "Read https://example.com/field-notes.",
    });
    const [message] = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", sent.threadIds[0]))
        .collect(),
    );
    const asPat = await withUser(t, pat);
    await expect(
      asPat.query(api.parentMessages.getMessageLinkPreviewRequest, {
        messageId: message._id,
        url: "https://example.com/field-notes",
      }),
    ).resolves.toMatchObject({ url: "https://example.com/field-notes" });
    await expect(
      asPat.query(api.parentMessages.getMessageLinkPreviewRequest, {
        messageId: message._id,
        url: "https://attacker.example/",
      }),
    ).resolves.toBeNull();
    await expect(
      (await withUser(t, unrelatedParent)).query(
        api.parentMessages.getMessageLinkPreviewRequest,
        {
          messageId: message._id,
          url: "https://example.com/field-notes",
        },
      ),
    ).rejects.toThrow(/forbidden|participant/i);

    const otherInstitution = await seedTestInstitution(t, {
      slug: "preview-other-school",
    });
    const otherTeacher = await t.run((ctx) =>
      ctx.db.insert("users", { role: "teacher", username: "other-teacher" }),
    );
    await grantInstitutionMembership(t, otherTeacher, otherInstitution, "teacher");
    await expect(
      (await withUser(t, otherTeacher)).query(
        api.parentMessages.getMessageLinkPreviewRequest,
        {
          messageId: message._id,
          url: "https://example.com/field-notes",
          as: "staff",
        },
      ),
    ).rejects.toThrow(/access|institution|forbidden/i);
  });

  test("a forged opt-in token (bad signature) is rejected", async () => {
    process.env.PARENT_INBOUND_SECRET = "test-inbound-secret";
    try {
      const t = convexTest(schema, modules);
      const pat = await seedUser(t, "parent", "pat");
      const exp = Date.now() + 1_000_000;
      const res = await t.run(async (c) =>
        c.runMutation(internal.parentMessages.ingestInboundPhone, {
          channel: "whatsapp",
          fromNumber: "+18085559999",
          body: `optin:${pat}.${exp}.deadbeefdeadbeefdeadbeefdeadbeef`,
        }),
      );
      expect(res.ok).toBe(false);
      const ids = await t.run(async (c) => c.db.query("parentChannelIdentities").collect());
      expect(ids.length).toBe(0);
    } finally {
      delete process.env.PARENT_INBOUND_SECRET;
    }
  });
});

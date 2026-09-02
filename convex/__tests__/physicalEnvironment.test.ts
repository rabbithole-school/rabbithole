import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { localWeekdayAndTime } from "../lib/metaBlocks";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the physical-environment inventory (rooms + equipment) is a
// DESIGN-layer, INSTITUTION-scoped building block whose per-item
// `tutorSuggestable` flag is the human-in-the-loop redaction boundary — the
// tutor must never see an item until a staffer opts it in. These tests pin the
// load-bearing behaviors: curriculum-role gating, institution scoping, the
// default-off gate, and that the tutor read (getSessionContext) surfaces ONLY
// suggestable + active gear.

type Role = "scholar" | "teacher" | "platform_admin" | "curriculum_designer" | "staff";

const HONOLULU_TZ = "Pacific/Honolulu";

/**
 * "23:59" is the latest valid, exclusive all-day end time. Use the production
 * timezone except during that one excluded Honolulu minute.
 */
function allDayFixtureTimeZone(nowMs = Date.now()): string {
  return localWeekdayAndTime(nowMs, HONOLULU_TZ).hhmm === "23:59"
    ? "Pacific/Pago_Pago"
    : HONOLULU_TZ;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      institutionId,
    }),
  );
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

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
  name = slug,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      slug,
      name,
      kind: "school" as const,
    }),
  );
}

/** Give a staffer a membership at an institution (so they may curate it). */
async function linkStaff(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  role: Role,
  institutionId: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", {
      userId,
      role: role as Exclude<Role, "scholar">,
      institutionId,
    }),
  );
}

async function withAllDayFixtureClock<T>(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  query: () => Promise<T>,
): Promise<T> {
  const nowMs = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.patch(institutionId, {
      timeZone: allDayFixtureTimeZone(nowMs),
    });
  });
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    return await query();
  } finally {
    nowSpy.mockRestore();
  }
}

describe("spaces + equipment — access & gating", () => {
  test("any school staff can create rooms + equipment; a scholar cannot", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const teacher = await seedUser(t, "teacher", "lehua");
    const opsStaff = await seedUser(t, "staff", "sloane");
    const scholar = await seedUser(t, "scholar", "kai", inst);
    await linkStaff(t, teacher, "teacher", inst);
    await linkStaff(t, opsStaff, "staff", inst);

    const asTeacher = await withUser(t, teacher);
    const roomId = await asTeacher.mutation(api.spaces.create, {
      institutionId: inst,
      name: "Music Room",
      kind: "music",
    });
    expect(roomId).toBeTruthy();

    const gearId = await asTeacher.mutation(api.equipment.create, {
      institutionId: inst,
      spaceId: roomId,
      name: "Set of hand bells",
    });
    expect(gearId).toBeTruthy();

    // Plain staff (the retired registrar role's successor, without any capability grant) is staff too — the School Space editor is open to all staff.
    const asOpsStaff = await withUser(t, opsStaff);
    const roomId2 = await asOpsStaff.mutation(api.spaces.create, {
      institutionId: inst,
      name: "Maker Lab",
      kind: "makerspace",
    });
    expect(roomId2).toBeTruthy();

    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.spaces.create, {
        institutionId: inst,
        name: "Secret Lab",
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.equipment.create, {
        institutionId: inst,
        name: "Contraband",
      }),
    ).rejects.toThrow();
    // Scholars can't read the curation lists either.
    await expect(
      asScholar.query(api.equipment.listByInstitution, { institutionId: inst }),
    ).rejects.toThrow();
  });

  test("new equipment is NOT tutor-suggestable by default (the gate is off)", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const teacher = await seedUser(t, "teacher", "lehua");
    await linkStaff(t, teacher, "teacher", inst);
    const asTeacher = await withUser(t, teacher);

    const gearId = await asTeacher.mutation(api.equipment.create, {
      institutionId: inst,
      name: "Balance scale",
    });
    const row = await t.run(async (ctx) => ctx.db.get(gearId));
    expect(row?.tutorSuggestable).toBe(false);

    await asTeacher.mutation(api.equipment.setTutorSuggestable, {
      id: gearId,
      tutorSuggestable: true,
    });
    const flipped = await t.run(async (ctx) => ctx.db.get(gearId));
    expect(flipped?.tutorSuggestable).toBe(true);
  });

  test("equipment can't be attached to a room from another institution", async () => {
    const t = convexTest(schema, modules);
    const a = await seedInstitution(t, "moli");
    const b = await seedInstitution(t, "guests");
    const teacher = await seedUser(t, "teacher", "lehua");
    await linkStaff(t, teacher, "teacher", a);
    await linkStaff(t, teacher, "teacher", b);
    const asTeacher = await withUser(t, teacher);

    const roomInB = await asTeacher.mutation(api.spaces.create, {
      institutionId: b,
      name: "Guest Room",
    });
    await expect(
      asTeacher.mutation(api.equipment.create, {
        institutionId: a,
        spaceId: roomInB,
        name: "Mismatched gear",
      }),
    ).rejects.toThrow(/institution/i);
  });

  test("listByInstitution is scoped to one institution", async () => {
    const t = convexTest(schema, modules);
    const a = await seedInstitution(t, "moli");
    const b = await seedInstitution(t, "guests");
    const teacher = await seedUser(t, "teacher", "lehua");
    await linkStaff(t, teacher, "teacher", a);
    await linkStaff(t, teacher, "teacher", b);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.equipment.create, {
      institutionId: a,
      name: "Bells in A",
    });
    await asTeacher.mutation(api.equipment.create, {
      institutionId: b,
      name: "Bowl in B",
    });

    const listA = await asTeacher.query(api.equipment.listByInstitution, {
      institutionId: a,
    });
    expect(listA.map((e) => e.name)).toEqual(["Bells in A"]);
  });

  test("a staffer CANNOT read or write another institution's inventory", async () => {
    const t = convexTest(schema, modules);
    const mine = await seedInstitution(t, "moli");
    const other = await seedInstitution(t, "guests");
    const teacher = await seedUser(t, "teacher", "lehua");
    await linkStaff(t, teacher, "teacher", mine); // member of `mine` only
    const asTeacher = await withUser(t, teacher);

    // A gear item that lives in the OTHER institution.
    const foreignGear = await t.run(async (ctx) =>
      ctx.db.insert("equipment", {
        institutionId: other,
        name: "Someone else's bells",
        tutorSuggestable: true,
        isActive: true,
      }),
    );

    await expect(
      asTeacher.query(api.equipment.listByInstitution, { institutionId: other }),
    ).rejects.toThrow(/context/i);
    await expect(
      asTeacher.query(api.spaces.list, { institutionId: other }),
    ).rejects.toThrow(/context/i);
    await expect(
      asTeacher.mutation(api.spaces.create, { institutionId: other, name: "Sneaky" }),
    ).rejects.toThrow(/context/i);
    await expect(
      asTeacher.mutation(api.equipment.create, { institutionId: other, name: "Sneaky" }),
    ).rejects.toThrow(/context/i);
    // …and can't flip another school's tutor gate by object id.
    await expect(
      asTeacher.mutation(api.equipment.setTutorSuggestable, {
        id: foreignGear,
        tutorSuggestable: false,
      }),
    ).rejects.toThrow(/context/i);
    await expect(
      asTeacher.mutation(api.equipment.archive, { id: foreignGear }),
    ).rejects.toThrow(/context/i);
  });
});

describe("physical environment — tutor read (getSessionContext)", () => {
  test("surfaces ONLY suggestable + active equipment for the scholar's institution", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const teacher = await seedUser(t, "teacher", "lehua");
    const scholar = await seedUser(t, "scholar", "kai", inst);
    await linkStaff(t, teacher, "teacher", inst);
    const asTeacher = await withUser(t, teacher);

    const room = await asTeacher.mutation(api.spaces.create, {
      institutionId: inst,
      name: "Music Room",
      kind: "music",
    });
    // Suggestable + active → should appear.
    await asTeacher.mutation(api.equipment.create, {
      institutionId: inst,
      spaceId: room,
      name: "Hand bells",
      tutorSuggestable: true,
      usageIdeas: ["Ring two together and describe what you hear."],
    });
    // Suggestable but archived → hidden.
    const archived = await asTeacher.mutation(api.equipment.create, {
      institutionId: inst,
      spaceId: room,
      name: "Broken drum",
      tutorSuggestable: true,
    });
    await asTeacher.mutation(api.equipment.archive, { id: archived });
    // Not suggestable → hidden.
    await asTeacher.mutation(api.equipment.create, {
      institutionId: inst,
      spaceId: room,
      name: "Fragile antique flute",
      tutorSuggestable: false,
    });

    // Physical inventory is now gated to the school day (derived from the Master
    // Schedule). Seed an active period + an all-day / all-weekday bell block so
    // the scholar counts as "at school" whenever this test runs — otherwise the
    // gate fails closed and no gear surfaces. (See convex/lib/schoolDay.ts.)
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Term",
        startsAt: 0,
        endsAt: Number.MAX_SAFE_INTEGER,
        status: "open" as const,
        institutionId: inst,
      });
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "allday",
        label: "All Day",
        startLocal: "00:00",
        endLocal: "23:59",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        order: 0,
      });
    });

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        title: "Exploring sound",
        isArchived: false,
      }),
    );

    const ctxOut = await withAllDayFixtureClock(t, inst, () =>
      t.query(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    const gear = ctxOut?.physicalEnvironmentContext?.equipment ?? [];
    expect(gear.map((e) => e.name)).toEqual(["Hand bells"]);
    expect(gear[0]?.usageIdeas).toEqual([
      "Ring two together and describe what you hear.",
    ]);
    expect(ctxOut?.physicalEnvironmentContext?.spaces.map((s) => s.name)).toEqual(
      ["Music Room"],
    );
  });

  test("no institution → no physical-environment context", async () => {
    const t = convexTest(schema, modules);
    // scholar with NO institutionId
    const scholar = await seedUser(t, "scholar", "loner");
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        title: "Solo",
        isArchived: false,
      }),
    );
    const ctxOut = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(ctxOut?.physicalEnvironmentContext).toBeNull();
  });

  test("teacher_only gear does NOT reach the tutor context (so the tool isn't offered)", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const teacher = await seedUser(t, "teacher", "lehua");
    const scholar = await seedUser(t, "scholar", "kai", inst);
    await linkStaff(t, teacher, "teacher", inst);
    const asTeacher = await withUser(t, teacher);

    // The ONLY suggestable item is teacher_only → never tutor-suggested.
    await asTeacher.mutation(api.equipment.create, {
      institutionId: inst,
      name: "Bunsen burner",
      tutorSuggestable: true,
      supervision: "teacher_only",
    });

    // Seed an at-school schedule so the school-day gate is OPEN — this proves the
    // context is null because the only gear is teacher_only (the exclusion under
    // test), not merely because we're off-hours. (See convex/lib/schoolDay.ts.)
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Term",
        startsAt: 0,
        endsAt: Number.MAX_SAFE_INTEGER,
        status: "open" as const,
        institutionId: inst,
      });
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "allday",
        label: "All Day",
        startLocal: "00:00",
        endLocal: "23:59",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        order: 0,
      });
    });

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        title: "Chemistry",
        isArchived: false,
      }),
    );
    const ctxOut = await withAllDayFixtureClock(t, inst, () =>
      t.query(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    // Context is null → hasPhysicalEnv is false → the suggest_physical_task
    // tool is not even offered (and the prompt section is omitted).
    expect(ctxOut?.physicalEnvironmentContext).toBeNull();
  });
});

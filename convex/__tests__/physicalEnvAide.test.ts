import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the staff/curriculum bots (aide · Slack · MCP · unit designer)
// read + write the school inventory through convex/physicalEnvAide.ts. These
// tests pin the bot-facing seam: institution resolved from the acting staffer
// (membership → primary fallback), name-based resolution (ambiguity reported,
// not mis-acted), staff-only, and that a removal flips the tutor's access off.

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "teacher" | "scholar",
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
  );
}

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
  isPrimary = false,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      slug,
      name: slug,
      kind: "school" as const,
      isPrimary,
    }),
  );
}

async function link(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { userId, role: "teacher", institutionId }),
  );
}

describe("physicalEnvAide — bot read/write", () => {
  test("staff can add, read, update, and remove gear by name (institution from membership)", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const teacher = await seedUser(t, "teacher", "lehua");
    await link(t, teacher, inst);

    // Add a room + gear via the bot seam.
    await t.mutation(internal.physicalEnvAide.addRoomForActor, {
      callerUserId: teacher,
      name: "Music Room",
      kind: "music",
    });
    const added = await t.mutation(internal.physicalEnvAide.addEquipmentForActor, {
      callerUserId: teacher,
      name: "Metronome",
      roomName: "Music Room",
      quantity: "2",
    });
    expect(added.ok).toBe(true);

    // Read it back — defaults to gate OFF, in the right room.
    let inv = await t.query(internal.physicalEnvAide.inventoryForActor, {
      callerUserId: teacher,
    });
    expect(inv.spaces.map((s) => s.name)).toContain("Music Room");
    const m = inv.equipment.find((e) => e.name === "Metronome");
    expect(m?.room).toBe("Music Room");
    expect(m?.tutorSuggestable).toBe(false);

    // Flip the tutor gate on by name.
    const upd = await t.mutation(internal.physicalEnvAide.updateEquipmentForActor, {
      callerUserId: teacher,
      name: "metronome", // case-insensitive
      tutorSuggestable: true,
    });
    expect(upd.ok).toBe(true);
    inv = await t.query(internal.physicalEnvAide.inventoryForActor, {
      callerUserId: teacher,
    });
    expect(inv.equipment.find((e) => e.name === "Metronome")?.tutorSuggestable).toBe(true);

    // "the metronome is broken, remove it" → gone from the active inventory.
    const rm = await t.mutation(internal.physicalEnvAide.archiveEquipmentForActor, {
      callerUserId: teacher,
      name: "Metronome",
    });
    expect(rm.ok).toBe(true);
    inv = await t.query(internal.physicalEnvAide.inventoryForActor, {
      callerUserId: teacher,
    });
    expect(inv.equipment.find((e) => e.name === "Metronome")).toBeUndefined();
  });

  test("an ambiguous name is reported, not acted on", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const teacher = await seedUser(t, "teacher", "lehua");
    await link(t, teacher, inst);
    await t.mutation(internal.physicalEnvAide.addEquipmentForActor, {
      callerUserId: teacher,
      name: "Hand bells",
    });
    await t.mutation(internal.physicalEnvAide.addEquipmentForActor, {
      callerUserId: teacher,
      name: "Sleigh bells",
    });
    const rm = await t.mutation(internal.physicalEnvAide.archiveEquipmentForActor, {
      callerUserId: teacher,
      name: "bells",
    });
    expect(rm.ok).toBe(false);
    expect(rm.message).toMatch(/Hand bells/);
    expect(rm.message).toMatch(/Sleigh bells/);
    // Neither was archived.
    const inv = await t.query(internal.physicalEnvAide.inventoryForActor, {
      callerUserId: teacher,
    });
    expect(inv.equipment.length).toBe(2);
  });

  test("no membership → falls back to the primary institution", async () => {
    const t = convexTest(schema, modules);
    await seedInstitution(t, "guests");
    const primary = await seedInstitution(t, "moli", true);
    const teacher = await seedUser(t, "teacher", "nomembership"); // no membership row
    const res = await t.mutation(internal.physicalEnvAide.addEquipmentForActor, {
      callerUserId: teacher,
      name: "Globe",
    });
    expect(res.ok).toBe(true);
    const row = await t.run(async (ctx) =>
      (await ctx.db.query("equipment").collect()).find((e) => e.name === "Globe"),
    );
    expect(row?.institutionId).toBe(primary);
  });

  test("a non-staff caller is refused", async () => {
    const t = convexTest(schema, modules);
    await seedInstitution(t, "moli", true);
    const scholar = await seedUser(t, "scholar", "kai");
    await expect(
      t.query(internal.physicalEnvAide.inventoryForActor, { callerUserId: scholar }),
    ).rejects.toThrow(/staff/i);
    await expect(
      t.mutation(internal.physicalEnvAide.archiveEquipmentForActor, {
        callerUserId: scholar,
        name: "anything",
      }),
    ).rejects.toThrow(/staff/i);
  });
});

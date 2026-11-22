import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Who bedtime applies to: currentUser.bedtimeTimeZone (convex/lib/bedtime.ts).
describe("currentUser.bedtimeTimeZone", () => {
  test("a scholar at the primary school gets the school's zone", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [primary] = world.schools;
    expect(primary.isPrimary).toBe(true);

    const asScholar = await world.as.scholar(primary.scholars[0]);
    expect(
      (await asScholar.query(api.users.currentUser, {}))?.bedtimeTimeZone,
    ).toBe("Pacific/Honolulu");

    await t.run((ctx) =>
      ctx.db.patch(primary.id, { timeZone: "America/New_York" }),
    );
    expect(
      (await asScholar.query(api.users.currentUser, {}))?.bedtimeTimeZone,
    ).toBe("America/New_York");
  });

  test("another school's scholar and staff are never put to bed", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [primary, other] = world.schools;

    const otherScholar = await world.as.scholar(other.scholars[0]);
    expect(
      (await otherScholar.query(api.users.currentUser, {}))?.bedtimeTimeZone,
    ).toBeNull();

    const teacher = await world.as.staffOf(primary);
    expect(
      (await teacher.query(api.users.currentUser, {}))?.bedtimeTimeZone,
    ).toBeNull();
  });
});

// A family's own bedtime (TRA-625): convex/scholarBedtimes.ts.
describe("a family's bedtime", () => {
  const earlier = { startMinutes: 19 * 60 + 30, endMinutes: 6 * 60 + 30 };

  test("a guardian makes their child's bedtime stricter, and the child's BunnyPad reads it", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [primary] = world.schools;
    const parent = primary.parents[0];
    const child = parent.children[0];
    const asParent = await world.as.parent(parent);
    const asChild = await world.as.scholar(child);

    const before = await asChild.query(api.users.currentUser, {});
    expect(before?.bedtimeStartMinutes).toBe(20 * 60);
    expect(before?.bedtimeEndMinutes).toBe(6 * 60);

    const { message } = await asParent.mutation(api.scholarBedtimes.setForScholar, {
      scholarId: child.id,
      ...earlier,
    });
    expect(message).toContain("7:30pm to 6:30am");

    const after = await asChild.query(api.users.currentUser, {});
    expect(after?.bedtimeStartMinutes).toBe(earlier.startMinutes);
    expect(after?.bedtimeEndMinutes).toBe(earlier.endMinutes);

    // The parent portal's BunnyPad tab and the teacher's profile both show it.
    expect(
      await asParent.query(api.scholarBedtimes.forParent, { scholarId: child.id }),
    ).toMatchObject({
      setByFamily: true,
      text: "7:30pm to 6:30am",
    });
    const asTeacher = await world.as.staffOf(primary);
    expect(
      await asTeacher.query(api.scholarBedtimes.forScholar, { scholarId: child.id }),
    ).toMatchObject({ setByFamily: true, text: "7:30pm to 6:30am" });

    // Back to the school's window removes the row.
    await asParent.mutation(api.scholarBedtimes.setForScholar, {
      scholarId: child.id,
      startMinutes: 20 * 60,
      endMinutes: 6 * 60,
    });
    expect(await t.run((ctx) => ctx.db.query("scholarBedtimes").collect())).toEqual([]);
  });

  test("never looser than the school's, and only for one's own first-party child", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [primary, other] = world.schools;
    const parent = primary.parents[0];
    const asParent = await world.as.parent(parent);

    await expect(
      asParent.mutation(api.scholarBedtimes.setForScholar, {
        scholarId: parent.children[0].id,
        startMinutes: 21 * 60,
        endMinutes: 6 * 60,
      }),
    ).rejects.toThrow(/Bedtime can be between/);

    // Another family's child.
    const stranger = primary.scholars.find((s) => s.id !== parent.children[0].id)!;
    await expect(
      asParent.mutation(api.scholarBedtimes.setForScholar, {
        scholarId: stranger.id,
        ...earlier,
      }),
    ).rejects.toThrow(/not a guardian/);
    await expect(
      asParent.query(api.scholarBedtimes.forParent, { scholarId: stranger.id }),
    ).rejects.toThrow(/not a guardian/);

    // Another school's child has no bedtime to make stricter.
    const otherParent = other.parents[0];
    await expect(
      (await world.as.parent(otherParent)).mutation(api.scholarBedtimes.setForScholar, {
        scholarId: otherParent.children[0].id,
        ...earlier,
      }),
    ).rejects.toThrow(/no bedtime to set/);

    // Another school's teacher can't read it.
    await expect(
      (await world.as.staffOf(other)).query(api.scholarBedtimes.forScholar, {
        scholarId: parent.children[0].id,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("the aide's write returns refusals as messages and records the source", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const parent = world.schools[0].parents[0];
    const child = parent.children[0];

    const refused = await t.mutation(internal.scholarBedtimes.setFromGuardian, {
      guardianUserId: parent.id,
      scholarId: child.id,
      source: "parent_sms",
      startMinutes: 17 * 60,
      endMinutes: 6 * 60,
    });
    expect(refused.ok).toBe(false);

    const set = await t.mutation(internal.scholarBedtimes.setFromGuardian, {
      guardianUserId: parent.id,
      scholarId: child.id,
      source: "parent_sms",
      ...earlier,
    });
    expect(set).toMatchObject({ ok: true });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.at(-1)).toMatchObject({
      action: "scholar.bedtime.set",
      targetUserId: child.id,
      detail: "7:30pm to 6:30am via parent_sms",
    });

    const status = await t.query(internal.scholarBedtimes.statusForGuardian, {
      guardianUserId: parent.id,
    });
    expect(status[0].bedtime).toMatchObject({ setByFamily: true });
  });
});

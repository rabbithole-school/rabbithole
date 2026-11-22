import { convexTest, type TestConvex } from "convex-test";
import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { assembleCurriculumTools } from "../lib/aideTools";
import { READ_ONLY_ACCOUNT_ERROR } from "../lib/auth";
import { toolErrorText } from "../lib/toolLabels";
import { ROLES, type Role } from "../lib/roles";
import { QUEST_ARCHIVE_REFUSAL } from "../units";
import { makeUnit, makeWorld } from "./factories/world";
import { grantInstitutionMembership } from "./institutionTestHelpers";

/**
 * The staff aide (the app's Chat tab and @Rabbithole in Slack) can tidy a
 * unit for the next teacher: retitle it, fill in its description, subject,
 * grade and Big Idea (`update_unit`), and archive or bring back a teacher
 * unit (`archive_unit`). Each write runs as the caller: their own unit-edit
 * access at the unit's school, a writable account, and never a scholar's
 * own Quest for archiving.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;
type Tool = { name: string; run: (input: Record<string, unknown>) => Promise<string> };

function actionCtx(t: T): ActionCtx {
  const query = t.query as (ref: unknown, args: unknown) => Promise<unknown>;
  const mutation = t.mutation as (ref: unknown, args: unknown) => Promise<unknown>;
  return {
    runQuery: (ref: unknown, args: unknown) =>
      getFunctionName(ref as Parameters<typeof getFunctionName>[0]).includes(":canOffer")
        ? Promise.resolve(false)
        : query(ref, args),
    runMutation: (ref: unknown, args: unknown) => mutation(ref, args),
  } as unknown as ActionCtx;
}

async function toolsFor(t: T, role: Role, callerUserId: Id<"users">) {
  const tools = (await assembleCurriculumTools(actionCtx(t), () => {}, {
    role,
    callerUserId,
    surface: "channel",
  })) as unknown as Tool[];
  return (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };
}

async function seed(t: T) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const [home, other] = world.schools;
  const homeUnit = await makeUnit(t, home.teacher, home, { title: "Tide Pools (Otters)" });
  const otherUnit = await makeUnit(t, other.teacher, other, { title: "Volcano Watch" });
  const scholar = home.scholars[0];
  const questUnit = await makeUnit(t, scholar.id, home, {
    title: "Word Detective",
    authorScholarId: scholar.id,
  });
  return { home, other, homeUnit, otherUnit, questUnit };
}

const unit = (t: T, id: Id<"units">) => t.run((ctx) => ctx.db.get(id));

describe("update_unit on the staff aide", () => {
  test("a teacher retitles a unit and fills in its catalog fields by title", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    const res = JSON.parse(
      await tool("update_unit").run({
        unitTitle: "Tide Pools (Otters)",
        title: "  Tide Pool Ecosystems ",
        description: "Scholars survey a tide pool and map who eats whom.",
        subject: "Science",
        gradeLevel: "3-5",
        bigIdea: "Every creature in a pool depends on the others.",
        essentialQuestions: ["Who eats whom?", "What changes at low tide?"],
      }),
    ) as { updated: string[] };
    expect(res.updated).toEqual(
      expect.arrayContaining(["title", "description", "subject", "gradeLevel"]),
    );

    const after = await unit(t, s.homeUnit);
    expect(after?.title).toBe("Tide Pool Ecosystems");
    expect(after?.description).toBe("Scholars survey a tide pool and map who eats whom.");
    expect(after?.subject).toBe("Science");
    expect(after?.gradeLevel).toBe("3-5");
    expect(after?.bigIdea).toBe("Every creature in a pool depends on the others.");
    expect(after?.essentialQuestions?.map((q) => q.text)).toEqual([
      "Who eats whom?",
      "What changes at low tide?",
    ]);
    // A teacher's description stays teacher-facing.
    expect(after?.scholarDescription).toBeUndefined();
  });

  test("a blank title is refused and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    const res = await tool("update_unit").run({
      unitId: s.homeUnit,
      title: "   ",
      gradeLevel: "4",
    });
    expect(res).toMatch(/can't be blank/);
    const after = await unit(t, s.homeUnit);
    expect(after?.title).toBe("Tide Pools (Otters)");
    expect(after?.gradeLevel).toBeUndefined();
  });

  test("another school's unit is refused by id and not found by title", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    expect(
      await tool("update_unit").run({ unitId: s.otherUnit, title: "Mine now" }),
    ).toMatch(/^Refused/);
    expect(
      await tool("update_unit").run({ unitTitle: "Volcano Watch", title: "Mine now" }),
    ).toMatch(/No unit found/);
    expect((await unit(t, s.otherUnit))?.title).toBe("Volcano Watch");

    // The mutation holds the same line when called without the tool's pre-check.
    await expect(
      t.mutation(internal.curriculumAssistant.updateUnitForCaller, {
        callerUserId: s.home.teacher.id,
        unitId: s.otherUnit,
        title: "Mine now",
      }),
    ).rejects.toThrow(/Forbidden/);
    expect((await unit(t, s.otherUnit))?.title).toBe("Volcano Watch");
  });

  test("a staff account without curriculum standing at the school is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // A base staff membership and nothing else: the role alone is not edit access.
    const plainStaff = await t.run((ctx) =>
      ctx.db.insert("users", { role: "staff", name: "Avery Stone", username: "avery-plain" }),
    );
    await grantInstitutionMembership(t, plainStaff, s.home.id, "staff");

    await expect(
      t.mutation(internal.curriculumAssistant.updateUnitForCaller, {
        callerUserId: plainStaff,
        unitId: s.homeUnit,
        title: "Renamed",
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      t.mutation(internal.units.aideSetUnitArchived, {
        callerUserId: plainStaff,
        unitId: s.homeUnit,
        archived: true,
      }),
    ).rejects.toThrow(/Forbidden/);
    const after = await unit(t, s.homeUnit);
    expect(after?.title).toBe("Tide Pools (Otters)");
    expect(after?.isActive).toBe(true);
  });

  test("a read-only account is refused for both writes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.home.teacher.id, { readOnly: true }));
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    expect(
      await tool("update_unit").run({ unitId: s.homeUnit, title: "Renamed" }),
    ).toContain(READ_ONLY_ACCOUNT_ERROR);
    expect(await tool("archive_unit").run({ unitId: s.homeUnit })).toContain(
      READ_ONLY_ACCOUNT_ERROR,
    );
    const after = await unit(t, s.homeUnit);
    expect(after?.title).toBe("Tide Pools (Otters)");
    expect(after?.isActive).toBe(true);
  });
});

describe("archive_unit on the staff aide", () => {
  test("archives a teacher unit, brings it back by title, and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    const archived = JSON.parse(await tool("archive_unit").run({ unitId: s.homeUnit })) as {
      archived: boolean;
      changed: boolean;
    };
    expect(archived).toMatchObject({ archived: true, changed: true });
    expect((await unit(t, s.homeUnit))?.isActive).toBe(false);

    const again = JSON.parse(await tool("archive_unit").run({ unitId: s.homeUnit })) as {
      changed: boolean;
    };
    expect(again.changed).toBe(false);

    // An archived unit is still found by title, so it can be brought back.
    const back = JSON.parse(
      await tool("archive_unit").run({ unitTitle: "Tide Pools (Otters)", archived: false }),
    ) as { archived: boolean; changed: boolean };
    expect(back).toMatchObject({ archived: false, changed: true });
    expect((await unit(t, s.homeUnit))?.isActive).toBe(true);
  });

  test("refuses a scholar's own Quest both ways and points to the Quests tab", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // The home teacher can see this scholar, so the refusal is about the
    // unit being a Quest, not about access.
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    const res = await tool("archive_unit").run({ unitId: s.questUnit });
    expect(res).toContain(QUEST_ARCHIVE_REFUSAL);
    expect(res).toContain("Quests tab");
    expect((await unit(t, s.questUnit))?.isActive).toBe(true);

    // A retracted Quest can't be brought back this way either: reopen owns that.
    await t.run((ctx) => ctx.db.patch(s.questUnit, { isActive: false }));
    await expect(
      t.mutation(internal.units.aideSetUnitArchived, {
        callerUserId: s.home.teacher.id,
        unitId: s.questUnit,
        archived: false,
      }),
    ).rejects.toThrow(QUEST_ARCHIVE_REFUSAL);
    expect((await unit(t, s.questUnit))?.isActive).toBe(false);
  });

  test("another school's unit is refused and stays active", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    expect(await tool("archive_unit").run({ unitId: s.otherUnit })).toMatch(/^Refused/);
    await expect(
      t.mutation(internal.units.aideSetUnitArchived, {
        callerUserId: s.home.teacher.id,
        unitId: s.otherUnit,
        archived: true,
      }),
    ).rejects.toThrow(/Forbidden/);
    expect((await unit(t, s.otherUnit))?.isActive).toBe(true);
  });
});

describe("archive_unit and running assignments", () => {
  test("refuses while an assignment is running, then archives once it has ended", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: s.home.teacher.id,
        unitId: s.homeUnit,
        scholarIds: [s.home.scholars[0].id],
        title: "Tide Pools, spring",
        startedAt: Date.now(),
      }),
    );

    const res = await tool("archive_unit").run({ unitId: s.homeUnit });
    expect(res).toContain("still running");
    expect(res).toContain("Tide Pools, spring");
    expect(res).not.toMatch(/Uncaught|Request ID|\.ts:/);
    expect((await unit(t, s.homeUnit))?.isActive).toBe(true);

    await t.run((ctx) => ctx.db.patch(assignmentId, { archivedAt: Date.now() }));
    const done = JSON.parse(await tool("archive_unit").run({ unitId: s.homeUnit })) as {
      changed: boolean;
    };
    expect(done.changed).toBe(true);
    expect((await unit(t, s.homeUnit))?.isActive).toBe(false);
  });
});

describe("a scholar's own Quest", () => {
  test("keeps its title on both bots, while other fields still save", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);

    const res = await tool("update_unit").run({ unitId: s.questUnit, title: "Renamed" });
    expect(res).toMatch(/title is theirs/);
    await expect(
      t.mutation(internal.curriculumAssistant.updateUnitInternal, {
        unitId: s.questUnit,
        title: "Renamed",
      }),
    ).rejects.toThrow(/title is theirs/);
    expect((await unit(t, s.questUnit))?.title).toBe("Word Detective");

    await tool("update_unit").run({ unitId: s.questUnit, gradeLevel: "4" });
    expect((await unit(t, s.questUnit))?.gradeLevel).toBe("4");
  });

  test("list_units marks it, and archived units, for the model", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);
    const rows = JSON.parse(await tool("list_units").run({})) as {
      title: string;
      isQuest: boolean;
    }[];
    expect(rows.find((r) => r.title === "Word Detective")?.isQuest).toBe(true);
    expect(rows.find((r) => r.title === "Tide Pools (Otters)")?.isQuest).toBe(false);
  });
});

describe("update_unit reports what it wrote", () => {
  test("an echo of the current subject is not reported as a change", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.homeUnit, { subject: "Science" }));
    const tool = await toolsFor(t, ROLES.TEACHER, s.home.teacher.id);
    const res = JSON.parse(
      await tool("update_unit").run({ unitId: s.homeUnit, subject: "science", gradeLevel: "5" }),
    ) as { updated: string[] };
    expect(res.updated).toEqual(["gradeLevel"]);
  });
});

describe("toolErrorText", () => {
  test("unwraps a Convex server error to its one sentence", () => {
    const wrapped = new Error(
      "[CONVEX M(units:aideSetUnitArchived)] [Request ID: 1a2b3c4d5e6f7a8b] Server Error\nUncaught Error: Nothing was changed.\n    at handler (../convex/units.ts:1987:11)",
    );
    expect(toolErrorText(wrapped)).toBe("Nothing was changed.");
    expect(toolErrorText(new Error("Plain reason."))).toBe("Plain reason.");
  });
});

describe("staff with a curriculum:edit grant", () => {
  test("can tidy a unit at the grant's school but not reach a scholar's Quest", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const designer = await t.run((ctx) =>
      ctx.db.insert("users", { role: "staff", name: "Lehua Torres", username: "lehua-design" }),
    );
    await grantInstitutionMembership(t, designer, s.home.id, "staff");
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: designer,
        institutionId: s.home.id,
        capability: "curriculum:edit",
        grantedBy: s.home.admin.id,
        grantedAt: Date.now(),
      }),
    );
    const tool = await toolsFor(t, ROLES.STAFF, designer);

    await tool("update_unit").run({ unitId: s.homeUnit, title: "Tide Pool Ecosystems" });
    expect((await unit(t, s.homeUnit))?.title).toBe("Tide Pool Ecosystems");

    // No scholar access, so a Quest is refused before the Quest rule is reached.
    expect(
      await tool("update_unit").run({ unitId: s.questUnit, title: "Renamed" }),
    ).toMatch(/^Refused/);
    expect((await unit(t, s.questUnit))?.title).toBe("Word Detective");
  });
});

describe("update_unit on the unit page's Curriculum Bot", () => {
  test("the shared write now takes a title and a description", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId: s.homeUnit,
      title: "Tide Pool Ecosystems",
      description: "Map a tide pool's food web.",
    });
    const after = await unit(t, s.homeUnit);
    expect(after?.title).toBe("Tide Pool Ecosystems");
    expect(after?.description).toBe("Map a tide pool's food web.");

    await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId: s.homeUnit,
      description: null,
    });
    expect((await unit(t, s.homeUnit))?.description).toBeUndefined();
  });
});

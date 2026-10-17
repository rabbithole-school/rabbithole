/**
 * The file installer (TRA-493): a finished HTML app + optional character
 * becomes an unpublished unit → lesson → vibecode activity whose starter
 * scholars open, with no rehearsal session as a vessel.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { MAX_STATIC_HTML_BYTES } from "../customApps";
import { appAssetRef } from "../../shared/appAssets";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HTML = "<!doctype html><html><body>Widget</body></html>";
const CHARACTER = {
  name: "Widget",
  persona: "A literal maintenance index with no arms.",
  moods: ["literal", "helpful"],
  verdicts: ["loophole", "answered"],
  greeting: "Maintenance index online.",
  directorNotes: "Let the scholar find the loophole.",
};

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
) {
  return await t.run(async (ctx) => {
    const institutionId =
      role === "scholar"
        ? await ctx.db.insert("institutions", {
            name: "Test School",
            slug: "test-school",
            kind: "school",
          })
        : undefined;
    const userId = await ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `test-${role}`,
      role,
      institutionId,
    });
    if (institutionId) {
      await ctx.db.insert("memberships", {
        userId,
        role: "scholar",
        institutionId,
      });
    }
    return userId;
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

function baseArgs(authorUserId: Id<"users">) {
  return {
    authorUserId,
    unitTitle: "Robots",
    lessonTitle: "Literal minds",
    activityTitle: "Teach the robot",
    html: HTML,
    brief: "Play the game; the tutor directs Widget.",
  };
}

describe("appInstall.installAppAsActivity", () => {
  test("creates an unpublished unit, lesson, and Play-only vibecode activity with the starter and character", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");

    const result = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      character: CHARACTER,
      scholarDescription: "Teach a literal robot to help you.",
    });

    expect(result.created).toEqual({ unit: true, lesson: true, activity: true });
    expect(result.unitUnpublished).toBe(true);
    const rows = await t.run(async (ctx) => ({
      unit: await ctx.db.get(result.unitId),
      lesson: await ctx.db.get(result.lessonId),
      activity: await ctx.db.get(result.activityId),
      starter: await ctx.db.get(result.starterAppId),
    }));
    expect(rows.unit).toMatchObject({ title: "Robots", unpublished: true, teacherId });
    expect(rows.lesson).toMatchObject({ title: "Literal minds", unitId: result.unitId });
    expect(rows.activity).toMatchObject({
      title: "Teach the robot",
      kind: "online",
      appActivity: true,
      systemPrompt: "Play the game; the tutor directs Widget.",
      editAccess: "never",
      scholarsStartFrom: "starter",
      starterAppId: result.starterAppId,
      scholarDescription: "Teach a literal robot to help you.",
    });
    expect(rows.activity?.buildContract).toBeUndefined();
    expect(rows.starter).toMatchObject({
      kind: "static",
      status: "live",
      origin: "starter",
      html: HTML,
      name: "Teach the robot",
      createdBy: teacherId,
    });
    expect(rows.starter?.externalAppId).toBeUndefined();
    expect(rows.starter?.appAi?.character).toEqual(CHARACTER);
  });

  test("installs judges beside the character, and the activity description", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const judge = { id: "whatWentWrong", rubric: "Name the fault.", verdicts: ["too_much", "not_yet"] };
    const first = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      character: CHARACTER,
      judges: [judge],
      description: "Social Detective: saying enough.",
    });
    expect(first.judgeIds).toEqual(["whatWentWrong"]);
    const rows = await t.run(async (ctx) => ({
      activity: await ctx.db.get(first.activityId),
      starter: await ctx.db.get(first.starterAppId),
    }));
    expect(rows.activity?.description).toBe("Social Detective: saying enough.");
    expect(rows.starter?.appAi).toMatchObject({ character: CHARACTER, judges: [judge] });

    // A changed rubric updates the starter; dropping the file drops the judge.
    const changed = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      character: CHARACTER,
      judges: [{ ...judge, rubric: "Name the fault plainly." }],
    });
    expect(changed.starterChanged).toBe(true);
    const dropped = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      character: CHARACTER,
    });
    expect(dropped.starterChanged).toBe(true);
    expect(dropped.judgeIds).toEqual([]);

    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, {
        ...baseArgs(teacherId),
        judges: [{ ...judge, verdicts: ["Not A Token"] }],
      }),
    ).rejects.toThrow(/Judge whatWentWrong:/);
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, {
        ...baseArgs(teacherId),
        judges: [judge, judge],
      }),
    ).rejects.toThrow(/unique/);
  });

  test("a scholar session clones the installed app and its character", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await t.mutation(
      internal.appInstall.installAppAsActivity,
      { ...baseArgs(teacherId), character: CHARACTER },
    );
    // The teacher publishes it (the installer never does).
    await t.run((ctx) => ctx.db.patch(unitId, { unpublished: false }));
    const asScholar = await withUser(t, scholarId);
    const created = await asScholar.mutation(api.sessions.create, { activityId });
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", created.id))
        .collect(),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ type: "code", content: HTML });
    expect(artifacts[0].appAi?.character?.name).toBe("Widget");
  });

  test("is idempotent: an identical re-run writes nothing; a changed app updates the same starter", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const first = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      character: CHARACTER,
    });
    const again = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      character: CHARACTER,
    });
    expect(again.created).toEqual({ unit: false, lesson: false, activity: false });
    expect(again).toMatchObject({
      unitId: first.unitId,
      lessonId: first.lessonId,
      activityId: first.activityId,
      starterAppId: first.starterAppId,
      starterChanged: false,
      starterUpdatedAt: first.starterUpdatedAt,
    });

    const html2 = HTML.replace("Widget", "Widget v2");
    const changed = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      html: html2,
      character: { ...CHARACTER, greeting: "Index rebooted." },
    });
    expect(changed.starterChanged).toBe(true);
    expect(changed.starterAppId).toBe(first.starterAppId);
    const counts = await t.run(async (ctx) => ({
      units: (await ctx.db.query("units").collect()).length,
      activities: (await ctx.db.query("activities").collect()).length,
      apps: (await ctx.db.query("customApps").collect()).length,
      starter: await ctx.db.get(first.starterAppId),
    }));
    expect(counts).toMatchObject({ units: 1, activities: 1, apps: 1 });
    expect(counts.starter?.html).toBe(html2);
    expect(counts.starter?.appAi?.character?.greeting).toBe("Index rebooted.");
  });

  test("a re-run makes the activity match its files: contract set, then cleared", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const contract = {
      invariants: ["A rule only helps if it changes what Widget does next"],
      freedoms: ["the ship's look"],
      gate: "one rule written",
    };
    const { activityId } = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      buildContract: contract,
      allowSilence: true,
      editAccess: "afterCompletion",
    });
    let row = await t.run((ctx) => ctx.db.get(activityId));
    expect(row).toMatchObject({
      buildContract: contract,
      allowSilence: true,
      editAccess: "afterCompletion",
    });
    await t.mutation(internal.appInstall.installAppAsActivity, baseArgs(teacherId));
    row = await t.run((ctx) => ctx.db.get(activityId));
    expect(row?.buildContract).toBeUndefined();
    expect(row?.allowSilence).toBeUndefined();
    expect(row?.editAccess).toBe("never");
  });

  test("rejects oversized html, asset references, and non-HTML", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const big = `<!doctype html><html><body>${"x".repeat(MAX_STATIC_HTML_BYTES)}</body></html>`;
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, { ...baseArgs(teacherId), html: big }),
    ).rejects.toThrow(/too large/);
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, {
        ...baseArgs(teacherId),
        html: `<!doctype html><html><body><img src="${appAssetRef("kg2abc")}"></body></html>`,
      }),
    ).rejects.toThrow(/self-contained/);
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, { ...baseArgs(teacherId), html: "just text" }),
    ).rejects.toThrow(/HTML app/);
    // Nothing was written by any refusal.
    expect(await t.run(async (ctx) => (await ctx.db.query("units").collect()).length)).toBe(0);
  });

  test("rejects a bad character and a bad contract before writing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, {
        ...baseArgs(teacherId),
        character: { ...CHARACTER, moods: ["Not A Token", "fine"] },
      }),
    ).rejects.toThrow(/Character:/);
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, {
        ...baseArgs(teacherId),
        buildContract: { invariants: [], freedoms: [] },
      }),
    ).rejects.toThrow(/invariants/);
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, {
        ...baseArgs(teacherId),
        allowSilence: true,
      }),
    ).rejects.toThrow(/allowSilence needs a buildContract/);
    expect(await t.run(async (ctx) => (await ctx.db.query("units").collect()).length)).toBe(0);
  });

  test("refuses to turn a same-titled non-app activity into an app (contract on non-vibecode)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { lessonId } = await t.mutation(internal.appInstall.installAppAsActivity, {
      ...baseArgs(teacherId),
      activityTitle: "Something else",
      lessonTitle: "Literal minds",
    });
    await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Teach the robot",
        kind: "online",
        systemPrompt: "Discuss.",
        order: 5,
      }),
    );
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, {
        ...baseArgs(teacherId),
        buildContract: { invariants: ["x"], freedoms: [] },
      }),
    ).rejects.toThrow(/online activity, not an app/);
  });

  test("refuses a scholar author", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    await expect(
      t.mutation(internal.appInstall.installAppAsActivity, baseArgs(scholarId)),
    ).rejects.toThrow(/teacher or admin/);
  });
});

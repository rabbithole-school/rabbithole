import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { validateCharacterSpec } from "../appAiDirector";
import {
  MAX_DIRECTOR_NOTES_CHARS,
  MAX_JUDGES,
  MAX_PERSONA_CHARS,
} from "../../shared/appAiPolicy";
import { grantStaffAccessToScholars } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

const ROBOT = {
  name: "Bolt",
  persona: "A literal-minded robot who follows instructions exactly.",
  moods: ["Puzzled", "delighted"],
  verdicts: ["understood", "confused"],
};
const NOTES = "The scholar must find the goal unprompted; never hint at it.";

async function seedUser(t: T, role: "scholar" | "teacher", username: string) {
  return await t.run(async (ctx) => {
    const institutionId =
      role === "scholar"
        ? await ctx.db.insert("institutions", {
            name: `School ${username}`,
            slug: `school-${username}`,
            kind: "school",
          })
        : undefined;
    const userId = await ctx.db.insert("users", {
      name: username,
      username,
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

async function withUser(t: T, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedVibecodeActivity(t: T, teacherId: Id<"users">) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Robots",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Teach the robot",
      order: 0,
    });
    return await ctx.db.insert("activities", {
      lessonId,
      title: "Teach the robot",
      kind: "vibecode",
      systemPrompt: "Coach the scholar while they teach the robot.",
      order: 0,
    });
  });
}

async function seedAppSession(
  t: T,
  ownerId: Id<"users">,
  opts: { activityId?: Id<"activities">; isTestDrive?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: ownerId,
      title: "Robot app",
      sessionMode: "vibecode",
      isArchived: false,
      ...(opts.activityId ? { activityId: opts.activityId } : {}),
      ...(opts.isTestDrive ? { isTestDrive: true } : {}),
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Robot app",
      content: "<!doctype html><p>robot</p>",
      lastEditedBy: "ai",
      revision: 0,
      type: "code",
      language: "html",
    });
    return { sessionId, artifactId };
  });
}

describe("validateCharacterSpec", () => {
  test("normalizes moods and verdicts to lowercase tokens", () => {
    const result = validateCharacterSpec(ROBOT);
    expect(result).toMatchObject({
      ok: true,
      value: { moods: ["puzzled", "delighted"] },
    });
  });

  test.each([
    ["one mood", { ...ROBOT, moods: ["puzzled"] }],
    ["seven moods", { ...ROBOT, moods: ["a", "b", "c", "d", "e", "f", "g"] }],
    ["a multi-word mood", { ...ROBOT, moods: ["very puzzled", "happy"] }],
    ["a repeated mood", { ...ROBOT, moods: ["happy", "Happy"] }],
    ["an empty name", { ...ROBOT, name: "  " }],
    ["an oversized persona", { ...ROBOT, persona: "x".repeat(MAX_PERSONA_CHARS + 1) }],
    [
      "oversized director notes",
      { ...ROBOT, directorNotes: "x".repeat(MAX_DIRECTOR_NOTES_CHARS + 1) },
    ],
  ])("rejects %s", (_label, input) => {
    expect(validateCharacterSpec(input).ok).toBe(false);
  });

  test("keeps trimmed director notes and drops blank ones", () => {
    const kept = validateCharacterSpec({ ...ROBOT, directorNotes: `  ${NOTES} ` });
    expect(kept.ok && kept.value.directorNotes).toBe(NOTES);
    const blank = validateCharacterSpec({ ...ROBOT, directorNotes: "   " });
    expect(blank.ok && blank.value).not.toHaveProperty("directorNotes");
  });
});

describe("define_character / define_judge", () => {
  test("writes the spec onto the session's code app and merges character with judges", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "scholar", "owner");
    const { sessionId, artifactId } = await seedAppSession(t, ownerId);

    await expect(
      t.mutation(internal.appAiDirector.defineJudge, {
        sessionId,
        callerUserId: ownerId,
        judge: { id: "rule", rubric: "A clear rule names one action.", verdicts: ["clear", "vague"] },
      }),
    ).resolves.toMatchObject({ ok: true, artifactId, starterSynced: false });
    await t.mutation(internal.appAiDirector.defineCharacter, {
      sessionId,
      callerUserId: ownerId,
      character: { ...ROBOT, directorNotes: NOTES },
    });
    // Same id replaces rather than appends.
    await t.mutation(internal.appAiDirector.defineJudge, {
      sessionId,
      callerUserId: ownerId,
      judge: { id: "rule", rubric: "Revised rubric.", verdicts: ["clear"] },
    });

    const artifact = await t.run((ctx) => ctx.db.get(artifactId));
    expect(artifact?.appAi?.character).toMatchObject({
      name: "Bolt",
      moods: ["puzzled", "delighted"],
      verdicts: ["understood", "confused"],
      directorNotes: NOTES,
    });
    expect(artifact?.appAi?.judges).toEqual([
      { id: "rule", rubric: "Revised rubric.", verdicts: ["clear"] },
    ]);
    expect(artifact?.appAi?.updatedAt).toEqual(expect.any(Number));
  });

  test("refuses more judges than the cap and an app that does not exist yet", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "scholar", "owner");
    const { sessionId } = await seedAppSession(t, ownerId);
    for (let index = 0; index < MAX_JUDGES; index += 1) {
      await t.mutation(internal.appAiDirector.defineJudge, {
        sessionId,
        callerUserId: ownerId,
        judge: { id: `judge${index}`, rubric: "r", verdicts: ["ok"] },
      });
    }
    await expect(
      t.mutation(internal.appAiDirector.defineJudge, {
        sessionId,
        callerUserId: ownerId,
        judge: { id: "oneTooMany", rubric: "r", verdicts: ["ok"] },
      }),
    ).resolves.toMatchObject({ ok: false });

    const empty = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: ownerId,
        title: "No app yet",
        sessionMode: "vibecode",
        isArchived: false,
      }),
    );
    await expect(
      t.mutation(internal.appAiDirector.defineCharacter, {
        sessionId: empty,
        callerUserId: ownerId,
        character: ROBOT,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  test("only the session owner can define a character", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "scholar", "owner");
    const otherId = await seedUser(t, "scholar", "other");
    const { sessionId } = await seedAppSession(t, ownerId);
    await expect(
      t.mutation(internal.appAiDirector.defineCharacter, {
        sessionId,
        callerUserId: otherId,
        character: ROBOT,
      }),
    ).rejects.toThrow();
  });
});

describe("the spec travels with the app", () => {
  test("promotion snapshots it and a persona-only edit reaches the promoted starter", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "teacher");
    const activityId = await seedVibecodeActivity(t, teacherId);
    const { sessionId, artifactId } = await seedAppSession(t, teacherId, {
      activityId,
      isTestDrive: true,
    });
    await t.mutation(internal.appAiDirector.defineCharacter, {
      sessionId,
      callerUserId: teacherId,
      character: ROBOT,
    });
    const promoted = await t.mutation(
      internal.activities.commitVibecodeStarterFromArtifact,
      {
        activityId,
        artifactId,
        callerUserId: teacherId,
        sourceRevision: 0,
        html: "<!doctype html><p>robot</p>",
        appAssetIds: [],
      },
    );
    expect(
      (await t.run((ctx) => ctx.db.get(promoted.id)))?.appAi?.character?.name,
    ).toBe("Bolt");

    // No code change, so autosave would short-circuit; the define tool itself
    // carries the edit onto the starter.
    const result = await t.mutation(internal.appAiDirector.defineCharacter, {
      sessionId,
      callerUserId: teacherId,
      character: { ...ROBOT, name: "Bolt Mk II", directorNotes: NOTES },
    });
    expect(result).toMatchObject({ ok: true, starterSynced: true });
    const starter = await t.run((ctx) => ctx.db.get(promoted.id));
    expect(starter?.appAi?.character?.name).toBe("Bolt Mk II");
    expect(starter?.appAi?.character?.directorNotes).toBe(NOTES);
    expect(starter?.sourceRevision).toBe(0);
  });

  test("a scholar's session cloned from the starter carries the spec", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "teacher");
    const scholarId = await seedUser(t, "scholar", "scholar");
    const activityId = await seedVibecodeActivity(t, teacherId);
    const appAi = {
      character: {
        name: "Bolt",
        persona: "p",
        moods: ["puzzled", "happy"],
        directorNotes: NOTES,
      },
      judges: [{ id: "rule", rubric: "r", verdicts: ["clear"] }],
      updatedAt: 1,
    };
    await t.run(async (ctx) => {
      const starterAppId = await ctx.db.insert("customApps", {
        token: "robot-starter",
        name: "Robot app",
        kind: "static",
        status: "live",
        html: "<!doctype html><p>robot</p>",
        origin: "starter",
        createdBy: teacherId,
        updatedAt: 5,
        appAi,
      });
      await ctx.db.patch(activityId, {
        starterAppId,
        scholarsStartFrom: "starter",
      });
    });

    const created = await (await withUser(t, scholarId)).mutation(
      api.sessions.create,
      { activityId },
    );
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", created.id))
        .collect(),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].appAi).toEqual(appAi);
  });

  test("forking an activity copies the spec onto the new starter", async () => {
    const t = convexTest(schema, modules);
    const sourceTeacherId = await seedUser(t, "teacher", "source-teacher");
    const callerId = await seedUser(t, "teacher", "forking-teacher");
    const activityId = await seedVibecodeActivity(t, sourceTeacherId);
    const appAi = {
      character: {
        name: "Bolt",
        persona: "p",
        moods: ["puzzled", "happy"],
        directorNotes: NOTES,
      },
      updatedAt: 1,
    };
    await t.run(async (ctx) => {
      const starterAppId = await ctx.db.insert("customApps", {
        token: "robot-source",
        name: "Robot app",
        kind: "static",
        status: "live",
        html: "<!doctype html><p>robot</p>",
        origin: "starter",
        createdBy: sourceTeacherId,
        updatedAt: 5,
        appAi,
      });
      await ctx.db.patch(activityId, { starterAppId });
    });

    const result = await (await withUser(t, callerId)).mutation(
      api.activities.forkToMyUnit,
      { activityId },
    );
    const starter = await t.run(async (ctx) => {
      const activity = await ctx.db.get(result.activityId);
      return activity?.starterAppId ? ctx.db.get(activity.starterAppId) : null;
    });
    expect(starter?.token).not.toBe("robot-source");
    expect(starter?.appAi).toEqual(appAi);
  });

  test("the scholar's own artifact reads never carry the spec", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "scholar", "owner");
    const { sessionId, artifactId } = await seedAppSession(t, ownerId);
    await t.mutation(internal.appAiDirector.defineCharacter, {
      sessionId,
      callerUserId: ownerId,
      character: { ...ROBOT, directorNotes: NOTES },
    });
    const owner = await withUser(t, ownerId);
    const rows = await owner.query(api.artifacts.getBySession, { sessionId });
    const one = await owner.query(api.artifacts.getById, { artifactId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("appAi");
    expect(one).not.toBeNull();
    expect(one).not.toHaveProperty("appAi");
    expect(JSON.stringify([rows, one])).not.toContain(NOTES);
  });
});

describe("director mutations", () => {
  async function seedCharacterApp(t: T) {
    const ownerId = await seedUser(t, "scholar", "owner");
    const teacherId = await seedUser(t, "teacher", "teacher");
    const { sessionId, artifactId } = await seedAppSession(t, ownerId);
    await t.mutation(internal.appAiDirector.defineCharacter, {
      sessionId,
      callerUserId: ownerId,
      character: ROBOT,
    });
    return { ownerId, teacherId, sessionId, artifactId };
  }

  test("finds the directable character only for the owner of an app that has one", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, teacherId, sessionId, artifactId } =
      await seedCharacterApp(t);
    await expect(
      t.query(internal.appAiDirector.directableCharacterForSession, {
        sessionId,
        callerUserId: ownerId,
      }),
    ).resolves.toEqual({
      artifactId,
      name: "Bolt",
      moods: ["puzzled", "delighted"],
      verdicts: ["understood", "confused"],
    });
    await expect(
      t.query(internal.appAiDirector.directableCharacterForSession, {
        sessionId,
        callerUserId: teacherId,
      }),
    ).resolves.toBeNull();

    const plain = await seedAppSession(t, ownerId);
    await expect(
      t.query(internal.appAiDirector.directableCharacterForSession, {
        sessionId: plain.sessionId,
        callerUserId: ownerId,
      }),
    ).resolves.toBeNull();
  });

  test("records a standing direction and refuses one that is too long", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, sessionId, artifactId } = await seedCharacterApp(t);
    await t.mutation(internal.appAiDirector.recordDirection, {
      sessionId,
      artifactId,
      callerUserId: ownerId,
      direction: "  Fold on the next reasonable attempt.  ",
    });
    await expect(
      t.mutation(internal.appAiDirector.recordDirection, {
        sessionId,
        artifactId,
        callerUserId: ownerId,
        direction: "x".repeat(501),
      }),
    ).rejects.toThrow();
    const rows = await t.run((ctx) => ctx.db.query("appAiTurns").collect());
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "direction",
        status: "done",
        direction: "Fold on the next reasonable attempt.",
      }),
    ]);
  });

  test("speaking upserts the app's mailbox when no state row exists and overrules the latest verdict", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, teacherId, sessionId, artifactId } =
      await seedCharacterApp(t);
    const [older, latest] = await t.run(async (ctx) => [
      await ctx.db.insert("appAiTurns", {
        sessionId,
        artifactId,
        kind: "exchange",
        status: "done",
        scholarLine: "Walk.",
        line: "Which leg?",
        mood: "puzzled",
        verdict: "confused",
        createdAt: 1,
      }),
      await ctx.db.insert("appAiTurns", {
        sessionId,
        artifactId,
        kind: "exchange",
        status: "done",
        scholarLine: "Lift your left leg.",
        line: "Lifted. Now what?",
        mood: "puzzled",
        verdict: "confused",
        createdAt: 2,
      }),
    ]);
    expect(
      await t.run((ctx) => ctx.db.query("appStates").collect()),
    ).toEqual([]);

    const spoken = await t.mutation(internal.appAiDirector.speakAsCharacter, {
      sessionId,
      artifactId,
      callerUserId: ownerId,
      line: "Oh! I think I get it.",
      mood: "delighted",
      verdict: "understood",
    });
    expect(spoken.overrodeVerdict).toBe(true);

    const owner = await withUser(t, ownerId);
    const ownerView = await owner.query(api.appStates.getSessionState, {
      artifactId,
    });
    expect(ownerView?.characterLine).toMatchObject({
      id: String(spoken.turnId),
      line: "Oh! I think I get it.",
      mood: "delighted",
      verdict: "understood",
    });

    // An authorized teacher sees the row but not the owner-only mailbox.
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherId,
      scholarIds: [ownerId],
    });
    const teacherView = await (await withUser(t, teacherId)).query(
      api.appStates.getSessionState,
      { artifactId },
    );
    expect(teacherView).toMatchObject({ version: ownerView?.version });
    expect(teacherView?.characterLine).toBeUndefined();

    const turns = await t.run(async (ctx) => ({
      older: await ctx.db.get(older),
      latest: await ctx.db.get(latest),
      aside: await ctx.db.get(spoken.turnId),
    }));
    expect(turns.latest?.verdictOverride?.verdict).toBe("understood");
    expect(turns.older?.verdictOverride).toBeUndefined();
    expect(turns.aside).toMatchObject({ kind: "aside", line: "Oh! I think I get it." });

    // A second line bumps the same row's version rather than adding a row.
    await t.mutation(internal.appAiDirector.speakAsCharacter, {
      sessionId,
      artifactId,
      callerUserId: ownerId,
      line: "Again?",
    });
    const rows = await t.run((ctx) => ctx.db.query("appStates").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe((ownerView?.version ?? 0) + 1);
    expect(rows[0].characterLine?.line).toBe("Again?");
  });

  test("refuses a mood the character does not have", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, sessionId, artifactId } = await seedCharacterApp(t);
    await expect(
      t.mutation(internal.appAiDirector.speakAsCharacter, {
        sessionId,
        artifactId,
        callerUserId: ownerId,
        line: "Hello",
        mood: "furious",
      }),
    ).rejects.toThrow();
  });
});

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  APP_OFF_TRACK_ALERT_KIND,
  OFF_MISSION_ALERT_KIND,
  buildOffMissionAlert,
  entersOffTrack,
} from "../appOffTrackAlert";
import { CONCERN_ON_TASK } from "../lib/rosterPulse";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

const OFF = CONCERN_ON_TASK - 0.3; // e.g. the 0.15 the 2026-10-09 session hit
const ON = 0.9;

async function seedTeacher(
  t: T,
  institutionId: Id<"institutions">,
  slackUserId: string,
  name: string,
): Promise<Id<"users">> {
  const id = await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username: `${name.toLowerCase()}-${slackUserId.toLowerCase()}`,
      role: "teacher",
      institutionId,
      slackUserId,
    }),
  );
  await grantInstitutionMembership(t, id, institutionId, "teacher");
  return id;
}

async function seedWorld(
  t: T,
  opts: {
    session?: Partial<Doc<"sessions">>;
    assignmentTeacherElsewhere?: boolean;
    buildContract?: boolean;
    /** Fields of the activity, replacing the default vibecode app. */
    activity?: Partial<Doc<"activities">>;
    /** The session has no activity (open chat, Quest planning, exploration). */
    noActivity?: boolean;
  } = {},
) {
  const institutionId = await seedTestInstitution(t, { slug: "home-school" });
  const otherInstitutionId = await seedTestInstitution(t, {
    slug: "other-school",
    isPrimary: false,
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Ava",
  });
  const unitTeacherId = await seedTeacher(t, institutionId, "UUNIT01", "Una");
  const assignmentTeacherId = await seedTeacher(
    t,
    opts.assignmentTeacherElsewhere ? otherInstitutionId : institutionId,
    "UASSIGN01",
    "Asa",
  );
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("alertChannel", {
      slackChannelId: "C_HOME",
      linkedBy: unitTeacherId,
      linkedAt: Date.now(),
      institutionId,
      role: "scoped",
    });
    await ctx.db.insert("alertChannel", {
      slackChannelId: "C_OTHER",
      linkedBy: unitTeacherId,
      linkedAt: Date.now(),
      institutionId: otherInstitutionId,
      role: "scoped",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId: unitTeacherId,
      institutionId,
      title: "Outbreak",
      isActive: true,
    });
    const activityId = await ctx.db.insert("activities", {
      title: "Cholera game",
      kind: "vibecode",
      order: 0,
      ...(opts.buildContract
        ? {
            buildContract: {
              invariants: ["cholera spreads only through contaminated water"],
              freedoms: ["setting"],
            },
          }
        : {}),
      ...opts.activity,
    } as Doc<"activities">);
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId: assignmentTeacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      unitId,
      ...(opts.noActivity ? {} : { activityId }),
      assignmentId,
      sessionMode: "vibecode",
      title: "My cholera game",
      isArchived: false,
      ...opts.session,
    });
    return { unitId, activityId, assignmentId, sessionId };
  });
  return {
    ...ids,
    institutionId,
    otherInstitutionId,
    scholarId,
    unitTeacherId,
    assignmentTeacherId,
  };
}

async function reading(t: T, sessionId: Id<"sessions">, onTaskScore: number) {
  await t.mutation(internal.analysisHelpers.saveAnalysis, {
    sessionId,
    engagementScore: 0.7,
    complexityLevel: 0.5,
    onTaskScore,
    topics: ["Disease spread"],
    learningIndicators: [],
    concernFlags: onTaskScore < CONCERN_ON_TASK ? ["curriculum_drift"] : [],
    summary: "The game has drifted from the microbe model into combat.",
    pulseScore: 2,
  });
}

async function offTrackAlerts(t: T) {
  return await t.run((ctx) =>
    ctx.db
      .query("alerts")
      .filter((q) => q.eq(q.field("kind"), OFF_MISSION_ALERT_KIND))
      .collect(),
  );
}

/** The captured outbound Slack call: the scheduled postNow args. */
async function slackPosts(t: T) {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs
    .filter((j) => j.name.includes("slackNotifications") && j.name.includes("postNow"))
    .map((j) => j.args[0] as { channelId: string; text: string });
}

describe("entersOffTrack", () => {
  test("needs two consecutive off-track readings, entered from on-track or nothing", () => {
    expect(entersOffTrack([{ onTaskScore: OFF }])).toBe(false);
    expect(entersOffTrack([{ onTaskScore: OFF }, { onTaskScore: ON }])).toBe(false);
    expect(entersOffTrack([{ onTaskScore: OFF }, { onTaskScore: OFF }])).toBe(true);
    expect(
      entersOffTrack([{ onTaskScore: OFF }, { onTaskScore: OFF }, { onTaskScore: ON }]),
    ).toBe(true);
    // Already off track before this pair: not a new entry.
    expect(
      entersOffTrack([{ onTaskScore: OFF }, { onTaskScore: OFF }, { onTaskScore: OFF }]),
    ).toBe(false);
    // The floor is the roster's own concern line, exclusive.
    expect(
      entersOffTrack([{ onTaskScore: CONCERN_ON_TASK }, { onTaskScore: CONCERN_ON_TASK }]),
    ).toBe(false);
    expect(entersOffTrack([{}, { onTaskScore: OFF }])).toBe(false);
  });
});

describe("app off-track alert", () => {
  test("fires on the second consecutive off-track reading, not the first", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
    await reading(t, w.sessionId, OFF);
    const alerts = await offTrackAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].scholarId).toBe(w.scholarId);
    expect(alerts[0].sessionId).toBe(w.sessionId);
  });

  test("one noisy reading between on-track readings never alerts", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    for (const s of [ON, OFF, ON, OFF, ON]) await reading(t, w.sessionId, s);
    expect(await offTrackAlerts(t)).toHaveLength(0);
  });

  test.each([
    ["a test drive (teacher build)", { isTestDrive: true }],
    ["free play", { freePlay: true }],
    ["an archived session", { isArchived: true }],
    ["an offline row", { isOffline: true }],
    ["a seeded exemplar", { seedExemplar: true }],
  ])("never fires for %s", async (_label, session) => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { session });
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
  });

  test("an app activity still alerts, whatever the session mode", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, {
      session: { sessionMode: "conversation" as const },
    });
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(1);
  });
});

describe("off-mission alert", () => {
  const ESSAY = {
    kind: "online" as const,
    title: "Field journal",
    deliverable: {
      kind: "text" as const,
      prompt: "Write about the pond.",
      mode: "none" as const,
      criteria: [],
    },
  };

  test("an essay activity with a text deliverable alerts after two low readings", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, {
      activity: ESSAY,
      session: { sessionMode: "conversation" as const },
    });
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
    await reading(t, w.sessionId, OFF);
    const alerts = await offTrackAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("off_mission");
    expect(alerts[0].dedupKey).toBe(`off_mission:${w.sessionId}`);
    const [post] = await slackPosts(t);
    expect(post.text).toContain("🧭");
    expect(post.text).toContain("Ava looks off mission in Field journal");
  });

  test("a discussion-only (advanceRubric) activity has no mission and never alerts", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, {
      activity: {
        kind: "online" as const,
        title: "Circle talk",
        advanceRubric: { criteria: [{ id: "c1", label: "Shares a view" }] },
      },
      session: { sessionMode: "conversation" as const },
    });
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
  });

  test("a session with no activity (open chat, Quest planning, seed exploration) never alerts", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, {
      noActivity: true,
      session: { sessionMode: "conversation" as const },
    });
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);

    // A seed exploration is an activity-less session carrying a seed.
    const seeded = await seedWorld(t, { noActivity: true });
    const seedId = await t.run((ctx) =>
      ctx.db.insert("seeds", {
        scholarId: seeded.scholarId,
        origin: "ai",
        status: "active",
        topic: "Why is the sky dark at night",
        suggestionType: "frontier",
        rationale: "test",
      }),
    );
    await t.run((ctx) => ctx.db.patch(seeded.sessionId, { seedId }));
    await reading(t, seeded.sessionId, OFF);
    await reading(t, seeded.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
  });

  test("the message carries the authored gate, or the default gate marked as default", async () => {
    const t = convexTest(schema, modules);
    const authored = await seedWorld(t, {
      activity: {
        ...ESSAY,
        buildContract: {
          invariants: [],
          freedoms: [],
          gate: "GATE-first-paragraph-about-the-heron",
        },
      },
    });
    await reading(t, authored.sessionId, OFF);
    await reading(t, authored.sessionId, OFF);
    const dflt = await seedWorld(t, { activity: ESSAY });
    await reading(t, dflt.sessionId, OFF);
    await reading(t, dflt.sessionId, OFF);
    const [a, d] = await slackPosts(t);
    expect(a.text).toContain("Mission: GATE-first-paragraph-about-the-heron");
    expect(a.text).not.toContain("(default)");
    expect(d.text).toContain("Mission: (default) ");
  });

  test("a contract with no gate still reads as the default gate", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, {
      activity: {
        ...ESSAY,
        buildContract: { invariants: [], freedoms: ["FREE-which-bird"] },
      },
    });
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    const [post] = await slackPosts(t);
    expect(post.text).toContain("Mission: (default) ");
  });

  test("a scholar who has completed the activity is never alerted", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { activity: ESSAY });
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: w.scholarId,
        activityId: w.activityId,
        assignmentId: w.assignmentId,
        sessionId: w.sessionId,
        completedAt: Date.now(),
      }),
    );
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
  });

  test("a completion under another assignment does not silence this one", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { activity: ESSAY });
    await t.run(async (ctx) => {
      const otherAssignment = await ctx.db.insert("assignments", {
        teacherId: w.unitTeacherId,
        unitId: w.unitId,
        scholarIds: [w.scholarId],
        startedAt: Date.now(),
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: w.scholarId,
        activityId: w.activityId,
        assignmentId: otherAssignment,
        completedAt: Date.now(),
      });
    });
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(1);
  });

  test("the saved-ideas line appears only when the lot is non-empty", async () => {
    const t = convexTest(schema, modules);
    const empty = await seedWorld(t, { activity: ESSAY });
    await reading(t, empty.sessionId, OFF);
    await reading(t, empty.sessionId, OFF);
    const withLot = await seedWorld(t, {
      activity: ESSAY,
      session: {
        parkingLot: [
          { text: "a podcast about herons", parkedAt: Date.now() },
          { text: "a heron board game", parkedAt: Date.now() },
        ],
      },
    });
    await reading(t, withLot.sessionId, OFF);
    await reading(t, withLot.sessionId, OFF);
    const [e, l] = await slackPosts(t);
    expect(e.text).not.toContain("saved");
    expect(l.text).toContain("The tutor has saved 2 ideas for later this session.");
  });

  test("the 12-hour window holds across the old and new kinds for one session", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // A session already paged under the app-only kind.
    await t.run((ctx) =>
      ctx.db.insert("alerts", {
        kind: APP_OFF_TRACK_ALERT_KIND,
        severity: "warning",
        title: "old",
        body: "old",
        source: "observer",
        scholarId: w.scholarId,
        sessionId: w.sessionId,
        dedupKey: `${APP_OFF_TRACK_ALERT_KIND}:${w.sessionId}`,
        status: "open",
        createdAt: Date.now() - 60 * 60 * 1000,
      }),
    );
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
  });

  test("an old-kind alert past the window no longer blocks the new kind", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("alerts", {
        kind: APP_OFF_TRACK_ALERT_KIND,
        severity: "warning",
        title: "old",
        body: "old",
        source: "observer",
        scholarId: w.scholarId,
        sessionId: w.sessionId,
        dedupKey: `${APP_OFF_TRACK_ALERT_KIND}:${w.sessionId}`,
        status: "open",
        createdAt: Date.now() - 13 * 60 * 60 * 1000,
      }),
    );
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(1);
  });

  test("a sustained off-track session alerts once; clearing and returning the same day stays at one", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    for (const s of [OFF, OFF, OFF, OFF, ON, OFF, OFF]) {
      await reading(t, w.sessionId, s);
    }
    expect(await offTrackAlerts(t)).toHaveLength(1);
  });

  test("after the daily window, only a cleared-and-returned state re-alerts", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    // Age the first alert past the fabric's 12h coalescing window.
    await t.run(async (ctx) => {
      const [a] = await ctx.db.query("alerts").collect();
      await ctx.db.patch(a._id, { createdAt: Date.now() - 13 * 60 * 60 * 1000 });
    });
    await reading(t, w.sessionId, OFF); // still the same episode
    expect(await offTrackAlerts(t)).toHaveLength(1);
    await reading(t, w.sessionId, ON);
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF); // a new episode
    expect(await offTrackAlerts(t)).toHaveLength(2);
  });

  test("names the assignment's teacher and posts to the scholar's school channel", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    const posts = await slackPosts(t);
    expect(posts).toHaveLength(1);
    expect(posts[0].channelId).toBe("C_HOME");
    expect(posts[0].text).toContain("<@UASSIGN01>");
    expect(posts[0].text).not.toContain("<@UUNIT01>");
  });

  test("never names a teacher from another school; falls back to the unit's teacher", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { assignmentTeacherElsewhere: true });
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    const posts = await slackPosts(t);
    expect(posts.map((p) => p.channelId)).toEqual(["C_HOME"]);
    expect(posts[0].text).toContain("<@UUNIT01>");
    expect(posts[0].text).not.toContain("<@UASSIGN01>");
  });

  test("no in-school owning teacher → no alert", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { assignmentTeacherElsewhere: true });
    await t.run((ctx) => ctx.db.patch(w.sessionId, { unitId: undefined }));
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    expect(await offTrackAlerts(t)).toHaveLength(0);
  });

  test("message shape: who, where, the observer's line, a session link — no scores", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { buildContract: true });
    await t.run((ctx) =>
      ctx.db.patch(w.sessionId, {
        parkingLot: [
          { text: "a crossbow", parkedAt: Date.now() },
          { text: "a boss fight", parkedAt: Date.now() },
        ],
      }),
    );
    await reading(t, w.sessionId, OFF);
    await reading(t, w.sessionId, OFF);
    const [post] = await slackPosts(t);
    const lines = post.text.split("\n");
    expect(lines[0]).toContain("Ava");
    expect(lines[0]).toContain("Cholera game");
    expect(lines[1].startsWith("<@UASSIGN01> ")).toBe(true);
    expect(lines[1]).toContain("microbe model");
    expect(lines[2].startsWith("Mission: ")).toBe(true);
    expect(lines[3]).toContain("2 ideas for later");
    expect(lines.at(-1)).toContain(`/scholar/${w.sessionId}?remote=${w.scholarId}`);
    expect(post.text).not.toMatch(/0\.\d/);
  });
});

describe("buildOffMissionAlert", () => {
  test("drops a malformed Slack id, names the mission, omits the saved-ideas line when there is none", () => {
    const { title, body } = buildOffMissionAlert({
      scholarName: "Ava",
      activityTitle: "Cholera game",
      observerSummary: "Drifted into combat.",
      mission: { gateAuthored: true, gate: "The microbe model has run once." },
      teacherSlackUserId: "not-an-id>",
      parkedIdeas: 0,
    });
    expect(title).toBe("Ava looks off mission in Cholera game");
    expect(body).toBe(
      "Drifted into combat.\nMission: The microbe model has run once.",
    );
  });

  test("a single saved idea reads in the singular", () => {
    const { body } = buildOffMissionAlert({
      scholarName: "Ava",
      activityTitle: "Field journal",
      observerSummary: "Wandered off.",
      mission: { gateAuthored: false, gate: "A first draft exists." },
      parkedIdeas: 1,
    });
    expect(body).toContain("Mission: (default) A first draft exists.");
    expect(body).toContain("The tutor has saved 1 idea for later this session.");
  });
});

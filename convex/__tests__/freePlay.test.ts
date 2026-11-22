// "Build it now" after an app activity is done: eligibility (lib/freePlay.ts,
// as getWithMessages.freePlayEligible and the startFreePlay gate), carrying on
// in the SAME session (no copy is made any more), and the prompt of a finished
// session (the contract stays, the gate counts as met, the scholar makes the
// rules). Free-play COPIES made before one-session building (TRA-489) still
// exist in prod, so their prompt (no contract, the opener, the shared weapons
// definition), the designer-tool gate, and that they never record a completion
// or become "the" activity session stay covered, on rows inserted directly.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  SCHOLAR_RULES_STEERING,
  WEAPON_DEFINITION,
  buildFreePlayOpenerSection,
  type DesignerBuildContract,
} from "../prompts";
import { buildTutorSystemPromptParts } from "../sessionStreamHelpers";
import {
  PARK_IDEA_TOOL_NAME,
  UNPARK_IDEA_TOOL_NAME,
  missionToolOffer,
} from "../lib/designerTools";
import { reconcileActivityCompletion } from "../lib/activityCompletionCore";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Fictional sentinels: their presence or absence proves plumbing, not wording.
const CONTRACT: DesignerBuildContract = {
  invariants: ["INV-pond-oxygen-falls-as-algae-grows"],
  freedoms: ["FREE-what-the-fish-look-like"],
  gate: "GATE-oxygen-curve-has-run-once",
};
const LOT = [
  { text: "IDEA-rainbow-fish", parkedAt: 1, reason: "REASON-later" },
  { text: "IDEA-night-mode", parkedAt: 2 },
];
const APP_HTML = "<html><body>APP-pond-v7</body></html>";

type Seed = {
  scholarId: Id<"users">;
  activityId: Id<"activities">;
  sessionId: Id<"sessions">;
  unitId: Id<"units">;
};

async function seed(
  t: ReturnType<typeof convexTest>,
  opts: {
    editAccess?: "always" | "never" | "afterCompletion";
    lot?: typeof LOT | null;
    complete?: boolean;
    buildContract?: DesignerBuildContract;
  } = {},
): Promise<Seed> {
  const institutionId = await seedTestInstitution(t);
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      title: "Pond unit",
      isActive: true,
      institutionId,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Pond lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build a pond",
      kind: "vibecode",
      order: 0,
      editAccess: opts.editAccess ?? "afterCompletion",
      buildContract: opts.buildContract ?? CONTRACT,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Build a pond",
      sessionMode: "vibecode",
      isArchived: false,
      unitId,
      lessonId,
      activityId,
      ...(opts.lot === null ? {} : { parkingLot: opts.lot ?? LOT }),
    });
    await ctx.db.insert("artifacts", {
      sessionId,
      title: "Pond",
      content: APP_HTML,
      lastEditedBy: "ai",
      revision: 7,
      type: "code",
      language: "html",
    });
    if (opts.complete ?? true) {
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        sessionId,
        completedAt: Date.now(),
      });
      await ctx.db.patch(sessionId, { activityCompletedAt: Date.now() });
    }
    return { scholarId, activityId, sessionId, unitId };
  });
}

/** A free-play COPY as startFreePlay made them before one-session building
 *  (TRA-489): prod still holds these rows, and they must keep working. */
async function insertLegacyCopy(
  t: ReturnType<typeof convexTest>,
  s: Seed,
): Promise<Id<"sessions">> {
  return await t.run(async (ctx) => {
    const source = await ctx.db.get(s.sessionId);
    const sessionId = await ctx.db.insert("sessions", {
      userId: s.scholarId,
      ...(source?.institutionId ? { institutionId: source.institutionId } : {}),
      unitId: s.unitId,
      lessonId: source?.lessonId,
      activityId: s.activityId,
      sessionMode: "vibecode",
      title: "Build a pond: Free play",
      isArchived: false,
      freePlay: true,
      freePlayOf: s.sessionId,
      parkingLot: source?.parkingLot,
    });
    await ctx.db.insert("artifacts", {
      sessionId,
      title: "Pond",
      content: APP_HTML,
      lastEditedBy: "ai",
      revision: 0,
      type: "code",
      language: "html",
    });
    return sessionId;
  });
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function eligible(t: ReturnType<typeof convexTest>, s: Seed) {
  const as = await asUser(t, s.scholarId);
  const result = await as.query(api.sessions.getWithMessages, {
    id: s.sessionId,
  });
  return result.session.freePlayEligible;
}

describe("free play eligibility", () => {
  test("no parked ideas → not eligible, and startFreePlay refuses", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { lot: null });
    expect(await eligible(t, s)).toBe(false);
    const as = await asUser(t, s.scholarId);
    await expect(
      as.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/emptyLot/);
  });

  test("editAccess never (play only) → not eligible", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { editAccess: "never" });
    expect(await eligible(t, s)).toBe(false);
    const as = await asUser(t, s.scholarId);
    await expect(
      as.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/playOnly/);
  });

  test("assignment version not complete → not eligible", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { complete: false });
    expect(await eligible(t, s)).toBe(false);
    const as = await asUser(t, s.scholarId);
    await expect(
      as.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/notComplete/);
  });

  test("complete + parked ideas → eligible (afterCompletion and always)", async () => {
    const t = convexTest(schema, modules);
    expect(await eligible(t, await seed(t))).toBe(true);
    expect(await eligible(t, await seed(t, { editAccess: "always" }))).toBe(
      true,
    );
  });

  test("someone else's session → not eligible and Forbidden", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const other = await seed(t);
    const asOther = await asUser(t, other.scholarId);
    await expect(
      asOther.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("sessions.startFreePlay", () => {
  test("carries on in the same session: no copy, the app stays where it is", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = await asUser(t, s.scholarId);
    const { sessionId } = await as.mutation(api.sessions.startFreePlay, {
      sessionId: s.sessionId,
    });
    expect(sessionId).toBe(s.sessionId);
    const rows = await t.run((ctx) => ctx.db.query("sessions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].freePlay).toBeUndefined();
    const artifacts = await t.run((ctx) => ctx.db.query("artifacts").collect());
    expect(artifacts).toHaveLength(1);
    // Still eligible: Build it now keeps working for the next idea.
    expect(await eligible(t, s)).toBe(true);
  });

  test("a scholar with an older free-play copy is taken to that copy", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const copyId = await insertLegacyCopy(t, s);
    const as = await asUser(t, s.scholarId);
    const { sessionId } = await as.mutation(api.sessions.startFreePlay, {
      sessionId: s.sessionId,
    });
    expect(sessionId).toBe(copyId);
    const copies = await t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect()).filter(
        (row) => row.freePlayOf === s.sessionId,
      ),
    );
    expect(copies).toHaveLength(1);
    // The copy is not itself a source for Build it now.
    const view = await as.query(api.sessions.getWithMessages, { id: copyId });
    expect(view.session.freePlayEligible).toBe(false);
  });

  test("launching the activity again resumes the assignment session, never an old copy", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertLegacyCopy(t, s);
    const as = await asUser(t, s.scholarId);
    const launched = await as.mutation(api.sessions.create, {
      activityId: s.activityId,
    });
    expect(launched.id).toBe(s.sessionId);
  });
});

describe("one answer to \"is the activity done?\"", () => {
  test("a teacher's class-wide mark (ledger only, no session stamp) counts as done", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // The class-wide mark writes the completions ledger, never the session.
    await t.run((ctx) => ctx.db.patch(s.sessionId, { activityCompletedAt: undefined }));
    const as = await asUser(t, s.scholarId);
    const view = await as.query(api.sessions.getWithMessages, { id: s.sessionId });
    expect(view.session.activityDone).toBe(true);
    expect(view.session.freePlayEligible).toBe(true);
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId: s.sessionId }),
    );
    expect(context?.activityComplete).toBe(true);
  });

  test("an unfinished activity is not done", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { complete: false });
    const as = await asUser(t, s.scholarId);
    const view = await as.query(api.sessions.getWithMessages, { id: s.sessionId });
    expect(view.session.activityDone).toBe(false);
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId: s.sessionId }),
    );
    expect(context?.activityComplete).toBe(false);
  });
});

describe("free play in the prompt", () => {
  async function promptParts(freePlay: boolean) {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sessionId = freePlay ? await insertLegacyCopy(t, s) : s.sessionId;
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    return { context: context!, parts: buildTutorSystemPromptParts(context!) };
  }

  test("free play carries no contract; the parked ideas become the opener", async () => {
    const { context, parts } = await promptParts(true);
    expect(context.freePlay).toBe(true);
    expect(context.lessonActivityContext).not.toHaveProperty("buildContract");
    const prompt = parts.stable + parts.dynamic + parts.turnSystem;
    for (const piece of [...CONTRACT.invariants, CONTRACT.gate!]) {
      expect(prompt).not.toContain(piece);
    }
    expect(prompt).not.toContain(PARK_IDEA_TOOL_NAME);
    expect(prompt).not.toContain(UNPARK_IDEA_TOOL_NAME);
    // The opener (per-turn session state, never the cached prefix) lists the ideas.
    expect(parts.stable).not.toContain("IDEA-rainbow-fish");
    expect(parts.turnSystem).toContain(buildFreePlayOpenerSection(LOT)!.trim());
    // The weapons rule survives the contract's absence.
    expect(parts.stable).toContain(WEAPON_DEFINITION);
    // With no contract, the scholar makes the world's rules.
    expect(parts.stable).toContain(SCHOLAR_RULES_STEERING.trim());
  });

  test("the finished assignment session keeps its contract and parking lot, and the scholar makes the rules", async () => {
    const { context, parts } = await promptParts(false);
    expect(context.freePlay).toBe(false);
    expect(context.activityComplete).toBe(true);
    expect(context.lessonActivityContext?.buildContract).toEqual(CONTRACT);
    expect(parts.stable).toContain(CONTRACT.gate!);
    expect(parts.stable).toContain(WEAPON_DEFINITION);
    expect(parts.stable).toContain(SCHOLAR_RULES_STEERING.trim());
    expect(parts.turnSystem).not.toContain(buildFreePlayOpenerSection(LOT)!.trim());
    expect(parts.turnSystem).toContain("IDEA-rainbow-fish");
  });

  test("buildFreePlayOpenerSection: null when empty, one line per idea", () => {
    expect(buildFreePlayOpenerSection(null)).toBeNull();
    expect(buildFreePlayOpenerSection([{ text: " " }])).toBeNull();
    const section = buildFreePlayOpenerSection(LOT)!;
    for (const idea of LOT) expect(section).toContain(idea.text);
  });

  test("missionToolOffer offers nothing in free play", () => {
    expect(
      missionToolOffer({
        hasMission: true,
        workshopMode: "edit",
        teacherBuild: false,
        freePlay: true,
      }),
    ).toEqual({ parkIdea: false });
  });
});

describe("free play counts toward nothing", () => {
  test("no completion is recorded from a free-play session", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sessionId = await insertLegacyCopy(t, s);
    const before = await t.run((ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    const result = await t.run((ctx) =>
      reconcileActivityCompletion(ctx, {
        scholarId: s.scholarId,
        activityId: s.activityId,
        sessionId,
      }),
    );
    expect(result).toEqual({ completionId: null, created: false });
    const after = await t.run((ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(after).toEqual(before);
    const freePlay = await t.run((ctx) => ctx.db.get(sessionId));
    expect(freePlay?.activityCompletedAt).toBeUndefined();
  });

  test("the tutor sees no deliverable or completion steering in free play", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.patch(s.activityId, {
        advanceRubric: {
          criteria: [{ id: "c1", label: "RUBRIC-oxygen", description: "d" }],
        },
      }),
    );
    const sessionId = await insertLegacyCopy(t, s);
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(context?.advanceRubricContext).toBeNull();
    expect(context?.standaloneDeliverableContext).toBeNull();
    expect(context?.conversationCompletionContext).toBeNull();
  });
});

// ── "Build it now" from any activity with a mission (TRA-519 B2) ───────────

async function seedEssay(
  t: ReturnType<typeof convexTest>,
  opts: {
    complete?: boolean;
    lot?: typeof LOT;
    activity?: Partial<Record<string, unknown>>;
    quest?: boolean;
  } = {},
) {
  const institutionId = await seedTestInstitution(t);
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      title: "Heron unit",
      isActive: true,
      institutionId,
      ...(opts.quest ? { authorScholarId: scholarId } : {}),
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Heron lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Field journal",
      kind: "online",
      order: 0,
      // Not an app: refused as notApp before editAccess is read.
      editAccess: "never",
      deliverable: {
        kind: "text",
        prompt: "Write about the heron.",
        mode: "none",
        criteria: [],
      },
      ...opts.activity,
    } as never);
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Field journal",
      isArchived: false,
      unitId,
      lessonId,
      activityId,
      parkingLot: opts.lot ?? LOT,
    });
    // A side app on a non-app source does not make it an app source.
    await ctx.db.insert("artifacts", {
      sessionId,
      title: "Side app",
      content: APP_HTML,
      lastEditedBy: "ai",
      revision: 1,
      type: "code",
      language: "html",
    });
    if (opts.complete ?? true) {
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        sessionId,
        unitId,
        lessonId,
        completedAt: Date.now(),
      });
    }
    return { scholarId, activityId, sessionId, unitId, lessonId };
  });
}

describe("Build it now is for app activities only", () => {
  test("a completed essay with parked ideas is not eligible, and startFreePlay refuses", async () => {
    const t = convexTest(schema, modules);
    const s = await seedEssay(t);
    const as = await asUser(t, s.scholarId);
    const view = await as.query(api.sessions.getWithMessages, { id: s.sessionId });
    expect(view.session.freePlayEligible).toBe(false);
    await expect(
      as.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/notApp/);
    const sessions = await t.run((ctx) => ctx.db.query("sessions").collect());
    expect(sessions.filter((x) => x.freePlay === true)).toHaveLength(0);
  });

  test("a discussion (no deliverable) is refused as not an app", async () => {
    const t = convexTest(schema, modules);
    const s = await seedEssay(t, {
      activity: {
        deliverable: undefined,
        advanceRubric: { criteria: [{ id: "c1", label: "Shares a view" }] },
      },
    });
    const as = await asUser(t, s.scholarId);
    await expect(
      as.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/notApp/);
  });

  test("a session with no activity (open chat) is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seedEssay(t);
    await t.run((ctx) => ctx.db.patch(s.sessionId, { activityId: undefined }));
    const as = await asUser(t, s.scholarId);
    await expect(
      as.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/noActivity/);
  });

  test("a rehearsal is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seedEssay(t);
    await t.run((ctx) => ctx.db.patch(s.sessionId, { isTestDrive: true }));
    const as = await asUser(t, s.scholarId);
    await expect(
      as.mutation(api.sessions.startFreePlay, { sessionId: s.sessionId }),
    ).rejects.toThrow(/testDrive/);
  });

  test("an online activity with the app marker is an app source", async () => {
    const t = convexTest(schema, modules);
    const s = await seedEssay(t, {
      activity: {
        appActivity: true,
        editAccess: "afterCompletion",
        deliverable: { kind: "artifact", prompt: "Build it.", mode: "none", criteria: [] },
      },
    });
    const as = await asUser(t, s.scholarId);
    const { sessionId } = await as.mutation(api.sessions.startFreePlay, {
      sessionId: s.sessionId,
    });
    expect(sessionId).toBe(s.sessionId);
  });
});

describe("startFreePlay idea", () => {
  test("idea puts that entry first in the session it opens", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = await asUser(t, s.scholarId);
    const lotOf = async (id: Id<"sessions">) =>
      (await t.run((ctx) => ctx.db.get(id)))?.parkingLot?.map((e) => e.text);
    await as.mutation(api.sessions.startFreePlay, {
      sessionId: s.sessionId,
      idea: "IDEA-night-mode",
    });
    expect(await lotOf(s.sessionId)).toEqual(["IDEA-night-mode", "IDEA-rainbow-fish"]);
    // Matching ignores case; an idea that is not in the lot changes nothing.
    await as.mutation(api.sessions.startFreePlay, {
      sessionId: s.sessionId,
      idea: "idea-rainbow-fish",
    });
    expect(await lotOf(s.sessionId)).toEqual(["IDEA-rainbow-fish", "IDEA-night-mode"]);
    await as.mutation(api.sessions.startFreePlay, {
      sessionId: s.sessionId,
      idea: "not parked",
    });
    expect(await lotOf(s.sessionId)).toEqual(["IDEA-rainbow-fish", "IDEA-night-mode"]);
  });

  test("with an older free-play copy, the copy's lot is the one reordered", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const copyId = await insertLegacyCopy(t, s);
    const as = await asUser(t, s.scholarId);
    await as.mutation(api.sessions.startFreePlay, {
      sessionId: s.sessionId,
      idea: "IDEA-night-mode",
    });
    const copy = await t.run((ctx) => ctx.db.get(copyId));
    expect(copy?.parkingLot?.map((e) => e.text)).toEqual(["IDEA-night-mode", "IDEA-rainbow-fish"]);
    const source = await t.run((ctx) => ctx.db.get(s.sessionId));
    expect(source?.parkingLot?.map((e) => e.text)).toEqual(["IDEA-rainbow-fish", "IDEA-night-mode"]);
  });
});

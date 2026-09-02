import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { buildNonHumanIntroSection } from "../prompts";
import { buildSystemPrompt } from "../sessionHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── buildNonHumanIntroSection ────────────────────────────────────────

describe("buildNonHumanIntroSection", () => {
  test("returns null when not showing", () => {
    expect(buildNonHumanIntroSection(false)).toBeNull();
  });

  test("when showing: identifies as AI, gives younger + older examples, not a list", () => {
    const s = buildNonHumanIntroSection(true)!;
    expect(s).toContain("first-ever session");
    expect(s).toContain("you're an AI");
    expect(s).toContain("not a real person");
    // Two example tones, not one rigid register-selected string.
    expect(s).toContain("younger child");
    expect(s).toContain("older child");
    // Tells the model to lead with it...
    expect(s).toContain("start your opening message by introducing yourself");
    // ...but the OUTPUT stays warm: not a disclaimer dump.
    expect(s).toContain("not a disclaimer");
  });
});

// ── buildSystemPrompt integration ────────────────────────────────────

describe("buildSystemPrompt — intro + session context wiring", () => {
  function build(opts: {
    isFirstTurn?: boolean;
    isFirstSession?: boolean;
    lastSessionAt?: number | null;
  }) {
    return buildSystemPrompt(
      null, // teacherWhisper
      null, // readingLevel
      "Kai", // scholarName
      null, // unitContext
      null, // personaContext
      null, // perspectiveContext
      null, // processContext
      null, // processStateData
      null, // artifactData
      null, // dossierContent
      null, // seedsData
      null, // masteryContext
      null, // signalContext
      null, // timingContext
      null, // lessonContext
      null, // teacherDirectives
      null, // lessonActivityContext
      null, // priorActivityContext
      null, // activityContext
      null, // standaloneDeliverableContext
      null, // currentVerdictsContext
      opts.isFirstTurn ?? false,
      opts.isFirstSession ?? false,
      opts.lastSessionAt ?? null,
    );
  }

  test("intro appears ONLY on first turn AND first session", () => {
    expect(build({ isFirstTurn: true, isFirstSession: true })).toContain(
      "## Introduce yourself",
    );
    // first turn but a returning scholar → no intro
    expect(build({ isFirstTurn: true, isFirstSession: false })).not.toContain(
      "## Introduce yourself",
    );
    // first session but mid-conversation → no intro
    expect(build({ isFirstTurn: false, isFirstSession: true })).not.toContain(
      "## Introduce yourself",
    );
  });

  test("the <start> greeting bullet carries the AI-identity lead on a first-ever session", () => {
    // Coupling lives in the bullet the model actually acts on, so it complies.
    const lead = "naturally works in who you are";
    const firstEver = build({ isFirstTurn: true, isFirstSession: true });
    expect(firstEver).toContain(lead);
    // The primacy line also fires on a first-ever session.
    expect(firstEver).toContain("FIRST MESSAGE:");
    // Returning scholars / mid-conversation get the normal greeting bullet.
    expect(build({ isFirstTurn: true, isFirstSession: false })).not.toContain(lead);
    expect(build({ isFirstTurn: false, isFirstSession: true })).not.toContain(lead);
  });

  test("session context: first-ever session", () => {
    const prompt = build({ isFirstTurn: true, isFirstSession: true });
    expect(prompt).toContain("SESSION CONTEXT:");
    expect(prompt).toContain("first-ever session");
    expect(prompt).toContain("Don't imply any shared history");
  });

  test("session context: returning scholar on the FIRST turn of a NEW session gets fresh-start guidance (no false welcome-back)", () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const prompt = build({ isFirstTurn: true, lastSessionAt: twoDaysAgo });
    expect(prompt).toContain("SESSION CONTEXT:");
    expect(prompt).toContain("used Rabbithole before");
    expect(prompt).toContain("2 days ago");
    expect(prompt).toContain("don't claim to recall specific past conversations");
    // The core of the fix: on a brand-new session the tutor must NOT imply it is
    // resuming an earlier thread.
    expect(prompt).toContain("brand-new session");
    expect(prompt).toContain('do NOT say "welcome back"');
    expect(prompt).toContain("dig back in");
  });

  test("session context: same-sitting new session on the FIRST turn does not imply time has passed", () => {
    // Usability finding: a same-sitting new session (last session minutes ago,
    // not hours/days) must not produce a false "since your last visit" greeting.
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const prompt = build({ isFirstTurn: true, lastSessionAt: fiveMinutesAgo });
    expect(prompt).toContain("SESSION CONTEXT:");
    expect(prompt).toContain("same sitting");
    expect(prompt).not.toContain("time has passed");
    expect(prompt).not.toContain("since your last visit");
  });

  test("session context: returning scholar MID-session keeps the plain returning note", () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    // isFirstTurn=false → the session already has real in-session history, so
    // acknowledging continuity is fine and the fresh-start guard is not injected.
    const prompt = build({ isFirstTurn: false, lastSessionAt: twoDaysAgo });
    expect(prompt).toContain("SESSION CONTEXT:");
    expect(prompt).toContain("returning scholar");
    expect(prompt).toContain("2 days ago");
    expect(prompt).toContain("don't claim to recall specific past conversations");
    expect(prompt).not.toContain('do NOT say "welcome back"');
  });

  test("no session context section when neither first-session nor a last time", () => {
    const prompt = build({});
    expect(prompt).not.toContain("SESSION CONTEXT:");
  });

  test("standing honesty rule lives in the base prompt (always present)", () => {
    const prompt = build({});
    expect(prompt).toContain("be honest: tell them you're an AI");
    // and it must not be weaponized against feelings
    expect(prompt).toContain("never a way to brush off feelings");
  });

  test("default trailing args (omitted) behave as not-first / no intro", () => {
    const prompt = buildSystemPrompt(null, null, "Kai", null, null, null);
    expect(prompt).not.toContain("## Introduce yourself");
    expect(prompt).not.toContain("SESSION CONTEXT:");
  });
});

// ── getSessionContext: isFirstTurn / isFirstSession / lastSessionAt ───

async function seedUser(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Test scholar",
      username: "testscholar",
      role: "scholar",
    }),
  );
}

describe("getSessionContext session signals", () => {
  test("first project, only <start>: isFirstSession=true, isFirstTurn=true, no lastSessionAt", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "New Project",
        isArchived: false,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "<start>",
        flagged: false,
      }),
    );

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.isFirstTurn).toBe(true);
    expect(c?.isFirstSession).toBe(true);
    expect(c?.lastSessionAt).toBeNull();
  });

  test("a prior project flips isFirstSession to false and sets lastSessionAt", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    // Prior (earlier) session with activity.
    const priorId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "Old Project",
        isArchived: false,
        lastMessageAt: 1_000_000,
      }),
    );
    void priorId;
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "New Project",
        isArchived: false,
      }),
    );

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.isFirstSession).toBe(false);
    expect(c?.lastSessionAt).toBe(1_000_000);
  });

  test("a test-drive project does NOT count as a prior session", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "Test Drive",
        isArchived: false,
        isTestDrive: true,
        lastMessageAt: 5_000_000,
      }),
    );
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "New Project",
        isArchived: false,
      }),
    );

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.isFirstSession).toBe(true);
    expect(c?.lastSessionAt).toBeNull();
  });

  test("isFirstTurn flips to false once the tutor has responded", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "New Project",
        isArchived: false,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "<start>",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Hi! I'm an AI helper...",
        flagged: false,
      });
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.isFirstTurn).toBe(false);
    // Still their first/only project → still a first session.
    expect(c?.isFirstSession).toBe(true);
  });
});

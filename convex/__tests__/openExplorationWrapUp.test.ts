import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { buildOpenExplorationWrapUpSection } from "../prompts";
import {
  buildTutorSystemPrompt,
  buildTutorSystemPromptParts,
} from "../sessionStreamHelpers";

// Gating for the tutor's "how an open exploration ends" note (TRA-371). The
// note must track exactly the sessions whose screen shows the Wrap up button:
// no activity, plain chat, not a test drive. Assertions compare against the
// builder's own output, so rewording the note never breaks these tests.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

const WRAP_UP = buildOpenExplorationWrapUpSection();

async function seedSession(
  t: TC,
  opts: {
    withActivity?: boolean;
    isTestDrive?: boolean;
    sessionMode?: "conversation" | "workbench" | "vibecode";
  } = {},
): Promise<Id<"sessions">> {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "S",
      username: "s-" + Math.random().toString(36).slice(2, 7),
      role: "scholar",
    });
    let activityFields = {};
    if (opts.withActivity) {
      const teacherId = await ctx.db.insert("users", {
        name: "T",
        username: "t-" + Math.random().toString(36).slice(2, 7),
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Chat activity",
        kind: "online",
        order: 0,
        systemPrompt: "...",
      });
      activityFields = { unitId, lessonId, activityId };
    }
    return await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Session",
      isArchived: false,
      ...activityFields,
      ...(opts.isTestDrive ? { isTestDrive: true } : {}),
      ...(opts.sessionMode ? { sessionMode: opts.sessionMode } : {}),
    });
  });
}

async function contextFor(t: TC, sessionId: Id<"sessions">) {
  const context = await t.query(internal.sessionHelpers.getSessionContext, {
    sessionId,
  });
  expect(context).not.toBeNull();
  return context!;
}

describe("open-exploration Wrap up note — gating", () => {
  test("an activity-less chat session gets the note, in the cached stable prefix", async () => {
    const t = convexTest(schema, modules);
    const context = await contextFor(t, await seedSession(t));

    expect(context.offersWrapUp).toBe(true);
    const { stable, dynamic } = buildTutorSystemPromptParts(context);
    expect(stable).toContain(WRAP_UP);
    expect(dynamic).not.toContain(WRAP_UP);
  });

  test("an explicit conversation-mode session without an activity gets it too", async () => {
    const t = convexTest(schema, modules);
    const context = await contextFor(
      t,
      await seedSession(t, { sessionMode: "conversation" }),
    );
    expect(buildTutorSystemPrompt(context)).toContain(WRAP_UP);
  });

  test("an activity session does not — its completion flow owns finishing", async () => {
    const t = convexTest(schema, modules);
    const context = await contextFor(
      t,
      await seedSession(t, { withActivity: true }),
    );

    expect(context.offersWrapUp).toBe(false);
    expect(buildTutorSystemPrompt(context)).not.toContain(WRAP_UP);
  });

  test("a teacher test drive does not — its screen has no Wrap up button", async () => {
    const t = convexTest(schema, modules);
    const context = await contextFor(
      t,
      await seedSession(t, { isTestDrive: true }),
    );
    expect(buildTutorSystemPrompt(context)).not.toContain(WRAP_UP);
  });

  test.each(["vibecode", "workbench"] as const)(
    "a %s session does not — it mounts its own screen",
    async (sessionMode) => {
      const t = convexTest(schema, modules);
      const context = await contextFor(t, await seedSession(t, { sessionMode }));
      expect(buildTutorSystemPrompt(context)).not.toContain(WRAP_UP);
    },
  );

  test("a context that doesn't declare the button (guest, offline callers) stays off", async () => {
    const t = convexTest(schema, modules);
    const { offersWrapUp: _omitted, ...context } = await contextFor(
      t,
      await seedSession(t),
    );
    expect(buildTutorSystemPrompt(context)).not.toContain(WRAP_UP);
  });
});

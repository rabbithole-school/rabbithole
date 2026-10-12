// `start_workshop_thread` — the staff aide / Slack / MCP tool that opens a new
// Workshop conversation with one scholar. Drives the REAL tool (its strict
// name resolver + lens plumbing) against convex-test by routing the stub
// ActionCtx's runQuery/runMutation into the test backend, so the whole path
// down to `startWorkshopThreadAs` → `requireStaffReach` runs for real.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { makeSuggestionTools } from "../lib/suggestionTools";
import { MESSAGE_EDIT_WINDOW_MS } from "../../shared/messageEditWindow";
import { makeWorld, type WorldStaff } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = TestConvex<typeof schema>;

function actionCtxFor(t: TestCtx): ActionCtx {
  return {
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  } as unknown as ActionCtx;
}

/** The tool exactly as an aide transport builds it: the caller's own lens. */
async function toolFor(t: TestCtx, staff: WorldStaff) {
  const lens = await t.query(internal.curriculumAssistant.resolveAideScholarLens, {
    callerUserId: staff.id,
    scope: "",
  });
  const tools = await makeSuggestionTools(actionCtxFor(t), () => {}, {
    role: staff.role,
    callerUserId: staff.id,
    allowedScholarIds: lens.unrestricted
      ? undefined
      : new Set<Id<"users">>(lens.scholarIds ?? []),
    scholarLensResolved: true,
  });
  const tool = tools.find((candidate) => candidate.name === "start_workshop_thread");
  if (!tool) throw new Error("start_workshop_thread not offered");
  return async (input: { scholarName: string; body: string }) =>
    JSON.parse(await (tool as unknown as { run: (i: typeof input) => Promise<string> }).run(input));
}

async function workshopRows(t: TestCtx, scholarId: Id<"users">) {
  return t.run(async (ctx) => {
    const threads = (
      await ctx.db
        .query("parentThreads")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).filter((thread) => thread.kind === "workshop");
    const messages = [];
    for (const thread of threads) {
      messages.push(
        ...(await ctx.db
          .query("parentMessages")
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .collect()),
      );
    }
    return { threads, messages };
  });
}

describe("start_workshop_thread", () => {
  test("a teacher at the scholar's school starts a thread posted as themselves", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const school = world.schools[0];
    const scholar = school.scholars[0];
    const run = await toolFor(t, school.teacher);

    const before = Date.now();
    const out = await run({
      scholarName: scholar.name.toUpperCase(),
      body: "  Sorry Rabbithole was down this morning!  ",
    });

    expect(out.ok).toBe(true);
    expect(out.posted).toBe("Sorry Rabbithole was down this morning!");
    expect(out.link).toContain("/teacher/messages?");
    expect(out.link).toContain("kind=workshop");
    expect(out.link).toContain(`thread=${out.threadId}`);
    const editableUntil = Date.parse(out.editableUntil);
    expect(editableUntil).toBeGreaterThanOrEqual(before + MESSAGE_EDIT_WINDOW_MS);

    const { threads, messages } = await workshopRows(t, scholar.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]._id).toBe(out.threadId);
    expect(threads[0].institutionId).toBe(school.id);
    expect(threads[0].suggestionId).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorType: "teacher",
      authorUserId: school.teacher.id,
      body: "Sorry Rabbithole was down this morning!",
    });
  });

  test("a teacher from another school cannot reach the scholar", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [home, other] = world.schools;
    const scholar = home.scholars[0];

    // Through the tool: the other school's lens never resolves the name.
    const run = await toolFor(t, other.teacher);
    const out = await run({ scholarName: scholar.name, body: "Aloha" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No scholar found/);

    // Even with a mis-wired, unrestricted lens, requireStaffReach refuses.
    await expect(
      t.mutation(internal.scholarMessages.startWorkshopThreadForCaller, {
        callerUserId: other.teacher.id,
        scholarId: scholar.id,
        body: "Aloha",
        scholarLensResolved: true,
      }),
    ).rejects.toThrow("Scholar not found");

    // And a lens that never resolved fails closed before anything else.
    await expect(
      t.mutation(internal.scholarMessages.startWorkshopThreadForCaller, {
        callerUserId: home.teacher.id,
        scholarId: scholar.id,
        body: "Aloha",
      }),
    ).rejects.toThrow("Scholar not found");

    expect((await workshopRows(t, scholar.id)).threads).toHaveLength(0);
  });

  test("an ambiguous or unknown name fails loudly and sends nothing", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const school = world.schools[0];
    const run = await toolFor(t, school.teacher);

    // The first school's cast shares a family name ("Kai Kahale", "Lani Kahale").
    const ambiguous = await run({ scholarName: "kahale", body: "Aloha" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/more than one scholar/);
    for (const scholar of school.scholars) {
      expect(ambiguous.error).toContain(scholar.name);
    }

    const unknown = await run({ scholarName: "Nobody Here", body: "Aloha" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/No scholar found/);

    const blank = await run({ scholarName: "   ", body: "Aloha" });
    expect(blank.ok).toBe(false);

    for (const scholar of school.scholars) {
      expect((await workshopRows(t, scholar.id)).threads).toHaveLength(0);
    }
  });
});

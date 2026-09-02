import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { emptyDeck } from "../../shared/slidesScene";
import {
  makeTutorSessionTools,
  type TutorToolSessionState,
} from "../lib/tutorSessionTools";
import type { ActionCtx } from "../_generated/server";
import type { AideEmit } from "../lib/aideStream";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TEXT_EL = {
  type: "text",
  frame: { x: 10, y: 10, w: 300, h: 90 },
  text: "Hello",
};

type T = ReturnType<typeof convexTest>;

async function seedScholarSession(t: T) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Kai Kahale",
      username: "kai-slides-tool-test",
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Volcanoes",
      isArchived: false,
    });
    return { scholarId, sessionId };
  });
}

/**
 * Build the tutor toolset with a fake ActionCtx that proxies runQuery/runMutation
 * to the convex-test backend, then hand back the `edit_slides` tool plus the
 * list of stream events it emitted. The factory only reads `sessionMode` and
 * `scholarId` off `session` at construction time, so a minimal stub suffices.
 */
async function makeEditSlides(
  t: T,
  scholarId: string,
  sessionId: string,
) {
  const events: Record<string, unknown>[] = [];
  const emit: AideEmit = (d) => {
    events.push(d);
  };
  const ctx = {
    runQuery: (ref: unknown, args: unknown) =>
      (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
  } as unknown as ActionCtx;

  const state: TutorToolSessionState = {
    assistantMsgId: "msg",
    fullContent: "",
    lastPersistLength: 0,
    completionHadPreToolText: false,
    rubricHadPreToolText: false,
    completionPreToolClosingIsValid: false,
    rubricPreToolClosingIsValid: false,
    suppressCompletionFollowUp: false,
    activityCompletedThisStream: false,
  };

  const tools = await makeTutorSessionTools(ctx, emit, {
    session: { sessionMode: "chat", scholarId } as never,
    projId: sessionId as never,
    callerUserId: scholarId as never,
    state,
    splitAfterTool: async () => {},
    hasProcess: false,
    hasRubric: false,
    activityWasAlreadyComplete: false,
    hasConversationCompletion: false,
    hasActivityResources: false,
    hasPhysicalEnv: false,
    isAngleKickoff: false,
    isOwnIsUnit: false,
    ownIsUnitId: null,
    instructionPlatform: "web",
    chatPracticeOn: false,
    teachBackOn: false,
  });

  const tool = tools.find((x) => x.name === "edit_slides");
  if (!tool) throw new Error("edit_slides tool was not registered");
  const run = (input: Record<string, unknown>) =>
    (tool.run as (i: unknown) => Promise<string>)(input);
  return { run, events };
}

describe("edit_slides tutor tool", () => {
  test("create then read returns a summary containing the minted ids", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const { run, events } = await makeEditSlides(t, scholarId, sessionId);

    // create emits artifactUpdate + a newArtifactId (focuses the panel).
    const createMsg = await run({
      op: "create",
      deck: emptyDeck("My deck", "sl1"),
    });
    expect(createMsg).toContain("revision 0");
    const focus = events.find((e) => "newArtifactId" in e);
    expect(focus).toBeTruthy();
    expect(focus).toMatchObject({ artifactUpdate: true });

    // Put a text element on the deck so read has an id to report.
    await run({
      op: "patch",
      ops: [{ op: "addElement", slideId: "sl1", element: TEXT_EL }],
    });

    const summary = await run({ op: "read" });
    // The model learns the server-minted slide + element ids from read.
    expect(summary).toContain("sl1");
    expect(summary).toContain("el1");
    expect(summary).toContain("revision");
  });

  test("read emits no stream events (silent lookup)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const { run } = await makeEditSlides(t, scholarId, sessionId);
    await run({ op: "create", deck: emptyDeck("D", "sl1") });

    const { run: run2, events: events2 } = await makeEditSlides(
      t,
      scholarId,
      sessionId,
    );
    await run2({ op: "read" });
    expect(events2).toHaveLength(0);
  });

  test("patch updates in place WITHOUT stealing focus (no newArtifactId)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const { run, events } = await makeEditSlides(t, scholarId, sessionId);
    await run({ op: "create", deck: emptyDeck("D", "sl1") });
    events.length = 0; // ignore the create events

    const msg = await run({
      op: "patch",
      ops: [{ op: "addElement", slideId: "sl1", element: TEXT_EL }],
    });
    expect(msg).toContain("revision 1");
    // A refresh, not a refocus: artifactUpdate with NO newArtifactId.
    expect(events.some((e) => "artifactUpdate" in e)).toBe(true);
    expect(events.some((e) => "newArtifactId" in e)).toBe(false);
  });

  test("a stale baseRevision surfaces the recovery text to the model", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const { run } = await makeEditSlides(t, scholarId, sessionId);
    await run({ op: "create", deck: emptyDeck("D", "sl1") });
    // Move the deck to revision 1.
    await run({
      op: "patch",
      ops: [{ op: "addElement", slideId: "sl1", element: TEXT_EL }],
    });

    // A model that read revision 0 and thought for a while tries to write.
    const stale = await run({
      op: "patch",
      ops: [{ op: "addElement", slideId: "sl1", element: TEXT_EL }],
      baseRevision: 0,
    });
    // The backend's verbatim message tells the model to re-read.
    expect(stale.toLowerCase()).toContain("stale");
    expect(stale.toLowerCase()).toContain("read the deck again");

    // …and the earlier edit survived untouched.
    const read = await t.query(internal.artifacts.aiReadDeck, { sessionId });
    if ("error" in read) throw new Error(read.error);
    expect(read.revision).toBe(1);
  });

  test("patch on a nonexistent deck returns a helpful error", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const { run } = await makeEditSlides(t, scholarId, sessionId);

    const msg = await run({
      op: "patch",
      ops: [{ op: "setTitle", title: "x" }],
    });
    expect(msg).toContain("No deck exists");
    expect(msg.toLowerCase()).toContain("create one first");
  });

  test("read on a nonexistent deck returns a helpful error, emits nothing", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const { run, events } = await makeEditSlides(t, scholarId, sessionId);

    const msg = await run({ op: "read" });
    expect(msg).toContain("No deck exists");
    expect(events).toHaveLength(0);
  });

  test("create with an invalid deck returns the validation error verbatim", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const { run } = await makeEditSlides(t, scholarId, sessionId);

    const msg = await run({ op: "create", deck: { slides: [] } });
    // validateDeck's message, surfaced to the model rather than thrown.
    expect(msg.toLowerCase()).toContain("slide");
  });
});

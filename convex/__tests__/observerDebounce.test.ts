import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();

afterEach(() => vi.useRealTimers());

async function seedSession(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      username: "debounce-scholar",
      role: "scholar",
    });
    return ctx.db.insert("sessions", {
      userId,
      title: "Debounce fixture",
      isArchived: false,
    });
  });
}

async function finalize(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
  content = "A concise assistant reply.",
) {
  const messageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "",
      flagged: false,
      streamId: `stream-${Date.now()}`,
    }),
  );
  await t.mutation(internal.sessionHelpers.finalizeStream, {
    messageId,
    sessionId,
    content,
  });
}

async function observerJobs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
      job.name.includes("observer:analyzeSession"),
    ),
  );
}

describe("observer trigger debounce", () => {
  test("coalesces a burst into one run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    await finalize(t, sessionId);
    vi.setSystemTime(t0 + 20_000);
    await finalize(t, sessionId);
    vi.setSystemTime(t0 + 40_000);
    await finalize(t, sessionId);

    const jobs = await observerJobs(t);
    const pending = jobs.filter((job) => job.state.kind === "pending");
    expect(pending).toHaveLength(1);
    expect(jobs.filter((job) => job.state.kind === "canceled")).toHaveLength(2);
    expect(pending[0].scheduledTime).toBe(t0 + 100_000);

    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.observerPendingJobId).toBe(pending[0]._id);
    expect(session?.observerPendingSince).toBe(t0);
  });

  test("opens a second window after a run starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    await finalize(t, sessionId);
    // A direct run (requestRecap) starts 10s in, while the debounced job is
    // still 50s out — that queued job would only re-read, so it is cancelled.
    vi.setSystemTime(t0 + 10_000);
    await t.mutation(internal.analysisHelpers.beginObserverRun, { sessionId });
    vi.setSystemTime(t0 + 100_000);
    await finalize(t, sessionId);

    const jobs = await observerJobs(t);
    expect(jobs.filter((job) => job.state.kind === "canceled")).toHaveLength(1);
    const pending = jobs.filter((job) => job.state.kind === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].scheduledTime).toBe(t0 + 160_000);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.observerPendingSince).toBe(t0 + 100_000);
  });

  test("never cancels a job that is already due — it may be mid-claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    await finalize(t, sessionId);
    // convex-test never fires jobs, so at t=65s the t=60s job still reads as
    // `pending` — exactly what a lagging scheduler looks like to the trigger.
    vi.setSystemTime(t0 + 65_000);
    await finalize(t, sessionId);
    let jobs = await observerJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state.kind).toBe("pending");

    // The run itself starting must not cancel that overdue job either; it
    // only releases the window.
    await t.mutation(internal.analysisHelpers.beginObserverRun, { sessionId });
    jobs = await observerJobs(t);
    expect(jobs[0].state.kind).toBe("pending");
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.observerPendingJobId).toBeUndefined();
  });

  test("caps a never-idle burst at the max-wait deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    for (const elapsed of [0, 50_000, 100_000, 150_000]) {
      vi.setSystemTime(t0 + elapsed);
      await finalize(t, sessionId);
    }
    const jobsAtDeadline = await observerJobs(t);
    expect(jobsAtDeadline).toHaveLength(4);
    expect(jobsAtDeadline.filter((job) => job.state.kind === "canceled")).toHaveLength(3);
    expect(jobsAtDeadline.filter((job) => job.state.kind === "pending")[0].scheduledTime).toBe(
      t0 + 180_000,
    );

    for (const elapsed of [200_000, 250_000]) {
      vi.setSystemTime(t0 + elapsed);
      await finalize(t, sessionId);
      expect(await observerJobs(t)).toHaveLength(jobsAtDeadline.length);
    }

    const jobs = await observerJobs(t);
    const pending = jobs.filter((job) => job.state.kind === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].scheduledTime).toBe(t0 + 180_000);
  });

  test("beginObserverRun only cancels a pending stamped job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    await finalize(t, sessionId);
    await t.mutation(internal.analysisHelpers.beginObserverRun, { sessionId });
    await t.mutation(internal.analysisHelpers.beginObserverRun, { sessionId });

    const jobs = await observerJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state.kind).toBe("canceled");
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.observerPendingJobId).toBeUndefined();
    expect(session?.observerPendingSince).toBeUndefined();
  });

  test("schedules the observer after deleting an empty placeholder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);

    await finalize(t, sessionId, "");

    const jobs = await observerJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state.kind).toBe("pending");
  });
});

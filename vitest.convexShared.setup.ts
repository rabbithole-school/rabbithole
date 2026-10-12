// Setup for the shared-worker Convex project only (vitest.config.ts). Runs
// per test file.
//
// Every convexTest() instance has its own scheduler, and a scheduled function
// a test leaves behind sits on a REAL timer. In an isolated process that
// timer dies with the process; in a shared worker a queued job fires during a
// later test or file, where vitest pins its unhandled rejection on whichever
// test is running. A job that is still running when the file ends is worse:
// it keeps loading modules after vitest has torn the file down, that load is
// rejected ("Cannot load … after the environment was torn down"), the
// worker's module cache keeps the rejection, and every later file on the
// worker that imports the module fails with it, retries included (TRA-443).
// Anything a file scheduled that has not settled by its last test is a leak
// by definition, so for EVERY instance the file created (recorded by
// vitest/convexTestTracked.ts), not just the last one:
//   1. wait for the jobs that have started. A running async function cannot
//      be cancelled, and abandoning it is exactly the leak. Timers stay live
//      while we wait, so a job's own delay or fetch timeout still fires and
//      the job can finish;
//   2. if a timer fired meanwhile, a queued job may have started too, so
//      cancel the queued jobs and wait again, until no instance has one
//      running;
//   3. clear every timer the file created, which cancels whatever is still
//      queued.
//
// The other leak is console output. Work an action starts without awaiting it
// is invisible to the scheduler, so it can outlive the drain, and its
// `console.error` then lands after this file's `afterAll` — with no test to
// belong to, vitest files it at file level, and a console call issued that
// late races the worker's rpc teardown: "EnvironmentTeardownError: Closing
// rpc while 'onUserConsoleLog' was pending", an unhandled error that fails
// the whole shard while every test passes (hit twice on 2026-09-15 via
// bakeUnitFromSeed's "[bake …] loop failed" line, on two unrelated PRs). So
// console output with no running test is dropped, for the same reason the
// timers are cleared: nothing after the last test is part of any verdict.
// The gate is installed once per worker and never restored, because the
// worker outlives the file.
import { afterAll, beforeAll, TestRunner } from "vitest";

type TimerId = ReturnType<typeof setTimeout>;
type TrackedInstance = NonNullable<typeof globalThis.__rhConvexTests> extends Set<infer T> ? T : never;
const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];
type ConsoleFn = (...args: unknown[]) => void;

declare global {
  var __rhConvexSharedOriginals:
    | {
        setTimeout: typeof setTimeout;
        setInterval: typeof setInterval;
        clearTimeout: typeof clearTimeout;
        clearInterval: typeof clearInterval;
        console: Partial<Record<ConsoleMethod, ConsoleFn>>;
      }
    | undefined;
}

// vitest re-evaluates this module for every test file, but the worker's
// globals outlive the file, so the real timers and console methods are
// captured once per worker. A later file must never take an earlier file's
// wrapper for the real thing: the console gate stays installed, and a drain
// that outlives its hook's timeout is still running.
const real = (globalThis.__rhConvexSharedOriginals ??= {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
  console: {},
});
const {
  setTimeout: realSetTimeout,
  setInterval: realSetInterval,
  clearTimeout: realClearTimeout,
  clearInterval: realClearInterval,
} = real;

// A drain that waits out a leaked job's request deadline (up to 12 s in the
// backend's fetch helpers) should finish, not fail its file on the default
// 10 s. A job that never settles, like one that reschedules itself while it
// is still running, holds the drain until this fails the file.
const DRAIN_TIMEOUT_MS = 30_000;
// A round only repeats for an instance that had a job running, and that job's
// follow-ups are cancelled in the next round, so real chains end within two
// or three. Rounds that never end mean the job table still shows a job as
// running after it settled (convex-test threw one of its own invariant
// errors), and the loop would otherwise spin until the hook timed out.
const MAX_DRAIN_ROUNDS = 20;

const pending = new Set<TimerId>();
// setTimeout callbacks that have run. A queued job can only start from one.
let fired = 0;

const trackingSetTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const id = realSetTimeout(
    function (this: unknown, ...callbackArgs: unknown[]) {
      fired += 1;
      return callback.apply(this, callbackArgs);
    },
    ms,
    ...args,
  );
  pending.add(id);
  return id;
}) as typeof setTimeout;
const trackingSetInterval = ((...args: Parameters<typeof setInterval>) => {
  const id = realSetInterval(...args);
  pending.add(id);
  return id;
}) as typeof setInterval;
const trackingClearTimeout = ((id: TimerId) => {
  pending.delete(id);
  realClearTimeout(id);
}) as typeof clearTimeout;
const trackingClearInterval = ((id: TimerId) => {
  pending.delete(id);
  realClearInterval(id);
}) as typeof clearInterval;

beforeAll(() => {
  globalThis.setTimeout = trackingSetTimeout;
  globalThis.setInterval = trackingSetInterval;
  globalThis.clearTimeout = trackingClearTimeout;
  globalThis.clearInterval = trackingClearInterval;

  for (const method of CONSOLE_METHODS) {
    if (real.console[method]) continue; // installed once per worker
    const original = console[method] as ConsoleFn;
    real.console[method] = original;
    console[method] = (...args: unknown[]) => {
      // Same attribution signal vitest's console uses: no current test means
      // this line would be reported at file level — a leaked job's output.
      if (TestRunner.getCurrentTest()) original(...args);
    };
  }
});

function clearPending() {
  const leaked = pending.size;
  for (const id of pending) realClearTimeout(id);
  pending.clear();
  return leaked;
}

// convex-test checks a job's state when its timer fires and returns early for
// a cancelled one, before loading the job's module. A job whose timer has
// fired but that has not reached that check yet still reads as pending here,
// so it is cancelled too. `running` names the jobs past it.
async function cancelQueuedJobs(t: TrackedInstance) {
  try {
    return await t.run(async (ctx) => {
      let cancelled = 0;
      const running: string[] = [];
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "inProgress") running.push(job.name);
        if (job.state.kind !== "pending") continue;
        await ctx.scheduler.cancel(job._id);
        cancelled += 1;
      }
      return { cancelled, running };
    });
  } catch (error) {
    real.console.warn?.("[vitest.convexShared] could not cancel a test's queued scheduled functions:", error);
    return { cancelled: 0, running: [] };
  }
}

async function finishStartedJobs(t: TrackedInstance) {
  // A job that throws rejects the wait while its siblings may still be
  // running, so wait again until the instance is idle. The failure is this
  // file's hygiene problem, not the next file's verdict: surface it without
  // changing this file's result.
  for (;;) {
    try {
      await t.finishInProgressScheduledFunctions();
      return;
    } catch (error) {
      real.console.warn?.("[vitest.convexShared] leaked scheduled function failed while draining:", error);
    }
  }
}

afterAll(async () => {
  const instances = [...(globalThis.__rhConvexTests ?? [])];
  globalThis.__rhConvexTests?.clear();
  let cancelled = 0;
  let rounds = 0;
  try {
    // Wait for every started job. Usually nothing is running and this settles
    // within microtasks, before any timer can fire: no queued job can have
    // started, and clearing the timers below cancels the rest.
    const firedBefore = fired;
    await Promise.all(instances.map(finishStartedJobs));
    // Otherwise a queued job may have started after its instance was found
    // idle. Cancel what is still queued and wait again, then repeat for each
    // instance that had a job running, since that job may have queued more.
    // (Only here, because a cancel pass is a transaction per instance, which
    // costs real time on every file when done unconditionally.)
    let draining = fired === firedBefore ? [] : instances;
    while (draining.length > 0) {
      const passes = await Promise.all(draining.map(cancelQueuedJobs));
      await Promise.all(draining.map(finishStartedJobs));
      cancelled += passes.reduce((sum, pass) => sum + pass.cancelled, 0);
      const running = passes.flatMap((pass) => pass.running);
      if (++rounds === MAX_DRAIN_ROUNDS && running.length > 0) {
        throw new Error(
          `[vitest.convexShared] scheduled functions this file left behind still read as running after ` +
            `${MAX_DRAIN_ROUNDS} drain rounds: ${running.join(", ")}`,
        );
      }
      draining = draining.filter((_, i) => passes[i].running.length > 0);
    }
  } finally {
    const leaked = clearPending();
    // Only this file's wrappers: if the drain outlived its hook, the next
    // file has installed its own.
    if (globalThis.setTimeout === trackingSetTimeout) globalThis.setTimeout = realSetTimeout;
    if (globalThis.setInterval === trackingSetInterval) globalThis.setInterval = realSetInterval;
    if (globalThis.clearTimeout === trackingClearTimeout) globalThis.clearTimeout = realClearTimeout;
    if (globalThis.clearInterval === trackingClearInterval) globalThis.clearInterval = realClearInterval;
    if (process.env.RH_DRAIN_DEBUG) {
      real.console.log?.(
        `[vitest.convexShared] ${instances.length} instance(s), ${rounds} round(s), ` +
          `cancelled ${cancelled} queued job(s), cleared ${leaked} timer(s)`,
      );
    }
  }
  // Let any console rpc the last test issued reach the main thread before
  // vitest tears the worker down.
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}, DRAIN_TIMEOUT_MS);

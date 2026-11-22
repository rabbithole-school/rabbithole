// Setup for BOTH Convex projects (vitest.config.ts): the shared-worker one and
// the isolated one. Runs per test file.
//
// Work a test leaves running can outlive the file: a scheduled action (the
// observer a send schedules), or work an action starts without awaiting it.
// Its `console.*` then lands after this file's last test — with no test to
// belong to, vitest files it at file level, and a console call issued that
// late races the worker's rpc teardown: "EnvironmentTeardownError: Closing
// rpc while 'onUserConsoleLog' was pending", an unhandled error that fails
// the whole shard while every test passes. Hit twice on 2026-09-15 via
// bakeUnitFromSeed's "[bake …] loop failed" line in the shared project, then
// on 2026-10-24 via stopSteering's scheduled observer ("[Observer] …") in the
// isolated project, which fake timers put there and which had no gate. So
// console output with no running test is dropped: nothing after the last
// test is part of any verdict.
//
// The gate is installed once per worker and never restored, because a shared
// worker outlives the file. The real methods stay reachable through
// `globalThis.__rhRealConsole` for setup code that must log outside a test.
import { afterAll, beforeAll, TestRunner } from "vitest";

const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];
type ConsoleFn = (...args: unknown[]) => void;

declare global {
  var __rhRealConsole: Partial<Record<ConsoleMethod, ConsoleFn>> | undefined;
}

// Captured before any test can install fake timers.
const realSetTimeout = globalThis.setTimeout;
const real = (globalThis.__rhRealConsole ??= {});

beforeAll(() => {
  for (const method of CONSOLE_METHODS) {
    if (real[method]) continue; // installed once per worker
    const original = console[method] as ConsoleFn;
    real[method] = original;
    console[method] = (...args: unknown[]) => {
      // Same attribution signal vitest's console uses: no current test means
      // this line would be reported at file level — a leaked job's output.
      if (TestRunner.getCurrentTest()) original(...args);
    };
  }
});

// Let any console rpc the last test issued reach the main thread before
// vitest tears the worker down. Registered before the shared project's drain,
// so it runs after it (vitest runs afterAll hooks in reverse).
afterAll(async () => {
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
});

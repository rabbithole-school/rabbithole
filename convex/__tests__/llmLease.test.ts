/**
 * acquireLlmLease's release runs its mutation once (TRA-607). Streams release
 * before closing and again in a `finally` backstop that runs after
 * `controller.close()`, when Convex may already have ended the HTTP action;
 * a second release mutation started there was left pending on every tutor
 * turn, logged as "1 unawaited operation: [mutation]".
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { acquireLlmLease } from "../lib/llmLease";

const LEASE_ID = "lease-1" as Id<"llmLeases">;
const USER_ID = "user-1" as Id<"users">;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A ctx whose acquire grants a lease and whose release follows `release`. */
function fakeCtx(release: () => Promise<void>) {
  const calls: string[] = [];
  const runMutation = vi.fn(
    async (ref: FunctionReference<"mutation", "internal">) => {
      const name = getFunctionName(ref);
      calls.push(name);
      if (name === "llmLimiter:acquire") return { ok: true, leaseId: LEASE_ID };
      if (name === "llmLimiter:release") return await release();
      throw new Error(`unexpected mutation ${name}`);
    },
  );
  return { ctx: { runMutation } as unknown as ActionCtx, calls };
}

async function grantedLease(ctx: ActionCtx) {
  const lease = await acquireLlmLease(ctx, {
    userId: USER_ID,
    surface: "project-stream",
  });
  if (!lease.ok) throw new Error("expected a granted lease");
  return lease;
}

const releases = (calls: string[]) =>
  calls.filter((name) => name === "llmLimiter:release").length;

describe("acquireLlmLease release", () => {
  test("a release after a successful release starts no mutation", async () => {
    const { ctx, calls } = fakeCtx(async () => undefined);
    const lease = await grantedLease(ctx);

    await lease.release(); // before controller.close()
    await lease.release(); // the stream's finally, after the close

    expect(releases(calls)).toBe(1);
  });

  test("overlapping releases share one mutation", async () => {
    const pending: Array<() => void> = [];
    const { ctx, calls } = fakeCtx(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const lease = await grantedLease(ctx);

    // An app update's cancel() and start() can both release.
    const first = lease.release();
    const second = lease.release();
    await Promise.resolve();
    for (const resolve of pending) resolve();
    await Promise.all([first, second]);

    expect(releases(calls)).toBe(1);
  });

  test("a failed release is logged and the next call tries again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempt = 0;
    const { ctx, calls } = fakeCtx(async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
    });
    const lease = await grantedLease(ctx);

    await expect(lease.release()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "[llm-limiter] lease release failed:",
      expect.any(Error),
    );
    await lease.release();
    await lease.release();

    expect(releases(calls)).toBe(2);
  });
});

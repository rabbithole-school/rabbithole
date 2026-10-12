import { describe, expect, it } from "vitest";
import {
  deriveServerTurnState,
  isQuietAppUpdatePlaceholder,
  parseRetryAfterSeconds,
  pendingTurnLabel,
  planStreamRetry,
  STREAM_DEAD_PLACEHOLDER_MS,
  STREAM_RETRY_BUDGET_MS,
  STREAM_RETRY_DEFAULT_DELAY_MS,
  STREAM_RETRY_MAX_DELAY_MS,
  type TurnPlaceholder,
} from "./streamRetry";

describe("parseRetryAfterSeconds", () => {
  it("parses the integer-seconds form the tutor stream emits", () => {
    expect(parseRetryAfterSeconds("5")).toBe(5);
    expect(parseRetryAfterSeconds("  30 ")).toBe(30);
    expect(parseRetryAfterSeconds("0")).toBe(0);
  });

  it("returns null for absent, empty, or non-numeric values", () => {
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds(undefined)).toBeNull();
    expect(parseRetryAfterSeconds("")).toBeNull();
    expect(parseRetryAfterSeconds("soon")).toBeNull();
    expect(parseRetryAfterSeconds("-3")).toBeNull();
  });
});

describe("planStreamRetry", () => {
  it("does not retry a non-busy failure", () => {
    expect(
      planStreamRetry({ busy: false, elapsedMs: 0, retryAfterSec: 5 }),
    ).toEqual({ retry: false, delayMs: 0 });
  });

  it("retries a busy refusal honoring Retry-After (concurrency = 5s)", () => {
    expect(
      planStreamRetry({ busy: true, elapsedMs: 2_000, retryAfterSec: 5 }),
    ).toEqual({ retry: true, delayMs: 5_000 });
  });

  it("falls back to the default delay when Retry-After is absent", () => {
    expect(
      planStreamRetry({ busy: true, elapsedMs: 0, retryAfterSec: null }),
    ).toEqual({ retry: true, delayMs: STREAM_RETRY_DEFAULT_DELAY_MS });
  });

  it("clamps a sub-5s Retry-After up to the 5s floor", () => {
    expect(
      planStreamRetry({ busy: true, elapsedMs: 0, retryAfterSec: 0 }).delayMs,
    ).toBe(STREAM_RETRY_DEFAULT_DELAY_MS);
    expect(
      planStreamRetry({ busy: true, elapsedMs: 0, retryAfterSec: 2 }).delayMs,
    ).toBe(STREAM_RETRY_DEFAULT_DELAY_MS);
  });

  it("clamps a Retry-After above 15s down to the 15s ceiling (under the dead window)", () => {
    expect(
      planStreamRetry({ busy: true, elapsedMs: 0, retryAfterSec: 15 }),
    ).toEqual({ retry: true, delayMs: STREAM_RETRY_MAX_DELAY_MS });
    // A 30s Retry-After is still honored as a retry, but capped at the 15s ceiling.
    expect(
      planStreamRetry({ busy: true, elapsedMs: 0, retryAfterSec: 30 }),
    ).toEqual({ retry: true, delayMs: STREAM_RETRY_MAX_DELAY_MS });
  });

  it("keeps the delay ceiling below the 20s dead-placeholder window", () => {
    expect(STREAM_RETRY_MAX_DELAY_MS).toBeLessThan(STREAM_DEAD_PLACEHOLDER_MS);
  });

  it("stops immediately when Retry-After exceeds 30s (user-window denial)", () => {
    expect(
      planStreamRetry({ busy: true, elapsedMs: 0, retryAfterSec: 31 }),
    ).toEqual({ retry: false, delayMs: 0 });
    expect(
      planStreamRetry({ busy: true, elapsedMs: 0, retryAfterSec: 300 }),
    ).toEqual({ retry: false, delayMs: 0 });
  });

  it("does not start a wait that would exceed the total budget", () => {
    expect(
      planStreamRetry({
        busy: true,
        elapsedMs: STREAM_RETRY_BUDGET_MS - 4_000,
        retryAfterSec: 5,
      }),
    ).toEqual({ retry: false, delayMs: 0 });
  });

  it("keeps retrying with the 5s cadence until ~45s of elapsed budget", () => {
    let elapsedMs = 0;
    let posts = 0;
    for (;;) {
      posts += 1;
      const plan = planStreamRetry({
        busy: true,
        elapsedMs,
        retryAfterSec: 5,
      });
      if (!plan.retry) break;
      elapsedMs += plan.delayMs + 300; // wait + a little request overhead
    }
    // No fixed attempt cap: several retries fit the 45s budget (vs. the old
    // 4-attempt cap that gave up at ~16s).
    expect(posts).toBeGreaterThan(4);
    expect(elapsedMs).toBeLessThanOrEqual(STREAM_RETRY_BUDGET_MS + 5_000);
  });
});

describe("pendingTurnLabel", () => {
  it("shows no label before the first escalation", () => {
    expect(pendingTurnLabel(0)).toBeNull();
    expect(pendingTurnLabel(7_999)).toBeNull();
  });

  it("escalates with elapsed time", () => {
    expect(pendingTurnLabel(8_000)).toBe("Still thinking…");
    expect(pendingTurnLabel(19_999)).toBe("Still thinking…");
    expect(pendingTurnLabel(20_000)).toBe("Taking a little longer than usual…");
  });
});

describe("deriveServerTurnState", () => {
  const placeholder = (over: Partial<TurnPlaceholder> = {}): TurnPlaceholder => ({
    role: "assistant",
    content: "",
    streamId: "s1",
    createdAt: 1_000,
    ...over,
  });

  it("is idle with no trailing message", () => {
    expect(deriveServerTurnState(null, 5_000)).toBe("idle");
    expect(deriveServerTurnState(undefined, 5_000)).toBe("idle");
  });

  it("is idle when the last message is a user turn or has content", () => {
    expect(deriveServerTurnState(placeholder({ role: "user" }), 1_500)).toBe(
      "idle",
    );
    expect(deriveServerTurnState(placeholder({ content: "hi" }), 1_500)).toBe(
      "idle",
    );
  });

  it("is idle for a bare empty assistant row with neither streamId nor heartbeat", () => {
    expect(
      deriveServerTurnState(
        placeholder({ streamId: null, lastStreamActivityAt: null }),
        1_500,
      ),
    ).toBe("idle");
  });

  it("is pending for a fresh streamId placeholder (normal send)", () => {
    expect(deriveServerTurnState(placeholder(), 5_000)).toBe("pending");
  });

  it("is pending for a fresh POST-TOOL placeholder with a heartbeat but NO streamId", () => {
    // The split placeholder shape: no streamId, but stamped lastStreamActivityAt.
    expect(
      deriveServerTurnState(
        placeholder({ streamId: null, lastStreamActivityAt: 5_000 }),
        9_000,
      ),
    ).toBe("pending");
  });

  it("goes dead once a streamId placeholder is older than the reap window", () => {
    // createdAt 1000, no heartbeat → dead at +20s
    expect(deriveServerTurnState(placeholder(), 21_000)).toBe("dead");
    // a fresher heartbeat keeps it pending
    expect(
      deriveServerTurnState(
        placeholder({ lastStreamActivityAt: 20_000 }),
        21_000,
      ),
    ).toBe("pending");
  });

  it("a STALE post-tool (no-streamId) placeholder is idle, never dead", () => {
    // Past the window, no streamId → idle (the server reaps it on next send;
    // showing a retry could duplicate an in-progress split).
    expect(
      deriveServerTurnState(
        placeholder({ streamId: null, lastStreamActivityAt: 1_000 }),
        30_000,
      ),
    ).toBe("idle");
  });
});

describe("quiet app-update placeholders", () => {
  const appUpdate = (over: Partial<TurnPlaceholder> = {}): TurnPlaceholder => ({
    role: "assistant",
    content: "",
    streamId: "s1",
    createdAt: 1_000,
    streamTrigger: "appUpdate",
    ...over,
  });

  it("is quiet only while an app-update turn has said nothing", () => {
    expect(isQuietAppUpdatePlaceholder(appUpdate())).toBe(true);
    expect(
      isQuietAppUpdatePlaceholder(appUpdate({ content: "Look again." })),
    ).toBe(false);
    expect(isQuietAppUpdatePlaceholder(appUpdate({ streamTrigger: null }))).toBe(
      false,
    );
    expect(
      isQuietAppUpdatePlaceholder(
        appUpdate({ streamTrigger: "activityKickoff" }),
      ),
    ).toBe(false);
    expect(isQuietAppUpdatePlaceholder(null)).toBe(false);
  });

  it("never reads as pending or dead, so no typing dots and no retry", () => {
    expect(deriveServerTurnState(appUpdate(), 5_000)).toBe("idle");
    expect(deriveServerTurnState(appUpdate(), 60_000)).toBe("idle");
  });
});

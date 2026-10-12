import { describe, expect, test } from "vitest";
import {
  APP_AI_LLM_SURFACE,
  APP_UPDATE_LLM_SURFACE,
  decideLlmLease as decideWithPlatformLeases,
  type LlmLeaseSnapshot,
  type LlmPlatformLease,
} from "../llmLimiter";

const NOW = 2_000_000_000_000;

// The pre-existing cases pass bare start times: every platform lease there is
// a tutor-side one (no surface), which is what they described before app-AI
// leases had a ceiling of their own. Their expected decisions are unchanged.
function decideLlmLease<TLeaseId>(args: {
  now: number;
  userLeases: readonly LlmLeaseSnapshot<TLeaseId>[];
  platformActiveStartedAts?: readonly number[];
  platformActiveLeases?: readonly LlmPlatformLease[];
  surface?: string;
}) {
  const { platformActiveStartedAts = [], platformActiveLeases = [], ...rest } =
    args;
  return decideWithPlatformLeases({
    ...rest,
    platformActiveLeases: [
      ...platformActiveStartedAts.map((startedAt) => ({ startedAt })),
      ...platformActiveLeases,
    ],
  });
}

const freshStarts = (count: number) =>
  Array.from({ length: count }, (_, index) => NOW - 1_000 - index);

function lease(
  leaseId: string,
  startedAt: number,
  active: boolean,
): LlmLeaseSnapshot<string> {
  return { leaseId, startedAt, active };
}

describe("decideLlmLease", () => {
  test("allows a human-paced start below every ceiling", () => {
    const userLeases = [
      lease("active", NOW - 1_000, true),
      ...Array.from({ length: 38 }, (_, index) =>
        lease(`old-${index}`, NOW - 10_000 - index * 1_000, false),
      ),
    ];

    expect(
      decideLlmLease({
        now: NOW,
        userLeases,
        platformActiveStartedAts: [NOW - 1_000],
      }),
    ).toEqual({ decision: { ok: true }, staleUserLeaseIds: [] });
  });

  test("denies a third fresh concurrent stream for one user", () => {
    const result = decideLlmLease({
      now: NOW,
      userLeases: [
        lease("one", NOW - 2_000, true),
        lease("two", NOW - 1_000, true),
      ],
      platformActiveStartedAts: [NOW - 2_000, NOW - 1_000],
    });

    expect(result.decision).toEqual({
      ok: false,
      reason: "user-concurrent",
      retryAfterSec: 5,
    });
  });

  test("denies the forty-first start and rounds retry-after up", () => {
    const userLeases = Array.from({ length: 40 }, (_, index) =>
      lease(
        `lease-${index}`,
        NOW - 600_000 + 1_500 + index * 1_000,
        false,
      ),
    );

    const result = decideLlmLease({
      now: NOW,
      userLeases,
      platformActiveStartedAts: [],
    });

    expect(result.decision).toEqual({
      ok: false,
      reason: "user-window",
      retryAfterSec: 2,
    });
  });

  test("denies when sixty fresh streams are active across the platform", () => {
    const result = decideLlmLease({
      now: NOW,
      userLeases: [],
      platformActiveStartedAts: Array.from(
        { length: 60 },
        (_, index) => NOW - 1_000 - index,
      ),
    });

    expect(result.decision).toEqual({
      ok: false,
      reason: "platform",
      retryAfterSec: 5,
    });
  });

  test("app-AI starts do not use up the shared window", () => {
    const userLeases = Array.from({ length: 59 }, (_, index) => ({
      ...lease(`app-${index}`, NOW - 10_000 - index * 1_000, false),
      surface: APP_AI_LLM_SURFACE,
    }));

    expect(
      decideLlmLease({
        now: NOW,
        userLeases,
        platformActiveStartedAts: [],
        surface: "project-stream",
      }).decision,
    ).toEqual({ ok: true });
    expect(
      decideLlmLease({
        now: NOW,
        userLeases,
        platformActiveStartedAts: [],
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: true });
  });

  test("denies the sixty-first app-AI start but not a tutor start", () => {
    const userLeases = Array.from({ length: 60 }, (_, index) => ({
      ...lease(`app-${index}`, NOW - 600_000 + 1_500 + index * 1_000, false),
      surface: APP_AI_LLM_SURFACE,
    }));

    expect(
      decideLlmLease({
        now: NOW,
        userLeases,
        platformActiveStartedAts: [],
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: false, reason: "user-window", retryAfterSec: 2 });
    expect(
      decideLlmLease({
        now: NOW,
        userLeases,
        platformActiveStartedAts: [],
        surface: "project-stream",
      }).decision,
    ).toEqual({ ok: true });
  });

  test("a full shared window does not block app-AI calls", () => {
    const userLeases = Array.from({ length: 40 }, (_, index) =>
      lease(`tutor-${index}`, NOW - 10_000 - index * 1_000, false),
    );

    expect(
      decideLlmLease({
        now: NOW,
        userLeases,
        platformActiveStartedAts: [],
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: true });
  });

  test("an app-AI call may overlap two tutor streams, and vice versa", () => {
    const tutorStreams = [
      lease("one", NOW - 2_000, true),
      lease("two", NOW - 1_000, true),
    ];
    const appCalls = [
      { ...lease("app-1", NOW - 2_000, true), surface: APP_AI_LLM_SURFACE },
      { ...lease("app-2", NOW - 1_000, true), surface: APP_AI_LLM_SURFACE },
    ];

    expect(
      decideLlmLease({
        now: NOW,
        userLeases: tutorStreams,
        platformActiveStartedAts: [],
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: true });
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: appCalls,
        platformActiveStartedAts: [],
        surface: "project-stream",
      }).decision,
    ).toEqual({ ok: true });
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: [...tutorStreams, ...appCalls],
        platformActiveStartedAts: [],
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toMatchObject({ ok: false, reason: "user-concurrent" });
  });

  test("app-AI calls have their own platform ceiling of twenty", () => {
    const appAiPlatform = freshStarts(20).map((startedAt) => ({
      startedAt,
      surface: APP_AI_LLM_SURFACE,
    }));

    expect(
      decideLlmLease({
        now: NOW,
        userLeases: [],
        platformActiveLeases: appAiPlatform.slice(0, 19),
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: true });
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: [],
        platformActiveLeases: appAiPlatform,
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: false, reason: "platform", retryAfterSec: 5 });
  });

  test("app-AI calls never take tutor headroom, and tutor streams never block them", () => {
    const appAiPlatform = freshStarts(20).map((startedAt) => ({
      startedAt,
      surface: APP_AI_LLM_SURFACE,
    }));

    // 59 tutor streams + 20 app-AI calls: the tutor still has its sixtieth.
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: [],
        platformActiveStartedAts: freshStarts(59),
        platformActiveLeases: appAiPlatform,
        surface: "project-stream",
      }).decision,
    ).toEqual({ ok: true });
    // A full tutor platform does not refuse a character line.
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: [],
        platformActiveStartedAts: freshStarts(60),
        surface: APP_AI_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: true });
  });

  test("zero-ask app updates draw on their own thirty-start window", () => {
    const updates = Array.from({ length: 30 }, (_, index) => ({
      ...lease(`update-${index}`, NOW - 600_000 + 1_500 + index * 1_000, false),
      surface: APP_UPDATE_LLM_SURFACE,
    }));

    // Thirty updates spend none of the scholar's typed-turn allowance…
    expect(
      decideLlmLease({ now: NOW, userLeases: updates, surface: "project-stream" })
        .decision,
    ).toEqual({ ok: true });
    // …but the thirty-first update waits for the window.
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: updates,
        surface: APP_UPDATE_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: false, reason: "user-window", retryAfterSec: 2 });
    // And forty typed turns do not stop an app update.
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: Array.from({ length: 40 }, (_, index) =>
          lease(`tutor-${index}`, NOW - 10_000 - index * 1_000, false),
        ),
        surface: APP_UPDATE_LLM_SURFACE,
      }).decision,
    ).toEqual({ ok: true });
  });

  test("an app update is a tutor stream for concurrency and the platform", () => {
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: [
          {
            ...lease("update", NOW - 2_000, true),
            surface: APP_UPDATE_LLM_SURFACE,
          },
          lease("tutor", NOW - 1_000, true),
        ],
        surface: "project-stream",
      }).decision,
    ).toMatchObject({ ok: false, reason: "user-concurrent" });
    expect(
      decideLlmLease({
        now: NOW,
        userLeases: [],
        platformActiveLeases: freshStarts(60).map((startedAt) => ({
          startedAt,
          surface: APP_UPDATE_LLM_SURFACE,
        })),
        surface: "project-stream",
      }).decision,
    ).toMatchObject({ ok: false, reason: "platform" });
  });

  test("expires a five-minute-old active lease before deciding", () => {
    const result = decideLlmLease({
      now: NOW,
      userLeases: [
        lease("stale", NOW - 300_000, true),
        lease("fresh", NOW - 299_999, true),
      ],
      platformActiveStartedAts: [NOW - 300_000, NOW - 299_999],
    });

    expect(result).toEqual({
      decision: { ok: true },
      staleUserLeaseIds: ["stale"],
    });
  });
});

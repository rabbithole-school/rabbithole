import { describe, expect, it } from "vitest";

import { breakerHydrationEvent } from "@/lib/breakerHydration";

import {
  newPracticeState,
  practiceReduce,
  type PracticeState,
} from "../../../vendor/shared/practiceMachine";
import type { BreakerLifecycleOperation } from "../../../vendor/shared/practiceLifecycleRetry";
import { newBreakerFlow } from "../../../vendor/shared/practiceLoop";

// ─────────────────────────────────────────────────────────────────────────
// Native binding-seam coverage for the reactive `activeBreakerEpisode` →
// `hydrate:breaker` translation (acceptance #5: "Query activeBreakerEpisode
// reactively and hydrate exact flow/attempt/rung/pinned fresh/easy... Two
// consecutive relaunches must not re-alert or regrade."). The REDUCER's own
// hydrate:breaker exactness/idempotency logic is already exhaustively
// covered by shared/practiceMachine.test.ts's "breaker hydration" describe
// block (same vendored file, byte-identical) — this file's job is narrower
// and native-specific: prove the translation `breakerHydrationEvent` performs
// (server episode shape → reducer event shape: stringifying the branded
// attempt id, defaulting optional fields to null, hardcoding
// recoveryAvailable) produces an event that, fed into the REAL reducer,
// lands the exact fields and survives being re-delivered — exactly what a
// `useQuery(api.practiceSkills.activeBreakerEpisode)` refetch across a
// process relaunch actually does: deliver a NEW JS object with the SAME
// server-side field values, not the same reference.
// ─────────────────────────────────────────────────────────────────────────

const SCHOLAR = "scholar-1" as never;

function confirmed(
  ...operations: BreakerLifecycleOperation[]
): BreakerLifecycleOperation[] {
  return operations;
}

function start(): PracticeState {
  return newPracticeState({ scholarId: SCHOLAR, itemCount: 6, itemId: "item-1" });
}

/** A fresh, independently-constructed object each call — simulating a real
 *  `useQuery` refetch (new reference, same server-side values) rather than
 *  reusing one object across two dispatches. */
function serverEpisode() {
  return {
    version: 2 as const,
    triggerAttemptId: "attempt-9" as never,
    triggerNodeKey: "node-9",
    domain: "whole-number-arithmetic",
    missStreak: 3,
    lastActivityAt: 1_000,
    expiresAt: 999_000,
    triggerItemId: "item-trigger",
    flow: newBreakerFlow("open"),
    repairStepIndex: 2,
    repairRungKind: "completion" as const,
    freshItemId: "item-fresh-7",
    easyItemId: "item-easy-3",
    easyDomain: "whole-number-arithmetic",
    confirmedLifecycle: confirmed("repairShown", "repairStarted"),
  };
}

describe("breakerHydrationEvent (native binding seam)", () => {
  it("translates the server episode into the exact hydrate:breaker event shape", () => {
    const event = breakerHydrationEvent(serverEpisode());
    expect(event).toEqual({
      type: "hydrate:breaker",
      episode: {
        triggerAttemptId: "attempt-9",
        recoveryAvailable: true,
        triggerItemId: "item-trigger",
        triggerNodeKey: "node-9",
        domain: "whole-number-arithmetic",
        missStreak: 3,
        flow: newBreakerFlow("open"),
        repairStepIndex: 2,
        freshItemId: "item-fresh-7",
        easyItemId: "item-easy-3",
        confirmedLifecycle: ["repairShown", "repairStarted"],
      },
    });
  });

  it("defaults optional trigger/rung/fresh/easy fields to null, never undefined", () => {
    const bare = {
      ...serverEpisode(),
      triggerItemId: undefined,
      repairStepIndex: undefined,
      freshItemId: undefined,
      easyItemId: undefined,
    };
    const event = breakerHydrationEvent(bare);
    expect(event.episode.triggerItemId).toBeNull();
    expect(event.episode.repairStepIndex).toBeNull();
    expect(event.episode.freshItemId).toBeNull();
    expect(event.episode.easyItemId).toBeNull();
  });

  it("hydrates the exact trigger/rung/fresh/easy state into the REAL reducer", () => {
    const step = practiceReduce(start(), breakerHydrationEvent(serverEpisode()));
    expect(step.state.breaker).toMatchObject({
      triggerAttemptId: "attempt-9",
      recoveryAvailable: true,
      triggerItemId: "item-trigger",
      triggerNodeKey: "node-9",
      domain: "whole-number-arithmetic",
      missStreak: 3,
      repairStepIndex: 2,
      freshItemId: "item-fresh-7",
      easyItemId: "item-easy-3",
      lifecycle: {
        confirmed: ["repairShown", "repairStarted"],
        pending: [],
      },
    });
    expect(step.state.breaker?.flow.stage).toBe("repair");
    expect(step.state.breaker?.flow.repair).toBe("open");
    // A live episode always outranks loading an ordinary run — the lane and
    // terminal flags settle back to their at-rest values.
    expect(step.state.lane).toBeNull();
    expect(step.state.terminal).toBe(false);
  });

  it("installs the real trigger item's repair rung on first hydration (relaunch mid-repair)", () => {
    const step = practiceReduce(start(), breakerHydrationEvent(serverEpisode()));
    const rung = step.commands.find((c) => c.kind === "serveHintRung");
    expect(rung).toBeDefined();
    if (rung && "itemId" in rung) expect(rung.itemId).toBe("item-trigger");
    if (rung && "stepIndex" in rung) expect(rung.stepIndex).toBe(2);
    expect(step.state.hint.itemId).toBe("item-trigger");
    expect(step.state.hint.open).toBe(true);
    expect(step.commands.map((command) => command.kind)).toEqual([
      "serveHintRung",
    ]);
  });

  it("two cold relaunches reconstruct only the exact rung, never a trigger, lifecycle, outcome, or grade", () => {
    for (const relaunch of [1, 2]) {
      const hydrated = practiceReduce(
        start(),
        breakerHydrationEvent(serverEpisode()),
      );
      expect(hydrated.state.breaker, `relaunch ${relaunch}`).toMatchObject({
        triggerAttemptId: "attempt-9",
        triggerItemId: "item-trigger",
        repairStepIndex: 2,
      });
      expect(hydrated.commands, `relaunch ${relaunch}`).toEqual([
        {
          kind: "serveHintRung",
          id: "breaker:attempt-9:repairRestore",
          domain: "hint:item-trigger",
          itemId: "item-trigger",
          stepIndex: 2,
          source: "breakerRestore",
        },
      ]);
      const restored = practiceReduce(hydrated.state, {
        type: "server:hintServed",
        id: "breaker:attempt-9:repairRestore",
        stepIndex: 2,
        hasMore: true,
        rungKind: "completion",
      });
      expect(restored.commands, `relaunch ${relaunch}`).toEqual([]);
    }
  });

  it("an identical reactive refetch after hydration is a strict no-op", () => {
    const first = practiceReduce(start(), breakerHydrationEvent(serverEpisode()));
    const second = practiceReduce(first.state, breakerHydrationEvent(serverEpisode()));
    expect(second.state).toBe(first.state);
    expect(second.commands).toEqual([]);
  });

  it("two process relaunches use authoritative lifecycle evidence without replaying writes", () => {
    const completed = {
      ...serverEpisode(),
      flow: {
        stage: "fresh" as const,
        repair: "done" as const,
        coachUsed: false,
      },
      confirmedLifecycle: confirmed(
        "repairShown",
        "repairStarted",
        "repairCompleted",
      ),
    };

    for (const relaunch of [1, 2]) {
      const hydrated = practiceReduce(
        start(),
        breakerHydrationEvent(completed),
      );
      expect(
        hydrated.state.breaker?.lifecycle,
        `relaunch ${relaunch}`,
      ).toEqual({
        confirmed: [
          "repairShown",
          "repairStarted",
          "repairCompleted",
        ],
        pending: [],
      });
      expect(
        hydrated.commands.map((command) => command.kind),
        `relaunch ${relaunch}`,
      ).toEqual(["serveBreakerFresh"]);
    }
  });

  it("does not relaunch a coach whose server projection confirms presentation", () => {
    const coached = {
      ...serverEpisode(),
      flow: {
        stage: "coach" as const,
        repair: "unavailable" as const,
        coachUsed: true,
      },
      repairStepIndex: undefined,
      freshItemId: undefined,
      easyItemId: undefined,
      confirmedLifecycle: confirmed(
        "repairUnavailable",
        "coachEscalated",
      ),
    };

    for (const relaunch of [1, 2]) {
      const hydrated = practiceReduce(
        start(),
        breakerHydrationEvent(coached),
      );
      expect(
        hydrated.state.breaker?.lifecycle.confirmed,
        `relaunch ${relaunch}`,
      ).toEqual(["repairUnavailable", "coachEscalated"]);
      expect(
        hydrated.commands.map((command) => command.kind),
        `relaunch ${relaunch}`,
      ).not.toContain("launchCoach");
    }
  });

  it("does not reconstruct or regrade an already-graded fresh item on relaunch", () => {
    const graded = {
      ...serverEpisode(),
      flow: {
        stage: "fresh" as const,
        repair: "done" as const,
        coachUsed: false,
        fresh: { correct: true, assisted: false, verified: true },
      },
    };
    const step = practiceReduce(start(), breakerHydrationEvent(graded));
    const kinds = step.commands.map((c) => c.kind);
    expect(kinds).not.toContain("serveBreakerFresh");
  });

  it("reconstructs the pinned fresh item on relaunch when the stage is fresh but ungraded", () => {
    const midFresh = {
      ...serverEpisode(),
      flow: { stage: "fresh" as const, repair: "done" as const, coachUsed: false },
    };
    const step = practiceReduce(start(), breakerHydrationEvent(midFresh));
    const kinds = step.commands.map((c) => c.kind);
    expect(kinds).toContain("serveBreakerFresh");
  });

  it("reinstalls the exact pinned easy item on consecutive process relaunches", () => {
    const midEasy = {
      ...serverEpisode(),
      flow: {
        stage: "easy" as const,
        repair: "done" as const,
        coachUsed: false,
        fresh: { correct: false, assisted: false, verified: true },
        easy: "requested" as const,
      },
    };

    for (const relaunch of [1, 2]) {
      const hydrated = practiceReduce(start(), breakerHydrationEvent(midEasy));
      expect(hydrated.commands).toEqual([
        {
          kind: "serveBreakerEasy",
          id: "breaker:attempt-9:easy",
          domain: "breaker-lifecycle:attempt-9",
          triggerAttemptId: "attempt-9",
          expectedItemId: "item-easy-3",
        },
      ]);

      const installed = practiceReduce(hydrated.state, {
        type: "server:breakerEasyServed",
        id: "breaker:attempt-9:easy",
        itemId: "item-easy-3",
      });
      expect(installed.state.item, `relaunch ${relaunch}`).toMatchObject({
        itemId: "item-easy-3",
        phase: { kind: "answering" },
        hasRecorded: false,
      });
      expect(installed.state.breaker?.easyItemId).toBe("item-easy-3");
      expect(installed.commands).toEqual([]);

      const duplicate = practiceReduce(installed.state, {
        type: "server:breakerEasyServed",
        id: "breaker:attempt-9:easy",
        itemId: "item-easy-3",
      });
      expect(duplicate.state).toStrictEqual(installed.state);
      expect(duplicate.commands).toEqual([]);
    }
  });

  it("fails closed when a reconstructed easy item does not match the server pin", () => {
    const midEasy = {
      ...serverEpisode(),
      flow: {
        stage: "easy" as const,
        repair: "done" as const,
        coachUsed: true,
        fresh: { correct: false, assisted: false, verified: true },
        easy: "requested" as const,
      },
    };
    const hydrated = practiceReduce(start(), breakerHydrationEvent(midEasy));
    const mismatch = practiceReduce(hydrated.state, {
      type: "server:breakerEasyServed",
      id: "breaker:attempt-9:easy",
      itemId: "item-other",
    });
    expect(mismatch.state).toBe(hydrated.state);
    expect(mismatch.commands).toEqual([]);
  });
});

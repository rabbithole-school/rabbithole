import { describe, expect, test } from "vitest";
import {
  OBSERVER_DEBOUNCE_CANCEL_GRACE_MS,
  OBSERVER_DEBOUNCE_IDLE_MS,
  OBSERVER_DEBOUNCE_MAX_WAIT_MS,
  planObserverRun,
  resolveObservationEvidenceTime,
  type PendingObserverRun,
} from "../lib/observerShared";

/**
 * The two pure decisions behind the observer's memory of its own cadence:
 *
 * - `planObserverRun` (TRA-152): what a new assistant turn does to the one
 *   pending observer job a session keeps — push it out, leave it, or open a new
 *   window. The starvation cap is the roster pulse's trend floor, not cost.
 * - `resolveObservationEvidenceTime` (TRA-101): when a mastery observation's
 *   evidence actually happened, so a re-derivation of a days-old turn is dated
 *   by the turn and not by the run that re-read it.
 */

const T0 = 1_800_000_000_000;
const SEC = 1000;

describe("planObserverRun", () => {
  test("no pending job → opens a window at now + idle", () => {
    expect(planObserverRun(T0, null)).toEqual({
      kind: "schedule",
      runAt: T0 + OBSERVER_DEBOUNCE_IDLE_MS,
      since: T0,
      cancelJobId: null,
    });
  });

  test.each<PendingObserverRun["state"]>([
    "inProgress",
    "success",
    "failed",
    "canceled",
    "missing",
  ])("a %s job will not read this turn → opens a NEW window", (state) => {
    const pending: PendingObserverRun = {
      jobId: "job-old",
      since: T0 - 100 * SEC,
      state,
      scheduledTime: T0 - 40 * SEC,
    };
    const plan = planObserverRun(T0, pending);
    expect(plan).toEqual({
      kind: "schedule",
      runAt: T0 + OBSERVER_DEBOUNCE_IDLE_MS,
      since: T0,
      cancelJobId: null,
    });
  });

  test.each([
    ["overdue (scheduler lag)", -5 * SEC],
    ["due right now", 0],
    ["due inside the cancel grace", OBSERVER_DEBOUNCE_CANCEL_GRACE_MS - 1],
  ])(
    "a pending job that is %s is left alone — it may already be claimed",
    (_label, offset) => {
      const pending: PendingObserverRun = {
        jobId: "job-due",
        since: T0 - 65 * SEC,
        state: "pending",
        scheduledTime: T0 + offset,
      };
      expect(planObserverRun(T0, pending)).toEqual({ kind: "leave" });
    },
  );

  test("a pending job just past the cancel grace is still pushed out", () => {
    const pending: PendingObserverRun = {
      jobId: "job-soon",
      since: T0 - 30 * SEC,
      state: "pending",
      scheduledTime: T0 + OBSERVER_DEBOUNCE_CANCEL_GRACE_MS + 1,
    };
    expect(planObserverRun(T0, pending)).toEqual({
      kind: "schedule",
      runAt: T0 + OBSERVER_DEBOUNCE_IDLE_MS,
      since: T0 - 30 * SEC,
      cancelJobId: "job-soon",
    });
  });

  test("a pending job inside the idle window is pushed out (trailing edge)", () => {
    const pending: PendingObserverRun = {
      jobId: "job-1",
      since: T0,
      state: "pending",
      scheduledTime: T0 + OBSERVER_DEBOUNCE_IDLE_MS,
    };
    const now = T0 + 20 * SEC;
    expect(planObserverRun(now, pending)).toEqual({
      kind: "schedule",
      runAt: now + OBSERVER_DEBOUNCE_IDLE_MS,
      since: T0,
      cancelJobId: "job-1",
    });
  });

  test("the window keeps its original `since` across a whole burst", () => {
    let pending: PendingObserverRun | null = null;
    let jobs = 0;
    for (const offset of [0, 20, 40, 55]) {
      const now = T0 + offset * SEC;
      const plan = planObserverRun(now, pending);
      expect(plan.kind).toBe("schedule");
      if (plan.kind !== "schedule") throw new Error("unreachable");
      expect(plan.since).toBe(T0);
      pending = {
        jobId: `job-${++jobs}`,
        since: plan.since,
        state: "pending",
        scheduledTime: plan.runAt,
      };
    }
    expect(pending?.scheduledTime).toBe(T0 + 55 * SEC + OBSERVER_DEBOUNCE_IDLE_MS);
  });

  test("continuous activity never pushes the run past since + max-wait", () => {
    const deadline = T0 + OBSERVER_DEBOUNCE_MAX_WAIT_MS;
    let pending: PendingObserverRun | null = null;
    const runAts: number[] = [];
    for (let offset = 0; offset <= 400; offset += 50) {
      const now = T0 + offset * SEC;
      const plan = planObserverRun(now, pending);
      if (plan.kind === "leave") continue;
      runAts.push(plan.runAt);
      pending = {
        jobId: `job-${runAts.length}`,
        since: plan.since,
        state: "pending",
        scheduledTime: plan.runAt,
      };
    }
    expect(Math.max(...runAts)).toBe(deadline);
    // At t=150 the run is capped to the deadline; the t=200..400 turns leave it.
    expect(runAts).toEqual([
      T0 + 60 * SEC,
      T0 + 110 * SEC,
      T0 + 160 * SEC,
      deadline,
    ]);
  });

  test("a job already due no later than we would schedule is left alone", () => {
    const pending: PendingObserverRun = {
      jobId: "job-1",
      since: T0,
      state: "pending",
      scheduledTime: T0 + OBSERVER_DEBOUNCE_MAX_WAIT_MS,
    };
    // Past the deadline but the job has not fired yet (scheduler lag): it will
    // run imminently and will read this turn. Cancelling it now would race its
    // start.
    expect(
      planObserverRun(T0 + OBSERVER_DEBOUNCE_MAX_WAIT_MS + 5 * SEC, pending),
    ).toEqual({ kind: "leave" });
  });

  test("an undated pending job is still pushed out rather than left", () => {
    const pending: PendingObserverRun = {
      jobId: "job-1",
      since: T0,
      state: "pending",
    };
    const plan = planObserverRun(T0 + 10 * SEC, pending);
    expect(plan.kind).toBe("schedule");
    if (plan.kind !== "schedule") throw new Error("unreachable");
    expect(plan.cancelJobId).toBe("job-1");
  });

  test("the constants are the plan's 60s idle / 180s max-wait", () => {
    // review/observer-cadence-plan.html: the widest setting that still clears
    // rosterPulse's TREND_MIN_POINTS floor inside one class block.
    expect(OBSERVER_DEBOUNCE_IDLE_MS).toBe(60_000);
    expect(OBSERVER_DEBOUNCE_MAX_WAIT_MS).toBe(180_000);
  });
});

describe("resolveObservationEvidenceTime", () => {
  type Turn = {
    id: string;
    sourceRole: string;
    role: string;
    content: string;
    createdAt?: number;
    generatedImage?: boolean;
  };
  const scholar = (id: string, content: string, createdAt?: number): Turn => ({
    id,
    sourceRole: "user",
    role: "user",
    content,
    createdAt,
  });
  const tutor = (id: string, content: string, createdAt?: number): Turn => ({
    id,
    sourceRole: "assistant",
    role: "assistant",
    content,
    createdAt,
  });

  const DAY = 24 * 60 * 60 * SEC;
  /** Invented transcript — no real scholar's words appear in this repo. */
  const history: Turn[] = [
    scholar("m1", "I think the denominator is the number of pieces", T0),
    tutor("m2", "The denominator is the number of pieces — say more?", T0 + 30 * SEC),
    scholar("m3", "so 3/4 means 3 of 4 pieces", T0 + 60 * SEC),
    tutor("m4", "Right. What about 6/8?", T0 + 90 * SEC),
    scholar("m5", "same amount, more pieces", T0 + 2 * DAY),
  ];

  test("a verbatim scholar quote dates the observation by that turn", () => {
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "so 3/4 means 3 of 4 pieces" },
        history,
      ),
    ).toBe(T0 + 60 * SEC);
  });

  test("quote matching is tolerant of quote marks, case and whitespace", () => {
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: '  "So 3/4 means  3 of 4 pieces"' },
        history,
      ),
    ).toBe(T0 + 60 * SEC);
  });

  test("a quote that only appears in a TUTOR turn does not date the evidence", () => {
    // The tutor echoed the scholar's phrase; the SCHOLAR turn that contains it
    // is m1, so the date is m1's — never the tutor's echo at +30s.
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "the denominator is the number of pieces" },
        history,
      ),
    ).toBe(T0);
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "What about 6/8?" },
        history,
      ),
    ).toBeNull();
  });

  test("a recurring short quote takes the NEWEST matching turn unless the model cites one", () => {
    const repeated: Turn[] = [
      scholar("a", "pieces", T0),
      scholar("b", "pieces", T0 + DAY),
    ];
    expect(
      resolveObservationEvidenceTime({ transcriptExcerpt: "pieces" }, repeated),
    ).toBe(T0 + DAY);
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "pieces", sourceMessageId: "[a]" },
        repeated,
      ),
    ).toBe(T0);
  });

  test("sourceMessageId alone dates a paraphrased excerpt", () => {
    expect(
      resolveObservationEvidenceTime(
        {
          transcriptExcerpt: "explained equivalence in their own words",
          sourceMessageId: "m5",
        },
        history,
      ),
    ).toBe(T0 + 2 * DAY);
  });

  test("a sourceMessageId that names a tutor line is ignored", () => {
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "no such words", sourceMessageId: "m4" },
        history,
      ),
    ).toBeNull();
  });

  test("a cited id that contradicts the grounded quote loses to the quote", () => {
    // The excerpt is verbatim from m3; the model cited m5 (a different turn).
    // The verbatim match is the stronger evidence.
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "so 3/4 means 3 of 4 pieces", sourceMessageId: "m5" },
        history,
      ),
    ).toBe(T0 + 60 * SEC);
  });

  test("nothing grounds → null (caller falls back to now, never a guess)", () => {
    expect(
      resolveObservationEvidenceTime({ transcriptExcerpt: "" }, history),
    ).toBeNull();
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "words that appear nowhere" },
        history,
      ),
    ).toBeNull();
    expect(resolveObservationEvidenceTime({}, history)).toBeNull();
  });

  test("an undated turn cannot date evidence", () => {
    const undated: Turn[] = [scholar("x", "an undated remark")];
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "an undated remark", sourceMessageId: "x" },
        undated,
      ),
    ).toBeNull();
  });

  test("a generated-image row mapped to role user never grounds a quote", () => {
    const withImage: Turn[] = [
      { ...scholar("img", "a diagram of pieces", T0), generatedImage: true },
    ];
    expect(
      resolveObservationEvidenceTime(
        { transcriptExcerpt: "a diagram of pieces" },
        withImage,
      ),
    ).toBeNull();
  });
});

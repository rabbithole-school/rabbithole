import { describe, expect, test } from "vitest";
import {
  OBSERVER_TRANSCRIPT_LIMIT,
  alertEvidenceWatermark,
  classifyAlertEvidence,
  observerTranscriptWindow,
  resolveChatAlertRecency,
  resolveChatAlerts,
} from "../lib/observerShared";

/**
 * The recency bound on the observer's conversational alerts.
 *
 * The failure it exists for: a session runs across days while the observer
 * re-reads a fixed transcript window on every run, so a moment from last week
 * stays permanently re-readable and nothing in the alert payload dates it. In
 * prod one session was correctly flagged "going in circles" on day 3; on day 8
 * the same five-day-old turn was re-read and re-raised under a DIFFERENT alert
 * kind, putting a distress card in front of a teacher about a session the
 * scholar had long since recovered in.
 *
 * The bound is a watermark, not a duration: "was this turn already read by the
 * last pass that RAISED an alert?" There is no age threshold anywhere in it,
 * and the mark advances fire-only — a quiet pass never converts "read" into
 * "implicitly cleared". Every ambiguity is resolved toward raising — the gate
 * suppresses only when it can positively show the evidence predates an alert a
 * teacher was actually sent.
 */

const DAY = 24 * 60 * 60 * 1000;
const DAY_3 = 1_000_000_000_000;
const DAY_8 = DAY_3 + 5 * DAY;

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

/** Invented transcript — no real scholar's words appear in this repo. */
const OLD_QUOTE = "i keep getting a different number every time";
const NEW_QUOTE = "oh that actually makes sense now";

const history: Turn[] = [
  scholar("m1", `${OLD_QUOTE} and i don't know which one is right`, DAY_3),
  tutor("m2", "What did you get the first time?", DAY_3 + 60_000),
  scholar("m3", `${NEW_QUOTE}, can i try the next one`, DAY_8),
  tutor("m4", "Go for it.", DAY_8 + 60_000),
];

/** The watermark a day-3 run that RAISED an alert would have left behind. */
const AFTER_DAY_3 = DAY_3 + 60_000;

describe("classifyAlertEvidence", () => {
  test("the prod shape: a quote only the previous run's turns contain is stale", () => {
    expect(
      classifyAlertEvidence({ excerpt: OLD_QUOTE }, history, AFTER_DAY_3),
    ).toBe("stale");
  });

  test("a quote from a turn written since the last pass is fresh", () => {
    expect(
      classifyAlertEvidence({ excerpt: NEW_QUOTE }, history, AFTER_DAY_3),
    ).toBe("fresh");
  });

  test("with no previously RAISED alert nothing can be a repeat", () => {
    // A null/undefined watermark covers two situations that must read the
    // same: no observer pass has run at all, and passes ran but none raised a
    // conversational alert (the mark advances fire-only, so a quiet pass
    // leaves it absent). Either way there is no prior alert for this evidence
    // to be a repeat OF.
    for (const watermark of [null, undefined]) {
      expect(classifyAlertEvidence({ excerpt: OLD_QUOTE }, history, watermark)).toBe(
        "fresh",
      );
    }
  });

  test("the recall-loss shape: quiet passes must not age out an early turn", () => {
    // A spiral that becomes legible only in retrospect: the observer runs
    // after every exchange, sees the day-3 turn each time, and raises nothing
    // — then finally quotes that EARLY, most representative turn. Because none
    // of those quiet passes recorded a watermark, the session still has none,
    // and the early quote is FRESH. (Under every-pass marking each quiet run
    // would have advanced the mark past day 3 and this alert — the first ever
    // raised for the session — would have been suppressed as a "repeat" of an
    // alert that never existed.)
    const quietPassesWatermark = null; // fire-only: raised nothing, wrote nothing
    expect(
      classifyAlertEvidence({ excerpt: OLD_QUOTE }, history, quietPassesWatermark),
    ).toBe("fresh");
    // The same quote against a mark an ACTUAL alert left is still a repeat —
    // fire-only marking narrows suppression to that case alone.
    expect(
      classifyAlertEvidence({ excerpt: OLD_QUOTE }, history, AFTER_DAY_3),
    ).toBe("stale");
  });

  test("a phrase the scholar repeated is fresh on its newest occurrence", () => {
    // The same words said twice are two moments, and the second one is new.
    const repeated: Turn[] = [
      scholar("m1", "i still don't get it", DAY_3),
      scholar("m2", "i still don't get it", DAY_8),
    ];
    expect(
      classifyAlertEvidence({ excerpt: "i still don't get it" }, repeated, AFTER_DAY_3),
    ).toBe("fresh");
  });

  test("a quote no scholar turn contains is undecidable, never stale", () => {
    expect(
      classifyAlertEvidence(
        { excerpt: "something the model paraphrased" },
        history,
        AFTER_DAY_3,
      ),
    ).toBe("ungrounded");
  });

  test("a quote lifted from a TUTOR turn is undecidable, never stale", () => {
    // Only the scholar's own words can substantiate these alerts, so a tutor
    // line grounds nothing — the same rule the signal grounding applies.
    expect(
      classifyAlertEvidence(
        { excerpt: "What did you get the first time?" },
        history,
        AFTER_DAY_3,
      ),
    ).toBe("ungrounded");
  });

  test("a missing or blank quote is undecidable, never stale", () => {
    for (const excerpt of [undefined, "", "   "]) {
      expect(classifyAlertEvidence({ excerpt }, history, AFTER_DAY_3)).toBe(
        "ungrounded",
      );
    }
    expect(classifyAlertEvidence(undefined, history, AFTER_DAY_3)).toBe(
      "ungrounded",
    );
  });

  test("an undateable turn is treated as new — the gate never suppresses on a guess", () => {
    const undated: Turn[] = [scholar("m1", `${OLD_QUOTE} today`)];
    expect(
      classifyAlertEvidence({ excerpt: OLD_QUOTE }, undated, AFTER_DAY_3),
    ).toBe("fresh");
  });

  test("a turn written exactly at the watermark counts as already read", () => {
    const boundary: Turn[] = [scholar("m1", OLD_QUOTE, AFTER_DAY_3)];
    expect(
      classifyAlertEvidence({ excerpt: OLD_QUOTE }, boundary, AFTER_DAY_3),
    ).toBe("stale");
    expect(
      classifyAlertEvidence({ excerpt: OLD_QUOTE }, boundary, AFTER_DAY_3 - 1),
    ).toBe("fresh");
  });

  test("a generated-image row cannot ground a quote", () => {
    // As getSessionContext actually builds them: generated-image rows carry
    // sourceRole "tool" (with the user-role transport), so the scholar-turn
    // filter alone excludes them — no separate generatedImage check needed.
    const withImage: Turn[] = [
      {
        id: "m1",
        sourceRole: "tool",
        role: "user",
        content: OLD_QUOTE,
        createdAt: DAY_3,
        generatedImage: true,
      },
    ];
    expect(
      classifyAlertEvidence({ excerpt: OLD_QUOTE }, withImage, AFTER_DAY_3),
    ).toBe("ungrounded");
  });

  test("smart quotes, case and whitespace do not defeat the match", () => {
    const styled: Turn[] = [
      scholar("m1", "I keep getting a  different number\nevery time", DAY_3),
    ];
    expect(
      classifyAlertEvidence(
        { excerpt: "  “i keep getting a different number every time”  " },
        styled,
        AFTER_DAY_3,
      ),
    ).toBe("stale");
  });
});

describe("alertEvidenceWatermark", () => {
  test("is the newest datable turn in what the observer just read", () => {
    expect(alertEvidenceWatermark(history)).toBe(DAY_8 + 60_000);
  });

  test("ignores undateable turns rather than resetting the mark", () => {
    expect(
      alertEvidenceWatermark([scholar("m1", "a", DAY_3), scholar("m2", "b")]),
    ).toBe(DAY_3);
  });

  test("is null when nothing is datable, so the next run stays unbounded", () => {
    expect(alertEvidenceWatermark([])).toBeNull();
    expect(alertEvidenceWatermark([scholar("m1", "a")])).toBeNull();
  });
});

describe("resolveChatAlertRecency composed with resolveChatAlerts", () => {
  const stuck = {
    severity: "warning" as const,
    summary: "Circling the same step with no progress.",
    excerpt: OLD_QUOTE,
  };
  const overwhelm = {
    severity: "info" as const,
    summary: "Read as an opt-out.",
    excerpt: OLD_QUOTE,
  };

  const raised = (
    result: { stuckAlert?: typeof stuck; overwhelmAlert?: typeof overwhelm },
    watermark: number | null,
  ) => {
    const quoted = resolveChatAlerts(result);
    const recency = resolveChatAlertRecency(result, history, watermark);
    return {
      stuck: quoted.raiseStuck && recency.stuck !== "stale",
      overwhelm: quoted.raiseOverwhelm && recency.overwhelm !== "stale",
    };
  };

  test("day 3: the moment is new, and the alert reaches the teacher", () => {
    expect(raised({ stuckAlert: stuck }, null)).toEqual({
      stuck: true,
      overwhelm: false,
    });
  });

  test("day 8: the same evidence, re-read, no longer reaches the teacher", () => {
    // Both readings of the identical old quote are dropped — including the
    // contradictory relabelling that caused the incident. Neither suppresses
    // the other; the watermark suppresses both, on the same ground.
    expect(
      raised({ stuckAlert: stuck, overwhelmAlert: overwhelm }, AFTER_DAY_3),
    ).toEqual({ stuck: false, overwhelm: false });
  });

  test("a stale alert cannot take a fresh one down with it", () => {
    // Independence, which #3375 established, has to survive the new gate: the
    // two alerts are still judged separately, now on recency as well as quote.
    expect(
      raised(
        {
          stuckAlert: { ...stuck, excerpt: NEW_QUOTE },
          overwhelmAlert: overwhelm,
        },
        AFTER_DAY_3,
      ),
    ).toEqual({ stuck: true, overwhelm: false });
  });

  test("the quote rule still applies on its own — recency cannot revive an unquoted alert", () => {
    expect(
      raised({ stuckAlert: { ...stuck, excerpt: "" } }, AFTER_DAY_3),
    ).toEqual({ stuck: false, overwhelm: false });
  });

  test("an ongoing spiral keeps alerting as long as the scholar keeps saying so", () => {
    // The bound is on the EVIDENCE, not the alert: a scholar still stuck today
    // produces today's words, so the alert survives every run.
    const stillStuck: Turn[] = [
      scholar("m1", OLD_QUOTE, DAY_3),
      scholar("m2", "im still getting different numbers", DAY_8),
    ];
    expect(
      resolveChatAlertRecency(
        { stuckAlert: { ...stuck, excerpt: "im still getting different numbers" } },
        stillStuck,
        AFTER_DAY_3,
      ).stuck,
    ).toBe("fresh");
  });
});

/**
 * The gate may only judge evidence the observer model actually READ.
 *
 * `observer.analyzeSession` sends the model one window — the last
 * `OBSERVER_TRANSCRIPT_LIMIT` turns — and feeds that same array to the recency
 * gate and to the watermark. These tests pin that composition, because the
 * failure they guard against is silent: judged against the FULL history
 * instead, an aged-out turn nobody read this run can supply the "already seen
 * it" proof that suppresses an alert, and the watermark can advance past turns
 * the pass never considered.
 */
describe("the gate reads exactly the window the model read", () => {
  /** A history long enough that its oldest turns fall outside the window. */
  const longHistory = (): Turn[] => {
    const turns: Turn[] = [];
    for (let i = 0; i < OBSERVER_TRANSCRIPT_LIMIT + 6; i++) {
      turns.push(
        i % 2 === 0
          ? scholar(`m${i}`, `filler scholar turn ${i}`, DAY_3 + i * 60_000)
          : tutor(`m${i}`, `filler tutor turn ${i}`, DAY_3 + i * 60_000),
      );
    }
    return turns;
  };

  test("an aged-out turn cannot supply the proof that suppresses a fresh alert", () => {
    // The quote lives ONLY in a turn that scrolled out of the model's window,
    // so this run cannot have taken it from there. The full history says
    // "already read"; the window — the truth about what this pass saw — says
    // "cannot tell", and an undecidable alert is raised.
    const AGED_OUT = "i cant even tell where to start on this";
    const full = longHistory();
    full[0] = scholar("m0", AGED_OUT, DAY_3);
    const window = observerTranscriptWindow(full);

    expect(window).not.toContainEqual(full[0]);
    expect(classifyAlertEvidence({ excerpt: AGED_OUT }, full, AFTER_DAY_3)).toBe(
      "stale",
    );
    expect(classifyAlertEvidence({ excerpt: AGED_OUT }, window, AFTER_DAY_3)).toBe(
      "ungrounded",
    );
  });

  test("a repeat the model could actually see is still caught — windowing loses no true positive", () => {
    // The incident's own shape: the old moment is still INSIDE the window,
    // which is the only reason the model could re-quote it. Still suppressed.
    const REPEATED = "i keep landing on a different answer";
    const full = longHistory();
    const visibleOld = scholar("old-but-visible", REPEATED, DAY_3 + 60_000);
    full[full.length - 4] = visibleOld;
    const window = observerTranscriptWindow(full);

    expect(window).toContainEqual(visibleOld);
    expect(classifyAlertEvidence({ excerpt: REPEATED }, window, AFTER_DAY_3)).toBe(
      "stale",
    );
  });

  test("the watermark records the newest turn the pass READ, never one it skipped", () => {
    // Ascending order is a property of the message query, not of this gate. If
    // history ever arrives out of order, a mark taken from the whole array
    // would jump to a turn outside the window and over-suppress every later run.
    const full = longHistory();
    full[0] = scholar("m0", "an out-of-order straggler", DAY_8 + 10 * DAY);
    const window = observerTranscriptWindow(full);
    const newestRead = Math.max(
      ...window.map((t) => t.createdAt ?? Number.NEGATIVE_INFINITY),
    );

    expect(alertEvidenceWatermark(window)).toBe(newestRead);
    expect(Number(alertEvidenceWatermark(full))).toBeGreaterThan(newestRead);
  });

  test("a short history is its own window, so ordinary sessions are unaffected", () => {
    expect(observerTranscriptWindow(history)).toEqual(history);
  });
});

/**
 * Invented spelling must not read as a different moment.
 *
 * Scholars here type "im" and "dont"; a model quoting them routinely writes
 * "I'm" and "don't". If an apostrophe decided identity, the tidied quote could
 * miss the fresh turn and match only an older tidy one — a false `stale`, and a
 * genuinely-now alert silently dropped.
 */
describe("apostrophes do not decide which moment a quote points at", () => {
  test("a tidied quote matches the scholar's untidied turn", () => {
    const untidy: Turn[] = [scholar("m1", "im stuck and i dont get it", DAY_3)];
    expect(
      classifyAlertEvidence(
        { excerpt: "I'm stuck and I don't get it" },
        untidy,
        AFTER_DAY_3,
      ),
    ).toBe("stale");
  });

  test("and an untidied quote matches a turn that did have the apostrophes", () => {
    const tidy: Turn[] = [scholar("m1", "I'm stuck and I don't get it", DAY_3)];
    expect(
      classifyAlertEvidence(
        { excerpt: "im stuck and i dont get it" },
        tidy,
        AFTER_DAY_3,
      ),
    ).toBe("stale");
  });

  test("the false-stale shape: punctuation must not hide the NEWER occurrence", () => {
    // The same words twice, spelled differently — the older turn tidy, the
    // newer one in the scholar's own invented spelling. The model quotes the
    // tidy form, as it does. Matching only the OLD turn suppresses an alert
    // about a moment that happened after the last pass: the false stale.
    const bothSpellings: Turn[] = [
      scholar("m1", "i can't do this one", DAY_3),
      scholar("m2", "i cant do this one", DAY_8),
    ];
    expect(
      classifyAlertEvidence(
        { excerpt: "I can’t do this one" },
        bothSpellings,
        AFTER_DAY_3,
      ),
    ).toBe("fresh");
  });

  test("dropping apostrophes never matches a turn whose WORDS differ", () => {
    const other: Turn[] = [scholar("m1", "i can do this one", DAY_3)];
    expect(
      classifyAlertEvidence({ excerpt: "i can't do this one" }, other, AFTER_DAY_3),
    ).toBe("ungrounded");
  });

  test("a quote that is nothing but punctuation stays undecidable", () => {
    for (const excerpt of ["'", "’’", "\"'\""]) {
      expect(classifyAlertEvidence({ excerpt }, history, AFTER_DAY_3)).toBe(
        "ungrounded",
      );
    }
  });
});

import { describe, expect, test } from "vitest";
import {
  hasAnyActivity,
  MAX_OVERDUE_QUESTIONS,
  mergeCheckinQuestions,
  OVERDUE_NAME_CAP,
  checkinDateLabel,
  checkinDayKey,
  checkinDayStartMs,
  isCheckinWeekend,
  EOD_CHECKIN_SYSTEM,
  parentMessageText,
  renderEodUserMessage,
  renderMechanicalFallback,
  renderThreadMessage,
  rankEodSignals,
  sanitizeEodSlackText,
  type EodChannelInput,
} from "../eodCheckin";
import { sessionSignalMeta } from "../../../shared/learningSignals";
import {
  SCHOLAR_NAME_PRONOUN_HINT,
  scholarNamePronounHint,
} from "../scholarPronouns";
import {
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  institutionPromptProfile,
} from "../institutionPromptProfile";

function input(
  overrides: Partial<EodChannelInput> = {},
): EodChannelInput {
  return {
    dateLabel: "Monday, July 27",
    groupNames: ["Geckos"],
    scholars: [],
    keyMoments: [],
    scheduled: [],
    overdueHomework: [],
    queuedDigestIds: [],
    queuedDigestLines: [],
    ...overrides,
  };
}

describe("check-in calendar helpers", () => {
  test("uses the institution day across the UTC boundary (Honolulu default)", () => {
    const stillMonday = Date.parse("2026-07-28T02:00:00.000Z");
    const mondayMidnight = Date.parse("2026-07-27T10:00:00.000Z");

    // Default timezone (Pacific/Honolulu) is byte-identical to the old fixed-HST
    // math — the no-regrets invariant for the configured primary channel.
    expect(checkinDayKey(stillMonday)).toBe("2026-07-27");
    expect(checkinDayKey(mondayMidnight)).toBe("2026-07-27");
    expect(checkinDayStartMs(stillMonday)).toBe(mondayMidnight);
    expect(checkinDayStartMs(mondayMidnight)).toBe(mondayMidnight);
    expect(checkinDateLabel(mondayMidnight)).toBe("Monday, July 27");
  });

  test("detects HST weekends when the UTC weekday differs", () => {
    expect(isCheckinWeekend(Date.parse("2026-08-02T05:00:00.000Z"))).toBe(true);
    expect(isCheckinWeekend(Date.parse("2026-08-03T05:00:00.000Z"))).toBe(true);
    expect(isCheckinWeekend(Date.parse("2026-08-04T05:00:00.000Z"))).toBe(
      false,
    );
  });

  test("a second institution's timezone shifts the day window and label", () => {
    // 2026-07-28T02:00Z is still Mon in Honolulu but already Tue in New York.
    const ms = Date.parse("2026-07-28T02:00:00.000Z");
    expect(checkinDayKey(ms, "America/New_York")).toBe("2026-07-27");
    expect(checkinDateLabel(ms, "America/New_York")).toBe("Monday, July 27");
    const laterUtc = Date.parse("2026-07-28T05:00:00.000Z"); // 7pm HST Mon / 1am EDT Tue
    expect(checkinDayKey(laterUtc, "Pacific/Honolulu")).toBe("2026-07-27");
    expect(checkinDayKey(laterUtc, "America/New_York")).toBe("2026-07-28");
  });
});

describe("EOD_CHECKIN_SYSTEM identity", () => {
  test("defaults to the configured primary identity, byte-for-byte", () => {
    const dflt = EOD_CHECKIN_SYSTEM();
    expect(EOD_CHECKIN_SYSTEM(DEFAULT_INSTITUTION_PROMPT_PROFILE)).toBe(dflt);
    expect(dflt).toContain(DEFAULT_INSTITUTION_PROMPT_PROFILE.schoolName);
  });

  test("names a second institution, never the configured primary", () => {
    const prompt = EOD_CHECKIN_SYSTEM(
      institutionPromptProfile({
        name: "Kestrel Academy",
        kind: "school",
        isPrimary: false,
        timeZone: "America/New_York",
      }),
    );
    expect(prompt).toContain(
      "You write Rabbithole's end-of-day note to a teacher at Kestrel Academy.",
    );
  });
});

describe("end-of-day message rendering", () => {
  test("renders the parent message exactly", () => {
    expect(
      parentMessageText(
        "Geckos turned their own expertise into advice a beginner could use.",
        "Monday, July 27",
      ),
    ).toBe(
      "🌅 Geckos turned their own expertise into advice a beginner could use.",
    );
    expect(parentMessageText("", "Monday, July 27")).toBe(
      "🌅 End of day check in for Monday, July 27",
    );
  });

  test("numbers questions and appends the fixed footer", () => {
    expect(renderThreadMessage("A good day.", ["First?", "Second?"])).toBe(
      "A good day.\n\n**Questions for you**\n1. First?\n2. Second?\n\n_Answer here in the thread — I'll record it so today's record stays complete._",
    );
  });

  test("mechanical fallback is non-empty and asks about scheduled gaps", () => {
    const result = renderMechanicalFallback(
      input({
        scholars: [
          {
            name: "Kai",
            scholarUrl: "https://example.test/teacher/scholars/kai",
            pronouns: null,
            sessions: [{ title: "Fractions", unitTitle: "Number Sense" }],
            completions: [],
            deliverables: 0,
            practiceAttempts: 0,
            practiceDistinctSkills: 0,
            observations: [],
            analysesNotes: [],
            signals: [],
          },
        ],
        scheduled: [
          {
            activityTitle: "Fraction Lab",
            scheduledForGroup: "Geckos",
            doneScholarNames: [],
            missingScholarNames: ["Kai"],
          },
        ],
      }),
    );

    expect(result.wrapUp).toContain("Kai");
    expect(result.wrapUp).toContain("1 session");
    expect(result.questions.join("\n")).toContain("Fraction Lab");
    expect(result.questions.join("\n")).toContain("Kai");
    expect(result.questions.at(-1)).toContain("Did I miss anything");
  });

  test("model input includes scholar names, URLs, and queued lines", () => {
    const rendered = renderEodUserMessage(
      input({
        scholars: [
          {
            name: "Lani",
            scholarUrl: "https://example.test/teacher/scholars/lani",
            pronouns: null,
            sessions: [],
            completions: [],
            deliverables: 0,
            practiceAttempts: 0,
            practiceDistinctSkills: 0,
            observations: [],
            analysesNotes: [],
            signals: [],
          },
        ],
        queuedDigestIds: [],
        queuedDigestLines: ["Lani submitted a field sketch"],
      }),
    );

    expect(rendered).toContain("Lani");
    expect(rendered).toContain(
      "https://example.test/teacher/scholars/lani",
    );
    expect(rendered).toContain("Lani submitted a field sketch");
  });

  // Regression: the name-level pronoun hint shipped on the observer only, so
  // this renderer kept handing the model a bare name and the Slack check-in
  // went on guessing a scholar's gender. Assert ADJACENCY (the hint next to the
  // name), not the hint's wording — the constant owns that.
  test("puts the pronoun hint on every line that names a scholar", () => {
    const rendered = renderEodUserMessage(
      input({
        scholars: [
          {
            name: "Lani",
            scholarUrl: "https://example.test/teacher/scholars/lani",
            pronouns: null,
            sessions: [],
            completions: [],
            deliverables: 0,
            practiceAttempts: 0,
            practiceDistinctSkills: 0,
            observations: [],
            analysesNotes: [],
            signals: [],
          },
        ],
        keyMoments: [
          {
            kind: "breakthrough" as const,
            scholarName: "Kai",
            scholarUrl: "https://example.test/teacher/scholars/kai",
            pronouns: null,
            sessionUrl: "https://example.test/scholar/session-1",
            headline: "Found the repeating structure",
            detail: "Explained why the third case follows the same rule.",
          },
        ],
      }),
    );

    expect(rendered).toContain(`## Lani ${SCHOLAR_NAME_PRONOUN_HINT}`);
    expect(rendered).toContain(`scholar: Kai ${SCHOLAR_NAME_PRONOUN_HINT}`);
  });

  test("states recorded pronouns instead of the unknown-case default", () => {
    const rendered = renderEodUserMessage(
      input({
        scholars: [
          {
            name: "Lani",
            pronouns: "they/them",
            scholarUrl: "https://example.test/teacher/scholars/lani",
            sessions: [],
            completions: [],
            deliverables: 0,
            practiceAttempts: 0,
            practiceDistinctSkills: 0,
            observations: [],
            analysesNotes: [],
            signals: [],
          },
        ],
      }),
    );

    expect(rendered).toContain(`## Lani ${scholarNamePronounHint("they/them")}`);
    expect(rendered).not.toContain(SCHOLAR_NAME_PRONOUN_HINT);
  });

  test("renders the signal contract without transcript excerpts", () => {
    const rendered = renderEodUserMessage(
      input({
        scholars: [
          {
            name: "Lani",
            scholarUrl: "https://example.test/teacher/scholars/lani",
            pronouns: null,
            sessions: [],
            completions: [],
            deliverables: 0,
            practiceAttempts: 0,
            practiceDistinctSkills: 0,
            observations: [],
            analysesNotes: [],
            signals: [
              {
                type: "productive_struggle",
                teacherLabel: "Productive struggle",
                description: "Returned to the difficult model",
                intensity: "high",
                pcmDimension: "practice",
                sessionUrl: "https://example.test/sessions/1",
              },
            ],
          },
        ],
      }),
    );
    expect(rendered).toContain(
      "productive_struggle | Productive struggle | high | Returned to the difficult model",
    );
    expect(rendered).toContain("pcmDimension: practice");
    expect(rendered).not.toContain("transcriptExcerpt");
  });

  test("model input and fallback include stored key moments with session links", () => {
    const keyMoments = [
      {
        kind: "breakthrough" as const,
        scholarName: "Kai",
        scholarUrl: "https://example.test/teacher/scholars/kai",
        pronouns: null,
        sessionUrl: "https://example.test/scholar/session-1?remote=kai",
        headline: "Found the repeating structure",
        detail: "Explained why the third case follows the same rule.",
      },
    ];

    const rendered = renderEodUserMessage(input({ keyMoments }));
    expect(rendered).toContain("## Key moments");
    expect(rendered).toContain("Found the repeating structure");
    expect(rendered).toContain(keyMoments[0].sessionUrl);

    const fallback = renderMechanicalFallback(input({ keyMoments }));
    expect(fallback.hook).toBe(
      "Geckos' Rabbithole day is ready to unpack.",
    );
    expect(fallback.wrapUp).toContain("Key moment");
    expect(fallback.wrapUp).toContain(
      `<${keyMoments[0].sessionUrl}|Kai>`,
    );
    expect(fallback.wrapUp).toContain("Found the repeating structure");
  });
});

describe("sanitizeEodSlackText", () => {
  test("keeps same-site links, flattens disguised external links", () => {
    const base = "https://app.example.invalid";
    const text =
      "See <https://app.example.invalid/teacher/scholars/kai|Kai> and <https://evil.example/x|Open Kai's profile>.";
    expect(sanitizeEodSlackText(text, base)).toBe(
      "See <https://app.example.invalid/teacher/scholars/kai|Kai> and Open Kai's profile.",
    );
  });

  test("leaves plain text untouched", () => {
    expect(sanitizeEodSlackText("no links here 1 < 2", "https://x")).toBe(
      "no links here 1 < 2",
    );
  });
});

describe("hasAnyActivity", () => {
  test("is false for an empty day", () => {
    expect(hasAnyActivity(input())).toBe(false);
  });

  describe("EOD session signals", () => {
    test("keeps teacher and scholar wording distinct", () => {
      const meta = sessionSignalMeta("productive_struggle");
      expect(meta?.teacherLabel).toBe("Productive struggle");
      expect(meta?.scholarTitle).toBe("You stay in the struggle");
      expect(meta?.teacherLabel).not.toBe(meta?.scholarTitle);
      expect(sessionSignalMeta("__proto__")).toBeUndefined();
      expect(sessionSignalMeta("toString")).toBeUndefined();
    });

    test("ranks with scoreSignal, breaks ties by recency, and dedupes by type", () => {
      const signals = rankEodSignals([
        {
          signalType: "task_commitment",
          description: "older",
          intensity: "high",
          sessionUrl: "https://example.test/s/old",
          createdAt: 10,
        },
        {
          signalType: "task_commitment",
          description: "newer",
          intensity: "high",
          sessionUrl: "https://example.test/s/new",
          createdAt: 20,
        },
        {
          signalType: "creative_approach",
          description: "creative",
          intensity: "high",
          sessionUrl: "https://example.test/s/creative",
          createdAt: 15,
        },
        {
          signalType: "metacognition",
          description: "thinking",
          intensity: "moderate",
          pcmDimension: "practice",
          sessionUrl: "https://example.test/s/meta",
          createdAt: 12,
        },
      ]);
      expect(signals).toHaveLength(3);
      expect(signals.map((signal) => signal.type)).toEqual([
        "creative_approach",
        "task_commitment",
        "metacognition",
      ]);
      expect(signals[1].description).toBe("newer");
      expect(signals[2].pcmDimension).toBe("practice");
      expect(signals[0]).not.toHaveProperty("transcriptExcerpt");
    });
  });

  test("recognizes scholar activity and queued digest lines", () => {
    const scholar = {
      name: "Kai",
      scholarUrl: "https://example.test/teacher/scholars/kai",
      pronouns: null,
      sessions: [],
      completions: [{ activityTitle: "Fraction Lab" }],
      deliverables: 0,
      practiceAttempts: 0,
      practiceDistinctSkills: 0,
      observations: [],
      analysesNotes: [],
      signals: [],
    };
    expect(hasAnyActivity(input({ scholars: [scholar] }))).toBe(true);
    expect(
      hasAnyActivity(
        input({
          queuedDigestIds: [],
          queuedDigestLines: ["Kai completed a lab"],
        }),
      ),
    ).toBe(true);
    expect(
      hasAnyActivity(
        input({
          keyMoments: [
            {
              kind: "insight",
              scholarName: "Kai",
              scholarUrl: "https://example.test/teacher/scholars/kai",
              pronouns: null,
              sessionUrl: "https://example.test/scholar/session-1?remote=kai",
              headline: "Connected two patterns",
              detail: "Used yesterday's rule in a new case.",
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasAnyActivity(
        input({
          scheduled: [
            {
              activityTitle: "Fraction Lab",
              scheduledForGroup: "Geckos",
              doneScholarNames: [],
              missingScholarNames: ["Kai"],
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("past-due homework questions", () => {
  const BASE = "https://app.example.invalid/teacher/schedule";
  const overdue = (
    activityTitle: string,
    daysPastDue: number,
    scholars: Array<[string, string]>,
  ) => ({
    activityTitle,
    teacherName: "Ms. Fictional",
    earliestDueAt: Date.parse("2026-07-27T00:00:00.000Z") - daysPastDue * 86_400_000,
    duePhrase: `was due ${daysPastDue} days back`,
    incompleteScholars: scholars.map(([name, assignmentId]) => ({
      name,
      assignmentUrl: `${BASE}/${assignmentId}`,
    })),
  });

  test("fallback leads with the oldest past-due items, capped, and keeps today's gaps", () => {
    const result = renderMechanicalFallback(
      input({
        overdueHomework: [
          overdue("Tide Chart", 3, [["Kai", "a1"]]),
          overdue("Read-aloud", 19, [["Mia", "a2"]]),
          overdue("Bird Count", 8, [["Noa", "a3"]]),
        ],
        scheduled: [
          {
            activityTitle: "Fraction Lab",
            scheduledForGroup: "Geckos",
            doneScholarNames: [],
            missingScholarNames: ["Kai"],
          },
        ],
      }),
    );
    expect(MAX_OVERDUE_QUESTIONS).toBe(2);
    expect(result.questions).toHaveLength(4);
    expect(result.questions[0]).toContain(`${BASE}/a2`); // 19 days
    expect(result.questions[1]).toContain(`${BASE}/a3`); // 8 days
    expect(result.questions.join("\n")).not.toContain(`${BASE}/a1`);
    expect(result.questions[2]).toContain("Fraction Lab");
    expect(result.wrapUp).not.toContain("Read-aloud");
  });

  test("a single cohort assignment links once; one-scholar copies link every copy", () => {
    const cohort = renderMechanicalFallback(
      input({
        overdueHomework: [
          overdue("Read-aloud", 5, [
            ["Kai", "cohort"],
            ["Mia", "cohort"],
          ]),
        ],
      }),
    ).questions[0];
    expect(cohort.split(`${BASE}/cohort`)).toHaveLength(2);
    expect(cohort).toContain("Kai");
    expect(cohort).toContain("Mia");

    const copies = renderMechanicalFallback(
      input({
        overdueHomework: [
          overdue("Read-aloud", 5, [
            ["Kai", "copy-kai"],
            ["Mia", "copy-mia"],
          ]),
        ],
      }),
    ).questions[0];
    expect(copies).toContain(`<${BASE}/copy-kai|Kai>`);
    expect(copies).toContain(`<${BASE}/copy-mia|Mia>`);
  });

  test("caps the named scholars and counts the rest", () => {
    const names = Array.from(
      { length: OVERDUE_NAME_CAP + 3 },
      (_, i) => [`Scholar ${i + 1}`, "cohort"] as [string, string],
    );
    const question = renderMechanicalFallback(
      input({ overdueHomework: [overdue("Read-aloud", 5, names)] }),
    ).questions[0];
    expect(question).toContain(`Scholar ${OVERDUE_NAME_CAP} and 3 more`);
    expect(question).not.toContain(`Scholar ${OVERDUE_NAME_CAP + 1}`);
  });

  test("model questions follow the verbatim past-due ones, four at most", () => {
    const withOverdue = input({
      overdueHomework: [overdue("Read-aloud", 5, [["Kai", "a1"]])],
    });
    const merged = mergeCheckinQuestions(withOverdue, [
      "Q1?",
      "Q2?",
      "Q3?",
      "Q4?",
    ]);
    expect(merged).toHaveLength(4);
    expect(merged[0]).toContain(`${BASE}/a1`);
    expect(merged.slice(1)).toEqual(["Q1?", "Q2?", "Q3?"]);
    expect(mergeCheckinQuestions(input(), ["Q1?", "Q2?"])).toEqual([
      "Q1?",
      "Q2?",
    ]);
    // The model sees what was already asked, so it can avoid repeating it.
    expect(renderEodUserMessage(withOverdue)).toContain(`${BASE}/a1`);
  });

  test("past-due homework alone is worth a check-in", () => {
    expect(
      hasAnyActivity(
        input({ overdueHomework: [overdue("Read-aloud", 5, [["Kai", "a1"]])] }),
      ),
    ).toBe(true);
  });
});

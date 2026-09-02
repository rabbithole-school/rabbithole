import { describe, expect, test } from "vitest";
import {
  hasAnyActivity,
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
      "A good day.\n\n*Questions for you*\n1. First?\n2. Second?\n\n_Answer here in the thread — I'll record it so today's record stays complete._",
    );
  });

  test("mechanical fallback is non-empty and asks about scheduled gaps", () => {
    const result = renderMechanicalFallback(
      input({
        scholars: [
          {
            name: "Kai",
            scholarUrl: "https://example.test/teacher/scholars/kai",
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

  test("renders the signal contract without transcript excerpts", () => {
    const rendered = renderEodUserMessage(
      input({
        scholars: [
          {
            name: "Lani",
            scholarUrl: "https://example.test/teacher/scholars/lani",
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
    expect(EOD_CHECKIN_SYSTEM()).toContain(
      "only when its description contains a concrete, observable learner action",
    );
    expect(EOD_CHECKIN_SYSTEM()).toContain(
      "Suggest teacher follow-up only when the evidence warrants it; do not force a follow-up",
    );
    expect(EOD_CHECKIN_SYSTEM()).toContain(
      "never print internal signal types, PCM labels, intensity labels, or permanent trait claims",
    );
    expect(EOD_CHECKIN_SYSTEM()).toContain(
      "must not use grit, gritty, perseverance, persevering, resilience, resilient, persistence, persistent",
    );
  });

  test("model input and fallback include stored key moments with session links", () => {
    const keyMoments = [
      {
        kind: "breakthrough" as const,
        scholarName: "Kai",
        scholarUrl: "https://example.test/teacher/scholars/kai",
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

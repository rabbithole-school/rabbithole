import { describe, expect, it } from "vitest";
import {
  classifyScholarState,
  computeMathSkillsUpdate,
  computePracticeDigest,
  renderScholarNote,
  selectMathSkillsUpdateCohorts,
  type PracticeCohortDigestRow,
  type PracticeScholarDigestRow,
} from "../practiceDigest";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 4, 12, 0, 0); // 2026-07-04 (ISO week 27)

// No competitive / gamified / learner-vs-learner framing anywhere.
const BANNED_FRAMING =
  /\b(ranking?|leaderboards?|behind|ahead|compare|comparison|xp|points?|streaks?|better than|worse than)\b/i;

function scholar(
  over: Partial<PracticeScholarDigestRow> &
    Pick<PracticeScholarDigestRow, "name">,
): PracticeScholarDigestRow {
  return {
    domain: "whole-number-arithmetic",
    username: null,
    needsPlacement: false,
    practicedDays: 0,
    lastPracticedAt: null,
    skillsTurnedFluent: 0,
    turnedFluentLabels: [],
    skillsAdvanced: 0,
    frontierLabels: [],
    dueReviews: 0,
    misconceptionFlags: 0,
    frictionSkillLabel: null,
    frictionMisses: 0,
    topStrand: null,
    ...over,
  };
}

describe("classifyScholarState", () => {
  it("routes each scholar to one salient state", () => {
    expect(classifyScholarState(scholar({ name: "A", needsPlacement: true }))).toBe(
      "not_placed",
    );
    expect(classifyScholarState(scholar({ name: "A", practicedDays: 0 }))).toBe(
      "quiet",
    );
    expect(
      classifyScholarState(
        scholar({ name: "A", practicedDays: 3, skillsTurnedFluent: 2 }),
      ),
    ).toBe("flying");
    expect(
      classifyScholarState(
        scholar({
          name: "A",
          practicedDays: 3,
          skillsTurnedFluent: 1,
          skillsAdvanced: 1,
        }),
      ),
    ).toBe("flying");
    expect(
      classifyScholarState(scholar({ name: "A", practicedDays: 3 })),
    ).toBe("stuck");
    expect(
      classifyScholarState(
        scholar({ name: "A", practicedDays: 2, skillsTurnedFluent: 1 }),
      ),
    ).toBe("steady");
  });
});

describe("renderScholarNote", () => {
  it("names the wins and the current frontier for a fast week", () => {
    const note = renderScholarNote(
      scholar({
        name: "Amara Okafor",
        practicedDays: 3,
        skillsTurnedFluent: 1,
        turnedFluentLabels: ["count to 10"],
        skillsAdvanced: 1,
        frontierLabels: ["count to 20"],
        dueReviews: 3,
        topStrand: "counting",
      }),
      NOW,
    );

    expect(note).toContain("🚀 *Amara Okafor*");
    expect(note).toContain("practiced 3 of 7 days");
    expect(note).toContain("confirmed *count to 10* fluent");
    expect(note).toContain("moved the frontier forward");
    expect(note).toContain("at the edge on *count to 20*");
    expect(note).toContain("_counting_");
    expect(note).toContain("3 reviews have since come due");
    expect(note).not.toMatch(BANNED_FRAMING);
  });

  it("says how long a quiet scholar has been away", () => {
    const note = renderScholarNote(
      scholar({
        name: "Ben Tran",
        practicedDays: 0,
        lastPracticedAt: NOW - 4 * DAY_MS,
        frontierLabels: ["skip-counting by 2"],
      }),
      NOW,
    );

    expect(note).toContain("💤 *Ben Tran* was quiet this week");
    expect(note).toContain("last practiced 4 days ago");
    expect(note).toContain("Still at the edge on *skip-counting by 2*");
    expect(note).not.toMatch(BANNED_FRAMING);
  });

  it("flags the friction skill for a stuck scholar", () => {
    const note = renderScholarNote(
      scholar({
        name: "Cleo Marsh",
        practicedDays: 4,
        frontierLabels: ["regroup in subtraction"],
        frictionSkillLabel: "regroup in subtraction",
        frictionMisses: 6,
      }),
      NOW,
    );

    expect(note).toContain("🌀 *Cleo Marsh*");
    expect(note).toContain("nothing has crossed into fluent yet");
    expect(note).toContain("friction is on *regroup in subtraction*");
    expect(note).toContain("6 missed attempts");
    expect(note).toContain("Worth a check-in");
    expect(note).not.toMatch(BANNED_FRAMING);
  });

  it("points to placement for an unplaced scholar", () => {
    const note = renderScholarNote(
      scholar({ name: "Dev Rao", needsPlacement: true }),
      NOW,
    );
    expect(note).toContain("🌱 *Dev Rao*");
    expect(note).toContain("hasn't taken a placement yet");
    expect(note).toContain("unblocker");
  });
});

describe("computePracticeDigest", () => {
  it("renders a calm narrative roll-up without competitive framing", () => {
    const cohorts: PracticeCohortDigestRow[] = [
      {
        title: "Seals — daily math",
        teacherName: "Malia Reyes",
        dailyGoalMinutes: 15,
        scholars: [
          scholar({
            name: "Lani Kahale",
            username: "lani_kahale",
            practicedDays: 4,
            skillsTurnedFluent: 2,
            turnedFluentLabels: ["add within 10", "add within 20"],
            skillsAdvanced: 1,
            frontierLabels: ["subtract within 20"],
            dueReviews: 1,
            misconceptionFlags: 1,
          }),
          scholar({
            name: "Kai Kahale",
            username: "kai_kahale",
            needsPlacement: true,
          }),
        ],
      },
    ];

    const digest = computePracticeDigest({ now: NOW, cohorts });

    expect(digest.text).toContain("🧭 *Practice Portrait — week of 2026-W27*");
    expect(digest.text).toContain("measured only against their own record");
    expect(digest.text).toContain(
      "Across 1 practice cohort: 1 of 2 scholars practiced this week.",
    );
    expect(digest.text).toContain(
      "• _whole number arithmetic_ · 🌱 *Kai Kahale*",
    );
    // Cohort headline is a plain-language state mix.
    expect(digest.text).toContain("1 of 2 scholars practiced this week");
    expect(digest.text).toContain("1 moving fast");
    expect(digest.text).toContain("1 still to place");

    // Rolled-up totals still available for callers.
    expect(digest.cohortCount).toBe(1);
    expect(digest.scholarCount).toBe(2);
    expect(digest.skillsTurnedFluent).toBe(2);
    expect(digest.needsPlacementCount).toBe(1);

    // Scholar bullets are alphabetical, not ordered by any performance counter.
    expect(digest.text.indexOf("*Kai Kahale*")).toBeLessThan(
      digest.text.indexOf("*Lani Kahale*"),
    );
    expect(digest.text).not.toMatch(BANNED_FRAMING);
  });

  describe("computeMathSkillsUpdate", () => {
    it("prefers explicit math cohorts and otherwise falls back to primary rosters", () => {
      const primary = { title: "Primary", scholars: [] };
      const math = { title: "Math", subjectKey: "math", scholars: [] };
      const robotics = { title: "Robotics", subjectKey: "robotics", scholars: [] };

      expect(selectMathSkillsUpdateCohorts([primary, math, robotics])).toEqual([
        math,
      ]);
      expect(selectMathSkillsUpdateCohorts([primary, robotics])).toEqual([
        primary,
      ]);
    });

    it("renders the intervention ladder with strong cohort hierarchy and generated nuance", () => {
      const update = computeMathSkillsUpdate({
        now: NOW,
        cohorts: [
          {
            title: "Geckos",
            subjectKey: "math",
            scholars: [
              scholar({
                name: "Avery <Admin>",
                practiceCount: 12,
                mathPracticeCount: 12,
                practicedDays: 4,
                skillsTurnedFluent: 1,
                turnedFluentLabels: ["Adding fractions & mixed numbers"],
                skillsAdvanced: 1,
                frontierLabels: ["Long division", "Decimal place value"],
                priorityTopics: [
                  {
                    domain: "whole-number-arithmetic",
                    nodeKey: "grouping",
                    label: "Order of operations & grouping",
                    tier: "sustained",
                    pattern: "REVERSED_OPERANDS",
                    patternDescription:
                      "Order of the operation isn't yet anchored.",
                    attemptCount: 7,
                    missCount: 5,
                    correctCount: 2,
                    missSittingCount: 3,
                    dayCount: 2,
                    dayLabels: ["Tuesday", "Thursday"],
                    latestAttemptCorrect: false,
                    trailingCorrectCount: 0,
                    breakerCount: 1,
                    missExamples: [],
                    reason:
                      "5 misses in 7 attempts across 3 sittings; latest attempt was missed",
                    narrative:
                      "The same operation-order move resurfaced in later practice.",
                    link: "https://example.test/teacher/math-skills?node=grouping",
                  },
                  {
                    domain: "fraction-arithmetic",
                    nodeKey: "equivalent-fractions",
                    label: "Equivalent fractions",
                    tier: "acute",
                    attemptCount: 4,
                    missCount: 3,
                    correctCount: 1,
                    missSittingCount: 1,
                    dayCount: 1,
                    dayLabels: ["Thursday"],
                    latestAttemptCorrect: true,
                    trailingCorrectCount: 1,
                    breakerCount: 1,
                    missExamples: [],
                    reason:
                      "3 misses in 4 attempts; the practice brake stepped in; finished with 1 correct attempt",
                  },
                  {
                    domain: "whole-number-arithmetic",
                    nodeKey: "rounding",
                    label: "Rounding",
                    tier: "practice",
                    attemptCount: 3,
                    missCount: 2,
                    correctCount: 1,
                    missSittingCount: 1,
                    dayCount: 1,
                    dayLabels: ["Monday"],
                    latestAttemptCorrect: false,
                    trailingCorrectCount: 0,
                    breakerCount: 0,
                    missExamples: [],
                    reason:
                      "2 misses in 3 attempts in one sitting; latest attempt was missed",
                  },
                ],
              }),
              scholar({
                name: "Active, no repeated topic",
                practiceCount: 4,
                mathPracticeCount: 4,
                mathMissCount: 1,
                priorityTopics: [],
              }),
            ],
          },
        ],
      });

      expect(update).toMatchObject({
        cohortCount: 1,
        scholarCount: 1,
        topicCount: 3,
      });
      expect(update.text).toContain("*👥 Geckos*");
      // The cohort's genuine wins are visible, not only the worklist.
      expect(update.text).toContain(
        "_Wins this week: 1 skill crossed into fluent and 1 frontier move._",
      );
      expect(update.text).toContain("• *Avery &lt;Admin&gt;*");
      // Each flagged scholar's misses sit inside their own week.
      expect(update.text).toContain(
        "This week: practiced 4 of 7 days, confirmed *Adding fractions &amp; mixed numbers* fluent, moved the frontier forward and now at the edge on *Long division* (and 1 more at the edge).",
      );
      expect(update.text).toContain(
        "Each scholar's own week first, then the topics worth a 1:1",
      );
      expect(update.text).toContain(
        "🔴 [Order of operations &amp; grouping](https://example.test/teacher/math-skills?node=grouping) — missed 5 of 7, 3 sittings",
      );
      expect(update.text).toContain(
        "🟠 *Equivalent fractions* — missed 3 of 4, 1 sitting",
      );
      expect(update.text).toContain("*Rounding* — missed 2 of 3, 1 sitting");
      expect(update.text).toContain("Due reviews are automatic");
      expect(update.text).not.toMatch(/`(?:ERROR|WARN|INFO)`|🧗/);
      expect(update.text).not.toContain(
        "The same operation-order move resurfaced in later practice.",
      );
      expect(update.threadText).toContain(
        "*Geckos · Avery &lt;Admin&gt;*",
      );
      expect(update.threadText).toContain(
        "• [Order of operations &amp; grouping](https://example.test/teacher/math-skills?node=grouping) — The same operation-order move resurfaced in later practice.",
      );
      expect(update.text).toContain(
        "Also practiced this week, with nothing repeating enough to queue: Active, no repeated topic.",
      );
      expect(update.text).not.toMatch(BANNED_FRAMING);
    });

    it("omits the week context for a flagged scholar with nothing to show", () => {
      const update = computeMathSkillsUpdate({
        now: NOW,
        cohorts: [
          {
            title: "Geckos",
            subjectKey: "math",
            scholars: [
              scholar({
                name: "No wins",
                practiceCount: 3,
                mathPracticeCount: 3,
                practicedDays: 0,
                priorityTopics: [
                  {
                    domain: "whole-number-arithmetic",
                    nodeKey: "rounding",
                    label: "Rounding",
                    tier: "practice",
                    attemptCount: 3,
                    missCount: 2,
                    correctCount: 1,
                    missSittingCount: 1,
                    dayCount: 1,
                    dayLabels: ["Monday"],
                    latestAttemptCorrect: false,
                    trailingCorrectCount: 0,
                    breakerCount: 0,
                    missExamples: [],
                    reason: "2 misses in 3 attempts in one sitting",
                  },
                ],
              }),
            ],
          },
        ],
      });

      expect(update.text).not.toContain("This week:");
      expect(update.text).not.toContain("Wins this week");
      expect(update.text).toContain("*Rounding* — missed 2 of 3, 1 sitting");
      expect(update.text).not.toMatch(BANNED_FRAMING);
    });

    it("keeps the week context honest when only some signals exist", () => {
      const update = computeMathSkillsUpdate({
        now: NOW,
        cohorts: [
          {
            title: "Geckos",
            subjectKey: "math",
            scholars: [
              scholar({
                name: "Edge only",
                practiceCount: 3,
                mathPracticeCount: 3,
                practicedDays: 2,
                frontierLabels: ["Long division"],
                priorityTopics: [
                  {
                    domain: "whole-number-arithmetic",
                    nodeKey: "rounding",
                    label: "Rounding",
                    tier: "practice",
                    attemptCount: 3,
                    missCount: 2,
                    correctCount: 1,
                    missSittingCount: 1,
                    dayCount: 1,
                    dayLabels: ["Monday"],
                    latestAttemptCorrect: false,
                    trailingCorrectCount: 0,
                    breakerCount: 0,
                    missExamples: [],
                    reason: "2 misses in 3 attempts in one sitting",
                  },
                ],
              }),
            ],
          },
        ],
      });

      expect(update.text).toContain(
        "This week: practiced 2 of 7 days and now at the edge on *Long division*.",
      );
      // No fabricated fluency claim, and no cohort wins line without crossings.
      expect(update.text).not.toContain("confirmed");
      expect(update.text).not.toContain("Wins this week");
      expect(update.text).not.toMatch(BANNED_FRAMING);
    });

    it("does not invent priorities when no evidence-backed topic exists", () => {
      const update = computeMathSkillsUpdate({
        now: NOW,
        cohorts: [
          {
            title: "Math",
            scholars: [
              scholar({
                name: "Quiet",
                practiceCount: 2,
                mathPracticeCount: 2,
                mathMissCount: 1,
              }),
            ],
          },
        ],
      });

      expect(update.scholarCount).toBe(0);
      expect(update.topicCount).toBe(0);
      expect(update.threadText).toBe("");
      expect(update.text).toContain(
        "1 scholar practiced math this week, but no skill was missed at least twice",
      );
    });

    it("distinguishes no math practice from a fully correct practice week", () => {
      const noPractice = computeMathSkillsUpdate({
        now: NOW,
        cohorts: [
          {
            title: "Math",
            scholars: [scholar({ name: "Quiet" })],
          },
        ],
      });
      expect(noPractice.text).toContain(
        "No math practice was recorded this week.",
      );

      const noMisses = computeMathSkillsUpdate({
        now: NOW,
        cohorts: [
          {
            title: "Math",
            scholars: [
              scholar({
                name: "Accurate",
                practiceCount: 2,
                mathPracticeCount: 2,
                mathMissCount: 0,
              }),
            ],
          },
        ],
      });
      expect(noMisses.text).toContain(
        "1 scholar practiced math this week, with no missed attempts.",
      );
    });
  });

  it("handles no active cohorts", () => {
    const digest = computePracticeDigest({ now: NOW, cohorts: [] });

    expect(digest.cohortCount).toBe(0);
    expect(digest.scholarCount).toBe(0);
    expect(digest.text).toContain(
      "No practice cohorts were found this week.",
    );
    expect(digest.text).not.toMatch(BANNED_FRAMING);
  });

  it("handles an empty rostered cohort without inventing practice data", () => {
    const digest = computePracticeDigest({
      now: NOW,
      cohorts: [
        {
          title: "Honu — daily math",
          teacherName: "Malia Reyes",
          scholars: [],
        },
      ],
    });

    expect(digest.cohortCount).toBe(0);
    expect(digest.scholarCount).toBe(0);
    expect(digest.text).toContain(
      "No scholars had practice to narrate this week.",
    );
    expect(digest.text).toContain("*Honu — daily math*");
    expect(digest.text).toContain("No scholars in this cohort yet.");
    expect(digest.text).not.toMatch(BANNED_FRAMING);
  });

  it("renders a navigable elsewhere reference without repeating the subject-cohort narrative", () => {
    const digest = computePracticeDigest({
      now: NOW,
      cohorts: [
        {
          title: "Geckos",
          scholars: [],
          elsewhere: [
            {
              name: "Kai Kahale",
              subject: "Carl's Math",
              count: 4,
              link: "https://app.example.invalid/teacher/scholars?group=math-group",
            },
          ],
        },
      ],
    });

    expect(digest.text).toContain(
      "↳ *Kai Kahale* — practiced 4× in [Carl's Math](https://app.example.invalid/teacher/scholars?group=math-group)",
    );
    expect(digest.text).not.toContain("whole number arithmetic");
    expect(digest.text).not.toContain("Working on");
  });

  it("omits zero-count elsewhere references", () => {
    const digest = computePracticeDigest({
      now: NOW,
      cohorts: [
        {
          title: "Geckos",
          scholars: [scholar({ name: "Kai Kahale" })],
          elsewhere: [
            {
              name: "Kai Kahale",
              subject: "Carl's Math",
              count: 0,
              link: "https://app.example.invalid/teacher/scholars?group=math-group",
            },
          ],
        },
      ],
    });

    expect(digest.text).not.toContain("↳");
  });
});

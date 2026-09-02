import { describe, expect, it } from "vitest";

import { academicRowDetail, selRowDetail } from "../roundsRowDetail";
import { WEEK_OBSERVATION_CAP, type RoundsEvidenceInput } from "../roundsEvidence";
import type { SelSynthesisRow } from "../selSynthesisView";

function evidence(over: Partial<RoundsEvidenceInput> = {}): RoundsEvidenceInput {
  return {
    observations: over.observations ?? [],
    mastery: over.mastery ?? [],
    practice: over.practice ?? { attempts: 0, correct: 0, nodes: 0, lastAttemptAt: null },
    pulse: over.pulse ?? null,
  };
}

function obs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    _id: `o${i}`,
    type: "note",
    note: `note ${i}`,
    weight: "minor" as const,
    at: 1_000 + i,
    teacherName: "Lehua Torres",
  }));
}

function synthesis(over: Partial<SelSynthesisRow> = {}): SelSynthesisRow {
  return {
    strengths: over.strengths ?? [],
    watch: over.watch ?? [],
    quiet: over.quiet ?? false,
    generatedAt: over.generatedAt ?? 1_000,
  };
}

const claim = (text: string) => ({ text, cites: [] });

describe("academicRowDetail", () => {
  it("summarises how much evidence the week carried, in one muted chip", () => {
    const chips = academicRowDetail(
      evidence({
        observations: obs(3),
        mastery: [
          {
            _id: "m1",
            conceptLabel: "Fractions",
            domain: "math",
            masteryLevel: 3,
            evidenceType: null,
            observedAt: 2_000,
          },
        ],
        practice: { attempts: 12, correct: 9, nodes: 4, lastAttemptAt: 2_000 },
        pulse: {
          latestSummary: null,
          latestSummaryAt: null,
          latestIntervention: null,
          analyzedSessions: 2,
          sampleCount: 2,
        },
      }),
      0,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].tone).toBe("muted");
    expect(chips[0].text).toBe("3 notes · 2 sessions · mastery · practice");
  });

  it("adds a green guidance chip when standing guidance is running", () => {
    const chips = academicRowDetail(evidence({ observations: obs(1) }), 2);
    expect(chips.map((c) => c.text)).toEqual(["1 note", "2 guidance running"]);
    expect(chips[1].tone).toBe("guidance");
  });

  it("renders no evidence chip for a genuinely silent week", () => {
    // The muted 'no evidence this week' headline already says it.
    expect(academicRowDetail(evidence(), 0)).toEqual([]);
  });

  it("still flags guidance on an otherwise silent week", () => {
    const chips = academicRowDetail(evidence(), 1);
    expect(chips).toEqual([
      { key: "guidance", text: "1 guidance running", tone: "guidance" },
    ]);
  });

  it("counts an observer summary with no analysed sessions as 'observer'", () => {
    const chips = academicRowDetail(
      evidence({
        pulse: {
          latestSummary: "Working through place value.",
          latestSummaryAt: 2_000,
          latestIntervention: null,
          analyzedSessions: 0,
          sampleCount: 0,
        },
      }),
      0,
    );
    expect(chips[0].text).toBe("observer");
  });

  it("marks a capped observation count with a trailing +", () => {
    const chips = academicRowDetail(
      evidence({ observations: obs(WEEK_OBSERVATION_CAP) }),
      0,
    );
    expect(chips[0].text).toBe(`${WEEK_OBSERVATION_CAP}+ notes`);
  });
});

describe("selRowDetail", () => {
  it("carries the synthesis shape and the teacher-record size, all muted", () => {
    const chips = selRowDetail(
      synthesis({
        strengths: [claim("Kind to a new scholar")],
        watch: [claim("Quieter in group work"), claim("Rushing to finish")],
      }),
      3,
      0,
    );
    expect(chips.map((c) => [c.text, c.tone])).toEqual([
      ["1 strength · 2 to watch", "muted"],
      ["3 teacher notes", "muted"],
    ]);
  });

  it("puts guidance last and green, alongside the charcoal SEL chips", () => {
    const chips = selRowDetail(
      synthesis({ strengths: [claim("a")], watch: [] }),
      1,
      2,
    );
    expect(chips.map((c) => c.text)).toEqual([
      "1 strength",
      "1 teacher note",
      "2 guidance running",
    ]);
    expect(chips.at(-1)?.tone).toBe("guidance");
  });

  it("shows no synthesis chip for a quiet week", () => {
    expect(selRowDetail(synthesis({ quiet: true }), 0, 0)).toEqual([]);
  });

  it("shows no synthesis chip when nothing is written yet", () => {
    // The headline already reads 'not written yet'.
    expect(selRowDetail(null, 0, 0)).toEqual([]);
  });
});

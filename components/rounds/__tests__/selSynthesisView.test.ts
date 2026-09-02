import { describe, expect, test } from "vitest";

import {
  selRowHeadline,
  selTeacherRecord,
  type SelRecordObservation,
  type SelSynthesisRow,
} from "../selSynthesisView";

function claim(text: string) {
  return { text, cites: [{ kind: "sessionSignal" as const, id: "x", label: "persistence", at: 0 }] };
}

function synthesis(over: Partial<SelSynthesisRow>): SelSynthesisRow {
  return { strengths: [], watch: [], quiet: false, generatedAt: 0, ...over };
}

describe("selRowHeadline", () => {
  test("shows the first strength when the synthesis has one", () => {
    expect(
      selRowHeadline(synthesis({ strengths: [claim("Stayed with the problem")] }), false),
    ).toEqual({ text: "Stayed with the problem", quiet: false });
  });

  test("falls back to the first watch item when there are no strengths", () => {
    expect(
      selRowHeadline(synthesis({ watch: [claim("Ended two sessions abruptly")] }), false),
    ).toEqual({ text: "Ended two sessions abruptly", quiet: false });
  });

  test("a quiet synthesis reads as a muted quiet week", () => {
    expect(selRowHeadline(synthesis({ quiet: true }), false)).toEqual({
      text: "quiet week",
      quiet: true,
    });
  });

  test("an evidence-empty synthesis still reads as a quiet week, not blank", () => {
    expect(selRowHeadline(synthesis({}), false)).toEqual({
      text: "quiet week",
      quiet: true,
    });
  });

  test("a missing synthesis reads as not-written, or a placeholder while loading", () => {
    expect(selRowHeadline(null, false)).toEqual({ text: "not written yet", quiet: true });
    expect(selRowHeadline(null, true)).toEqual({ text: "…", quiet: true });
  });
});

describe("selTeacherRecord", () => {
  const rows: SelRecordObservation[] = [
    { _id: "a", type: "praise", note: "nice", category: "socialEmotional", at: 1, teacherName: "A" },
    { _id: "b", type: "concern", note: "watch", category: null, at: 2, teacherName: "B" },
    { _id: "c", type: "intervention", note: "did x", category: null, at: 3, teacherName: "C" },
    { _id: "d", type: "praise", note: "generic", category: null, at: 4, teacherName: "D" },
    { _id: "e", type: "note", note: "tagged note", category: "execFunction", at: 5, teacherName: "E" },
  ];

  test("keeps category-tagged rows plus concern/intervention, and drops untagged praise", () => {
    expect(selTeacherRecord(rows).map((o) => o._id)).toEqual(["a", "b", "c", "e"]);
  });

  test("an empty record stays empty", () => {
    expect(selTeacherRecord([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  gradeValue,
  honoluluWeekStart,
  missedUnits,
  readAloudText,
  spokenShareText,
  tallyReadAloud,
  tutorRepliesText,
  validTalkJudgment,
  WEEK_MS,
} from "../levelEvidence";

describe("gradeValue", () => {
  it("puts K a full grade below grade 1 and reads any spelling of a grade", () => {
    expect(gradeValue("K")).toBe(0);
    expect(gradeValue("1")).toBe(1);
    expect(gradeValue("Grade 3.4")).toBe(3.4);
    expect(gradeValue("college")).toBe(13);
    expect(gradeValue("advanced")).toBeNull();
    expect(gradeValue(null)).toBeNull();
  });
});

describe("tutorRepliesText", () => {
  it("reads on target within a grade of the talk level, and says how far off otherwise", () => {
    expect(tutorRepliesText(2.3, "2")).toBe("Tutor's replies: grade 2.3, on target");
    expect(tutorRepliesText(4.5, "2")).toBe(
      "Tutor's replies: grade 4.5, 2.5 grades above the talk level",
    );
    expect(tutorRepliesText(0.4, "2")).toContain("below the talk level");
    expect(tutorRepliesText(3.1, null)).toBe("Tutor's replies: grade 3.1");
  });
});

describe("missedUnits", () => {
  it("names the spelling a substitution got wrong, using the scholar's own teams", () => {
    expect(missedUnits("ship", "sip", ["sh", "ck"])).toEqual(["sh"]);
    expect(missedUnits("pig", "big", [])).toEqual(["p"]);
    // Without "sh" as a known team the word splits into letters.
    expect(missedUnits("ship", "sip", [])).toEqual(["h"]);
  });

  it("says nothing about a word that was not heard at all", () => {
    expect(missedUnits("nap", undefined, [])).toEqual([]);
  });
});

describe("the read-aloud tally", () => {
  const row = (over: Partial<Parameters<typeof tallyReadAloud>[0][number]> = {}) => ({
    at: 0,
    words: 4,
    matched: 4,
    attempted: true,
    missedUnits: [] as string[],
    ...over,
  });

  it("counts accuracy over tried lines and names spellings missed twice or more", () => {
    const tally = tallyReadAloud([
      row({ matched: 3, missedUnits: ["sh"] }),
      row({ matched: 3, missedUnits: ["sh", "th"] }),
      row({ matched: 4 }),
      row({ attempted: false, matched: 0 }),
    ]);
    expect(tally).toEqual({ lines: 3, notTried: 1, words: 12, matched: 10, oftenMissed: ["sh"] });
    expect(readAloudText(tally)).toBe(
      "Read-aloud: 3 lines in the last 7 days, 83% of words right · 1 not tried · often misses sh",
    );
  });

  it("is hidden with nothing read", () => {
    expect(readAloudText(tallyReadAloud([]))).toBeNull();
  });
});

describe("spokenShareText", () => {
  it("states the spoken share, and nothing without turns", () => {
    expect(spokenShareText(47, 3)).toBe("94% spoken in the last 2 weeks");
    expect(spokenShareText(0, 0)).toBeNull();
  });
});

describe("honoluluWeekStart", () => {
  it("buckets on Monday-to-Sunday weeks in Honolulu time, whatever the time of day", () => {
    // Monday 2026-10-12 00:00 in Honolulu = 10:00 UTC.
    const monday = Date.UTC(2026, 9, 12, 10);
    expect(honoluluWeekStart(monday)).toBe(monday);
    expect(honoluluWeekStart(monday + 3 * 24 * 3_600_000 + 5_000)).toBe(monday);
    // Sunday 23:59 Honolulu is still the previous week; Monday 00:00 starts the next.
    expect(honoluluWeekStart(monday - 60_000)).toBe(monday - WEEK_MS);
    expect(honoluluWeekStart(monday + WEEK_MS)).toBe(monday + WEEK_MS);
    // 09:00 UTC Monday is still Sunday evening in Honolulu.
    expect(honoluluWeekStart(Date.UTC(2026, 9, 12, 9))).toBe(monday - WEEK_MS);
  });
});

describe("validTalkJudgment", () => {
  it("keeps a canonical grade drawn from 100+ scholar words, and nothing else", () => {
    expect(validTalkJudgment("Grade 4.0", 150)).toEqual({ talkLevel: "4", talkWords: 150 });
    expect(validTalkJudgment("4", 99)).toBeNull();
    expect(validTalkJudgment("advanced", 500)).toBeNull();
    expect(validTalkJudgment(undefined, 500)).toBeNull();
    expect(validTalkJudgment("4", undefined)).toBeNull();
  });
});

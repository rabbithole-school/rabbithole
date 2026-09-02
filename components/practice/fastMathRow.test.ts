import { describe, expect, it } from "vitest";
import {
  fastMathCellReadout,
  fastMathPercentTint,
  fastMathRowSubLabel,
  fastMathSliceCellReadout,
  FAST_MATH_OPERATION_GROUPS,
  type FastMathReading,
} from "./fastMathRow";

const PARTIAL: FastMathReading = {
  automaticCount: 209,
  denominator: 418,
  percent: 50,
  ready: false,
  baselineKnown: true,
  license: null,
};

describe("fastMathRowSubLabel", () => {
  it("names the denominator so 100% is legible without a tooltip", () => {
    expect(fastMathRowSubLabel(418)).toBe("418 facts · % automatic");
  });

  it("degrades to the unit alone before the reading lands", () => {
    expect(fastMathRowSubLabel(null)).toBe("Fast math · % automatic");
  });
});

describe("fastMathCellReadout", () => {
  it("shows an em dash while loading — never a 0% that would read as measured", () => {
    const readout = fastMathCellReadout({
      reading: undefined,
      scholarName: "Leilani Park",
    });
    expect(readout.display).toBe("—");
    expect(readout.status).toBe("loading");
    expect(readout.subLabel).toBeNull();
  });

  it("shows the per cent and the fraction behind it, with no readiness claim", () => {
    const readout = fastMathCellReadout({
      reading: PARTIAL,
      scholarName: "Leilani Park",
    });

    expect(readout.display).toBe("50%");
    expect(readout.status).toBe("progress");
    expect(readout.subLabel).toBeNull();
    expect(readout.title).toContain("209 of 418 facts automatic");
    expect(readout.title).toContain("passing proctored exam");
    expect(readout.title).not.toContain("opens at 100%");
  });

  it("does not render an uncalibrated scholar as 0%", () => {
    const readout = fastMathCellReadout({
      reading: { ...PARTIAL, baselineKnown: false, percent: 0 },
      scholarName: "Leilani Park",
    });
    expect(readout.display).toBe("—");
    expect(readout.status).toBe("uncalibrated");
    expect(readout.title).toContain("not measured yet");
  });

  it("marks 100% as ready for the exam", () => {
    const readout = fastMathCellReadout({
      reading: {
        ...PARTIAL,
        automaticCount: 418,
        percent: 100,
        ready: true,
      },
      scholarName: "Leilani Park",
    });
    expect(readout.display).toBe("100%");
    expect(readout.status).toBe("ready");
    expect(readout.subLabel).toBe("Ready");
  });

  it("keeps the license separate from readiness — a licensed scholar whose facts decayed still reads Licensed", () => {
    const readout = fastMathCellReadout({
      reading: {
        ...PARTIAL,
        percent: 62,
        ready: false,
        license: { issuedAt: 1_700_000_000_000, issuedByName: "Mr Kalani" },
      },
      scholarName: "Leilani Park",
    });
    expect(readout.display).toBe("62%");
    expect(readout.status).toBe("licensed");
    expect(readout.subLabel).toBe("Licensed");
    expect(readout.title).not.toMatch(/\d+\/\d+/);
    expect(readout.title).toContain("Mr Kalani");
  });
});

describe("Fast math family cells", () => {
  it("shows the ten useful family ladders without repeating the add-subtract union", () => {
    const skillKeys = FAST_MATH_OPERATION_GROUPS.flatMap((group) =>
      group.families.map((family) => family.skillKey),
    );
    expect(skillKeys).toHaveLength(10);
    expect(skillKeys).not.toContain("add_subtract_fluency_within_20");
  });

  it("names the fraction behind a family percentage", () => {
    const readout = fastMathSliceCellReadout({
      reading: { automaticCount: 15, denominator: 30, percent: 50 },
      baselineKnown: true,
      scholarName: "Leilani Park",
      label: "Multiply by 3, 4, and 6",
    });
    expect(readout.display).toBe("50%");
    expect(readout.title).toContain("15 of 30 facts automatic");
  });

  it("uses a continuous white-to-green percentage tint", () => {
    expect(fastMathPercentTint(0)).toBe("#ffffff");
    expect(fastMathPercentTint(50)).toBe("#9dcfb5");
    expect(fastMathPercentTint(100)).toBe("#3a9e6b");
  });
});

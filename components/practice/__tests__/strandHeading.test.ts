import { describe, expect, it } from "vitest";

import { checkpointGradesInNodes } from "../StrandHeading";

describe("checkpointGradesInNodes", () => {
  it("offers only actual domain grade bands, without filling holes", () => {
    expect(
      checkpointGradesInNodes([
        { grade: "4" },
        { grade: "1" },
        { grade: "3" },
        { grade: "3" },
      ]),
    ).toEqual(["1", "3", "4"]);
  });

  it("keeps natural K→8 order while excluding missing strand grades", () => {
    expect(
      checkpointGradesInNodes([
        { grade: "4" },
        { grade: "K" },
        { grade: "2" },
        { grade: "1" },
      ]),
    ).toEqual(["K", "1", "2", "4"]);
  });
});

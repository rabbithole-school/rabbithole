import { describe, expect, test } from "vitest";
import { staffWithLine } from "../staffWithLine";

const lehua = { _id: "u1", name: "Lehua Torres" };
const chris = { _id: "u2", name: "Chris Mentor-Test" };
const noa = { _id: "u3", name: "Noa Kim" };

describe("staffWithLine", () => {
  test("names only the other adults, never the viewer", () => {
    expect(staffWithLine([chris, lehua], "u1")).toBe("with Chris Mentor-Test");
    expect(staffWithLine([lehua, chris, noa], "u1")).toBe(
      "with Chris Mentor-Test and Noa Kim",
    );
  });

  test("names everyone when the viewer is not a named participant", () => {
    expect(staffWithLine([chris], "u1")).toBe("with Chris Mentor-Test");
    expect(staffWithLine([chris, noa], undefined)).toBe("with Chris Mentor-Test and Noa Kim");
  });

  test("null when the viewer is the only named adult, or nobody is", () => {
    expect(staffWithLine([lehua], "u1")).toBeNull();
    expect(staffWithLine([], "u1")).toBeNull();
  });
});

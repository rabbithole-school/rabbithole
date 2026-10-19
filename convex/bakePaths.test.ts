import { describe, expect, test } from "vitest";
import { readReportPaths } from "./bakePaths";

const path = { emoji: "🐶", title: "Design the dog", blurb: "Sketch its poses." };

describe("readReportPaths", () => {
  test("reads a well-formed tool input", () => {
    expect(readReportPaths({ specific_build: true, paths: [path] })).toEqual({
      paths: [path],
      specificBuild: true,
    });
  });

  test("unwraps a whole answer packed into paths as a JSON string", () => {
    const packed = { paths: JSON.stringify({ specific_build: true, paths: [path] }) };
    expect(readReportPaths(packed)).toEqual({ paths: [path], specificBuild: true });
  });

  test("unwraps a stringified array and keeps a top-level flag", () => {
    expect(
      readReportPaths({ specific_build: true, paths: JSON.stringify([path]) }),
    ).toEqual({ paths: [path], specificBuild: true });
  });

  test("garbage reads as no paths and no build", () => {
    expect(readReportPaths({ paths: "{not json" })).toEqual({ paths: [], specificBuild: false });
    expect(readReportPaths(null)).toEqual({ paths: [], specificBuild: false });
  });
});

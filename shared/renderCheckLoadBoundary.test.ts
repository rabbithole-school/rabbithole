import { describe, expect, it } from "vitest";
import { renderCheckLoadBoundary } from "./renderCheckLoadBoundary";

describe("renderCheckLoadBoundary", () => {
  const loadBoundary = { loadVersion: 3, nonce: "old-nonce" };
  const baseline = { id: "artifact-1", loadBoundary };

  it("waits past the old load only for an in-place edit of the same artifact", () => {
    expect(renderCheckLoadBoundary(baseline, "artifact-1")).toBe(loadBoundary);
  });

  it("lets a brand-new artifact capture on its first settled load", () => {
    expect(renderCheckLoadBoundary(baseline, "artifact-2")).toBeUndefined();
    expect(renderCheckLoadBoundary(null, "artifact-1")).toBeUndefined();
  });

  it("treats a baseline without a boundary as first-load", () => {
    expect(
      renderCheckLoadBoundary({ id: "artifact-1", loadBoundary: null }, "artifact-1"),
    ).toBeUndefined();
  });
});

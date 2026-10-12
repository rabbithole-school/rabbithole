import { describe, expect, test } from "vitest";
import {
  effectiveWorkshopView,
  snapshotCaptureForView,
} from "../workshopView";

describe("effectiveWorkshopView", () => {
  test("editable mode reflects the raw view", () => {
    expect(effectiveWorkshopView(false, "preview")).toBe("preview");
    expect(effectiveWorkshopView(false, "code")).toBe("code");
  });

  test("read-only (Play) always resolves to preview even from Code", () => {
    // The Code→Play regression (N2): with the raw view still "code", read-only
    // rendering pins the effective view to preview, so capture must key on the
    // effective view, not the stale raw one.
    expect(effectiveWorkshopView(true, "code")).toBe("preview");
    expect(effectiveWorkshopView(true, "preview")).toBe("preview");
  });
});

describe("snapshotCaptureForView", () => {
  const capture = { id: "capture" };

  test("registers the capture for a non-empty preview", () => {
    expect(snapshotCaptureForView("preview", false, capture)).toBe(capture);
  });

  test("suppresses capture for the code editor or an empty artifact", () => {
    expect(snapshotCaptureForView("code", false, capture)).toBeNull();
    expect(snapshotCaptureForView("preview", true, capture)).toBeNull();
  });

  test("Code→Play keeps capture registered via the effective view", () => {
    // Full path: switching to Play from Code yields effectiveView "preview",
    // so the non-empty preview iframe still exposes its snapshot for Play turns.
    const effectiveView = effectiveWorkshopView(true, "code");
    expect(snapshotCaptureForView(effectiveView, false, capture)).toBe(capture);
  });
});

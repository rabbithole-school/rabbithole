import { describe, expect, test } from "vitest";
import {
  shouldProvideDeliverableContext,
  type DeliverableContextGateInput,
} from "./deliverablePanelContext";

const base: DeliverableContextGateInput = {
  hasSession: true,
  deliverable: { kind: "text", mode: "manual" },
  snapshotLoaded: true,
  snapshotStatus: "ready",
  snapshotHasCriteria: true,
};

describe("shouldProvideDeliverableContext", () => {
  test("no session or no deliverable → false", () => {
    expect(shouldProvideDeliverableContext({ ...base, hasSession: false })).toBe(false);
    expect(shouldProvideDeliverableContext({ ...base, deliverable: null })).toBe(false);
    expect(shouldProvideDeliverableContext({ ...base, deliverable: undefined })).toBe(false);
  });

  // The review's repro: an AUTO-mode PHOTO whose criteria are still generating
  // (or errored) must STILL get context, so the panel shows photo capture — not
  // the generic "No documents yet / Add Document" trap.
  test("auto-mode photo with criteria PENDING → true (the trap repro)", () => {
    expect(
      shouldProvideDeliverableContext({
        hasSession: true,
        deliverable: { kind: "photo", mode: "auto" },
        snapshotLoaded: true,
        snapshotStatus: "pending",
        snapshotHasCriteria: false,
      }),
    ).toBe(true);
  });

  test("auto-mode photo with criteria ERROR → true (never permanently trapped)", () => {
    expect(
      shouldProvideDeliverableContext({
        hasSession: true,
        deliverable: { kind: "photo", mode: "auto" },
        snapshotLoaded: true,
        snapshotStatus: "error",
        snapshotHasCriteria: false,
      }),
    ).toBe(true);
  });

  test("photo/slides/audio don't even wait for the snapshot to load", () => {
    for (const kind of ["photo", "slides", "audio"] as const) {
      expect(
        shouldProvideDeliverableContext({
          hasSession: true,
          deliverable: { kind, mode: "auto" },
          snapshotLoaded: false,
          snapshotStatus: undefined,
          snapshotHasCriteria: false,
        }),
      ).toBe(true);
    }
  });

  test("auto-mode TEXT with criteria pending → true (shows preparation state)", () => {
    expect(
      shouldProvideDeliverableContext({
        ...base,
        deliverable: { kind: "text", mode: "auto" },
        snapshotStatus: "pending",
        snapshotHasCriteria: false,
      }),
    ).toBe(true);
  });

  test("auto-mode TEXT with criteria ready → true", () => {
    expect(
      shouldProvideDeliverableContext({
        ...base,
        deliverable: { kind: "text", mode: "auto" },
        snapshotStatus: "ready",
        snapshotHasCriteria: true,
      }),
    ).toBe(true);
  });

  test("manual text/artifact → true once snapshot loaded", () => {
    expect(
      shouldProvideDeliverableContext({ ...base, deliverable: { kind: "text", mode: "manual" } }),
    ).toBe(true);
    expect(
      shouldProvideDeliverableContext({ ...base, deliverable: { kind: "artifact", mode: "manual" } }),
    ).toBe(true);
  });

  test("text still waits for the snapshot query to resolve", () => {
    expect(
      shouldProvideDeliverableContext({ ...base, snapshotLoaded: false }),
    ).toBe(false);
  });
});

import { describe, expect, test } from "vitest";

import {
  assignedSessionIsCurrent,
  captureStationGateMode,
  formatCaptureStationExpiryShort,
} from "../captureStationAssignment";

const assignment = {
  captureStationId: "station",
  expiresAt: 1_000,
  updatedAt: 7,
};

describe("capture station assignment gate", () => {
  test("keeps a permanent enrollment token ahead of an assigned device", () => {
    expect(
      captureStationGateMode({
        hasStaticToken: true,
        assignment,
        isConnected: true,
        now: 999,
      }),
    ).toBe("static");
  });

  test("fails closed while offline or after the assignment expires", () => {
    expect(
      captureStationGateMode({
        hasStaticToken: false,
        assignment,
        isConnected: false,
        now: 999,
      }),
    ).toBe("app");
    expect(
      captureStationGateMode({
        hasStaticToken: false,
        assignment,
        isConnected: true,
        now: 1_000,
      }),
    ).toBe("app");
  });

  test("rejects a temporary session when its assignment revision changes", () => {
    expect(
      assignedSessionIsCurrent({
        assignment,
        sessionRevision: 6,
        sessionExpiresAt: 999,
        now: 100,
      }),
    ).toBe(false);
    expect(
      assignedSessionIsCurrent({
        assignment,
        sessionRevision: 7,
        sessionExpiresAt: 999,
        now: 100,
      }),
    ).toBe(true);
  });
});

describe("formatCaptureStationExpiryShort", () => {
  const tz = "Pacific/Honolulu"; // UTC-10, no DST
  // 2026-08-19T02:40Z === 2026-08-18 4:40 PM HST
  const expiresAt = Date.UTC(2026, 7, 19, 2, 40);

  test("same school day → bare time", () => {
    const now = Date.UTC(2026, 7, 19, 1, 0); // 2026-08-18 3:00 PM HST
    expect(formatCaptureStationExpiryShort(expiresAt, now, tz)).toBe(
      "ends 4:40pm",
    );
  });

  test("next school day → tomorrow", () => {
    const now = Date.UTC(2026, 7, 18, 2, 0); // 2026-08-17 4:00 PM HST
    expect(formatCaptureStationExpiryShort(expiresAt, now, tz)).toBe(
      "ends tomorrow 4:40pm",
    );
  });

  test("further out → short weekday, never 'tomorrow'", () => {
    const now = Date.UTC(2026, 7, 17, 2, 0); // 2026-08-16 4:00 PM HST
    const label = formatCaptureStationExpiryShort(expiresAt, now, tz);
    expect(label).toMatch(/^ends [A-Z][a-z]{2} 4:40pm$/);
    expect(label).not.toContain("tomorrow");
  });
});

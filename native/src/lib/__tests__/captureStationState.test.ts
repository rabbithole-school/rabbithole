import { describe, expect, test } from "vitest";
import {
  captureSessionIsReusable,
  captureUploadPause,
  emptyCaptureStationState,
  pendingUploadCannotRetry,
  resetCaptureStationState,
  restoreTeamSelection,
  toggleRosterSelection,
} from "../captureStationState";
import { resolveCaptureStationEnrollmentToken } from "../captureStationTokenLogic";
import {
  captureMediaKind,
  formatCaptureDuration,
} from "../../../vendor/shared/captureMedia";

describe("capture station state", () => {
  test("dedupes roster selection and toggles it off", () => {
    expect(toggleRosterSelection(["a"], "a")).toEqual([]);
    expect(toggleRosterSelection(["a", "a"], "b")).toEqual(["a", "b"]);
  });

  test("reset clears a pending capture after submit or background", () => {
    expect(resetCaptureStationState()).toEqual(emptyCaptureStationState);
    expect(resetCaptureStationState()).not.toBe(emptyCaptureStationState);
  });

  test("keeps a still-valid reservation session while an upload is pending", () => {
    expect(captureSessionIsReusable(1_001, 1_000, true)).toBe(true);
    expect(captureSessionIsReusable(1_001, 1_000, false)).toBe(false);
    expect(captureSessionIsReusable(1_000, 1_000, true)).toBe(false);
  });

  test("drops pending uploads that cannot succeed after a quota failure", () => {
    expect(
      pendingUploadCannotRetry({ data: { kind: "capture_count_quota" } }),
    ).toBe(true);
    expect(
      pendingUploadCannotRetry({ data: { kind: "capture_storage_quota" } }),
    ).toBe(true);
    expect(
      pendingUploadCannotRetry(new Error("Assigned capture mode has ended.")),
    ).toBe(true);
    expect(pendingUploadCannotRetry(new Error("Network unavailable"))).toBe(
      false,
    );
  });

  test("pauses capture until the minute the server accepts uploads again", () => {
    const tz = "Pacific/Honolulu";
    for (const kind of ["upload_pending_quota", "upload_abandoned_quota"]) {
      const pause = captureUploadPause(
        { data: { kind, retryAt: Date.parse("2026-08-18T21:01:37.000Z") } },
        tz,
      );
      // Rounded up: a pause shown as "until 11:01am" would still refuse at
      // 11:01:05.
      expect(pause?.until).toBe(Date.parse("2026-08-18T21:02:00.000Z"));
      expect(pause?.message).toContain("11:02am");
      expect(pause?.message).not.toMatch(/connection/i);
    }
    expect(
      captureUploadPause(
        {
          data: {
            kind: "upload_abandoned_quota",
            retryAt: Date.parse("2026-08-18T21:02:00.000Z"),
          },
        },
        tz,
      )?.until,
    ).toBe(Date.parse("2026-08-18T21:02:00.000Z"));
  });

  test("a pause with no usable retry time names no time and holds nothing", () => {
    for (const retryAt of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1e16,
      "2026-08-18T21:02:00.000Z",
    ]) {
      const pause = captureUploadPause({
        data: { kind: "upload_abandoned_quota", retryAt },
      });
      expect(pause?.until).toBeNull();
      expect(pause?.message).not.toMatch(/\d:\d\d|undefined|NaN|Infinity/);
    }
  });

  test("leaves every other upload failure to the caller", () => {
    expect(captureUploadPause({ data: { kind: "upload_url_quota" } })).toBeNull();
    expect(captureUploadPause(new Error("Network request failed"))).toBeNull();
    expect(captureUploadPause(null)).toBeNull();
  });

  test("restores a persisted team, dropping ids no longer on the roster", () => {
    expect(restoreTeamSelection(["a", "b", "c"], ["c", "a"])).toEqual([
      "a",
      "c",
    ]);
    expect(restoreTeamSelection([], ["a", "b"])).toEqual([]);
    expect(restoreTeamSelection(["a", "b"], [])).toEqual([]);
  });

  test("uses managed capture enrollment before a dev-only fallback", () => {
    const managed = "rhcapture_managed-token-value";
    const dev = "rhcapture_dev-token-value";
    expect(resolveCaptureStationEnrollmentToken(managed, dev, true)).toBe(managed);
    expect(resolveCaptureStationEnrollmentToken(undefined, dev, true)).toBe(dev);
    expect(resolveCaptureStationEnrollmentToken(undefined, dev, false)).toBeNull();
  });
});

describe("formatCaptureDuration", () => {
  test("formats milliseconds as m:ss", () => {
    expect(formatCaptureDuration(58_000)).toBe("0:58");
    expect(formatCaptureDuration(125_000)).toBe("2:05");
    expect(formatCaptureDuration(0)).toBe("0:00");
    expect(formatCaptureDuration(-500)).toBe("0:00");
    expect(formatCaptureDuration(59_600)).toBe("1:00"); // rounds up
  });
});

describe("captureMediaKind", () => {
  test("maps video MIME types to video and other captures to photo", () => {
    expect(captureMediaKind("video/quicktime")).toBe("video");
    expect(captureMediaKind("VIDEO/MP4")).toBe("video");
    expect(captureMediaKind("image/jpeg")).toBe("photo");
    expect(captureMediaKind(null)).toBe("photo");
  });
});

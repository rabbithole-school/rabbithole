import type { Id } from "@/lib/convex";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_SNAPSHOT_UPLOAD_MAX_BYTES,
  collectAppSnapshotConsoleLines,
  uploadChangedAppSnapshot,
} from "../appSnapshot";

function dataUrl(bytes: Uint8Array, mime = "image/jpeg"): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("collectAppSnapshotConsoleLines", () => {
  it("filters snapshot CSS-rule noise and puts errors first", () => {
    expect(
      collectAppSnapshotConsoleLines([
        { level: "log", message: "ready" },
        {
          level: "error",
          message: "Error while reading CSS rules from https://example.test",
        },
        { level: "warn", message: "slow" },
        { level: "error", message: "boom" },
      ]),
    ).toEqual(["[error] boom", "[warn] slow", "[log] ready"]);
  });
});

describe("uploadChangedAppSnapshot", () => {
  it("skips an unchanged capture before requesting an upload URL", async () => {
    const generateUploadUrl = vi.fn(async () => "https://upload.test");

    await expect(
      uploadChangedAppSnapshot({
        captureSnapshot: async () => ({
          image: {
            dataUrl: dataUrl(new Uint8Array([1, 2, 3])),
            hash: "same",
          },
          consoleLines: [],
          stateJson: "{}",
        }),
        lastSentHash: "same",
        generateUploadUrl,
        uploadDataUrl: vi.fn(),
      }),
    ).resolves.toBeNull();
    expect(generateUploadUrl).not.toHaveBeenCalled();
  });

  it("uploads decoded image bytes and returns the Convex storage id", async () => {
    const uploadDataUrl = vi.fn(async () => "storage-1" as Id<"_storage">);

    await expect(
      uploadChangedAppSnapshot({
        captureSnapshot: async () => ({
          image: {
            dataUrl: dataUrl(new Uint8Array([1, 2, 3, 4])),
            hash: "fresh",
          },
          consoleLines: [],
          stateJson: "{}",
        }),
        lastSentHash: null,
        generateUploadUrl: async () => "https://upload.test",
        uploadDataUrl,
      }),
    ).resolves.toEqual({ storageId: "storage-1", hash: "fresh" });
    expect(uploadDataUrl).toHaveBeenCalledWith(
      "https://upload.test",
      dataUrl(new Uint8Array([1, 2, 3, 4])),
    );
  });

  it("returns the structured missing-image reason for render checks", async () => {
    await expect(
      uploadChangedAppSnapshot({
        captureSnapshot: async () => ({
          image: null,
          imageError: "timeout",
          consoleLines: [],
          stateJson: "{}",
        }),
        lastSentHash: null,
        generateUploadUrl: async () => "https://upload.test",
        uploadDataUrl: vi.fn(),
        returnCaptureOnUploadSkip: true,
      }),
    ).resolves.toEqual({
      storageId: null,
      hash: null,
      missingImageReason: "timeout",
      consoleLines: [],
      stateJson: "{}",
    });
  });

  it("drops captures above the server byte limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const generateUploadUrl = vi.fn(async () => "https://upload.test");

    await expect(
      uploadChangedAppSnapshot({
        captureSnapshot: async () => ({
          image: {
            dataUrl: dataUrl(
              new Uint8Array(APP_SNAPSHOT_UPLOAD_MAX_BYTES + 1),
            ),
            hash: "oversize",
          },
          consoleLines: [],
          stateJson: "{}",
        }),
        lastSentHash: null,
        generateUploadUrl,
        uploadDataUrl: vi.fn(),
      }),
    ).resolves.toBeNull();
    expect(generateUploadUrl).not.toHaveBeenCalled();
  });
});

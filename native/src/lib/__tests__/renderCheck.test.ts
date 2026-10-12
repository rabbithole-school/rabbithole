import { afterEach, describe, expect, it, vi } from "vitest";

import type { Id } from "@/lib/convex";
import {
  answerNativeRenderCheck,
  renderCheckLoadBoundary,
} from "../renderCheck";
import { createTutorSseParser } from "../tutorSse";

function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native tutor SSE", () => {
  it("preserves a renderCheck event split across network chunks", () => {
    const parser = createTutorSseParser();

    expect(
      parser.push(
        'data: {"renderCheck":{"checkId":"check-1","artifactId":"art',
      ),
    ).toEqual([]);
    expect(parser.push('ifact-1"}}\n\n')).toEqual([
      {
        renderCheck: {
          checkId: "check-1",
          artifactId: "artifact-1",
        },
      },
    ]);
  });

  it("drops malformed renderCheck payloads without dropping the event", () => {
    const parser = createTutorSseParser();

    expect(
      parser.push(
        'data: {"text":"still here","renderCheck":{"checkId":1,"artifactId":"a"}}\n',
      ),
    ).toEqual([{ text: "still here", renderCheck: undefined }]);
  });

  it("delivers a final unterminated event when the stream finishes", () => {
    const parser = createTutorSseParser();

    expect(parser.push('data: {"done":true}')).toEqual([]);
    expect(parser.finish()).toEqual([{ done: true }]);
  });
});

describe("native render-check answer", () => {
  it("waits past the old load only for an in-place artifact edit", () => {
    const loadBoundary = { loadVersion: 3, nonce: "old-nonce" };
    const baseline = {
      id: "artifact-1",
      loadBoundary,
    };

    expect(renderCheckLoadBoundary(baseline, "artifact-1")).toBe(loadBoundary);
    expect(renderCheckLoadBoundary(baseline, "artifact-2")).toBeUndefined();
    expect(renderCheckLoadBoundary(null, "artifact-1")).toBeUndefined();
  });

  it("uploads the rendered capture and answers the matching stream check", async () => {
    const captureSnapshot = vi.fn(async () => ({
      image: {
        dataUrl: dataUrl(new Uint8Array([1, 2, 3, 4])),
        hash: "rendered-hash",
      },
      consoleLines: ["[error] boom", "[log] ready"],
      stateJson: '{"screen":"counter"}',
    }));
    const answerRenderCheck = vi.fn(async () => ({
      messageId: "message-1",
      answeredAt: 123,
    }));
    const afterLoad = { loadVersion: 3, nonce: "old-nonce" };
    const deadlineAt = performance.now() + 6_500;

    await expect(
      answerNativeRenderCheck({
        sessionId: "session-1" as Id<"sessions">,
        streamId: "stream-1",
        checkId: "check-1",
        captureSnapshot,
        afterLoad,
        lastSentHash: "rendered-hash",
        generateUploadUrl: async () => "https://upload.test",
        uploadDataUrl: async () => "storage-1" as Id<"_storage">,
        answerRenderCheck,
        isStillActive: () => true,
        deadlineAt,
      }),
    ).resolves.toMatchObject({
      storageId: "storage-1",
      hash: "rendered-hash",
    });

    expect(captureSnapshot).toHaveBeenCalledWith(afterLoad, deadlineAt);
    expect(answerRenderCheck).toHaveBeenCalledWith({
      sessionId: "session-1",
      streamId: "stream-1",
      checkId: "check-1",
      snapshotStorageId: "storage-1",
      consoleLines: ["[error] boom", "[log] ready"],
      stateJson: '{"screen":"counter"}',
    });
  });

  it("still answers without an image when capture fails", async () => {
    const captureError = new Error("snapshot timed out");
    const onCaptureError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answerRenderCheck = vi.fn(async () => ({
      messageId: "message-1",
      answeredAt: 123,
    }));

    await answerNativeRenderCheck({
      sessionId: "session-1" as Id<"sessions">,
      streamId: "stream-1",
      checkId: "check-1",
      captureSnapshot: async () => {
        throw captureError;
      },
      lastSentHash: null,
      generateUploadUrl: async () => "https://upload.test",
      uploadDataUrl: async () => "storage-1" as Id<"_storage">,
      answerRenderCheck,
      isStillActive: () => true,
      deadlineAt: performance.now() + 6_500,
      onCaptureError,
    });

    expect(onCaptureError).toHaveBeenCalledWith(captureError);
    expect(answerRenderCheck).toHaveBeenCalledWith({
      sessionId: "session-1",
      streamId: "stream-1",
      checkId: "check-1",
      snapshotStorageId: undefined,
      consoleLines: [
        "[render-check] no image: capture-error:snapshot timed out",
      ],
      stateJson: "{}",
    });
    expect(warn).toHaveBeenCalledWith(
      "[render-check] no image: capture-error:snapshot timed out",
    );
  });

  it("does not answer a render check superseded during capture", async () => {
    const answerRenderCheck = vi.fn();

    await expect(
      answerNativeRenderCheck({
        sessionId: "session-1" as Id<"sessions">,
        streamId: "stream-1",
        checkId: "check-1",
        captureSnapshot: async () => ({
          image: {
            dataUrl: dataUrl(new Uint8Array([1, 2, 3, 4])),
            hash: "rendered-hash",
          },
          consoleLines: [],
          stateJson: "{}",
        }),
        lastSentHash: null,
        generateUploadUrl: async () => "https://upload.test",
        uploadDataUrl: async () => "storage-1" as Id<"_storage">,
        answerRenderCheck,
        isStillActive: () => false,
        deadlineAt: performance.now() + 6_500,
      }),
    ).resolves.toBeNull();

    expect(answerRenderCheck).not.toHaveBeenCalled();
  });
});

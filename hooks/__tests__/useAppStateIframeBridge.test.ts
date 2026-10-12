// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  collectAppSnapshotConsoleLines,
  forwardAppTutorRequest,
  type CaptureAppSnapshot,
  useAppStateIframeSrcDoc,
  uploadChangedAppSnapshot,
} from "../useAppStateIframeBridge";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureWithHash(hash: string): CaptureAppSnapshot {
  return Object.assign(
    async () => ({
      image: {
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        hash,
      },
      consoleLines: ["[error] boom"],
      stateJson: '{"screen":"shop"}',
    }),
    {
      currentLoadBoundary: () => ({ loadVersion: 1, nonce: "ready" }),
    },
  );
}

describe("collectAppSnapshotConsoleLines", () => {
  test("drops dom-to-image CSS-rule capture noise without hiding app errors", () => {
    expect(
      collectAppSnapshotConsoleLines([
        {
          level: "log",
          message:
            "Error while reading CSS rules from https://fonts.googleapis.com/css2?family=Inter SecurityError: Failed to read the 'cssRules' property from 'CSSStyleSheet': Cannot access rules",
        },
        {
          level: "warn",
          message: "A button has no label",
        },
        {
          level: "error",
          message: "SecurityError: Local storage is unavailable",
        },
      ]),
    ).toEqual([
      "[error] SecurityError: Local storage is unavailable",
      "[warn] A button has no label",
    ]);
  });

  describe("forwardAppTutorRequest", () => {
    test("flushes app state before handing the request to the host", async () => {
      const order: string[] = [];
      const handler = vi.fn(async () => {
        order.push("handler");
      });

      await expect(
        forwardAppTutorRequest({
          request: {
            message: "Check my orbit",
            context: { selectedPlanet: "Mars" },
          },
          flush: async () => {
            order.push("flush");
            return true;
          },
          handler,
        }),
      ).resolves.toBe(true);
      expect(order).toEqual(["flush", "handler"]);
      expect(handler).toHaveBeenCalledWith({
        message: "Check my orbit",
        context: { selectedPlanet: "Mars" },
      });
    });

    test("does not send when the pending app-state flush fails", async () => {
      const handler = vi.fn();
      await expect(
        forwardAppTutorRequest({
          request: { message: "Check my orbit" },
          flush: async () => false,
          handler,
        }),
      ).resolves.toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe("useAppStateIframeSrcDoc", () => {
  test("returns the storage path CSP with the prepared srcdoc", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let resolveCsp: (value: string) => void = () => undefined;
    const cspReady = new Promise<string>((resolve) => {
      resolveCsp = resolve;
    });
    const assetUrls = new Map([
      ["fish", "https://assets.example/api/storage/fish-id"],
    ]);

    function Probe() {
      const sandbox = useAppStateIframeSrcDoc(
        '<img src="/app-assets/fish">',
        null,
        assetUrls,
      );
      if (sandbox !== null) resolveCsp(sandbox.csp);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Probe));
      });
      await expect(cspReady).resolves.toContain(
        "https://assets.example/api/storage/",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("uploadChangedAppSnapshot", () => {
  test("forwards the live load boundary to render-check capture", async () => {
    const boundary = { loadVersion: 3, nonce: "prior-artifact" };
    const captureSnapshot = Object.assign(
      vi.fn(async () => ({
        image: null,
        consoleLines: [],
        stateJson: "{}",
      })),
      {
        currentLoadBoundary: vi.fn(() => boundary),
      },
    );

    await expect(
      uploadChangedAppSnapshot({
        captureSnapshot,
        lastSentHash: null,
        generateUploadUrl: vi.fn(),
        force: true,
        afterLoad: captureSnapshot.currentLoadBoundary(),
        deadlineAt: 42,
        returnCaptureOnUploadSkip: true,
      }),
    ).resolves.toMatchObject({
      storageId: null,
      hash: null,
      consoleLines: [],
      stateJson: "{}",
    });
    expect(captureSnapshot).toHaveBeenCalledWith(boundary, 42);
  });

  test("force uploads an unchanged capture for a render check", async () => {
    const generateUploadUrl = vi.fn(async () => "https://upload.example.com");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ storageId: "storage-render-check" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadChangedAppSnapshot({
        captureSnapshot: captureWithHash("same-hash"),
        lastSentHash: "same-hash",
        generateUploadUrl,
      }),
    ).resolves.toBeNull();
    expect(generateUploadUrl).not.toHaveBeenCalled();

    await expect(
      uploadChangedAppSnapshot({
        captureSnapshot: captureWithHash("same-hash"),
        lastSentHash: "same-hash",
        generateUploadUrl,
        force: true,
        returnCaptureOnUploadSkip: true,
      }),
    ).resolves.toMatchObject({
      storageId: "storage-render-check",
      hash: "same-hash",
      consoleLines: ["[error] boom"],
      stateJson: '{"screen":"shop"}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

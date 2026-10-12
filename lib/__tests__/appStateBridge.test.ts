import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { describe, expect, test } from "vitest";
import * as appStateBridgeRuntime from "../appStateBridge.mjs";

// The end-to-end bridge test drives a real headless Chromium (launch → navigate
// → several waitForFunction polls). That is reliable locally but timing-flaky on
// the shared unit-test CI runners, where a cold Playwright launch can blow the
// default per-test timeout. Keep it OUT of CI (the pure protocol/merge/parse
// assertions below cover the logic there) and run the browser E2E locally, or in
// a dedicated browser lane via APP_STATE_BRIDGE_E2E=1. Requires the chromium
// binary either way.
function chromiumAvailable(): boolean {
  try {
    const path = chromium.executablePath();
    return Boolean(path) && existsSync(path);
  } catch {
    return false;
  }
}
const runBrowserE2e =
  chromiumAvailable() &&
  (process.env.APP_STATE_BRIDGE_E2E === "1" || !process.env.CI);
// Generous ceiling for a cold headless launch when it does run.
const BROWSER_E2E_TIMEOUT_MS = 60_000;
import {
  APP_STATE_PROTOCOL,
  APP_STATE_PROTOCOL_VERSION,
  APP_STATE_MAX_WRITE_LATENCY_MS,
  APP_STATE_WRITE_DEBOUNCE_MS,
  RABBITHOLE_APP_STATE_SDK_BYTES,
  appActionRegistryWriteDecision,
  injectAppStateSdk,
  appStateFlushDelay,
  matchesAppStateBridgeNonce,
  createAppStateHostMessage,
  mergeAppStateDoc,
  parseAppStateBridgeMessage,
  appStateHostInjectionScript,
  createAppBridgeResponseMessage,
  appBridgeResponseInjectionScript,
} from "../appStateBridge.mjs";
import {
  APP_REQUEST_TIMEOUT_MS,
  MAX_CHARACTER_LINE_CHARS,
  MAX_JUDGE_ANSWER_CHARS,
  type AppBridgeErrorCode,
} from "../../shared/appAiPolicy";
import { MAX_APP_ACTIONS } from "../../shared/appActionPolicy";
import {
  APP_SANDBOX_CSP,
  prepareCustomAppSandbox,
} from "../../shared/customAppSandbox";
import { DOM_TO_IMAGE_SOURCE } from "../../shared/domToImageSource";
import { createAppStateIframeSrcDoc } from "../../hooks/useAppStateIframeBridge";

const {
  APP_SNAPSHOT_READY_TYPE,
  APP_SNAPSHOT_REQUEST_TYPE,
  APP_SNAPSHOT_RESULT_TYPE,
  RABBITHOLE_APP_SNAPSHOT_SDK,
  RABBITHOLE_APP_STATE_SDK,
  RABBITHOLE_APP_SNAPSHOT_SDK_BYTES,
  createAppSnapshotRequestMessage,
  hashAppSnapshotDataUrl,
} = appStateBridgeRuntime as typeof appStateBridgeRuntime & {
  APP_SNAPSHOT_READY_TYPE: "rabbithole:snapshot:ready";
  APP_SNAPSHOT_REQUEST_TYPE: "rabbithole:snapshot";
  APP_SNAPSHOT_RESULT_TYPE: "rabbithole:snapshot:result";
  RABBITHOLE_APP_SNAPSHOT_SDK: string;
  RABBITHOLE_APP_SNAPSHOT_SDK_BYTES: number;
  createAppSnapshotRequestMessage: (
    nonce: string,
    requestId: string,
    maxWidth?: number,
    width?: number,
    height?: number,
  ) => Record<string, unknown>;
  hashAppSnapshotDataUrl: (dataUrl: string) => string;
};

declare global {
  interface Window {
    __bridge: {
      stored: Record<string, unknown>;
      logs: Array<{ message: string }>;
      writes: number;
      sharedStored: Record<string, unknown>;
      sharedWrites: number;
      ignored: number;
      nonceDrops: number;
      lastOrigin: string | null;
      activeNonce: string | null;
      pushShared: (patch: Record<string, unknown>) => void;
      actions: Array<{ name: string; description: string }>;
      actionResult: {
        requestId: string;
        ok: boolean;
        result?: unknown;
        error?: string;
      } | null;
      invokeAction: (
        name: string,
        args?: Record<string, unknown>,
      ) => void;
      snapshotNonce: string | null;
      snapshotResult: {
        requestId?: string;
        dataUrl?: string;
        hash?: string;
        error?: string;
      } | null;
    };
    __cspSnapshotResult: {
      requestId?: string;
      dataUrl?: string;
      hash?: string;
      error?: string;
    } | null;
  }
}

describe("app-state bridge protocol", () => {
  test("both injected SDKs parse as JavaScript", () => {
    // The SDKs are template strings, so a stray paren ships silently — the
    // frame then never emits `ready` and every snapshot times out.
    expect(() => new Function(RABBITHOLE_APP_STATE_SDK)).not.toThrow();
    expect(() => new Function(RABBITHOLE_APP_SNAPSHOT_SDK)).not.toThrow();
  });

  test("is versioned, bounded, and injected before app scripts", () => {
    expect(RABBITHOLE_APP_STATE_SDK_BYTES).toBeLessThanOrEqual(6_144);
    expect(RABBITHOLE_APP_SNAPSHOT_SDK_BYTES).toBeLessThanOrEqual(4_096);
    expect(Buffer.byteLength(DOM_TO_IMAGE_SOURCE)).toBe(9_278);
    expect(
      createHash("sha256").update(DOM_TO_IMAGE_SOURCE).digest("hex"),
    ).toBe("73dbf1717c801b8a5a02b406df193a0e3c96ffd687c5a8b679ff51a4c58ee380");
    expect(DOM_TO_IMAGE_SOURCE).toMatch(
      /^\/\*! dom-to-image 10-06-2017 \*\/\n/,
    );
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).toContain("window.domtoimage");
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).not.toContain("html2canvas");
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).not.toMatch(/https?:\/\//);
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).toContain(
      'document.querySelectorAll("canvas")',
    );
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).toContain(
      "c.width*c.height>=w*h*.6",
    );
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).toContain(
      'n.tagName!=="CANVAS"&&n.tagName!=="SCRIPT"',
    );
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).toContain("||800");
    expect(RABBITHOLE_APP_SNAPSHOT_SDK).toContain("||600");
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "change",
        patch: { score: 1 },
      }),
    ).toEqual({
      type: "change",
      nonce: "test-nonce",
      patch: { score: 1 },
      logs: undefined,
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "askTutor",
        message: " Check my orbit ",
        context: { selectedPlanet: "Mars" },
      }),
    ).toEqual({
      type: "askTutor",
      nonce: "test-nonce",
      message: "Check my orbit",
      context: { selectedPlanet: "Mars" },
    });
    expect(RABBITHOLE_APP_STATE_SDK).toContain("askTutor:T");
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "actions",
        actions: [
          { name: "reset", description: "Reset the board." },
          { name: "solveChallenge", description: "Forbidden semantics." },
          ...Array.from({ length: MAX_APP_ACTIONS + 3 }, (_, index) => ({
            name: `seed${index}`,
            description: `Seed scenario ${index}.`,
          })),
        ],
      }),
    ).toMatchObject({
      type: "actions",
      nonce: "test-nonce",
      actions: expect.arrayContaining([
        { name: "reset", description: "Reset the board." },
      ]),
    });
    const parsedActions = parseAppStateBridgeMessage({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "test-nonce",
      type: "actions",
      actions: Array.from({ length: MAX_APP_ACTIONS + 3 }, (_, index) => ({
        name: `seed${index}`,
        description: `Seed scenario ${index}.`,
      })),
    });
    if (parsedActions?.type !== "actions") {
      throw new Error("expected an actions message");
    }
    expect(parsedActions.actions).toHaveLength(MAX_APP_ACTIONS);
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "actionResult",
        requestId: "request-1",
        ok: true,
        result: { loaded: 3 },
      }),
    ).toEqual({
      type: "actionResult",
      nonce: "test-nonce",
      requestId: "request-1",
      ok: true,
      result: { loaded: 3 },
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION + 1,
        nonce: "test-nonce",
        type: "change",
        patch: { score: 1 },
      }),
    ).toBeNull();
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "sharedSelect",
        roomId: "room-1",
      }),
    ).toEqual({
      type: "sharedSelect",
      nonce: "test-nonce",
      roomId: "room-1",
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "sharedChange",
        roomId: "room-1",
        patch: { turn: 2 },
      }),
    ).toEqual({
      type: "sharedChange",
      nonce: "test-nonce",
      roomId: "room-1",
      patch: { turn: 2 },
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "snapshot-nonce",
        type: APP_SNAPSHOT_READY_TYPE,
      }),
    ).toEqual({
      type: APP_SNAPSHOT_READY_TYPE,
      nonce: "snapshot-nonce",
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "snapshot-nonce",
        type: APP_SNAPSHOT_RESULT_TYPE,
        requestId: "snapshot-1",
        dataUrl: "data:image/jpeg;base64,/9g=",
        hash: "cab3f41d",
      }),
    ).toEqual({
      type: APP_SNAPSHOT_RESULT_TYPE,
      nonce: "snapshot-nonce",
      requestId: "snapshot-1",
      dataUrl: "data:image/jpeg;base64,/9g=",
      hash: "cab3f41d",
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "snapshot-nonce",
        type: APP_SNAPSHOT_RESULT_TYPE,
        requestId: "snapshot-2",
        error: "DOM image capture failed",
      }),
    ).toEqual({
      type: APP_SNAPSHOT_RESULT_TYPE,
      nonce: "snapshot-nonce",
      requestId: "snapshot-2",
      error: "DOM image capture failed",
    });
    expect(
      createAppSnapshotRequestMessage(
        "snapshot-nonce",
        "snapshot-1",
        800,
        600,
        400,
      ),
    ).toMatchObject({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "snapshot-nonce",
      type: "rabbithole:snapshot",
      requestId: "snapshot-1",
      maxWidth: 800,
      width: 600,
      height: 400,
    });
    expect(
      createAppStateHostMessage("init", { local: true }, "test-nonce", {
        roomId: "room-1",
        doc: { turn: 1 },
        presence: [{ name: "A" }],
      }, {
        id: "request-1",
        name: "reset",
        requestedAt: 1,
      }),
    ).toMatchObject({
      doc: { local: true },
      shared: {
        roomId: "room-1",
        doc: { turn: 1 },
        presence: [{ name: "A" }],
      },
      actionRequest: {
        id: "request-1",
        name: "reset",
      },
    });

    expect(
      mergeAppStateDoc(
        { score: 1, level: 2 },
        [{ score: 2 }, { score: 3, streak: 4 }],
      ),
    ).toEqual({ score: 3, level: 2, streak: 4 });
    const startedAt = 1_000;
    expect(appStateFlushDelay(undefined, startedAt)).toBe(
      APP_STATE_WRITE_DEBOUNCE_MS,
    );
    expect(appStateFlushDelay(startedAt, startedAt + 1_900)).toBe(100);
    expect(
      appStateFlushDelay(
        startedAt,
        startedAt + APP_STATE_MAX_WRITE_LATENCY_MS,
      ),
    ).toBe(0);

    const injected = injectAppStateSdk(
      '<!doctype html><html><script>window.appBooted=true</script><head><meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'"></head><body></body></html>',
    );
    expect(injected.indexOf(APP_STATE_PROTOCOL)).toBeLessThan(
      injected.indexOf("window.appBooted"),
    );
  });

  test("hashes identical snapshot data deterministically", () => {
    const first = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
    const second = "data:image/jpeg;base64,/9j/4AAQSkZJRgABBQ==";
    expect(hashAppSnapshotDataUrl(first)).toBe(
      hashAppSnapshotDataUrl(first),
    );
    expect(hashAppSnapshotDataUrl(first)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashAppSnapshotDataUrl(first)).not.toBe(
      hashAppSnapshotDataUrl(second),
    );
  });

  test("waits for initial state and uses the shared app sandbox CSP", async () => {
    const html = "<!doctype html><html><body>App</body></html>";
    expect(await createAppStateIframeSrcDoc(html, undefined)).toBeNull();

    const initialSrcDoc = await createAppStateIframeSrcDoc(html, null);
    const patchedSrcDoc = await createAppStateIframeSrcDoc(html, {
      doc: { score: 2 },
      actions: [],
      version: 2,
      updatedAt: 200,
    });
    const customAppSandbox = await prepareCustomAppSandbox(
      html,
      injectAppStateSdk,
    );

    expect(initialSrcDoc).toContain(APP_STATE_PROTOCOL);
    expect(initialSrcDoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${customAppSandbox.csp}">`,
    );
    expect(customAppSandbox.csp).toBe(APP_SANDBOX_CSP);
    expect(patchedSrcDoc).toBe(initialSrcDoc);
  });

  test("inlines app-kit scripts in the Workshop srcdoc path", async () => {
    const srcDoc = await createAppStateIframeSrcDoc(
      '<script src="/app-kit/v1/cytoscape.min.js"></script>',
      null,
    );

    expect(srcDoc).not.toContain('src="/app-kit/');
    expect(srcDoc).toContain("cytoscape");
    expect(srcDoc).toContain(APP_SANDBOX_CSP);
  });

  test("accepts changes only when their nonce matches the active handshake", () => {
    const message = parseAppStateBridgeMessage({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "active-nonce",
      type: "change",
      patch: { score: 1 },
    });
    expect(message).not.toBeNull();
    expect(matchesAppStateBridgeNonce(message!, "active-nonce")).toBe(true);
    expect(matchesAppStateBridgeNonce(message!, "different-nonce")).toBe(false);
    expect(matchesAppStateBridgeNonce(message!, null)).toBe(false);

    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        type: "change",
        patch: { score: 2 },
      }),
    ).toBeNull();
  });

  test("drops a pre-reload message after a fresh nonce becomes active", () => {
    const staleMessage = parseAppStateBridgeMessage({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "pre-reload-nonce",
      type: "change",
      patch: { score: 1 },
    });
    expect(staleMessage).not.toBeNull();
    expect(matchesAppStateBridgeNonce(staleMessage!, "pre-reload-nonce")).toBe(
      true,
    );
    expect(matchesAppStateBridgeNonce(staleMessage!, "post-reload-nonce")).toBe(
      false,
    );
  });

  test("defers then skips an empty initial action registry write", () => {
    expect(appActionRegistryWriteDecision(undefined, [])).toBe("defer");
    expect(appActionRegistryWriteDecision(null, [])).toBe("skip");
    expect(appActionRegistryWriteDecision([], [])).toBe("skip");
  });

  test("defers then persists clearing a non-empty action registry", () => {
    expect(appActionRegistryWriteDecision(undefined, [])).toBe("defer");
    expect(
      appActionRegistryWriteDecision(
        [{ name: "reset", description: "Reset the board." }],
        [],
      ),
    ).toBe("persist");
  });

  test("parses only well-formed character.say and judge requests", () => {
    const request = (method: unknown, params: unknown, requestId = "q1") =>
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "request",
        requestId,
        method,
        params,
      });
    expect(request("character.say", { text: "  Hello robot  " })).toEqual({
      type: "request",
      nonce: "test-nonce",
      requestId: "q1",
      method: "character.say",
      params: { text: "Hello robot" },
    });
    expect(
      request("judge", { judgeId: "haiku_1", answer: " An old silent pond " }),
    ).toEqual({
      type: "request",
      nonce: "test-nonce",
      requestId: "q1",
      method: "judge",
      params: { judgeId: "haiku_1", answer: "An old silent pond" },
    });
    // Clamped to the policy limits, never rejected for length.
    const longSay = request("character.say", {
      text: "x".repeat(MAX_CHARACTER_LINE_CHARS + 50),
    });
    expect(longSay?.type === "request" && longSay.method === "character.say"
      ? longSay.params.text.length
      : -1).toBe(MAX_CHARACTER_LINE_CHARS);
    const longJudge = request("judge", {
      judgeId: "rubric",
      answer: "y".repeat(MAX_JUDGE_ANSWER_CHARS + 1),
    });
    expect(longJudge?.type === "request" && longJudge.method === "judge"
      ? longJudge.params.answer.length
      : -1).toBe(MAX_JUDGE_ANSWER_CHARS);
    // Unknown methods, missing ids, and malformed params all parse to null.
    expect(request("askTutor", { text: "hi" })).toBeNull();
    expect(request("character.listen", { text: "hi" })).toBeNull();
    expect(request("character.say", { text: "   " })).toBeNull();
    expect(request("character.say", { text: 42 })).toBeNull();
    expect(request("character.say", "hi")).toBeNull();
    expect(request("character.say", { text: "hi" }, "")).toBeNull();
    expect(request("character.say", { text: "hi" }, "q".repeat(65))).toBeNull();
    expect(request("judge", { judgeId: "1abc", answer: "x" })).toBeNull();
    expect(request("judge", { judgeId: "has space", answer: "x" })).toBeNull();
    expect(request("judge", { judgeId: "a".repeat(41), answer: "x" })).toBeNull();
    expect(request("judge", { judgeId: "ok", answer: "" })).toBeNull();
    expect(request("judge", { judgeId: "ok" })).toBeNull();
  });

  test("carries a normalized app context on requests and drops junk without refusing", () => {
    const request = (method: string, params: unknown) =>
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "request",
        requestId: "q1",
        method,
        params,
      });
    expect(
      request("character.say", {
        text: "Step forward",
        context: { stage: 4, mode: " rule ", done: false, nested: { a: 1 }, "bad key": 1 },
      }),
    ).toMatchObject({
      method: "character.say",
      params: { text: "Step forward", context: { stage: 4, mode: "rule", done: false } },
    });
    expect(
      request("judge", { judgeId: "q", answer: "42", context: { question: 3 } }),
    ).toMatchObject({
      method: "judge",
      params: { judgeId: "q", answer: "42", context: { question: 3 } },
    });
    // A context that normalizes to nothing is omitted; the call still parses.
    for (const context of [null, "stage 4", [1], {}, { nested: { a: 1 } }]) {
      const parsed = request("character.say", { text: "hi", context });
      expect(parsed).toMatchObject({ params: { text: "hi" } });
      expect(
        parsed?.type === "request" ? parsed.params : null,
      ).not.toHaveProperty("context");
    }
  });

  test("builds response messages and carries a character line on init/update", () => {
    expect(
      createAppBridgeResponseMessage("test-nonce", "q1", {
        ok: true,
        result: { line: "Beep", mood: "happy" },
      }),
    ).toEqual({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "test-nonce",
      type: "response",
      requestId: "q1",
      ok: true,
      result: { line: "Beep", mood: "happy" },
    });
    expect(
      createAppBridgeResponseMessage("test-nonce", "q2", {
        ok: false,
        error: { code: "busy", message: "Try again soon" },
      }),
    ).toMatchObject({ ok: false, error: { code: "busy", message: "Try again soon" } });
    // An undocumented code degrades to "failed" so the frame never sees one.
    expect(
      createAppBridgeResponseMessage("test-nonce", "q3", {
        ok: false,
        error: { code: "teapot" as AppBridgeErrorCode, message: "" },
      }),
    ).toMatchObject({ ok: false, error: { code: "failed", message: "Request failed" } });
    expect(() =>
      createAppBridgeResponseMessage("", "q1", { ok: true, result: {} }),
    ).toThrow();
    expect(() =>
      createAppBridgeResponseMessage("n", "", { ok: true, result: {} }),
    ).toThrow();
    const injected = appBridgeResponseInjectionScript("test-nonce", "q1", {
      ok: true,
      result: { line: "</script><b>", mood: "sly" },
    });
    expect(injected.startsWith("window.__rabbitholeReceive?.(")).toBe(true);
    expect(injected).not.toContain("<");
    expect(injected).toContain('"type":"response"');

    const line = { id: "line-1", line: "Hello!", mood: "happy" };
    expect(
      createAppStateHostMessage("update", {}, "test-nonce", undefined, undefined, {
        ...line,
        requestedAt: 5,
      } as never),
    ).toMatchObject({ characterLine: line });
    expect(
      createAppStateHostMessage("update", {}, "test-nonce", undefined, undefined, {
        ...line,
        requestedAt: 5,
      } as never).characterLine,
    ).not.toHaveProperty("requestedAt");
    expect(
      createAppStateHostMessage("init", {}, "test-nonce", undefined, undefined, {
        id: "",
        line: "x",
      }),
    ).not.toHaveProperty("characterLine");
    expect(
      createAppStateHostMessage("init", {}, "test-nonce"),
    ).not.toHaveProperty("characterLine");
    expect(
      appStateHostInjectionScript("update", {}, "test-nonce", undefined, undefined, line),
    ).toContain('"characterLine":{"id":"line-1"');
    expect(RABBITHOLE_APP_STATE_SDK).toContain("character:{say:");
    expect(RABBITHOLE_APP_STATE_SDK).toContain(`},${APP_REQUEST_TIMEOUT_MS})`);
  });

  test.runIf(runBrowserE2e)(
    "captures a workshop iframe snapshot under the shared networkless CSP",
    async () => {
      const appHtml = await createAppStateIframeSrcDoc(
        `<!doctype html>
<html>
  <head>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; }
      body { display: grid; place-items: center; background: #f0fbfc; }
      #target { width: 120px; height: 80px; background: #a960bc; color: white; }
    </style>
  </head>
  <body>
    <div id="target">Snapshot ready</div>
    <script>fetch("/should-not-load").catch(() => {});</script>
  </body>
</html>`,
        null,
      );
      if (appHtml === null) {
        throw new Error("Workshop srcdoc was not created");
      }
      const serializedAppHtml = JSON.stringify(appHtml).replaceAll(
        "</script",
        "<\\/script",
      );
      const hostHtml = `<!doctype html>
<html>
  <body>
    <script>
      const frame = document.createElement("iframe");
      window.__cspSnapshotResult = null;
      addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (
          message?.protocol === ${JSON.stringify(APP_STATE_PROTOCOL)} &&
          message?.version === ${APP_STATE_PROTOCOL_VERSION} &&
          message?.type === ${JSON.stringify(APP_SNAPSHOT_READY_TYPE)}
        ) {
          frame.contentWindow.postMessage({
            protocol: ${JSON.stringify(APP_STATE_PROTOCOL)},
            version: ${APP_STATE_PROTOCOL_VERSION},
            nonce: message.nonce,
            type: ${JSON.stringify(APP_SNAPSHOT_REQUEST_TYPE)},
            requestId: "strict-csp",
            maxWidth: 240,
            width: 240,
            height: 120
          }, "*");
          return;
        }
        if (
          message?.protocol === ${JSON.stringify(APP_STATE_PROTOCOL)} &&
          message?.version === ${APP_STATE_PROTOCOL_VERSION} &&
          message?.type === ${JSON.stringify(APP_SNAPSHOT_RESULT_TYPE)}
        ) {
          window.__cspSnapshotResult = message;
        }
      });
      frame.id = "app";
      frame.sandbox = "allow-scripts";
      frame.setAttribute("csp", ${JSON.stringify(APP_SANDBOX_CSP)});
      frame.srcdoc = ${serializedAppHtml};
      document.body.append(frame);
    </script>
  </body>
</html>`;

      const server = createServer((_request, response) => {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(hostHtml);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind to a TCP port");
      }

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const networkRequests: string[] = [];
        page.on("request", (request) => {
          if (/^https?:/.test(request.url())) {
            networkRequests.push(request.url());
          }
        });
        const hostUrl = `http://127.0.0.1:${address.port}`;
        await page.goto(hostUrl);
        await page.waitForFunction(
          () =>
            window.__cspSnapshotResult?.requestId === "strict-csp" &&
            window.__cspSnapshotResult.dataUrl?.startsWith(
              "data:image/jpeg;base64,",
            ),
        );
        const result = await page.evaluate(() => window.__cspSnapshotResult);
        expect(result?.error).toBeUndefined();
        expect(result?.hash).toMatch(/^[0-9a-f]{8}$/);
        expect(networkRequests.filter((url) => url !== `${hostUrl}/`)).toEqual(
          [],
        );
      } finally {
        await browser.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    BROWSER_E2E_TIMEOUT_MS,
  );

  test.runIf(runBrowserE2e)(
    "buffers init, captures console, nonce-checks, debounces, and rehydrates",
    async () => {
      const appHtml = injectAppStateSdk(`<!doctype html>
<html>
  <body>
    <button id="counter" data-count="0">0</button>
    <button id="shared-counter" data-count="0">0</button>
    <div id="presence"></div>
    <script>
      let count = 0;
      const button = document.querySelector("#counter");
      window.domtoimage = {
        toPng(_node, options) {
          document.body.dataset.snapshotWidth = String(options.width);
          document.body.dataset.snapshotHeight = String(options.height);
          document.body.dataset.snapshotTransform = options.style.transform;
          document.body.dataset.snapshotSourceWidth = options.style.width;
          document.body.dataset.snapshotSourceHeight = options.style.height;
          return Promise.resolve(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          );
        }
      };
      rabbithole.setState({ bootedBeforeInit: true });
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          protocol: ${JSON.stringify(APP_STATE_PROTOCOL)},
          version: ${APP_STATE_PROTOCOL_VERSION},
          nonce: "forged",
          type: "init",
          doc: { count: 999 }
        }
      }));
      console.warn("boot warning", { phase: "before-init" });
      rabbithole.subscribe((state) => {
        count = Number(state.count || 0);
        button.textContent = String(count);
        button.dataset.count = String(count);
      });
      const sharedButton = document.querySelector("#shared-counter");
      rabbithole.shared.subscribe((state) => {
        sharedButton.textContent = String(state.count || 0);
        sharedButton.dataset.count = String(state.count || 0);
      });
      rabbithole.shared.subscribePresence((people) => {
        document.querySelector("#presence").textContent =
          people.map((person) => person.name).join(",");
      });
      rabbithole.registerAction(
        "seedScenario",
        "Load a stage with a chosen number of clues.",
        ({ clues = 3 } = {}) => {
          button.dataset.seeded = String(clues);
          rabbithole.setState({ seededClues: clues });
          return { seededClues: clues };
        }
      );
      button.addEventListener("click", () => {
        rabbithole.setState({ count: count + 1 });
      });
      sharedButton.addEventListener("click", () => {
        rabbithole.shared.setState({
          count: Number(sharedButton.dataset.count || 0) + 1
        });
      });
    </script>
  </body>
</html>`);
      const serializedAppHtml = JSON.stringify(appHtml).replaceAll(
        "</script",
        "<\\/script",
      );
      const hostHtml = `<!doctype html>
<html>
  <body>
    <button id="refresh">Refresh preview</button>
    <div id="mount"></div>
    <script>
      const APP_HTML = ${serializedAppHtml};
      const PROTOCOL = ${JSON.stringify(APP_STATE_PROTOCOL)};
      const VERSION = ${APP_STATE_PROTOCOL_VERSION};
      const DEBOUNCE_MS = ${APP_STATE_WRITE_DEBOUNCE_MS};
      let frame, writeTimer, pendingPatch = {}, pendingLogs = [];
      window.__bridge = {
        stored: { restoredByHost: true },
        logs: [],
        writes: 0,
        sharedStored: { count: 4 },
        sharedWrites: 0,
        ignored: 0,
        nonceDrops: 0,
        lastOrigin: null,
        activeNonce: null,
        snapshotNonce: null,
        snapshotResult: null,
        actions: [],
        actionResult: null,
        invokeAction(name, args) {
          frame.contentWindow.postMessage({
            ...hostMessage("update"),
            actionRequest: {
              id: "request-1",
              name,
              args,
              requestedAt: Date.now()
            }
          }, "*");
        },
        pushShared(patch) {
          this.sharedStored = { ...this.sharedStored, ...patch };
          frame.contentWindow.postMessage(hostMessage("update"), "*");
        },
      };
      let bridgeNonce = null;
      const hostMessage = (type) => ({
        protocol: PROTOCOL,
        version: VERSION,
        nonce: bridgeNonce,
        type,
        doc: window.__bridge.stored,
        shared: {
          roomId: "room-1",
          doc: window.__bridge.sharedStored,
          presence: [{ name: "First" }, { name: "Second" }],
        },
      });
      const postInit = () => frame.contentWindow.postMessage(hostMessage("init"), "*");
      addEventListener("message", (event) => {
        if (!frame || event.source !== frame.contentWindow) {
          window.__bridge.ignored += 1;
          return;
        }
        const message = event.data;
        if (message?.protocol !== PROTOCOL || message?.version !== VERSION) return;
        if (message.type === ${JSON.stringify(APP_SNAPSHOT_READY_TYPE)}) {
          window.__bridge.snapshotNonce = message.nonce;
          return;
        }
        if (
          message.type === ${JSON.stringify(APP_SNAPSHOT_RESULT_TYPE)} &&
          message.nonce === window.__bridge.snapshotNonce
        ) {
          window.__bridge.snapshotResult = message;
          return;
        }
        if (message.type === "ready") {
          bridgeNonce = message.nonce;
          window.__bridge.activeNonce = bridgeNonce;
          window.__bridge.lastOrigin = event.origin;
          postInit();
          return;
        }
        if (message.nonce !== bridgeNonce) {
          window.__bridge.nonceDrops += 1;
          return;
        }
        if (message.type === "sharedChange") {
          window.__bridge.sharedStored = {
            ...window.__bridge.sharedStored,
            ...(message.patch || {})
          };
          window.__bridge.sharedWrites += 1;
          return;
        }
        if (message.type === "actions") {
          window.__bridge.actions = message.actions || [];
          return;
        }
        if (message.type === "actionResult") {
          window.__bridge.actionResult = message;
          return;
        }
        if (message.type !== "change") return;
        pendingPatch = { ...pendingPatch, ...(message.patch || {}) };
        pendingLogs.push(...(message.logs || []));
        clearTimeout(writeTimer);
        writeTimer = setTimeout(() => {
          window.__bridge.stored = { ...window.__bridge.stored, ...pendingPatch };
          window.__bridge.logs.push(...pendingLogs);
          pendingPatch = {};
          pendingLogs = [];
          window.__bridge.writes += 1;
        }, DEBOUNCE_MS);
      });
      function mount() {
        const next = document.createElement("iframe");
        next.id = "app";
        next.name = "app";
        next.sandbox = "allow-scripts";
        next.srcdoc = APP_HTML;
        next.addEventListener("load", postInit);
        document.querySelector("#mount").replaceChildren(next);
        frame = next;
      }
      document.querySelector("#refresh").addEventListener("click", mount);
      mount();
      const hostile = document.createElement("iframe");
      hostile.sandbox = "allow-scripts";
      hostile.srcdoc =
        '<script>parent.postMessage({protocol:' + JSON.stringify(PROTOCOL) +
        ',version:' + VERSION + ',type:"change",patch:{count:999}},"*")<\\/script>';
      document.body.append(hostile);
    </script>
  </body>
</html>`;

      const server = createServer((_request, response) => {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(hostHtml);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind to a TCP port");
      }

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}`);
        const counter = () => page.frameLocator("#app").locator("#counter");
        const sharedCounter = () =>
          page.frameLocator("#app").locator("#shared-counter");
        await counter().waitFor();
        await sharedCounter().waitFor();
        await page.waitForFunction(
          () => {
            const bridge = window.__bridge;
            return (
              bridge.stored.bootedBeforeInit === true &&
              bridge.logs.some((entry) =>
                entry.message.includes("boot warning"),
              ) &&
              bridge.lastOrigin === "null" &&
              bridge.snapshotNonce !== null &&
              bridge.actions.some((action) => action.name === "seedScenario") &&
              bridge.sharedStored.count === 4 &&
              bridge.ignored > 0
            );
          },
        );
        const baselineWrites = await page.evaluate(
          () => window.__bridge.writes,
        );
        const initialFrame = page.frame({ name: "app" });
        if (!initialFrame) throw new Error("App iframe was not mounted");
        await page.evaluate(
          ({ protocol, version, type }) => {
            const frame = document.querySelector(
              "#app",
            ) as HTMLIFrameElement | null;
            frame?.contentWindow?.postMessage(
              {
                protocol,
                version,
                nonce: window.__bridge.snapshotNonce,
                type,
                requestId: "opaque-dom",
                maxWidth: 120,
                width: 600,
                height: 400,
              },
              "*",
            );
          },
          {
            protocol: APP_STATE_PROTOCOL,
            version: APP_STATE_PROTOCOL_VERSION,
            type: APP_SNAPSHOT_REQUEST_TYPE,
          },
        );
        await page.waitForFunction(
          () =>
            window.__bridge.snapshotResult?.requestId === "opaque-dom" &&
            window.__bridge.snapshotResult.dataUrl?.startsWith(
              "data:image/jpeg;base64,",
            ),
        );
        await page
          .frameLocator("#app")
          .locator(
            'body[data-snapshot-width="120"][data-snapshot-height="80"]' +
              '[data-snapshot-transform="scale(0.2)"]' +
              '[data-snapshot-source-width="600px"]' +
              '[data-snapshot-source-height="400px"]',
          )
          .waitFor();
        const postChange = async (
          frame: NonNullable<typeof initialFrame>,
          nonce: string | undefined,
          patch: Record<string, unknown>,
        ) => {
          await frame.evaluate(
            ({ protocol, version, nonce: messageNonce, patch: messagePatch }) => {
              parent.postMessage(
                {
                  protocol,
                  version,
                  ...(messageNonce === undefined
                    ? {}
                    : { nonce: messageNonce }),
                  type: "change",
                  patch: messagePatch,
                },
                "*",
              );
            },
            {
              protocol: APP_STATE_PROTOCOL,
              version: APP_STATE_PROTOCOL_VERSION,
              nonce,
              patch,
            },
          );
        };
        await postChange(initialFrame, undefined, { missingNonce: true });
        await postChange(initialFrame, "mismatched-nonce", {
          mismatchedNonce: true,
        });
        await page.waitForFunction(
          () => window.__bridge.nonceDrops === 2,
        );
        await page
          .frameLocator("#app")
          .locator('#shared-counter[data-count="4"]')
          .waitFor();
        await page.evaluate(() =>
          window.__bridge.invokeAction("seedScenario", { clues: 5 }),
        );
        await page.waitForFunction(() => {
          const result = window.__bridge.actionResult;
          const payload = result?.result as
           | { seededClues?: number }
           | undefined;
          return (
           result?.requestId === "request-1" &&
           result.ok === true &&
           payload?.seededClues === 5
          );
        });
        await page
          .frameLocator("#app")
          .locator('#counter[data-seeded="5"]')
          .waitFor();
        await page
          .frameLocator("#app")
          .locator("#presence")
          .filter({ hasText: "First,Second" })
          .waitFor();
        await sharedCounter().click();
        await page.waitForFunction(() => {
          const bridge = window.__bridge;
          return bridge.sharedStored.count === 5 && bridge.sharedWrites === 1;
        });
        await page.evaluate(() => window.__bridge.pushShared({ count: 8 }));
        await page
          .frameLocator("#app")
          .locator('#shared-counter[data-count="8"]')
          .waitFor();

        await counter().click();
        await counter().click();
        await page.waitForFunction(
          (writes) => {
            const bridge = window.__bridge;
            return bridge.stored.count === 2 && bridge.writes === writes + 1;
          },
          baselineWrites,
        );

        const preReloadNonce = await page.evaluate(
          () => window.__bridge.activeNonce,
        );
        await page.locator("#refresh").click();
        await page
          .frameLocator("#app")
          .locator('#counter[data-count="2"]')
          .waitFor();
        await page.waitForFunction(
          (nonce) =>
            window.__bridge.activeNonce !== null &&
            window.__bridge.activeNonce !== nonce,
          preReloadNonce,
        );
        const reloadedFrame = page.frame({ name: "app" });
        if (!reloadedFrame) throw new Error("Reloaded app iframe was not mounted");
        await postChange(reloadedFrame, preReloadNonce ?? undefined, {
          staleAfterReload: true,
        });
        await page.waitForFunction(
          () => window.__bridge.nonceDrops === 3,
        );
        const stored = await page.evaluate(
          () => window.__bridge.stored,
        );
        expect(stored).toMatchObject({
          count: 2,
          restoredByHost: true,
          bootedBeforeInit: true,
        });
        expect(stored).not.toHaveProperty("missingNonce");
        expect(stored).not.toHaveProperty("mismatchedNonce");
        expect(stored).not.toHaveProperty("staleAfterReload");
      } finally {
        await browser.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    BROWSER_E2E_TIMEOUT_MS,
  );

  test.runIf(runBrowserE2e)(
    "round-trips character.say and judge through a fake host: gesture, busy, timeout, onLine, context",
    async () => {
      const appHtml = injectAppStateSdk(`<!doctype html>
<html>
  <body>
    <button id="talk">Talk</button>
    <button id="judge">Judge</button>
    <ul id="lines"></ul>
    <script>
      let calls = 0;
      const record = (promise) => {
        const key = "r" + ++calls;
        promise.then(
          (value) => {
            document.body.dataset[key] =
              "ok:" + (value.line ?? value.verdict) + ":" + (value.mood ?? value.feedback ?? "");
          },
          (error) => {
            document.body.dataset[key] = "err:" + error.code;
          },
        );
      };
      rabbithole.character.say("too early").then(
        () => { document.body.dataset.preGesture = "resolved"; },
        (error) => { document.body.dataset.preGesture = error.code; },
      );
      rabbithole.character.say("   ").catch((error) => {
        document.body.dataset.empty = error.code;
      });
      rabbithole.character.onLine((line) => {
        const item = document.createElement("li");
        item.textContent = line.line + "/" + (line.mood || "");
        document.querySelector("#lines").append(item);
      });
      document.querySelector("#talk").addEventListener("click", () =>
        record(rabbithole.character.say("  Hello robot  ", { context: { stage: 4, mode: "rule" } })),
      );
      document.querySelector("#judge").addEventListener("click", () =>
        // A function value cannot be cloned; it must not wedge the call.
        record(rabbithole.judge("haiku", "An old silent pond", {
          context: { question: 2, nested: { a: 1 }, skip: () => 1 },
        })),
      );
    </script>
  </body>
</html>`);
      const serializedAppHtml = JSON.stringify(appHtml).replaceAll(
        "</script",
        "<\\/script",
      );
      const hostHtml = `<!doctype html>
<html>
  <body>
    <script>
      const PROTOCOL = ${JSON.stringify(APP_STATE_PROTOCOL)};
      const VERSION = ${APP_STATE_PROTOCOL_VERSION};
      window.__ai = { nonce: null, requests: [] };
      const frame = document.createElement("iframe");
      addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (message?.protocol !== PROTOCOL || message?.version !== VERSION) return;
        if (message.type === "ready") {
          window.__ai.nonce = message.nonce;
          frame.contentWindow.postMessage(
            { protocol: PROTOCOL, version: VERSION, nonce: message.nonce, type: "init", doc: {} },
            "*",
          );
          return;
        }
        if (message.type === "request" && message.nonce === window.__ai.nonce) {
          window.__ai.requests.push(message);
        }
      });
      frame.id = "app";
      frame.sandbox = "allow-scripts";
      frame.srcdoc = ${serializedAppHtml};
      document.body.append(frame);
    </script>
  </body>
</html>`;

      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(hostHtml);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind to a TCP port");
      }

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        // Fake timers so the 20 s request timeout can be fast-forwarded.
        await page.clock.install();
        await page.goto(`http://127.0.0.1:${address.port}`);
        const app = page.frameLocator("#app");
        const body = app.locator("body");
        const requests = () =>
          page.evaluate(() =>
            (window as unknown as { __ai: { requests: Array<Record<string, unknown>> } })
              .__ai.requests,
          );
        const postToFrame = (message: Record<string, unknown>) =>
          page.evaluate((payload) => {
            const frame = document.querySelector("#app") as HTMLIFrameElement;
            frame.contentWindow?.postMessage(payload, "*");
          }, message);
        const nonce = async () => {
          await page.waitForFunction(
            () => (window as unknown as { __ai: { nonce: string | null } }).__ai.nonce !== null,
          );
          return page.evaluate(
            () => (window as unknown as { __ai: { nonce: string } }).__ai.nonce,
          );
        };

        // (b) Before any user gesture, character.say rejects without a request.
        await app.locator('body[data-pre-gesture="needs-gesture"]').waitFor();
        await app.locator('body[data-empty="invalid"]').waitFor();
        const bridgeNonce = await nonce();
        expect(await requests()).toEqual([]);

        // (a) After a click the request reaches the host, parses, and resolves.
        await app.locator("#talk").click();
        await page.waitForFunction(
          () => (window as unknown as { __ai: { requests: unknown[] } }).__ai.requests.length === 1,
        );
        const [first] = await requests();
        expect(parseAppStateBridgeMessage(first)).toEqual({
          type: "request",
          nonce: bridgeNonce,
          requestId: first.requestId,
          method: "character.say",
          params: { text: "Hello robot", context: { stage: 4, mode: "rule" } },
        });
        // (d) A second say while the first is in flight rejects busy, locally.
        await app.locator("#talk").click();
        await app.locator('body[data-r2="err:busy"]').waitFor();
        expect(await requests()).toHaveLength(1);
        await postToFrame(
          createAppBridgeResponseMessage(bridgeNonce, String(first.requestId), {
            ok: true,
            result: { line: "Beep", mood: "happy" },
          }),
        );
        await app.locator('body[data-r1="ok:Beep:happy"]').waitFor();

        // (c) An unanswered request times out; its late response is ignored.
        await app.locator("#talk").click();
        await page.waitForFunction(
          () => (window as unknown as { __ai: { requests: unknown[] } }).__ai.requests.length === 2,
        );
        const second = (await requests())[1];
        await page.clock.runFor(APP_REQUEST_TIMEOUT_MS + 1_000);
        await app.locator('body[data-r3="err:timeout"]').waitFor();
        await postToFrame(
          createAppBridgeResponseMessage(bridgeNonce, String(second.requestId), {
            ok: true,
            result: { line: "Too late", mood: "sad" },
          }),
        );

        // judge rides the same primitive; a host error code reaches the app.
        await app.locator("#judge").click();
        await page.waitForFunction(
          () => (window as unknown as { __ai: { requests: unknown[] } }).__ai.requests.length === 3,
        );
        const third = (await requests())[2];
        // The frame sends a JSON-safe copy; the host parser drops the rest.
        expect(third.params).toEqual({
          judgeId: "haiku",
          answer: "An old silent pond",
          context: { question: 2, nested: { a: 1 } },
        });
        expect(parseAppStateBridgeMessage(third)).toMatchObject({
          method: "judge",
          params: {
            judgeId: "haiku",
            answer: "An old silent pond",
            context: { question: 2 },
          },
        });
        await postToFrame(
          createAppBridgeResponseMessage(bridgeNonce, String(third.requestId), {
            ok: false,
            error: { code: "unavailable", message: "No judge" },
          }),
        );
        await app.locator('body[data-r4="err:unavailable"]').waitFor();
        expect(await body.getAttribute("data-r3")).toBe("err:timeout");

        // (e) onLine fires once per distinct characterLine id.
        const lineOne = { id: "line-1", line: "Psst, try again", mood: "sly" };
        await postToFrame(
          createAppStateHostMessage("update", {}, bridgeNonce, undefined, undefined, lineOne),
        );
        await postToFrame(
          createAppStateHostMessage("update", {}, bridgeNonce, undefined, undefined, lineOne),
        );
        await postToFrame(
          createAppStateHostMessage("update", {}, bridgeNonce, undefined, undefined, {
            id: "line-2",
            line: "Nice!",
          }),
        );
        await app.locator("#lines li").nth(1).waitFor();
        // A forged-nonce line is dropped like any other host message.
        await postToFrame(
          createAppStateHostMessage("update", {}, "forged", undefined, undefined, {
            id: "line-3",
            line: "Forged",
          }),
        );
        await postToFrame(
          createAppStateHostMessage("update", {}, bridgeNonce, undefined, undefined, lineOne),
        );
        // Messages deliver in order, so once line-4 renders the two above
        // have already been processed (and dropped).
        await postToFrame(
          createAppStateHostMessage("update", {}, bridgeNonce, undefined, undefined, {
            id: "line-4",
            line: "Last",
            mood: "calm",
          }),
        );
        await app.locator("#lines li").nth(2).waitFor();
        expect(await app.locator("#lines li").allTextContents()).toEqual([
          "Psst, try again/sly",
          "Nice!/",
          "Last/calm",
        ]);
      } finally {
        await browser.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    BROWSER_E2E_TIMEOUT_MS,
  );
});

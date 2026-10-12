/**
 * Reset (F10 / Play → Reset app state) clears the server-persisted app-state
 * row and remounts the host. The host also flushes pending app-state writes
 * from its unmount cleanup, so without an explicit barrier a debounced patch,
 * a late bridge message, or a failed write restoring its patch could re-persist
 * the exact state the Reset just cleared — right after the clear.
 *
 * `discardPendingAppState` closes that window with a writer EPOCH: it bumps the
 * epoch and pauses writes, so anything enqueued during the discard await, any
 * failed write trying to restore its patch, and the unmount flush are all
 * dropped once the epoch has moved. These tests pin that barrier through the
 * real bridge (a WebView `onMessage`), not a reimplementation of the queue.
 */
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodeArtifactStateScope } from "@/lib/codeArtifactStateScope";
import {
  APP_STATE_PROTOCOL,
  APP_STATE_PROTOCOL_VERSION,
} from "../../../vendor/shared/appStateBridge.mjs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Deferred = {
  args: Record<string, unknown>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const {
  webView,
  sessionWrites,
  updateSessionState,
  injected,
  queryResults,
  appAiSay,
  appAiJudge,
} = vi.hoisted(() => {
  const webView: { props: Record<string, unknown> | null } = { props: null };
  // Scripts the host injects into the page (init/update, request replies).
  const injected: string[] = [];
  // Per-query results; anything absent stays `undefined` (loading).
  const queryResults = new Map<string, unknown>();
  const appAiSay = vi.fn();
  const appAiJudge = vi.fn();
  const sessionWrites: Deferred[] = [];
  const updateSessionState = vi.fn((args: Record<string, unknown>) => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = () => res();
      reject = (error: unknown) => rej(error);
    });
    sessionWrites.push({ args, resolve, reject });
    return promise;
  });
  return {
    webView,
    sessionWrites,
    updateSessionState,
    injected,
    queryResults,
    appAiSay,
    appAiJudge,
  };
});

vi.mock("react-native", () => ({
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    hairlineWidth: 1,
    absoluteFill: {},
  },
  View: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock("react-native-webview", () => ({
  default: (props: Record<string, unknown>) => {
    webView.props = props;
    // React 19 passes `ref` as a prop to function components.
    const ref = props.ref as
      | { current: unknown }
      | ((value: unknown) => void)
      | undefined;
    const instance = {
      injectJavaScript: (script: string) => injected.push(script),
    };
    if (typeof ref === "function") ref(instance);
    else if (ref) ref.current = instance;
    return null;
  },
}));

vi.mock("convex/react", () => ({
  useAction: (ref: string) =>
    ref === "appAiActions.say"
      ? appAiSay
      : ref === "appAiActions.judge"
        ? appAiJudge
        : vi.fn(async () => []),
  useConvex: () => ({}),
  useQuery: (ref: string, args: unknown) =>
    args === "skip" ? undefined : queryResults.get(ref),
  useMutation: (ref: string) =>
    ref === "appStates.updateSessionState"
      ? updateSessionState
      : vi.fn(async () => undefined),
}));

vi.mock("@/lib/convex", () => ({
  api: {
    appStates: {
      getSessionState: "appStates.getSessionState",
      getCustomAppState: "appStates.getCustomAppState",
      getRoomState: "appStates.getRoomState",
      getRoomPresence: "appStates.getRoomPresence",
      updateSessionState: "appStates.updateSessionState",
      updateCustomAppState: "appStates.updateCustomAppState",
      updateRoomState: "appStates.updateRoomState",
      joinRoomPresence: "appStates.joinRoomPresence",
      leaveRoomPresence: "appStates.leaveRoomPresence",
    },
    rooms: { defaultForArtifact: "rooms.defaultForArtifact" },
    appAiActions: {
      say: "appAiActions.say",
      judge: "appAiActions.judge",
    },
    appAssetHostActions: {
      resolveArtifactAssets: "appAssetHostActions.resolveArtifactAssets",
    },
  },
}));

vi.mock("@/lib/appKitAssets", () => ({
  resolveNativeAppKitSource: async () => undefined,
}));

import { CodeArtifactWebView } from "../CodeArtifactWebView";
import type { CodeArtifactWebViewHandle } from "../CodeArtifactWebView";

const scope = {
  kind: "session",
  artifactId: "artifact-1",
} as unknown as CodeArtifactStateScope;

/** The nonce the mounted host will treat as the live bridge session. */
const NONCE = "nonce-1";

function bridge(payload: Record<string, unknown>) {
  return {
    nativeEvent: {
      data: JSON.stringify({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: NONCE,
        ...payload,
      }),
    },
  };
}

async function send(payload: Record<string, unknown>, nonce = NONCE) {
  const onMessage = webView.props?.onMessage as
    | ((event: { nativeEvent: { data: string } }) => void)
    | undefined;
  await act(async () => {
    onMessage?.(bridge({ nonce, ...payload }));
  });
}

/** Mount the host, resolve its async sandbox prep, and open the bridge. */
async function mountHost(
  props: {
    scope?: CodeArtifactStateScope;
    onAppAiTurn?: () => void;
  } = {},
) {
  const handleRef: { current: CodeArtifactWebViewHandle | null } = {
    current: null,
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(CodeArtifactWebView, {
        ref: handleRef,
        scope: props.scope ?? scope,
        onAppAiTurn: props.onAppAiTurn,
        content: "<!doctype html><html><body></body></html>",
      }),
    );
  });
  // The sandbox HTML is prepared asynchronously; let it settle so the WebView
  // (and its onMessage bridge) mounts.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await send({ type: "ready" });
  return { renderer, handleRef };
}

afterEach(() => {
  vi.useRealTimers();
  webView.props = null;
  sessionWrites.length = 0;
  injected.length = 0;
  queryResults.clear();
  vi.clearAllMocks();
});

describe("CodeArtifactWebView — discard epoch barrier", () => {
  it("drops a patch enqueued during the discard await", async () => {
    const { renderer, handleRef } = await mountHost();
    vi.useFakeTimers();

    // A first change flushes to an in-flight (still-pending) write.
    await send({ type: "change", patch: { keep: 1 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sessionWrites).toHaveLength(1);
    expect(sessionWrites[0].args.patch).toEqual({ keep: 1 });

    await act(async () => {
      const discarded = handleRef.current!.discardPendingAppState();
      // Enqueued WHILE the discard is awaiting the in-flight write: must drop.
      await send({ type: "change", patch: { stale: 2 } });
      sessionWrites[0].resolve();
      await discarded;
    });

    // The unmount flush must not resurrect the dropped patch either.
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(sessionWrites).toHaveLength(1);
    expect(sessionWrites[0].args.patch).toEqual({ keep: 1 });
  });

  it("does not restore a patch from a write that fails after discard", async () => {
    const { renderer, handleRef } = await mountHost();
    vi.useFakeTimers();

    await send({ type: "change", patch: { keep: 1 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sessionWrites).toHaveLength(1);

    await act(async () => {
      const discarded = handleRef.current!.discardPendingAppState();
      // The awaited write rejects AFTER the discard bumped the epoch, so its
      // failure-restore is stale and must be dropped, not re-queued.
      sessionWrites[0].reject(new Error("write failed"));
      await discarded;
    });

    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Only the original (failed) attempt — no restored re-write.
    expect(sessionWrites).toHaveLength(1);
  });

  it("writes nothing from the unmount flush after a discard", async () => {
    const { renderer, handleRef } = await mountHost();

    // Pending, but never flushed (no timer advance) before the discard.
    await send({ type: "change", patch: { keep: 1 } });

    await act(async () => {
      await handleRef.current!.discardPendingAppState();
    });

    // A late bridge patch after the discard is paused out, so the unmount
    // flush has nothing to persist.
    await send({ type: "change", patch: { late: 2 } });
    await act(async () => {
      renderer.unmount();
    });

    expect(sessionWrites).toHaveLength(0);
  });

  it("still flushes pending state on unmount without a discard", async () => {
    const { renderer } = await mountHost();

    await send({ type: "change", patch: { keep: 1 } });
    await act(async () => {
      renderer.unmount();
    });

    expect(sessionWrites).toHaveLength(1);
    expect(sessionWrites[0].args.patch).toEqual({ keep: 1 });
  });
});

/** The message carried by each `__rabbitholeReceive(...)` injection. */
function received(): Array<Record<string, unknown>> {
  return injected.flatMap((script) => {
    const match = /^window\.__rabbitholeReceive\?\.\((.*)\);true;$/s.exec(
      script,
    );
    return match ? [JSON.parse(match[1]) as Record<string, unknown>] : [];
  });
}

const responses = () => received().filter((m) => m.type === "response");

/** Let the reply chain (action → route → inject) settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("CodeArtifactWebView — app AI requests", () => {
  it("answers a character request from the session action and reports the turn", async () => {
    appAiSay.mockResolvedValue({
      ok: true,
      line: "I walk into the wall.",
      mood: "confused",
      turnId: "turn-1",
    });
    const onAppAiTurn = vi.fn();
    await mountHost({ onAppAiTurn });
    await send({
      type: "request",
      requestId: "q1",
      method: "character.say",
      params: { text: "Walk forward" },
    });
    await settle();

    expect(appAiSay).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      text: "Walk forward",
    });
    expect(responses()).toEqual([
      expect.objectContaining({
        nonce: NONCE,
        requestId: "q1",
        ok: true,
        result: { line: "I walk into the wall.", mood: "confused" },
      }),
    ]);
    expect(onAppAiTurn).toHaveBeenCalledTimes(1);
  });

  it("forwards the app's normalized context to both actions", async () => {
    appAiSay.mockResolvedValue({ ok: true, line: "Noted.", mood: "calm", turnId: "t" });
    appAiJudge.mockResolvedValue({ ok: true, verdict: "clear", turnId: "t" });
    await mountHost();
    await send({
      type: "request",
      requestId: "q5",
      method: "character.say",
      params: { text: "Turn left", context: { stage: 4, mode: "rule", junk: { a: 1 } } },
    });
    await send({
      type: "request",
      requestId: "q6",
      method: "judge",
      params: { judgeId: "clarity", answer: "Left", context: { question: 3 } },
    });
    await settle();

    expect(appAiSay).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      text: "Turn left",
      context: { stage: 4, mode: "rule" },
    });
    expect(appAiJudge).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      judgeId: "clarity",
      answer: "Left",
      context: { question: 3 },
    });
  });

  it("passes a judge failure code through and does not report a turn", async () => {
    appAiJudge.mockResolvedValue({ ok: false, code: "busy", retryAfterSec: 30 });
    const onAppAiTurn = vi.fn();
    await mountHost({ onAppAiTurn });
    await send({
      type: "request",
      requestId: "q2",
      method: "judge",
      params: { judgeId: "clarity", answer: "Step left" },
    });
    await settle();

    expect(appAiJudge).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      judgeId: "clarity",
      answer: "Step left",
    });
    expect(responses()).toEqual([
      expect.objectContaining({
        requestId: "q2",
        ok: false,
        error: expect.objectContaining({ code: "busy" }),
      }),
    ]);
    expect(onAppAiTurn).not.toHaveBeenCalled();
  });

  it("drops a reply that arrives after the page reloaded", async () => {
    let resolve!: (value: unknown) => void;
    appAiSay.mockReturnValue(new Promise((done) => (resolve = done)));
    await mountHost();
    await send({
      type: "request",
      requestId: "q3",
      method: "character.say",
      params: { text: "Hello" },
    });
    // The page reloads (fresh SDK, fresh nonce) while the server is thinking.
    await send({ type: "ready" }, "nonce-2");
    resolve({ ok: true, line: "Late", mood: "calm", turnId: "t" });
    await settle();

    expect(responses()).toEqual([]);
  });

  it("answers unavailable at once for a custom-app tile", async () => {
    await mountHost({
      scope: {
        kind: "customApp",
        token: "token-1",
        stateUserId: "user-1",
        stateKey: "default",
      },
    });
    await send({
      type: "request",
      requestId: "q4",
      method: "character.say",
      params: { text: "Hello" },
    });
    await settle();

    expect(appAiSay).not.toHaveBeenCalled();
    expect(responses()).toEqual([
      expect.objectContaining({
        requestId: "q4",
        ok: false,
        error: expect.objectContaining({ code: "unavailable" }),
      }),
    ]);
  });
});

describe("CodeArtifactWebView — character lines", () => {
  it("delivers the session row's character line on init", async () => {
    queryResults.set("appStates.getSessionState", {
      doc: {},
      actions: [],
      log: [],
      version: 1,
      updatedAt: 1,
      characterLine: {
        id: "line-1",
        line: "Beep. Hello!",
        mood: "happy",
        requestedAt: 1,
      },
    });
    await mountHost();

    expect(received().find((m) => m.type === "init")).toMatchObject({
      characterLine: { id: "line-1", line: "Beep. Hello!", mood: "happy" },
    });
  });
});

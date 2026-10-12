// @vitest-environment jsdom
// Host half of the bridge's request/response pair, driven through the real
// hook: a frame `request` reaches `onRequest`, the reply is posted back to the
// frame under the same nonce, a reply for a reloaded frame is dropped, and a
// host with no handler (a custom-app tile) answers `unavailable` at once. The
// in-frame SDK half is covered by lib/__tests__/appStateBridge.test.ts.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  APP_STATE_PROTOCOL,
  APP_STATE_PROTOCOL_VERSION,
} from "@/lib/appStateBridge.mjs";
import type { AppBridgeResponsePayload } from "@/shared/appAiPolicy";
import {
  useAppStateIframeBridge,
  type AppBridgeRequestHandler,
} from "../useAppStateIframeBridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Snapshot = Parameters<typeof useAppStateIframeBridge>[0]["snapshot"];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

type HostProps = {
  snapshot: Snapshot;
  onRequest?: AppBridgeRequestHandler;
  onAppAiTurn?: () => void;
};

function Host({ snapshot, onRequest, onAppAiTurn }: HostProps) {
  const { iframeRef } = useAppStateIframeBridge({
    identity: "session:artifact-1",
    snapshot,
    persist: async () => undefined,
    onRequest,
    onAppAiTurn,
  });
  return createElement("iframe", { ref: iframeRef });
}

async function mount(props: HostProps) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(createElement(Host, props));
  });
  const frame = container.querySelector("iframe")!.contentWindow!;
  const posted: Array<Record<string, unknown>> = [];
  vi.spyOn(frame, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message as Record<string, unknown>);
  });
  const fromFrame = async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame,
          data: {
            protocol: APP_STATE_PROTOCOL,
            version: APP_STATE_PROTOCOL_VERSION,
            ...data,
          },
        }),
      );
      await Promise.resolve();
    });
  };
  const rerender = async (next: HostProps) => {
    await act(async () => {
      mounted.render(createElement(Host, next));
    });
  };
  return { posted, fromFrame, rerender };
}

const sayRequest = (nonce: string, requestId = "q1") => ({
  nonce,
  type: "request",
  requestId,
  method: "character.say",
  params: { text: "  Walk forward  " },
});

const responses = (posted: Array<Record<string, unknown>>) =>
  posted.filter((message) => message.type === "response");

/** Let the reply chain (handler → catch → then) settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useAppStateIframeBridge requests", () => {
  test("routes a request to onRequest and posts the reply to the frame", async () => {
    const onRequest = vi.fn<AppBridgeRequestHandler>(async () => ({
      ok: true,
      result: { line: "I walk into the wall.", mood: "confused" },
    }));
    const { posted, fromFrame } = await mount({ snapshot: null, onRequest });
    await fromFrame({ nonce: "n1", type: "ready" });
    await fromFrame(sayRequest("n1"));
    await settle();

    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "character.say",
        requestId: "q1",
        params: { text: "Walk forward" },
      }),
    );
    expect(responses(posted)).toEqual([
      expect.objectContaining({
        nonce: "n1",
        requestId: "q1",
        ok: true,
        result: { line: "I walk into the wall.", mood: "confused" },
      }),
    ]);
  });

  test("hands onRequest the normalized app context", async () => {
    const onRequest = vi.fn<AppBridgeRequestHandler>(async () => ({
      ok: true,
      result: { verdict: "clear" },
    }));
    const { fromFrame } = await mount({ snapshot: null, onRequest });
    await fromFrame({ nonce: "n1", type: "ready" });
    await fromFrame({
      nonce: "n1",
      type: "request",
      requestId: "q3",
      method: "judge",
      params: {
        judgeId: "clarity",
        answer: "Left",
        context: { question: 3, "not a key": 1, nested: { a: 1 } },
      },
    });
    await settle();
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { judgeId: "clarity", answer: "Left", context: { question: 3 } },
      }),
    );
  });

  test("ignores a request carrying a nonce other than the active one", async () => {
    const onRequest = vi.fn<AppBridgeRequestHandler>();
    const { posted, fromFrame } = await mount({ snapshot: null, onRequest });
    await fromFrame({ nonce: "n1", type: "ready" });
    await fromFrame(sayRequest("forged"));
    await settle();
    expect(onRequest).not.toHaveBeenCalled();
    expect(responses(posted)).toEqual([]);
  });

  test("drops a reply that arrives after the frame reloaded", async () => {
    let resolve!: (payload: AppBridgeResponsePayload) => void;
    const onRequest = vi.fn<AppBridgeRequestHandler>(
      () => new Promise((done) => (resolve = done)),
    );
    const { posted, fromFrame } = await mount({ snapshot: null, onRequest });
    await fromFrame({ nonce: "n1", type: "ready" });
    await fromFrame(sayRequest("n1"));
    // The frame reloads while the server is still thinking.
    await fromFrame({ nonce: "n2", type: "ready" });
    resolve({ ok: true, result: { line: "Late", mood: "calm" } });
    await settle();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(responses(posted)).toEqual([]);
  });

  test("a host without a handler answers unavailable at once", async () => {
    const { posted, fromFrame } = await mount({ snapshot: null });
    await fromFrame({ nonce: "n1", type: "ready" });
    await fromFrame({
      nonce: "n1",
      type: "request",
      requestId: "q2",
      method: "judge",
      params: { judgeId: "clarity", answer: "Step left" },
    });
    await settle();
    expect(responses(posted)).toEqual([
      expect.objectContaining({
        nonce: "n1",
        requestId: "q2",
        ok: false,
        error: expect.objectContaining({ code: "unavailable" }),
      }),
    ]);
  });

  test("tells the tutor only about a success the app received", async () => {
    let resolveLate!: (payload: AppBridgeResponsePayload) => void;
    const replies: Array<() => Promise<AppBridgeResponsePayload>> = [
      async () => ({ ok: true, result: { line: "Hi", mood: "calm" } }),
      // The host already gave up: the router answers timeout.
      async () => ({
        ok: false,
        error: { code: "timeout", message: "That took too long. Try again." },
      }),
      () => new Promise((done) => (resolveLate = done)),
    ];
    const onAppAiTurn = vi.fn();
    const { posted, fromFrame } = await mount({
      snapshot: null,
      onRequest: () => replies.shift()!(),
      onAppAiTurn,
    });
    await fromFrame({ nonce: "n1", type: "ready" });
    await fromFrame(sayRequest("n1", "q1"));
    await settle();
    expect(onAppAiTurn).toHaveBeenCalledTimes(1);

    await fromFrame(sayRequest("n1", "q2"));
    await settle();
    expect(onAppAiTurn).toHaveBeenCalledTimes(1);

    // A success for a frame that reloaded meanwhile is dropped, unreported.
    await fromFrame(sayRequest("n1", "q3"));
    await fromFrame({ nonce: "n2", type: "ready" });
    resolveLate({ ok: true, result: { line: "Late", mood: "calm" } });
    await settle();
    expect(onAppAiTurn).toHaveBeenCalledTimes(1);
    expect(responses(posted).map((r) => r.requestId)).toEqual(["q1", "q2"]);
  });

  test("a rejecting handler answers failed instead of leaving the app waiting", async () => {
    const { posted, fromFrame } = await mount({
      snapshot: null,
      onRequest: async () => {
        throw new Error("boom");
      },
    });
    await fromFrame({ nonce: "n1", type: "ready" });
    await fromFrame(sayRequest("n1"));
    await settle();
    expect(responses(posted)).toEqual([
      expect.objectContaining({
        requestId: "q1",
        ok: false,
        error: expect.objectContaining({ code: "failed" }),
      }),
    ]);
  });
});

describe("useAppStateIframeBridge character lines", () => {
  const base = { doc: {}, actions: [], version: 3, updatedAt: 100 };

  test("carries the row's character line on init and on a new line", async () => {
    const first = {
      ...base,
      characterLine: { id: "line-1", line: "Hello!", mood: "happy" },
    };
    const { posted, fromFrame, rerender } = await mount({ snapshot: first });
    await fromFrame({ nonce: "n1", type: "ready" });
    expect(posted.at(-1)).toMatchObject({
      type: "init",
      characterLine: { id: "line-1", line: "Hello!", mood: "happy" },
    });

    // A new line on an otherwise unchanged row version still reaches the app.
    await rerender({
      snapshot: { ...base, characterLine: { id: "line-2", line: "Try again" } },
    });
    expect(posted.at(-1)).toMatchObject({
      type: "update",
      characterLine: { id: "line-2", line: "Try again" },
    });
  });
});

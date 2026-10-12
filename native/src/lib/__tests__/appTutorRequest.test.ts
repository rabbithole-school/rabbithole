import { describe, expect, test, vi } from "vitest";

import { deliverAppBridgeReply } from "../../../vendor/shared/appBridgeRequest";
import {
  APP_TUTOR_BUSY_RETRY_MS,
  createAppTutorUpdateQueue,
  forwardAppTutorRequest,
  settleAppTutorSend,
  type AppTutorSendResult,
  type AppTutorUpdateBatch,
} from "../../../vendor/shared/appTutorRequest";
import {
  deriveServerTurnState,
  isQuietAppUpdatePlaceholder,
} from "../../../vendor/shared/streamRetry";

// The vendored copy is what the iPad runs; the full queue behaviour is tested
// against the source in shared/__tests__. These pin the native-side contract.
describe("native app tutor host gate", () => {
  test("flushes app state before forwarding the request", async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => {
      order.push("handler");
    });

    await expect(
      forwardAppTutorRequest({
        request: { message: "Check my orbit" },
        flush: async () => {
          order.push("flush");
          return true;
        },
        handler,
      }),
    ).resolves.toBe(true);

    expect(order).toEqual(["flush", "handler"]);
  });

  test("an ask arriving mid-reply waits and is delivered after the reply", async () => {
    let streaming = true;
    const sent: AppTutorUpdateBatch[] = [];
    const queue = createAppTutorUpdateQueue({
      isStreaming: () => streaming,
      send: async (batch) => {
        sent.push(batch);
        return "sent";
      },
    });

    queue.enqueue({ kind: "ask", message: "Check my orbit" });
    queue.enqueue({ kind: "appAi" });
    await expect(queue.drain()).resolves.toBe("streaming");
    streaming = false;
    await expect(queue.drain()).resolves.toBe("sent");
    expect(sent).toEqual([
      { asks: [{ message: "Check my orbit" }], appAi: true },
    ]);
  });

  test("an ask before the scholar's first turn is held, not dropped", async () => {
    const results: AppTutorSendResult[] = ["held", "sent"];
    const send = vi.fn(async () => results.shift() ?? "sent");
    const queue = createAppTutorUpdateQueue({ isStreaming: () => false, send });

    queue.enqueue({ kind: "ask", message: "Check my orbit" });
    await expect(queue.drain()).resolves.toBe("held");
    await expect(queue.drain()).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      asks: [{ message: "Check my orbit" }],
      appAi: false,
    });
  });

  test("a busy server is retried on a timer while the iPad is idle", async () => {
    const results: AppTutorSendResult[] = ["busy", "sent"];
    const send = vi.fn(async () => results.shift() ?? "sent");
    const timers: Array<{ run: () => void; ms: number }> = [];
    const queue = createAppTutorUpdateQueue({
      isStreaming: () => false,
      send,
      schedule: (run, ms) => {
        timers.push({ run, ms });
        return () => {};
      },
    });

    queue.enqueue({ kind: "ask", message: "Check my orbit" });
    await expect(queue.drain()).resolves.toBe("busy");
    expect(timers.map((t) => t.ms)).toEqual([APP_TUTOR_BUSY_RETRY_MS]);
    timers[0].run();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  test("the tutor hears only about a success the WebView received", () => {
    const ok = { ok: true, result: { line: "Hi", mood: "calm" } } as const;
    const onAppAiTurn = vi.fn();
    const post = vi.fn();
    deliverAppBridgeReply(ok, { isCurrent: () => false, post, onAppAiTurn });
    deliverAppBridgeReply(
      { ok: false, error: { code: "timeout", message: "Too long" } },
      { isCurrent: () => true, post, onAppAiTurn },
    );
    expect(onAppAiTurn).not.toHaveBeenCalled();
    deliverAppBridgeReply(ok, { isCurrent: () => true, post, onAppAiTurn });
    expect(onAppAiTurn).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
  });

  test("a host that bails before its mutation keeps the update queued", async () => {
    await expect(settleAppTutorSend(async () => false)).resolves.toBe("busy");
  });

  test("a quiet app-update placeholder shows no pending state", () => {
    const placeholder = {
      role: "assistant",
      content: "",
      streamId: "s1",
      createdAt: 0,
      streamTrigger: "appUpdate" as const,
    };
    expect(isQuietAppUpdatePlaceholder(placeholder)).toBe(true);
    expect(deriveServerTurnState(placeholder, 1_000)).toBe("idle");
  });
});

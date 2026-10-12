import { afterEach, describe, expect, test, vi } from "vitest";

import { APP_REQUEST_TIMEOUT_MS } from "../appAiPolicy";
import {
  APP_HOST_REQUEST_TIMEOUT_MS,
  deliverAppBridgeReply,
  routeAppBridgeRequest,
  type AppBridgeRequest,
  type SayResult,
} from "../appBridgeRequest";

const say: AppBridgeRequest = {
  method: "character.say",
  params: { text: "Walk forward" },
};
const judge: AppBridgeRequest = {
  method: "judge",
  params: { judgeId: "clarity", answer: "Step left twice" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("routeAppBridgeRequest", () => {
  test("a missing handler answers unavailable without calling anything", async () => {
    const judgeHandler = vi.fn();
    expect(await routeAppBridgeRequest(say, { judge: judgeHandler })).toEqual({
      ok: false,
      error: { code: "unavailable", message: expect.any(String) },
    });
    expect(await routeAppBridgeRequest(judge, {})).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(judgeHandler).not.toHaveBeenCalled();
  });

  test("a character reply reaches the app without server-only fields", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      line: "I walk into the wall.",
      mood: "confused",
      turnId: "turn-1",
    }));
    expect(await routeAppBridgeRequest(say, { say: handler })).toEqual({
      ok: true,
      result: { line: "I walk into the wall.", mood: "confused" },
    });
    // An app that sends no context gets none passed on.
    expect(handler).toHaveBeenCalledWith("Walk forward", undefined);
  });

  test("the app context reaches both handlers unchanged", async () => {
    const sayHandler = vi.fn(async () => ({
      ok: true as const,
      line: "Rule noted.",
      mood: "calm",
      turnId: "t",
    }));
    const judgeHandler = vi.fn(async () => ({
      ok: true as const,
      verdict: "clear",
      turnId: "t",
    }));
    await routeAppBridgeRequest(
      { method: "character.say", params: { text: "Turn left", context: { stage: 4, mode: "rule" } } },
      { say: sayHandler },
    );
    await routeAppBridgeRequest(
      { method: "judge", params: { judgeId: "clarity", answer: "Left", context: { question: 3 } } },
      { judge: judgeHandler },
    );
    expect(sayHandler).toHaveBeenCalledWith("Turn left", { stage: 4, mode: "rule" });
    expect(judgeHandler).toHaveBeenCalledWith("clarity", "Left", { question: 3 });
  });

  test("a character verdict is passed through when present", async () => {
    const payload = await routeAppBridgeRequest(say, {
      say: async () => ({
        ok: true,
        line: "Done!",
        mood: "proud",
        verdict: "success",
        turnId: "turn-2",
      }),
    });
    expect(payload).toEqual({
      ok: true,
      result: { line: "Done!", mood: "proud", verdict: "success" },
    });
  });

  test("a judgment reaches the app without server-only fields", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      verdict: "clear",
      feedback: "Every step names a direction.",
      turnId: "turn-3",
    }));
    expect(await routeAppBridgeRequest(judge, { judge: handler })).toEqual({
      ok: true,
      result: { verdict: "clear", feedback: "Every step names a direction." },
    });
    expect(handler).toHaveBeenCalledWith("clarity", "Step left twice", undefined);

    expect(
      await routeAppBridgeRequest(judge, {
        judge: async () => ({ ok: true, verdict: "unclear", turnId: "t" }),
      }),
    ).toEqual({ ok: true, result: { verdict: "unclear" } });
  });

  test.each(["unavailable", "busy", "timeout", "invalid", "failed"] as const)(
    "a server %s failure keeps its code",
    async (code) => {
      const payload = await routeAppBridgeRequest(judge, {
        judge: async () => ({ ok: false, code }),
      });
      expect(payload).toEqual({
        ok: false,
        error: { code, message: expect.any(String) },
      });
    },
  );

  test("a busy failure with a retry hint says when to try again", async () => {
    const withHint = await routeAppBridgeRequest(say, {
      say: async () => ({ ok: false, code: "busy", retryAfterSec: 41.2 }),
    });
    const withoutHint = await routeAppBridgeRequest(say, {
      say: async () => ({ ok: false, code: "busy" }),
    });
    if (withHint.ok || withoutHint.ok) throw new Error("expected failures");
    expect(withHint.error.code).toBe("busy");
    expect(withHint.error.message).toMatch(/42/);
    expect(withoutHint.error.message).not.toMatch(/\d/);
  });

  test("a thrown or rejected handler answers failed", async () => {
    expect(
      await routeAppBridgeRequest(say, {
        say: async () => {
          throw new Error("Not authenticated");
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "failed" } });
    expect(
      await routeAppBridgeRequest(say, {
        say: () => {
          throw new Error("sync throw");
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "failed" } });
  });

  test("a call that never settles answers timeout at the host deadline", async () => {
    vi.useFakeTimers();
    const pending = routeAppBridgeRequest(say, {
      say: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(APP_HOST_REQUEST_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  test("the host deadline lands before the SDK's own", () => {
    expect(APP_HOST_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(APP_HOST_REQUEST_TIMEOUT_MS).toBeLessThan(APP_REQUEST_TIMEOUT_MS);
  });
});

describe("deliverAppBridgeReply", () => {
  const ok = {
    ok: true,
    result: { line: "I step left.", mood: "calm" },
  } as const;

  test("a success the app received tells the tutor", () => {
    const post = vi.fn();
    const onAppAiTurn = vi.fn();
    deliverAppBridgeReply(ok, { isCurrent: () => true, post, onAppAiTurn });
    expect(post).toHaveBeenCalledWith(ok);
    expect(onAppAiTurn).toHaveBeenCalledTimes(1);
  });

  test("a success that lands after the host answered timeout never reaches the tutor", async () => {
    vi.useFakeTimers();
    let finish!: (result: SayResult) => void;
    const routed = routeAppBridgeRequest(say, {
      say: () => new Promise((resolve) => (finish = resolve)),
    });
    await vi.advanceTimersByTimeAsync(APP_HOST_REQUEST_TIMEOUT_MS);
    // The server action completes (and records the exchange) after the deadline.
    finish({ ok: true, line: "Too late", mood: "calm", turnId: "t1" });

    const post = vi.fn();
    const onAppAiTurn = vi.fn();
    deliverAppBridgeReply(await routed, {
      isCurrent: () => true,
      post,
      onAppAiTurn,
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "timeout" }),
      }),
    );
    expect(onAppAiTurn).not.toHaveBeenCalled();
  });

  test("a reply for a reloaded frame is dropped and not reported", () => {
    const post = vi.fn();
    const onAppAiTurn = vi.fn();
    deliverAppBridgeReply(ok, { isCurrent: () => false, post, onAppAiTurn });
    expect(post).not.toHaveBeenCalled();
    expect(onAppAiTurn).not.toHaveBeenCalled();
  });
});

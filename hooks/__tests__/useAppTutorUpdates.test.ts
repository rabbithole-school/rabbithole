// @vitest-environment jsdom
// The web binding of the app → tutor queue, driven through the real hook. The
// queue's own behaviour is covered in shared/__tests__/appTutorRequest.test.ts.
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  AppTutorSendResult,
  AppTutorUpdateBatch,
} from "@/shared/appTutorRequest";
import { useAppTutorUpdates, useUnreadTutorLine } from "../useAppTutorUpdates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Updates = ReturnType<typeof useAppTutorUpdates>;
type HostProps = {
  sessionId: string;
  busy: boolean;
  send: (batch: AppTutorUpdateBatch) => Promise<AppTutorSendResult>;
  onUpdates: (updates: Updates) => void;
};

function Host({ sessionId, busy, send, onUpdates }: HostProps) {
  onUpdates(useAppTutorUpdates({ sessionId, enabled: true, busy, send }));
  return null;
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("useAppTutorUpdates", () => {
  test("an update queued for one session never goes out through the next", async () => {
    const sentTo: string[] = [];
    const sendFor = (sessionId: string) =>
      vi.fn(async () => {
        sentTo.push(sessionId);
        return "sent" as const;
      });
    let updates!: Updates;
    const onUpdates = (next: Updates) => {
      updates = next;
    };
    root = createRoot(document.createElement("div"));
    const render = (props: Omit<HostProps, "onUpdates">) =>
      act(async () => {
        root!.render(createElement(Host, { ...props, onUpdates }));
      });

    // A reply is streaming in session A, so the hint tap waits in the queue.
    await render({ sessionId: "A", busy: true, send: sendFor("A") });
    await act(async () => {
      updates.onAskTutor({ message: "Hint please" });
    });

    // The route moves to session B without a remount, and B is idle.
    await render({ sessionId: "B", busy: false, send: sendFor("B") });
    expect(sentTo).toEqual([]);

    // B's own updates still flow.
    await act(async () => {
      updates.onAskTutor({ message: "Another hint" });
    });
    expect(sentTo).toEqual(["B"]);
  });

  test("still delivers after a StrictMode remount", async () => {
    // StrictMode mounts, cleans up, and mounts again. A queue disposed by that
    // cleanup never sends, so the hook must come back with a live one.
    const send = vi.fn(async () => "sent" as const);
    let updates!: Updates;
    root = createRoot(document.createElement("div"));
    await act(async () => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(Host, {
            sessionId: "A",
            busy: false,
            send,
            onUpdates: (next: Updates) => {
              updates = next;
            },
          }),
        ),
      );
    });
    await act(async () => {
      updates.onAppAiTurn();
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

type Line = { id: string; role: string; content: string };
type Unread = ReturnType<typeof useUnreadTutorLine<Line>>;
type StripProps = {
  messages: Line[];
  streaming: boolean;
  onLine: (line: Unread) => void;
};

function Strip({ messages, streaming, onLine }: StripProps) {
  onLine(
    useUnreadTutorLine({ messages, loaded: true, chatOpen: false, streaming }),
  );
  return null;
}

describe("useUnreadTutorLine", () => {
  const first: Line = { id: "t1", role: "assistant", content: "Try a rule." };
  const second: Line = { id: "t2", role: "assistant", content: "Look closer." };

  async function mount() {
    const seen: Unread[] = [];
    root = createRoot(document.createElement("div"));
    const render = (props: Omit<StripProps, "onLine">) =>
      act(async () => {
        root!.render(
          createElement(Strip, { ...props, onLine: (line) => seen.push(line) }),
        );
      });
    return { seen, render, latest: () => seen[seen.length - 1] };
  }

  test("a line read by the scholar's next act never comes back after a silent turn", async () => {
    const { render, latest } = await mount();
    await render({ messages: [first], streaming: false });
    await render({ messages: [first, second], streaming: false });
    expect(latest().unread?.id).toBe("t2");

    // The scholar talks to the character; the host marks the line read.
    await act(async () => latest().markRead());
    expect(latest().unread).toBeNull();

    // The update turn that exchange queued runs and ends in silence.
    await render({ messages: [first, second], streaming: true });
    await render({ messages: [first, second], streaming: false });
    expect(latest().unread).toBeNull();
  });

  test("markRead from an earlier render marks the line on screen now", async () => {
    const { seen, render, latest } = await mount();
    await render({ messages: [first], streaming: false });
    const heldByTheFrame = seen[seen.length - 1].markRead;
    await render({ messages: [first, second], streaming: false });
    expect(latest().unread?.id).toBe("t2");

    await act(async () => heldByTheFrame());
    expect(latest().unread).toBeNull();
  });
});

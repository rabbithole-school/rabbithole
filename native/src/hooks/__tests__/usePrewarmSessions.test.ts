import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { prewarmSessions } from "@/hooks/usePrewarmSessions";

vi.mock("@/lib/convex", () => ({
  api: {
    sessions: { getWithMessages: makeFunctionReference("sessions:getWithMessages") },
  },
}));

// A socket that never connects: the subscribe/unsubscribe bookkeeping under
// test is all client-side, so no backend is needed.
class InertSocket {
  readyState = 0;
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

let client: ConvexReactClient | null = null;
afterEach(() => {
  // Not awaited: close() waits on a socket that never opened.
  void client?.close();
  client = null;
});

function makeClient() {
  client = new ConvexReactClient("https://example-123.convex.cloud", {
    webSocketConstructor: InertSocket as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  });
  return client;
}

// The iPad Home crashed with "Cannot read property 'delete' of undefined" when
// it unmounted while two plate rows pointed at the same session: both
// subscriptions shared one callback, so the second unsubscribe found the
// listener set already gone (see the comment in usePrewarmSessions.ts).
describe("prewarmSessions", () => {
  it("tears down cleanly when two rows share a session", () => {
    const teardown = prewarmSessions(makeClient(), ["s1", "s2", "s1"]);
    expect(teardown).not.toThrow();
  });

  it("holds one subscription per distinct session", () => {
    const convex = makeClient();
    const watched: unknown[] = [];
    const spy = {
      watchQuery: ((...args: Parameters<ConvexReactClient["watchQuery"]>) => {
        watched.push(args[1]);
        return convex.watchQuery(...args);
      }) as ConvexReactClient["watchQuery"],
    };
    prewarmSessions(spy, ["s1", "s2", "s1"])();
    expect(watched).toEqual([{ id: "s1" }, { id: "s2" }]);
  });
});

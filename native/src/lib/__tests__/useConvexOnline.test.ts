import { createElement, type ElementType } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
  online: false,
  connectDuringSubscribe: false,
  listeners: new Set<() => void>(),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({
    connectionState: () => ({
      isWebSocketConnected: connection.online,
    }),
    subscribeToConnectionState: (listener: () => void) => {
      if (connection.connectDuringSubscribe) {
        connection.connectDuringSubscribe = false;
        connection.online = true;
      }
      connection.listeners.add(listener);
      return () => connection.listeners.delete(listener);
    },
  }),
}));

import { useConvexOnline } from "../useConvexOnline";

const STATUS = "connection-status" as unknown as ElementType;

function Harness() {
  return createElement(STATUS, { online: useConvexOnline() });
}

beforeEach(() => {
  connection.online = false;
  connection.connectDuringSubscribe = false;
  connection.listeners.clear();
});

describe("useConvexOnline", () => {
  it("reconciles a connection that lands between render and subscription", async () => {
    connection.connectDuringSubscribe = true;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(createElement(Harness));
    });
    expect(tree.root.findByType(STATUS).props.online).toBe(true);
    await act(async () => tree.unmount());
  });

  it("tracks later Convex socket transitions", async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(createElement(Harness));
    });
    expect(tree.root.findByType(STATUS).props.online).toBe(false);

    await act(async () => {
      connection.online = true;
      for (const listener of connection.listeners) listener();
    });
    expect(tree.root.findByType(STATUS).props.online).toBe(true);
    await act(async () => tree.unmount());
  });
});

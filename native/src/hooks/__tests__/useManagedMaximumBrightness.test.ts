import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { appStateListeners, setManagedMaximumBrightness } = vi.hoisted(() => ({
  appStateListeners: new Set<(state: string) => void>(),
  setManagedMaximumBrightness: vi.fn(() => Promise.resolve()),
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi.fn(
      (_event: string, listener: (state: string) => void) => {
        appStateListeners.add(listener);
        return { remove: () => appStateListeners.delete(listener) };
      },
    ),
  },
}));

vi.mock("@/lib/singleAppMode", () => ({
  setManagedMaximumBrightness,
}));

import { useManagedMaximumBrightness } from "../useManagedMaximumBrightness";

function Harness({
  enabled,
  lockState,
}: {
  enabled: boolean;
  lockState: boolean;
}) {
  useManagedMaximumBrightness(enabled);
  return createElement("harness", { lockState });
}

describe("useManagedMaximumBrightness", () => {
  beforeEach(() => {
    appStateListeners.clear();
    setManagedMaximumBrightness.mockClear();
  });

  it("does not follow transient ASAM lock-state changes", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(Harness, { enabled: true, lockState: true }));
    });
    expect(setManagedMaximumBrightness).toHaveBeenCalledWith(true);

    setManagedMaximumBrightness.mockClear();
    await act(async () => {
      tree.update(
        createElement(Harness, { enabled: true, lockState: false }),
      );
    });
    expect(setManagedMaximumBrightness).not.toHaveBeenCalled();

    await act(async () => tree.unmount());
    expect(setManagedMaximumBrightness).not.toHaveBeenCalled();
  });

  it("reapplies the configured policy when the app becomes active", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(Harness, { enabled: true, lockState: true }));
    });

    setManagedMaximumBrightness.mockClear();
    for (const listener of appStateListeners) listener("background");
    expect(setManagedMaximumBrightness).not.toHaveBeenCalled();

    for (const listener of appStateListeners) listener("active");
    expect(setManagedMaximumBrightness).toHaveBeenCalledWith(true);

    await act(async () => tree.unmount());
  });

  it("clears stale managed brightness when the MDM gate is disabled", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(Harness, { enabled: false, lockState: false }));
    });

    expect(setManagedMaximumBrightness).toHaveBeenCalledWith(false);
    await act(async () => tree.unmount());
  });

  it("restores brightness only when the managed gate is explicitly disabled", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(Harness, { enabled: true, lockState: true }));
    });

    setManagedMaximumBrightness.mockClear();
    await act(async () => {
      tree.update(
        createElement(Harness, { enabled: false, lockState: false }),
      );
    });

    expect(setManagedMaximumBrightness).toHaveBeenCalledTimes(1);
    expect(setManagedMaximumBrightness).toHaveBeenCalledWith(false);
    await act(async () => tree.unmount());
  });
});

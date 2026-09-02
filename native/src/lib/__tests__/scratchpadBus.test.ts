import { afterEach, describe, expect, it, vi } from "vitest";

import { scratchpadBus } from "../scratchpadBus";

describe("scratchpad capture provider lifecycle", () => {
  afterEach(() => {
    scratchpadBus.cancelTarget();
    scratchpadBus.setCaptureProvider(null);
  });

  it("degrades silent capture to null when no global scratchpad host is mounted", async () => {
    await expect(scratchpadBus.requestCapture()).resolves.toBeNull();
  });

  it("does not let an unmounting prior host clear the current capture provider", async () => {
    const prior = vi.fn(async () => ({ uri: "file:///prior.png", mime: "image/png" }));
    const current = vi.fn(async () => ({ uri: "file:///current.png", mime: "image/png" }));
    scratchpadBus.setCaptureProvider(prior);
    scratchpadBus.setCaptureProvider(current);

    scratchpadBus.setCaptureProvider(null, prior);

    await expect(scratchpadBus.requestCapture()).resolves.toEqual({
      uri: "file:///current.png",
      mime: "image/png",
    });
    expect(prior).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it("notifies a pending one-shot target when the scratchpad closes", () => {
    const onCancel = vi.fn();
    const target = {
      primaryLabel: "Insert sketch",
      onCapture: vi.fn(),
      onCancel,
    };
    scratchpadBus.setTarget(target);

    scratchpadBus.close();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(scratchpadBus.getTarget()).toBeNull();
  });
});

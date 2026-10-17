import { describe, expect, it, vi } from "vitest";

import { enterFullscreen, exitFullscreen, fullscreenElementOf } from "./fullscreen";

describe("enterFullscreen", () => {
  it("uses the standard API when present", async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const webkitRequestFullscreen = vi.fn();
    await expect(
      enterFullscreen({ requestFullscreen, webkitRequestFullscreen }),
    ).resolves.toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(webkitRequestFullscreen).not.toHaveBeenCalled();
  });

  it("falls back to Safari's prefixed API", async () => {
    const webkitRequestFullscreen = vi.fn();
    await expect(enterFullscreen({ webkitRequestFullscreen })).resolves.toBe(true);
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
  });

  it("reports false when the browser has no API or refuses", async () => {
    await expect(enterFullscreen({})).resolves.toBe(false);
    await expect(
      enterFullscreen({
        requestFullscreen: () => Promise.reject(new Error("denied")),
      }),
    ).resolves.toBe(false);
  });
});

describe("exitFullscreen", () => {
  it("does nothing when the page is not full screen", async () => {
    const exit = vi.fn(async () => undefined);
    await exitFullscreen({ fullscreenElement: null, exitFullscreen: exit });
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits through whichever API the browser has", async () => {
    const exit = vi.fn(async () => undefined);
    await exitFullscreen({ fullscreenElement: {}, exitFullscreen: exit });
    expect(exit).toHaveBeenCalledOnce();

    const webkitExit = vi.fn();
    await exitFullscreen({ webkitFullscreenElement: {}, webkitExitFullscreen: webkitExit });
    expect(webkitExit).toHaveBeenCalledOnce();
  });

  it("reads the prefixed element too", () => {
    const el = {};
    expect(fullscreenElementOf({ webkitFullscreenElement: el })).toBe(el);
    expect(fullscreenElementOf({})).toBeNull();
  });
});

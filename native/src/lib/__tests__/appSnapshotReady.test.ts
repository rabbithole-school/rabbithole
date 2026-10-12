import { describe, expect, it, vi } from "vitest";

import { waitForAppSnapshotReady } from "../appSnapshotReady";

function frameQueue() {
  const callbacks: Array<() => void> = [];
  return {
    requestFrame: (callback: () => void) => callbacks.push(callback),
    flush: () => callbacks.shift()?.(),
    size: () => callbacks.length,
  };
}

describe("waitForAppSnapshotReady", () => {
  it("waits for both a newer settled load and a different nonce after an edit", async () => {
    let readiness = { loadVersion: 3, nonce: "old-nonce" as string | null };
    const frames = frameQueue();
    const resolved = vi.fn();

    const result = waitForAppSnapshotReady({
      afterLoad: { loadVersion: 3, nonce: "old-nonce" },
      deadlineAt: 100,
      current: () => readiness,
      now: () => 0,
      requestFrame: frames.requestFrame,
    }).then(resolved);

    expect(frames.size()).toBe(1);
    readiness = { loadVersion: 4, nonce: "old-nonce" };
    frames.flush();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    readiness = { loadVersion: 4, nonce: "new-nonce" };
    frames.flush();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    frames.flush();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    frames.flush();
    await result;
    expect(resolved).toHaveBeenCalledWith(true);
  });

  it("resolves after the first settled load when there is no edit boundary", async () => {
    let readiness = { loadVersion: 0, nonce: null as string | null };
    const frames = frameQueue();
    const resolved = vi.fn();

    const result = waitForAppSnapshotReady({
      deadlineAt: 100,
      current: () => readiness,
      now: () => 0,
      requestFrame: frames.requestFrame,
    }).then(resolved);

    readiness = { loadVersion: 1, nonce: "first-nonce" };
    frames.flush();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    frames.flush();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    frames.flush();
    await result;
    expect(resolved).toHaveBeenCalledWith(true);
  });

  it("restarts the stability wait when a second WebView load begins", async () => {
    let readiness = { loadVersion: 0, nonce: null as string | null };
    const frames = frameQueue();
    const resolved = vi.fn();

    const result = waitForAppSnapshotReady({
      deadlineAt: 100,
      current: () => readiness,
      now: () => 0,
      requestFrame: frames.requestFrame,
    }).then(resolved);

    readiness = { loadVersion: 1, nonce: "first" };
    frames.flush();
    readiness = { loadVersion: 1, nonce: null };
    frames.flush();
    readiness = { loadVersion: 2, nonce: "second" };
    frames.flush();
    frames.flush();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    frames.flush();
    await result;
    expect(resolved).toHaveBeenCalledWith(true);
  });

  it("times out when the ready load key never stabilizes", async () => {
    let now = 0;
    let loadVersion = 1;
    const frames = frameQueue();

    const result = waitForAppSnapshotReady({
      deadlineAt: 3,
      current: () => ({
        loadVersion: loadVersion++,
        nonce: `nonce-${loadVersion}`,
      }),
      now: () => now,
      requestFrame: frames.requestFrame,
    });

    expect(frames.size()).toBe(1);
    now = 1;
    frames.flush();
    expect(frames.size()).toBe(1);
    now = 2;
    frames.flush();
    expect(frames.size()).toBe(1);
    now = 3;
    frames.flush();

    await expect(result).resolves.toBe(false);
    expect(frames.size()).toBe(0);
  });
});

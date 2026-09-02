import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * State-machine tests for the native tap-to-hear engine (lib/nativeTTS.ts).
 *
 * The Expo native seams (expo-audio, expo-file-system) and the Convex URL are
 * mocked so the pure transition logic — idle → loading → speaking ⇄ paused,
 * stop() from any state, and generation-token supersede — can run under the
 * repo's node-only vitest harness. What's under test is the state machine and
 * its listener notifications, not the audio plumbing.
 */

const hoisted = vi.hoisted(() => {
  class FakePlayer {
    playing = false;
    private cb: ((s: { playing: boolean; didJustFinish: boolean }) => void) | null = null;
    play() {
      this.playing = true;
      this.cb?.({ playing: true, didJustFinish: false });
    }
    pause() {
      this.playing = false;
    }
    remove() {}
    addListener(
      _event: string,
      cb: (s: { playing: boolean; didJustFinish: boolean }) => void,
    ) {
      this.cb = cb;
      return { remove() {} };
    }
    /** Simulate playback reaching the end. */
    finish() {
      this.cb?.({ playing: false, didJustFinish: true });
    }
  }
  const state = { last: null as FakePlayer | null };
  return { FakePlayer, state };
});

vi.mock("expo-audio", () => ({
  createAudioPlayer: vi.fn(() => {
    const p = new hoisted.FakePlayer();
    hoisted.state.last = p;
    return p;
  }),
  setAudioModeAsync: vi.fn(async () => {}),
}));

vi.mock("expo-file-system/legacy", () => ({
  writeAsStringAsync: vi.fn(async () => {}),
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
}));

vi.mock("@/lib/convex", () => ({ convexSiteUrl: "http://localhost:9999" }));

import { getNativeTTS, type TTSState } from "../nativeTTS";

beforeEach(() => {
  hoisted.state.last = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })),
  );
});

afterEach(() => {
  getNativeTTS().stop(); // reset the module singleton between tests
  vi.unstubAllGlobals();
});

/** speak() resolves once the player is created and playback starts. */
async function speakAndSettle(text: string): Promise<void> {
  await getNativeTTS().speak(text);
}

describe("NativeTTSEngine state machine", () => {
  it("goes idle → loading → speaking on speak(), notifying listeners", async () => {
    const engine = getNativeTTS();
    const seen: TTSState[] = [];
    const unsub = engine.subscribe((s) => seen.push(s));
    await speakAndSettle("Hello there.");
    expect(engine.state).toBe("speaking");
    expect(seen).toEqual(["loading", "speaking"]);
    expect(hoisted.state.last?.playing).toBe(true);
    unsub();
  });

  it("pause() from speaking → paused and pauses the player", async () => {
    const engine = getNativeTTS();
    await speakAndSettle("Read me.");
    engine.pause();
    expect(engine.state).toBe("paused");
    expect(hoisted.state.last?.playing).toBe(false);
  });

  it("resume() from paused → speaking and plays the player", async () => {
    const engine = getNativeTTS();
    await speakAndSettle("Read me.");
    engine.pause();
    engine.resume();
    expect(engine.state).toBe("speaking");
    expect(hoisted.state.last?.playing).toBe(true);
  });

  it("pause() is a no-op unless speaking", async () => {
    const engine = getNativeTTS();
    expect(engine.state).toBe("idle");
    engine.pause();
    expect(engine.state).toBe("idle");
  });

  it("resume() is a no-op unless paused", async () => {
    const engine = getNativeTTS();
    await speakAndSettle("Read me.");
    engine.resume(); // still speaking, not paused
    expect(engine.state).toBe("speaking");
  });

  it("stop() from paused → idle and clears currentText", async () => {
    const engine = getNativeTTS();
    await speakAndSettle("Read me.");
    engine.pause();
    engine.stop();
    expect(engine.state).toBe("idle");
    expect(engine.currentText).toBeNull();
  });

  it("a new speak() while paused supersedes cleanly", async () => {
    const engine = getNativeTTS();
    await speakAndSettle("First utterance.");
    engine.pause();
    expect(engine.state).toBe("paused");
    await speakAndSettle("Second utterance.");
    expect(engine.state).toBe("speaking");
    expect(engine.currentText).toBe("Second utterance.");
    expect(hoisted.state.last?.playing).toBe(true);
  });

  it("didJustFinish drives paused-less playback back to idle", async () => {
    const engine = getNativeTTS();
    await speakAndSettle("All done soon.");
    hoisted.state.last?.finish();
    expect(engine.state).toBe("idle");
    expect(engine.currentText).toBeNull();
  });
});

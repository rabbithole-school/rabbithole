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

/** Let queued fetch/write promises settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("NativeTTSEngine sentence queue (pre-reader voice mode)", () => {
  afterEach(() => {
    getNativeTTS().onIdle = null;
  });

  it("plays enqueued sentences in order, then drains to idle and fires onIdle once", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    engine.enqueue("First sentence here.");
    engine.enqueue("Second sentence here.");
    await flush();
    expect(engine.state).toBe("speaking");
    expect(engine.currentText).toBe("First sentence here.");
    hoisted.state.last?.finish();
    await flush();
    expect(engine.currentText).toBe("Second sentence here.");
    expect(engine.state).toBe("speaking"); // no loading flicker between sentences
    expect(onIdle).not.toHaveBeenCalled();
    hoisted.state.last?.finish();
    await flush();
    expect(engine.state).toBe("idle");
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a sentence enqueued while one plays waits its turn", async () => {
    const engine = getNativeTTS();
    engine.enqueue("Playing right now.");
    await flush();
    const first = hoisted.state.last;
    engine.enqueue("Arrives mid-play.");
    await flush();
    expect(hoisted.state.last).toBe(first); // no second player yet
    first?.finish();
    await flush();
    expect(engine.currentText).toBe("Arrives mid-play.");
  });

  it("stop() mid-queue clears it and never fires onIdle (tap-to-stop)", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    engine.enqueue("One sentence here.");
    engine.enqueue("Two sentence here.");
    await flush();
    const first = hoisted.state.last;
    engine.stop();
    first?.finish(); // a late status event from the torn-down player
    await flush();
    expect(engine.state).toBe("idle");
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("skips a sentence whose /tts fetch fails rather than killing the reply", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        }),
    );
    engine.enqueue("This one fails.");
    engine.enqueue("This one plays.");
    await flush();
    expect(engine.currentText).toBe("This one plays.");
    hoisted.state.last?.finish();
    await flush();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("reports the drained source: a voice reply drains as 'voice'", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    engine.enqueue("A voice loop sentence.");
    await flush();
    hoisted.state.last?.finish();
    await flush();
    expect(onIdle).toHaveBeenCalledWith("voice");
    expect(engine.lastDrainedSource).toBe("voice");
  });

  it("a speak() (tap-to-hear label) drain reports 'label', never 'voice'", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    engine.enqueue("Voice loop sentence one.");
    await flush();
    // The child taps a label mid-reply: speak() stops the reply first.
    await engine.speak("A label read aloud.");
    hoisted.state.last?.finish();
    await flush();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith("label");
    expect(engine.lastDrainedSource).toBe("label");
  });

  it("stop() leaves no drained source, so a stopped reply can't reopen the mic", async () => {
    const engine = getNativeTTS();
    engine.enqueue("Voice loop sentence one.");
    await flush();
    hoisted.state.last?.finish();
    await flush();
    expect(engine.lastDrainedSource).toBe("voice");
    engine.enqueue("Another voice sentence.");
    expect(engine.lastDrainedSource).toBeNull(); // queued again → not drained
    engine.stop();
    expect(engine.lastDrainedSource).toBeNull();
  });

  it("cancelSource('voice') drops an old reply but leaves another source's audio alone", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    engine.enqueue("A label someone tapped.", "label");
    engine.enqueue("Old reply sentence one.");
    engine.enqueue("Old reply sentence two.");
    await flush();
    expect(engine.currentText).toBe("A label someone tapped.");
    engine.cancelSource("voice"); // a new reply starts
    hoisted.state.last?.finish();
    await flush();
    expect(onIdle).toHaveBeenCalledWith("label"); // nothing of the old reply played
  });

  it("cancelSource('voice') on a playing reply stops it without firing onIdle", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    engine.enqueue("Old reply sentence one.");
    engine.enqueue("Old reply sentence two.");
    await flush();
    engine.cancelSource("voice");
    await flush();
    expect(engine.state).toBe("idle");
    expect(onIdle).not.toHaveBeenCalled();
    expect(engine.lastDrainedSource).toBeNull();
  });

  it("a paused reply never drains, so onIdle cannot reopen the mic", async () => {
    const engine = getNativeTTS();
    const onIdle = vi.fn();
    engine.onIdle = onIdle;
    engine.enqueue("Pause me please.");
    await flush();
    engine.pause();
    await flush();
    expect(engine.state).toBe("paused");
    expect(onIdle).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, test, vi } from "vitest";
import { TTSEngine } from "../../hooks/useTTSQueue";

/**
 * Tests the engine's queue/cancellation core — the logic that keeps the
 * voice-first loop honest. The network + Web Audio seams (fetchBuffer /
 * playBuffer) are overridden with instant fakes; what's under test is
 * ordering, stop() semantics, and onIdle firing.
 */

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async () => {
  // The pump loop awaits fetch + play per item; a few microtask/timer
  // turns are enough for the instant fakes to drain.
  for (let i = 0; i < 20; i++) await tick();
};

function makeEngine() {
  const played: string[] = [];
  class TestEngine extends TTSEngine {
    protected override async fetchBuffer(text: string): Promise<AudioBuffer | null> {
      // The buffer just carries its text through to playBuffer.
      return { __text: text } as unknown as AudioBuffer;
    }
    protected override async playBuffer(buffer: AudioBuffer): Promise<void> {
      played.push((buffer as unknown as { __text: string }).__text);
    }
  }
  return { engine: new TestEngine(), played };
}

/**
 * Like makeEngine, but playBuffer BLOCKS until the test releases it — so a
 * sentence can be "in progress" while pause()/resume()/stop() are exercised.
 * (The real pause suspends the AudioContext, which node can't run; here we test
 * the state machine + the onIdle contract that pause must not violate.)
 */
function makeControllableEngine() {
  const played: string[] = [];
  let releaseCurrent: (() => void) | null = null;
  class TestEngine extends TTSEngine {
    protected override async fetchBuffer(text: string): Promise<AudioBuffer | null> {
      return { __text: text } as unknown as AudioBuffer;
    }
    protected override playBuffer(buffer: AudioBuffer): Promise<void> {
      played.push((buffer as unknown as { __text: string }).__text);
      return new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
    }
  }
  return {
    engine: new TestEngine(),
    played,
    /** Finish the sentence currently "playing". */
    release: () => releaseCurrent?.(),
  };
}

const settleUntil = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await tick();
};

function installAudioContext() {
  const instances: FakeAudioContext[] = [];

  class FakeAudioContext {
    state: AudioContextState = "suspended";
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {
      this.state = "running";
    });
    suspend = vi.fn(async () => {
      this.state = "suspended";
    });
    createOscillator = vi.fn(() => ({
      type: "sine",
      frequency: { value: 0 },
      connect: <T>(target: T) => target,
      start: vi.fn(),
      stop: vi.fn(),
    }));
    createGain = vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: <T>(target: T) => target,
    }));

    constructor() {
      instances.push(this);
    }
  }

  vi.stubGlobal("window", {});
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return instances;
}

describe("TTSEngine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("plays enqueued sentences in order and fires onIdle on natural drain", async () => {
    const { engine, played } = makeEngine();
    let idleCount = 0;
    engine.onIdle = () => idleCount++;
    engine.enqueue("First sentence.");
    engine.enqueue("Second sentence.");
    engine.enqueue("Third sentence.");
    await settle();
    expect(played).toEqual(["First sentence.", "Second sentence.", "Third sentence."]);
    expect(idleCount).toBe(1);
    expect(engine.state).toBe("idle");
  });

  test("stop() clears the queue and suppresses onIdle (no phantom auto-listen)", async () => {
    const { engine, played } = makeEngine();
    let idleCount = 0;
    engine.onIdle = () => idleCount++;
    engine.enqueue("One.");
    engine.stop();
    await settle();
    expect(played).toEqual([]);
    expect(idleCount).toBe(0);
    expect(engine.state).toBe("idle");
  });

  test("enqueue after stop() starts a fresh utterance that plays", async () => {
    const { engine, played } = makeEngine();
    engine.enqueue("Doomed sentence.");
    engine.stop();
    engine.enqueue("Fresh sentence arrives.");
    await settle();
    expect(played).toEqual(["Fresh sentence arrives."]);
  });

  test("speak() replaces whatever was queued and splits into sentences", async () => {
    const { engine, played } = makeEngine();
    engine.enqueue("Old queued sentence.");
    engine.speak("New thing to say. It has two sentences.");
    await settle();
    expect(played).toEqual(["New thing to say.", "It has two sentences."]);
  });

  test("blank sentences are dropped, not fetched", async () => {
    const { engine, played } = makeEngine();
    engine.enqueue("   ");
    engine.enqueue("");
    await settle();
    expect(played).toEqual([]);
  });

  test("state transitions notify subscribers", async () => {
    const { engine } = makeEngine();
    const seen: string[] = [];
    engine.subscribe((s) => seen.push(s));
    engine.enqueue("Say something nice.");
    await settle();
    expect(seen[0]).toBe("speaking");
    expect(seen[seen.length - 1]).toBe("idle");
  });

  test("pause() during playback parks the queue and does NOT fire onIdle", async () => {
    const { engine, played, release } = makeControllableEngine();
    let idle = 0;
    engine.onIdle = () => idle++;
    engine.enqueue("First.");
    engine.enqueue("Second.");
    await settleUntil(() => played.length === 1); // First is "playing"
    engine.pause();
    expect(engine.state).toBe("paused");
    await settle();
    // Still parked mid-utterance — the queue never drained, so no auto-listen.
    expect(idle).toBe(0);
    expect(played).toEqual(["First."]);

    engine.resume();
    expect(engine.state).toBe("speaking");
    release(); // finish First → Second starts
    await settleUntil(() => played.length === 2);
    release(); // finish Second → queue drains
    await settle();
    expect(played).toEqual(["First.", "Second."]);
    expect(idle).toBe(1); // exactly one onIdle, only on the genuine drain
    expect(engine.state).toBe("idle");
  });

  test("pause() is a no-op unless speaking; resume() is a no-op unless paused", async () => {
    const { engine } = makeControllableEngine();
    engine.pause(); // idle
    expect(engine.state).toBe("idle");
    engine.resume(); // idle
    expect(engine.state).toBe("idle");
    engine.enqueue("Talking now.");
    await settleUntil(() => engine.state === "speaking");
    engine.resume(); // speaking, not paused → no change
    expect(engine.state).toBe("speaking");
  });

  test("unlock() does not resume the shared context while speech is paused", async () => {
    const contexts = installAudioContext();
    const { engine } = makeControllableEngine();
    engine.unlock();
    const [ctx] = contexts;
    expect(ctx.resume).toHaveBeenCalledTimes(1);

    engine.enqueue("Pause here.");
    await settleUntil(() => engine.state === "speaking");
    engine.pause();
    expect(ctx.state).toBe("suspended");

    engine.unlock();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("suspended");
    expect(engine.state).toBe("paused");
  });

  test("playListeningCue() drops the cue while speech is paused", async () => {
    const contexts = installAudioContext();
    const { engine } = makeControllableEngine();
    engine.unlock();
    const [ctx] = contexts;
    engine.enqueue("Pause before the cue.");
    await settleUntil(() => engine.state === "speaking");
    engine.pause();

    engine.playListeningCue();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.state).toBe("suspended");
    expect(engine.state).toBe("paused");
  });

  test("resume() resumes the paused context and returns to speaking", async () => {
    const contexts = installAudioContext();
    const { engine } = makeControllableEngine();
    engine.unlock();
    const [ctx] = contexts;
    engine.enqueue("Pause, then continue.");
    await settleUntil(() => engine.state === "speaking");
    engine.pause();

    engine.resume();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(ctx.state).toBe("running");
    expect(engine.state).toBe("speaking");
  });

  test("ordinary unlock and listening cue behavior is unchanged", () => {
    const contexts = installAudioContext();
    const { engine } = makeEngine();

    engine.unlock();
    const [ctx] = contexts;
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("running");

    engine.playListeningCue();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  test("stop() while paused clears state and suppresses onIdle", async () => {
    const { engine, played, release } = makeControllableEngine();
    let idle = 0;
    engine.onIdle = () => idle++;
    engine.enqueue("Doomed.");
    await settleUntil(() => played.length === 1);
    engine.pause();
    engine.stop();
    expect(engine.state).toBe("idle");
    release(); // unwind the parked pump loop
    await settle();
    expect(idle).toBe(0);
  });
});

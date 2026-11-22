import { afterEach, describe, expect, it, vi } from "vitest";

const focus = vi.hoisted(() => ({
  input: null as object | null,
  blurTextInput: vi.fn(),
  endEditing: vi.fn(),
}));

vi.mock("expo-router", () => ({ useFocusEffect: () => {} }));
vi.mock("react-native", () => ({
  TextInput: {
    State: {
      currentlyFocusedInput: () => focus.input,
      blurTextInput: focus.blurTextInput,
    },
  },
}));
vi.mock("@/lib/hardwareKeyboard", () => ({
  watchHardwareKeys: () => () => {},
  watchHardwarePresses: () => () => {},
  claimHardwarePresses: () => {},
  watchKeyCommands: () => () => {},
  isEditingText: async () => false,
  endEditing: focus.endEditing,
}));

import { appStatusBus } from "@/lib/appStatusBus";
import { micKeyReleased } from "@/lib/micKeyHold";
import {
  claimedPressTypes,
  NO_MIC,
  pressComposeKey,
  pressMicKey,
  pressRecorderKey,
  releaseMicKey,
  registerVoiceTarget,
  watchedRecorderKeys,
  type VoiceTarget,
} from "@/lib/voiceKey";

const ESCAPE = 0x29;
const SPACE = 0x2c;
const F5 = 0x3e;

function target(overrides: Partial<VoiceTarget> = {}): VoiceTarget {
  return {
    state: "idle",
    start: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];
function register(t: VoiceTarget) {
  cleanups.push(registerVoiceTarget(() => t));
  return t;
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  micKeyReleased(0); // drop any hold a test left behind
  vi.useRealTimers();
  focus.input = null;
  focus.blurTextInput.mockClear();
  focus.endEditing.mockClear();
});

describe("voice key registry", () => {
  it("does nothing with no screen registered", () => {
    expect(pressMicKey()).toBe(false);
    expect(pressComposeKey()).toBe(false);
    expect(pressRecorderKey(ESCAPE)).toBe(false);
  });

  it("drives the newest target, and the older one again once it leaves", () => {
    const older = register(target({ compose: vi.fn() }));
    const newer = target({ state: "busy" });
    const unregisterNewer = registerVoiceTarget(() => newer);
    expect(pressMicKey()).toBe(true);
    expect(older.start).not.toHaveBeenCalled();
    unregisterNewer();
    pressMicKey();
    expect(older.start).toHaveBeenCalledOnce();
  });

  it("⌘/ opens the composer, but not over an open recorder", () => {
    const compose = vi.fn();
    const t = register(target({ compose }));
    expect(pressComposeKey()).toBe(true);
    expect(compose).toHaveBeenCalledOnce();
    t.state = "recording";
    expect(pressComposeKey()).toBe(true);
    expect(compose).toHaveBeenCalledOnce();
  });

  it("⌘/ is unclaimed where the screen has no composer", () => {
    register(target());
    expect(pressComposeKey()).toBe(false);
  });

  it("Escape cancels an open recorder before it closes the floating panel", () => {
    const dismiss = vi.fn();
    const t = register(target({ state: "recording", dismiss }));
    pressRecorderKey(ESCAPE);
    expect(t.cancel).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
    t.state = "idle";
    expect(pressRecorderKey(ESCAPE)).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    // Space is the recorder's ✓ only; with the mic closed it is ordinary typing.
    expect(pressRecorderKey(SPACE)).toBe(false);
  });

  it("watches Escape alone for a panel, and the recorder keys only while recording", () => {
    expect(watchedRecorderKeys(undefined, false)).toEqual([]);
    expect(watchedRecorderKeys(target(), false)).toEqual([]);
    expect(watchedRecorderKeys(target({ dismiss: vi.fn() }), false)).toEqual([ESCAPE]);
    expect(watchedRecorderKeys(target({ state: "connecting" }), false)).toContain(SPACE);
    expect(watchedRecorderKeys(target(), true)).toEqual([F5]);
  });

  it("the mic key, Space and Return send while the recorder is still starting", () => {
    const t = register(target({ state: "connecting" }));
    expect(pressMicKey()).toBe(true);
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(pressRecorderKey(SPACE)).toBe(true);
    expect(t.confirm).toHaveBeenCalledTimes(2);
  });

  it("holding the mic key past a second sends on release; a tap keeps recording", () => {
    vi.useFakeTimers();
    // Snapshots, as screens provide them: the press sees "idle", the release
    // must see the take that started.
    let state: VoiceTarget["state"] = "idle";
    const confirm = vi.fn();
    const start = vi.fn(() => {
      state = "recording";
    });
    cleanups.push(
      registerVoiceTarget(() => target({ state, start, confirm })),
    );

    pressMicKey();
    vi.advanceTimersByTime(300);
    releaseMicKey();
    expect(start).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();

    state = "idle";
    pressMicKey();
    vi.advanceTimersByTime(1_500);
    releaseMicKey();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("claims the mic key from UIKit only where the screen has a mic", () => {
    // A focused field would otherwise take it for the Dictation key.
    expect(claimedPressTypes(undefined)).toEqual([]);
    expect(claimedPressTypes({ ...NO_MIC, compose: vi.fn() })).toEqual([]);
    expect(claimedPressTypes(target())).toEqual([504]);
    expect(claimedPressTypes(target({ state: "busy" }))).toEqual([504]);
  });

  it("the mic key takes focus from a field before the recorder opens", () => {
    const field = {};
    focus.input = field;
    const order: string[] = [];
    focus.blurTextInput.mockImplementation(() => order.push("blur"));
    const t = register(target({ start: vi.fn(() => order.push("start")) }));
    pressMicKey();
    expect(t.start).toHaveBeenCalledOnce();
    expect(focus.blurTextInput).toHaveBeenCalledWith(field);
    expect(focus.endEditing).toHaveBeenCalledOnce();
    expect(order).toEqual(["blur", "start"]);
  });

  it("leaves the writing box focused while it holds the mic", () => {
    // The screen's start does nothing then: one recorder at a time.
    const writingBox = Symbol("writing box");
    appStatusBus.setMicOwned(writingBox, true);
    cleanups.push(() => appStatusBus.setMicOwned(writingBox, false));
    focus.input = {};
    register(target());
    pressMicKey();
    expect(focus.blurTextInput).not.toHaveBeenCalled();
    expect(focus.endEditing).not.toHaveBeenCalled();
  });

  it("leaves focus alone when the mic key has nothing to start", () => {
    // Typed text in the box: the mic is busy, and the scholar keeps typing.
    focus.input = {};
    register(target({ state: "busy" }));
    pressMicKey();
    expect(focus.blurTextInput).not.toHaveBeenCalled();
    expect(focus.endEditing).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";

import {
  isVolumeTooLow,
  lastTutorSpeech,
  LOW_VOLUME_THRESHOLD,
  shouldAutoListen,
  type AutoListenInput,
} from "../voiceLoop";

const ready: AutoListenInput = {
  voiceMode: true,
  sttEnabled: true,
  replyOpen: false,
  appActive: true,
  micBusy: false,
  drainedSource: "voice",
};

describe("shouldAutoListen", () => {
  it("reopens the mic once a finished, voice-loop reply has drained", () => {
    expect(shouldAutoListen(ready)).toBe(true);
  });

  it.each([
    ["voice mode is off", { voiceMode: false }],
    ["the teacher disabled speech-to-text", { sttEnabled: false }],
    ["the reply is still streaming (between sentences)", { replyOpen: true }],
    ["the app is backgrounded", { appActive: false }],
    ["another recorder holds the mic", { micBusy: true }],
    ["a tap-to-hear label drained (speak())", { drainedSource: "label" as const }],
    ["playback was stopped (stop/abort/mic tap)", { drainedSource: null }],
  ])("stays closed when %s", (_label, patch) => {
    expect(shouldAutoListen({ ...ready, ...patch })).toBe(false);
  });
});

describe("isVolumeTooLow", () => {
  // iPad volume moves in 16 steps of 0.0625.
  it.each([
    [0, true], // muted
    [0.0625, true], // bottom step — inaudible in a classroom
    [LOW_VOLUME_THRESHOLD, true],
    [0.125, false], // second step — quiet but hearable
    [0.5, false],
    [1, false],
  ])("volume %s → too low: %s", (volume, expected) => {
    expect(isVolumeTooLow(volume)).toBe(expected);
  });

  it("an unknown reading (module missing) never counts as too low", () => {
    expect(isVolumeTooLow(null)).toBe(false);
  });
});

describe("lastTutorSpeech", () => {
  it("returns the latest non-empty tutor message", () => {
    expect(
      lastTutorSpeech([
        { role: "assistant", content: "First reply." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "Latest reply." },
        { role: "assistant", content: "  " }, // an empty streaming placeholder
        { role: "tool", content: "resource_share" },
      ]),
    ).toBe("Latest reply.");
  });

  it("is null when the tutor hasn't said anything yet", () => {
    expect(lastTutorSpeech([{ role: "user", content: "<start>" }])).toBeNull();
    expect(lastTutorSpeech(undefined)).toBeNull();
  });
});

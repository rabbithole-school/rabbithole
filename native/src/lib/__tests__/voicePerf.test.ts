/// <reference types="node" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { voiceMark } from "../voicePerf";

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_VOICE_DEBUG;
  vi.restoreAllMocks();
});

function enable(): void {
  process.env.EXPO_PUBLIC_VOICE_DEBUG = "1";
}

describe("voiceMark", () => {
  test("is silent unless the Expo bundle-time flag is enabled", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    voiceMark("micClosed");
    voiceMark("firstAudio");
    expect(info).not.toHaveBeenCalled();
  });

  test("reports consecutive present marks in the canonical format", () => {
    enable();
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125)
      .mockReturnValueOnce(180)
      .mockReturnValueOnce(240)
      .mockReturnValueOnce(300);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});

    voiceMark("micClosed");
    voiceMark("transcript");
    voiceMark("sendMessage");
    voiceMark("firstText");
    voiceMark("firstAudio");

    expect(info).toHaveBeenCalledWith(
      "[voice-perf] micClosed→transcript 25ms | transcript→sendMessage 55ms | " +
        "sendMessage→firstText 60ms | firstText→firstAudio 60ms | " +
        "TOTAL micClosed→firstAudio 200ms",
    );
  });

  test("skips absent marks and supports speechEnd as an arm mark", () => {
    enable();
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(70)
      .mockReturnValueOnce(100);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});

    voiceMark("speechEnd");
    voiceMark("firstText");
    voiceMark("firstAudio");

    expect(info).toHaveBeenCalledWith(
      "[voice-perf] speechEnd→firstText 60ms | firstText→firstAudio 30ms | " +
        "TOTAL speechEnd→firstAudio 90ms",
    );
  });

  test("records only the first occurrence of each mark and reports once", () => {
    enable();
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(60)
      .mockReturnValueOnce(100);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});

    voiceMark("micClosed");
    voiceMark("transcript");
    voiceMark("transcript");
    voiceMark("firstAudio");
    voiceMark("firstAudio");

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[voice-perf] micClosed→transcript 10ms | transcript→firstAudio 50ms | " +
        "TOTAL micClosed→firstAudio 60ms",
    );
  });

  test("ignores audio outside an armed cycle and re-arming resets the cycle", () => {
    enable();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});

    voiceMark("firstAudio");
    voiceMark("micClosed");
    voiceMark("transcript");
    voiceMark("speechEnd");
    voiceMark("firstAudio");

    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0][0] as string;
    expect(line).toContain("speechEnd→firstAudio");
    expect(line).not.toContain("micClosed");
    expect(line).not.toContain("transcript");
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";
import { voiceMark } from "../voicePerf";

// voicePerf reads the flag from localStorage and reports via console.info.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

const enable = () => store.set("rh.voiceDebug", "1");

describe("voiceMark", () => {
  test("silent when the debug flag is off", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    voiceMark("micClosed");
    voiceMark("firstText");
    voiceMark("firstAudio");
    expect(info).not.toHaveBeenCalled();
  });

  test("reports a full cycle once firstAudio lands", () => {
    enable();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    voiceMark("micClosed");
    voiceMark("transcript");
    voiceMark("firstText");
    voiceMark("firstAudio");
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0][0] as string;
    expect(line).toContain("[voice-perf]");
    expect(line).toContain("micClosed→transcript");
    expect(line).toContain("TOTAL micClosed→firstAudio");
    expect(line).not.toContain("—"); // every gap measured
  });

  test("audio outside an armed cycle (manual read-aloud) stays silent", () => {
    enable();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    voiceMark("firstAudio");
    expect(info).not.toHaveBeenCalled();
  });

  test("skips unmeasured marks rather than fabricating gaps", () => {
    enable();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    voiceMark("micClosed");
    voiceMark("firstText"); // transcript mark never happened
    voiceMark("firstAudio");
    const line = info.mock.calls[0][0] as string;
    // The chain jumps straight between the marks that actually fired —
    // no invented "transcript" segment.
    expect(line).toContain("micClosed→firstText");
    expect(line).not.toContain("transcript");
    expect(line).toContain("TOTAL micClosed→firstAudio");
  });

  test("re-arming starts a fresh cycle", () => {
    enable();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    voiceMark("micClosed");
    voiceMark("firstAudio");
    voiceMark("micClosed"); // new turn
    voiceMark("transcript");
    voiceMark("firstText");
    voiceMark("firstAudio");
    expect(info).toHaveBeenCalledTimes(2);
  });
});

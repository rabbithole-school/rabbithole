import { describe, expect, test, vi } from "vitest";
import {
  parseRealtimeTranscriptionEvent,
  reduceTranscriptAssembly,
  type TranscriptAssembly,
} from "../realtimeTranscriptionProtocol";
import { voiceMark } from "../voicePerf";

const empty: TranscriptAssembly = {
  itemId: null,
  partial: "",
  final: null,
};

describe("Realtime transcription events", () => {
  test("parses semantic VAD boundaries", () => {
    expect(
      parseRealtimeTranscriptionEvent({
        type: "input_audio_buffer.speech_started",
      }),
    ).toEqual({ kind: "speechStarted" });
    expect(
      parseRealtimeTranscriptionEvent({
        type: "input_audio_buffer.speech_stopped",
      }),
    ).toEqual({ kind: "speechStopped" });
  });

  test("assembles deltas for one item and trusts the final transcript", () => {
    const first = reduceTranscriptAssembly(
      empty,
      parseRealtimeTranscriptionEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item_1",
        delta: "Why do ",
      }),
    );
    const second = reduceTranscriptAssembly(
      first,
      parseRealtimeTranscriptionEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item_1",
        delta: "stars shine?",
      }),
    );
    const completed = reduceTranscriptAssembly(
      second,
      parseRealtimeTranscriptionEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item_1",
        transcript: "Why do stars shine?",
      }),
    );

    expect(second.partial).toBe("Why do stars shine?");
    expect(completed).toEqual({
      itemId: "item_1",
      partial: "Why do stars shine?",
      final: "Why do stars shine?",
    });
  });

  describe("streaming voice performance marks", () => {
    test("streaming turns arm at speechEnd and report once at firstAudio", () => {
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => (key === "rh.voiceDebug" ? "1" : null),
      });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});

      voiceMark("speechEnd");
      voiceMark("transcript");
      voiceMark("sendMessage");
      voiceMark("firstText");
      voiceMark("firstAudio");

      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toContain("[voice-perf] speechEnd→transcript");
      expect(info.mock.calls[0][0]).toContain("TOTAL speechEnd→firstAudio");
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    test("legacy turns still arm at micClosed with the same reporter", () => {
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => (key === "rh.voiceDebug" ? "1" : null),
      });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});

      voiceMark("micClosed");
      voiceMark("transcript");
      voiceMark("firstText");
      voiceMark("firstAudio");

      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toContain("[voice-perf] micClosed→transcript");
      expect(info.mock.calls[0][0]).toContain("TOTAL micClosed→firstAudio");
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
  });

  test("does not concatenate deltas from different committed items", () => {
    const prior: TranscriptAssembly = {
      itemId: "item_1",
      partial: "old turn",
      final: null,
    };
    const next = reduceTranscriptAssembly(
      prior,
      parseRealtimeTranscriptionEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item_2",
        delta: "new turn",
      }),
    );
    expect(next.partial).toBe("new turn");
    expect(next.itemId).toBe("item_2");
  });

  test("turns transcription failures into explicit error events", () => {
    expect(
      parseRealtimeTranscriptionEvent({
        type: "conversation.item.input_audio_transcription.failed",
        error: { message: "bad audio" },
      }),
    ).toEqual({ kind: "error", message: "bad audio" });
  });

  test("ignores malformed and unrelated events", () => {
    expect(parseRealtimeTranscriptionEvent(null)).toEqual({ kind: "ignored" });
    expect(
      parseRealtimeTranscriptionEvent({ type: "rate_limits.updated" }),
    ).toEqual({ kind: "ignored" });
  });
});

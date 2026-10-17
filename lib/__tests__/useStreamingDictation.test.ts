import { describe, expect, test, vi } from "vitest";
import {
  isSecretUsable,
  isSessionReadyForTurn,
  SECRET_REFRESH_AHEAD_MS,
  SECRET_USABLE_MARGIN_MS,
  shouldPrefetchSecret,
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

// The mic may only say "listening" once audio is actually transcribed under
// the turn's real config — before this, the first words of a take were lost.
describe("startup readiness", () => {
  const created = parseRealtimeTranscriptionEvent({ type: "session.created" });
  const updated = parseRealtimeTranscriptionEvent({ type: "session.updated" });

  test("tells session.created from session.updated", () => {
    expect(created).toEqual({ kind: "sessionReady", phase: "created" });
    expect(updated).toEqual({ kind: "sessionReady", phase: "updated" });
  });

  test("tap-to-talk waits for the ack of its VAD-off session.update", () => {
    expect(isSessionReadyForTurn(created, false)).toBe(false);
    expect(isSessionReadyForTurn(updated, false)).toBe(true);
  });

  test("a hands-free take is ready at the first session event", () => {
    expect(isSessionReadyForTurn(created, true)).toBe(true);
    expect(isSessionReadyForTurn(updated, true)).toBe(true);
  });

  test("no other event makes a take ready", () => {
    expect(
      isSessionReadyForTurn(
        parseRealtimeTranscriptionEvent({
          type: "input_audio_buffer.speech_started",
        }),
        true,
      ),
    ).toBe(false);
  });
});

describe("client-secret cache", () => {
  const now = 1_000_000;
  const expiringIn = (ms: number) => ({ expiresAtMs: now + ms });

  test("nothing cached: unusable, and a prefetch should mint", () => {
    expect(isSecretUsable(null, now)).toBe(false);
    expect(shouldPrefetchSecret(null, now)).toBe(true);
  });

  test("a fresh secret is used as-is and not re-minted", () => {
    const fresh = expiringIn(10 * 60_000);
    expect(isSecretUsable(fresh, now)).toBe(true);
    expect(shouldPrefetchSecret(fresh, now)).toBe(false);
  });

  test("near expiry: still usable for this tap, refreshed in the background", () => {
    const aging = expiringIn(SECRET_REFRESH_AHEAD_MS - 1);
    expect(isSecretUsable(aging, now)).toBe(true);
    expect(shouldPrefetchSecret(aging, now)).toBe(true);
  });

  test("too close to expiry to outlive a handshake: not usable", () => {
    expect(isSecretUsable(expiringIn(SECRET_USABLE_MARGIN_MS), now)).toBe(false);
    expect(isSecretUsable(expiringIn(SECRET_USABLE_MARGIN_MS + 1), now)).toBe(
      true,
    );
    expect(isSecretUsable(expiringIn(-1), now)).toBe(false);
  });
});

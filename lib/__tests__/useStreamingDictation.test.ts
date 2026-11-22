import { describe, expect, test, vi } from "vitest";
import {
  takeSessionUpdate,
  BACKLOG_PAUSE_MARGIN_MS,
  encodePcm16Wav,
  EMPTY_COMMIT_ERROR_CODE,
  isBacklogPause,
  TakeTranscript,
  isSecretUsable,
  meterLevelFromDb,
  pcm16DurationMs,
  pcm16RmsDb,
  RealtimeAudioRelay,
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
    ).toEqual({ kind: "speechStopped", audioEndMs: null });
    expect(
      parseRealtimeTranscriptionEvent({
        type: "input_audio_buffer.speech_stopped",
        audio_end_ms: 1850,
      }),
    ).toEqual({ kind: "speechStopped", audioEndMs: 1850 });
    expect(
      parseRealtimeTranscriptionEvent({
        type: "input_audio_buffer.committed",
        item_id: "item_7",
      }),
    ).toEqual({ kind: "committed", itemId: "item_7" });
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

  test("keeps the error code, so an empty commit can be told apart", () => {
    expect(
      parseRealtimeTranscriptionEvent({
        type: "error",
        error: { message: "buffer too small", code: EMPTY_COMMIT_ERROR_CODE },
      }),
    ).toMatchObject({ kind: "error", code: EMPTY_COMMIT_ERROR_CODE });
  });

  test("turns transcription failures into explicit error events", () => {
    expect(
      parseRealtimeTranscriptionEvent({
        type: "conversation.item.input_audio_transcription.failed",
        error: { message: "bad audio" },
      }),
    ).toEqual({ kind: "error", message: "bad audio", code: null });
  });

  test("ignores malformed and unrelated events", () => {
    expect(parseRealtimeTranscriptionEvent(null)).toEqual({ kind: "ignored" });
    expect(
      parseRealtimeTranscriptionEvent({ type: "rate_limits.updated" }),
    ).toEqual({ kind: "ignored" });
  });
});

describe("session events", () => {
  test("tells session.created from session.updated", () => {
    expect(
      parseRealtimeTranscriptionEvent({ type: "session.created" }),
    ).toEqual({ kind: "sessionReady", phase: "created" });
    expect(
      parseRealtimeTranscriptionEvent({ type: "session.updated" }),
    ).toEqual({ kind: "sessionReady", phase: "updated" });
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

describe("RealtimeAudioRelay", () => {
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const kinds = (sent: string[]) =>
    sent.map((message) => {
      const event = JSON.parse(message) as { type: string; audio?: string };
      return event.audio ? `append:${event.audio}` : event.type;
    });

  test("holds audio captured before the socket opens, then sends it in order", () => {
    const relay = new RealtimeAudioRelay(hex);
    const sent: string[] = [];
    relay.push(new Uint8Array([1, 2]));
    relay.push(new Uint8Array([3, 4]));
    expect(relay.hasSentAudio).toBe(false);

    relay.attach((message) => sent.push(message));
    relay.push(new Uint8Array([5, 6]));

    expect(kinds(sent)).toEqual(["append:0102", "append:0304", "append:0506"]);
    expect(relay.hasSentAudio).toBe(true);
  });

  test("a turn finished before the socket opens commits after its backlog", () => {
    const relay = new RealtimeAudioRelay(hex);
    const sent: string[] = [];
    relay.push(new Uint8Array([1, 2]));
    relay.commit();
    relay.push(new Uint8Array([9, 9])); // a late buffer after ✓ is not part of the turn

    relay.attach((message) => sent.push(message));

    expect(kinds(sent)).toEqual(["append:0102", "input_audio_buffer.commit"]);
  });

  test("commits once, and keeps every captured chunk for the batch fallback", () => {
    const relay = new RealtimeAudioRelay(hex);
    const sent: string[] = [];
    relay.attach((message) => sent.push(message));
    relay.push(new Uint8Array([1, 2, 3, 4]));
    relay.commit();
    relay.commit();

    expect(kinds(sent)).toEqual(["append:01020304", "input_audio_buffer.commit"]);
    expect(relay.capturedBytes).toBe(4);
    expect(relay.audio().map(hex)).toEqual(["01020304"]);
  });

  test("after detach it keeps capturing for the fallback but sends nothing", () => {
    const relay = new RealtimeAudioRelay(hex);
    const sent: string[] = [];
    relay.attach((message) => sent.push(message));
    relay.push(new Uint8Array([1, 2]));
    relay.detach();
    relay.push(new Uint8Array([3, 4, 5, 6]));

    expect(sent).toHaveLength(1);
    expect(relay.sentBytes).toBe(2);
    expect(relay.capturedBytes).toBe(6);
  });
});

describe("PCM helpers", () => {
  const int16 = (values: number[]) => {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => view.setInt16(i * 2, value, true));
    return bytes;
  };

  test("silence reads as the floor and a full-scale square wave as 0 dBFS", () => {
    expect(pcm16RmsDb(int16([0, 0, 0, 0]))).toBe(-100);
    expect(pcm16RmsDb(int16([-32768, -32768]))).toBeCloseTo(0, 5);
    expect(pcm16RmsDb(new Uint8Array(0))).toBe(-100);
  });

  test("the meter maps -60..0 dB onto 0..1 and clamps outside it", () => {
    expect(meterLevelFromDb(-100)).toBe(0);
    expect(meterLevelFromDb(-30)).toBeCloseTo(0.5);
    expect(meterLevelFromDb(6)).toBe(1);
  });

  test("duration counts 16-bit mono samples", () => {
    expect(pcm16DurationMs(48_000, 24_000)).toBe(1000);
  });

  test("the WAV wrapper writes a 16-bit PCM header around the chunks", () => {
    const wav = encodePcm16Wav([int16([1]), int16([2, 3])], 24_000);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) =>
      String.fromCharCode(...wav.subarray(offset, offset + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(wav.subarray(44))).toEqual([1, 0, 2, 0, 3, 0]);
  });
});

describe("hands-free turn boundaries", () => {
  test("a pause near the live edge ends the turn; one deep in the backlog does not", () => {
    expect(isBacklogPause(4_200, 4_500)).toBe(false);
    expect(isBacklogPause(1_200, 1_200 + BACKLOG_PAUSE_MARGIN_MS + 1)).toBe(true);
    expect(isBacklogPause(null, 10_000)).toBe(false);
  });

  test("tap-to-talk: complete when the manual commit's item is transcribed", () => {
    const take = new TakeTranscript();
    take.finalCommitRequested();
    expect(take.result()).toBeNull();
    take.committed("a");
    expect(take.result()).toBeNull();
    take.completed("a", " Volcanoes form where plates pull apart. ");
    expect(take.result()).toBe("Volcanoes form where plates pull apart.");
  });

  test("hands-free: an earlier item finishing during the tail does not end the take", () => {
    const take = new TakeTranscript();
    take.speechStopped(); // a pause in the backlog
    take.committed("a");
    take.finalCommitRequested(); // ✓ while still talking
    take.completed("a", "We went outside");
    expect(take.result()).toBeNull(); // the manual commit's item is still coming
    take.committed("b");
    take.completed("b", "and then it rained.");
    expect(take.result()).toBe("We went outside and then it rained.");
  });

  test("✓'s commit landing before VAD's stop: the late stop is not waited for", () => {
    const take = new TakeTranscript();
    take.finalCommitRequested();
    take.committed("a"); // ✓'s commit, acknowledged first
    take.speechStopped(); // VAD noticing the pause after audio we never sent
    take.completed("a", "Sea otters hold hands.");
    expect(take.result()).toBe("Sea otters hold hands.");
  });

  test("a manual commit server VAD left empty is not waited for", () => {
    const take = new TakeTranscript();
    take.finalCommitRequested();
    take.speechStopped();
    take.completed("a", "Done.");
    expect(take.result()).toBeNull();
    take.finalCommitWasEmpty();
    expect(take.result()).toBe("Done.");
  });
});

describe("takeSessionUpdate", () => {
  const input = (json: string | null) =>
    json === null ? null : JSON.parse(json).session.audio.input;

  test("tap-to-talk on the raw iPad mic: VAD and noise reduction off", () => {
    expect(input(takeSessionUpdate({ handsFree: false, rawMic: true }))).toEqual({
      turn_detection: null,
      noise_reduction: null,
    });
  });

  test("hands-free on the raw mic: patient semantic VAD, no noise reduction", () => {
    expect(input(takeSessionUpdate({ handsFree: true, rawMic: true }))).toEqual({
      turn_detection: { type: "semantic_vad", eagerness: "low" },
      noise_reduction: null,
    });
  });

  // TRA-706: the minted default (medium, up to 4 s) cut K–2 readers off
  // mid-sentence. Every hands-free take is a young reader's.
  test("web hands-free also waits patiently for a young reader", () => {
    expect(input(takeSessionUpdate({ handsFree: true, rawMic: false }))).toEqual({
      turn_detection: { type: "semantic_vad", eagerness: "low" },
    });
  });

  test("web tap-to-talk only switches VAD off", () => {
    expect(input(takeSessionUpdate({ handsFree: false, rawMic: false }))).toEqual({
      turn_detection: null,
    });
  });
});

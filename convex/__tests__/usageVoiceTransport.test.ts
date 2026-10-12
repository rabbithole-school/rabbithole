import { describe, expect, test } from "vitest";
import {
  computeUsageReport,
  renderUsageReportMarkdown,
  renderUsageTeaser,
  type UsageEventRow,
} from "../lib/usageReport";

const WINDOW_START = Date.UTC(2026, 7, 26);
const WINDOW_END = Date.UTC(2026, 8, 2);

function voiceRow(
  source: "realtime-transcription" | "whisper-transcription",
  sessionId: string | null,
): UsageEventRow {
  return {
    source,
    model: source === "realtime-transcription" ? "gpt-4o-transcribe" : "whisper-1",
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    audioSeconds: 4,
    sessionId,
    createdAt: WINDOW_START + 1_000,
  };
}

function report(events: UsageEventRow[]) {
  return computeUsageReport({
    events,
    priorEvents: [],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
}

describe("voice transport health in the weekly usage report", () => {
  test("classifies each session by its transport mix, not by turn counts", () => {
    // Shaped after the prod week of 2026-08-26 → 09-02: mostly healthy, one
    // mid-session fallback, and one session that never reached realtime at all
    // and then ate almost every fallback turn (the stickiness).
    const events: UsageEventRow[] = [
      ...Array.from({ length: 14 }, (_, i) => voiceRow("realtime-transcription", `s${i}`)),
      voiceRow("realtime-transcription", "fell-back"),
      voiceRow("whisper-transcription", "fell-back"),
      ...Array.from({ length: 21 }, () => voiceRow("whisper-transcription", "cold")),
    ];

    const { voice } = report(events);
    expect(voice).toEqual({
      sessions: 16,
      realtimeOnly: 14,
      fellBack: 1,
      neverRealtime: 1,
      realtimeTurns: 15,
      whisperTurns: 22,
    });
  });

  test("a healthy week reports zero degraded sessions and says nothing in the teaser", () => {
    const r = report([
      voiceRow("realtime-transcription", "a"),
      voiceRow("realtime-transcription", "a"),
      voiceRow("realtime-transcription", "b"),
    ]);
    expect(r.voice.sessions).toBe(2);
    expect(r.voice.fellBack + r.voice.neverRealtime).toBe(0);
    expect(renderUsageTeaser(r)).not.toContain("Whisper fallback");
    // The table still renders, so a reader can see voice ran clean.
    expect(renderUsageReportMarkdown(r)).toContain("## Voice input");
  });

  test("a degraded week reaches the alert body, not just the canvas", () => {
    const r = report([
      voiceRow("realtime-transcription", "a"),
      voiceRow("whisper-transcription", "b"),
      voiceRow("whisper-transcription", "b"),
    ]);
    const teaser = renderUsageTeaser(r);
    expect(teaser).toContain("Voice: 1 of 2 sessions ran on the Whisper fallback");

    const markdown = renderUsageReportMarkdown(r);
    expect(markdown).toContain("## Voice input");
    expect(markdown).toContain("| 2 | 1 | 0 | 1 | 1 | 2 |");
    expect(markdown).toContain("sticky");
  });

  test("never emits a session id", () => {
    const r = report([
      voiceRow("whisper-transcription", "kd7abcsecretsessionid"),
      voiceRow("realtime-transcription", "kd7abcsecretsessionid"),
    ]);
    expect(renderUsageReportMarkdown(r)).not.toContain("kd7abcsecretsessionid");
    expect(renderUsageTeaser(r)).not.toContain("kd7abcsecretsessionid");
  });

  test("voice rows without a session are priced but never classified", () => {
    // Staff dictation outside a scholar session carries no sessionId; counting
    // it as a session would invent a scholar that was never degraded.
    const r = report([voiceRow("whisper-transcription", null)]);
    expect(r.voice.sessions).toBe(0);
    expect(r.eventCount).toBe(1);
    expect(renderUsageReportMarkdown(r)).not.toContain("## Voice input");
  });

  test("no voice usage at all skips the section entirely", () => {
    const r = report([
      {
        source: "tutor",
        model: "claude-sonnet-5",
        inputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 50,
        createdAt: WINDOW_START + 5,
      },
    ]);
    expect(r.voice.sessions).toBe(0);
    expect(renderUsageReportMarkdown(r)).not.toContain("## Voice input");
  });
});

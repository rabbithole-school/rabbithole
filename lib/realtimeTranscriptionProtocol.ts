export type ParsedRealtimeEvent =
  | { kind: "delta"; itemId: string; text: string }
  | { kind: "completed"; itemId: string; text: string }
  | { kind: "speechStarted" }
  | { kind: "speechStopped" }
  | { kind: "sessionReady" }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

export type TranscriptAssembly = {
  itemId: string | null;
  partial: string;
  final: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRealtimeTranscriptionEvent(
  value: unknown,
): ParsedRealtimeEvent {
  const event = asRecord(value);
  if (!event || typeof event.type !== "string") return { kind: "ignored" };

  if (
    event.type === "conversation.item.input_audio_transcription.delta" &&
    typeof event.item_id === "string" &&
    typeof event.delta === "string"
  ) {
    return { kind: "delta", itemId: event.item_id, text: event.delta };
  }
  if (
    event.type === "conversation.item.input_audio_transcription.completed" &&
    typeof event.item_id === "string" &&
    typeof event.transcript === "string"
  ) {
    return {
      kind: "completed",
      itemId: event.item_id,
      text: event.transcript,
    };
  }
  if (event.type === "input_audio_buffer.speech_started") {
    return { kind: "speechStarted" };
  }
  if (event.type === "input_audio_buffer.speech_stopped") {
    return { kind: "speechStopped" };
  }
  if (event.type === "session.created" || event.type === "session.updated") {
    return { kind: "sessionReady" };
  }
  if (
    event.type === "error" ||
    event.type === "conversation.item.input_audio_transcription.failed"
  ) {
    const error = asRecord(event.error);
    return {
      kind: "error",
      message:
        (typeof error?.message === "string" && error.message) ||
        "Realtime transcription failed.",
    };
  }
  return { kind: "ignored" };
}

export function reduceTranscriptAssembly(
  current: TranscriptAssembly,
  event: ParsedRealtimeEvent,
): TranscriptAssembly {
  if (event.kind === "delta") {
    return {
      itemId: event.itemId,
      partial:
        current.itemId === event.itemId
          ? current.partial + event.text
          : event.text,
      final: null,
    };
  }
  if (event.kind === "completed") {
    return {
      itemId: event.itemId,
      partial: event.text,
      final: event.text,
    };
  }
  return current;
}

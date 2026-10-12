export type TutorStreamEvent = {
  thinking?: boolean;
  toolStart?: { name?: string };
  toolComplete?: { name?: string; result?: unknown };
  generatingImage?: string;
  generatedImage?: unknown;
  text?: string;
  newAssistantMsg?: string;
  renderCheck?: {
    checkId: string;
    artifactId: string;
  };
  done?: boolean;
  error?: unknown;
  /**
   * App designer (TRA-301): the mode the server actually ran this turn in. It
   * is emitted only when the server CLAMPED a requested Edit down to Play (the
   * edit policy said no), so the screen can snap to Play mid-turn instead of
   * showing designer chrome over a tutor turn.
   */
  workshopMode?: "edit" | "play";
};

function parseTutorSseLine(line: string): TutorStreamEvent | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trimStart();
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const event = value as TutorStreamEvent;
    const renderCheck = (
      value as {
        renderCheck?: {
          checkId?: unknown;
          artifactId?: unknown;
        };
      }
    ).renderCheck;
    if (
      renderCheck &&
      (typeof renderCheck.checkId !== "string" ||
        typeof renderCheck.artifactId !== "string")
    ) {
      return { ...event, renderCheck: undefined };
    }
    return event;
  } catch {
    return null;
  }
}

export function createTutorSseParser() {
  let buffer = "";
  return {
    push(chunk: string): TutorStreamEvent[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines
        .map((line) => parseTutorSseLine(line.replace(/\r$/, "")))
        .filter((event): event is TutorStreamEvent => event !== null);
    },
    finish(): TutorStreamEvent[] {
      const event = parseTutorSseLine(buffer.replace(/\r$/, ""));
      buffer = "";
      return event ? [event] : [];
    },
  };
}

/**
 * Stands in for the server's own error event when a stream closes with
 * neither `done` nor `error` — the server action was killed mid-turn.
 */
export const TUTOR_STREAM_ENDED_EARLY = "stream-ended-early";

/**
 * Read a tutor SSE body to its end, handing each event to `onEvent`; an
 * `onEvent` that returns true stops reading. Resolves true once a `done`
 * event has arrived. A stream that closes without `done` or `error` gets a
 * synthetic error event first, so it fails through the same path a server
 * error takes instead of reading as a finished turn.
 */
export async function readTutorSse(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  onEvent: (event: TutorStreamEvent) => boolean | void,
): Promise<boolean> {
  const decoder = new TextDecoder();
  const parser = createTutorSseParser();
  let sawDone = false;
  let sawError = false;
  const handle = (event: TutorStreamEvent) => {
    if (event.done) sawDone = true;
    if (event.error) sawError = true;
    return onEvent(event) === true;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      if (handle(event)) return sawDone;
    }
  }
  for (const event of parser.push(decoder.decode())) {
    if (handle(event)) return sawDone;
  }
  for (const event of parser.finish()) {
    if (handle(event)) return sawDone;
  }
  if (!sawDone && !sawError) onEvent({ error: TUTOR_STREAM_ENDED_EARLY });
  return sawDone;
}

export function parseTutorSseText(text: string): TutorStreamEvent[] {
  const parser = createTutorSseParser();
  return [...parser.push(text), ...parser.finish()];
}

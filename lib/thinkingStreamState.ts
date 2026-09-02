import type { ThinkingActivity } from "./toolActivityGroups";

export interface ThinkingStreamState {
  thinkingActivity: ThinkingActivity[];
  isThinking: boolean;
}

/**
 * Apply one SSE event to the teacher aide's transient reasoning state.
 *
 * Reasoning summaries are deliberately live-only: the registry removes this
 * state when the stream completes, and the backend never appends it to the
 * persisted assistant message.
 */
export function reduceThinkingStreamState(
  state: ThinkingStreamState,
  event: Record<string, unknown>,
  currentTextOffset: number,
  currentSequence?: number,
): ThinkingStreamState {
  if (event.newAssistantMsg) {
    return { thinkingActivity: [], isThinking: false };
  }

  let thinkingActivity = state.thinkingActivity;
  let isThinking = state.isThinking;

  if (event.thinking === true) {
    isThinking = true;
  }

  if (isThinkingStart(event.thinkingStart)) {
    thinkingActivity = [
      ...markLastThinkingDone(thinkingActivity),
      {
        text: "",
        textOffset: event.thinkingStart.textOffset,
        sequence: currentSequence,
        done: false,
      },
    ];
    isThinking = true;
  }

  if (typeof event.thinkingText === "string" && event.thinkingText.length > 0) {
    if (thinkingActivity.length === 0) {
      thinkingActivity = [
        {
          text: event.thinkingText,
          textOffset: currentTextOffset,
          sequence: currentSequence,
          done: false,
        },
      ];
    } else {
      const next = [...thinkingActivity];
      const last = next[next.length - 1];
      next[next.length - 1] = {
        ...last,
        text: last.text + event.thinkingText,
      };
      thinkingActivity = next;
    }
    isThinking = true;
  }

  if (event.toolStart || typeof event.text === "string") {
    thinkingActivity = markLastThinkingDone(thinkingActivity);
    isThinking = false;
  }

  if (
    thinkingActivity === state.thinkingActivity &&
    isThinking === state.isThinking
  ) {
    return state;
  }
  return { thinkingActivity, isThinking };
}

function markLastThinkingDone(
  activity: ThinkingActivity[],
): ThinkingActivity[] {
  if (activity.length === 0 || activity[activity.length - 1].done) {
    return activity;
  }
  const next = [...activity];
  next[next.length - 1] = { ...next[next.length - 1], done: true };
  return next;
}

function isThinkingStart(
  value: unknown,
): value is { textOffset: number } {
  if (!value || typeof value !== "object" || !("textOffset" in value)) {
    return false;
  }
  const offset = value.textOffset;
  return typeof offset === "number" && Number.isFinite(offset) && offset >= 0;
}

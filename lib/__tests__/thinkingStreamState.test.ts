import { describe, expect, test } from "vitest";
import {
  reduceThinkingStreamState,
  type ThinkingStreamState,
} from "../thinkingStreamState";

const idle = (): ThinkingStreamState => ({
  thinkingActivity: [],
  isThinking: false,
});

describe("reduceThinkingStreamState", () => {
  test("opens a positioned block and appends summarized deltas", () => {
    const opened = reduceThinkingStreamState(
      idle(),
      { thinkingStart: { textOffset: 12 } },
      12,
      4,
    );
    const appended = reduceThinkingStreamState(
      opened,
      { thinkingText: "Compare the two options." },
      12,
    );

    expect(appended).toEqual({
      isThinking: true,
      thinkingActivity: [
        {
          text: "Compare the two options.",
          textOffset: 12,
          sequence: 4,
          done: false,
        },
      ],
    });
  });

  test("falls back to the current text offset if a delta arrives before start", () => {
    expect(
      reduceThinkingStreamState(
        idle(),
        { thinkingText: "Recover defensively." },
        7,
      ),
    ).toEqual({
      isThinking: true,
      thinkingActivity: [
        {
          text: "Recover defensively.",
          textOffset: 7,
          done: false,
        },
      ],
    });
  });

  test("text ends the preceding reasoning block", () => {
    const active = reduceThinkingStreamState(
      idle(),
      { thinkingText: "Draft the answer." },
      0,
    );
    const ended = reduceThinkingStreamState(active, { text: "Here it is." }, 0);

    expect(ended.isThinking).toBe(false);
    expect(ended.thinkingActivity[0].done).toBe(true);
  });

  test("a tool start ends reasoning, then a later block stays distinct", () => {
    const first = reduceThinkingStreamState(
      idle(),
      { thinkingText: "Search first." },
      0,
    );
    const tool = reduceThinkingStreamState(
      first,
      { toolStart: { name: "search" } },
      0,
    );
    const second = reduceThinkingStreamState(
      tool,
      { thinkingStart: { textOffset: 0 } },
      0,
    );

    expect(second.thinkingActivity).toHaveLength(2);
    expect(second.thinkingActivity[0].done).toBe(true);
    expect(second.thinkingActivity[1].done).toBe(false);
  });

  test("new assistant message clears offset-relative reasoning state", () => {
    const active = reduceThinkingStreamState(
      idle(),
      { thinkingText: "Old message." },
      5,
    );

    expect(
      reduceThinkingStreamState(
        active,
        { newAssistantMsg: "message-id" },
        5,
      ),
    ).toEqual(idle());
  });

  test("ignores malformed starts and unrelated events without cloning state", () => {
    const state = idle();
    expect(
      reduceThinkingStreamState(
        state,
        { thinkingStart: { textOffset: -1 } },
        0,
      ),
    ).toBe(state);
    expect(reduceThinkingStreamState(state, { toolComplete: {} }, 0)).toBe(
      state,
    );
  });
});

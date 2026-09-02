import { describe, expect, it } from "vitest";

// RoundsBoardHeader is a React component; we drive it as a plain function and
// inspect the element it returns. It composes `WorkTableHeader`, so we read the
// props it hands that child (title / subtitle) rather than a rendered DOM. The
// header carries no mutations or state any more (the open/close meeting state
// machine was removed), so nothing needs mocking.

import { RoundsBoardHeader } from "../RoundsBoardHeader";
import { WorkTableHeader } from "@/app/teacher/(dashboard)/_components/WorkTableHeader";

type El = { type: unknown; props: Record<string, unknown> };
type SubtitleLine = { text: string; tone?: string; testId?: string };

function props(over: Partial<Parameters<typeof RoundsBoardHeader>[0]> = {}) {
  return RoundsBoardHeader({
    cadence: "academic",
    week: undefined,
    scoped: false,
    shownCount: 5,
    totalCount: 5,
    reservedLines: 1,
    ...over,
  }) as unknown as El;
}

const week = {
  configured: true,
  weekLabel: "20 Aug",
  window: { startMs: 1_000, endMs: 2_000 },
  institutionId: "inst1",
  meeting: null,
  scholars: [],
} as never;

describe("RoundsBoardHeader composes the shared WorkTableHeader", () => {
  it("always renders a WorkTableHeader with the cadence title", () => {
    const el = props();
    expect(el.type).toBe(WorkTableHeader);
    expect(el.props.title).toBe("Academic Rounds");
    expect(el.props.reservedLines).toBe(1);
  });

  it("while the week loads: empty subtitle (reserved slots hold the height)", () => {
    const el = props({ week: undefined });
    expect(el.props.subtitle).toEqual([]);
  });

  it("with a loaded week: just the window line, no open/close action", () => {
    const el = props({ week });
    const subtitle = el.props.subtitle as SubtitleLine[];
    // Only the window line now — the open/closed status line was removed with
    // the meeting state machine.
    expect(subtitle).toHaveLength(1);
    expect(subtitle[0].tone).toBe("strong");
    // WorkTableHeader carries no action here (empty slot, Homework parity).
    expect(el.props.action).toBeUndefined();
  });

  it("adds the scope-count line (with its testid) only when scoped", () => {
    const el = props({ week, scoped: true, shownCount: 3, totalCount: 10, reservedLines: 2 });
    const subtitle = el.props.subtitle as SubtitleLine[];
    expect(subtitle).toHaveLength(2);
    expect(subtitle[1].testId).toBe("rounds-scope-count");
  });

  it("renders the SEL not-configured surface through the shared header", () => {
    const el = props({
      cadence: "sel",
      week: { ...(week as unknown as Record<string, unknown>), configured: false } as never,
      reservedLines: 1,
    });
    expect(el.type).toBe(WorkTableHeader);
    expect(el.props.title).toBe("SEL Rounds");
    const childText = JSON.stringify(el.props.children);
    expect(childText).toContain("rounds-sel-unconfigured");
  });
});

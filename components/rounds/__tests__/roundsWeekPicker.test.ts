import { describe, expect, it, vi } from "vitest";

// The Rounds week nav moved OUT of the board into this picker, which composes
// the shared DateNavPicker. That real module pulls in react-day-picker + its
// CSS, and this repo's Vitest runs on edge-runtime with no DOM — so mock it to
// a stub. The picker is a thin wrapper, so we read the props it hands the stub
// (the element's `.props`) and drive its callbacks directly, asserting the
// week-key math without rendering anything.
vi.mock("@/components/ui/DateNavPicker", () => ({
  DateNavPicker: () => null,
}));

import { RoundsWeekPicker } from "../RoundsWeekPicker";
import {
  roundsWeekKeyForDay,
  roundsWeekLabel,
  shiftRoundsWeekKey,
} from "@/lib/roundsCadence";

type NavProps = {
  label: string;
  selected: Date;
  onSelect: (date: Date) => void;
  onPrevious: () => void;
  onNext: () => void;
  reset: { label: string; onReset: () => void };
};

function navProps(weekKey: string, currentWeekKey: string) {
  const onWeekKeyChange = vi.fn();
  const el = RoundsWeekPicker({
    weekKey,
    currentWeekKey,
    onWeekKeyChange,
  }) as unknown as { props: NavProps };
  return { props: el.props, onWeekKeyChange };
}

describe("RoundsWeekPicker — the moved week nav", () => {
  const week = "2026-08-20"; // a Thursday-anchored week
  const current = "2026-08-27";

  it("labels the pill with the week's date and a sentence-case reset", () => {
    const { props } = navProps(week, current);
    expect(props.label).toBe(roundsWeekLabel(week)); // "20 Aug"
    expect(props.reset.label).toBe("This week");
  });

  it("steps a whole school week on the carets", () => {
    const { props, onWeekKeyChange } = navProps(week, current);
    props.onPrevious();
    expect(onWeekKeyChange).toHaveBeenLastCalledWith(shiftRoundsWeekKey(week, -1));
    props.onNext();
    expect(onWeekKeyChange).toHaveBeenLastCalledWith(shiftRoundsWeekKey(week, 1));
  });

  it("resets to the genuinely-current week", () => {
    const { props, onWeekKeyChange } = navProps(week, current);
    props.reset.onReset();
    expect(onWeekKeyChange).toHaveBeenCalledWith(current);
  });

  it("maps a picked calendar day to that day's Rounds week", () => {
    const { props, onWeekKeyChange } = navProps(week, current);
    // Monday inside the Thursday-anchored week maps back to the Thursday key.
    props.onSelect(new Date(2026, 7, 24)); // 2026-08-24, local
    expect(onWeekKeyChange).toHaveBeenCalledWith(
      roundsWeekKeyForDay("2026-08-24", week),
    );
    expect(onWeekKeyChange).toHaveBeenLastCalledWith("2026-08-20");
  });
});

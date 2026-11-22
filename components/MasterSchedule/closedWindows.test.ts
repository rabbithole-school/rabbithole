import { describe, expect, test } from "vitest";
import { withClosedWindows } from "./closedWindows";
import { chipStatus } from "./PlacementChip";

const TZ = "Pacific/Honolulu";
// Sat Nov 14 2026 ends at local midnight = Sun 10:00 UTC.
const CLOSES_AT = Date.UTC(2026, 10, 15, 10, 0);

function grid(nowLinked: { linkState: "live" | "planned" | "none"; openUntil: number | null }) {
  const placement = { _id: "p1", groupId: "g1", subject: "Humanities", assignmentId: "a1", ...nowLinked };
  return {
    placements: [placement],
    weekPlacements: [placement],
  };
}

describe("a closed open-until give reads as closed, not Live", () => {
  test("before the window closes, nothing changes", () => {
    const g = grid({ linkState: "live", openUntil: CLOSES_AT });
    expect(withClosedWindows(g, CLOSES_AT - 60_000, TZ)).toBe(g);
    expect(chipStatus(g.weekPlacements[0]).label).toBe("Live");
  });

  test("once it has closed, the cell says Closed Sat", () => {
    const g = withClosedWindows(
      grid({ linkState: "live", openUntil: CLOSES_AT }),
      CLOSES_AT,
      TZ,
    );
    const cell = g.weekPlacements[0];
    expect(cell.linkState).toBe("none");
    expect(chipStatus(cell).label).toBe("Closed Sat");
    expect(chipStatus(g.placements[0]).label).toBe("Closed Sat");
  });

  test("a live give with no open-until window stays live", () => {
    const g = grid({ linkState: "live", openUntil: null });
    expect(withClosedWindows(g, CLOSES_AT + 1, TZ).weekPlacements[0].linkState).toBe("live");
  });
});

describe("an open window's label follows the clock", () => {
  const farCloses = Date.UTC(2026, 10, 25, 10, 0); // end of Tue Nov 24
  const labelled = () => {
    const p = {
      _id: "p1",
      groupId: "g1",
      subject: "Humanities",
      assignmentId: "a1",
      linkState: "live" as const,
      openUntil: farCloses,
      openUntilLabel: "Open until Tue",
    };
    return { placements: [p], weekPlacements: [p] };
  };

  test("seven days out the chip names the date", () => {
    const g = withClosedWindows(labelled(), Date.UTC(2026, 10, 17, 19, 0), TZ);
    expect(g.weekPlacements[0].openUntilLabel).toBe("Open until Tue, Nov 24");
  });
  test("within the week it is untouched", () => {
    const g = labelled();
    expect(withClosedWindows(g, Date.UTC(2026, 10, 18, 19, 0), TZ)).toBe(g);
  });
});

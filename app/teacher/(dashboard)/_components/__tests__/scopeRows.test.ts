import { describe, expect, it } from "vitest";

import { buildScopeRows } from "../scopeRows";
import { groupMatchesParticipation } from "@/shared/scholarGroupRouting";
import type { RosterGroup } from "@/hooks/useScholarRoster";

// The rail's scope rows must come FROM the roster data — the whole point of
// scope rows over a dropdown is that whichever groups exist are advertised, so
// nothing here may be hardcoded. Fixtures are invented.
const group = (
  id: string,
  name: string,
  emoji: string | null,
  n: number,
  participation: RosterGroup["participation"] = "enrolled_only",
): RosterGroup => ({
  id,
  name,
  emoji,
  scholarIds: Array.from({ length: n }, (_, i) => `${id}-s${i}`),
  isMine: false,
  type: null,
  participation,
  ownerId: null,
});

describe("buildScopeRows", () => {
  it("two seeded groups → All + My + two group rows, in order", () => {
    const rows = buildScopeRows(
      [group("g1", "Honu", "🐢", 4), group("g2", "ʻIwa", "🐦‍⬛", 6)],
      true,
      21,
    );
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ["", "All scholars"],
      ["mine", "My scholars"],
      ["g1", "Honu"],
      ["g2", "ʻIwa"],
    ]);
    // Counts come from the data (group roster length / total), never invented.
    expect(rows[0].count).toBe(21);
    expect(rows[2].count).toBe(4);
    expect(rows[3].count).toBe(6);
    // The group names + emoji are exactly the roster's, not a hardcoded set.
    expect(rows[2].emoji).toBe("🐢");
    expect(rows[3].emoji).toBe("🐦‍⬛");
  });

  it("omits My scholars when the roster has no affinity", () => {
    const rows = buildScopeRows([group("g1", "Robotics", "🤖", 3)], false, 3);
    expect(rows.map((r) => r.key)).toEqual(["", "g1"]);
  });

  it("no groups → just the All row", () => {
    expect(buildScopeRows([], false, 0)).toEqual([
      { key: "", label: "All scholars", emoji: null, count: 0 },
    ]);
  });

  it("a group with no emoji keeps a null emoji (the UI renders an initial)", () => {
    const rows = buildScopeRows([group("g1", "unnamed pod", null, 2)], false, 2);
    expect(rows[1]).toMatchObject({ key: "g1", label: "unnamed pod", emoji: null, count: 2 });
  });

  // The rail applies groupMatchesParticipation BEFORE buildScopeRows (the same
  // filter ScopeRows uses), so a guest-inclusive group stays hidden until
  // Extended education is selected — shared/scholarGroupRouting.ts's standing
  // rule, restored after the picker's removal.
  it("hides a guest-inclusive group until Extended education is selected", () => {
    const groups = [
      group("g1", "Honu", "🐢", 4, "enrolled_only"),
      group("g2", "Reef program", "🐠", 3, "includes_program_guests"),
    ];

    // Enrolled-only (the default): the guest group is filtered out.
    const enrolledOnly = groups.filter((g) => groupMatchesParticipation(g, false));
    expect(buildScopeRows(enrolledOnly, false, 7).map((r) => r.key)).toEqual(["", "g1"]);

    // Extended education selected: the guest group appears.
    const withGuests = groups.filter((g) => groupMatchesParticipation(g, true));
    expect(buildScopeRows(withGuests, false, 10).map((r) => r.key)).toEqual(["", "g1", "g2"]);
  });
});

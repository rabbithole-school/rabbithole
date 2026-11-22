import { describe, expect, test } from "vitest";
import { givenMeetingKeys, onePerGive, withGiveClock } from "./giveClock";

const give = (over: Partial<Parameters<typeof withGiveClock>[0][number]> = {}) => ({
  key: "p1:g1",
  pushId: "p1",
  state: "live" as const,
  linkState: "live" as const,
  closedLabel: null,
  endsAt: 1_000,
  afterEnd: "fade" as const,
  ...over,
});

describe("withGiveClock", () => {
  test("a live fading give past its end reads as ended", () => {
    expect(withGiveClock([give()], 1_000)[0]).toMatchObject({
      state: "finished",
      closedLabel: "Ended",
    });
  });
  test("before its end, it stays live", () => {
    expect(withGiveClock([give()], 999)[0]).toMatchObject({ state: "live", closedLabel: null });
  });
  test("planned, undated and late-ending gives are left alone", () => {
    const rows = [
      give({ state: "planned", linkState: "planned" }),
      give({ endsAt: null }),
      give({ afterEnd: "late" }),
    ];
    expect(withGiveClock(rows, 5_000)).toEqual(rows);
  });
});

describe("onePerGive", () => {
  test("keeps one card per give across groups", () => {
    const rows = [give(), give({ key: "p1:g2" }), give({ key: "p2:g1", pushId: "p2" })];
    expect(onePerGive(rows).map((g) => [g.key, g.groupCount])).toEqual([
      ["p1:g1", 2],
      ["p2:g1", 1],
    ]);
  });
});

describe("givenMeetingKeys", () => {
  test("a carried open-until card doesn't hide its cell's Up next (TRA-724)", () => {
    const keys = givenMeetingKeys([
      { place: "class", classId: "c1", dayKey: "2026-11-17", carried: false },
      { place: "class", classId: "c2", dayKey: "2026-11-17", carried: true },
      { place: "allDay", classId: "c3", dayKey: "2026-11-17", carried: false },
    ]);
    expect([...keys]).toEqual(["c1|2026-11-17"]);
  });
  test("a give drawn in another class's slot marks that slot (TRA-725)", () => {
    const keys = givenMeetingKeys([
      { place: "class", classId: "science", slotClassId: "math", dayKey: "2026-11-17" },
    ]);
    expect([...keys]).toEqual(["math|2026-11-17"]);
  });
});

describe("withGiveClock open-until wording", () => {
  const TZ = "Pacific/Honolulu";
  // Closes at the end of Tue Nov 24 (local midnight = Wed 10:00 UTC).
  const closes = Date.UTC(2026, 10, 25, 10, 0);
  const open = give({ endsAt: closes, afterEnd: "late", openUntilLabel: "Open until Tue" });

  test("seven days out, the card gains the date", () => {
    const now = Date.UTC(2026, 10, 17, 19, 0); // Tue Nov 17, 9am Honolulu
    expect(withGiveClock([open], now, TZ)[0].openUntilLabel).toBe("Open until Tue, Nov 24");
  });
  test("within the week it keeps the bare weekday, and the same object", () => {
    const now = Date.UTC(2026, 10, 18, 19, 0); // Wed Nov 18
    expect(withGiveClock([open], now, TZ)[0]).toBe(open);
  });
});

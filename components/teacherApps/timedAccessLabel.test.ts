import { describe, expect, test } from "vitest";
import type { AppTimedWindow } from "@/convex/appAudiences";
import { fullWindow, timedAccessLabel } from "./timedAccessLabel";

const TZ = "Pacific/Honolulu";
// Sat 2026-10-17 13:00 in Honolulu (UTC-10).
const NOW = Date.UTC(2026, 9, 17, 23, 0);
const HOUR = 60 * 60_000;

function w(overrides: Partial<AppTimedWindow>): AppTimedWindow {
  return {
    state: "live",
    source: "push",
    startsAt: NOW - HOUR,
    endsAt: NOW + HOUR,
    audience: "Seals",
    timeZone: TZ,
    ...overrides,
  };
}

describe("timedAccessLabel", () => {
  test("a live window ending today names only the time", () => {
    expect(timedAccessLabel(w({}), NOW, true)).toBe(
      "Live now · Seals until 2:00 PM",
    );
    expect(timedAccessLabel(w({}), NOW, false)).toBe("Live now · until 2:00 PM");
  });

  test("an Open until grant ending on another school day names the day", () => {
    const grant = w({ source: "grant", endsAt: NOW + 21 * HOUR });
    expect(timedAccessLabel(grant, NOW, true)).toBe(
      "Live now · Seals until Sun 10:00 AM",
    );
  });

  test("a later-today window ending after local midnight still names the end day", () => {
    // 11:30 PM Sat → 1:30 AM Sun local; UTC is the same calendar day for both.
    const late = w({ endsAt: NOW + 12.5 * HOUR });
    expect(timedAccessLabel(late, NOW, false)).toBe("Live now · until Sun 1:30 AM");
  });

  test("a next window today omits the day; one on another day names it", () => {
    const today = w({ state: "next", startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR });
    expect(timedAccessLabel(today, NOW, true)).toBe(
      "Next · 2:00 PM–3:00 PM, Seals",
    );
    const monday = w({
      state: "next",
      startsAt: NOW + 44 * HOUR,
      endsAt: NOW + 45 * HOUR,
    });
    expect(timedAccessLabel(monday, NOW, false)).toBe("Next · Mon 9:00 AM–10:00 AM");
  });

  test("the tooltip gives the full window; a grant gives only its end", () => {
    expect(fullWindow(w({}))).toBe("Sat 12:00 PM–2:00 PM");
    expect(fullWindow(w({ source: "grant", endsAt: NOW + 21 * HOUR }))).toBe(
      "Until Sun 10:00 AM",
    );
  });
});

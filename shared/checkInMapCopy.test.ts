import { describe, expect, test } from "vitest";

import {
  CHECK_IN_HOME_TITLE,
  checkInDomainChipLabel,
  checkInHomeCta,
  checkInHomeSubtitle,
  mapCompleteBody,
  mapGrowthBody,
  showCheckInHomeCard,
} from "./checkInMapCopy";

// ─────────────────────────────────────────────────────────────────────────
// The Home CTA's render/hide gate (decision 5: the CTA is an accelerator, not
// a fixture — it renders only while there's real servable work left, and
// disappears PERMANENTLY once the map completes). Pure so web
// (CheckInHomeCard.tsx) and native (CheckInHomeCard.tsx) can't diverge on WHEN
// to show it or WHAT it says.
// ─────────────────────────────────────────────────────────────────────────
describe("showCheckInHomeCard — the accelerator, never a fixture", () => {
  test("renders when the check-in is underway and the map isn't complete", () => {
    expect(
      showCheckInHomeCard({ hasServable: true, allMapped: false, started: true }),
    ).toBe(true);
  });

  test("hides once every eligible domain has converged, even if something is still servable", () => {
    // allMapped should win outright — a converged map never shows the CTA
    // again, regardless of any (theoretically impossible) servable leftover.
    expect(
      showCheckInHomeCard({ hasServable: true, allMapped: true, started: true }),
    ).toBe(false);
    expect(
      showCheckInHomeCard({ hasServable: false, allMapped: true, started: true }),
    ).toBe(false);
  });

  test("hides when there's nothing servable, even if the map isn't (yet) complete", () => {
    // e.g. every eligible domain is prereq-gated (`queued`) with nothing open.
    expect(
      showCheckInHomeCard({ hasServable: false, allMapped: false, started: true }),
    ).toBe(false);
  });

  test("hides on missing/loading progress rather than flashing the card", () => {
    expect(showCheckInHomeCard(null)).toBe(false);
    expect(showCheckInHomeCard(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The day-1 double-CTA guard. Observed on the test iPad 2026-08-19: a
// never-started scholar saw the compact accelerator ("Math check-in · 0 of 4
// domains mapped → Start check-in") stacked directly on top of the playlist
// card's own pre-placement check-in skin ("Math check-in" + "A few math
// questions to find where to start…" → "Start check-in") — two renderings of
// ONE signal, the T1 double. The never-started state belongs to the playlist
// card alone; this accelerator only exists once there is progress to
// accelerate. See the predicate's doc comment for the full handoff.
// ─────────────────────────────────────────────────────────────────────────
describe("showCheckInHomeCard — day 1 belongs to the playlist card, not the accelerator", () => {
  test("hides before any probe is answered, even with servable work left", () => {
    // The EXACT photographed state: 0 of 4 mapped, work available, untouched.
    expect(
      showCheckInHomeCard({ hasServable: true, allMapped: false, started: false }),
    ).toBe(false);
  });

  test("appears the moment the first probe lands, and stays until the map completes", () => {
    const servable = { hasServable: true, allMapped: false };
    expect(showCheckInHomeCard({ ...servable, started: false })).toBe(false);
    expect(showCheckInHomeCard({ ...servable, started: true })).toBe(true);
  });

  test("`started` never RESCUES a state the other two conjuncts already refuse", () => {
    // Guards the conjunct's polarity: started is a further narrowing, never a
    // widening — a complete map and a nothing-servable map both stay hidden.
    for (const started of [false, true]) {
      expect(
        showCheckInHomeCard({ hasServable: true, allMapped: true, started }),
      ).toBe(false);
      expect(
        showCheckInHomeCard({ hasServable: false, allMapped: false, started }),
      ).toBe(false);
    }
  });
});

describe("the CTA verb forks on whether the check-in has begun", () => {
  // NOTE: since the day-1 guard above, `showCheckInHomeCard` renders the home
  // card ONLY when `started` — so its sole consumer always asks for the
  // "Continue" branch, and "Start check-in" is unreachable FROM THAT CARD (the
  // playlist card's pre-placement skin says "Start check-in" from its own
  // shared/practiceChoiceSelection.ts verb ladder, not from here). The fork is
  // kept, not inlined, because the verb belongs with the rest of this card's
  // shared copy; collapsing it to a constant is a separate call.
  test("'Start check-in' before any probe is answered, 'Continue check-in' after", () => {
    expect(checkInHomeCta(false)).toBe("Start check-in");
    expect(checkInHomeCta(true)).toBe("Continue check-in");
  });

  test("neither verb nor title carries an arrow glyph (each frontend supplies its own)", () => {
    expect(checkInHomeCta(true)).not.toMatch(/→/);
    expect(checkInHomeCta(false)).not.toMatch(/→/);
    expect(CHECK_IN_HOME_TITLE).not.toMatch(/→/);
  });
});

describe("N-of-M copy — the one shared readout", () => {
  test("checkInHomeSubtitle names the honest N of M", () => {
    expect(checkInHomeSubtitle(3, 7)).toBe("3 of 7 domains mapped");
  });

  test("checkInDomainChipLabel appends the playlist's `· mapping` vocabulary", () => {
    expect(checkInDomainChipLabel("Whole Number Arithmetic")).toBe(
      "Whole Number Arithmetic · mapping",
    );
  });
});

describe("completion / growth body copy — framed as expansion, never regression", () => {
  test("mapCompleteBody names the full eligible count", () => {
    expect(mapCompleteBody(7)).toBe(
      "All 7 domains mapped. Every question from here starts from where you actually are.",
    );
  });

  test("mapGrowthBody never says the check-in became incomplete again", () => {
    const body = mapGrowthBody("Algebra Readiness", 7, 8);
    expect(body).toBe(
      "Algebra Readiness just opened up for you. Your map: 7 of 8 domains mapped.",
    );
    expect(body.toLowerCase()).not.toContain("incomplete");
  });
});

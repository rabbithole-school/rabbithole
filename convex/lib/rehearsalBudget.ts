// Duration-grounded turn budget for sim rehearsals.
//
// A rehearsal's budget is framed in MINUTES, not turns, and auto-populates
// from the activity's `durationMinutes` (the teacher already sets it). The
// sim then answers the real question — *does this activity fit the time it
// was given?* — instead of an arbitrary turn count. See the TODO and
// review/curriculum-rehearse-and-maturity.md.
//
// IMPORTANT (anti-rig-overfitting): the budget is ONLY the loop bound for
// how many turns a sim runs — it is NEVER injected into the tutor/sim
// prompt and must not become "hurry up" pressure. The judge already treats
// hitting the cap as not-a-failure, and the improver may not add urgency
// language; a duration-grounded cap is the principled version of that. If a
// sim still runs out of turns, that's a real signal the activity doesn't
// fit its allotted time — surface it, don't paper over it with speed
// pressure.

// Minutes per tutor↔scholar exchange. A real elementary exchange — the kid
// reads the tutor's message, thinks, composes a substantive reply, the
// tutor responds — runs roughly 2–3 minutes. This 2.5 is a REASONED
// ESTIMATE, not measured; calibrate it against prod by taking the median
// gap between consecutive `messages._creationTime` across a sample of real
// sessions (recipe: .agents/skills/prod-data-access/SKILL.md). Tune
// this one number when you have that median.
export const MINUTES_PER_TURN = 2.5;

// Even a short activity needs a few turns to land (a hook, a couple of
// Socratic exchanges, a wrap). Floor the derived cap here.
export const MIN_TURNS = 6;

// Cost ceiling: sim cost is turns × cast × variants × Anthropic calls, so a
// very long activity shouldn't blow the budget. A 75-min activity already
// hits this.
export const MAX_TURNS = 30;

// Budget for an activity with no Duration set (most authored activities do
// have one). 25 min ≈ a typical online activity. Replaces the old flat cap
// of 8 turns (≈ a 20-min budget), which sims "often ran out of" before
// reaching the goal.
export const DEFAULT_MINUTES = 25;

/** Turns a sim gets for an activity of `minutes` length (its Duration). */
export function turnsForMinutes(minutes: number | null | undefined): number {
  const m = minutes && minutes > 0 ? minutes : DEFAULT_MINUTES;
  return Math.min(MAX_TURNS, Math.max(MIN_TURNS, Math.round(m / MINUTES_PER_TURN)));
}

/** The minute budget shown to the teacher (auto-populated from Duration). */
export function budgetMinutes(minutes: number | null | undefined): number {
  return minutes && minutes > 0 ? minutes : DEFAULT_MINUTES;
}

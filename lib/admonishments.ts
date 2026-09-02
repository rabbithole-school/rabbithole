/**
 * Anti-parasocial chat chrome — the single caption line under the composer.
 *
 * North star: Rabbithole is a tool designed to be outgrown. This caption does
 * the PROACTIVE framing the system prompt can't — it tells the kid, every
 * session, what this thing is and isn't. It is deliberately:
 *
 *  - **Exactly ONE line, every surface.** Including touch, the kid's primary
 *    device (`isTouchDevice`), which used to get only a weak data line. Never
 *    two stacked lines — one line keeps the chrome quiet and unmissable.
 *  - **Third-person + tool-framed.** "Rabbithole has no feelings", never
 *    "I'm just a tool" — a first-person line re-personifies the very chrome
 *    that's supposed to de-personify the tutor.
 *  - **Deterministic.** Ordinary chat always shows the relational line. This is
 *    load-bearing safety chrome, not rotating helper copy.
 *  - **Homework-aware.** On at-home / unsupervised work the teacher-visibility
 *    line takes precedence (that's when "your teacher can read this" does the
 *    most behavioral work). Otherwise the relational line is the default.
 *
 * See `review/anti-parasocial-design.md` for the durable "why".
 */

import { RELATIONAL_LINE, TEACHER_LINE } from "@/shared/admonishments";

// Preserve the established web selector API while shared/ owns the copy.
export { RELATIONAL_LINE, TEACHER_LINE } from "@/shared/admonishments";

/**
 * Pick the ONE caption line for a session.
 *
 *  - `isHomework` → always the teacher-visibility line (precedence).
 *  - otherwise → always the relational anti-parasocial line.
 */
export function pickAdmonishment(
  opts: { isHomework?: boolean } = {},
): string {
  if (opts.isHomework) return TEACHER_LINE;
  return RELATIONAL_LINE;
}

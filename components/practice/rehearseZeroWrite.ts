/**
 * The zero-write seams of the practice session, factored OUT of the 4.5k-line
 * `PracticeSession` component so they can be exercised directly with spies.
 *
 * This is what makes the "nothing you answer here is recorded" claim CHECKABLE.
 * The machine now owns submission, offline replay, resume persistence and
 * terminal writes, and structurally emits no durable command in rehearsal.
 * The remaining helpers here guard write-bearing UI siblings outside that
 * machine: route eligibility, Example retrieval/generation, and closure lines.
 */

import { isStaffRole, type Role } from "@/convex/lib/roles";

/**
 * The ROUTE INVARIANT behind the zero-write guarantee: any STAFF member (every
 * non-scholar role — teacher, curriculum designer, admin, operations staff) practicing
 * as THEMSELVES can only rehearse. Independent of any `?rehearse=1` parameter,
 * so an old bookmark, a hand-edited URL, or a curriculum designer the Content
 * surface admits can never fall through to the real `submitAnswer` path.
 *
 * `hasRemoteScholar` excludes the deliberate `?remote=` teacher-drives-a-scholar
 * flow, which is NOT rehearsal (it writes to that scholar's own record).
 */
export function isStaffSelfRehearsal(
  role: Role | undefined | null,
  hasRemoteScholar: boolean,
): boolean {
  return isStaffRole(role) && !hasRemoteScholar;
}

/** The write capabilities the Example sheet is granted per mode: a rehearsal
 *  preview may SEE the same example but must mint nothing — no retrieval log,
 *  no on-demand generation (which writes AI-usage telemetry). */
export function exampleSheetWriteCaps(rehearse: boolean): {
  logRetrieval: boolean;
  allowGeneration: boolean;
} {
  return { logRetrieval: !rehearse, allowGeneration: !rehearse };
}

/** Whether the completion closure-line GENERATOR runs (`ensureClosureLine`
 *  records AI usage + upserts `closureLines`). Off for a remote view and for a
 *  rehearsal — both fall back to the deterministic headline. */
export function closureGenerationEnabled(isRemote: boolean, rehearse: boolean): boolean {
  return !isRemote && !rehearse;
}

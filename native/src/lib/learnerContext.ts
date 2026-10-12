// Whether the signed-in user can act as a learner on this device.
//
// The native app is scholar-facing: Home and the session screen mount
// learner-only queries (`asLearner: true`, `requireActiveLearnerInstitution`)
// that throw "A learner membership is required" for anyone else. A teacher can
// still land here — the dev autologin / dev-login button pointed at a staff
// user (TRA-316), or a staff account that signs in on an iPad — so callers
// decide from this predicate whether to mount those queries at all.
//
// Mirrors the server's `isLearner` in convex/lib/scholarEnrollment.ts: a
// learner is a `scholar` / `lifelong_learner` by top-level role OR by any
// membership carrying one of those roles. That is deliberately the SERVER's
// definition (will learner-only queries succeed?), not a UI-capability check —
// e.g. the session screen's "Wrap up" gate stays on top-level `scholar`
// because convex/masteryObservations.ts permits only that role.

const LEARNER_ROLES: ReadonlySet<string> = new Set([
  "scholar",
  "lifelong_learner",
]);

export type LearnerContextInput = {
  /** `api.users.currentUser` — `null` when signed out, `undefined` while loading. */
  me: { role?: string | null } | null | undefined;
  /** `api.memberships.myMemberships` — `undefined` while loading. */
  memberships: ReadonlyArray<{ role: string }> | undefined;
};

/**
 * `undefined` while either query is still loading (hold the spinner — don't
 * flash the staff landing at a scholar, or mount learner queries for staff).
 */
export function hasLearnerContext({
  me,
  memberships,
}: LearnerContextInput): boolean | undefined {
  if (me === undefined || memberships === undefined) return undefined;
  if (me?.role && LEARNER_ROLES.has(me.role)) return true;
  return memberships.some((membership) => LEARNER_ROLES.has(membership.role));
}

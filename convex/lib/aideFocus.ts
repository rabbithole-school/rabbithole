// The authorization decision for the /aide-stream "currently viewing" focus
// injection — factored out of the HTTP handler so it can be unit-tested (and so
// the fail-CLOSED contract is stated in one place).
//
// The dock sends an EPHEMERAL `focusScholarId` (the scholar the teacher is
// looking at right now) so the general chat thread re-contextualizes without
// binding. That id is NEVER trusted for auth: before we pre-load the scholar's
// records into the system prompt, the focus must be provably within the
// caller's visible universe (the same institution lens the scholar-read tools
// are scoped to).
//
// Fail CLOSED: earlier this gated `!allowedScholarIds || allowedScholarIds.has(id)`,
// which FAILED OPEN when the request omitted `scope` (a crafted POST from an
// out-of-lens teacher could inject any scholar's context). Now the caller must
// have communicated a lens (the dock always sends `scope`, even ""), and either
// that lens is unrestricted (a platform admin's "all" — sees everyone) or it
// explicitly contains the focus id.

import type { Id } from "../_generated/dataModel";

/**
 * The scope string the aide's institution lens must be resolved with.
 *
 * The client's `scope` may only NARROW the lens (and even then only to an
 * institution resolveInstitutionLens confirms the caller may see) — it can
 * never widen or OMIT the boundary. An absent scope therefore means "home"
 * (`""`), never "skip lens resolution".
 *
 * Factored out because the omission was the bug: /aide-stream used to resolve
 * the lens inside an `else if (typeof scope === "string")`, so any client that
 * simply left the field off got a completely unlensed toolset. A boundary that
 * depends on the client sending a field is not a boundary. Routing every
 * caller through this helper makes that shape hard to reintroduce.
 */
export function aideLensScope(scope: unknown): string {
  return typeof scope === "string" ? scope : "";
}

export function focusScholarAllowed(params: {
  /** The client sent a `scope` string (a lens was communicated). */
  scopeProvided: boolean;
  /** The lens is unrestricted (an admin's "all" — sees every scholar). */
  lensUnrestricted: boolean;
  /** The materialized set of visible scholars when the lens is restricted. */
  allowedScholarIds: Set<Id<"users">> | undefined;
  focusScholarId: Id<"users">;
}): boolean {
  // No lens communicated (Slack / MCP / legacy / a crafted POST) → deny.
  if (!params.scopeProvided) return false;
  // Admin "all" lens sees everyone.
  if (params.lensUnrestricted) return true;
  // Otherwise the focus must be explicitly in the caller's lens set.
  return params.allowedScholarIds?.has(params.focusScholarId) ?? false;
}

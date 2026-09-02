// Pure, view-agnostic helpers for the platform-admin Institutions list.
//
// Kept out of the component so the two things that must NOT drift are unit-
// pinned on their own: (1) the primary-institution safety invariant — the
// primary school offers NEITHER pause nor delete, mirroring the server's hard
// refusal in institutionLifecycle.ts / institutionDeletion.ts, and (2) the
// status + size formatting the row renders.

export interface InstitutionLifecycleState {
  isPrimary: boolean;
  disabled: boolean;
}

export interface InstitutionActions {
  canPause: boolean;
  canResume: boolean;
  canDelete: boolean;
}

/**
 * Which lifecycle actions a row may offer. The PRIMARY institution offers NONE
 * — the server refuses to pause or delete it, so the UI must visibly offer
 * neither (never weaken the guard to fit the UI). A non-primary row offers
 * pause when active, resume when paused, and delete either way.
 */
export function institutionActions({
  isPrimary,
  disabled,
}: InstitutionLifecycleState): InstitutionActions {
  if (isPrimary) return { canPause: false, canResume: false, canDelete: false };
  return { canPause: !disabled, canResume: disabled, canDelete: true };
}

export interface InstitutionStatusChip {
  label: string;
  palette: "green" | "orange";
}

/**
 * The active-vs-paused status chip. "Paused" keeps the existing suspension
 * vocabulary the scholar-facing gate already uses ("access is paused"); one
 * concept, one name.
 */
export function institutionStatus({
  disabled,
}: {
  disabled: boolean;
}): InstitutionStatusChip {
  return disabled
    ? { label: "Paused", palette: "orange" }
    : { label: "Active", palette: "green" };
}

/**
 * The batched size signal, from the live scholar count in `institutions.list`.
 * "1 scholar" / "N scholars" — one query for the whole table, no per-row query.
 */
export function scholarCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "scholar" : "scholars"}`;
}

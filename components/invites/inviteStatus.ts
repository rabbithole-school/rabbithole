export type InviteStatus = "active" | "revoked" | "expired" | "exhausted";

export function canRevokeInvite(status: InviteStatus): boolean {
  return status === "active";
}

export type GuardianRelationship =
  | ""
  | "parent"
  | "legal_guardian"
  | "other"
  | "mother"
  | "father"
  | "guardian";

export type NeutralGuardianRelationship =
  | ""
  | "parent"
  | "legal_guardian"
  | "other";

export const guardianRelationshipOptions = [
  ["parent", "Parent"],
  ["legal_guardian", "Legal guardian"],
  ["other", "Other"],
] as const satisfies ReadonlyArray<
  readonly [Exclude<NeutralGuardianRelationship, "">, string]
>;

// The parent-facing form offers the fuller set (Mother/Father in addition to the
// neutral options); "Other" reveals a free-text field so any relationship can be
// captured verbatim.
export const guardianRelationshipFormOptions = [
  ["mother", "Mother"],
  ["father", "Father"],
  ["parent", "Parent"],
  ["legal_guardian", "Legal guardian"],
  ["other", "Other"],
] as const satisfies ReadonlyArray<
  readonly [Exclude<GuardianRelationship, "">, string]
>;

export function normalizeGuardianRelationship(
  value: GuardianRelationship,
): NeutralGuardianRelationship {
  if (value === "mother" || value === "father") return "parent";
  if (value === "guardian") return "legal_guardian";
  return value;
}

export function guardianRelationshipLabel(
  value: GuardianRelationship,
  otherText?: string,
): string {
  switch (value) {
    case "mother":
      return "Mother";
    case "father":
      return "Father";
    case "parent":
      return "Parent";
    case "legal_guardian":
    case "guardian":
      return "Legal guardian";
    case "other":
      return otherText?.trim() ? otherText.trim() : "Other";
    default:
      return "Not provided";
  }
}

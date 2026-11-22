/**
 * Whether a scholar group is a primary (homeroom) class. A group with no type
 * predates the field and counts as primary.
 */
export function isPrimaryGroupType(type: string | null | undefined): boolean {
  return type == null || type === "" || type === "primary";
}

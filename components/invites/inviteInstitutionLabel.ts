export function createdInstitutionLabel(
  institutionName: string | null,
): string {
  return institutionName ?? "Deleted school";
}

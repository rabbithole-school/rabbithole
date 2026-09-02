export type InstitutionScopeOption = {
  slug: string;
  isPrimary: boolean;
};

export type ActiveInstitutionScope =
  | {
      scope: "institution";
      institutionSlug: string | null;
    }
  | {
      scope: "all";
      institutionSlug: string | null;
    }
  | undefined;

/**
 * Produces a select value that is always represented by its available options.
 * URL slugs stay authoritative; legacy ids and invalid values use the resolved
 * institution lens. Account filters retain their all-institutions option,
 * while School always falls back to one institution.
 */
export function canonicalInstitutionScope(
  requestedScope: string,
  activeInstitution: ActiveInstitutionScope,
  institutions: readonly InstitutionScopeOption[],
  mode: "all" | "institution",
) {
  const hasOption = (scope: string | null | undefined): scope is string =>
    !!scope && institutions.some((institution) => institution.slug === scope);

  if (mode === "all" && (requestedScope === "" || requestedScope === "all")) {
    return "";
  }
  if (hasOption(requestedScope)) return requestedScope;

  const activeScope =
    activeInstitution?.scope === "institution"
      ? activeInstitution.institutionSlug
      : null;
  if (hasOption(activeScope)) return activeScope;

  return mode === "all"
    ? ""
    : (institutions.find((institution) => institution.isPrimary)?.slug ??
      institutions[0]?.slug ??
      "");
}

export function withInstitutionScope(
  href: string,
  scopeParam: string | null | undefined,
): string {
  const scope = scopeParam ?? "";
  const [withoutHash, hash] = href.split("#", 2);
  const [path, query] = withoutHash.split("?", 2);
  const params = new URLSearchParams(query ?? "");
  if (scope) params.set("inst", scope);
  else params.delete("inst");
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}

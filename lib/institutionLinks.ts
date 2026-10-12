export type InstitutionScopeOption = {
  slug: string;
  isPrimary: boolean;
};

export type ActiveInstitutionScope =
  | {
      scope: "institution";
      institutionSlug: string | null;
      /**
       * Did the lens actually honor `requestedScope`? Straight from
       * `institutionLensClientPayload` — see the precedence note below.
       */
      honored: boolean;
    }
  | {
      scope: "all";
      institutionSlug: string | null;
      honored: boolean;
    }
  | undefined;

/**
 * Produces a select value that is always represented by its available options.
 *
 * The SERVER is authoritative about which school is actually in effect: a URL
 * slug is only kept as the controlled value when the lens reports it `honored`.
 * An unhonored request (a suspended school, a non-member slug, a legacy id)
 * scopes every read on the page to the resolved school, so the picker must name
 * THAT school — showing the requested one would tell an operator they are
 * looking at a school whose data is not on screen. Account filters retain their
 * all-institutions option, while School always falls back to one institution.
 */
export function canonicalInstitutionScope(
  requestedScope: string,
  activeInstitution: ActiveInstitutionScope,
  institutions: readonly InstitutionScopeOption[],
  mode: "all" | "institution",
) {
  const hasOption = (scope: string | null | undefined): scope is string =>
    !!scope && institutions.some((institution) => institution.slug === scope);

  // While the lens query is in flight there is nothing better to trust than the
  // URL, and snapping the value early would flicker the picker.
  const honored = activeInstitution ? activeInstitution.honored : true;

  if (mode === "all" && (requestedScope === "" || requestedScope === "all")) {
    return "";
  }
  if (honored && hasOption(requestedScope)) return requestedScope;

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

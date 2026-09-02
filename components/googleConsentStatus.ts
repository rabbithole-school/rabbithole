type GoogleConsentStatus = {
  hasRefreshToken?: boolean;
  requiresReconsent?: boolean;
  grantedScopes?: readonly string[];
  missingRequiredScopes?: readonly string[];
};

export type GoogleAccessRequirement = "all" | "drive" | "slides" | "workspace";

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";

const REQUIRED_SCOPES: Record<
  Exclude<GoogleAccessRequirement, "all">,
  readonly string[]
> = {
  drive: [DRIVE_READ_SCOPE],
  slides: [SLIDES_SCOPE, DRIVE_FILE_SCOPE, DRIVE_READ_SCOPE],
  workspace: [DOCS_SCOPE, SLIDES_SCOPE, DRIVE_FILE_SCOPE],
};

const CAPABILITY_BY_SCOPE: Record<string, string> = {
  "https://www.googleapis.com/auth/documents": "Google Docs",
  "https://www.googleapis.com/auth/presentations": "Google Slides",
  "https://www.googleapis.com/auth/drive.file": "Google Drive",
  "https://www.googleapis.com/auth/drive.readonly": "Google Drive",
};

function missingScopesFor(
  status: GoogleConsentStatus,
  requirement: GoogleAccessRequirement,
): readonly string[] {
  if (requirement === "all") {
    return status.missingRequiredScopes ?? [];
  }
  const granted = new Set(status.grantedScopes ?? []);
  return REQUIRED_SCOPES[requirement].filter((scope) => !granted.has(scope));
}

export function needsGoogleReconsent(
  status: GoogleConsentStatus,
  requirement: GoogleAccessRequirement = "all",
): boolean {
  if (!status.hasRefreshToken) return true;
  return requirement === "all"
    ? !!status.requiresReconsent
    : missingScopesFor(status, requirement).length > 0;
}

export function describeMissingGoogleCapabilities(
  missingScopes: readonly string[] | undefined,
): string {
  const capabilities = [
    ...new Set(
      (missingScopes ?? [])
        .map((scope) => CAPABILITY_BY_SCOPE[scope])
        .filter((capability): capability is string => !!capability),
    ),
  ];

  if (capabilities.length === 0) {
    return "Required Google access is missing.";
  }
  if (capabilities.length === 1) {
    return `${capabilities[0]} access is missing.`;
  }
  if (capabilities.length === 2) {
    return `${capabilities.join(" and ")} access is missing.`;
  }
  return `${capabilities.slice(0, -1).join(", ")}, and ${capabilities.at(-1)} access is missing.`;
}

export function googleReconsentReason(
  status: GoogleConsentStatus,
  requirement: GoogleAccessRequirement = "all",
): string {
  if (!status.hasRefreshToken) {
    if (requirement === "drive") {
      return "Google needs a new connection to keep Drive access working.";
    }
    if (requirement === "slides") {
      return "Google needs a new connection to keep Google Slides and Drive access working.";
    }
    if (requirement === "workspace") {
      return "Google needs a new connection to keep Google Docs and Google Slides access working.";
    }
    return "Google needs a new connection to keep Google Docs, Google Slides, and Drive access working.";
  }
  const missingScopes = missingScopesFor(status, requirement);
  if (
    requirement === "workspace" &&
    missingScopes.length === 1 &&
    missingScopes[0] === DRIVE_FILE_SCOPE
  ) {
    return "Google file creation access is missing.";
  }
  return describeMissingGoogleCapabilities(
    requirement === "workspace"
      ? missingScopes.filter((scope) => scope !== DRIVE_FILE_SCOPE)
      : missingScopes,
  );
}

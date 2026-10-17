/**
 * Framework-free artifact helpers shared by the web and native surfaces.
 * Sync changes into native/vendor/vibecode/helpers.ts with native/scripts/sync-vendor.js.
 */
export const CODE_TOOLS = new Set(["create_code", "edit_document"]);

export function looksLikeHtml(content: string): boolean {
  const normalized = content.trimStart().toLowerCase();
  if (!normalized.includes("<")) return false;
  return (
    normalized.startsWith("<!doctype html") ||
    normalized.startsWith("<html") ||
    normalized.includes("<body") ||
    normalized.includes("<div") ||
    normalized.includes("<style") ||
    normalized.includes("<script") ||
    normalized.includes("<canvas") ||
    normalized.includes("<svg")
  );
}

type ArtifactCandidate = {
  _creationTime: number;
  content: string;
  type?: string;
};

export function newestHtmlArtifact<T extends ArtifactCandidate>(
  artifacts: readonly T[] | null | undefined,
): T | null {
  if (!artifacts) return null;
  let newest: T | null = null;
  for (const artifact of artifacts) {
    if (artifact.type === "map") continue;
    if (!looksLikeHtml(artifact.content)) continue;
    if (!newest || artifact._creationTime > newest._creationTime) {
      newest = artifact;
    }
  }
  return newest;
}

/**
 * The app a builder shows (TRA-519): the one its Open named (`requestedId`,
 * the web `?app=` query param / the native `app` route param) when that is
 * still one of the session's apps, else the newest. Opening an older app's
 * card must edit, check and restore THAT app, not the newest one.
 */
export function builderHtmlArtifact<
  T extends ArtifactCandidate & { _id: string },
>(
  artifacts: readonly T[] | null | undefined,
  requestedId: string | null | undefined,
): T | null {
  if (requestedId && artifacts) {
    const requested = artifacts.find(
      (artifact) =>
        String(artifact._id) === requestedId &&
        artifact.type !== "map" &&
        looksLikeHtml(artifact.content),
    );
    if (requested) return requested;
  }
  return newestHtmlArtifact(artifacts);
}

/** The ids of a session's apps (the builder's candidates). */
export function htmlAppIds(
  artifacts: readonly (ArtifactCandidate & { _id: string })[] | null | undefined,
): Set<string> {
  return new Set(
    (artifacts ?? [])
      .filter((a) => a.type !== "map" && looksLikeHtml(a.content))
      .map((a) => String(a._id)),
  );
}

/**
 * An app that appeared since the builder last looked (`knownIds`), newest
 * first — e.g. the designer's create_code. A builder pinned to an older app
 * (`?app=` / the `app` route param) follows it there, so the screen shows the
 * app the AI just made. Null on the first look (`knownIds` null) or when
 * nothing new arrived.
 */
export function newlyAddedHtmlApp<T extends ArtifactCandidate & { _id: string }>(
  knownIds: ReadonlySet<string> | null,
  artifacts: readonly T[] | null | undefined,
): T | null {
  if (!knownIds || !artifacts) return null;
  return newestHtmlArtifact(
    artifacts.filter((a) => !knownIds.has(String(a._id))),
  );
}

/**
 * The History versions of one app. Revisions are recorded per session, and a
 * Restore writes a version into the app on screen, so a builder lists only
 * the app's own versions — never another app's. Undefined while loading.
 */
export function revisionsForApp<T extends { artifactId: string }>(
  revisions: readonly T[] | null | undefined,
  artifactId: string | null | undefined,
): T[] | undefined {
  if (!revisions) return undefined;
  if (!artifactId) return [];
  return revisions.filter((rev) => rev.artifactId === artifactId);
}

export type BuilderAppChoice = { id: string; label: string };

/** The switcher's accessible name (web + native). */
export const SWITCH_APP_LABEL = "Switch app";

/**
 * The apps a builder-primary session can switch between (TRA-519): every app
 * in the session, oldest first (a teacher's starter app leads), labelled by
 * its title. A repeated title gets " (2)", " (3)" so two apps never read
 * alike. Empty for a session with one app — that builder shows no switcher.
 */
export function builderAppChoices(
  artifacts:
    | readonly (ArtifactCandidate & { _id: string; title?: string })[]
    | null
    | undefined,
): BuilderAppChoice[] {
  const apps = (artifacts ?? [])
    .filter((a) => a.type !== "map" && looksLikeHtml(a.content))
    .sort((a, b) => a._creationTime - b._creationTime);
  if (apps.length < 2) return [];
  const seen = new Map<string, number>();
  return apps.map((app) => {
    const base = app.title?.trim() || "Untitled app";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: String(app._id), label: n === 1 ? base : `${base} (${n})` };
  });
}

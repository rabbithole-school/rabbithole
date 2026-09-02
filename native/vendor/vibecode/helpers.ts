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

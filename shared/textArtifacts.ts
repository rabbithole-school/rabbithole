/**
 * Plain-text CAS applies only to legacy, text, and code artifacts. Structured
 * types ("map", "slides", "manipulative") own their own update contracts and
 * are never text-editable, so this allowlist deliberately excludes them.
 */
export function isTextArtifact(
  artifact: { type?: string } | null | undefined,
): boolean {
  return (
    artifact?.type === undefined ||
    artifact.type === "text" ||
    artifact.type === "code"
  );
}

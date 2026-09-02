import {
  redactTaskForClient,
  type StoredMapArtifact,
} from "./types";

export function parseStoredMapArtifact(
  content: string,
): StoredMapArtifact | null {
  try {
    const parsed = JSON.parse(content) as StoredMapArtifact;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      !parsed.spec ||
      !Array.isArray(parsed.scholarPins)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Produce the same no-spoiler map projection used on scholar surfaces.
 * Family snapshots use this projection so a task map cannot reveal its answer.
 */
export function projectStoredMapForScholar(content: string): string | null {
  const stored = parseStoredMapArtifact(content);
  if (!stored) return null;
  if (!stored.spec.task) return content;
  return JSON.stringify({
    ...stored,
    spec: {
      ...stored.spec,
      task: redactTaskForClient(stored.spec.task),
    },
  } satisfies StoredMapArtifact);
}

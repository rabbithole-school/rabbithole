import {
  clearAllArtifactDrafts,
  clearArtifactDraft,
} from "@/shared/artifactDraftStore";

const artifactFlushers = new Map<string, () => Promise<void>>();

export function registerArtifactSave(
  artifactId: string,
  flush: () => Promise<void>,
): () => void {
  artifactFlushers.set(artifactId, flush);
  return () => {
    // Switching documents must not discard a debounced draft. Keep this
    // in-flight save registered so a concurrent chat flush still waits for it.
    const pending = flush();
    const awaitPending = () => pending;
    artifactFlushers.set(artifactId, awaitPending);
    void pending.then(() => {
      if (artifactFlushers.get(artifactId) === awaitPending) {
        artifactFlushers.delete(artifactId);
      }
    }).catch(() => undefined);
  };
}

export function clearArtifactSave(artifactId: string): void {
  artifactFlushers.delete(artifactId);
  clearArtifactDraft(artifactId);
}

export function clearAllArtifactSaves(): void {
  artifactFlushers.clear();
  clearAllArtifactDrafts();
}

export async function flushAllArtifactSaves(): Promise<void> {
  await Promise.all(Array.from(artifactFlushers.values(), (flush) => flush()));
}

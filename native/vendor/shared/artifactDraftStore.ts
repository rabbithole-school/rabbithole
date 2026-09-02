export type ArtifactDraftSnapshot = {
  content: string;
  title?: string;
  serverContent: string;
  serverTitle?: string;
  revision: number;
  conflict: boolean;
};

type ArtifactDraftEntry = {
  owner: symbol;
  draft?: ArtifactDraftSnapshot;
};

const artifactDrafts = new Map<string, ArtifactDraftEntry>();

export function getArtifactDraft(artifactId: string): ArtifactDraftSnapshot | undefined {
  const draft = artifactDrafts.get(artifactId)?.draft;
  return draft ? { ...draft } : undefined;
}

export function hasArtifactDraftConflict(
  draft: ArtifactDraftSnapshot | undefined,
  current: { content: string; title?: string },
): boolean {
  if (!draft) return false;
  if (draft.conflict) return true;
  const contentChangedUnderDraft =
    draft.content !== draft.serverContent &&
    current.content !== draft.serverContent &&
    current.content !== draft.content;
  const titleChangedUnderDraft =
    draft.title !== draft.serverTitle &&
    current.title !== draft.serverTitle &&
    current.title !== draft.title;
  return contentChangedUnderDraft || titleChangedUnderDraft;
}

export function hasIncomingArtifactConflict(
  localContent: string,
  previousServerContent: string,
  incomingServerContent: string,
): boolean {
  return (
    localContent !== previousServerContent &&
    incomingServerContent !== localContent
  );
}

export function setArtifactDraft(
  artifactId: string,
  draft: ArtifactDraftSnapshot,
): void {
  artifactDrafts.set(artifactId, { owner: Symbol(artifactId), draft: { ...draft } });
}

export function clearArtifactDraft(
  artifactId: string,
  expected?: ArtifactDraftSnapshot,
): void {
  if (expected) {
    const current = artifactDrafts.get(artifactId)?.draft;
    if (
      !current ||
      current.content !== expected.content ||
      current.title !== expected.title ||
      current.serverContent !== expected.serverContent ||
      current.serverTitle !== expected.serverTitle ||
      current.revision !== expected.revision ||
      current.conflict !== expected.conflict
    ) {
      return;
    }
  }
  artifactDrafts.delete(artifactId);
}

export function createArtifactDraftController(artifactId: string) {
  const owner = Symbol(artifactId);
  let draft = getArtifactDraft(artifactId);
  return {
    initialDraft: draft,
    claim(): void {
      artifactDrafts.set(artifactId, {
        owner,
        ...(draft ? { draft: { ...draft } } : {}),
      });
    },
    write(next: ArtifactDraftSnapshot): boolean {
      if (artifactDrafts.get(artifactId)?.owner !== owner) return false;
      draft = { ...next };
      artifactDrafts.set(artifactId, { owner, draft });
      return true;
    },
    clear(): boolean {
      if (artifactDrafts.get(artifactId)?.owner !== owner) return false;
      draft = undefined;
      artifactDrafts.delete(artifactId);
      return true;
    },
  };
}

export function clearAllArtifactDrafts(): void {
  artifactDrafts.clear();
}

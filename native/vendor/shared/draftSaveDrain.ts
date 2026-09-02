export function createDraftSaveDrain<T>({
  hasPending,
  readDraft,
  save,
}: {
  hasPending: () => boolean;
  readDraft: () => T;
  save: (draft: T) => Promise<void>;
}): () => Promise<void> {
  let pending: Promise<void> | null = null;

  return () => {
    if (pending) return pending;
    const run = (async () => {
      while (hasPending()) {
        await save(readDraft());
      }
    })();
    pending = run;
    const clear = () => {
      if (pending === run) pending = null;
    };
    void run.then(clear, clear);
    return run;
  };
}

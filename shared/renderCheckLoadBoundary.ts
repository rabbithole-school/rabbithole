import type { AppSnapshotLoadBoundary } from "@/hooks/useAppStateIframeBridge";

/**
 * The load boundary a render check must wait PAST before capturing.
 *
 * For an in-place edit of the artifact the check was armed on, the capture
 * must wait for the frame to reload past the pre-edit boundary (version + 1,
 * fresh nonce), or the tutor is shown the old render. For a BRAND-NEW artifact
 * there is no old render to wait past: handing the capture the previous
 * frame's boundary demanded a reload that may never come, so the first render
 * check answered with state but no picture (TRA-300). `undefined` lets the
 * bridge capture as soon as the first load settles — the same rule native
 * shipped in `native/src/lib/renderCheck.ts`.
 */
export function renderCheckLoadBoundary(
  baseline: {
    id: string;
    loadBoundary?: AppSnapshotLoadBoundary | null;
  } | null,
  artifactId: string,
): AppSnapshotLoadBoundary | undefined {
  return baseline?.id === artifactId
    ? (baseline.loadBoundary ?? undefined)
    : undefined;
}

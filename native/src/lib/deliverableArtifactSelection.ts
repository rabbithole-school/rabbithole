/**
 * pickDefaultArtifact — which artifact the native deliverable panel opens on
 * when the scholar has not explicitly chosen one (TRA-274).
 *
 * The panel used to resolve the shown artifact as `selected ?? newest`, so a
 * tutor-made side artifact (e.g. a counter app) evicted the writing doc the
 * activity actually asked for. This rule instead prefers the EARLIEST-CREATED
 * artifact whose type matches the activity's deliverable kind — a text/untyped
 * artifact for a `text` deliverable, a `code` artifact for an `artifact` (code
 * app) deliverable — and falls back to the newest only when nothing matches.
 *
 * "Earliest, not last-edited" resolves the design's open question: when more
 * than one artifact matches, the original doc the activity started with wins.
 *
 * Pure and self-contained: it sorts by `_creationTime` internally, so callers
 * need not pre-sort and "earliest"/"newest" are well-defined regardless of
 * input order.
 */

/** Activity deliverable kinds (mirrors the `activities.deliverable.kind` union). */
export type DeliverableKind =
  | "photo"
  | "artifact"
  | "slides"
  | "text"
  | "audio"
  | "map";

/** The only artifact fields the selection rule reads. */
export type SelectableArtifact = {
  _id: string;
  _creationTime: number;
  /** Undefined = legacy untyped artifact; otherwise "text" | "code" | … */
  type?: string;
};

/**
 * Deliverable kinds whose submission row carries NO `artifactId` — the work is
 * the file itself, not a document. `deliverables.submit` stores a photo with a
 * `fileStorageId` and no artifact (DeliverablePanel's handleCapturePhoto), so
 * scoping the lookup to a document can only ever exclude it.
 *
 * Only `photo` qualifies today. `audio` has no capture surface at all, and the
 * generic rubric path (`applyRubricScoreFromTool`) would create an
 * artifact-scoped row for it, so listing it here on the strength of its NAME
 * would un-scope a kind that is artifact-backed in practice. Add it when an
 * audio submission actually writes a file-backed, artifact-less row.
 *
 * Naming the artifact-LESS kinds rather than the artifact-backed ones is
 * deliberate: an allowlist silently un-scopes every kind added later.
 */
const ARTIFACT_LESS_DELIVERABLE_KINDS: ReadonlySet<DeliverableKind> = new Set([
  "photo",
]);

/**
 * The `artifactId` the deliverable lookup should be scoped to, given the
 * artifact the panel is currently showing. Artifact-less kinds resolve to
 * `undefined` so the query falls back to the activity's own submission row.
 *
 * An unknown kind (the activity query still loading) stays scoped: that is what
 * every artifact-backed kind wants, and a photo corrects itself the moment the
 * activity resolves.
 *
 * NOTE this decides only WHETHER to scope, not to what. WHAT is the artifact
 * the caller resolved — for `slides`/`map` that must be the deck/map from
 * `dedicatedDeliverableArtifact` (below), never the text-document selection:
 * un-scoping instead would resolve some other row in the same activity.
 */
export function artifactIdForDeliverableLookup<T>(
  artifactId: T | null | undefined,
  deliverableKind: DeliverableKind | null | undefined,
): T | undefined {
  if (deliverableKind && ARTIFACT_LESS_DELIVERABLE_KINDS.has(deliverableKind)) {
    return undefined;
  }
  return artifactId ?? undefined;
}

/**
 * Deliverable kinds whose work is ONE dedicated artifact of the same `type` —
 * the deck for `slides`, the map for `map` — rather than a text/code document.
 * Their rows are stamped with that artifact's id by `applyRubricScoreFromTool`.
 */
const DEDICATED_ARTIFACT_DELIVERABLE_KINDS: ReadonlySet<DeliverableKind> =
  new Set(["slides", "map"]);

/**
 * The work artifact for a deliverable kind that has a dedicated artifact type
 * (TRA-339): the EARLIEST artifact whose `type` equals the kind — the same
 * artifact the server scores (`resolveScorableArtifactId`) and the slides
 * editor opens (`SlidesDeliverable`). Pass the session's UNFILTERED artifact
 * list: the text-document list (`isTextArtifact`) deliberately excludes decks
 * and maps, which is how a slides activity used to scope its lookup to a side
 * document instead of the deck.
 *
 * Returns `null` when the kind is dedicated but the session has no such
 * artifact yet (never a fallback to a document), and `undefined` when the kind
 * is not dedicated — the caller then uses its text-document selection.
 */
export function dedicatedDeliverableArtifact<T extends SelectableArtifact>(
  artifacts: readonly T[],
  deliverableKind: DeliverableKind | null | undefined,
): T | null | undefined {
  if (!deliverableKind || !DEDICATED_ARTIFACT_DELIVERABLE_KINDS.has(deliverableKind)) {
    return undefined;
  }
  let earliest: T | null = null;
  for (const artifact of artifacts) {
    if (artifact.type !== deliverableKind) continue;
    if (!earliest || artifact._creationTime < earliest._creationTime) {
      earliest = artifact;
    }
  }
  return earliest;
}

/**
 * Whether an artifact of `artifactType` is the kind of work `deliverableKind`
 * asked for. The `"artifact"` deliverable kind is the code/app kind — it seeds
 * a `code` artifact server-side (see convex/lib/sessionActivitySetup.ts).
 */
export function artifactMatchesDeliverableKind(
  artifactType: string | undefined,
  deliverableKind: DeliverableKind | null | undefined,
): boolean {
  switch (deliverableKind) {
    case "text":
      return artifactType === undefined || artifactType === "text";
    case "artifact":
      return artifactType === "code";
    default:
      return false;
  }
}

export function pickDefaultArtifact<T extends SelectableArtifact>(
  artifacts: readonly T[],
  deliverableKind: DeliverableKind | null | undefined,
): T | null {
  if (artifacts.length === 0) return null;
  const byCreation = [...artifacts].sort(
    (a, b) => a._creationTime - b._creationTime,
  );
  const match = byCreation.find((artifact) =>
    artifactMatchesDeliverableKind(artifact.type, deliverableKind),
  );
  return match ?? byCreation[byCreation.length - 1];
}

/**
 * nextAutoSelect — the pure state machine behind the panel's "auto-open an
 * artifact that appears AFTER first load" behavior (TRA-274). It decides, from
 * the previous view of a session's artifact ids and the current one, whether a
 * genuinely-new artifact just appeared that should be auto-selected once.
 *
 * The rules it enforces (each is exercised by a unit test):
 *  - The baseline is established on the FIRST NON-EMPTY snapshot. An initial
 *    empty snapshot (undefined → [] while the query loads) must NOT establish
 *    it, or the first real artifact would look "new" and steal selection from
 *    pickDefaultArtifact.
 *  - `seenIds` is MONOTONIC: ids are only ever added, never dropped. So a
 *    transient empty snapshot followed by the same ids reappearing selects
 *    nothing (they are already seen).
 *  - One genuine addition selects that id (the last, if several arrive at once).
 *  - It is idempotent: re-running with an already-seen set selects nothing, so a
 *    scholar-created artifact (whose id the caller already selected in
 *    handleCreateArtifact) is registered as seen but not re-selected on the next
 *    render — no double-handling.
 *
 * `seenIds` is reset by the caller when the sessionId changes (monotonic only
 * WITHIN a session); the machine itself is session-agnostic.
 */
export type AutoSelectInput = {
  seenIds: readonly string[];
  ids: readonly string[];
  baselineEstablished: boolean;
};

export type AutoSelectResult = {
  select?: string;
  seenIds: string[];
  baselineEstablished: boolean;
};

export function nextAutoSelect(input: AutoSelectInput): AutoSelectResult {
  const { seenIds, ids, baselineEstablished } = input;

  if (!baselineEstablished) {
    // An empty (still-loading or genuinely-empty) snapshot cannot establish a
    // baseline — wait for the first snapshot that actually has artifacts.
    if (ids.length === 0) {
      return { seenIds: [...seenIds], baselineEstablished: false };
    }
    return { seenIds: [...ids], baselineEstablished: true };
  }

  const seen = new Set(seenIds);
  const appeared = ids.filter((id) => !seen.has(id));
  // Monotonic union — never drop an id, so a transient empty snapshot can't make
  // already-seen ids look new when they return.
  const mergedSeen = [...seenIds];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      mergedSeen.push(id);
    }
  }
  return {
    select: appeared.length > 0 ? appeared[appeared.length - 1] : undefined,
    seenIds: mergedSeen,
    baselineEstablished: true,
  };
}

/**
 * What the session's work surface — DeliverablePanel (landscape) /
 * DeliverableCard (portrait) — renders (TRA-463).
 *
 * The tutor's `edit_document` create works in EVERY session (artifacts are
 * keyed by session, not activity), but these two components used to render
 * nothing unless the session's activity carried a `deliverable`. They are the
 * only native surfaces for text/code artifacts, so a tutor-made document in an
 * open exploration, a unit-level planning chat, or a deliverable-less activity
 * was invisible on iPad while web showed it.
 *
 *  - `"loading"`     — the session has an activity that has not loaded yet
 *                      (the deliverable kind is unknown, so skeleton as before).
 *  - `"deliverable"` — the activity asks for a deliverable: the full surface
 *                      (prompt, rubric flair, check / hand-in) exactly as before.
 *  - `"documents"`   — no deliverable, but the session holds text/code
 *                      artifacts: show and edit them, with none of the
 *                      deliverable-only parts (nothing to check or hand in).
 *  - `"none"`        — nothing to show; the caller renders nothing (no empty
 *                      panel), including while the artifact list is loading.
 */
export type WorkSurface = "loading" | "deliverable" | "documents" | "none";

export function workSurfaceFor({
  hasActivity,
  activity,
  textArtifactCount,
}: {
  /** Whether the session is attached to an activity at all. */
  hasActivity: boolean;
  /** The activity query result: `undefined` while loading, `null` if missing. */
  activity: { deliverable?: unknown } | null | undefined;
  /** Text/code artifacts in the session; `undefined` while loading. */
  textArtifactCount: number | undefined;
}): WorkSurface {
  if (hasActivity && activity === undefined) return "loading";
  if (hasActivity && activity?.deliverable) return "deliverable";
  return (textArtifactCount ?? 0) > 0 ? "documents" : "none";
}

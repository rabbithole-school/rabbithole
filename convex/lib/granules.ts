/**
 * Granules — the unit's EQs/EUs as stable-keyed mastery atoms.
 *
 * `units.essentialQuestions` / `enduringUnderstandings` historically were
 * bare string arrays. granuleEvidence rows need a stable identity to
 * attribute observations to, so each entry now carries a `key`. These
 * helpers are the single place the two shapes meet:
 *
 *  - READS go through `normalizeGranules` (or `granuleTexts` when only
 *    display text is needed). Legacy strings get a DETERMINISTIC
 *    text-hash key, so evidence recorded against a not-yet-migrated
 *    unit stays attached once the migration stores those same keys.
 *  - Plain-string WRITES go through `toKeyedGranules`, which preserves the
 *    existing key for an unchanged text and mints a fresh key for a new one.
 *    Key-aware editors use `mergeKeyedGranules`, preserving each carried key
 *    across in-place text edits so existing evidence stays attached.
 *
 * Pure module — no ctx, no Convex imports — so it's importable from
 * frontend components and unit-testable per rabbithole-test-strategy.
 */

export type Granule = { key: string; text: string };
export type GranuleKind = "eq" | "eu";
export type RawGranuleList = string[] | Granule[] | null | undefined;

export type GranuleStatus = "green" | "yellow" | "gray";

/** Minimal evidence shape needed to derive status. */
export type GranuleEvidenceLike = {
  granuleKey: string;
  outcome: "demonstrated" | "probed";
};

// djb2, base36 — short, deterministic, good enough for per-unit lists.
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Deterministic key for a legacy (string) entry. Used by both
 * normalize-at-read and the migration, so the keys agree.
 */
export function legacyGranuleKey(kind: GranuleKind, text: string): string {
  return `${kind}:t${hashText(text.trim())}`;
}

/**
 * Fresh key for a newly authored granule. Math.random is fine here:
 * browsers and Node are obvious, and the Convex runtime makes it
 * deterministic-replayable inside mutations.
 */
export function newGranuleKey(kind: GranuleKind): string {
  return `${kind}:r${Math.random().toString(36).slice(2, 10)}`;
}

/** De-dupe keys within one list (legacy duplicate texts hash alike). */
function uniquifyKeys(list: Granule[]): Granule[] {
  const seen = new Map<string, number>();
  return list.map((g) => {
    const n = seen.get(g.key) ?? 0;
    seen.set(g.key, n + 1);
    return n === 0 ? g : { ...g, key: `${g.key}-${n + 1}` };
  });
}

/**
 * Normalize either stored shape to keyed objects. Legacy strings get
 * deterministic text-hash keys; already-keyed entries pass through.
 */
export function normalizeGranules(
  raw: RawGranuleList,
  kind: GranuleKind,
): Granule[] {
  if (!raw || raw.length === 0) return [];
  const keyed = raw.map((entry) =>
    typeof entry === "string"
      ? { key: legacyGranuleKey(kind, entry), text: entry }
      : entry,
  );
  return uniquifyKeys(keyed);
}

/** Display texts regardless of stored shape. */
export function granuleTexts(raw: RawGranuleList): string[] {
  if (!raw) return [];
  return raw.map((entry) => (typeof entry === "string" ? entry : entry.text));
}

/**
 * Convert an incoming text array (UI / bot tools speak plain strings)
 * into keyed granules, preserving keys of entries whose text already
 * exists on the unit. Blank texts are dropped.
 */
export function toKeyedGranules(
  texts: string[],
  existingRaw: RawGranuleList,
  kind: GranuleKind,
): Granule[] {
  const existing = normalizeGranules(existingRaw, kind);
  const byText = new Map<string, Granule[]>();
  for (const g of existing) {
    const t = g.text.trim();
    const bucket = byText.get(t);
    if (bucket) bucket.push(g);
    else byText.set(t, [g]);
  }
  const result: Granule[] = [];
  for (const rawText of texts) {
    const text = rawText.trim();
    if (!text) continue;
    const bucket = byText.get(text);
    const match = bucket?.shift();
    result.push(match ?? { key: newGranuleKey(kind), text });
  }
  return uniquifyKeys(result);
}

/**
 * Merge a key-aware editor payload into the existing granule list. Known keys
 * remain attached even when the text changes; missing or stale keys represent
 * genuinely new granules and get fresh identity.
 */
export function mergeKeyedGranules(
  incoming: Array<{ key?: string; text: string }>,
  existingRaw: RawGranuleList,
  kind: GranuleKind,
): Granule[] {
  const existingKeys = new Set(
    normalizeGranules(existingRaw, kind).map((g) => g.key),
  );
  const result: Granule[] = [];

  for (const item of incoming) {
    const text = item.text.trim();
    if (!text) continue;
    result.push({
      key:
        item.key && existingKeys.has(item.key)
          ? item.key
          : newGranuleKey(kind),
      text,
    });
  }

  return uniquifyKeys(result);
}

/** A unit-like doc carrying the two granule fields (either shape). */
export type GranuleFields = {
  essentialQuestions?: RawGranuleList;
  enduringUnderstandings?: RawGranuleList;
};

export type UnitGranule = Granule & { kind: GranuleKind };

/** The unit's full granule list — EQs then EUs, kind-tagged. */
export function unitGranules(unit: GranuleFields): UnitGranule[] {
  return [
    ...normalizeGranules(unit.essentialQuestions, "eq").map((g) => ({
      ...g,
      kind: "eq" as const,
    })),
    ...normalizeGranules(unit.enduringUnderstandings, "eu").map((g) => ({
      ...g,
      kind: "eu" as const,
    })),
  ];
}

/**
 * Derive per-granule status from evidence rows. Status is never
 * stored: green if any demonstration, yellow if probed only, gray if
 * never touched. Green sticks — later "probed" rows don't demote.
 */
export function deriveGranuleStatuses(
  granules: { key: string }[],
  evidence: GranuleEvidenceLike[],
): Map<string, GranuleStatus> {
  const statuses = new Map<string, GranuleStatus>();
  for (const g of granules) statuses.set(g.key, "gray");
  for (const e of evidence) {
    const current = statuses.get(e.granuleKey);
    if (current === undefined) continue; // orphaned key — granule edited/removed
    if (e.outcome === "demonstrated") {
      statuses.set(e.granuleKey, "green");
    } else if (current === "gray") {
      statuses.set(e.granuleKey, "yellow");
    }
  }
  return statuses;
}

/**
 * Status for an arbitrary subset of evidence rows (e.g. just the
 * baseline-phase or just the exit-phase rows of one cell), so the
 * pre/post "Before → After" view can read a single granule's status at
 * each end of the unit. Same rule as deriveGranuleStatuses: green if any
 * demonstration, yellow if probed only, gray if untouched.
 */
export function statusFromEvidence(
  rows: { outcome: "demonstrated" | "probed" }[],
): GranuleStatus {
  let status: GranuleStatus = "gray";
  for (const r of rows) {
    if (r.outcome === "demonstrated") return "green";
    status = "yellow";
  }
  return status;
}

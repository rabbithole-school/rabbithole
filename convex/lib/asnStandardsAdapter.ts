/**
 * Shared ASN standards adapter types and pure transforms.
 *
 * Every standards source is normalized into this shape before the Convex import
 * writes rows. A source may be raw ASN/CSP JSON, a clean mirror of ASN data, or
 * a baked data module, but row identity remains ASN-style ids plus one document
 * id for the framework.
 */

export type AsnStandardEntry = {
  /** ASN standard id or a behavior-preserving synthetic id for framework folders. */
  id: string;
  notation?: string;
  description: string;
  gradeLevels: string[];
  isLeaf: boolean;
  parent?: string;
  label: string;
};

export type AsnStandardsDataset = {
  asnDocumentId: string;
  title: string;
  subject: string;
  jurisdiction: string;
  entries: AsnStandardEntry[];
};

// SirFizX v0.8 clean JSON mirrors ASN Common Core documents. Entries have mixed
// id schemes: folders usually have only a GUID `id`, while standards carry an
// ASN `S...` id under `ASN.id`; parent references may use either scheme.
export type SirFizXCleanEntry = {
  id: string;
  subject: string;
  statement: string;
  gradeLevels?: string[];
  gradelevels?: string[];
  code?: string | null;
  shortCode?: string;
  cls?: string;
  statementLabel?: string;
  asnParent?: string;
  ccsiParent?: string;
  ASN?: {
    id?: string | null;
    identifier?: string;
    parent?: string;
    leaf?: string;
    statementNotation?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function normalizeGrade(g: string): string {
  if (g === "KG" || g === "K") return "K";
  const num = parseInt(g, 10);
  if (!isNaN(num)) return String(num);
  return g;
}

function inferLabel(cls: string | undefined, depth: number): string {
  if (cls === "folder") {
    if (depth === 0) return "Domain";
    if (depth === 1) return "Cluster";
    return "Category";
  }
  return "Standard";
}

/**
 * Convert SirFizX's clean Common Core JSON into the canonical ASN adapter shape
 * without changing ids, notations, grades, leaf flags, or parent links.
 */
export function sirFizXCleanJsonToAsnEntries(
  rawData: SirFizXCleanEntry[],
): AsnStandardEntry[] {
  type Processed = {
    canonicalId: string;
    parentCanonicalId?: string;
    notation?: string;
    description: string;
    gradeLevels: string[];
    statementLabel: string;
    isLeaf: boolean;
    cls?: string;
  };

  const idAlias = new Map<string, string>();
  const processed: Processed[] = [];

  for (const entry of rawData) {
    const asnId = entry.ASN?.id;
    const guid = entry.id;
    const canonicalId = asnId || guid;

    idAlias.set(canonicalId, canonicalId);
    if (asnId && guid && asnId !== guid) {
      idAlias.set(guid, canonicalId);
    }

    const parentRef =
      entry.ASN?.parent || entry.asnParent || entry.ccsiParent || undefined;

    const gradeLevels = (entry.gradeLevels || entry.gradelevels || []).map(
      normalizeGrade,
    );
    const notation = entry.shortCode || entry.ASN?.statementNotation || undefined;

    processed.push({
      canonicalId,
      parentCanonicalId: parentRef,
      notation,
      description: entry.statement || "(no description)",
      gradeLevels,
      statementLabel: entry.statementLabel || "",
      isLeaf: entry.ASN?.leaf === "true",
      cls: entry.cls,
    });
  }

  const parentMap = new Map<string, string>();
  for (const p of processed) {
    if (p.parentCanonicalId) {
      const resolvedParent = idAlias.get(p.parentCanonicalId) || p.parentCanonicalId;
      parentMap.set(p.canonicalId, resolvedParent);
    }
  }

  function getDepth(id: string): number {
    let depth = 0;
    let current = id;
    const seen = new Set<string>();
    while (parentMap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentMap.get(current)!;
      depth++;
    }
    return depth;
  }

  return processed.map((p) => ({
    id: p.canonicalId,
    notation: p.notation,
    description: p.description,
    gradeLevels: p.gradeLevels,
    isLeaf: p.isLeaf,
    parent: p.parentCanonicalId
      ? idAlias.get(p.parentCanonicalId) || p.parentCanonicalId
      : undefined,
    label: p.statementLabel || inferLabel(p.cls, getDepth(p.canonicalId)),
  }));
}

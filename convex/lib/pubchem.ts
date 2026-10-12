import {
  MAX_MOLECULE_HEAVY_ATOMS,
  MoleculeParseError,
  moleculeFormula,
  parseMolfile,
  validateMolecule,
} from "../../lib/manipulative/molecule";
import type {
  MoleculeHighlight,
  MoleculeSpec,
} from "../../lib/manipulative/types";

const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound";
const DEFAULT_TIMEOUT_MS = 8_000;

export type HydratedMoleculeDraft = Omit<MoleculeSpec, "id"> & { id?: string };

export type PubChemResolution =
  | { ok: true; spec: HydratedMoleculeDraft; message: string }
  | { ok: false; reason: string };

class PubChemHttpError extends Error {
  constructor(
    readonly status: number,
    readonly stage: "cid" | "sdf" | "properties",
  ) {
    super(`PubChem ${stage} request returned HTTP ${status}`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validHighlight(value: unknown): value is MoleculeHighlight | undefined {
  if (value == null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const highlight = value as Record<string, unknown>;
  return (
    highlight.kind === "bridgingOxygen" ||
    (highlight.kind === "element" &&
      typeof highlight.el === "string" &&
      /^[A-Z][a-z]?$/.test(highlight.el))
  );
}

async function checkedText(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
  stage: "cid" | "sdf" | "properties",
): Promise<string> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new PubChemHttpError(response.status, stage);
  return await response.text();
}

function notFoundReason(query: string, numeric: boolean): string {
  return numeric
    ? `PubChem has no compound with CID ${query} — check the identifier.`
    : `PubChem has no compound named "${query}" — try the IUPAC or common name.`;
}

function readPropertyRecord(
  jsonText: string,
): { title: string; molecularFormula?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("PubChem returned invalid compound properties JSON");
  }
  const first = (
    parsed as {
      PropertyTable?: {
        Properties?: Array<{ Title?: unknown; MolecularFormula?: unknown }>;
      };
    }
  ).PropertyTable?.Properties?.[0];
  if (!first || !nonEmptyString(first.Title)) {
    throw new Error("PubChem returned no resolved compound title");
  }
  return {
    title: first.Title.trim(),
    ...(nonEmptyString(first.MolecularFormula)
      ? { molecularFormula: first.MolecularFormula.trim() }
      : {}),
  };
}

export function moleculeResolutionMessage(
  spec: Pick<MoleculeSpec, "query" | "resolvedName" | "cid" | "formula">,
): string {
  return `Resolved '${spec.query}' → ${spec.resolvedName} (CID ${spec.cid}, ${spec.formula}).`;
}

/**
 * Turns the tutor's query-only molecule request into the structure stored in
 * the artifact. This runs in the HTTP action runtime where `fetch` is available;
 * the artifact mutation remains deterministic and only validates/persists.
 */
export async function resolvePubChemMolecule(
  raw: unknown,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PubChemResolution> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "molecule spec must be an object" };
  }
  const draft = raw as Record<string, unknown>;
  if (draft.kind !== "molecule") {
    return { ok: false, reason: 'molecule spec.kind must be "molecule"' };
  }
  if (!nonEmptyString(draft.concept)) {
    return { ok: false, reason: "molecule.concept must be a non-empty string" };
  }
  if (!nonEmptyString(draft.prompt)) {
    return { ok: false, reason: "molecule.prompt must be a non-empty string" };
  }
  if (!nonEmptyString(draft.query)) {
    return {
      ok: false,
      reason: "molecule.query must be a compound name or PubChem CID",
    };
  }
  if (!validHighlight(draft.highlight)) {
    return {
      ok: false,
      reason:
        'molecule.highlight must be {"kind":"bridgingOxygen"} or {"kind":"element","el":"O"}',
    };
  }
  for (const forbidden of ["atoms", "bonds", "resolvedName", "cid", "formula"]) {
    if (draft[forbidden] != null) {
      return {
        ok: false,
        reason:
          `Do not author molecule.${forbidden}; provide only query and let the server resolve the real PubChem structure.`,
      };
    }
  }
  if (draft.goal != null || draft.answer != null) {
    return {
      ok: false,
      reason: "molecule is an exploration manipulative in v1 and does not accept goal or answer",
    };
  }
  const allowedFields = new Set([
    "kind",
    "id",
    "concept",
    "prompt",
    "query",
    "highlight",
  ]);
  const unknownField = Object.keys(draft).find((field) => !allowedFields.has(field));
  if (unknownField) {
    return {
      ok: false,
      reason:
        `molecule.${unknownField} is not authorable; provide only kind, concept, prompt, query, and optional highlight.`,
    };
  }

  const query = draft.query.trim();
  const numeric = /^\d+$/.test(query);
  if (numeric && (!Number.isSafeInteger(Number(query)) || Number(query) <= 0)) {
    return { ok: false, reason: `PubChem CID "${query}" must be a positive integer.` };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    let cid: number;
    if (numeric) {
      cid = Number(query);
    } else {
      const cidText = await checkedText(
        fetchImpl,
        `${PUBCHEM}/name/${encodeURIComponent(query)}/cids/TXT`,
        controller.signal,
        "cid",
      );
      const firstCid = cidText.trim().split(/\r?\n/)[0];
      if (!/^\d+$/.test(firstCid)) {
        return { ok: false, reason: notFoundReason(query, false) };
      }
      cid = Number(firstCid);
    }

    const [sdf, propertyText] = await Promise.all([
      checkedText(
        fetchImpl,
        `${PUBCHEM}/cid/${cid}/SDF?record_type=2d`,
        controller.signal,
        "sdf",
      ),
      checkedText(
        fetchImpl,
        `${PUBCHEM}/cid/${cid}/property/Title,MolecularFormula/JSON`,
        controller.signal,
        "properties",
      ),
    ]);

    const molecule = parseMolfile(sdf);
    const invalid = validateMolecule(molecule, {
      maxHeavyAtoms: MAX_MOLECULE_HEAVY_ATOMS,
    });
    if (invalid) {
      return {
        ok: false,
        reason: `PubChem returned a structure Rabbithole cannot render: ${invalid}. Try a smaller compound.`,
      };
    }
    const properties = readPropertyRecord(propertyText);
    const formula = moleculeFormula(molecule);
    if (!formula) {
      return {
        ok: false,
        reason: `PubChem returned no usable formula for "${query}". Try another name or CID.`,
      };
    }
    if (
      properties.molecularFormula &&
      properties.molecularFormula !== formula
    ) {
      return {
        ok: false,
        reason:
          `PubChem's formula ${properties.molecularFormula} does not match the ` +
          `structure-derived formula ${formula} for "${query}" — try another name or CID.`,
      };
    }

    const spec: HydratedMoleculeDraft = {
      kind: "molecule",
      ...(nonEmptyString(draft.id) ? { id: draft.id.trim() } : {}),
      concept: draft.concept.trim(),
      prompt: draft.prompt.trim(),
      query,
      resolvedName: properties.title,
      cid,
      formula,
      atoms: molecule.atoms,
      bonds: molecule.bonds,
      ...(draft.highlight ? { highlight: draft.highlight } : {}),
    };
    return { ok: true, spec, message: moleculeResolutionMessage(spec) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        reason: `PubChem took too long to resolve "${query}" — try again or use a CID.`,
      };
    }
    if (error instanceof PubChemHttpError) {
      if (error.status === 404) {
        return { ok: false, reason: notFoundReason(query, numeric) };
      }
      return {
        ok: false,
        reason: `PubChem could not resolve "${query}" right now (HTTP ${error.status}) — try again.`,
      };
    }
    if (error instanceof MoleculeParseError) {
      return {
        ok: false,
        reason: `PubChem returned an unusable 2D structure for "${query}": ${error.message}.`,
      };
    }
    return {
      ok: false,
      reason: `PubChem could not resolve "${query}": ${error instanceof Error ? error.message : String(error)}.`,
    };
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

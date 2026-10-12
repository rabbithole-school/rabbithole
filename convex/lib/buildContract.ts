// The vibecode MODEL CONTRACT (schema.ts activities.buildContract): one
// validator + one normalizer so every writer (web editor, aide tools, unit
// tools, duplicate/fork) enforces the same limits. The contract is not
// secret — it is a design-time steering note, read alongside the brief.
import { v } from "convex/values";

export const BUILD_CONTRACT_LIMITS = {
  minInvariants: 1,
  maxInvariants: 5,
  maxFreedoms: 8,
  maxChars: 240,
} as const;

export const buildContractValidator = v.object({
  invariants: v.array(v.string()),
  freedoms: v.array(v.string()),
  gate: v.optional(v.string()),
});

export type BuildContract = {
  invariants: string[];
  freedoms: string[];
  gate?: string;
};

function cleanList(items: readonly string[], label: string): string[] {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  for (const item of cleaned) {
    if (item.length > BUILD_CONTRACT_LIMITS.maxChars) {
      throw new Error(
        `Each model-contract ${label} entry must be ${BUILD_CONTRACT_LIMITS.maxChars} characters or fewer.`,
      );
    }
  }
  return cleaned;
}

export function normalizeBuildContract(raw: BuildContract): BuildContract {
  const invariants = cleanList(raw.invariants, "\"must be true\"");
  const freedoms = cleanList(raw.freedoms, "\"scholar owns\"");
  if (
    invariants.length < BUILD_CONTRACT_LIMITS.minInvariants ||
    invariants.length > BUILD_CONTRACT_LIMITS.maxInvariants
  ) {
    throw new Error(
      `A model contract needs ${BUILD_CONTRACT_LIMITS.minInvariants}–${BUILD_CONTRACT_LIMITS.maxInvariants} "must be true" invariants (got ${invariants.length}).`,
    );
  }
  if (freedoms.length > BUILD_CONTRACT_LIMITS.maxFreedoms) {
    throw new Error(
      `A model contract takes at most ${BUILD_CONTRACT_LIMITS.maxFreedoms} "scholar owns" freedoms (got ${freedoms.length}).`,
    );
  }
  const gate = raw.gate?.trim() || undefined;
  if (gate && gate.length > BUILD_CONTRACT_LIMITS.maxChars) {
    throw new Error(
      `The model contract's gate must be ${BUILD_CONTRACT_LIMITS.maxChars} characters or fewer.`,
    );
  }
  return { invariants, freedoms, ...(gate ? { gate } : {}) };
}

/** Coerce a model-authored tool argument (loose JSON) into the contract
 *  shape before `normalizeBuildContract` validates it. A bare string for a
 *  list becomes a one-item list; anything non-object is "not supplied". */
export function parseBuildContractArg(raw: unknown): BuildContract | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((x): x is string => typeof x === "string")
      : typeof value === "string"
        ? [value]
        : [];
  return {
    invariants: strings(r.invariants),
    freedoms: strings(r.freedoms),
    ...(typeof r.gate === "string" ? { gate: r.gate } : {}),
  };
}

export function assertContractKind(
  kind: string,
  fields: { buildContract?: unknown; allowSilence?: boolean },
): void {
  if (kind === "vibecode") return;
  if (fields.buildContract != null || fields.allowSilence === true) {
    throw new Error(
      "A model contract and allowSilence apply only to vibecode (build-an-app) activities.",
    );
  }
}

/**
 * The patch a writer applies for the two contract fields, given the kind the
 * row will have AFTER the write. `undefined` = not supplied (leave as is),
 * `null` = clear. Throws on a non-vibecode kind so a contract can never be
 * stranded on an activity the designer never runs. `allowSilence: false` is
 * stored as absent (false is the default).
 *
 * allowSilence only means something under a contract (stay_silent is offered
 * only with one), so it is stored only when the row will HAVE a contract
 * after the write: the supplied one, else `existingContract` (an update's
 * current row; omit on create). Clearing the contract clears it too.
 */
export function buildContractPatch(
  targetKind: string | undefined,
  fields: {
    buildContract?: BuildContract | null;
    allowSilence?: boolean | null;
  },
  existingContract?: BuildContract | null,
): { buildContract?: BuildContract | undefined; allowSilence?: true | undefined } {
  const patch: {
    buildContract?: BuildContract | undefined;
    allowSilence?: true | undefined;
  } = {};
  const settingContract =
    fields.buildContract !== undefined && fields.buildContract !== null;
  const settingSilence = fields.allowSilence === true;
  if (settingContract || settingSilence) {
    assertContractKind(targetKind ?? "", {
      buildContract: settingContract ? fields.buildContract : undefined,
      allowSilence: settingSilence,
    });
  }
  if (fields.buildContract !== undefined) {
    patch.buildContract = fields.buildContract
      ? normalizeBuildContract(fields.buildContract)
      : undefined;
  }
  const resultingContract =
    fields.buildContract !== undefined
      ? patch.buildContract
      : (existingContract ?? undefined);
  // Clearing the contract (null) clears a stored allowSilence with it.
  if (fields.allowSilence !== undefined || fields.buildContract === null) {
    patch.allowSilence =
      fields.allowSilence && resultingContract ? true : undefined;
  }
  return patch;
}

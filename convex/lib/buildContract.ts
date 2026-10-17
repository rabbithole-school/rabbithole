// The activity's MISSION, stored as `activities.buildContract` (schema.ts):
// one validator + one normalizer so every writer (web editor, aide tools, unit
// tools, duplicate/fork) enforces the same limits. It is not secret — it is a
// design-time steering note, read alongside the brief.
//
// Shape per activity (TRA-519 B1):
//   • App activity: the builder's MODEL CONTRACT — 1–5 "must be true"
//     invariants, 0–8 freedoms, optional gate; 0–5 invariants when it has a
//     gate (a mission of gate + freedoms, e.g. a Quest co-design app step).
//   • Any other online activity: gate + freedoms only. Its "must be true"
//     items belong in the deliverable's criteria, so invariants must be empty.
//   • Every other kind (offline, game, web, …): no mission — no tutor session
//     to steer.
import { v } from "convex/values";
import { isAppActivity } from "../../shared/appSurface";

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

export function normalizeBuildContract(
  raw: BuildContract,
  opts: { appActivity?: boolean } = { appActivity: true },
): BuildContract {
  const appActivity = opts.appActivity !== false;
  const invariants = cleanList(raw.invariants, "\"must be true\"");
  const freedoms = cleanList(raw.freedoms, "\"scholar owns\"");
  if (appActivity) {
    // An app mission with a gate may carry no invariants (a Quest co-design
    // app step: "what it does first" + what the scholar owns); without a gate
    // the invariants ARE the mission, so at least one is required.
    const minInvariants = raw.gate?.trim()
      ? 0
      : BUILD_CONTRACT_LIMITS.minInvariants;
    if (
      invariants.length < minInvariants ||
      invariants.length > BUILD_CONTRACT_LIMITS.maxInvariants
    ) {
      throw new Error(
        `A model contract needs ${minInvariants}–${BUILD_CONTRACT_LIMITS.maxInvariants} "must be true" invariants (got ${invariants.length}).`,
      );
    }
  } else if (invariants.length > 0) {
    throw new Error(
      "For a non-app activity, put 'must be true' items in the deliverable's criteria; a mission here is a gate plus freedoms.",
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

/** True when a normalized non-app mission carries nothing worth storing. */
function isEmptyMission(contract: BuildContract): boolean {
  return (
    contract.invariants.length === 0 &&
    contract.freedoms.length === 0 &&
    !contract.gate
  );
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

/** The activity shape a write leaves the row in: legacy { kind: "vibecode" }
 * or { kind: "online", appActivity: true } are both app activities. */
export type ContractTarget = { kind: string; appActivity?: boolean | null };

/** Whether the activity can carry a mission: any online activity (app
 * activities included). */
export function canCarryMission(target: ContractTarget | null | undefined): boolean {
  return isAppActivity(target) || target?.kind === "online";
}

export function assertContractKind(
  target: ContractTarget | null | undefined,
  fields: { buildContract?: unknown; allowSilence?: boolean },
): void {
  if (fields.allowSilence === true && !isAppActivity(target)) {
    throw new Error("allowSilence applies only to app (build-an-app) activities.");
  }
  if (fields.buildContract != null && !canCarryMission(target)) {
    throw new Error(
      "A mission (gate and freedoms) applies only to online activities, which have a tutor session to steer.",
    );
  }
}

/**
 * The patch a writer applies for the two contract fields, given the shape the
 * row will have AFTER the write. `undefined` = not supplied (leave as is),
 * `null` = clear. Throws on a kind with no tutor session so a mission can
 * never be stranded on an activity nobody steers by; a non-app mission with
 * invariants throws (they belong in the deliverable's criteria), and an empty
 * non-app mission is stored as absent. `allowSilence: false` is
 * stored as absent (false is the default).
 *
 * allowSilence only means something under a contract (stay_silent is offered
 * only with one), so it is stored only when the row will HAVE a contract
 * after the write: the supplied one, else `existingContract` (an update's
 * current row; omit on create). Clearing the contract clears it too.
 */
export function buildContractPatch(
  target: ContractTarget | null | undefined,
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
    assertContractKind(target, {
      buildContract: settingContract ? fields.buildContract : undefined,
      allowSilence: settingSilence,
    });
  }
  if (fields.buildContract !== undefined) {
    const normalized = fields.buildContract
      ? normalizeBuildContract(fields.buildContract, {
          appActivity: isAppActivity(target),
        })
      : undefined;
    patch.buildContract =
      normalized && !isEmptyMission(normalized) ? normalized : undefined;
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

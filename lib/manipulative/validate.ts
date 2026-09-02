/**
 * ManipulativeSpec validation — the governance gate for the `show_manipulative`
 * tool (and any future ad-hoc authoring path). Every spec entering the artifact
 * envelope passes through `validateManipulativeSpec` BEFORE storage.
 *
 * Philosophy (shared with lib/geomap/validate.ts): reject loudly with a
 * human-readable reason the tool surfaces to the model, which self-corrects —
 * never silently strip or coerce. Kind/domain policy (e.g. geoLocate belongs to
 * show_map) is deliberately NOT here: this validator stays domain-honest and
 * only answers "is this a renderable, and — if it claims a goal — gradable —
 * manipulative?" Policy lives in the mutation.
 */
import {
  ALL_MANIPULATIVE_KINDS,
  isCurrentManipulativeKind,
  type ManipulativeSpec,
} from "./types";
import {
  assertGradableManipulative,
  assertRenderableManipulative,
  isGradableManipulative,
} from "./authoring";

export type ManipulativeValidationResult =
  | { ok: true; spec: ManipulativeSpec }
  | { ok: false; reason: string };

const fail = (reason: string): ManipulativeValidationResult => ({
  ok: false,
  reason,
});

// ── Data-driven structural pre-check ─────────────────────────────────────────
// The cast `raw as ManipulativeSpec` below is a LIE the compiler can't catch: a
// type-wrong field the renderer later divides/indexes by (rekenrek total:"ten"
// → NaN beads, array rows:"3" → a 0-row grid) sails past `assertRenderable`
// because `isSolved` reads GOAL fields, not every structural field. So before we
// trust the shape we walk ONE table of each kind's required structural fields —
// the same fields the show_manipulative catalog names, sourced from the per-kind
// interfaces in types.ts — with a small checker per field. Reasons are
// model-teaching and always quote the observed value so the tutor self-corrects.
type FieldChecker = { label: string; ok: (v: unknown) => boolean };

const finiteNumber: FieldChecker = {
  label: "a finite number",
  ok: (v) => typeof v === "number" && Number.isFinite(v),
};
const int: FieldChecker = {
  label: "an integer",
  ok: (v) => typeof v === "number" && Number.isInteger(v),
};
const nonEmptyString: FieldChecker = {
  label: "a non-empty string",
  ok: (v) => typeof v === "string" && v.trim().length > 0,
};
const nonEmptyArray: FieldChecker = {
  label: "a non-empty array",
  ok: (v) => Array.isArray(v) && v.length > 0,
};
const object: FieldChecker = {
  label: "an object",
  ok: (v) => !!v && typeof v === "object" && !Array.isArray(v),
};
const enumOf = (...values: string[]): FieldChecker => ({
  label: `one of ${values.map((s) => `"${s}"`).join(", ")}`,
  ok: (v) => typeof v === "string" && values.includes(v),
});

// Required structural fields per kind. Optional fields (marked `?` in types.ts)
// are omitted — a missing one is a valid default, not a defect. `goal`/`answer`
// are handled by the gradability gate, not here.
const STRUCTURE: Record<string, Record<string, FieldChecker>> = {
  partition: { discs: nonEmptyArray, adjustable: nonEmptyArray },
  numberline: { min: finiteNumber, max: finiteNumber, tickStep: finiteNumber, start: finiteNumber },
  array: { rows: int, cols: int },
  balance: { left: finiteNumber, right: finiteNumber, adjustable: nonEmptyArray },
  areaPerimeter: { perimeter: finiteNumber, startWidth: finiteNumber },
  distribute: { width: finiteNumber, height: finiteNumber, startColumn: finiteNumber },
  rekenrek: { total: finiteNumber },
  distributor: { total: finiteNumber, groups: finiteNumber },
  riemann: { slope: finiteNumber, intercept: finiteNumber, tMax: finiteNumber, startBars: finiteNumber },
  functionMachine: { rule: object, examples: nonEmptyArray, queryInput: finiteNumber },
  placeValue: { mode: enumOf("buildNumber", "expandedForm", "placeShift"), places: nonEmptyArray },
  dice: { diceType: enumOf("d6", "d20", "coin") },
  protractor: { startDeg: finiteNumber },
  coordinatePlane: {
    xMin: finiteNumber,
    xMax: finiteNumber,
    yMin: finiteNumber,
    yMax: finiteNumber,
    gridStep: finiteNumber,
    draggable: nonEmptyArray,
  },
  geoLocate: { map: object },
  ruler: { unit: enumOf("cm", "in"), length: finiteNumber, startEnd: finiteNumber },
  clock: { startHour: finiteNumber, startMinute: finiteNumber },
  liquid: { unit: enumOf("cup", "L", "mL"), vessels: nonEmptyArray },
  money: { available: nonEmptyArray },
};

const observed = (v: unknown): string =>
  v === undefined ? "nothing" : JSON.stringify(v);

/**
 * Structural gate: reject a spec whose required fields are the wrong TYPE before
 * the unsafe cast. Returns a model-teaching reason (quoting the observed value)
 * or null when the shape is sound. Also enforces the base meta both frontends
 * display: `prompt` (the stem) and `concept` (REQUIRED in ManipulativeMeta).
 */
function structuralReason(kind: string, raw: Record<string, unknown>): string | null {
  for (const [field, checker] of [
    ["prompt", nonEmptyString] as const,
    ["concept", nonEmptyString] as const,
  ]) {
    if (!checker.ok(raw[field])) {
      return `${kind}.${field} must be ${checker.label}, got ${observed(raw[field])}`;
    }
  }
  const fields = STRUCTURE[kind];
  if (fields) {
    for (const [field, checker] of Object.entries(fields)) {
      if (!checker.ok(raw[field])) {
        return `${kind}.${field} must be ${checker.label}, got ${observed(raw[field])}`;
      }
    }
  }
  if (kind === "functionMachine") {
    const inconsistency = functionMachineInconsistency(raw);
    if (inconsistency) return inconsistency;
  }
  return null;
}

/**
 * functionMachine self-consistency: when the hidden rule is `{op:"affine",m,b}`
 * and worked `examples[]` are present, every example must satisfy
 * out = m·in + b — otherwise the scholar studies examples that contradict the
 * rule they're meant to infer. Reject naming the first inconsistent example.
 */
function functionMachineInconsistency(raw: Record<string, unknown>): string | null {
  const rule = raw.rule as { op?: unknown; m?: unknown; b?: unknown } | undefined;
  const examples = raw.examples;
  if (
    !rule ||
    rule.op !== "affine" ||
    typeof rule.m !== "number" ||
    !Number.isFinite(rule.m) ||
    typeof rule.b !== "number" ||
    !Number.isFinite(rule.b) ||
    !Array.isArray(examples)
  ) {
    return null;
  }
  const { m, b } = rule;
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i] as { in?: unknown; out?: unknown };
    if (typeof ex?.in !== "number" || typeof ex?.out !== "number") continue;
    const expected = m * ex.in + b;
    if (ex.out !== expected) {
      return `functionMachine.examples[${i}] is inconsistent with rule out=${m}*in+${b}: in=${ex.in} gives ${expected}, but out=${ex.out}`;
    }
  }
  return null;
}

export function validateManipulativeSpec(
  raw: unknown,
): ManipulativeValidationResult {
  if (!raw || typeof raw !== "object") return fail("spec must be an object");
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !kind.trim())
    return fail('spec.kind is required (a manipulative kind string)');
  if (!isCurrentManipulativeKind(kind)) {
    return fail(
      `unknown manipulative kind "${kind}" — use one of: ${ALL_MANIPULATIVE_KINDS.join(", ")}`,
    );
  }

  // Structural gate BEFORE the cast: a type-wrong required field (total:"ten")
  // would otherwise ride the cast into a renderer that crashes or silently
  // produces NaN, because assertRenderableManipulative only exercises the goal.
  const structural = structuralReason(kind, raw as Record<string, unknown>);
  if (structural) return fail(structural);

  const spec = raw as ManipulativeSpec;

  // Renderability first: a well-shaped goal can still sit on a spec whose
  // structural fields would crash the scholar's screen on mount (see
  // assertRenderableManipulative). This also enforces the non-empty prompt.
  try {
    assertRenderableManipulative(spec);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // A present-but-unusable goal (or typed answer) means the self-check could
  // never pass — reject it so the model fixes the goal rather than shipping a
  // challenge that is silently unwinnable. Goal-less specs are valid free
  // exploration (see isChallenge in types.ts), so they skip this gate.
  const meta = spec as { goal?: unknown; answer?: unknown };
  if (meta.goal != null || meta.answer != null) {
    if (!isGradableManipulative(spec)) {
      try {
        assertGradableManipulative(spec);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { ok: true, spec };
}

/**
 * The stored envelope for a `type: "manipulative"` artifact — structured JSON
 * in `content`, mirroring StoredMapArtifact. `v` is the contract version; `spec`
 * is the validated ManipulativeSpec. Unlike "map" there is no second namespace
 * for scholar edits — a manipulative is poked in place, not co-authored.
 */
export interface StoredManipulativeArtifact {
  v: 1;
  spec: ManipulativeSpec;
}

/**
 * Tolerant parse of a stored manipulative artifact's `content`, or null if
 * unusable — the renderers' single reader, mirroring parseStoredMapArtifact.
 * Total: malformed / wrong-version / kind-less JSON is null, never a throw.
 */
export function parseStoredManipulativeArtifact(
  content: string,
): StoredManipulativeArtifact | null {
  try {
    const parsed = JSON.parse(content) as StoredManipulativeArtifact;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      !parsed.spec ||
      typeof parsed.spec !== "object" ||
      typeof (parsed.spec as { kind?: unknown }).kind !== "string"
    ) {
      return null;
    }
    // A stored spec outlives the union: a retired kind (dotBlaster, factorGame)
    // leaves rows no current renderer/`isSolved` branch handles, so a row whose
    // `kind` the binary can no longer render must parse to null — never a blank,
    // unsolvable frame (see isCurrentManipulativeKind in types.ts).
    if (!isCurrentManipulativeKind((parsed.spec as { kind: string }).kind)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

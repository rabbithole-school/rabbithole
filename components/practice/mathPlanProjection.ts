/**
 * Math plan → matrix projection. The ONE place that turns a scholar's authored
 * Math plan (`convex/mathPlans.ts` → `forScholars`) into the two marks a matrix
 * cell can carry, plus the words those marks are stated in.
 *
 * There are exactly two authored controls, so there are exactly two marks:
 *
 *  • Practice scope → the out-of-scope SLASH. One policy decision projected
 *    down: a whole domain out of scope slashes its domain-altitude cell; a
 *    strand out of scope slashes every skill cell in that strand. It is never a
 *    per-cell control and never means mastery, mapping, or "not yet reached".
 *  • Checkpoint → the corner FLAG, in the checkpoint's derived mode (working
 *    toward / going deeper). It corners its domain cell at all-domain altitude,
 *    and every target-grade skill cell in its band inside a domain.
 *
 * When the two contradict (a checkpoint outside scope) BOTH marks stay visible
 * and the flag switches to the suspended/error reading — scope is the runtime
 * safety boundary, so the checkpoint is suspended, not overruled by precedence.
 *
 * Pure so it can be unit-tested; the React marks live in `MathPlanMarks.tsx`.
 */

export type PracticeScope =
  | { kind: "open" }
  | { kind: "limited"; domains: { domain: string; strands?: string[] }[] };

export type CheckpointMode = "toward" | "deeper";

export type MathPlanCheckpoint = {
  domain: string;
  strand?: string;
  grade: string;
};

type EffectiveMathPlanCheckpoint = MathPlanCheckpoint & {
  source: "teacher" | "group";
  groupId?: string;
  groupName?: string;
  conflictGroupIds?: string[];
};

/** One row of `api.mathPlans.forScholars`, narrowed to what the UI reads. */
export type MathPlanRow = {
  scholarId: string;
  practiceScope: PracticeScope;
  scopeSource: "math_plan" | "legacy_standing" | "open_default";
  migrationIssue?: {
    reason:
      | "complex_strand_config"
      | "overlapping_standing_assignments"
      | "unknown_domain";
  } | null;
  checkpoint: EffectiveMathPlanCheckpoint | null;
  conflict: boolean;
  mode: CheckpointMode;
  bandSolid: number;
  bandTotal: number;
};

/** The flag a cell carries: its derived mode, or the suspended reading. */
export type CheckpointCornerState = CheckpointMode | "conflict";

export type MathPlanCellMarks = {
  /** Practice scope excludes this cell's work — draw the slash. */
  outOfScope: boolean;
  /** This cell sits in the checkpoint band — draw the corner flag. */
  checkpoint: CheckpointCornerState | null;
};

const NO_MARKS: MathPlanCellMarks = { outOfScope: false, checkpoint: null };

export type CheckpointBandNode = {
  strand: string | null;
  grade: string | null;
};

/**
 * The checkpoint band a curriculum node represents. Ungraded nodes cannot be
 * checkpoints; an unstranded node is a whole-domain checkpoint.
 */
export function bandForNode(
  domain: string,
  node: CheckpointBandNode,
): MathPlanCheckpoint | null {
  if (node.grade === null) return null;
  return {
    domain,
    grade: node.grade,
    ...(node.strand === null ? {} : { strand: node.strand }),
  };
}

/** The pure scope classification behind the out-of-scope readings: which axis a
 *  limited scope excludes this node on, if any. */
function scopeExclusion(
  scope: PracticeScope,
  domain: string,
  strand?: string | null,
): "domain" | "strand" | null {
  if (!scopeAllowsDomain(scope, domain)) return "domain";
  if (strand != null && !scopeAllowsStrand(scope, domain, strand)) {
    return "strand";
  }
  return null;
}

/** Everything a caller needs to state an out-of-scope refusal honestly. */
export type CheckpointScopeGap = {
  /**
   * The axis the WIDENING adds — always the band's own axis, because that is
   * what `widenScopeToAdmit` writes: a strand band admits that one strand (even
   * when its whole domain is currently unserved), and only a whole-domain band
   * admits the whole domain. Naming the domain for a strand band would promise
   * more than the save performs.
   */
  widen: "domain" | "strand";
  /** Which axis the CURRENT scope excludes it on — the domain, or just the strand. */
  excluded: "domain" | "strand";
};

function isEmptyLimitedScope(scope: PracticeScope) {
  return (
    scope.kind === "limited" &&
    (scope.domains.length === 0 ||
      scope.domains.some((entry) => entry.strands?.length === 0))
  );
}

/** The pure "is this band already the checkpoint" test — EXACT band identity,
 *  unlike the membership test the cell marks run (a whole-domain checkpoint is
 *  not the same authored band as one of its strands at the same grade). Both
 *  sides are nullable so callers holding a "maybe there is no checkpoint" value
 *  can ask directly; two absent bands are the same absence. */
export function sameCheckpointBand(
  left: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade"> | null | undefined,
  right: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade"> | null | undefined,
) {
  if (!left || !right) return !left && !right;
  return (
    left.domain === right.domain &&
    left.grade === right.grade &&
    left.strand === right.strand
  );
}

export type CheckpointBandReading =
  | { kind: "no-grade" }
  | { kind: "blocked"; reason: "conflict" | "empty-limited-scope" }
  | ({ kind: "out-of-scope"; checkpoint: MathPlanCheckpoint } & CheckpointScopeGap)
  | { kind: "current"; checkpoint: MathPlanCheckpoint; mode: CheckpointMode }
  | {
      kind: "inherited-current";
      checkpoint: MathPlanCheckpoint;
      mode: CheckpointMode;
    }
  | {
      kind: "elsewhere";
      checkpoint: MathPlanCheckpoint;
      inherited: boolean;
    }
  | { kind: "settable"; checkpoint: MathPlanCheckpoint };

/**
 * The checkpoint action/readout for ONE curriculum node — the inverse of the
 * cell marks: `skillCellMarks` answers "is this cell inside the checkpoint's
 * band", this answers "is the band this cell NAMES the authored checkpoint, and
 * if not, what would setting it here take". It projects stored state only: the
 * mode is always passed through from the plan, never predicted.
 */
export function checkpointBandState(
  plan: MathPlanRow | undefined,
  domain: string,
  node: CheckpointBandNode,
): CheckpointBandReading | null {
  if (!plan) return null;
  const band = bandForNode(domain, node);
  if (!band) return { kind: "no-grade" };
  if (plan.conflict) return { kind: "blocked", reason: "conflict" };
  if (isEmptyLimitedScope(plan.practiceScope)) {
    return { kind: "blocked", reason: "empty-limited-scope" };
  }
  if (!scopeAllowsCheckpoint(plan.practiceScope, band)) {
    return {
      kind: "out-of-scope",
      checkpoint: band,
      widen: band.strand === undefined ? "domain" : "strand",
      excluded:
        scopeExclusion(plan.practiceScope, domain, node.strand) ?? "domain",
    };
  }
  if (plan.checkpoint && sameCheckpointBand(plan.checkpoint, band)) {
    return plan.checkpoint.source === "group"
      ? { kind: "inherited-current", checkpoint: band, mode: plan.mode }
      : { kind: "current", checkpoint: band, mode: plan.mode };
  }
  if (plan.checkpoint) {
    return {
      kind: "elsewhere",
      inherited: plan.checkpoint.source === "group",
      checkpoint: {
        domain: plan.checkpoint.domain,
        grade: plan.checkpoint.grade,
        ...(plan.checkpoint.strand === undefined
          ? {}
          : { strand: plan.checkpoint.strand }),
      },
    };
  }
  return { kind: "settable", checkpoint: band };
}

export function scopeAllowsDomain(scope: PracticeScope, domain: string) {
  return (
    scope.kind === "open" ||
    scope.domains.some((entry) => entry.domain === domain)
  );
}

/** A skill's strand is in scope when its domain is checked whole, or when its
 *  own strand is one of the checked ones. An unstranded node rides its domain. */
export function scopeAllowsStrand(
  scope: PracticeScope,
  domain: string,
  strand: string | null | undefined,
) {
  if (scope.kind === "open") return true;
  const entry = scope.domains.find((item) => item.domain === domain);
  if (!entry) return false;
  if (entry.strands === undefined) return true;
  return strand != null && entry.strands.includes(strand);
}

function cornerState(
  plan: MathPlanRow,
  inBand: boolean,
): CheckpointCornerState | null {
  if (!inBand) return null;
  return plan.conflict ? "conflict" : plan.mode;
}

/**
 * The COLUMN's checkpoint state: the mode a scholar's own checkpoint reads at,
 * independent of any one cell's band membership. A matrix column HEADING wears
 * this as the same top-left corner its marked cells carry, so the heading and
 * the column below it read as one mark in one hue rather than two vocabularies.
 * Null when the scholar has no checkpoint at all — a heading with no checkpoint
 * state gets no mark.
 */
export function scholarCheckpointState(
  plan: MathPlanRow | undefined,
): CheckpointCornerState | null {
  if (!plan) return null;
  return cornerState(plan, plan.checkpoint !== null);
}

/** All-domain altitude: one cell per (scholar × domain). */
export function domainCellMarks(
  plan: MathPlanRow | undefined,
  domain: string,
): MathPlanCellMarks {
  if (!plan) return NO_MARKS;
  return {
    outOfScope: !scopeAllowsDomain(plan.practiceScope, domain),
    checkpoint: cornerState(plan, plan.checkpoint?.domain === domain),
  };
}

/** Skill altitude, inside one domain: one cell per (scholar × skill). */
export function skillCellMarks(
  plan: MathPlanRow | undefined,
  domain: string,
  node: CheckpointBandNode,
): MathPlanCellMarks {
  if (!plan) return NO_MARKS;
  const checkpoint = plan.checkpoint;
  // BAND MEMBERSHIP, not band identity: a whole-domain checkpoint covers every
  // strand at its grade, so every one of those cells wears the flag. (The
  // authoring control asks the narrower question — see `checkpointBandState`.)
  const inBand =
    !!checkpoint &&
    checkpoint.domain === domain &&
    checkpoint.grade === node.grade &&
    (checkpoint.strand === undefined || checkpoint.strand === node.strand);
  return {
    outOfScope: !scopeAllowsStrand(plan.practiceScope, domain, node.strand),
    checkpoint: cornerState(plan, inBand),
  };
}

export const CHECKPOINT_MODE_LABEL: Record<CheckpointMode, string> = {
  toward: "Working toward",
  deeper: "Going deeper",
};

/** The mark suffixes a cell announces after its mastery reading — never colour
 *  alone, and never a hover-only tooltip (§ accessibility). */
export function markPhrases(marks: MathPlanCellMarks): string[] {
  const phrases: string[] = [];
  if (marks.outOfScope) phrases.push("out of practice scope");
  if (marks.checkpoint === "conflict") {
    phrases.push("checkpoint suspended, needs attention");
  } else if (marks.checkpoint) {
    phrases.push(
      `checkpoint, ${CHECKPOINT_MODE_LABEL[marks.checkpoint].toLowerCase()}`,
    );
  }
  return phrases;
}

/**
 * Join already-punctuated fragments into one sentence-cased readout without
 * doubling terminators — the old cell labels concatenated `"…reading." + " …."`
 * and announced "reading.. checkpoint..".
 */
export function joinReadout(...parts: (string | null | undefined)[]): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/[.\s]+$/, ""))
    .join(". ");
}

/** The cell's full accessible name: its mastery reading, then its policy, then
 *  whatever the control itself does. */
export function cellReadoutWithMarks(
  base: string,
  marks: MathPlanCellMarks,
  suffix?: string,
) {
  return joinReadout(base, ...markPhrases(marks), suffix);
}

export type ScopeSummary =
  | { kind: "open" }
  | {
      kind: "limited";
      entries: { domain: string; label: string; strandLabels: string[] | null }[];
    };

/** The rail's exact "what is served" sentence — never a count that hides the
 *  names, because the boundary is the thing the teacher is inspecting. */
export function practiceScopeSummary(
  scope: PracticeScope,
  labels: {
    domainLabel: (domain: string) => string;
    strandLabel: (strand: string) => string;
  },
): ScopeSummary {
  if (scope.kind === "open") return { kind: "open" };
  return {
    kind: "limited",
    entries: scope.domains.map((entry) => ({
      domain: entry.domain,
      label: labels.domainLabel(entry.domain),
      strandLabels: entry.strands
        ? entry.strands.map((strand) => labels.strandLabel(strand))
        : null,
    })),
  };
}

/** "Fractions · comparing fractions · grade 5" — the checkpoint, in words. */
export function checkpointLabel(
  checkpoint: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade">,
  labels: {
    domainLabel: (domain: string) => string;
    strandLabel: (strand: string) => string;
  },
) {
  return [
    labels.domainLabel(checkpoint.domain),
    checkpoint.strand ? labels.strandLabel(checkpoint.strand) : null,
    `grade ${checkpoint.grade}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "Math group Rockets" vs "Scholar override" — one effective value, one source. */
export function checkpointSourceLabel(checkpoint: EffectiveMathPlanCheckpoint) {
  return checkpoint.source === "group"
    ? `Math group ${checkpoint.groupName ?? "—"}`
    : "Scholar override";
}

/** "3 of 9 skills in the band are fluent" (or the honest empty-band reading). */
export function bandProgressLabel(plan: MathPlanRow) {
  if (plan.bandTotal === 0) return "No skills in this band yet";
  return `${plan.bandSolid} of ${plan.bandTotal} ${
    plan.bandTotal === 1 ? "skill" : "skills"
  } in the band ${plan.bandSolid === 1 ? "is" : "are"} fluent`;
}

/**
 * The draft the editor holds. A draft is INVALID (not merely unsaved) while its
 * checkpoint sits outside its scope — the editor blocks the save rather than
 * silently clearing one control to satisfy the other.
 */
export type MathPlanDraft = {
  scope: PracticeScope;
  checkpoint: { domain: string; strand?: string; grade: string } | null;
};

export type DraftProblem =
  | { kind: "emptyScope" }
  | { kind: "checkpointOutOfScope"; domain: string; strand?: string };

export function draftProblem(draft: MathPlanDraft): DraftProblem | null {
  if (draft.scope.kind === "limited") {
    if (draft.scope.domains.length === 0) return { kind: "emptyScope" };
    if (draft.scope.domains.some((entry) => entry.strands?.length === 0)) {
      return { kind: "emptyScope" };
    }
  }
  const checkpoint = draft.checkpoint;
  if (
    checkpoint &&
    !scopeAllowsCheckpoint(draft.scope, checkpoint)
  ) {
    return {
      kind: "checkpointOutOfScope",
      domain: checkpoint.domain,
      ...(checkpoint.strand === undefined ? {} : { strand: checkpoint.strand }),
    };
  }
  return null;
}

/** Mirrors `convex/lib/practice/mathPlan.ts` — a whole-domain checkpoint needs
 *  the whole domain in scope; a strand checkpoint needs that strand. */
export function scopeAllowsCheckpoint(
  scope: PracticeScope,
  target: { domain: string; strand?: string },
) {
  if (scope.kind === "open") return true;
  const entry = scope.domains.find((item) => item.domain === target.domain);
  if (!entry) return false;
  return target.strand === undefined
    ? entry.strands === undefined
    : entry.strands === undefined || entry.strands.includes(target.strand);
}

/**
 * The catalogue the editor's checkpoint picker is built from — one entry per
 * domain, with its strands and the grades each carries. The band grid's rows
 * are `strands` (plus "Any strand"), its columns are `grades`, and a strand ×
 * grade intersection exists only where that strand lists that grade.
 */
export type CheckpointCatalogDomain = {
  domain: string;
  label: string;
  grades: string[];
  strands: { strand: string; label: string; grades: string[] }[];
};

export type CheckpointOption = {
  value: string;
  label: string;
  /**
   * Outside the DRAFT scope. Such an option is still rendered — otherwise a
   * conflicted plan's own checkpoint domain has no matching `<option>` and a
   * native `<select>` silently shows its first one instead ("No checkpoint"),
   * hiding the very target the teacher opened the editor to repair. It is never
   * selectable, so the editor still cannot author a NEW conflict.
   *
   * Only the DOMAIN axis is still a select: strand and grade are chosen
   * together in `CheckpointBandGrid`, which draws an out-of-scope band in
   * place, slashed, and so never needed this workaround.
   */
  outOfScope: boolean;
};

function option(
  value: string,
  label: string,
  outOfScope: boolean,
): CheckpointOption {
  return {
    value,
    label: outOfScope ? `${label} — out of scope` : label,
    outOfScope,
  };
}

/** Domains a checkpoint may live in under the draft scope, plus the current
 *  target's own domain when the draft excludes it. */
export function checkpointDomainChoices(
  draft: MathPlanDraft,
  catalog: CheckpointCatalogDomain[],
): CheckpointOption[] {
  const held = draft.checkpoint?.domain;
  const known = catalog
    .filter(
      (entry) =>
        scopeAllowsDomain(draft.scope, entry.domain) || entry.domain === held,
    )
    .map((entry) =>
      option(
        entry.domain,
        entry.label,
        !scopeAllowsDomain(draft.scope, entry.domain),
      ),
    );
  // A stored checkpoint can name a domain the catalogue no longer lists.
  const unknown =
    held && !catalog.some((entry) => entry.domain === held)
      ? [option(held, held, !scopeAllowsDomain(draft.scope, held))]
      : [];
  return [
    { value: "", label: "No checkpoint", outOfScope: false },
    ...unknown,
    ...known,
  ];
}

/**
 * The smallest widening of `scope` that admits `target` — the repair for a plan
 * that ARRIVED with its checkpoint out of scope (a legacy migration, an import,
 * two teachers saving at once), where there is no edit to undo.
 */
export function widenScopeToAdmit(
  scope: PracticeScope,
  target: { domain: string; strand?: string },
  allStrands?: string[],
): PracticeScope {
  if (scope.kind === "open") return scope;
  if (scopeAllowsCheckpoint(scope, target)) return scope;
  const without = scope.domains.filter((entry) => entry.domain !== target.domain);
  const entry = scope.domains.find((item) => item.domain === target.domain);
  // A whole-domain checkpoint needs the whole domain, not one strand of it.
  if (target.strand === undefined) {
    return { kind: "limited", domains: [...without, { domain: target.domain }] };
  }
  const current = entry?.strands ?? [];
  const updated = [...new Set([...current, target.strand])];
  const ordered = allStrands
    ? allStrands.filter((item) => updated.includes(item))
    : updated;
  return {
    kind: "limited",
    domains: [
      ...without,
      allStrands && ordered.length === allStrands.length
        ? { domain: target.domain }
        : { domain: target.domain, strands: ordered },
    ],
  };
}

/**
 * What "keep it in scope" restores: the pre-edit scope when that still admits
 * the checkpoint (undo exactly the step just taken), otherwise the current
 * scope widened to admit it. So the exit is offered — and works — on the repair
 * path too, where nothing has been edited yet.
 */
export function keepCheckpointInScope(
  scope: PracticeScope,
  target: { domain: string; strand?: string },
  undo: PracticeScope | null,
  allStrands?: string[],
): PracticeScope {
  if (undo && scopeAllowsCheckpoint(undo, target)) return undo;
  return widenScopeToAdmit(scope, target, allStrands);
}

/**
 * The undo point to remember after a scope edit. Captured ONLY on the
 * valid → invalid transition: a second breaking edit must not overwrite it with
 * an already-broken scope (restoring that would leave the banner up and make
 * the exit look broken), and a draft that arrived broken has nothing to undo.
 */
export function nextScopeUndo(
  draft: MathPlanDraft,
  next: PracticeScope,
  current: PracticeScope | null,
): PracticeScope | null {
  const checkpoint = draft.checkpoint;
  if (!checkpoint || scopeAllowsCheckpoint(next, checkpoint)) return null;
  if (!scopeAllowsCheckpoint(draft.scope, checkpoint)) return current;
  return draft.scope;
}

/** Three-state domain checkbox: every file picker's convention, no new words. */
export type DomainCheckState = "checked" | "indeterminate" | "unchecked";

export function domainCheckState(
  scope: PracticeScope,
  domain: string,
): DomainCheckState {
  if (scope.kind === "open") return "checked";
  const entry = scope.domains.find((item) => item.domain === domain);
  if (!entry) return "unchecked";
  return entry.strands === undefined ? "checked" : "indeterminate";
}

export function draftStrandChecked(
  scope: PracticeScope,
  domain: string,
  strand: string,
) {
  return scopeAllowsStrand(scope, domain, strand);
}

/** Check/uncheck a whole domain. Checking clears any strand restriction (the
 *  whole domain IS "no strand restriction"); unchecking removes the domain.
 *  Callers pass a LIMITED draft — the editor seeds one when the teacher
 *  switches away from Open, so a toggle never has to invent the complement. */
export function toggleDraftDomain(
  scope: PracticeScope,
  domain: string,
  next: boolean,
): PracticeScope {
  const domains = scope.kind === "limited" ? scope.domains : [];
  const without = domains.filter((entry) => entry.domain !== domain);
  return {
    kind: "limited",
    domains: next ? [...without, { domain }] : without,
  };
}

/**
 * Check/uncheck one strand. Unchecking a strand of a whole-checked domain
 * demotes that domain to the indeterminate state carrying its remaining
 * strands; unchecking the last one drops the domain entirely (an empty domain
 * entry is not a representable scope).
 */
export function toggleDraftStrand(
  scope: PracticeScope,
  domain: string,
  strand: string,
  next: boolean,
  allStrands: string[],
): PracticeScope {
  const domains = scope.kind === "limited" ? scope.domains : [];
  const entry = domains.find((item) => item.domain === domain);
  const current = entry ? (entry.strands ?? allStrands) : [];
  const updated = next
    ? [...new Set([...current, strand])]
    : current.filter((item) => item !== strand);
  const without = domains.filter((item) => item.domain !== domain);
  const ordered = allStrands.filter((item) => updated.includes(item));
  if (ordered.length === 0) return { kind: "limited", domains: without };
  return {
    kind: "limited",
    domains: [
      ...without,
      ordered.length === allStrands.length
        ? { domain }
        : { domain, strands: ordered },
    ],
  };
}

// ── Group-altitude checkpoint words ────────────────────────────────────────
// The math GROUP's checkpoint is one stored policy row, so the surfaces that
// author it (the domain/strand grade pill and the panel band control) share one
// set of words here rather than each spelling out its own.

export type GroupCheckpointIntent = "set" | "move" | "clear";

/**
 * Setting vs moving, from the group's STORED checkpoint. A group holds exactly
 * one, so writing a different band moves it off the one it holds — and the
 * teacher is told which, before the write.
 */
export function groupCheckpointIntent(
  current: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade"> | null | undefined,
  target: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade">,
): Extract<GroupCheckpointIntent, "set" | "move"> {
  return current && !sameCheckpointBand(current, target) ? "move" : "set";
}

/** "4 scholars" / "1 scholar" — always the group's SERVER-side member total,
 *  never the filtered column count the matrix happens to be showing. */
export function scholarCountLabel(total: number) {
  return `${total} ${total === 1 ? "scholar" : "scholars"}`;
}

/** "Set checkpoint for 4 scholars" — the one action label, shared by the panel
 *  button and the confirmation it opens so the two can never disagree. */
export function groupCheckpointActionLabel(
  intent: GroupCheckpointIntent,
  total: number,
) {
  const verb =
    intent === "clear" ? "Clear" : intent === "move" ? "Move" : "Set";
  return `${verb} checkpoint for ${scholarCountLabel(total)}`;
}

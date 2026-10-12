/**
 * The per-cell checkpoint control, held to the invariants that justified it:
 * one primitive (no new glyph), one mutation, no authored mode, no optimistic
 * paint, and exactly one mount — the list view's scholar × skill panel.
 *
 * Source assertions rather than a render: every claim here is about what the
 * component may NOT contain (a second mutation, a mode picker, a predicted
 * hue), which is the shape a rendered test cannot prove absent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

const control = read("CheckpointBandControl.tsx");

describe("CheckpointBandControl", () => {
  it("writes through exactly one mutation, and it is the atomic plan save", () => {
    expect((control.match(/useMutation\(/g) ?? []).length).toBe(1);
    expect(control).toContain("useMutation(api.mathPlans.saveForScholar)");
    expect((control.match(/await save\(/g) ?? []).length).toBe(1);
    // Both authored controls travel together, always.
    expect(control).toMatch(/practiceScope: payload\.practiceScope/);
    expect(control).toMatch(/checkpoint: payload\.checkpoint/);
    // No group-altitude write, and no bespoke per-scholar checkpoint endpoint.
    expect(control).not.toContain("setGroupCheckpoint");
    expect(control).not.toContain("setScholarCheckpointOverride");
  });

  it("reads the band and its state from the shared projection", () => {
    expect(control).toContain("checkpointBandState(");
    expect(control).toContain("widenScopeToAdmit(");
    expect(control).toContain("checkpointLabel(");
    expect(control).toContain("checkpointSourceLabel(");
    expect(control).toContain("CHECKPOINT_MODE_LABEL[");
    // Mode words are never retyped, so the two surfaces cannot drift.
    expect(control).not.toMatch(/"Going deeper"|"Working toward"/);
  });

  it("never authors or predicts the mode", () => {
    expect(control).not.toMatch(/setMode|RadioGroup|<select/);
    expect(control).toContain("<CheckpointModePill");
    // The pill and the corner both read the plan row's derived mode.
    expect(control).toMatch(/mode=\{reading\.mode\}/);
    expect(control).toMatch(/chipCorner = plan\.conflict \? "conflict" : reading\.mode/);
  });

  it("is not optimistic: the button disables until the server answers", () => {
    expect(control).toContain("loading={saving}");
    expect(control).toContain("disabled={disabled || saving}");
    // The announcement waits for the reactive row to carry the write.
    expect(control).toContain('aria-live="polite"');
    expect(control).toMatch(/const settled = result\?\.settled \? result : null;/);
  });

  it("offers undo only where the button is not already the inverse", () => {
    // A move and a widen change something the main button cannot put back; a
    // set or a clear IS its own inverse.
    expect(control).toMatch(/kind: "move",[\s\S]*?reading\.inherited[\s\S]*?undo: \{/);
    expect(control).toMatch(/kind: "widen",\s*\n\s*undo: \{/);
    expect(control).toMatch(/\{ kind: "set" \}/);
    expect(control).toMatch(/\{ kind: "clear" \}/);
    // Undo re-saves the exact captured pair through the same atomic call.
    expect(control).toContain("commit(undoPayload!, { kind: \"undo\" })");
    // …and it is forgotten when the selection or the plan moves elsewhere.
    expect(control).toMatch(/if \(result\.key !== identity\) setResult\(null\)/);
  });

  it("refuses rather than repairs: a conflicted or empty plan routes to the modal", () => {
    expect(control).toMatch(/reading\.kind === "blocked"/);
    expect(control).toContain("Open math plan");
    expect(control).toContain("onClick = onOpenPlan");
    // The modal owns the three named exits; the row does not fork them.
    expect(control).not.toContain("Keep it in scope");
    expect(control).not.toContain("Move checkpoint into scope");
  });

  it("names the exact widening in the exit's own label", () => {
    expect(control).toMatch(/`Add \$\{subject\} to scope, then set checkpoint`/);
    expect(control).toMatch(/Adds one \$\{reading\.widen\} to practice scope/);
    // The subject is the BAND's axis, which is what `widenScopeToAdmit` adds —
    // naming the domain for a strand band would promise more than the save does.
    expect(control).toMatch(
      /reading\.widen === "domain" \? domainLabel : \(strandLabel \?\? domainLabel\)/,
    );
  });

  it("states the band's sibling count before it writes", () => {
    expect(control).toMatch(/bandSkillCount === 1 \? "skill" : "skills"/);
    expect(control).toMatch(/`all \$\{bandSkillCount\}`/);
  });

  it("carries a full-sentence accessible name on a 44px target", () => {
    expect(control).toContain("aria-label={ariaLabel}");
    expect(control).toContain('minH="44px"');
    expect(control).toContain("_focusVisible");
    expect(control).toMatch(/cursor=\{disabled \? "not-allowed" : "pointer"\}/);
  });

  it("renders nothing without a loaded plan or an author route", () => {
    expect(control).toMatch(
      /if \(!plan \|\| !reading \|\| !onOpenPlan\) return null;/,
    );
  });
});

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
const marks = read("MathPlanMarks.tsx");
const view = read("MathSkillsMasteryView.tsx");

describe("CheckpointBandChip", () => {
  it("composes the two canonical marks instead of drawing a third", () => {
    expect(marks).toMatch(/export function CheckpointBandChip\(/);
    const chip = marks.slice(marks.indexOf("export function CheckpointBandChip("));
    expect(chip).toContain("<OutOfScopeSlash />");
    expect(chip).toContain("<CheckpointCorner");
    // No new glyph, no new palette: the chip is the cell, in white.
    expect(chip).not.toContain("<svg");
    expect(chip).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it("ships exactly the two densities the two consumers need", () => {
    expect(marks).toMatch(/cell: \{ w: 44, h: 34/);
    expect(marks).toMatch(/grid: \{ w: 52, h: 30/);
  });

  it("is decorative — the consumer always supplies the words", () => {
    const chip = marks.slice(marks.indexOf("export function CheckpointBandChip("));
    expect(chip).toContain("aria-hidden");
  });
});

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

describe("where the control is mounted", () => {
  it("mounts once, in the scholar × skill branch, between the rail and the scope strip", () => {
    expect((view.match(/<CheckpointBandControl/g) ?? []).length).toBe(1);
    const mount = view.indexOf("<CheckpointBandControl");
    const rail = view.indexOf("{mathPlanFor?.(focusedScholar.id)}");
    const strip = view.indexOf("<MathPlanScopeStrip", mount);
    expect(rail).toBeGreaterThan(-1);
    expect(rail).toBeLessThan(mount);
    expect(mount).toBeLessThan(strip);
  });

  it("leaves the view itself free of any per-scholar checkpoint mutation", () => {
    // The write lives in the control; the view keeps its group-altitude calls.
    expect(view).not.toContain("mathPlans.saveForScholar");
    expect(view).not.toContain("setScholarCheckpointOverride");
  });

  it("hands the author route to the list mount only, never the map drawer", () => {
    expect((view.match(/onOpenPlan=\{setEditPlanScholarId\}/g) ?? []).length).toBe(1);
    const mapDrawer = view.slice(view.indexOf("<Drawer.Body>"));
    // The Map drawer's own SkillDetailPanel deliberately carries no route…
    const mapPanel = mapDrawer.slice(
      mapDrawer.indexOf("<SkillDetailPanel"),
      mapDrawer.indexOf("</Drawer.Body>"),
    );
    expect(mapPanel).toContain("mathPlanFor={renderMathPlanFor}");
    expect(mapPanel).not.toContain("onOpenPlan=");
    // …and that omission is stated, so nobody "fixes" it by hand.
    expect(mapDrawer).toMatch(/No `onOpenPlan` on this mount, on purpose/);
  });

  it("counts the band's siblings from the UNFILTERED domain nodes", () => {
    expect(view).toMatch(/bandSkillCount=\{\s*domainNodes\.filter\(/);
  });
});

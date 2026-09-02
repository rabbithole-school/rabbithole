/**
 * The World template FORM REGISTRY — one entry per physics template. Adding a
 * new template (e.g. matrixGame, publicGoods) is exactly ONE registry entry +
 * ONE Form component in this directory; SimulatorSpecEditor.tsx never grows a
 * template-specific branch.
 *
 * Deliberately independent of `lib/simulator/templates/registry.ts` (the SERVER
 * template registry — physics, validation, senses/actions/metrics): a
 * template can land there before its author-facing form exists here, in
 * which case SimulatorSpecEditor falls back to a read-only notice for it.
 */

import { ECOSYSTEM_GRID_FORM } from "./ecosystemGrid";
import { MATRIX_GAME_FORM } from "./matrixGame";
import { PRISONERS_DILEMMA_FORM } from "./prisonersDilemma";
import { PUBLIC_GOODS_FORM } from "./publicGoods";
import type { SimulatorFormEntry } from "./types";

export const SIMULATOR_FORMS: Readonly<Record<string, SimulatorFormEntry>> = {
  [ECOSYSTEM_GRID_FORM.templateId]: ECOSYSTEM_GRID_FORM,
  [PRISONERS_DILEMMA_FORM.templateId]: PRISONERS_DILEMMA_FORM,
  [MATRIX_GAME_FORM.templateId]: MATRIX_GAME_FORM,
  [PUBLIC_GOODS_FORM.templateId]: PUBLIC_GOODS_FORM,
};

export function getSimulatorForm(templateId: string): SimulatorFormEntry | null {
  return SIMULATOR_FORMS[templateId] ?? null;
}

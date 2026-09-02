/**
 * Shared types for the World template FORM REGISTRY (see registry.ts).
 *
 * Each physics template gets exactly one registry entry + one Form component.
 * SimulatorSpecEditor.tsx owns only the template-agnostic shell (loading state,
 * the Physics card — template/interpreter/micro-world — and the save bar);
 * everything template-specific (criterion, config, species slots, budgets)
 * lives inside that template's Form.
 */

import type { SimulatorSpec } from "@/lib/simulator/contract";

export type DeepWritable<T> = T extends readonly (infer U)[]
  ? DeepWritable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepWritable<T[K]> }
    : T;

/** Mirrors one entry of `design.templates` from `api.simulator.simulatorDesign`. */
export interface SimulatorTemplateMeta {
  id: string;
  version: number;
  senseIds: readonly string[];
  actionKinds: readonly string[];
  metricKeys: readonly string[];
  summaryMetricKeys: readonly string[];
}

export interface SimulatorFormLimits {
  maxSpeciesSlots: number;
  maxEcosystemSpeciesSlots: number;
  maxAutomataPerRun: number;
  maxPromptChars: number;
}

export interface SimulatorFormProps {
  activityId: string;
  draft: SimulatorSpec;
  templateMeta: SimulatorTemplateMeta;
  limits: SimulatorFormLimits;
  patch: (mut: (next: DeepWritable<SimulatorSpec>) => void) => void;
}

/** One row of the World template form registry. */
export interface SimulatorFormEntry {
  templateId: string;
  /** Button copy for the blank-draft "start from a template" picker. */
  startLabel: string;
  /** A fresh, valid author draft for this template — used by the blank-draft picker. */
  defaultSpec: (
    templateMeta: SimulatorTemplateMeta,
    activityId?: string,
  ) => SimulatorSpec;
  Form: React.ComponentType<SimulatorFormProps>;
}

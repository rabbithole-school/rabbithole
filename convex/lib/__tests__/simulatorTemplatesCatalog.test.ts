import { describe, expect, test } from "vitest";

import {
  assembleSimulatorSpec,
  buildSimulatorTemplateCatalog,
  simulatorAuthoringArgProperties,
  EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
  EXAMPLE_MATRIX_GAME_AUTHOR_INPUT,
  EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT,
  EXAMPLE_PUBLIC_GOODS_AUTHOR_INPUT,
  type SimulatorAuthorInput,
} from "../simulatorTemplatesCatalog";
import {
  SIMULATOR_TEMPLATE_IDS,
  SIMULATOR_TEMPLATES,
  getSimulatorTemplate,
} from "../../../lib/simulator/templates/registry";
import {
  COMPILED_POLICY_INTERPRETER_ID,
  SIMULATOR_PROTOCOL_VERSION,
} from "../../../lib/simulator/contract";

function validate(input: SimulatorAuthorInput) {
  const spec = assembleSimulatorSpec(input);
  const template = getSimulatorTemplate(input.templateId)!;
  // validateSpec throws on any invalid field — a clean pass is the assertion.
  template.validateSpec(spec as never);
  return spec;
}

describe("simulatorTemplatesCatalog", () => {
  test("assembleSimulatorSpec injects the invariants and clears validateSpec for every example", () => {
    for (const input of [
      EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
      EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT,
      EXAMPLE_MATRIX_GAME_AUTHOR_INPUT,
      EXAMPLE_PUBLIC_GOODS_AUTHOR_INPUT,
    ]) {
      const spec = validate(input);
      expect(spec.version).toBe(SIMULATOR_PROTOCOL_VERSION);
      expect(spec.templateVersion).toBe(
        SIMULATOR_TEMPLATES[input.templateId as keyof typeof SIMULATOR_TEMPLATES].version,
      );
      expect(spec.interpreter).toEqual({
        kind: "scripted",
        interpreterId: COMPILED_POLICY_INTERPRETER_ID,
      });
      expect(spec.microWorld).toBe(false);
    }
  });

  test("microWorld defaults to false and can be opted in", () => {
    expect(assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT).microWorld).toBe(false);
    expect(
      assembleSimulatorSpec({ ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT, microWorld: true })
        .microWorld,
    ).toBe(true);
  });

  test("an unknown templateId leaves templateVersion unset (validateSpec surfaces the real error)", () => {
    const spec = assembleSimulatorSpec({
      ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
      templateId: "notARealTemplate",
    });
    expect(spec.templateVersion).toBeUndefined();
    expect(getSimulatorTemplate("notARealTemplate")).toBeNull();
  });

  test("catalog machine facts are pulled from the registry (never drift)", () => {
    const catalog = buildSimulatorTemplateCatalog();
    expect(catalog.templates.map((t) => t.templateId).sort()).toEqual(
      [...SIMULATOR_TEMPLATE_IDS].sort(),
    );
    for (const entry of catalog.templates) {
      const runtime =
        SIMULATOR_TEMPLATES[entry.templateId as keyof typeof SIMULATOR_TEMPLATES];
      expect(entry.templateVersion).toBe(runtime.version);
      expect(entry.senseIds).toEqual(runtime.senseIds);
      expect(entry.actionKinds).toEqual(runtime.actionKinds);
      expect(entry.metricKeys).toEqual(runtime.metricKeys);
      // Every example the catalog hands the bot must itself validate.
      expect(() => validate(entry.exampleAuthorInput)).not.toThrow();
    }
    expect(catalog.limits.simulatorProtocolVersion).toBe(SIMULATOR_PROTOCOL_VERSION);
    const ecosystem = catalog.templates.find(
      (template) => template.templateId === "ecosystemGrid",
    );
    expect(ecosystem?.config.heredity).toMatch(/mutationStd.*0-0\.5/);
    expect(ecosystem?.exampleAuthorInput.config).not.toHaveProperty("heredity");
    // The disambiguation guidance is load-bearing — it keeps maps out of the
    // Simulator activity type.
    expect(catalog.whatWorldsAreNOT).toMatch(/map/i);
    expect(catalog.whatWorldsAreNOT).toMatch(/civilization/i);
    expect(catalog.whatWorldsAre).toContain("Simulator activity");
    expect(catalog.whatWorldsAreNOT).toContain("Simulator");
  });

  test("the shared arg schema exposes exactly the real template ids", () => {
    const props = simulatorAuthoringArgProperties();
    expect(props.templateId.enum.sort()).toEqual([...SIMULATOR_TEMPLATE_IDS].sort());
    for (const key of ["config", "speciesSlots", "criterion", "tickBudget"]) {
      expect(props).toHaveProperty(key);
    }
    expect(props.tickBudget.properties).toEqual({
      iterationTicks: { type: "integer", minimum: 1 },
      seasonTicks: { type: "integer", minimum: 1 },
      absoluteMaxTicks: { type: "integer", minimum: 1 },
    });
  });
});

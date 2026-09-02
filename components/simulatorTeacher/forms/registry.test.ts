import { describe, expect, test } from "vitest";

import { SIMULATOR_TEMPLATES } from "@/lib/simulator/templates/registry";
import { SIMULATOR_FORMS } from "./registry";
import type { SimulatorTemplateMeta } from "./types";

function templateMetaFor(templateId: string): SimulatorTemplateMeta {
  const runtime = SIMULATOR_TEMPLATES[templateId as keyof typeof SIMULATOR_TEMPLATES];
  return {
    id: runtime.id,
    version: runtime.version,
    senseIds: runtime.senseIds,
    actionKinds: runtime.actionKinds,
    metricKeys: runtime.metricKeys,
    summaryMetricKeys: runtime.summaryMetricKeys,
  };
}

describe("World template form registry", () => {
  test("every registered form's default spec passes the real server validateSpec", () => {
    for (const [templateId, entry] of Object.entries(SIMULATOR_FORMS)) {
      expect(entry.templateId).toBe(templateId);
      const templateMeta = templateMetaFor(templateId);
      const spec = entry.defaultSpec(templateMeta);
      expect(spec.templateId).toBe(templateId);
      const template = SIMULATOR_TEMPLATES[templateId as keyof typeof SIMULATOR_TEMPLATES];
      // validateSpec throws on any illegal field — a clean pass is the assertion.
      expect(() => template.validateSpec(spec)).not.toThrow();
    }
  });

  test("every registered templateId is a real server template", () => {
    for (const templateId of Object.keys(SIMULATOR_FORMS)) {
      expect(SIMULATOR_TEMPLATES).toHaveProperty(templateId);
    }
  });

  test("new ecosystem drafts start with an activity-specific scenic landscape", () => {
    const spec = SIMULATOR_FORMS.ecosystemGrid.defaultSpec(
      templateMetaFor("ecosystemGrid"),
      "activity-fixture",
    );
    expect(spec.templateId).toBe("ecosystemGrid");
    if (spec.templateId !== "ecosystemGrid") throw new Error("Expected ecosystemGrid");
    expect(spec.config.landscape).toMatchObject({
      version: 1,
      seed: "ecosystem-landscape-activity-fixture",
    });
  });

  test("getSimulatorForm falls back to null for an unregistered / unknown template", async () => {
    const { getSimulatorForm } = await import("./registry");
    expect(getSimulatorForm("notARealTemplate")).toBeNull();
  });
});

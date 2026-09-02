import { describe, expect, test } from "vitest";
import type { PreflightResult } from "@/convex/lib/curriculumPreflightResult";
import {
  canFixFinding,
  findingCoverageLabel,
  findingHandoffCaveat,
  fixFieldForFinding,
  protectedCoverageNotice,
  sortedFindings,
  type PreflightFinding,
} from "./rehearseResult";

function result(uncheckedProtectedDims?: string[]): PreflightResult {
  return {
    version: 1,
    analysisStatus: "complete",
    summary: "Summary",
    findings: [],
    coverage: {
      cast: {
        expected: 1,
        completed: 1,
        failed: 0,
        stopReasons: { goal: 1, stuck: 0, maxTurns: 0 },
      },
      probes: { completed: 0, skipped: 1 },
      ...(uncheckedProtectedDims !== undefined
        ? { uncheckedProtectedDims }
        : {}),
      context: {
        unit: "included",
        lesson: "included",
        resources: "included",
        deliverableScoring: "withheld",
        completion: "included",
      },
    },
  };
}

function finding(overrides: Partial<PreflightFinding>): PreflightFinding {
  return {
    id: "finding",
    provenance: "judged",
    status: "needs-action",
    owningLayer: "activity",
    severity: "medium",
    title: "Check the source",
    evidence: ["Evidence"],
    evidencePointer: "verdict:Pip",
    targetSurface: "activity-resources",
    suggestedAction: "Do the thing.",
    ...overrides,
  };
}

describe("fixFieldForFinding", () => {
  test("maps each editable target surface to its existing editor", () => {
    expect(fixFieldForFinding(finding({ targetSurface: "activity-resources" }))).toBe(
      "resources",
    );
    expect(
      fixFieldForFinding(finding({ targetSurface: "activity-deliverable" })),
    ).toBe("deliverable");
    expect(fixFieldForFinding(finding({ targetSurface: "activity-duration" }))).toBe(
      "duration",
    );
    expect(
      fixFieldForFinding(finding({ targetSurface: "activity-tutor-prompt" })),
    ).toBe("tutorPrompt");
  });

  test("a cast-level finding has no editor to route to", () => {
    expect(fixFieldForFinding(finding({ targetSurface: "rehearse" }))).toBeNull();
  });
});

describe("canFixFinding", () => {
  test("a rehearse-target finding is never fixable via an editor", () => {
    const preflight = result([]);
    expect(
      canFixFinding(preflight, finding({ targetSurface: "rehearse" })),
    ).toBe(false);
  });

  test("a needs-action finding is always fixable", () => {
    const preflight = result([]);
    expect(
      canFixFinding(
        preflight,
        finding({ status: "needs-action", targetSurface: "activity-duration" }),
      ),
    ).toBe(true);
  });

  test("a not-observed finding is fixable when its own layer is exactly what's missing", () => {
    const preflight = result([]);
    preflight.coverage.context.resources = "withheld";
    expect(
      canFixFinding(
        preflight,
        finding({
          status: "not-observed",
          targetSurface: "activity-resources",
          contextDependencies: ["resources"],
        }),
      ),
    ).toBe(true);
  });

  test("a limited prompt finding cannot bypass a missing Resources dependency", () => {
    const preflight = result([]);
    preflight.coverage.context.resources = "withheld";
    expect(
      canFixFinding(
        preflight,
        finding({
          status: "not-observed",
          targetSurface: "activity-tutor-prompt",
          contextDependencies: ["resources"],
        }),
      ),
    ).toBe(false);
  });
});

describe("findingCoverageLabel", () => {
  test("only labels not-observed findings", () => {
    const preflight = result([]);
    expect(
      findingCoverageLabel(preflight, finding({ status: "needs-action" })),
    ).toBeNull();
  });

  test("limited labels follow evidence dependencies rather than edit target", () => {
    const preflight = result([]);
    expect(
      findingCoverageLabel(
        preflight,
        finding({
          status: "not-observed",
          targetSurface: "activity-resources",
          contextDependencies: ["deliverableScoring"],
        }),
      ),
    ).toBe("Limited · deliverable scoring withheld");
  });
});

describe("findingHandoffCaveat", () => {
  test("a needs-action finding just asks for a rerun after the change", () => {
    expect(
      findingHandoffCaveat(finding({ status: "needs-action" }), undefined),
    ).toMatch(/rerun Preflight/);
  });

  test("a not-observed finding names its actual target and missing context", () => {
    const preflight = result([]);
    expect(
      findingHandoffCaveat(
        finding({
          status: "not-observed",
          targetSurface: "activity-deliverable",
          contextDependencies: ["deliverableScoring"],
        }),
        preflight.coverage.context,
      ),
    ).toBe(
      "This run cannot verify a Deliverable repair because required context was incomplete: deliverable scoring (withheld). Readiness stays incomplete until a fresh run observes the revision.",
    );
  });
});

describe("protectedCoverageNotice", () => {
  test("legacy runs with no recorded coverage render as unknown", () => {
    expect(protectedCoverageNotice(result())).toMatch(
      /historical run did not record coverage/i,
    );
  });

  test("an explicit empty list renders no rerun warning", () => {
    expect(protectedCoverageNotice(result([]))).toBeNull();
  });

  test("nonempty coverage names the missing checks with readable labels", () => {
    expect(
      protectedCoverageNotice(result(["socratic", "noSpoilers"])),
    ).toBe("Needs rerun · checks not run: Socratic, No spoilers.");
  });
});

describe("sortedFindings", () => {
  test("orders by severity, highest first", () => {
    const preflight = result([]);
    preflight.findings = [
      finding({ id: "low", severity: "low" }),
      finding({ id: "critical", severity: "critical" }),
      finding({ id: "medium", severity: "medium" }),
      finding({ id: "high", severity: "high" }),
    ];
    expect(sortedFindings(preflight).map((f) => f.id)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });
});

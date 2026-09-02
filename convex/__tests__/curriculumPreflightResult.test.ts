import { describe, expect, test } from "vitest";
import {
  deterministicPreflightFindings,
  fallbackPreflightResult,
  normalizeBackendCommit,
  normalizePreflightSynthesis,
  preflightCoverage,
  type PreflightCoverage,
} from "../lib/curriculumPreflightResult";

const context: PreflightCoverage["context"] = {
  unit: "withheld",
  lesson: "withheld",
  resources: "withheld",
  deliverableScoring: "withheld",
  completion: "withheld",
};

describe("curriculum Preflight result", () => {
  test("accepts only an exact backend commit stamp", () => {
    expect(normalizeBackendCommit("A".repeat(40))).toBe("a".repeat(40));
    expect(normalizeBackendCommit("main")).toBe("unavailable");
    expect(normalizeBackendCommit(undefined)).toBe("unavailable");
  });

  test("freezes cast completion and stop-reason coverage", () => {
    expect(
      preflightCoverage(5, ["goal", "maxTurns", "maxTurns", "stuck"], context),
    ).toEqual({
      cast: {
        expected: 5,
        completed: 4,
        failed: 1,
        stopReasons: { goal: 1, stuck: 1, maxTurns: 2 },
      },
      probes: { completed: 0, skipped: 0 },
      turns: { allowed: 0, perSim: [] },
      correctness: "not-checked",
      protectedFloorBreaches: [],
      context,
    });
  });

  test("normalizes judged findings with stable evidence pointers", () => {
    const coverage = preflightCoverage(1, ["goal"], context);
    const result = normalizePreflightSynthesis(
      {
        summary: " The source is missing. ",
        findings: [
          {
            title: " Add the named source ",
            evidence: [" The sim could not inspect the list. "],
            evidencePointer: " verdict:Pip:promptAttribution ",
            owningLayer: "activity",
            severity: "high",
            targetSurface: "activity-resources",
            suggestedAction: " Attach the list in Resources. ",
            contextDependencies: ["resources"],
          },
        ],
      },
      coverage,
      () => "finding-stable",
    );

    expect(result).toMatchObject({
      analysisStatus: "complete",
      summary: "The source is missing.",
      findings: [
        {
          id: "finding-stable",
          provenance: "judged",
          status: "not-observed",
          owningLayer: "activity",
          severity: "high",
          targetSurface: "activity-resources",
          evidencePointer: "verdict:Pip:promptAttribution",
          contextDependencies: ["resources"],
        },
      ],
    });
  });

  test("normalizes a populated cross-sim inventory without falling back", () => {
    const coverage = preflightCoverage(2, ["goal", "goal"], context);
    let id = 0;
    const result = normalizePreflightSynthesis(
      {
        summary: "Strong run.",
        findings: [],
        runObservedInventory: [
          {
            title: "Two labels appeared",
            evidence: ["Pip: fair-test rule", "Cog: controlled variables"],
          },
        ],
      },
      coverage,
      () => `id-${++id}`,
    );

    expect(result?.analysisStatus).toBe("complete");
    expect(result?.findings).toEqual([]);
    expect(result?.runObservedInventory).toEqual([
      {
        id: "id-1",
        provenance: "judged",
        title: "Two labels appeared",
        evidence: ["Pip: fair-test rule", "Cog: controlled variables"],
      },
    ]);
  });

  test("rejects findings without evidence or a canonical target", () => {
    const coverage = preflightCoverage(1, ["goal"], context);
    expect(
      normalizePreflightSynthesis(
        {
          summary: "Bad output",
          findings: [
            {
              title: "Do something",
              evidence: [],
              evidencePointer: "aggregate",
              owningLayer: "activity",
              severity: "medium",
              targetSurface: "other",
              suggestedAction: "Change it",
              contextDependencies: [],
            },
          ],
        },
        coverage,
      ),
    ).toBeNull();
  });

  test("rejects the whole synthesis when one supplied finding is malformed", () => {
    const coverage = preflightCoverage(1, ["goal"], context);
    expect(
      normalizePreflightSynthesis(
        {
          summary: "Mixed output",
          findings: [
            {
              title: "Valid",
              evidence: ["Grounded evidence"],
              evidencePointer: "verdict:one",
              owningLayer: "activity",
              severity: "medium",
              targetSurface: "activity-tutor-prompt",
              suggestedAction: "Revise the opener.",
              contextDependencies: [],
            },
            {
              title: "Malformed blocker",
              evidence: [],
              evidencePointer: "verdict:two",
              owningLayer: "activity",
              severity: "critical",
              targetSurface: "activity-deliverable",
              suggestedAction: "Fix the rubric.",
              contextDependencies: [],
            },
          ],
          runObservedInventory: [],
        },
        coverage,
      ),
    ).toBeNull();
  });

  test("adds deterministic coverage findings without manufacturing advice", () => {
    const coverage = preflightCoverage(
      5,
      ["goal", "maxTurns", "maxTurns", "maxTurns"],
      context,
    );
    const findings = deterministicPreflightFindings({
      coverage,
      durationMinutes: 20,
    });
    expect(findings.map((finding) => finding.id)).toEqual([
      "deterministic-cast-coverage",
      "deterministic-time-budget",
    ]);
    expect(
      findings.every((finding) => finding.provenance === "deterministic"),
    ).toBe(true);
  });

  test("adds a protected-floor-breach finding from calibrated per-sim breaches", () => {
    const coverage = preflightCoverage(3, ["goal", "goal", "goal"], context, {
      completed: 0,
      skipped: 0,
    }, { allowed: 0, perSim: [] }, "not-checked", [
      { profileName: "Pip", dimension: "depth", value: 1, floor: 2 },
    ]);
    const findings = deterministicPreflightFindings({
      coverage,
      durationMinutes: 20,
    });
    expect(findings.map((finding) => finding.id)).toEqual([
      "deterministic-protected-floor-breach",
    ]);
    expect(findings[0]).toMatchObject({
      provenance: "deterministic",
      owningLayer: "tutor",
      severity: "high",
      targetSurface: "activity-tutor-prompt",
      evidencePointer: "coverage:protectedFloorBreaches",
    });
    expect(findings[0].evidence).toContain("Pip: depth 1 < 2.");
  });

  test("limited status follows explicit evidence dependencies", () => {
    const coverage = preflightCoverage(1, ["goal"], {
      ...context,
      resources: "included",
    });
    const result = normalizePreflightSynthesis(
      {
        summary: "The deliverable source could not be assessed.",
        findings: [
          {
            title: "Check the deliverable source",
            evidence: ["The verdict depends on withheld deliverable scoring."],
            evidencePointer: "verdict:Pip:promptAttribution",
            owningLayer: "activity",
            severity: "medium",
            targetSurface: "activity-resources",
            suggestedAction: "Inspect the deliverable and source together.",
            contextDependencies: ["deliverableScoring"],
          },
        ],
      },
      coverage,
      () => "dependency-finding",
    );

    expect(result?.findings[0]).toMatchObject({
      id: "dependency-finding",
      status: "not-observed",
      contextDependencies: ["deliverableScoring"],
    });
  });

  test("fallback is explicit and preserves deterministic findings", () => {
    const coverage = preflightCoverage(1, ["maxTurns"], context);
    const deterministic = deterministicPreflightFindings({
      coverage,
      durationMinutes: null,
    });
    const result = fallbackPreflightResult(coverage, deterministic);

    expect(result.summary).toMatch(/could not be generated/i);
    expect(result.analysisStatus).toBe("unavailable");
    expect(result.findings[0]?.id).toBe(
      "deterministic-judged-analysis-unavailable",
    );
    expect(result.findings[0]?.title).toMatch(
      /cross-sim synthesis was unavailable/i,
    );
    expect(result.findings[0]?.suggestedAction).toMatch(
      /per-sim scorecards and activity attributions/i,
    );
    expect(result.findings.slice(1)).toEqual(deterministic);
  });

  test("distinguishes an internal synthesis error from ordinary unavailability", () => {
    const coverage = preflightCoverage(1, ["goal"], context);
    const result = fallbackPreflightResult(coverage, [], "error");
    expect(result.analysisStatus).toBe("error");
    expect(result.findings[0]?.id).toBe("deterministic-judged-analysis-error");
  });
});

import { describe, expect, test } from "vitest";
import { parseObserverResponse } from "../lib/observerShared";

/**
 * The observer's chat "going in circles" signal is a pure passthrough on the
 * parse boundary (like safetyAlert / socialRelianceAlert). These lock the
 * contract the observer action relies on: an emitted `stuckAlert` survives
 * normalization, and its absence stays undefined (the OMIT default).
 */
describe("parseObserverResponse — stuckAlert", () => {
  const minimalPulse = {
    engagementScore: 0.4,
    complexityLevel: 0.5,
    onTaskScore: 0.4,
    topics: [],
    learningIndicators: [],
    concernFlags: [],
    summary: "Spinning on the same step.",
    pulseScore: 2,
  };

  test("passes an emitted stuckAlert through unchanged", () => {
    const result = parseObserverResponse([
      {
        type: "tool_use",
        input: {
          pulse: minimalPulse,
          observations: [],
          sessionSignals: [],
          crossDomainConnections: [],
          seeds: [],
          stuckAlert: {
            severity: "warning",
            summary:
              "Circling the same subtraction regrouping error across five turns with no progress.",
            excerpt: "i still don't get it, this makes no sense",
          },
        },
      },
    ]);
    expect(result?.stuckAlert).toEqual({
      severity: "warning",
      summary:
        "Circling the same subtraction regrouping error across five turns with no progress.",
      excerpt: "i still don't get it, this makes no sense",
    });
  });

  test("omitted stuckAlert normalizes to undefined", () => {
    const result = parseObserverResponse([
      {
        type: "tool_use",
        input: {
          pulse: minimalPulse,
          observations: [],
          sessionSignals: [],
          crossDomainConnections: [],
          seeds: [],
        },
      },
    ]);
    expect(result?.stuckAlert).toBeUndefined();
  });
});

/**
 * The affective twin of stuckAlert. Same pure-passthrough contract, plus the
 * property that actually justifies the signal existing: it is emitted for a
 * moment that RESOLVED, which stuckAlert omits by design.
 */
describe("parseObserverResponse — overwhelmAlert", () => {
  const minimalPulse = {
    engagementScore: 0.4,
    complexityLevel: 0.5,
    onTaskScore: 0.4,
    topics: [],
    learningIndicators: [],
    concernFlags: [],
    summary: "Asked to stop, then carried on.",
    pulseScore: 2,
  };

  const parse = (input: Record<string, unknown>) =>
    parseObserverResponse([
      {
        type: "tool_use",
        input: {
          pulse: minimalPulse,
          observations: [],
          sessionSignals: [],
          crossDomainConnections: [],
          seeds: [],
          ...input,
        },
      },
    ]);

  test("passes an emitted overwhelmAlert through unchanged", () => {
    const result = parse({
      overwhelmAlert: {
        severity: "info",
        summary:
          "Asked to stop partway through the fraction task; the tutor offered a smaller step and they continued.",
        excerpt: "can we stop i don't want to do this",
      },
    });
    expect(result?.overwhelmAlert).toEqual({
      severity: "info",
      summary:
        "Asked to stop partway through the fraction task; the tutor offered a smaller step and they continued.",
      excerpt: "can we stop i don't want to do this",
    });
  });

  test("omitted overwhelmAlert normalizes to undefined", () => {
    expect(parse({})?.overwhelmAlert).toBeUndefined();
  });

  test("the two alerts are independent at the parse boundary", () => {
    // Precedence between them is enforced by the observer action, not here —
    // the parser must not silently drop either one.
    const result = parse({
      stuckAlert: { severity: "warning", summary: "Circling." },
      overwhelmAlert: { severity: "warning", summary: "Asked to stop." },
    });
    expect(result?.stuckAlert?.summary).toBe("Circling.");
    expect(result?.overwhelmAlert?.summary).toBe("Asked to stop.");
  });
});

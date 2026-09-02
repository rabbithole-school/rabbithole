import { describe, expect, it } from "vitest";
import {
  systemAttentionCopy,
  systemAttentionHeadline,
  systemAttentionNeedsDecision,
} from "./systemAttention";

describe("System attention copy", () => {
  it("strips the rule version — a teacher never reads a rule id", () => {
    expect(systemAttentionCopy("frustration_without_disposition:v1")?.rule).toBe(
      "frustration_without_disposition",
    );
    expect(systemAttentionCopy("frustration_without_disposition:v7")?.rule).toBe(
      "frustration_without_disposition",
    );
    expect(systemAttentionCopy("seed_agent_visible_human_truncated:v2")?.rule).toBe(
      "seed_agent_visible_human_truncated",
    );
  });

  it("drops an unrecognised rule instead of leaking its raw id", () => {
    expect(systemAttentionCopy("some_future_rule:v1")).toBeNull();
    expect(systemAttentionCopy("")).toBeNull();
    expect(systemAttentionCopy(null)).toBeNull();
    expect(systemAttentionCopy(undefined)).toBeNull();
  });

  it("never echoes an id, a source ref, or a raw enum into visible copy", () => {
    for (const rule of [
      "frustration_without_disposition:v1",
      "seed_agent_visible_human_truncated:v1",
    ]) {
      const copy = systemAttentionCopy(rule)!;
      const visible = `${copy.label} ${copy.help}`;
      expect(visible).not.toMatch(/_/); // no snake_case enum or rule id
      expect(visible).not.toMatch(/:v\d/);
      // Table names are internal plumbing. ("seeds" as product vocabulary is
      // fine — exploration seeds are a thing teachers already talk about.)
      expect(visible).not.toMatch(/sweepFindings|sessionSignals|stateRef|docId/);
      // Sentence case: only the first word carries a capital.
      expect(copy.label.slice(1)).toBe(copy.label.slice(1).toLowerCase());
    }
  });

  it("talks about the system's blind spot, not the child's deficit", () => {
    const frustration = systemAttentionCopy("frustration_without_disposition:v1")!;
    expect(frustration.help).toMatch(/no one has said what to do/i);
    const seeds = systemAttentionCopy("seed_agent_visible_human_truncated:v1")!;
    expect(seeds.label).toMatch(/staff aide can see more/i);
    for (const copy of [frustration, seeds]) {
      expect(`${copy.label} ${copy.help}`).not.toMatch(/gap|behind|deficit|struggling/i);
    }
  });

  it("flags only the dispositions still waiting on a human", () => {
    expect(systemAttentionNeedsDecision("needs_decision")).toBe(true);
    expect(systemAttentionNeedsDecision("repair_proposed")).toBe(true);
    expect(systemAttentionNeedsDecision("logged_only")).toBe(false);
    expect(systemAttentionNeedsDecision(undefined)).toBe(false);
  });

  it("counts findings, in plain speech", () => {
    expect(systemAttentionHeadline(1)).toBe("1 thing the system wants a human on");
    expect(systemAttentionHeadline(3)).toBe("3 things the system wants a human on");
  });
});

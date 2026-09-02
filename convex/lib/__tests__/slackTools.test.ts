import { describe, expect, test } from "vitest";
import { linkTopicFor } from "../slackTools";

// The topic-string selection is a pure function so we can pin the exact stamp
// per link type without standing up the tool loop. These strings are what the
// bot writes to a channel's topic on the explicit LINK action.

describe("linkTopicFor — the self-documenting channel topic per link type", () => {
  test("group link uses the canonical group name", () => {
    expect(linkTopicFor("group", { groupName: "Geckos" })).toBe(
      "📚 Geckos · Rabbithole activity updates",
    );
  });

  test("group name is trimmed, with a sensible fallback when blank", () => {
    expect(linkTopicFor("group", { groupName: "  Sea Turtles  " })).toBe(
      "📚 Sea Turtles · Rabbithole activity updates",
    );
    expect(linkTopicFor("group", { groupName: "" })).toBe(
      "📚 Scholar group · Rabbithole activity updates",
    );
    expect(linkTopicFor("group")).toBe(
      "📚 Scholar group · Rabbithole activity updates",
    );
  });

  test("catchall alerts link (or role unknown) is the generic alerts stamp", () => {
    expect(linkTopicFor("alerts", { alertsRole: "catchall" })).toBe(
      "🚨 Rabbithole alerts · safety alerts & weekly reports",
    );
    expect(linkTopicFor("alerts")).toBe(
      "🚨 Rabbithole alerts · safety alerts & weekly reports",
    );
  });

  test("scoped alerts link names the institution", () => {
    expect(
      linkTopicFor("alerts", { alertsRole: "scoped", institutionName: "Moli School" }),
    ).toBe("🚨 Moli School · Rabbithole safety alerts & weekly reports");
  });

  test("platform-ops link never claims safety alerts (and drops the siren)", () => {
    const topic = linkTopicFor("alerts", { alertsRole: "platform-ops" });
    expect(topic).toBe(
      "📊 Rabbithole platform ops · cost/usage reports & system alerts",
    );
    expect(topic).not.toContain("safety");
    expect(topic).not.toContain("🚨");
  });

  test("improvement-loop link names only the generic policies", () => {
    const topic = linkTopicFor("alerts", { alertsRole: "improvement-loops" });
    expect(topic).toBe(
      "🔄 Rabbithole improvement loops · Rounds, Coherence & proposals",
    );
    expect(topic).not.toContain("scholar");
  });

  test("parent-message link flags PRIVATE / staff-only", () => {
    expect(linkTopicFor("parent")).toBe(
      "✉️ Rabbithole parent messages · PRIVATE — staff only",
    );
  });

  test("every stamp is within Slack's 250-char topic cap", () => {
    for (const topic of [
      linkTopicFor("group", {
        groupName: "A very long scholar group name that a teacher might pick",
      }),
      linkTopicFor("alerts", { alertsRole: "catchall" }),
      linkTopicFor("alerts", {
        alertsRole: "scoped",
        institutionName: "A School With A Rather Long Official Name",
      }),
      linkTopicFor("alerts", { alertsRole: "platform-ops" }),
      linkTopicFor("alerts", { alertsRole: "improvement-loops" }),
      linkTopicFor("parent"),
    ]) {
      expect(topic.length).toBeLessThanOrEqual(250);
    }
  });
});

import { describe, expect, test } from "vitest";
import { linkTopicFor } from "../slackTools";

// Behavior of the topic selector, not its copy: which inputs surface in the
// stamp, which roles must NOT claim safety alerts, and Slack's hard cap.

describe("linkTopicFor — channel topic per link type", () => {
  test("group topics carry the trimmed group name, with a fallback when blank", () => {
    expect(linkTopicFor("group", { groupName: "  Sea Turtles  " })).toContain("Sea Turtles");
    expect(linkTopicFor("group", { groupName: "  Sea Turtles  " })).not.toContain("  ");
    expect(linkTopicFor("group", { groupName: "" })).toBe(linkTopicFor("group"));
    expect(linkTopicFor("group")).not.toBe("");
  });

  test("scoped alerts name the institution; catchall and unknown role share one stamp", () => {
    const scoped = linkTopicFor("alerts", { alertsRole: "scoped", institutionName: "Moli School" });
    expect(scoped).toContain("Moli School");
    expect(linkTopicFor("alerts", { alertsRole: "catchall" })).toBe(linkTopicFor("alerts"));
    expect(scoped).not.toBe(linkTopicFor("alerts"));
  });

  test("platform-ops and improvement-loop channels never claim safety alerts", () => {
    for (const alertsRole of ["platform-ops", "improvement-loops"] as const) {
      const topic = linkTopicFor("alerts", { alertsRole });
      expect(topic).not.toContain("safety");
      expect(topic).not.toContain("🚨");
      expect(topic).not.toBe(linkTopicFor("alerts"));
    }
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

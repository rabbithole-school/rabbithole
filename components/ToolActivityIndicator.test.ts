import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, test } from "vitest";

import { ToolGroupRow } from "@/components/ToolActivityIndicator";
import type { ToolGroup } from "@/lib/toolActivityGroups";
import { system } from "@/lib/theme";

function render(group: ToolGroup, scholarSafe = false, isExpanded = false): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
    createElement(ChakraProvider, {
      value: system,
      children: createElement(ToolGroupRow, {
        group,
        isExpanded,
        onToggle: () => {},
        scholarSafe,
      }),
    }),
  );
}

const lessons = (results: string[]): ToolGroup => ({
  name: "create_lesson",
  status: "complete",
  items: results.map((result) => ({ result })),
});

describe("ToolGroupRow shows the shared tool status (the same as Slack's cards)", () => {
  test("a finished group shows its done label", () => {
    const html = render(lessons(["Created A", "Created B"]));
    expect(html).toContain("Created 2 lessons");
    expect(html).not.toContain('aria-label="failed"');
  });

  test("a partly failed group says how many failed, and why", () => {
    const html = render(lessons(["Created A", "Failed: boom", "Created C"]));
    expect(html).toContain("Created 3 lessons (1 of 3 failed) — boom");
    expect(html).toContain('aria-label="failed"');
  });

  test("a wholly failed group is named by its tool, never as done work", () => {
    const html = render(lessons(["Failed: boom", "Failed: boom"]));
    expect(html).toContain("Creating lesson (2) — boom");
    expect(html).not.toContain("Created");
  });

  test("a single failed call is titled with the tool and the reason, as Slack's card is", () => {
    const html = render({
      name: "dispatch_implementation",
      status: "complete",
      items: [{ result: "Failed: daily dispatch cap reached" }],
    });
    expect(html).toContain("Dispatching implementation — daily dispatch cap reached");
    // Nothing more to open: the whole reason is in the title.
    expect(html).not.toContain("aria-expanded");
  });

  test("a Convex server error shows its message, and the row opens to the full text", () => {
    const raw = [
      "Failed: [CONVEX M(lessons:create)] [Request ID: 5c0ffee5c0ffee50] Server Error",
      "Uncaught Error: Lesson not found",
      "    at handler (../convex/lessons.ts:42:11)",
    ].join("\n");
    const failed: ToolGroup = {
      name: "create_scholar_activity",
      status: "complete",
      items: [{ result: raw }],
    };
    const closed = render(failed);
    expect(closed).toContain("Adding activity — Lesson not found");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Request ID");
    const open = render(failed, false, true);
    expect(open).toContain("Request ID: 5c0ffee5c0ffee50");
  });

  test("a scholar never sees a finished tool row", () => {
    const html = render(
      { name: "update_rubric_score", status: "complete", items: [{ result: "Failed: boom" }] },
      true,
    );
    // The provider still emits its global styles; the row itself renders nothing.
    expect(html).not.toContain("boom");
    expect(html).not.toContain("Checking your work");
    expect(html).not.toContain('aria-label="failed"');
  });
});

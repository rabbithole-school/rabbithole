import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The dashboard page is wired directly to live Convex hooks, with no component
// render harness. Keep this source invariant beside the route so a refactor
// cannot regress the new-tab Rehearse control into invalid nested interactives.
const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

function rehearseControl() {
  const marker = 'data-testid="content-rehearse"';
  const markerIndex = source.indexOf(marker);
  const start = source.lastIndexOf("<Button", markerIndex);
  const end = source.indexOf("</Button>", markerIndex);
  if (markerIndex < 0 || start < 0 || end < 0) {
    throw new Error("Math Skills Rehearse control markers not found.");
  }
  return source.slice(start, end + "</Button>".length);
}

describe("Math Skills Rehearse control", () => {
  test("uses one safe new-tab anchor through Chakra Button asChild", () => {
    const control = rehearseControl();

    expect(control).toMatch(/^<Button\s+asChild\b/);
    expect(control.match(/<a\b/g)).toHaveLength(1);
    expect(control.match(/<\/a>/g)).toHaveLength(1);
    expect(control).toMatch(/<a\b[^>]*target="_blank"[^>]*rel="noopener"[^>]*>/);
    expect(control).not.toMatch(/<button\b/);
  });
});

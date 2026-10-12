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

// The shareable-URL effect rebuilds the query string from an EMPTY
// URLSearchParams, so any param it doesn't name is stripped on the next write.
// `inst=` (the institution lens, owned by the account menu) was the one that
// mattered: dropping it bounced a non-home school's roster straight back to the
// home school, so Math Skills could never show those scholars. Pin the
// carry-through beside the route — there is no render harness here.
function urlRebuildEffect() {
  const start = source.indexOf("const q = new URLSearchParams();");
  const end = source.indexOf("router[navigationMode](href", start);
  if (start < 0 || end < 0) {
    throw new Error("Math Skills URL-rebuild effect markers not found.");
  }
  return source.slice(start, end);
}

describe("Math Skills shareable URL", () => {
  test("carries the params the page does not own", () => {
    const effect = urlRebuildEffect();

    // Both externally-owned params come off the LIVE address, not the reactive
    // `params` snapshot: they arrive via navigations this effect isn't keyed on.
    expect(effect).toContain(
      "new URLSearchParams(window.location.search)",
    );
    for (const param of ["inst", "colorBy"]) {
      expect(effect).toMatch(
        new RegExp(`liveParams\\.get\\(\\s*"${param}"\\s*\\)`),
      );
      expect(effect).toMatch(new RegExp(`q\\.set\\("${param}"`));
    }
  });

  test("reads the live address only once, so a param cannot be carried from a stale read", () => {
    const effect = urlRebuildEffect();

    expect(
      effect.match(/new URLSearchParams\(window\.location\.search\)/g),
    ).toHaveLength(1);
  });
});

describe("Math Skills default group scope", () => {
  // The shell resolves the focused scholar out of the SCOPED roster, so
  // applying an owned math cohort on top of a `?scholar=` link can scope the
  // named scholar off the matrix. A program guest belongs to no math cohort,
  // so for them it always would.
  test("yields to a URL that already names a scholar", () => {
    const call = source.slice(
      source.indexOf("useDefaultGroupScope({"),
      source.indexOf("});", source.indexOf("useDefaultGroupScope({")),
    );

    expect(call).toMatch(/enabled:\s*!scopeCameFromUrl\s*&&\s*!scholarCameFromUrl/);
    expect(source).toMatch(/scholarCameFromUrl\]\s*=\s*useState\(\(\)\s*=>\s*!!params\.get\("scholar"\)\)/);
  });
});

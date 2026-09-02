/**
 * The compact slides panel beside a chat is a READ-ONLY vertical list, and it
 * must not own scrolling.
 *
 * Both of its callers already render it inside a vertical scroller
 * (`DeliverablePanel`'s ScrollView, `DeliverableCard`'s inverted chat
 * FlatList). A same-axis scroller nested in those traps gestures, and an
 * auto-scroll-to-index effect made the panel visibly jump every time the
 * full-screen editor opened or closed. Both are easy to reintroduce by
 * reaching for a ScrollView, so this guards the source directly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "SlidesEditorNative.tsx"), "utf8");

/** The body of `CompactSlidesViewer`, which is the compact panel itself. */
function compactViewerSource(): string {
  const start = SOURCE.indexOf("function CompactSlidesViewer");
  expect(start, "CompactSlidesViewer should exist").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\nfunction ", start + 1);
  expect(end, "CompactSlidesViewer should be followed by another function").toBeGreaterThan(start);
  // Comments explain what the panel deliberately avoids, so they would match
  // the very patterns being guarded against.
  return SOURCE.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("compact slides panel", () => {
  it("does not nest its own scroller inside the panel that already scrolls", () => {
    const body = compactViewerSource();
    expect(body).not.toMatch(/<ScrollView/);
    expect(body).not.toMatch(/FlatList/);
  });

  it("never scrolls itself to the selected slide", () => {
    const body = compactViewerSource();
    expect(body).not.toMatch(/scrollTo\s*\(/);
    expect(body).not.toMatch(/scrollToIndex/);
    expect(body).not.toMatch(/contentOffset/);
  });

  it("renders every slide, not one paged card", () => {
    const body = compactViewerSource();
    expect(body).toMatch(/deck\.slides\.map/);
    // A horizontal pager is what the vertical list replaced.
    expect(body).not.toMatch(/horizontal/);
    expect(body).not.toMatch(/snapToInterval/);
  });

  it("exposes no editing affordance of its own", () => {
    const body = compactViewerSource();
    // Adding, deleting, or editing notes belongs to the full editor.
    expect(body).not.toMatch(/onDelete|onAdd|addSlide|deleteSlide/i);
    expect(body).not.toMatch(/TextInput/);
    // So does the Grid/Slide switcher: one list, one way to read it.
    expect(body).not.toMatch(/SlideGrid|gridOpen|ToggleGrid/);
  });

  it("only offers a slide press when the caller can open the editor", () => {
    const body = compactViewerSource();
    // The press target is gated on `onOpenEditor`, which the read-only
    // (teacher-remote) caller does not pass.
    expect(body).toMatch(/onOpenEditor \?/);
  });
});

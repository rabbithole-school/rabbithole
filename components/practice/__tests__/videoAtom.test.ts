import { describe, it, expect } from "vitest";
import {
  VIDEO_EYEBROW_LABEL,
  videoHasReachedEnd,
  videoIframeSrc,
} from "@/components/practice/LaunchpadContent";
import {
  instructionVideoEmbedUrl,
  type InstructionVideoAtom,
} from "@/convex/lib/practice/instructionEntries";

/**
 * The doctrine of the web `video` atom renderer (plan §7), driven through the
 * SAME pure decision seams the component delegates to — this env has no DOM
 * renderer (see `launchpadInstructionFixes.test.ts`), so a regression in the
 * no-autoplay guarantee fails an assertion here rather than only showing up in
 * a screenshot.
 */

const atom: InstructionVideoAtom = {
  kind: "video",
  provider: "youtube",
  videoId: "abc123",
  startSec: 90,
  endSec: 210,
  captionText: "Watch the jump land on the whole number, then make the same jump.",
  sourceLabel: "Khan Academy — Adding fractions",
  sourceUrl: "https://www.khanacademy.org/math/arithmetic/fractions",
};

describe("video atom · no autoplay (tap-to-play guarantee)", () => {
  it("mounts NO iframe before the tap — src is null until playing", () => {
    // The single decision that keeps watching active: before a tap there is no
    // iframe, so no YouTube pixel / media request exists.
    expect(videoIframeSrc(atom, false)).toBeNull();
  });

  it("after the tap, extends the shared privacy-enhanced clipped embed URL with the runtime API origin", () => {
    const origin = "https://preview.example.test";
    const src = videoIframeSrc(atom, true, origin);
    expect(src).toBe(`${instructionVideoEmbedUrl(atom)}&enablejsapi=1&origin=${encodeURIComponent(origin)}`);
    expect(src).toContain("youtube-nocookie.com/embed/abc123");
    expect(src).toContain("start=90");
    expect(src).toContain("end=210");
    expect(src).toContain("rel=0");
  });
});

describe("video atom · end-screen interception", () => {
  it("finishes from the clock poll just before the authored end", () => {
    expect(videoHasReachedEnd(209.89, atom.endSec)).toBe(false);
    expect(videoHasReachedEnd(209.9, atom.endSec)).toBe(true);
  });

  it("does not treat an unavailable clock reading as finished", () => {
    expect(videoHasReachedEnd(undefined, atom.endSec)).toBe(false);
  });
});

// There is deliberately no attribution assertion here any more: the per-clip
// "Source: <label>" link under the player was removed, and the source credit
// lives on the pre-auth /sources page, which carries Khan Academy's required
// notice verbatim.

describe("video atom · eyebrow voice", () => {
  it("is 'See the move' — not the word 'Video', never 'Watch this video'", () => {
    expect(VIDEO_EYEBROW_LABEL).toBe("See the move");
    expect(VIDEO_EYEBROW_LABEL).not.toMatch(/^Video$/i);
    expect(VIDEO_EYEBROW_LABEL.toLowerCase()).not.toContain("watch this video");
  });
});

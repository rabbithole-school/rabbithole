import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripMarkdownForSpeech } from "../../../vendor/shared/sentenceStream";

// The read-aloud affordance MUST speak a tutor message the SAME way on web and
// iPad — same markdown stripping, so a kid hears prose (not "star star") on
// either surface. Native can't import repo-root lib/ directly (metro never
// crawls outside the project root), so it consumes a vendored copy refreshed by
// `npm run sync:vendor`. Nothing forces that refresh, so this pins the copy to
// its source: if lib/sentenceStream.ts changes and the vendor copy isn't
// re-synced, this fails instead of the two surfaces quietly drifting apart.
const repoRoot = path.resolve(__dirname, "../../../..");

describe("vendored sentence-stream markdown stripper", () => {
  it("is byte-identical to the lib/ source web and convex use", () => {
    const source = readFileSync(path.join(repoRoot, "lib/sentenceStream.ts"), "utf8");
    const vendored = readFileSync(
      path.join(repoRoot, "native/vendor/shared/sentenceStream.ts"),
      "utf8",
    );
    expect(vendored).toBe(source);
  });

  it("strips markdown syntax so TTS reads prose, not punctuation soup", () => {
    expect(stripMarkdownForSpeech("**Great** work on `fractions`!")).toBe(
      "Great work on fractions!",
    );
    // A link renders as its label, not the URL.
    expect(stripMarkdownForSpeech("See [the map](https://x.test).")).toBe("See the map.");
  });
});

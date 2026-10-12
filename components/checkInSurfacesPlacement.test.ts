import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// MapCompletionCard is scholar-self-only: a guard against the specific leak
// its own doc comment warns about — rendering it in a teacher's remote view
// would silently show the TEACHER's own completion state mislabeled as the
// scholar's. No component render harness in this repo (edge-runtime vitest,
// no jsdom), so this reads the real source and asserts the boundary holds.
// ─────────────────────────────────────────────────────────────────────────

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  if (from < 0) throw new Error(`marker not found: ${start}`);
  const to = src.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`marker not found after ${start}: ${end}`);
  return src.slice(from, to);
}

const WEB_HOME = "app/scholar/page.tsx";

describe("MapCompletionCard — scholar-self only", () => {
  test("is a self-only query (mapCompletionForScholar takes no scholarId) — never mounted in remote mode", () => {
    expect(read(WEB_HOME)).not.toMatch(
      /isRemoteMode[\s\S]{0,400}<MapCompletionCard/,
    );
    const remoteBlock = between(
      read(WEB_HOME),
      '{(activeTab === "all" || isRemoteMode) && (',
      "{/* Remote view stays comprehensive",
    );
    expect(remoteBlock).not.toContain("MapCompletionCard");
    // And the component itself never accepts a scholarId prop to begin with.
    expect(read("components/practice/MapCompletionCard.tsx")).not.toMatch(
      /scholarId\s*:/,
    );
  });
});

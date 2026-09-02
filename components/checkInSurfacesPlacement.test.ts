import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// PR2 finish-the-check-in SURFACES — placement guards for the web mounts of
// the new Home CTA (Surface 1) and completion/growth reveal (Surface 4), plus
// the revived `?checkin=all` multi-domain orchestrator entry (Surface 2).
// There is no component render harness in this repo (edge-runtime vitest, no
// jsdom — see components/mapHomeCardPlacement.test.ts), so — same as that
// suite — this is a structural drift guard reading the real source and
// asserting call sites. Native's mirror lands in Phase 3.
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
const WEB_PRACTICE_PAGE = "app/scholar/practice/page.tsx";
const WEB_SUBJECT_BLOCK = "{isSubjectTab && !isRemoteMode && (";
const WEB_PREP_BLOCK = "{isPrepTab && !isRemoteMode &&";

describe("CheckInHomeCard — Surface 1 mounts above the playlist it accelerates", () => {
  test("mounts in the remote/teacher plate above the PlaylistCard it sits beside", () => {
    const remoteBlock = between(
      read(WEB_HOME),
      '{(activeTab === "all" || isRemoteMode) && (',
      "{/* A focus without a plate row",
    );
    const ctaIdx = remoteBlock.indexOf("<CheckInHomeCard");
    const playlistIdx = remoteBlock.indexOf("<PlaylistCard");
    expect(ctaIdx).toBeGreaterThan(-1);
    expect(playlistIdx).toBeGreaterThan(-1);
    expect(ctaIdx).toBeLessThan(playlistIdx);
  });

  test("mounts in the math subject tab above the playlist card, in BOTH orderings", () => {
    const subjectTab = between(read(WEB_HOME), WEB_SUBJECT_BLOCK, WEB_PREP_BLOCK);
    // Both branches of the caughtUp/actionable ordering render checkInCard
    // immediately before playlistCard. The unified Calculator License card
    // follows the playlist; its Quick-facts action is a distinct offer.
    expect(subjectTab).toMatch(
      /\{completionCard\}\s*\{treeCard\}\s*\{checkInCard\}\s*\{playlistCard\}/,
    );
    expect(subjectTab).toMatch(
      /\{completionCard\}\s*\{checkInCard\}\s*\{playlistCard\}\s*\{calculatorLicenseCard\}\s*\{treeCard\}/,
    );
  });

  test("routes to the revived multi-domain check-in, never the single-domain placement route", () => {
    expect(read(WEB_HOME)).toContain('stamp("/scholar/practice?checkin=all")');
  });

  test("never mounts inside the ALL-tab's scholar (non-remote) branch — only remote + subject tabs", () => {
    // The ALL tab covers both the remote plate AND the scholar's own "All"
    // tab (`activeTab === "all" || isRemoteMode`); CheckInHomeCard belongs
    // only to the remote sub-block, never rendered unconditionally for the
    // scholar's plain All tab (that's ScholarPlate's job).
    const allBlock = between(
      read(WEB_HOME),
      '{(activeTab === "all" || isRemoteMode) && (',
      "{/* Remote view stays comprehensive",
    );
    const remoteSub = between(allBlock, "{isRemoteMode && (", "</Stack>\n            </Stack>\n          )}");
    expect(remoteSub).toContain("<CheckInHomeCard");
  });
});

describe("MapCompletionCard — Surface 4 is the loudest rung, scholar-self only", () => {
  test("renders above BOTH the tree card and the playlist card, in every ordering", () => {
    const subjectTab = between(read(WEB_HOME), WEB_SUBJECT_BLOCK, WEB_PREP_BLOCK);
    expect(subjectTab).toMatch(
      /\{completionCard\}\s*\{treeCard\}\s*\{checkInCard\}\s*\{playlistCard\}/,
    );
    expect(subjectTab).toMatch(
      /\{completionCard\}\s*\{checkInCard\}\s*\{playlistCard\}\s*\{calculatorLicenseCard\}\s*\{treeCard\}/,
    );
  });

  test("is a self-only query (mapCompletionForScholar takes no scholarId) — never mounted in remote mode", () => {
    // A guard against the specific leak this component's own doc comment
    // warns about: rendering it in a teacher's remote view would silently
    // show the TEACHER's own completion state mislabeled as the scholar's.
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

describe("?checkin=all — the revived multi-domain check-in entry (Surface 2)", () => {
  test("checkInAllRequested reads the URL param and drives checkInAllDomains in the default (no-pin) branch", () => {
    const page = read(WEB_PRACTICE_PAGE);
    expect(page).toContain(
      'const checkInAllRequested = searchParams.get("checkin") === "all";',
    );
    expect(page).toContain("checkInAllDomains = checkInAllRequested;");
    expect(page).toContain("includeMapping = !checkInAllRequested;");
  });

  test("checkInAllDomains defaults to false — the folded Option D mapping band stays the ambient default", () => {
    expect(read(WEB_PRACTICE_PAGE)).toContain("let checkInAllDomains = false;");
  });
});

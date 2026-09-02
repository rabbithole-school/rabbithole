import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("scholar Math-plan parity wiring", () => {
  it("uses the shared scope projection on both playlist cards", () => {
    const web = read("components/practice/PlaylistCard.tsx");
    const native = read("native/src/components/practice/PracticePlaylistCard.tsx");

    for (const source of [web, native]) {
      expect(source).toContain("practiceScopeSentence");
      expect(source).toContain("scopeAllowsChoice");
    }
    // Web owns the query at Home so teacher remote mode can pass the viewed
    // scholar id; the presentational card receives that already-scoped result.
    expect(read("app/scholar/page.tsx")).toContain("api.mathPlans.myPlan");
    expect(web).toContain("mathPlan,");
    expect(native).toContain("api.mathPlans.myPlan");
  });

  it("waits for and honors an explicit Math plan over legacy standing configuration", () => {
    const web = read("app/scholar/practice/page.tsx");
    const native = read("native/src/components/practice/PracticePlaylistCard.tsx");

    for (const source of [web, native]) {
      expect(source).toContain("api.mathPlans.myPlan");
      expect(source).toContain('scopeSource === "math_plan"');
      expect(source).toContain("effectiveStanding");
    }
    expect(web).toContain("mathPlan === undefined");
    expect(native).toContain("mathPlan === undefined");
    expect(native).toContain("const switchableDomains = hasExplicitMathPlan");
  });

  it("vendors scope projection and recesses out-of-scope map territory", () => {
    expect(read("native/vendor/shared/mathPlanScope.ts")).toBe(read("shared/mathPlanScope.ts"));
    expect(read("components/map/MapTreeCanvas.tsx")).toContain("outOfScope");
    expect(read("components/map/MapTreeCanvas.tsx")).toContain('transform="rotate(-45deg)"');
    expect(read("native/src/components/tree/TreeMapNative.tsx")).toContain("scopeAllowsStrand");
  });

  it("derives the switcher from the PLAN on BOTH cards, never the retired standing row", () => {
    // The legacy `standing.domains` read meant a scholar with a multi-domain
    // Math plan and no legacy row saw no switcher at all, while a scholar whose
    // plan had NARROWED still got the removed domains offered.
    for (const path of [
      "components/practice/PlaylistCard.tsx",
      "native/src/components/practice/PracticePlaylistCard.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain("const switchableDomains = hasExplicitMathPlan");
      expect(source).toContain("planDomains");
      expect(source).not.toContain("const switchableDomains = standing?.domains");
    }
  });

  it("launches the domain the scholar PICKED on both cards", () => {
    // The header switcher only renders with ≥2 switchable domains, so deriving
    // "mixed" from the domain SET alone made every switcher-visible card mixed
    // and sent Start to the blend the scholar had just narrowed away from.
    for (const path of [
      "components/practice/PlaylistCard.tsx",
      "native/src/components/practice/PracticePlaylistCard.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain(
        "const selectedDomainSet = selectedDomain ? [selectedDomain] : domainSet;",
      );
      expect(source).toContain("const isMixed = selectedDomainSet.length > 1;");
    }
    // Web owns the selection in the page (it drives the preview queries), so it
    // must hand it BACK to the card or the card cannot honor the pick.
    expect(read("app/scholar/page.tsx")).toContain("selectedDomain={selectedDomain}");
    // A `?domain=` the CARD derived from the blend still folds the `· mapping`
    // band, so Start serves exactly the composition Home previewed. Native
    // marks the same distinction with the same flag.
    expect(read("app/scholar/practice/page.tsx")).toContain('searchParams.get("blend") === "1"');
    expect(read("native/src/lib/practiceDeepLinkParams.ts")).toContain("blend");
  });

  it("reads the SERVER's blocked flag on every scholar practice surface", () => {
    // The scope-SHAPE predicate this replaces was vacuously-true-only —
    // `validatePracticeScope` rejects a stored `strands: []`, so it never fired
    // and a scope-blocked scholar was told they were caught up instead.
    for (const path of [
      "components/practice/PlaylistCard.tsx",
      "native/src/components/practice/PracticePlaylistCard.tsx",
      "components/practice/PracticeSession.tsx",
      "native/src/app/practice.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain("blocked");
      expect(source).not.toContain("entry.strands !== undefined && entry.strands.length === 0");
    }
    // Both cards feed the flag to the shared doneness verdict…
    for (const path of [
      "components/practice/PlaylistCard.tsx",
      "native/src/components/practice/PracticePlaylistCard.tsx",
    ]) {
      expect(read(path)).toContain("const noPracticeAvailable");
    }
    // …and both session surfaces branch on it BEFORE the summit/caught-up read.
    for (const path of [
      "components/practice/PracticeSession.tsx",
      "native/src/app/practice.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain("setScopeBlocked");
      expect(source).toContain("if (scopeBlocked)");
      expect(source).toContain("PRACTICE_SCOPE_BLOCKED_HEADLINE");
    }
  });

  it("speaks the boundary with ONE shared line on every surface", () => {
    for (const path of [
      "components/practice/PlaylistCard.tsx",
      "native/src/components/practice/PracticePlaylistCard.tsx",
      "components/practice/PracticeSession.tsx",
      "native/src/app/practice.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain("PRACTICE_SCOPE_BLOCKED_HEADLINE");
      expect(source).toContain("PRACTICE_SCOPE_BLOCKED_DETAIL");
    }
    // …and the surviving caught-up / summit copy must sit BEHIND the boundary
    // branch, or a blocked scholar still gets the cheerful version.
    const webSession = read("components/practice/PracticeSession.tsx");
    expect(webSession.indexOf("if (scopeBlocked)")).toBeLessThan(
      webSession.indexOf("Nothing to practice right now"),
    );
    expect(webSession.indexOf("if (scopeBlocked)")).toBeLessThan(
      webSession.indexOf("<SummitHandoff"),
    );
    const nativeSession = read("native/src/app/practice.tsx");
    expect(nativeSession.indexOf("if (scopeBlocked)")).toBeLessThan(
      nativeSession.indexOf("<SummitHandoff"),
    );
  });

  it("narrows both domain switchers after a limited plan resolves", () => {
    for (const path of [
      "components/practice/DomainSwitcherDrawer.tsx",
      "native/src/components/practice/DomainSwitcherSheet.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain("scopeAllowsDomain");
      expect(source).toContain("availableDomains");
      expect(source).toContain("No practice is available in your current Math plan.");
    }
  });
});

// Pure normalization of the practice screen's URL/search params — the ONE place
// the native practice route's param contract is defined, so it can be unit-tested
// off-device and kept in lockstep with the web reference (app/scholar/practice/
// page.tsx). Native reads these via `useGlobalSearchParams` (see practice.tsx for
// WHY global, not local): a deep link into the practice screen mounts its
// navigator late (behind the async AuthGate), and the focus-scoped
// `useLocalSearchParams` context can settle empty on that first paint while the
// global URL still carries the query — which dropped `?domain=` on native deep
// links. Reading the global URL params (as web does with Next's useSearchParams)
// fixes that, and this helper resolves them identically to web.
import { resolvePracticeDomainSlug } from "../../vendor/shared/practiceDomainLabels";

/** The raw param bag as expo-router hands it back (a repeated query key arrives
 *  as string[], a single one as string, an absent one as undefined). */
export interface RawPracticeSearchParams {
  domain?: string | string[];
  domains?: string | string[];
  choiceDomain?: string | string[];
  choiceStrand?: string | string[];
  /** Exact knowledge-node scope from the Math Skills Tree. */
  skill?: string | string[];
  /** Web deep-link contract: `?stretch=1`. */
  stretch?: string | string[];
  /** Native in-app nav contract: `?stretchHint=1` (PracticePlaylistCard). */
  stretchHint?: string | string[];
  /**
   * Native in-app nav contract: `?blend=1`, set ONLY by the daily-playlist
   * entry points (PracticePlaylistCard). It marks "this domain was DERIVED from
   * the scholar's blend", which is the distinction web makes server-side and
   * native previously lost — see `foldsMappingBand`.
   */
  blend?: string | string[];
  /**
   * The finish-the-check-in SURFACES revival (PR2, Surfaces 1/2): `?checkin=all`
   * — CheckInHomeCard's link — requests the full multi-domain orchestrator
   * INSTEAD OF Option D's ambient `· mapping` playlist band. Mirrors web's
   * `app/scholar/practice/page.tsx` `checkInAllRequested` exactly.
   */
  checkin?: string | string[];
  quickFacts?: string | string[];
}

export interface PracticeDeepLinkParams {
  /** Resolved single-domain slug (natural aliases like "fractions" accepted), or
   *  undefined when absent/unknown — never a silent whole-number restart. */
  domain: string | undefined;
  /** Stable NUL-joined key of the raw `domains` set. Kept as a string (not an
   *  array) so callers can memoize the derived array on a value-stable key —
   *  expo-router hands back a fresh params object every render. */
  domainSetKey: string;
  /** Resolved bounded-choice domain slug ("You pick" tile), or undefined. */
  choiceDomain: string | undefined;
  choiceStrand: string | undefined;
  /** Exact knowledge-node scope from the Math Skills Tree. */
  skillKey: string | undefined;
  /** True when the stretch tail was requested via EITHER `?stretch=1` (web
   *  deep-link contract) OR `?stretchHint=1` (native in-app nav). */
  isStretch: boolean;
  /**
   * Whether this entry should fold the cross-domain `· mapping` band into the
   * served playlist (`practiceSession`'s `includeMapping`).
   *
   * Native used to pass `includeMapping: true` for EVERY non-stretch run, which
   * silently defeated `?domain=`: the server leads with the mapping band, so a
   * deep link to (say) fraction-arithmetic served whole-number mapping items and
   * looked exactly like the param had been dropped.
   *
   * Web decides this server-side in app/scholar/practice/page.tsx and folds the
   * band in for only two entries: the DEFAULT (no-pin) playlist, and a "You pick"
   * tile whose `choiceDomain` is the domain being served. A BARE `?domain=` (a
   * deep link, or the knowledge-tree's NodeSheet) is an explicit request for that
   * domain and must NOT be diluted. Native derives its blend on the CLIENT and
   * passes the result as `?domain=`, so it marks those playlist entries with
   * `?blend=1` to preserve the same distinction.
   */
  foldsMappingBand: boolean;
  /**
   * The finish-the-check-in SURFACES revival (PR2, Surfaces 1/2): true only
   * for `?checkin=all` on the true default (no-pin, no choice-tile) blend
   * entry — mirrors web's `checkInAllDomains` precedence exactly (see
   * app/scholar/practice/page.tsx's final `else` branch). When true, the
   * caller must NOT also fold the mapping band (the standalone check-in
   * REPLACES it for this entry, never stacks with it).
   */
  checkInAllDomains: boolean;
  /** Direct Quick-facts practice takes precedence over every other route hint. */
  quickFacts: boolean;
}

/** A repeated query param arrives as string[]; collapse to the first value. */
function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parse the practice route's URL params into the normalized shape the screen
 * consumes. Pure — no hooks, no device APIs — so it is unit-testable and shared
 * between the deep-link (external) and in-app (router.push) entry paths.
 */
export function parsePracticeDeepLinkParams(
  raw: RawPracticeSearchParams,
): PracticeDeepLinkParams {
  const quickFacts = firstValue(raw.quickFacts) === "1";
  if (quickFacts) {
    return {
      domain: undefined,
      domainSetKey: "",
      choiceDomain: undefined,
      choiceStrand: undefined,
      skillKey: undefined,
      isStretch: false,
      checkInAllDomains: false,
      foldsMappingBand: false,
      quickFacts: true,
    };
  }
  const domainSetKey = Array.isArray(raw.domains)
    ? raw.domains.join("\u0000")
    : (raw.domains ?? "");
  const domain = resolvePracticeDomainSlug(firstValue(raw.domain)) ?? undefined;
  const choiceDomain = resolvePracticeDomainSlug(firstValue(raw.choiceDomain)) ?? undefined;
  const isBlendEntry = firstValue(raw.blend) === "1";
  // The true default entry: the daily playlist (explicitly marked), or a bare
  // `/practice` with no domain at all — NOT a "You pick" tile (that's its own
  // branch below), and the only entry `?checkin=all` can redirect.
  const isDefaultBlendEntry = isBlendEntry || (!domain && !domainSetKey);
  const checkInAllDomains =
    isDefaultBlendEntry && !choiceDomain && firstValue(raw.checkin) === "all";
  return {
    domain,
    domainSetKey,
    choiceDomain,
    choiceStrand: firstValue(raw.choiceStrand),
    skillKey: firstValue(raw.skill)?.trim() || undefined,
    isStretch: firstValue(raw.stretch) === "1" || firstValue(raw.stretchHint) === "1",
    checkInAllDomains,
    foldsMappingBand:
      // The standalone check-in REPLACES the ambient mapping band for the
      // default entry (mirrors web: `includeMapping = !checkInAllRequested`).
      !checkInAllDomains &&
      (isDefaultBlendEntry ||
        // A "You pick" tile serving the picked domain (web: choiceDomain ===
        // resolvedDomain, or a pick outside the started set).
        (!!choiceDomain && choiceDomain === domain)),
    quickFacts: false,
  };
}

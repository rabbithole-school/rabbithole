// A scholar conversation's FLAVOR, and its old name. One table for the server
// (convex/lib/scholarThreadAccess.ts), the web, and the iPad (vendored by
// native/scripts/sync-vendor.js).
//
// A conversation is either "family" (a scholar's guardians and staff) or
// "scholar" (one scholar and adults). A scholar conversation is "general"
// (with the adults named on it), "workshop" (with the Rabbithole team) or
// "about" (about one Quest or wonder).
//
// Until the narrow, rows and API responses still carry the old names in
// `kind` ("mentor" for general), because iPad builds that predate `flavor`
// read them. New code reads `flavor` (through `flavorOf` on a client).

export type ScholarThreadFlavor = "general" | "workshop" | "about";
export type LegacyScholarThreadKind = "mentor" | "workshop" | "about";

const LEGACY_FLAVOR: Record<LegacyScholarThreadKind, ScholarThreadFlavor> = {
  mentor: "general",
  workshop: "workshop",
  about: "about",
};
const FLAVOR_LEGACY_KIND: Record<ScholarThreadFlavor, LegacyScholarThreadKind> = {
  general: "mentor",
  workshop: "workshop",
  about: "about",
};

export function flavorFromLegacyKind(kind: LegacyScholarThreadKind): ScholarThreadFlavor {
  return LEGACY_FLAVOR[kind];
}

export function legacyKindForFlavor(flavor: ScholarThreadFlavor): LegacyScholarThreadKind {
  return FLAVOR_LEGACY_KIND[flavor];
}

/** A thread row from the API: its `flavor`, or — from a backend that
 *  predates it — the flavor its old `kind` names. */
export function flavorOf(thread: {
  flavor?: ScholarThreadFlavor;
  kind: LegacyScholarThreadKind;
}): ScholarThreadFlavor {
  return thread.flavor ?? LEGACY_FLAVOR[thread.kind];
}

/**
 * The catalog kinds with a first-class native renderer — the pure routing table
 * behind `NativeManipulative`. Kept in its own React-free module so it can be
 * unit-tested (and imported by a host's routing logic) without pulling in the
 * react-native-svg / gesture-handler renderer graph.
 *
 * `ManipulativeKind` is the vendored spec union (a read-only copy of
 * lib/manipulative/types synced by native/scripts/sync-vendor.js), so this list
 * is measured against the exact catalog the web + server use.
 */
import type { ManipulativeKind } from "../../../vendor/manipulative/types";

/**
 * Every catalog kind that renders INLINE natively. A new `ManipulativeKind`
 * must land in EITHER this list (with a renderer + switch case in
 * NativeManipulative) OR `WEBVIEW_ONLY_MANIPULATIVE_KINDS` below, or the
 * compile-time totality assertion fails the build. A host routes anything NOT
 * in this list to the web `/embed/manipulative` WebView fallback.
 */
export const NATIVE_MANIPULATIVE_KINDS = [
  "partition",
  "numberline",
  "array",
  "balance",
  "areaPerimeter",
  "distribute",
  "rekenrek",
  "distributor",
  "riemann",
  "functionMachine",
  "placeValue",
  "dice",
  "protractor",
  "coordinatePlane",
  "ruler",
  "clock",
  "liquid",
  "money",
] as const satisfies readonly ManipulativeKind[];

/**
 * Kinds deliberately served through the web `/embed/manipulative` WebView with
 * NO native inline renderer — a designed choice, not a catalog gap. `geoLocate`
 * (a Mapbox geography item) has no @rnmapbox native renderer yet, so it routes
 * to the same WebView fallback any unsupported kind does. Listing it here keeps
 * the totality assertion below a real guard: every `ManipulativeKind` must be
 * EITHER native-inline OR explicitly webview-only.
 */
export const WEBVIEW_ONLY_MANIPULATIVE_KINDS = [
  "geoLocate",
] as const satisfies readonly ManipulativeKind[];

// Compile-time guarantee that every kind is accounted for: if a new
// `ManipulativeKind` is added without landing in one of the two lists above,
// this resolves to `never` and the assignment fails to typecheck.
type UncoveredKind = Exclude<
  ManipulativeKind,
  (typeof NATIVE_MANIPULATIVE_KINDS)[number] | (typeof WEBVIEW_ONLY_MANIPULATIVE_KINDS)[number]
>;
const _assertNativeKindsTotal: UncoveredKind extends never ? true : never = true;
void _assertNativeKindsTotal;

/**
 * True when `kind` has a native renderer (so a host can render it INLINE). A
 * kind outside the current catalog — a future/unknown or malformed spec kind —
 * returns false and routes to the WebView fallback.
 */
export function isNativeManipulativeKind(kind: string): kind is ManipulativeKind {
  return (NATIVE_MANIPULATIVE_KINDS as readonly string[]).includes(kind);
}

/**
 * Empty route-segment fallback (intentionally renders nothing).
 *
 * This tab's surface — and ALL of its loading UI — lives in the sibling
 * `layout.tsx`, a client component that renders its own scoped skeletons
 * (`ScholarRailSkeleton`, spinners) from its own Convex query state. The
 * `page.tsx` is a null stub, and the layout mounts `{children}` as an ABSOLUTE,
 * full-bleed overlay (`position:absolute; inset:0`). So a full-surface skeleton
 * here would paint *on top of* the layout's real content whenever the layout's
 * queries are already warm (common since the nav-prefetch warming landed in
 * #330) — the "skeleton overlaid on real data" bug.
 *
 * Returning null keeps the Suspense boundary HERE (so a suspending stub-page
 * RSC fetch stays caught locally instead of bubbling up to the dashboard's
 * GenericBodySkeleton) while showing nothing — the layout's own skeletons are
 * the single source of truth for this tab's loading UI.
 */
export default function Loading() {
  return null;
}

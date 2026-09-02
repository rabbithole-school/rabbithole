/**
 * Thin re-export barrel — the pure Workbench display/scoring helpers now
 * live in `lib/simulator/helpers.ts` (the single home shared with native, which
 * vendors it as `native/vendor/simulator/helpers.ts`). Keep this file so every
 * existing `./helpers` import in `components/workbench/` keeps resolving.
 */
export * from "@/lib/simulator/helpers";

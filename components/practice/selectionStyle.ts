/**
 * selectableSurface — the ONE selection treatment shared by every selectable
 * "cell / list item" in the Math Skills studio: the cohort-matrix cells, the
 * domain-rail rows, and the column-avatar header. A THIN 1px violet ring on a
 * light violet wash, rounded — kept in a single place so the surfaces never
 * drift to different border weights (a 2px ring here, a 1px there).
 *
 * The unselected state keeps a `transparent` 1px border so selecting an item
 * never nudges layout (Chakra is border-box): the ring appears in place, it
 * does not push its neighbours.
 *
 * Spread it onto the selectable element, then add whatever `_hover` the surface
 * wants (density differs — a dense matrix cell vs. a rail row):
 *
 *   <Box {...selectableSurface(selected)} _hover={{ bg: selected ? "violet.50" : "gray.50" }} />
 *
 * Interactivity is a SEPARATE concern — spread `interactiveSurface` for that,
 * because some selection rings wrap a surface whose click target is a child.
 */
export function selectableSurface(selected: boolean) {
  return {
    borderRadius: "md",
    borderWidth: "1px",
    borderColor: selected ? "violet.300" : "transparent",
    bg: selected ? "violet.50" : "transparent",
  } as const;
}

/**
 * interactiveSurface — the pointer cursor for a hand-rolled click target
 * (`<Box as="button">`, a clickable header or matrix cell). Chakra's `Button`
 * recipe already carries `cursor: "button"`, but a bare `as="button"` inherits
 * the UA default (`cursor: default`), so every grid cell and column heading in
 * the Math Skills matrices has to state it. Kept next to `selectableSurface`
 * so "this thing is selectable" and "this thing is clickable" stay one import.
 *
 * Only spread it on something that actually responds to a click — an inert
 * label under a hover wash must keep the default arrow.
 */
export const interactiveSurface = { cursor: "pointer" } as const;

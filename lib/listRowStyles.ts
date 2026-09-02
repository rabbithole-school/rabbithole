/**
 * Shared visual treatment for "selected row in a primary nav list" —
 * the chat-history sidebar, the curriculum unit sidebar, the unit
 * designer's session list, etc. Lets each surface keep its bespoke
 * row structure (some have pin icons, some have menus, some have
 * status pips) while sharing the same selected/hover/idle look.
 *
 * Returns Chakra style props you spread onto the row's outer
 * Box/Flex. Pair with `selectedListRowLabelColor()` for the title
 * text color when you want it to also shift on selection.
 *
 * Canonical look (borderless, reconciled June 2026):
 *   - selected: violet.50 background + a violet.700 label (see
 *     selectedListRowLabelColor) — NO border. The tint is faint on its
 *     own, so the label color is what carries the "selected" read.
 *   - idle:     transparent background, hover swaps to gray.100
 *
 * A transparent 1px border is still reserved on both states so the row
 * height never jumps; the border is just never colored. The same
 * borderless look is mirrored by `<HierarchyRow>` and the outline's
 * NodeRow so every list in the app reads identically.
 *
 * Surfaces that should NOT use this:
 *   - Button-like option cards (KindToggle radio cards, DimensionPicker
 *     option tiles, ProcessPicker chips) — those are toggles, not list
 *     items, and have their own affordance vocabulary.
 */
export function selectedListRowProps(selected: boolean) {
  return {
    bg: selected ? "violet.50" : "transparent",
    borderWidth: "1px" as const,
    borderColor: "transparent",
    borderStyle: "solid" as const,
    transition: "background 0.12s, border-color 0.12s",
    _hover: {
      bg: selected ? "violet.50" : "gray.100",
    },
  };
}

/** Title-color companion. Use on the row's primary label Text. */
export function selectedListRowLabelColor(selected: boolean): string {
  return selected ? "violet.700" : "navy.500";
}

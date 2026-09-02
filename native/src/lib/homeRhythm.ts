/**
 * The scholar Home's vertical rhythm — THREE numbers, shared by the Home
 * screen and every section that renders into it.
 *
 * The rule: vertical space between two blocks is spent as `gap` on the stack
 * that OWNS them — never as a margin on one of the blocks. Nearly every Home
 * card self-gates to `null` on its own data, so a card's own margin is spacing
 * that exists only when that card does; that is how the Home ended up with
 * eight different hand-tuned margins (16/32 on the map reveal, 14 on the
 * playlist, 12 on the recap, 4/4/16 across the quest footer…) and gaps that
 * read fine in one data state and wrong in the next. A gap belongs to the
 * *relationship*, and a child that renders `null` takes its gap with it.
 *
 * Two corollaries, which are the easy things to get wrong:
 *
 * 1. Never wrap a self-gating card in an always-rendered <View> inside a gap
 *    stack. An empty wrapper is still a flex child, so it emits a phantom gap.
 *    Pass the card itself as a direct child and let it collapse.
 *
 * 2. Where there is genuinely no shared parent to hang a gap on — a
 *    SectionList cell, or a stack whose every child can collapse — the block
 *    owns its LEADING gap as `paddingTop`, and nothing owns a trailing one.
 *    Leading-only still collapses correctly: no block, no space.
 */

/** Sibling cards / blocks. */
export const HOME_GAP = 14;

/** An eyebrow label → the cards it introduces. */
export const HOME_LABEL_GAP = 10;

/** A new labeled section → the block above it. */
export const HOME_SECTION_GAP = 24;

/**
 * What a section adds ON TOP of the stack's own gap.
 *
 * A labeled section that lives inside a HOME_GAP stack already inherits
 * HOME_GAP from its previous sibling, so it only has to top that up to
 * HOME_SECTION_GAP. Derived, never typed as a literal — the two numbers above
 * are the only ones anyone should ever tune. See <HomeSection>, which is the
 * single component that spends it.
 */
export const HOME_SECTION_TOPUP = HOME_SECTION_GAP - HOME_GAP;

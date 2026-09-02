"use client";

/**
 * Body-shaped loading skeletons for the Math Skills > Content right pane. Same
 * doctrine as components/skeletons/PanelSkeletons.tsx: a pane whose eventual
 * SHAPE is known loads into a skeleton of that shape — never a lone centered
 * spinner that then pops/reflows content (Andy: browsing skill→skill must not
 * jump). Each skeleton mirrors the REAL component's wrappers + px so the
 * settled content lands in place:
 *   - Questions  → NodeItemPool mode="questions" (Written facet: template-drill
 *     block + stored header + one row)
 *   - Mixed      → NodeItemPool mode="all" (All facet: template-drill block +
 *     stored header + a written row + a hands-on row)
 *   - Manipulatives → NodeItemPool mode="manipulatives" (Hands-on facet: header
 *     + one item card)
 *   - Stories    → NodeStoryFamily (section header + story cards)
 *   - Instruction → InstructionLaunchpadDetailPane (heading + segment card + atom cards)
 *   - Worktable  → PracticeItemInventoryTable / StoryInventoryTable (a `size="sm"` table)
 *
 * Body-only (the pane provides the Surface + padding), plain Chakra `Skeleton`
 * with house defaults (no shimmer circus), and `aria-hidden` throughout.
 */

import { Box, Flex, Skeleton, Table } from "@chakra-ui/react";

/** An Eyebrow label placeholder (uppercase section heading, ~11px, mb=2). */
function EyebrowSkeleton({ w = "132px" }: { w?: string }) {
  return <Skeleton height="11px" w={w} borderRadius="sm" mb={2} />;
}

/** A pill/button placeholder (size="xs" control, ~28px). */
function ButtonSkeleton({ w = "104px" }: { w?: string }) {
  return <Skeleton height="28px" w={w} borderRadius="md" flexShrink={0} />;
}

/** One stored-item card — mirrors NodeItemPool's `ItemRow` (borderWidth 1px
 *  gray.200, borderRadius 10px, p=2.5): a stem line + a badge sub-row. */
function ItemRowSkeleton() {
  return (
    <Flex
      gap={2}
      align="flex-start"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="12px"
      p={2.5}
      aria-hidden
    >
      <Box flex={1} minW={0}>
        <Skeleton height="14px" w="82%" borderRadius="sm" mb={2} />
        <Flex gap={2} align="center">
          <Skeleton height="16px" w="72px" borderRadius="full" />
          <Skeleton height="12px" w="120px" borderRadius="sm" />
        </Flex>
      </Box>
      <Skeleton height="20px" w="20px" borderRadius="md" flexShrink={0} />
      <Skeleton height="20px" w="20px" borderRadius="md" flexShrink={0} />
    </Flex>
  );
}

/**
 * The skill-pane HEADER sub-row (grade · strand text + standard-code badges),
 * which only mounts once `poolForNode` resolves — so its absence collapses the
 * header. Render this in its place while the pool loads, so the header keeps its
 * height. The title line above is driven by `summary` (already present), so only
 * this sub-row needs a placeholder.
 */
export function SkillPaneHeaderSkeleton() {
  return (
    // 20px rows: the real meta line is a 20px-tall xs Text + size="sm" badges
    // (both measured live at 20px) — 18px placeholders shifted the whole pane
    // 2px on every skill switch.
    <Flex gap={2} mt={1} align="center" wrap="wrap" aria-hidden>
      <Skeleton height="20px" w="180px" borderRadius="sm" />
      <Skeleton height="20px" w="56px" borderRadius="sm" />
      <Skeleton height="20px" w="64px" borderRadius="sm" />
    </Flex>
  );
}

/**
 * Questions tab — mirrors NodeItemPool mode="questions": the template-drill block
 * (eyebrow + description + ~5 sample rows in the tinted gray.50 boxes) then the
 * stored-questions header (eyebrow + Add / Generate buttons) and one item row.
 */
export function QuestionsTabSkeleton() {
  return (
    <Box data-testid="questions-tab-skeleton" aria-hidden>
      {/* Template source */}
      <Box mb={4}>
        <EyebrowSkeleton w="96px" />
        <Skeleton height="11px" w="94%" borderRadius="sm" mb={1} />
        <Skeleton height="11px" w="78%" borderRadius="sm" mb={2} />
        <Flex direction="column" gap={1}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Flex
              key={i}
              gap={2}
              align="baseline"
              px={2.5}
              py={1.5}
              bg="gray.50"
              borderRadius="8px"
            >
              <Skeleton height="14px" flex={1} borderRadius="sm" />
              <Skeleton height="12px" w="40px" borderRadius="sm" flexShrink={0} />
            </Flex>
          ))}
        </Flex>
      </Box>
      {/* Stored items */}
      <Box mb={4}>
        <Flex align="center" justify="space-between" mb={2}>
          <EyebrowSkeleton w="148px" />
          <Flex gap={1}>
            <ButtonSkeleton w="104px" />
            <ButtonSkeleton w="132px" />
          </Flex>
        </Flex>
        <Flex direction="column" gap={2}>
          <ItemRowSkeleton />
        </Flex>
      </Box>
    </Box>
  );
}

/**
 * Manipulatives tab — mirrors NodeItemPool mode="manipulatives": the stored
 * header (eyebrow + Add manipulative) and one item card.
 */
export function ManipulativesTabSkeleton() {
  return (
    <Box data-testid="manipulatives-tab-skeleton" aria-hidden>
      <Box mb={4}>
        <Flex align="center" justify="space-between" mb={2}>
          <EyebrowSkeleton w="128px" />
          <ButtonSkeleton w="132px" />
        </Flex>
        <Flex direction="column" gap={2}>
          <ItemRowSkeleton />
        </Flex>
      </Box>
    </Box>
  );
}

/**
 * Mixed (All facet) tab — mirrors NodeItemPool mode="all": the SAME template-
 * drill block the Written facet shows (a code-templated skill still previews its
 * template) then the stored header (eyebrow + Add / Generate) and two item rows
 * — one written, one hands-on — because the All facet renders the whole pool.
 * This is the honest loading shape for `mode="all"`, which used to borrow the
 * Written skeleton and under-report the mixed pool.
 */
export function MixedTabSkeleton() {
  return (
    <Box data-testid="mixed-tab-skeleton" aria-hidden>
      {/* Template source (present when the skill is code-templated) */}
      <Box mb={4}>
        <EyebrowSkeleton w="96px" />
        <Skeleton height="11px" w="94%" borderRadius="sm" mb={1} />
        <Skeleton height="11px" w="78%" borderRadius="sm" mb={2} />
        <Flex direction="column" gap={1}>
          {[0, 1, 2].map((i) => (
            <Flex
              key={i}
              gap={2}
              align="baseline"
              px={2.5}
              py={1.5}
              bg="gray.50"
              borderRadius="8px"
            >
              <Skeleton height="14px" flex={1} borderRadius="sm" />
              <Skeleton height="12px" w="40px" borderRadius="sm" flexShrink={0} />
            </Flex>
          ))}
        </Flex>
      </Box>
      {/* Stored items — both formats */}
      <Box mb={4}>
        <Flex align="center" justify="space-between" mb={2}>
          <EyebrowSkeleton w="164px" />
          <Flex gap={1}>
            <ButtonSkeleton w="88px" />
            <ButtonSkeleton w="132px" />
          </Flex>
        </Flex>
        <Flex direction="column" gap={2}>
          <ItemRowSkeleton />
          <ItemRowSkeleton />
        </Flex>
      </Box>
    </Box>
  );
}

/**
 * Stories tab — mirrors NodeStoryFamily: the mt={5} section header (uppercase
 * label + Add story) and two story cards (Box borderRadius 12px, bg gray.50,
 * p=4: a badge/related-pill row + hook text lines).
 */
export function StoriesTabSkeleton() {
  return (
    <Box mt={5} data-testid="stories-tab-skeleton" aria-hidden>
      <Flex align="center" justify="space-between" gap={2} mb={3}>
        <Skeleton height="10px" w="240px" borderRadius="sm" />
        <ButtonSkeleton w="96px" />
      </Flex>
      <Flex direction="column" gap={3}>
        {[0, 1].map((i) => (
          <Box key={i} borderRadius="12px" bg="gray.50" p={4}>
            <Flex justify="space-between" align="flex-start" gap={2} mb={2}>
              <Flex gap={1.5} align="center">
                <Skeleton height="18px" w="120px" borderRadius="full" />
                <Skeleton height="16px" w="64px" borderRadius="full" />
              </Flex>
            </Flex>
            <Skeleton height="13px" w="92%" borderRadius="sm" mb={1.5} />
            <Skeleton height="13px" w="68%" borderRadius="sm" />
          </Box>
        ))}
      </Flex>
    </Box>
  );
}

/** One instruction atom card — mirrors InstructionAtomCard (borderWidth 1px,
 *  borderRadius 11px, p=4): a kind badge + a few text lines. */
function AtomCardSkeleton() {
  return (
    <Box borderWidth="1px" borderColor="charcoal.200" borderRadius="12px" bg="white" p={4}>
      <Skeleton height="18px" w="104px" borderRadius="full" mb={2} />
      <Skeleton height="13px" w="88%" borderRadius="sm" mb={1.5} />
      <Skeleton height="13px" w="72%" borderRadius="sm" />
    </Box>
  );
}

/**
 * Instruction segment BODY — mirrors the resolved part of
 * InstructionLaunchpadDetailPane (the segment card: title + subtitle + Rehearse,
 * the atom-kind badge row, and 2-3 atom cards). Body-only: every caller already
 * renders a heading/caption above it (the pane's own header, or the worktable's
 * "Instructional segments in …" heading), so the loading branch swaps only the
 * body and the header never flickers.
 */
export function InstructionSegmentBodySkeleton() {
  return (
    <Flex direction="column" gap={3} data-testid="instruction-body-skeleton" aria-hidden>
      <Flex align="flex-start" justify="space-between" gap={3}>
        <Box minW={0} flex={1}>
          <Skeleton height="22px" w="60%" borderRadius="md" mb={1.5} />
          <Skeleton height="13px" w="82%" borderRadius="sm" />
        </Box>
        <ButtonSkeleton w="92px" />
      </Flex>
      <Flex gap={2} wrap="wrap">
        <Skeleton height="18px" w="88px" borderRadius="full" />
        <Skeleton height="18px" w="72px" borderRadius="full" />
        <Skeleton height="18px" w="64px" borderRadius="full" />
      </Flex>
      <AtomCardSkeleton />
      <AtomCardSkeleton />
    </Flex>
  );
}

/**
 * A no-skill worktable table — mirrors PracticeItemInventoryTable /
 * StoryInventoryTable (`Table.Root size="sm"` with a header + rows). `columns`
 * matches the real table (4 for the item inventories, 3 for stories).
 */
export function InventoryTableSkeleton({
  columns = 4,
  rows = 6,
  heading,
}: {
  columns?: number;
  rows?: number;
  /** An optional worktable heading + description above the table (the no-skill
   *  worktables render one). */
  heading?: boolean;
}) {
  const widths = ["68%", "52%", "60%", "44%", "72%", "50%"];
  return (
    <Box data-testid="inventory-table-skeleton" aria-hidden>
      {heading && (
        <>
          <Skeleton height="14px" w="240px" borderRadius="sm" mb={1.5} />
          <Skeleton height="11px" w="60%" borderRadius="sm" mb={3} />
        </>
      )}
      <Box overflowX="auto">
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              {Array.from({ length: columns }).map((_, c) => (
                <Table.ColumnHeader key={c}>
                  <Skeleton height="11px" w="56px" borderRadius="sm" />
                </Table.ColumnHeader>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {Array.from({ length: rows }).map((_, r) => (
              <Table.Row key={r}>
                {Array.from({ length: columns }).map((_, c) => (
                  <Table.Cell key={c}>
                    <Skeleton
                      height="12px"
                      borderRadius="sm"
                      w={widths[(r + c) % widths.length]}
                    />
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </Box>
  );
}

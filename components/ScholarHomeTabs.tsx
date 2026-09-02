"use client";

/**
 * ScholarHomeTabs — the pill row for the scholar Home:
 * Now · All · <subjects> · Other · Scholar’s Prep · Quests.
 * Wraps ViewToggle (the canonical segmented-pill idiom) with the tab types from
 * shared/scholarHomeNow.
 *
 * Visual invariants (.claude/rules/visual-design.md):
 *   - Even borders (pill container bg, no accent stripe)
 *   - No text below `sm` on the tab labels
 *   - One-line, scrolls horizontally when the subject list is long
 */

import { Box } from "@chakra-ui/react";
import { ViewToggle } from "@/components/ui/ViewToggle";
import type { ScholarHomeTab } from "@/shared/scholarHomeNow";

export function ScholarHomeTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: ScholarHomeTab[];
  activeTab: string;
  onChange: (tab: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    // Overflow scroll for wide subject lists; hide the scrollbar visually.
    // fit-content (capped at the old breakout width) so the VISIBLE pill row
    // is what gets centered — a fixed 880px box with left-flushed pills read
    // as the whole bar sitting ~160px left of the page column.
    <Box
      w="fit-content"
      maxW={{ base: "100%", md: "min(880px, calc(100vw - 48px))" }}
      position="relative"
      left="50%"
      transform="translateX(-50%)"
      overflowX="auto"
      css={{ "&::-webkit-scrollbar": { display: "none" }, scrollbarWidth: "none" }}
    >
      <ViewToggle
        items={tabs.map((t) => ({ value: t.key, label: t.label }))}
        value={activeTab}
        onChange={onChange}
        ariaLabel="Home view"
      />
    </Box>
  );
}

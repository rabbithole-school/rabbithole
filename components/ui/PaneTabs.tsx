"use client";

/**
 * PaneTabs — the one canonical L1 (in-surface content tabs) control.
 *
 * This is the LOUD level of the two-tier navigation: the subtle-gray pill
 * `Tabs` established by PR #278 (ScholarProfile's Feed/Map/Dossier row,
 * a report's section row, an assignment's Outline/Roster row). It exists
 * so surfaces stop re-deriving the recipe by hand and drifting apart
 * (line/sm here, subtle/lg there, a solid-violet ButtonGroup somewhere
 * else). The quieter L2 sub-navigation *inside* one of these tabs is the
 * separate {@link ./SubNav} control (violet.50 tint); lens/view toggles are
 * enclosed `Tabs`. L1 → L2 should read as a clear hierarchy, not two
 * equally-loud bars.
 *
 * The codified recipe: `Tabs.Root variant="subtle" fitted={false} size="md"`,
 * each trigger `fontFamily="heading" fontSize="xs" px={4} py={3}
 * color="charcoal.400"`, with an optional leading icon (~14px, 6px gap) and
 * an optional trailing count/status node.
 *
 *   <PaneTabs
 *     items={[{ value: "feed", label: "Feed", icon: <House size={14} /> }, …]}
 *     value={tab}
 *     onChange={setTab}
 *   />
 *
 * Controlled (pass `value` + `onChange`) or uncontrolled (pass
 * `defaultValue`). Pass `Tabs.Content` as `children` when the surface uses
 * Ark's content panels (they read the `Tabs.Root` context this renders);
 * surfaces that render their own body from `value` just omit children.
 */
import { Box, Flex, Tabs } from "@chakra-ui/react";

export interface PaneTabItem<T extends string = string> {
  value: T;
  label: string;
  /** Optional leading icon node (~14px), rendered before the label. */
  icon?: React.ReactNode;
  /** Optional trailing node (a count/status pill), rendered after the label. */
  trailing?: React.ReactNode;
}

export interface PaneTabsProps<T extends string = string> {
  items: PaneTabItem<T>[];
  /** Controlled selected value. Omit and pass `defaultValue` for uncontrolled. */
  value?: T;
  /** Uncontrolled initial value. */
  defaultValue?: T;
  onChange?: (value: T) => void;
  /** Horizontal padding on the tab list (e.g. 5 to match a surface's gutter). */
  px?: number;
  /** Bottom margin below the list (defaults to 0; parent stack usually owns spacing). */
  mb?: number;
  /** Right-aligned slot rendered on the same row as the tabs. */
  rightSlot?: React.ReactNode;
  /** `Tabs.Content` panels rendered inside `Tabs.Root`, below the list. */
  children?: React.ReactNode;
  /**
   * Delay mounting each panel until it is first activated (Ark `lazyMount`).
   * Panels stay mounted afterwards — pair with the default `unmountOnExit`
   * (false) to preserve an inactive panel's scroll/editor state, the Math
   * Skills "lost-place" fix.
   */
  lazyMount?: boolean;
  /** Unmount a panel when it deactivates (Ark `unmountOnExit`). Defaults to
   *  Ark's default (false = keep mounted). */
  unmountOnExit?: boolean;
  /** Pin the tab list to the top of the nearest scroll container
   *  (`position: sticky`), so it stays reachable while a long panel scrolls. */
  sticky?: boolean;
}

export function PaneTabs<T extends string = string>({
  items,
  value,
  defaultValue,
  onChange,
  px,
  mb = 0,
  rightSlot,
  children,
  lazyMount,
  unmountOnExit,
  sticky,
}: PaneTabsProps<T>) {
  const rootProps =
    value !== undefined ? { value } : { defaultValue };

  // `minW={0}` + `overflowX="auto"` let this list shrink and scroll
  // internally instead of running past its container: a narrow ancestor
  // (e.g. the scholar-detail panel next to the roster rail) otherwise clips
  // trailing tabs mid-word with no ellipsis and no way to reach them — this
  // makes the full label set reachable via a native horizontal scroll
  // instead of a new compact-menu chooser. `w="full"` matters too: Chakra's
  // Tabs.List is `display: inline-flex`, which shrink-to-fits its content's
  // natural width instead of being capped by its parent — without it the
  // list just grows past the parent (and the viewport) instead of
  // triggering its own overflow-x scroll.
  const stickyProps = sticky
    ? ({
        position: "sticky" as const,
        top: 0,
        zIndex: 1,
        bg: "white",
      })
    : {};
  const list = (
    <Tabs.List
      px={px}
      gap={0}
      mb={rightSlot ? 0 : mb}
      w="full"
      minW={0}
      overflowX="auto"
      {...stickyProps}
    >
      {items.map((item) => (
        <Tabs.Trigger
          key={item.value}
          value={item.value}
          flexShrink={0}
          whiteSpace="nowrap"
          fontFamily="heading"
          fontSize="xs"
          px={4}
          py={3}
          color="charcoal.400"
        >
          {item.icon && (
            <Box as="span" display="inline-flex" alignItems="center" mr={1.5} flexShrink={0}>
              {item.icon}
            </Box>
          )}
          {item.label}
          {item.trailing && (
            <Box as="span" display="inline-flex" alignItems="center" ml={1.5} flexShrink={0}>
              {item.trailing}
            </Box>
          )}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );

  return (
    <Tabs.Root
      {...rootProps}
      onValueChange={onChange ? (e) => onChange(e.value as T) : undefined}
      variant="subtle"
      fitted={false}
      size="md"
      lazyMount={lazyMount}
      unmountOnExit={unmountOnExit}
    >
      {rightSlot ? (
        <Flex align="center" justify="space-between" gap={3} mb={mb} minW={0}>
          {list}
          <Box flexShrink={0} pr={px}>
            {rightSlot}
          </Box>
        </Flex>
      ) : (
        list
      )}
      {children}
    </Tabs.Root>
  );
}

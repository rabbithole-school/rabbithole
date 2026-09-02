"use client";

/**
 * ViewToggle — the one canonical LENS/VIEW switcher: a rounded segmented
 * control that flips between alternate *views of the same content* (e.g.
 * Assignments' Agenda ⇄ List, Messages' All ⇄ Mine, Reports' Course
 * narratives ⇄ Whole Child).
 *
 * It is distinct from the app's other two segmented controls:
 *  - {@link ./PaneTabs} is L1 — the loud content tabs that swap *which pane*
 *    you're looking at.
 *  - {@link ./SubNav} is L2 — the quiet sub-navigation *inside* one pane.
 *  - ViewToggle is neither: the content is unchanged, only the *lens* over it
 *    changes, so it's a compact rounded pill track rather than a tab bar.
 *
 *   <ViewToggle
 *     items={[{ value: "agenda", label: "Agenda", icon: <CalendarBlank size={14} /> }, …]}
 *     value={view}
 *     onChange={setView}
 *   />
 *
 * Link-mode: pass `hrefFor` and each segment renders as a real `<a href>` (so
 * cmd/middle-click opens a new tab, right-click copies the link). Plain
 * left-clicks are intercepted (preventDefault) and delegated to `onChange`, so
 * the caller owns the soft-nav — the same idiom as {@link ../TeacherNavTabs}.
 */
import { Box, HStack, chakra } from "@chakra-ui/react";

export interface ViewToggleItem<T extends string = string> {
  value: T;
  label: string;
  /** Optional leading icon node (~14px), rendered before the label. */
  icon?: React.ReactNode;
}

export interface ViewToggleProps<T extends string = string> {
  items: ViewToggleItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Optional href builder — enables link-mode: each segment becomes a real
   *  `<a>`. Plain left-clicks still call `onChange` (preventDefault); modified
   *  clicks fall through to the href so the browser opens a new tab. */
  hrefFor?: (value: T) => string;
  /** Accessible label for the group. */
  ariaLabel?: string;
  /** data-testid for Playwright hooks. */
  testId?: string;
}

function isModifiedClick(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

export function ViewToggle<T extends string = string>({
  items,
  value,
  onChange,
  hrefFor,
  ariaLabel,
  testId,
}: ViewToggleProps<T>) {
  return (
    <HStack
      gap={1}
      p={1}
      bg="gray.100"
      borderRadius="full"
      display="inline-flex"
      flexShrink={0}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {items.map((item) => {
        const active = item.value === value;
        const style = {
          px: item.icon ? 4 : 3.5,
          py: 1,
          borderRadius: "full",
          fontFamily: "heading",
          fontSize: "sm",
          fontWeight: "600",
          bg: active ? "white" : "transparent",
          shadow: active ? "sm" : "none",
          color: active ? "violet.700" : "charcoal.500",
          cursor: "pointer",
          userSelect: "none",
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
          gap: "6px",
          whiteSpace: "nowrap",
          textDecoration: "none",
          _hover: active ? undefined : { color: "charcoal.700" },
        } as const;
        const inner = (
          <>
            {item.icon && (
              <Box
                as="span"
                display="inline-flex"
                alignItems="center"
                flexShrink={0}
                lineHeight="0"
              >
                {item.icon}
              </Box>
            )}
            {item.label}
          </>
        );
        if (hrefFor) {
          return (
            <chakra.a
              key={item.value}
              href={hrefFor(item.value)}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                // Let the browser handle modified clicks (open in new tab, etc.);
                // soft-navigate plain left-clicks via the caller's onChange.
                if (isModifiedClick(e)) return;
                e.preventDefault();
                onChange(item.value);
              }}
              {...style}
            >
              {inner}
            </chakra.a>
          );
        }
        return (
          <Box
            key={item.value}
            as="button"
            onClick={() => onChange(item.value)}
            aria-pressed={active}
            {...style}
          >
            {inner}
          </Box>
        );
      })}
    </HStack>
  );
}

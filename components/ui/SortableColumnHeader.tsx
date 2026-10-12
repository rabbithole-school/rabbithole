"use client";

/**
 * SortableColumnHeader — the one sortable table-header control: a header cell
 * carrying `aria-sort`, holding a button whose label names the column and
 * whose caret shows the direction. Pair it with `lib/tableSort.ts`
 * (`sortRows`, `nextSort`) for the ordering itself.
 *
 *   <SortableColumnHeader label="Due" dir={sort.key === "due" ? sort.dir : null}
 *     onToggle={() => setSort(nextSort(sort, "due"))} cell="th" />
 *
 * `cell="th"` renders a Chakra `Table.ColumnHeader`; the default renders a
 * `role="columnheader"` box for div-based tables. An inactive column
 * (`dir={null}`) shows a muted up/down caret and `aria-sort="none"`.
 */
import { Box, Button, Table, type ButtonProps } from "@chakra-ui/react";
import { CaretDown, CaretUp, CaretUpDown } from "@phosphor-icons/react";
import type { SortDir } from "@/lib/tableSort";

export interface SortableColumnHeaderProps {
  label: string;
  /** This column's direction, or null when another column (or none) sorts. */
  dir: SortDir | null;
  onToggle: () => void;
  /** Screen-reader label; defaults to "Sort by {label}". */
  ariaLabel?: string;
  /** "th" inside a Chakra Table; "box" (default) for a div-based table. */
  cell?: "box" | "th";
  testId?: string;
  /** Visual overrides for the button (font size, colour). */
  buttonProps?: Omit<ButtonProps, "onClick" | "children">;
  /** Props for the header cell (padding, width). */
  cellProps?: Record<string, unknown>;
}

export function SortableColumnHeader({
  label,
  dir,
  onToggle,
  ariaLabel,
  cell = "box",
  testId,
  buttonProps,
  cellProps,
}: SortableColumnHeaderProps) {
  const ariaSort = dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none";
  const button = (
    <Button
      variant="ghost"
      size="sm"
      px={0}
      minW="auto"
      h="auto"
      gap={1}
      onClick={onToggle}
      aria-label={ariaLabel ?? `Sort by ${label.toLowerCase()}`}
      data-testid={testId}
      fontFamily="heading"
      fontWeight="700"
      fontSize="sm"
      color="charcoal.500"
      {...buttonProps}
    >
      {label}
      {dir === "asc" ? (
        <CaretUp size={13} weight="bold" />
      ) : dir === "desc" ? (
        <CaretDown size={13} weight="bold" />
      ) : (
        <Box as="span" color="charcoal.200" display="inline-flex">
          <CaretUpDown size={12} />
        </Box>
      )}
    </Button>
  );
  if (cell === "th") {
    return (
      <Table.ColumnHeader aria-sort={ariaSort} {...cellProps}>
        {button}
      </Table.ColumnHeader>
    );
  }
  return (
    <Box role="columnheader" aria-sort={ariaSort} {...cellProps}>
      {button}
    </Box>
  );
}

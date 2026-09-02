"use client";

/**
 * The per-node settings bundle for the curriculum document view: each setting
 * renders as a nested submenu row directly INSIDE the node's ⋮ menu via
 * {@link NodeOptionsMenuItems} (label + current value + a caret opening the
 * option list, reusing `EditableChip`'s option renderer) — so a node header
 * carries ONE ⋮ affordance for both settings and actions, and low-signal
 * metadata ("Either", "Regular", "No process"…) never clutters the header.
 *
 * History: a read-only gray `NodeOptionsSummary` used to mirror the non-default
 * selections inline in the sticky header; it read as unlabeled noise ("what does
 * 'Understand' mean?") and was removed — the labeled ⋮ rows are now the one
 * place these values show. The vague "Options…" item and its standalone
 * `NodeOptionsDialog` are likewise retired; the two former text fields (math
 * domain, video URL) relocated to the unit body.
 */
import { Menu, Portal, Spacer, Text } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import {
  SelectOptionItems,
  sameValue,
  type EditableChipSelectOption,
  type EditableChipValue,
} from "./EditableChip";

/**
 * A single settings row: a select surfaced as a nested submenu in the ⋮ menu.
 * `summary` stays falsy at the default value (the menu row renders a
 * non-default selection slightly darker); `valueLabel` always shows the
 * current selection on the menu row.
 *
 * `T` defaults to `any` on purpose: a node's rows are heterogeneous (a Bloom
 * enum, a perspective id, a boolean…) and each `onCommit` writes a narrow
 * mutation field, so a shared `EditableChipValue` bound would reject those
 * writes. `any` keeps the call sites (the row arrays) clean per the spec.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface NodeOptionRow<T extends EditableChipValue = any> {
  /** The field label shown on the menu row and as the submenu's eyebrow. */
  label: string;
  /** One-liner shown under the submenu's eyebrow. */
  hint?: string;
  /** Set only when the value differs from its default (darkens the menu row). */
  summary?: string;
  /** The current value. */
  value: T;
  /** What the menu row shows, e.g. "No process", "🎟️ Exit ticket". */
  valueLabel: string;
  options: ReadonlyArray<EditableChipSelectOption<T>>;
  onCommit: (v: T) => void | Promise<unknown>;
}

/**
 * The settings rows as nested submenus, rendered directly inside the node's ⋮
 * menu content. Each row is its own `Menu.Root` (a Chakra v3 nested menu) whose
 * `Menu.TriggerItem` shows `label … currentValue ▸` and whose submenu reuses
 * {@link SelectOptionItems} — the same option-row renderer as the header chips,
 * so the two never drift. Selecting an option commits the row's mutation.
 */
export function NodeOptionsMenuItems({ rows }: { rows: NodeOptionRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <Menu.Root
          key={row.label}
          positioning={{ placement: "right-start", gutter: 2 }}
          onSelect={(details) => {
            const next = row.options[Number(details.value)];
            if (next && !sameValue(next.value, row.value)) {
              void row.onCommit(next.value);
            }
          }}
        >
          <Menu.TriggerItem cursor="pointer">
            <Text
              fontFamily="heading"
              fontSize="sm"
              fontWeight="600"
              color="charcoal.600"
            >
              {row.label}
            </Text>
            <Spacer minW={4} />
            <Text
              fontFamily="heading"
              fontSize="sm"
              color={row.summary ? "charcoal.500" : "charcoal.400"}
              truncate
              maxW="160px"
            >
              {row.valueLabel}
            </Text>
            <CaretRight size={11} weight="bold" />
          </Menu.TriggerItem>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="220px" maxW="320px" shadow="lg" borderRadius="lg">
                <SelectOptionItems
                  label={row.label}
                  hint={row.hint}
                  options={row.options}
                  value={row.value}
                />
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      ))}
    </>
  );
}

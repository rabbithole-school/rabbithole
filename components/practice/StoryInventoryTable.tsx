"use client";

import { useMemo, useState } from "react";
import { Badge, Box, Flex, Table, Text } from "@chakra-ui/react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { KIND_LABEL, type StoryKind } from "@/components/NodeStoryFamily";

export type StoryInventoryRow = {
  edgeId: string;
  fromKey: string;
  fromLabel: string;
  fromDomain: string;
  fromStrand: string | null;
  toKey: string;
  toLabel: string;
  toDomain: string;
  kind: StoryKind;
  hook: string;
  narrative: string;
  visualEmoji?: string;
  probe?: string;
  source?: string;
  provenance: "registry" | "authored" | "generated";
  updatedAt?: number;
};

type SortKey = "fromLabel" | "fromStrand" | "kind" | "provenance" | "toDomain";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "fromLabel", label: "Skill" },
  { key: "fromStrand", label: "Strand" },
  { key: "kind", label: "Kind" },
  { key: "toDomain", label: "Opens into" },
  { key: "provenance", label: "Provenance" },
];

function SortHeader({
  col,
  active,
  dir,
  onClick,
}: {
  col: { key: SortKey; label: string };
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <Table.ColumnHeader
      fontFamily="heading"
      cursor="pointer"
      onClick={onClick}
      userSelect="none"
      data-testid={`stories-sort-${col.key}`}
    >
      <Flex align="center" gap={1}>
        {col.label}
        {active &&
          (dir === "asc" ? (
            <CaretUp size={11} weight="bold" />
          ) : (
            <CaretDown size={11} weight="bold" />
          ))}
      </Flex>
    </Table.ColumnHeader>
  );
}

function previewLine(narrative: string): string {
  return narrative.split(/\r?\n/u)[0] ?? "";
}

export function StoryInventoryTable({
  rows,
  onSelect,
}: {
  rows: StoryInventoryRow[];
  onSelect: (row: StoryInventoryRow) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("fromLabel");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const left = sortKey === "kind" ? KIND_LABEL[a.kind] : (a[sortKey] ?? "");
      const right = sortKey === "kind" ? KIND_LABEL[b.kind] : (b[sortKey] ?? "");
      const cmp = String(left).localeCompare(String(right));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortDir, sortKey]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir("asc");
  };

  return (
    <Box overflowX="auto" data-testid="story-inventory-table">
      <Table.Root size="sm">
        <Table.Header>
          <Table.Row>
            {COLUMNS.map((col) => (
              <SortHeader
                key={col.key}
                col={col}
                active={sortKey === col.key}
                dir={sortDir}
                onClick={() => toggleSort(col.key)}
              />
            ))}
            <Table.ColumnHeader fontFamily="heading">Story</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {sorted.map((row) => (
            <Table.Row
              key={row.edgeId}
              onClick={() => onSelect(row)}
              cursor="pointer"
              _hover={{ bg: "gray.50" }}
              data-testid={`story-row-${row.edgeId}`}
            >
              <Table.Cell fontFamily="body" fontWeight="600">
                {row.fromLabel}
              </Table.Cell>
              <Table.Cell fontFamily="body" color="charcoal.500">
                {row.fromStrand ?? "—"}
              </Table.Cell>
              <Table.Cell>{KIND_LABEL[row.kind]}</Table.Cell>
              <Table.Cell>
                <Text fontSize="sm" color="charcoal.700">
                  {row.toLabel}
                </Text>
                <Text fontSize="xs" color="charcoal.500">
                  {row.toDomain}
                </Text>
              </Table.Cell>
              <Table.Cell>
                <Badge colorPalette="gray" variant="subtle" size="sm">
                  {row.provenance}
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <Flex gap={2} align="flex-start">
                  {row.visualEmoji && (
                    <Text aria-hidden="true" fontSize="lg" lineHeight="1">
                      {row.visualEmoji}
                    </Text>
                  )}
                  <Text fontSize="sm" color="charcoal.700" fontWeight="600" lineHeight="1.4">
                    {row.hook}
                  </Text>
                </Flex>
                <Text fontSize="xs" color="charcoal.500" lineHeight="1.4" mt={0.5}>
                  {previewLine(row.narrative)}
                </Text>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}

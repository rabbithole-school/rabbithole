"use client";

/**
 * Instructional coverage inventory for the Math Skills tab. Where the Questions,
 * Manipulatives, and Stories views tally coverage PER NODE, Launchpads are
 * strand-level (one canonical worked example per strand, shown the first time a
 * scholar meets that strand) — so this table lists one row per strand in the
 * domain, marking which have verified content and which are still fully-Socratic
 * gaps. Read-only: Launchpad content is authored/generated through the verify→
 * store gate, not edited here.
 */

import { useMemo } from "react";
import { Badge, Box, Flex, Table, Text } from "@chakra-ui/react";
import type { InstructionMedium } from "@/convex/instruction";
import {
  INSTRUCTION_ATOM_LABEL,
  instructionAtomPalette,
  type InstructionAtomKind,
} from "@/components/practice/instructionVocabulary";
import { InstructionMediumBadge } from "@/components/practice/InstructionLaunchpadDetail";

export type InstructionCoverageRow = {
  strand: string;
  key: string;
  status: "passed" | "failed" | "unverified";
  provenance: "authored" | "generated";
  title: string;
  subtitle: string | null;
  atomKinds: string[];
  /** manipulative-led / video-led / text — already computed server-side by
   *  `instructionMedium()`; this table simply never showed it. */
  medium: InstructionMedium;
  hasWorkedExample: boolean;
  version: number;
  updatedAt: number;
};

function StatusBadge({ row }: { row: InstructionCoverageRow | undefined }) {
  if (!row) {
    return (
      <Badge colorPalette="yellow" variant="solid" size="sm">
        none
      </Badge>
    );
  }
  if (row.status === "passed") {
    return (
      <Badge colorPalette="violet" variant="subtle" size="sm">
        launchpad
      </Badge>
    );
  }
  return (
    <Badge colorPalette="red" variant="subtle" size="sm">
      failed verify
    </Badge>
  );
}

export function InstructionInventoryTable({
  strands,
  coverage,
}: {
  strands: string[];
  coverage: InstructionCoverageRow[];
}) {
  const byStrand = useMemo(
    () => new Map(coverage.map((c) => [c.strand, c])),
    [coverage],
  );
  // Every designated strand in the domain, plus any stored content whose strand
  // isn't in that list (a gap in the other direction — surfaced, never hidden).
  const rows = useMemo(() => {
    const all = new Set<string>(strands);
    for (const c of coverage) all.add(c.strand);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [strands, coverage]);

  return (
    <Box overflowX="auto" data-testid="instruction-inventory-table">
      <Table.Root size="sm">
        <Table.Header userSelect="none">
          <Table.Row>
            <Table.ColumnHeader fontFamily="heading">Strand</Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">Status</Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">Launchpad</Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">Medium</Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">Includes</Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">Source</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((strand) => {
            const row = byStrand.get(strand);
            return (
              <Table.Row key={strand} data-testid={`instruction-row-${strand}`}>
                <Table.Cell fontFamily="body" fontWeight="600" color="charcoal.700">
                  {strand}
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge row={row} />
                </Table.Cell>
                <Table.Cell>
                  {row ? (
                    <>
                      <Text fontSize="sm" color="charcoal.700" fontWeight="600" lineHeight="1.4">
                        {row.title}
                      </Text>
                      {row.subtitle && (
                        <Text fontSize="xs" color="charcoal.500" lineHeight="1.4" mt={0.5}>
                          {row.subtitle}
                        </Text>
                      )}
                    </>
                  ) : (
                    <Text fontSize="sm" color="charcoal.400">
                      No launchpad yet — this strand stays fully Socratic.
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {/* The one-word answer to "what kind of instruction is this?".
                      Same badge the rail and the segment detail render, so the
                      answer looks identical wherever a teacher meets it. */}
                  {row ? (
                    <InstructionMediumBadge medium={row.medium} />
                  ) : (
                    <Text fontSize="sm" color="charcoal.400">
                      —
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {row ? (
                    <Flex gap={1} wrap="wrap">
                      {row.atomKinds.map((kind, i) => (
                        <Badge
                          key={`${kind}-${i}`}
                          colorPalette={instructionAtomPalette(
                            kind as InstructionAtomKind,
                          )}
                          variant="subtle"
                          size="sm"
                        >
                          {INSTRUCTION_ATOM_LABEL[kind as InstructionAtomKind] ??
                            kind}
                        </Badge>
                      ))}
                    </Flex>
                  ) : (
                    <Text fontSize="sm" color="charcoal.400">
                      —
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {row ? (
                    <Badge colorPalette="gray" variant="subtle" size="sm">
                      {row.provenance}
                    </Badge>
                  ) : (
                    <Text fontSize="sm" color="charcoal.400">
                      —
                    </Text>
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}

"use client";

import { useState } from "react";
import { Badge, Box, Button, Table, Text } from "@chakra-ui/react";
import { Play } from "@phosphor-icons/react";
import { ManipulativeRehearseModal } from "@/components/practice/ManipulativeRehearseModal";
import { stemPreviewText } from "@/shared/practiceStemBlocks";
import { parseManipulativeSpec } from "@/lib/manipulative/grade";
import type { ManipulativeSpec } from "@/lib/manipulative/types";

export type PracticeItemInventoryRow = {
  id: string;
  skillKey: string;
  skillLabel: string;
  strand: string | null;
  grade: string | null;
  stem: string;
  answerType: string;
  answer: string;
  verifierKind: string;
  /** The manipulative's spec JSON (null for word items) — powers the Rehearse
   *  preview on manipulative rows. */
  manipulativeSpec: string | null;
  source: string;
  model: string | null;
  verifiedAt: number;
};

export type TemplateInventorySkill = {
  nodeKey: string;
  label: string;
  strand: string | null;
  grade: string | null;
};

type InventoryEntry =
  | {
      key: string;
      kind: "template";
      skillKey: string;
      skillLabel: string;
      strand: string | null;
      grade: string | null;
    }
  | {
      key: string;
      kind: "stored";
      row: PracticeItemInventoryRow;
      skillKey: string;
      skillLabel: string;
      strand: string | null;
      grade: string | null;
    };

function formatBadge(entry: InventoryEntry) {
  // The row's ANSWER-FORMAT badge (the Questions thread's facet vocabulary):
  // a template and a written stored item are Written (violet); a manipulative is
  // Hands-on (teal). Same two tokens the facet control uses — no new colour. A
  // template row keeps reading "Template" so the endless-variants source stays
  // legible.
  if (entry.kind === "template") {
    return { label: "Template", palette: "violet" as const };
  }
  if (entry.row.verifierKind === "manipulative") {
    return { label: "Hands-on", palette: "teal" as const };
  }
  return { label: "Written", palette: "violet" as const };
}

export function PracticeItemInventoryTable({
  mode,
  rows,
  templateSkills = [],
  onSelectSkill,
}: {
  mode: "questions" | "manipulatives" | "all";
  rows: PracticeItemInventoryRow[];
  templateSkills?: TemplateInventorySkill[];
  onSelectSkill: (skillKey: string) => void;
}) {
  // A single shared rehearse dialog for the whole table — the clicked row sets
  // the spec, one Dialog mounts (never N hidden dialogs). Conditionally rendered
  // (`{rehearse && …}`) with no changing key → no body-lock leak.
  const [rehearse, setRehearse] = useState<{ spec: ManipulativeSpec; title: string } | null>(
    null,
  );
  // Templates belong to the written pool, so they appear in every facet EXCEPT
  // Hands-on. Stored rows are filtered per facet; the All facet keeps both.
  const entries: InventoryEntry[] = [
    ...(mode !== "manipulatives"
      ? templateSkills.map((skill) => ({
          key: `template:${skill.nodeKey}`,
          kind: "template" as const,
          skillKey: skill.nodeKey,
          skillLabel: skill.label,
          strand: skill.strand,
          grade: skill.grade,
        }))
      : []),
    ...rows
      .filter((row) =>
        mode === "all"
          ? true
          : mode === "manipulatives"
            ? row.verifierKind === "manipulative"
            : row.verifierKind !== "manipulative",
      )
      .map((row) => ({
        key: row.id,
        kind: "stored" as const,
        row,
        skillKey: row.skillKey,
        skillLabel: row.skillLabel,
        strand: row.strand,
        grade: row.grade,
      })),
  ].sort((a, b) => {
    const bySkill = a.skillLabel.localeCompare(b.skillLabel);
    if (bySkill !== 0) return bySkill;
    if (a.kind !== b.kind) return a.kind === "template" ? -1 : 1;
    if (a.kind === "stored" && b.kind === "stored") {
      return b.row.verifiedAt - a.row.verifiedAt;
    }
    return 0;
  });

  if (entries.length === 0) {
    const noun = mode === "all" ? "items" : mode;
    return (
      <Text fontSize="sm" color="charcoal.400" py={2}>
        No {noun} in this domain yet.
      </Text>
    );
  }

  return (
    <Box overflowX="auto" data-testid={`practice-${mode}-inventory`}>
      <Table.Root size="sm">
        <Table.Header userSelect="none">
          <Table.Row>
            <Table.ColumnHeader fontFamily="heading">Skill</Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">Format</Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">
              {mode === "questions" ? "Question" : mode === "manipulatives" ? "Manipulative" : "Item"}
            </Table.ColumnHeader>
            <Table.ColumnHeader fontFamily="heading">
              {/* The header has to be as honest as the cells under it. Under the
                  All facet this column is genuinely mixed — a written row shows
                  its canonical answer, a hands-on row shows Rehearse (a
                  manipulative deliberately HAS no answer string) — so a bare
                  "Answer" would label a column of buttons. */}
              {mode === "manipulatives"
                ? "Type"
                : mode === "all"
                  ? "Answer or rehearse"
                  : "Answer"}
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {entries.map((entry) => {
            const badge = formatBadge(entry);
            return (
              <Table.Row key={entry.key}>
                <Table.Cell>
                  <Button
                    variant="plain"
                    h="auto"
                    minH="auto"
                    p={0}
                    whiteSpace="normal"
                    textAlign="left"
                    justifyContent="flex-start"
                    fontFamily="body"
                    fontWeight="600"
                    color="charcoal.700"
                    onClick={() => onSelectSkill(entry.skillKey)}
                  >
                    {entry.skillLabel}
                  </Button>
                  <Text fontSize="xs" color="charcoal.400">
                    {[entry.strand, entry.grade ? `G${entry.grade}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <Badge colorPalette={badge.palette} variant="subtle" size="sm">
                    {badge.label}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="sm" color="charcoal.700" lineHeight="1.4">
                    {/* Bucket B: a stem cell inside a real Table.Cell — flatten
                        any table run to one scannable line, never a nested block
                        table. */}
                    {entry.kind === "template"
                      ? "Code template · endless variants"
                      : stemPreviewText(entry.row.stem)}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  {entry.kind === "template" ? (
                    <Text fontSize="sm" color="charcoal.500">
                      Generated at serve time
                    </Text>
                  ) : entry.row.verifierKind !== "manipulative" ? (
                    // Written row: its canonical answer — even in the All facet's
                    // mixed column (per-row, not per-mode), so a written and a
                    // hands-on row read side by side honestly.
                    <Text fontSize="sm" color="charcoal.500">
                      {entry.row.answer}
                    </Text>
                  ) : (
                    // Manipulative row: Rehearse opens the REAL interactive
                    // manipulative (standalone, ungraded, zero writes) — same
                    // renderer a scholar gets. Same label / Play glyph / size as
                    // every other Rehearse in the Content view.
                    (() => {
                      const spec = parseManipulativeSpec(entry.row.manipulativeSpec);
                      return spec ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          color="violet.700"
                          fontFamily="heading"
                          fontWeight="600"
                          _hover={{ bg: "violet.50" }}
                          onClick={() => setRehearse({ spec, title: entry.row.stem })}
                          data-testid="inventory-rehearse"
                        >
                          <Play weight="fill" />
                          Rehearse
                        </Button>
                      ) : (
                        <Text fontSize="sm" color="charcoal.500">
                          Interactive
                        </Text>
                      );
                    })()
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      {rehearse && (
        <ManipulativeRehearseModal
          spec={rehearse.spec}
          title={rehearse.title}
          onClose={() => setRehearse(null)}
        />
      )}
    </Box>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { Box, Grid, Text, VStack, chakra } from "@chakra-ui/react";
import { CaretDown } from "@phosphor-icons/react";
import type { DomainPortrait, MathPortrait } from "@/convex/mathPortrait";
import { gradeWords } from "@/components/practice/masteryGradeLevel";
import {
  AskAboutMathButton,
  PortraitPending,
  portraitFirstName,
} from "@/components/practice/MathSkillsPortrait";
import {
  isListedArea,
  isThinArea,
  parentLevelText,
  showOverallLevel,
} from "@/shared/parentMathThin";
import {
  areaSkillCountLine,
  mathContextLine,
  newThisTermCell,
  paceTile,
} from "@/components/practice/parentMathDisplay";

/**
 * The parent Math page (`/parent/math`): a context line, two stat tiles (the
 * overall level, and this term's new learning against the standard pace), and
 * one compact table with a row per area that expands to the three skills most
 * recently demonstrated there. Fed by `parents.childMathPortrait`; every
 * number is the server's, the same fields the teacher's `MathSkillsPortrait`
 * reads. Skills credited only by the placement check-in are counted, never
 * named.
 */

export interface ParentMathPortraitProps {
  /** undefined while the query is in flight. */
  portrait: MathPortrait | undefined;
  scholarName: string;
  /** Seeds the portal chat with "What is <name> working on in math?". */
  onAskAi?: (question: string) => void;
  /** Shown under the Common Core footnote: the portal's standing
   *  "part of the picture" note. */
  note?: ReactNode;
}

// Area | Grade level | New this term | chevron. The two number columns are
// sized to their headers ("New this term" wraps to two lines) and to "12.4 mo",
// so a long area name wraps instead of pushing the row wide at phone width.
const COLUMNS = "minmax(0, 1fr) 4.5rem 4.25rem 1rem";

function StatTile({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <Box borderWidth="1px" borderColor="border.default" borderRadius="lg" bg="bg.default" px={4} py={3} minW={0}>
      <Text fontFamily="body" fontSize="13px" color="fg.muted">
        {label}
      </Text>
      <Text
        fontFamily="heading"
        fontSize="2xl"
        fontWeight="700"
        color="violet.600"
        fontVariantNumeric="tabular-nums"
        lineHeight="1.2"
        mt={0.5}
      >
        {value}
      </Text>
      {children}
    </Box>
  );
}

function NewThisTermCell({ months }: { months: number | undefined }) {
  const cell = newThisTermCell(months);
  if (cell === null) return null;
  return (
    <Text
      fontFamily="heading"
      fontSize="sm"
      fontWeight={cell.muted ? "400" : "600"}
      color={cell.muted ? "fg.muted" : "green.700"}
      fontVariantNumeric="tabular-nums"
      textAlign="right"
      whiteSpace="nowrap"
    >
      {cell.text}
    </Text>
  );
}

// A real <button> (not Box as="button") so `type="button"` is natively typed.
const RowButton = chakra("button");

function AreaRow({ area, showTermColumn, first }: { area: DomainPortrait; showTermColumn: boolean; first: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = `math-area-${area.domain}`;
  const skills = area.recentFluentSkillLabels ?? [];
  const countLine = areaSkillCountLine(area.fluentSkills, area.placementSkills);
  // A thin area's level rests on a handful of skills, so it is not printed
  // (shared/parentMathThin.ts); the words span both number columns.
  const thin = isThinArea(area);
  return (
    <Box borderTopWidth={first ? 0 : "1px"} borderColor="border.muted">
      <RowButton
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        w="full"
        textAlign="left"
        px={4}
        py={3}
        cursor="pointer"
        _hover={{ bg: "bg.subtle" }}
        _focusVisible={{ outline: "2px solid", outlineColor: "violet.500", outlineOffset: "-2px" }}
      >
        <Grid templateColumns={COLUMNS} columnGap={3} alignItems="center">
          <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.700" minW={0}>
            {area.label}
          </Text>
          {thin ? (
            <Text gridColumn="span 2" fontFamily="body" fontSize="xs" color="fg.muted" textAlign="right">
              Just getting started
            </Text>
          ) : (
            <>
              <Text
                fontFamily="heading"
                fontSize="md"
                fontWeight="700"
                color={area.gradeValue !== null ? "violet.600" : "fg.subtle"}
                fontVariantNumeric="tabular-nums"
                textAlign="right"
              >
                {area.gradeValue !== null ? parentLevelText(area.gradeValue, "table") : "—"}
              </Text>
              <Box>{showTermColumn && <NewThisTermCell months={area.termLearnedMonths} />}</Box>
            </>
          )}
          <Box
            color="fg.muted"
            display="flex"
            justifyContent="flex-end"
            transform={open ? "rotate(180deg)" : undefined}
            transition="transform 0.15s"
          >
            <CaretDown size={14} weight="bold" aria-hidden />
          </Box>
        </Grid>
      </RowButton>
      {open && (
        <Box id={panelId} px={4} pb={3}>
          {skills.length > 0 && (
            <>
              <Text fontFamily="body" fontSize="xs" color="fg.muted" mb={1}>
                Recently demonstrated
              </Text>
              <VStack as="ul" align="stretch" gap={0.5} listStyleType="none" m={0} p={0} mb={2}>
                {skills.map((label) => (
                  <Text as="li" key={label} fontFamily="body" fontSize="sm" color="charcoal.700">
                    {label}
                  </Text>
                ))}
              </VStack>
            </>
          )}
          {countLine && (
            <Text fontFamily="body" fontSize="xs" color="fg.muted">
              {countLine}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

export function ParentMathPortrait({ portrait, scholarName, onAskAi, note }: ParentMathPortraitProps) {
  const firstName = portraitFirstName(scholarName);
  // An area with no credited skill at all is not listed.
  const areas = portrait?.domains.filter(isListedArea) ?? [];
  if (portrait === undefined || areas.length === 0) {
    return <PortraitPending portrait={portrait && { ...portrait, domains: areas }} firstName={firstName} />;
  }

  const overall = portrait.overall;
  // The overall level only when two or more areas carry a printable level.
  const level = showOverallLevel(areas) ? (overall?.level ?? null) : null;
  const pace = paceTile(overall?.pace);
  // The "New this term" column exists only when there is a term to measure from.
  const showTermColumn = areas.some((d) => d.termLearnedMonths !== undefined);
  const columnHeader = { fontFamily: "body", fontSize: "xs", color: "fg.muted", textAlign: "right" } as const;

  return (
    <VStack align="stretch" gap={4} maxW="720px">
      <Text fontFamily="body" fontSize="sm" color="fg.muted">
        {mathContextLine(firstName, overall?.pace?.windowStartsDay)}
      </Text>

      {(level || pace) && (
        <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap={3}>
          {level && (
            <StatTile label="Overall grade level" value={parentLevelText(level.value, "tile")}>
              {overall?.enrolledGradeRank != null && (
                <Text fontFamily="body" fontSize="xs" color="fg.muted" mt={1}>
                  enrolled in {gradeWords(overall.enrolledGradeRank)}
                </Text>
              )}
            </StatTile>
          )}
          {pace && (
            <StatTile label="New math learned" value={pace.learnedMonths}>
              <Text fontFamily="body" fontSize="xs" color="fg.muted" mt={1}>
                in {pace.schoolMonths}
              </Text>
              <Text
                fontFamily="body"
                fontSize="xs"
                fontWeight="600"
                color={pace.atOrAboveStandard ? "green.700" : "charcoal.600"}
                mt={0.5}
              >
                {pace.pace}
              </Text>
            </StatTile>
          )}
        </Grid>
      )}

      <Box borderWidth="1px" borderColor="border.default" borderRadius="lg" bg="bg.default" overflow="hidden">
        <Grid templateColumns={COLUMNS} columnGap={3} px={4} pt={3} pb={2} borderBottomWidth="1px" borderColor="border.muted">
          <Text fontFamily="body" fontSize="xs" color="fg.muted">
            Area
          </Text>
          <Text {...columnHeader}>Grade level</Text>
          <Text {...columnHeader}>{showTermColumn ? "New this term" : ""}</Text>
          <Box />
        </Grid>
        {areas.map((d, i) => (
          <AreaRow key={d.domain} area={d} showTermColumn={showTermColumn} first={i === 0} />
        ))}
      </Box>

      <Text fontFamily="body" fontSize="xs" color="fg.subtle">
        Grade levels follow the Common Core math standards.
      </Text>

      {note}

      {onAskAi && <AskAboutMathButton firstName={firstName} onAskAi={onAskAi} />}
    </VStack>
  );
}

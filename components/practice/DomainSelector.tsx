"use client";

/**
 * DomainSelector — the teacher-facing practice-domain picker. The practice
 * engine is domain-parametric (whole-number arithmetic, fractions, probability,
 * …), but most teacher surfaces historically hard-defaulted to whole-number.
 * This is the ONE control that lets a teacher choose which domain to assign /
 * inspect, reused by the StandingPractice dialog, the scholar math-map view, and
 * the cohort frontier.
 *
 * Options come from `api.standingPractice.listDomains` (only domains actually
 * seeded on this deployment). Renders discipline-grouped button rows to match
 * the dialog's existing visual language (no select dependency). Renders nothing
 * when there is 0–1 domain to choose from — a single-domain deployment gets no
 * redundant chrome.
 *
 * `value === undefined` means "the default" (the first listed domain), so a
 * caller can leave `domain` unset and still highlight the default.
 */

import { useQuery } from "convex/react";
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";

export function DomainSelector({
  value,
  onChange,
  size = "xs",
  label,
}: {
  /** Selected domain slug, or undefined to highlight the default (first). */
  value: string | undefined;
  onChange: (domain: string) => void;
  size?: "xs" | "sm";
  /** Optional section header, rendered in the dialog's uppercase-label style
   *  ONLY when the picker actually renders (≥2 domains). */
  label?: string;
}) {
  const domains = useQuery(api.standingPractice.listDomains, {});

  // Nothing worth choosing between → render no chrome at all (no dangling label).
  if (!domains || domains.length <= 1) return null;

  const effective = value ?? domains[0].domain;

  // Group by discipline, preserving first-seen order within and across groups.
  const groups: { discipline: string; items: typeof domains }[] = [];
  for (const d of domains) {
    const g = groups.find((x) => x.discipline === d.discipline);
    if (g) g.items.push(d);
    else groups.push({ discipline: d.discipline, items: [d] });
  }
  const showDisciplineLabels = groups.length > 1;

  return (
    <Flex direction="column" gap={2}>
      {label && (
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.04em"
        >
          {label}
        </Text>
      )}
      {groups.map((group) => (
        <Box key={group.discipline}>
          {showDisciplineLabels && (
            <Text
              fontSize="2xs"
              color="charcoal.400"
              fontFamily="heading"
              fontWeight="600"
              textTransform="uppercase"
              letterSpacing="0.04em"
              mb={1}
            >
              {group.discipline}
            </Text>
          )}
          <Flex wrap="wrap" gap={2}>
            {group.items.map((d) => {
              const active = effective === d.domain;
              return (
                <Button
                  key={d.domain}
                  size={size}
                  variant={active ? "solid" : "outline"}
                  colorPalette={active ? "violet" : "gray"}
                  onClick={() => onChange(d.domain)}
                >
                  {d.label}
                </Button>
              );
            })}
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}

/**
 * MultiDomainSelector — the multi-select variant for a MIXED playlist: the
 * teacher toggles any number of domains to blend into one interleaved session.
 * Same discipline-grouped chrome as {@link DomainSelector}; an empty selection
 * means "the default" (whole-number arithmetic, single-domain). Renders nothing
 * on a 0–1 domain deployment (nothing to blend).
 */
export function MultiDomainSelector({
  selected,
  onToggle,
  size = "xs",
  label,
}: {
  /** The set of selected domain slugs (empty ⇒ the default single domain). */
  selected: Set<string>;
  onToggle: (domain: string) => void;
  size?: "xs" | "sm";
  label?: string;
}) {
  const domains = useQuery(api.standingPractice.listDomains, {});

  if (!domains || domains.length <= 1) return null;

  const groups: { discipline: string; items: typeof domains }[] = [];
  for (const d of domains) {
    const g = groups.find((x) => x.discipline === d.discipline);
    if (g) g.items.push(d);
    else groups.push({ discipline: d.discipline, items: [d] });
  }
  const showDisciplineLabels = groups.length > 1;

  return (
    <Flex direction="column" gap={2}>
      {label && (
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.04em"
        >
          {label}
        </Text>
      )}
      {groups.map((group) => (
        <Box key={group.discipline}>
          {showDisciplineLabels && (
            <Text
              fontSize="2xs"
              color="charcoal.400"
              fontFamily="heading"
              fontWeight="600"
              textTransform="uppercase"
              letterSpacing="0.04em"
              mb={1}
            >
              {group.discipline}
            </Text>
          )}
          <Flex wrap="wrap" gap={2}>
            {group.items.map((d) => {
              const active = selected.has(d.domain);
              return (
                <Button
                  key={d.domain}
                  size={size}
                  variant={active ? "solid" : "outline"}
                  colorPalette={active ? "violet" : "gray"}
                  onClick={() => onToggle(d.domain)}
                >
                  {active ? "✓ " : ""}
                  {d.label}
                </Button>
              );
            })}
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}

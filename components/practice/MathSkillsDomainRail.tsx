"use client";

/**
 * MathSkillsDomainRail — the body of the Math Skills studio's collapsible left
 * DOMAIN rail, the Finder-column analogue of the Units tab. It renders INSIDE a
 * `CollapsibleRailLayout` panel (which owns width + the collapse animation), so
 * this component is just the expanded content: a header (title + collapse
 * chevron) and a scrollable domain list, shared identically by both the Mastery
 * and Content lenses.
 *
 * It is PURE NAVIGATION — a list of domains, the current selection, and
 * click-to-select. Domain/strand access curation used to live here too; that
 * control surface has been removed, so this rail only reads and shows
 * non-access domain metadata (name, strand count, grade span).
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { CaretDoubleLeft } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { COLUMN_HEADER_HEIGHT } from "@/components/hierarchy";
import { selectableSurface } from "@/components/practice/selectionStyle";
import { formatGradeRange } from "@/shared/gradeRange";

type PracticeDomain = { domain: string; label: string };

/**
 * The sentinel `domain` value for the rail's synthetic "All domains" row (an
 * experiment: a computed cross-domain mastery grade level per scholar, in
 * place of any one domain's skill matrix). It is never a real practice-domain
 * slug, so it can travel through the SAME `selectedDomain`/`onSelectDomain`
 * string channel as every other row without a parallel prop.
 */
export const ALL_DOMAINS_DOMAIN = "__all__";
export const FAST_MATH_DOMAIN = "__fast_math__";

export function isSyntheticMathSkillsDomain(domain: string): boolean {
  return domain === ALL_DOMAINS_DOMAIN || domain === FAST_MATH_DOMAIN;
}

export function MathSkillsDomainRail({
  domains,
  selectedDomain,
  onSelectDomain,
  showAllDomainsOption,
  showFastMathOption,
  onCollapse,
}: {
  domains: PracticeDomain[];
  selectedDomain: string;
  onSelectDomain: (domain: string) => void;
  /** Show the synthetic "All domains" row above the per-domain list (Mastery
   *  lens only — Content always needs one real domain for its item pools). */
  showAllDomainsOption?: boolean;
  /** Show the synthetic Fast math percentage view (Mastery lens only). */
  showFastMathOption?: boolean;
  /** Collapse the rail to its chevron (the layout owns the animation). */
  onCollapse?: () => void;
}) {
  // Per-domain meta under each domain name — "N strands · Grade K–6". The strand
  // count and the grade span both come from sibling teacher queries over the
  // domain's knowledge nodes (grade omitted when no node carries one).
  const strandCounts = useQuery(api.standingPractice.domainStrandCounts, {});
  const gradeRanges = useQuery(api.standingPractice.domainGradeRanges, {});
  const strandMeta = useMemo(
    () => (domainKey: string): string => {
      const n = strandCounts?.[domainKey];
      if (n === undefined) return "\u00A0"; // reserve the line height while loading
      const strands = `${n} ${n === 1 ? "strand" : "strands"}`;
      const range = gradeRanges?.[domainKey];
      const grade = formatGradeRange(range?.min, range?.max);
      return grade ? `${strands} · ${grade}` : strands;
    },
    [strandCounts, gradeRanges],
  );

  return (
    <Flex direction="column" h="full" w="full" minW={0}>
      {/* Header — aligns with the content panel's header band. */}
      <Flex
        align="center"
        justify="space-between"
        h={COLUMN_HEADER_HEIGHT}
        minH={COLUMN_HEADER_HEIGHT}
        px={3}
        borderBottomWidth="1px"
        borderColor="gray.100"
        flexShrink={0}
      >
        <Text
          fontSize="2xs"
          fontWeight="700"
          color="charcoal.400"
          textTransform="uppercase"
          letterSpacing="0.04em"
          lineClamp={1}
        >
          Domains
        </Text>
        {onCollapse && (
          <Box
            as="button"
            onClick={onCollapse}
            color="charcoal.400"
            cursor="pointer"
            _hover={{ color: "charcoal.600" }}
            aria-label="Collapse domains"
            title="Collapse domains"
            lineHeight={0}
            flexShrink={0}
          >
            <CaretDoubleLeft size={14} />
          </Box>
        )}
      </Flex>

      <Flex direction="column" gap={0.5} p={2} overflowY="auto" flex={1}>
        {showAllDomainsOption && (
          <Box
            as="button"
            onClick={() => onSelectDomain(ALL_DOMAINS_DOMAIN)}
            w="100%"
            textAlign="left"
            cursor="pointer"
            px={2.5}
            py={2}
            {...selectableSurface(selectedDomain === ALL_DOMAINS_DOMAIN)}
            _hover={{
              bg: selectedDomain === ALL_DOMAINS_DOMAIN ? "violet.50" : "gray.50",
            }}
            data-testid="domain-rail-all-domains"
          >
            <Text
              fontSize="sm"
              fontWeight={selectedDomain === ALL_DOMAINS_DOMAIN ? "700" : "600"}
              color={
                selectedDomain === ALL_DOMAINS_DOMAIN ? "navy.700" : "charcoal.600"
              }
              lineClamp={1}
            >
              All domains
            </Text>
            <Text fontSize="2xs" color="charcoal.400" lineClamp={1}>
              Grade level across every domain
            </Text>
          </Box>
        )}
        {showFastMathOption && (
          // The rule that separates the synthetic rows from the real domain
          // list belongs to the GROUP, not to the row: putting it on the button
          // overrode the shared selection ring's colour and read as a second
          // outline around the selected item.
          <Box mb={1} pb={1} borderBottomWidth="1px" borderColor="gray.100">
            <Box
              as="button"
              onClick={() => onSelectDomain(FAST_MATH_DOMAIN)}
              w="100%"
              textAlign="left"
              cursor="pointer"
              px={2.5}
              py={2}
              {...selectableSurface(selectedDomain === FAST_MATH_DOMAIN)}
              _hover={{
                bg: selectedDomain === FAST_MATH_DOMAIN ? "violet.50" : "gray.50",
              }}
              data-testid="domain-rail-fast-math"
            >
              <Text
                fontSize="sm"
                fontWeight={selectedDomain === FAST_MATH_DOMAIN ? "700" : "600"}
                color={
                  selectedDomain === FAST_MATH_DOMAIN ? "navy.700" : "charcoal.600"
                }
                lineClamp={1}
              >
                Fast math
              </Text>
              <Text fontSize="2xs" color="charcoal.400" lineClamp={1}>
                Fact families · 0–100% automatic
              </Text>
            </Box>
          </Box>
        )}
        {domains.map((d) => {
          const selected = d.domain === selectedDomain;
          return (
            <Box
              key={d.domain}
              as="button"
              onClick={() => onSelectDomain(d.domain)}
              w="100%"
              textAlign="left"
              cursor="pointer"
              px={2.5}
              py={2}
              {...selectableSurface(selected)}
              _hover={{ bg: selected ? "violet.50" : "gray.50" }}
              data-testid={`domain-rail-${d.domain}`}
            >
              <Flex align="center" gap={2}>
                <Box flex={1} minW={0}>
                  <Text
                    fontSize="sm"
                    fontWeight={selected ? "700" : "600"}
                    color={selected ? "navy.700" : "charcoal.600"}
                    lineClamp={1}
                  >
                    {d.label}
                  </Text>
                  <Text fontSize="2xs" color="charcoal.400" lineClamp={1}>
                    {strandMeta(d.domain)}
                  </Text>
                </Box>
              </Flex>
            </Box>
          );
        })}
      </Flex>
    </Flex>
  );
}

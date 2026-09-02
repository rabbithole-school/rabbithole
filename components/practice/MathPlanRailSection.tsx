"use client";

/**
 * MathPlanRailSection — the canonical inspector for one scholar's Math plan,
 * stated in words inside the existing right detail rail. Two authored controls,
 * one action. It deliberately does NOT restate mastery, mapping status,
 * placement, focus-next, or exclusions: those are system state the rail
 * already renders elsewhere, and the plan does not gain settings for them.
 *
 * The eyebrow heading alone separates authored policy from system state — no
 * tinted policy panel, no accent stripe, no card inside a card.
 *
 * ONE click target, no disclosure. The whole section is a single button that
 * opens `EditMathPlanDialog`, which is now the dual-purpose detailed view AND
 * editor: there is no second, quieter copy of the plan to expand in place, and
 * so no expansion state to drift out of step with the modal. What the rail
 * carries is the at-a-glance summary appropriate to its altitude (T1: one
 * rendering, two densities) — one line at a specific domain/strand/skill focus,
 * where that learning focus is the subject, and two named values side by side at
 * All-domains scholar focus, where the plan IS the subject. Neither density
 * explains the controls: the modal is one click away and holds the full scope
 * list, the prose, and the editing. A conflict or a migration issue is stated in
 * the summary at either altitude and opens the SAME modal: the repair is the
 * editor, never a separate hidden action.
 *
 * Everything inside the button is a `span`, because a `<button>` may only hold
 * phrasing content — the layout is unchanged, the markup is valid.
 */

import { Box, chakra, Flex, Spinner, Text } from "@chakra-ui/react";
import { PencilSimple, WarningCircle } from "@phosphor-icons/react";

import { CheckpointModePill } from "@/components/practice/MathPlanMarks";
import {
  checkpointLabel,
  practiceScopeSummary,
  type MathPlanRow,
  type ScopeSummary,
} from "@/components/practice/mathPlanProjection";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Text
      as="span"
      display="block"
      fontSize="2xs"
      fontWeight="700"
      color="charcoal.400"
      textTransform="uppercase"
      letterSpacing="0.04em"
    >
      {children}
    </Text>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      as="span"
      display="block"
      fontSize="2xs"
      fontWeight="700"
      color="charcoal.400"
    >
      {children}
    </Text>
  );
}

/** The compact line: both authored controls, in the fewest honest words. The
 *  scope half counts rather than names the domains — the full names are one
 *  click away in the editor, and a strip of them would defeat the compaction. */
function summaryLine(
  scope: ScopeSummary,
  plan: MathPlanRow,
  labels: {
    domainLabel: (domain: string) => string;
    strandLabel: (strand: string) => string;
  },
): string {
  const scopePart =
    scope.kind === "open"
      ? "Open scope"
      : `Limited scope, ${scope.entries.length} ${
          scope.entries.length === 1 ? "domain" : "domains"
        }`;
  const checkpointPart = plan.checkpoint
    ? checkpointLabel(plan.checkpoint, labels)
    : "no checkpoint";
  return `${scopePart} — ${checkpointPart}`;
}

/** The scope, as the fewest honest words that fit one column. The domains are
 *  counted, not named: the names are one click away in the editor. */
function scopeValue(scope: ScopeSummary): { text: string; empty: boolean } {
  if (scope.kind === "open") return { text: "Open", empty: false };
  if (scope.entries.length === 0)
    return { text: "Limited · nothing in scope", empty: true };
  return {
    text: `Limited · ${scope.entries.length} ${
      scope.entries.length === 1 ? "domain" : "domains"
    }`,
    empty: false,
  };
}

/** One named value in the All-domains summary — a label over its reading. */
function SummaryField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box as="span" display="block" flex="1" minW={0}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </Box>
  );
}

function migrationIssueLine(reason: string): string {
  return reason === "overlapping_standing_assignments"
    ? "Legacy configuration was ambiguous. Author a Math plan to set this scholar’s Practice scope."
    : "Legacy configuration could not be migrated. Author a Math plan to set this scholar’s Practice scope.";
}

export function MathPlanRailSection({
  plan,
  loading,
  domainLabel,
  strandLabel,
  onEdit,
  compact = true,
}: {
  /** This scholar's row from `api.mathPlans.forScholars`. */
  plan: MathPlanRow | undefined;
  loading: boolean;
  domainLabel: (domain: string) => string;
  strandLabel: (strand: string) => string;
  /** Opens the plan's detailed view / editor — the section's only gesture. */
  onEdit: () => void;
  /** One-line summary — the default, for wherever the panel's subject is a
   *  specific domain, strand, or skill rather than the plan itself. */
  compact?: boolean;
}) {
  if (loading && !plan) {
    return (
      <Box mb={4} data-testid="math-plan-rail">
        <Eyebrow>Math plan</Eyebrow>
        <Flex align="center" gap={2} py={3}>
          <Spinner size="xs" color="violet.500" />
          <Text fontSize="xs" color="charcoal.400">
            Loading the plan…
          </Text>
        </Flex>
      </Box>
    );
  }
  if (!plan) return null;

  const scope = practiceScopeSummary(plan.practiceScope, {
    domainLabel,
    strandLabel,
  });
  const checkpoint = plan.checkpoint;
  const scopeReading = scopeValue(scope);
  const needsAttention = plan.conflict || !!plan.migrationIssue;

  return (
    <Box
      mb={4}
      pb={3}
      borderBottomWidth="1px"
      borderColor="gray.100"
      data-testid="math-plan-rail"
    >
      {/* The whole section is the target — one real button, no nested ones. */}
      <chakra.button
        type="button"
        onClick={onEdit}
        display="block"
        w="100%"
        textAlign="left"
        cursor="pointer"
        px={2}
        py={2}
        borderRadius="md"
        borderWidth="1px"
        borderColor="transparent"
        _hover={{ bg: "gray.50", borderColor: "gray.200" }}
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "violet.500",
          outlineOffset: "1px",
        }}
        aria-label="View or edit math plan"
        title="View or edit math plan"
        data-testid="math-plan-edit"
      >
        <Flex as="span" align="center" justify="space-between" gap={2} mb={1}>
          <Eyebrow>Math plan</Eyebrow>
          <Flex
            as="span"
            align="center"
            gap={1}
            color="violet.600"
            fontSize="2xs"
            fontWeight="700"
            flexShrink={0}
          >
            <PencilSimple size={12} />
            View or edit
          </Flex>
        </Flex>

        {needsAttention && (
          <Flex
            as="span"
            align="flex-start"
            gap={1.5}
            mb={2}
            data-testid={
              plan.migrationIssue
                ? "math-plan-migration-issue"
                : "math-plan-conflict"
            }
          >
            <Box
              as="span"
              color="red.600"
              display="flex"
              mt="2px"
              flexShrink={0}
            >
              <WarningCircle size={13} weight="fill" />
            </Box>
            <Text
              as="span"
              display="block"
              fontSize="xs"
              color="red.600"
              lineHeight="1.5"
            >
              <Text as="span" fontWeight="700">
                Needs attention.{" "}
              </Text>
              {plan.migrationIssue
                ? migrationIssueLine(plan.migrationIssue.reason)
                : checkpoint
                  ? `The checkpoint (${checkpointLabel(checkpoint, {
                      domainLabel,
                      strandLabel,
                    })}) sits outside practice scope, so it is suspended until this is corrected. Practice scope stays the boundary: nothing out of scope is served, checkpoint or not.`
                  : "The checkpoint sits outside practice scope, so it is suspended until this is corrected."}
            </Text>
          </Flex>
        )}

        {compact ? (
          <Text
            as="span"
            display="block"
            fontSize="xs"
            color="charcoal.500"
            lineHeight="1.4"
            lineClamp={2}
            data-testid="math-plan-summary"
          >
            {summaryLine(scope, plan, { domainLabel, strandLabel })}
          </Text>
        ) : (
          <Flex
            as="span"
            align="flex-start"
            gap={4}
            data-testid="math-plan-detail"
          >
            <SummaryField label="Practice scope">
              <Text
                as="span"
                display="block"
                fontSize="sm"
                fontWeight="600"
                lineHeight="1.4"
                color={scopeReading.empty ? "red.600" : "charcoal.700"}
              >
                {scopeReading.text}
              </Text>
            </SummaryField>

            <SummaryField label="Checkpoint">
              {!checkpoint ? (
                <Text
                  as="span"
                  display="block"
                  fontSize="sm"
                  lineHeight="1.4"
                  color="charcoal.400"
                >
                  None
                </Text>
              ) : (
                <Flex as="span" align="center" gap={1.5} flexWrap="wrap">
                  <Text
                    as="span"
                    display="block"
                    fontSize="sm"
                    fontWeight="600"
                    lineHeight="1.4"
                    color="charcoal.700"
                  >
                    {checkpointLabel(checkpoint, { domainLabel, strandLabel })}
                  </Text>
                  <CheckpointModePill
                    mode={plan.mode}
                    suspended={plan.conflict}
                  />
                </Flex>
              )}
            </SummaryField>
          </Flex>
        )}
      </chakra.button>
    </Box>
  );
}

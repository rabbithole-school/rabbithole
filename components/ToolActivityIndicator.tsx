"use client";

import { useState } from "react";
import { Box, Flex, Spinner, Text, VStack } from "@chakra-ui/react";
import { CaretRight, WarningCircle } from "@phosphor-icons/react";
import {
  isScholarToolActivityVisible,
  toolGroupStatus,
} from "@/lib/toolLabels";
import {
  coalesceToolActivity,
  isScholarHiddenToolResult,
  toScholarSafeGroup,
  type ToolActivity,
  type ToolGroup,
} from "@/lib/toolActivityGroups";

/**
 * The persistent, coalesced tool-activity log for a streaming turn. Takes the
 * raw ordered log; coalesces consecutive same-type calls into counted rows
 * ("✓ Created 7 lessons"). A finished multi-call group gets a chevron to
 * expand its individual results — plain useState, no Chakra overlay (avoids
 * the Ark body-lock leak; see engineering-principles.md).
 *
 * `scholarSafe` — when set (scholar chat), only curated in-progress labels are
 * shown. Completed results are model/staff protocol payloads and never learner
 * copy. Staff/debug surfaces leave it off and keep the raw result.
 */
export function ToolActivityIndicator({
  toolActivity,
  scholarSafe = false,
}: {
  toolActivity: ToolActivity[];
  scholarSafe?: boolean;
}) {
  const groups = coalesceToolActivity(toolActivity);
  // Expanded-by-group-index. The completed-group prefix is index-stable across
  // a stream (coalescing only mutates the trailing group / appends), so an
  // index key survives re-renders.
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (groups.length === 0) return null;

  return (
    <VStack align="stretch" gap={0.5} px={4} py={1} alignSelf="flex-start" w="full">
      {groups.map((group, i) => (
        <ToolGroupRow
          key={i}
          group={group}
          scholarSafe={scholarSafe}
          isExpanded={!!expanded[i]}
          onToggle={() =>
            setExpanded((prev) => ({ ...prev, [i]: !prev[i] }))
          }
        />
      ))}
    </VStack>
  );
}

export function ToolGroupRow({
  group,
  isExpanded,
  onToggle,
  scholarSafe = false,
}: {
  group: ToolGroup;
  isExpanded: boolean;
  onToggle: () => void;
  scholarSafe?: boolean;
}) {
  if (scholarSafe && !isScholarToolActivityVisible(group)) return null;

  const displayGroup = scholarSafe ? toScholarSafeGroup(group) : group;
  const visibleItems = displayGroup.items.filter((it) => !isScholarHiddenToolResult(it.result));
  const labelGroup =
    scholarSafe && visibleItems.length > 0
      ? { ...displayGroup, items: visibleItems }
      : displayGroup;
  // Classify from labelGroup, not the raw group: on a scholar-safe surface
  // failures are already redacted/filtered out of labelGroup, so a scholar keeps
  // the plain checkmark and is never shown that a tool failed. The same status
  // drives Slack's task cards (toolGroupStatus).
  const status = toolGroupStatus(labelGroup);

  if (status.state === "running") {
    return (
      <Flex align="center" gap={2} py={1}>
        <Spinner size="xs" color="violet.400" />
        <Text fontSize="xs" fontFamily="heading" color="charcoal.400">
          {status.label}
        </Text>
      </Flex>
    );
  }

  // A multi-call group can expand to its individual per-call results.
  const multiCall = scholarSafe ? visibleItems.length > 1 : displayGroup.items.length > 1;
  if (displayGroup.status === "complete" && scholarSafe && visibleItems.length === 0) {
    return null;
  }

  // A single failed call whose label had to shorten its reason opens to the
  // full one, as Slack's card does with its details.
  const results = multiCall
    ? visibleItems.map((it) => it.result).filter((r): r is string => !!r)
    : status.detail
      ? [status.detail]
      : [];
  const expandable = multiCall || results.length > 0;

  const failed = status.state === "failed";

  return (
    <Box>
      <Flex
        align="center"
        gap={2}
        py={1}
        cursor={expandable ? "pointer" : "default"}
        onClick={expandable ? onToggle : undefined}
        role={expandable ? "button" : undefined}
        aria-expanded={expandable ? isExpanded : undefined}
        _hover={expandable ? { color: "charcoal.500" } : undefined}
      >
        {failed ? (
          // The row's own CaretRight sets the icon treatment here (bold, small).
          // Labelled so a screen reader announces the failure before the text.
          <WarningCircle
            size={12}
            weight="bold"
            color="var(--chakra-colors-orange-500)"
            aria-label="failed"
          />
        ) : (
          <Text fontSize="xs" color="green.500">
            &#10003;
          </Text>
        )}
        <Text fontSize="xs" fontFamily="heading" color="charcoal.300">
          {status.label}
        </Text>
        {expandable && (
          <CaretRight
            size={10}
            weight="bold"
            color="var(--chakra-colors-charcoal-300)"
            style={{
              transform: isExpanded ? "rotate(90deg)" : "none",
              transition: "transform 0.12s ease",
            }}
          />
        )}
      </Flex>
      {expandable && isExpanded && results.length > 0 && (
        <VStack align="stretch" gap={0} pl={5} pb={1}>
          {results.map((r, j) => (
            <Text key={j} fontSize="2xs" fontFamily="body" color="charcoal.300">
              {r}
            </Text>
          ))}
        </VStack>
      )}
    </Box>
  );
}

/**
 * A single coalesced tool-group row that owns its own expand state — for
 * interleaved rendering (see StreamingTurn), where each row stands alone
 * between text segments rather than inside the indexed list above.
 */
export function StreamToolRow({
  group,
  scholarSafe = false,
}: {
  group: ToolGroup;
  scholarSafe?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <ToolGroupRow
      group={group}
      scholarSafe={scholarSafe}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded((v) => !v)}
    />
  );
}

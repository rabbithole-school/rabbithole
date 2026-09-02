"use client";

/**
 * SkillNeighbourhoodPanel — restores the "neighbouring skill + story info"
 * detail the teacher Math Skills studio lost when it moved off the scholar
 * Tree Map. Read-only: no prescribe-practice, no setTeacherFocus, no
 * misconceptions/error-flags/recent-work — those stay in NodeDrawer, which
 * this component deliberately does not duplicate.
 *
 * Reuses `api.nodeNeighbourhood.neighbourhood` (already built for NodeDrawer)
 * and mirrors NodeDrawer's prereq/unlock derivation from `edges` — see the
 * `layout` useMemo around NodeDrawer.tsx:472. Stories render via the
 * canonical `<NodeStoryFamily>` rather than a reimplementation.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Badge, Box, Button, Flex, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { NodeStoryFamily, type StoryItem } from "@/components/NodeStoryFamily";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isCurriculumRole, type Role } from "@/convex/lib/roles";
import { MasteryDot } from "@/components/MasteryDot";
import type { MasteryState } from "@/shared/treeMapLayout";

// ── Typed neighbourhood payload (mirrors convex/nodeNeighbourhood.ts) ───────

type NeighbourNode = {
  nodeKey: string;
  label: string;
  domain: string;
  source: string | null;
  standardCodes: { framework: string; code: string }[] | null;
};

type NeighbourhoodEdge = {
  fromKey: string;
  toKey: string;
  kind: string;
  relation: "dependency" | "bridge";
  method: string | null;
  weight: number | null;
};

type RetLabel = "fresh" | "due" | "none";

type NeighbourhoodData = {
  node: {
    nodeKey: string;
    label: string;
    domain: string;
    standardCodes: { framework: string; code: string }[] | null;
  };
  edges: NeighbourhoodEdge[];
  stories: StoryItem[];
  neighbours: NeighbourNode[];
  neighbourMastery: Record<
    string,
    { mastery: MasteryState; automaticity: number; retentionLabel: RetLabel }
  >;
} | null;

function NeighbourChip({
  neighbour,
  mastery,
  onNavigate,
}: {
  neighbour: NeighbourNode;
  mastery?: MasteryState;
  onNavigate?: (nodeKey: string, label: string) => void;
}) {
  return (
    <Button
      onClick={() => onNavigate?.(neighbour.nodeKey, neighbour.label)}
      variant="outline"
      size="xs"
      borderRadius="full"
      borderColor="gray.200"
      bg="white"
      color="charcoal.600"
      fontWeight="600"
      px={2.5}
      h="26px"
      maxW="100%"
      _hover={{ borderColor: "violet.300", bg: "violet.50" }}
    >
      {mastery && (
        <Box as="span" mr={1.5} display="inline-flex" flexShrink={0}>
          <MasteryDot state={mastery} size={8} />
        </Box>
      )}
      <Text as="span" fontSize="xs" truncate maxW="180px">
        {neighbour.label}
      </Text>
    </Button>
  );
}

function NeighbourGroup({
  title,
  keys,
  neighbourByKey,
  neighbourMastery,
  onNavigate,
}: {
  title: string;
  keys: string[];
  neighbourByKey: Map<string, NeighbourNode>;
  neighbourMastery: Record<
    string,
    { mastery: MasteryState; automaticity: number; retentionLabel: RetLabel }
  >;
  onNavigate?: (nodeKey: string, label: string) => void;
}) {
  const items = keys
    .map((key) => neighbourByKey.get(key))
    .filter((n): n is NeighbourNode => !!n);
  if (items.length === 0) return null;
  return (
    <Box mb={3}>
      <Text
        fontSize="2xs"
        fontWeight="700"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.04em"
        fontFamily="heading"
        mb={1.5}
      >
        {title}
      </Text>
      <Flex wrap="wrap" gap={1.5}>
        {items.map((neighbour) => (
          <NeighbourChip
            key={neighbour.nodeKey}
            neighbour={neighbour}
            mastery={neighbourMastery[neighbour.nodeKey]?.mastery}
            onNavigate={onNavigate}
          />
        ))}
      </Flex>
    </Box>
  );
}

export function SkillNeighbourhoodPanel({
  nodeKey,
  scholarId,
  onNavigate,
}: {
  nodeKey: string;
  scholarId?: Id<"users">;
  onNavigate?: (nodeKey: string, label: string) => void;
}) {
  const { user } = useCurrentUser();
  const canEditStories = isCurriculumRole(
    (user?.role ?? undefined) as Role | undefined,
  );

  const data = useQuery(
    api.nodeNeighbourhood.neighbourhood,
    nodeKey
      ? {
          nodeKey,
          ...(scholarId ? { scholarId } : {}),
        }
      : "skip",
  ) as NeighbourhoodData | undefined;

  const layout = useMemo(() => {
    if (!data) return null;
    const { node, edges, neighbours } = data;
    const neighbourByKey = new Map<string, NeighbourNode>(
      neighbours.map((n) => [n.nodeKey, n]),
    );
    const prereqKeys = edges
      .filter((e) => e.relation === "dependency" && e.toKey === node.nodeKey)
      .map((e) => e.fromKey);
    const unlockKeys = edges
      .filter((e) => e.relation === "dependency" && e.fromKey === node.nodeKey)
      .map((e) => e.toKey);
    return { neighbourByKey, prereqKeys, unlockKeys };
  }, [data]);

  if (!nodeKey) return null;

  if (data === undefined) {
    return (
      <Flex align="center" gap={2} py={3}>
        <Spinner size="sm" color="violet.500" />
        <Text fontSize="sm" color="charcoal.400">
          Loading neighbourhood…
        </Text>
      </Flex>
    );
  }

  if (data === null || !layout) {
    return (
      <Text fontSize="sm" color="charcoal.400">
        No linked skills or stories yet.
      </Text>
    );
  }

  const isEmpty =
    layout.prereqKeys.length === 0 &&
    layout.unlockKeys.length === 0 &&
    (data.node.standardCodes?.length ?? 0) === 0 &&
    data.stories.length === 0;

  if (isEmpty) {
    return (
      <Text fontSize="sm" color="charcoal.400">
        No linked skills or stories yet.
      </Text>
    );
  }

  return (
    <Box>
      {data.node.standardCodes && data.node.standardCodes.length > 0 && (
        <Box mb={3}>
          <Text
            fontSize="2xs"
            fontWeight="700"
            color="charcoal.400"
            textTransform="uppercase"
            letterSpacing="0.04em"
            fontFamily="heading"
            mb={1.5}
          >
            Standards
          </Text>
          <Flex wrap="wrap" gap={1.5}>
            {data.node.standardCodes.map((standard) => (
              <Badge
                key={`${standard.framework}-${standard.code}`}
                colorPalette="gray"
                variant="subtle"
                size="sm"
              >
                {standard.framework} {standard.code}
              </Badge>
            ))}
          </Flex>
        </Box>
      )}
      <NeighbourGroup
        title="Builds on"
        keys={layout.prereqKeys}
        neighbourByKey={layout.neighbourByKey}
        neighbourMastery={data.neighbourMastery}
        onNavigate={onNavigate}
      />
      <NeighbourGroup
        title="Leads to"
        keys={layout.unlockKeys}
        neighbourByKey={layout.neighbourByKey}
        neighbourMastery={data.neighbourMastery}
        onNavigate={onNavigate}
      />
      {data.stories.length > 0 && (
        <Box mt={2}>
          <NodeStoryFamily
            focalKey={nodeKey}
            stories={data.stories}
            canEdit={canEditStories}
            onNavigate={onNavigate}
          />
        </Box>
      )}
    </Box>
  );
}

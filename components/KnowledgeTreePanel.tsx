"use client";

/**
 * KnowledgeTreePanel — the "daylight" Knowledge Tree lens, teacher-facing.
 *
 * Reads `knowledgeTree.frontierForScholar` and renders the scholar's local
 * frontier as a light node-graph: mastered nodes filled, the frontier
 * highlighted, gaps drawn dashed with a visible "why". Standard tags ride on
 * each node. Light mode is the visual shorthand for structure (vs. the dark
 * Interpretive star-chart). See review/learning-lenses-plan.md.
 */

import { Box, Spinner, Text, Stack, Flex } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// Fixed layout for the small fractions DAG (left→right by prerequisite order).
const POS: Record<string, { x: number; y: number }> = {
  partition: { x: 12, y: 30 },
  equivalent: { x: 38, y: 22 },
  quantity: { x: 38, y: 64 },
  compare: { x: 40, y: 90 },
  addsub: { x: 68, y: 44 },
  commondenom: { x: 90, y: 44 },
};

const STATUS_STYLE: Record<
  string,
  { bg: string; border: string; dashed?: boolean; color: string; tag: string }
> = {
  demonstrated: { bg: "#e7f5ee", border: "#9ed7b6", color: "#1f2329", tag: "mastered" },
  frontier: { bg: "#fbf4dd", border: "#e3c766", color: "#7a5f1c", tag: "frontier — next" },
  gap: { bg: "#fbeee6", border: "#e3b48f", dashed: true, color: "#9a4f2c", tag: "gap" },
  probed: { bg: "#fcf8ec", border: "#ecd99a", color: "#7a5f1c", tag: "probed" },
  locked: { bg: "#fafbfc", border: "#e4e8ee", color: "#9aa3af", tag: "locked" },
};

export function KnowledgeTreePanel({ scholarId }: { scholarId: Id<"users"> }) {
  const data = useQuery(api.knowledgeTree.frontierForScholar, { scholarId });

  if (data === undefined) {
    return (
      <Box h="320px" display="flex" alignItems="center" justifyContent="center">
        <Spinner color="green.400" />
      </Box>
    );
  }

  const nodeByKey = new Map(data.nodes.map((n) => [n.key, n]));
  const gaps = data.nodes.filter((n) => n.status === "gap");

  return (
    <Stack gap={3}>
      <Flex align="baseline" gap={2}>
        <Text fontFamily="heading" fontWeight="700" fontSize="lg" color="navy.600">
          🌳 Skills Tree
        </Text>
        <Text fontSize="sm" color="charcoal.400">
          {data.domain} · structure &amp; what&apos;s next
        </Text>
      </Flex>

      <Box
        position="relative"
        h="340px"
        borderRadius="xl"
        borderWidth="1px"
        borderColor="gray.200"
        overflow="hidden"
        css={{
          backgroundImage:
            "radial-gradient(circle at 16px 16px, #eef1f6 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      >
        {/* edges */}
        <Box
          as="svg"
          position="absolute"
          inset={0}
          width="100%"
          height="100%"
          // @ts-expect-error chakra svg passthrough
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {data.edges.map((e) => {
            const a = POS[e.from];
            const b = POS[e.to];
            if (!a || !b) return null;
            const toStatus = nodeByKey.get(e.to)?.status;
            const fromStatus = nodeByKey.get(e.from)?.status;
            const isGapEdge = fromStatus === "gap";
            const color = isGapEdge
              ? "#e3b48f"
              : toStatus === "frontier"
                ? "#e3c766"
                : "#9ed7b6";
            return (
              <line
                key={`${e.from}-${e.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={color}
                strokeWidth="0.5"
                strokeDasharray={isGapEdge ? "1.6 1.2" : undefined}
              />
            );
          })}
        </Box>

        {/* nodes */}
        {data.nodes.map((n) => {
          const p = POS[n.key];
          if (!p) return null;
          const s = STATUS_STYLE[n.status] ?? STATUS_STYLE.locked;
          return (
            <Box
              key={n.key}
              position="absolute"
              left={`${p.x}%`}
              top={`${p.y}%`}
              transform="translate(-50%,-50%)"
              bg={s.bg}
              borderWidth="1.5px"
              borderStyle={s.dashed ? "dashed" : "solid"}
              borderColor={s.border}
              borderRadius="lg"
              px={2.5}
              py={1.5}
              minW="96px"
              textAlign="center"
              title={n.gapReason ?? n.evidence ?? ""}
              zIndex={2}
            >
              <Text fontSize="xs" fontWeight="600" color={s.color} lineHeight="1.2">
                {n.label}
              </Text>
              <Text fontSize="9px" color={s.color} opacity={0.85}>
                {n.status === "gap" ? "⚠ " : ""}
                {s.tag}
              </Text>
              {typeof n.fluency === "number" && n.fluency > 0 && (
                <Box
                  position="absolute"
                  top="-6px"
                  right="-6px"
                  display="flex"
                  gap="2px"
                  title={`Automaticity: ${["", "effortful", "fluent", "automatic"][n.fluency]} (external practice)`}
                >
                  {[1, 2, 3].map((d) => (
                    <Box
                      key={d}
                      w="7px"
                      h="7px"
                      transform="rotate(45deg)"
                      borderRadius="1px"
                      bg={d <= n.fluency! ? "#2f9e6b" : "transparent"}
                      borderWidth="1px"
                      borderColor={d <= n.fluency! ? "#2f9e6b" : "#bcd6c6"}
                    />
                  ))}
                </Box>
              )}
              {n.standard && (
                <Box
                  display="inline-block"
                  mt={1}
                  fontSize="8px"
                  fontWeight="700"
                  color="#5a6a3f"
                  bg="#eef3e3"
                  borderWidth="1px"
                  borderColor="#d3e0bd"
                  borderRadius="sm"
                  px={1}
                >
                  {n.standard}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* gap diagnoses — the visible "why" */}
      {gaps.length > 0 && (
        <Stack gap={1.5}>
          {gaps.map((g) => (
            <Flex
              key={g.key}
              gap={2}
              align="flex-start"
              bg="#fbeee6"
              borderLeftWidth="3px"
              borderLeftColor="#c2683f"
              borderRadius="0 8px 8px 0"
              px={3}
              py={2}
            >
              <Text fontSize="sm">⚠</Text>
              <Box>
                <Text fontSize="sm" fontWeight="600" color="#9a4f2c">
                  Gap: {g.label}
                </Text>
                <Text fontSize="xs" color="#9a4f2c">
                  {g.gapReason}
                  {g.evidence ? ` — ${g.evidence}` : ""}
                </Text>
              </Box>
            </Flex>
          ))}
        </Stack>
      )}
      <Text fontSize="xs" color="charcoal.400">
        A gap is never just &quot;not yet learned&quot; — only an unmet concept that&apos;s
        load-bearing for where {`they're`} working now (an open misconception, or a
        prerequisite blocking the frontier). Every gap shows its evidence and is
        dismissable.
      </Text>

      {/* Standards "tag" projection — the same tree grouped by official CCSS code,
          for when a teacher needs coverage language (reporting). Not a lens. */}
      {data.nodes.some((n) => n.standard) && (
        <Box mt={1} borderTopWidth="1px" borderColor="gray.100" pt={3}>
          <Text fontSize="xs" fontWeight="700" color="charcoal.500" textTransform="uppercase" letterSpacing="0.04em" mb={2}>
            Standards coverage <Text as="span" fontWeight="400" textTransform="none">— the same tree, by CCSS code</Text>
          </Text>
          <Stack gap={1}>
            {data.nodes
              .filter((n) => n.standard)
              .map((n) => {
                const evidenced = n.status === "demonstrated";
                const flagged = n.status === "gap";
                return (
                  <Flex key={n.key} align="center" gap={2} fontSize="xs" py={0.5}>
                    <Box
                      as="span"
                      fontWeight="700"
                      color="#5a6a3f"
                      bg="#eef3e3"
                      borderWidth="1px"
                      borderColor="#d3e0bd"
                      borderRadius="sm"
                      px={1.5}
                      minW="62px"
                      textAlign="center"
                    >
                      {n.standard}
                    </Box>
                    <Text color="charcoal.500" flex={1}>{n.label}</Text>
                    <Text
                      color={evidenced ? "#1f7a52" : flagged ? "#9a4f2c" : "charcoal.300"}
                      fontWeight={evidenced || flagged ? 600 : 400}
                    >
                      {evidenced ? "● evidenced" : flagged ? "○ ⚠ gap" : "○ not yet"}
                    </Text>
                  </Flex>
                );
              })}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

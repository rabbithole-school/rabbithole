"use client";

/**
 * ConceptStarMap — the node-level "View in star map" pivot. Given one grounded
 * concept, calls openMap.leapsForConcept and renders the open-map neighborhood
 * as a dark constellation: the concept at the hub, generative transdisciplinary
 * leaps radiating out (near → far by reach), each with its "because" bridge.
 *
 * The grounded tree and the open map are separate graphs; this is the shared
 * anchor that lets you flip from the disciplined view to the curious one. See
 * review/knowledge-tree-expansion.html §6.
 */

import { useEffect, useState } from "react";
import { Box, Flex, Spinner, Stack, Text } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SKY_BG, colorForKey } from "@/components/sky/skyVisuals";

type Leap = { topic: string; bridge: string; domain: string; reach: number };

export function ConceptStarMap({
  concept,
  grounding,
  onClose,
  backLabel,
}: {
  concept: string;
  grounding?: string;
  onClose: () => void;
  /** When set, the header shows a left-aligned "← {backLabel}" control (and no
   *  right X) — used when this is the anchored Sky view. */
  backLabel?: string;
}) {
  const leapsForConcept = useAction(api.openMap.leapsForConcept);
  const [leaps, setLeaps] = useState<Leap[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale results while the external concept request changes.
    setLeaps(null);
    setError(null);
    leapsForConcept({ concept, grounding })
      .then((r) => alive && setLeaps(r.leaps))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [concept, grounding, leapsForConcept]);

  // Place leaps around the hub: angle by index, radius by reach (near→far).
  const placed = (leaps ?? []).map((l, i, arr) => {
    const angle = (i / Math.max(1, arr.length)) * Math.PI * 2 - Math.PI / 2;
    const radius = 24 + l.reach * 12; // % of the box
    return {
      ...l,
      leftPct: 50 + Math.cos(angle) * radius,
      topPct: 50 + Math.sin(angle) * radius * 0.84,
    };
  });

  return (
    <Box
      data-testid="concept-star-map"
      mt={3}
      borderRadius="xl"
      overflow="hidden"
      borderWidth="1px"
      borderColor="#2a2350"
    >
      <Flex align="center" gap={3} bg="#1a1438" px={4} py={2}>
        {backLabel && (
          <Box
            as="button"
            data-testid="sky-anchor-clear"
            onClick={onClose}
            flexShrink={0}
            color="#cdbef2"
            _hover={{ color: "#efe9ff" }}
            fontSize="xs"
            fontWeight="700"
            whiteSpace="nowrap"
          >
            ← {backLabel}
          </Box>
        )}
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="sm"
          color="#cdbef2"
          lineClamp={1}
          flex="1"
          minW={0}
        >
          🌌 Open map
          <Text as="span" color="#9b8fd0" fontWeight="500">
            {" "}· {concept}
          </Text>
        </Text>
        {!backLabel && (
          <Box
            as="button"
            data-testid="concept-star-map-close"
            onClick={onClose}
            flexShrink={0}
            color="#9b8fd0"
            _hover={{ color: "#efe9ff" }}
            aria-label="Close"
          >
            <X size={16} weight="bold" />
          </Box>
        )}
      </Flex>

      <Box position="relative" h="300px" css={{ background: SKY_BG }} overflow="hidden">
        {leaps === null && !error && (
          <Flex h="full" align="center" justify="center" gap={2}>
            <Spinner color="#a99ee0" size="sm" />
            <Text fontSize="xs" color="#9b8fd0">
              Finding true leaps across human knowledge…
            </Text>
          </Flex>
        )}
        {error && (
          <Flex h="full" align="center" justify="center" px={6}>
            <Text fontSize="xs" color="#c98fa8" textAlign="center">
              Couldn&apos;t reach the open map right now. {error}
            </Text>
          </Flex>
        )}
        {leaps && leaps.length > 0 && (
          <>
            {/* lines hub → leaps */}
            <Box as="svg" position="absolute" inset={0} width="100%" height="100%">
              {placed.map((p, i) => (
                <line
                  key={i}
                  x1="50%"
                  y1="50%"
                  x2={`${p.leftPct}%`}
                  y2={`${p.topPct}%`}
                  stroke="#3a2d70"
                  strokeWidth="1"
                />
              ))}
            </Box>
            {/* hub */}
            <Box
              position="absolute"
              left="50%"
              top="50%"
              transform="translate(-50%,-50%)"
              bg="#caa23a"
              color="#231a05"
              borderRadius="full"
              px={3}
              py={2}
              maxW="160px"
              textAlign="center"
              boxShadow="0 0 24px rgba(202,162,58,0.5)"
              zIndex={2}
            >
              <Text fontSize="10px" fontWeight="800" lineClamp={3} lineHeight="1.2">
                {concept}
              </Text>
            </Box>
            {/* leap stars */}
            {placed.map((p, i) => {
              const color = colorForKey(p.domain);
              return (
                <Box
                  key={i}
                  data-testid="open-map-leap"
                  data-domain={p.domain}
                  position="absolute"
                  left={`${p.leftPct}%`}
                  top={`${p.topPct}%`}
                  transform="translate(-50%,-50%)"
                  maxW="150px"
                  textAlign="center"
                  title={p.bridge}
                  zIndex={1}
                >
                  <Box
                    mx="auto"
                    w="10px"
                    h="10px"
                    borderRadius="full"
                    bg={color}
                    boxShadow={`0 0 10px ${color}`}
                    mb={1}
                  />
                  <Text fontSize="10px" fontWeight="700" color="#efe9ff" lineClamp={2} lineHeight="1.15">
                    {p.topic}
                  </Text>
                  <Text fontSize="8px" color={color} fontWeight="700" textTransform="uppercase" letterSpacing="0.04em">
                    {p.domain}
                  </Text>
                </Box>
              );
            })}
          </>
        )}
      </Box>

      {/* bridges (the "because" — visible, never hidden) */}
      {leaps && leaps.length > 0 && (
        <Stack gap={1} bg="#13102b" px={4} py={3}>
          {leaps.map((l, i) => (
            <Text key={i} fontSize="11px" color="#b3acd6">
              <Text as="span" color={colorForKey(l.domain)} fontWeight="700">
                {l.topic}
              </Text>{" "}
              — {l.bridge}
            </Text>
          ))}
          <Text fontSize="10px" color="#6f659e" mt={1}>
            Generated fresh — the curiosity lens (a separate graph from the
            grounded tree, sharing this concept as its anchor). The factuality
            bar is in the prompt: every leap must be true.
          </Text>
        </Stack>
      )}
    </Box>
  );
}

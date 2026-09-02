"use client";

/**
 * MapArtifactView — the bridge between a stored `type: "map"` artifact and the
 * pure {@link ./GeoMap} renderer. It parses the artifact `content` as a
 * `StoredMapArtifact` (tolerant: bad JSON → a small error card), renders the
 * spec, and owns the scholar-pin round-trip: optimistic local state on
 * drop/remove, persisted via the owner-only `scholarSetMapPins` mutation.
 *
 */
import { useCallback, useMemo } from "react";
import { useMutation } from "convex/react";
import { Box, Button, Center, Flex, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  GEOMAP_MAX_SCHOLAR_PINS,
  type LngLat,
  type ScholarPin,
  type StoredMapArtifact,
} from "@/lib/geomap/types";
import GeoMap from "./GeoMap";

const scholarSetMapPins = api.artifacts.scholarSetMapPins;

/** Tolerant parse — a stored map artifact whose content we can actually render. */
function parseStoredMap(content: string): StoredMapArtifact | null {
  try {
    const parsed = JSON.parse(content) as StoredMapArtifact;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.spec || typeof parsed.spec !== "object") return null;
    if (!parsed.spec.camera || !parsed.spec.base) return null;
    return {
      v: 1,
      spec: parsed.spec,
      scholarPins: Array.isArray(parsed.scholarPins) ? parsed.scholarPins : [],
    };
  } catch {
    return null;
  }
}

function newPinId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface MapArtifactViewProps {
  artifactId?: Id<"artifacts">;
  content: string;
  token: string | null;
  compact?: boolean;
  /** Owner-only surfaces persist pin edits; read-only ones (e.g. staff) don't. */
  readOnly?: boolean;
  /** Send a scholar-voice turn so the tutor reacts to the current pins. When
   *  omitted (or read-only), the commit button isn't shown. */
  onMapCommit?: (text: string) => void;
  /** A turn is already streaming — disable the commit button. */
  isStreaming?: boolean;
  /** Kickoff is still blocking sends (SessionInterface won't accept a turn) —
   *  disable the commit button so it's enabled exactly when the send path is. */
  kickoffBlocksSending?: boolean;
}

export function MapArtifactView({
  artifactId,
  content,
  token,
  compact,
  readOnly = false,
  onMapCommit,
  isStreaming = false,
  kickoffBlocksSending = false,
}: MapArtifactViewProps) {
  const stored = useMemo(() => parseStoredMap(content), [content]);
  const setPinsMutation = useMutation(scholarSetMapPins);

  // Pins are rendered straight from the stored artifact; a drop/remove persists
  // through the owner-only mutation and Convex reactivity refreshes `content`
  // (which re-parses here). No local mirror state — the one-map merge keeps the
  // kid's pins intact across tutor spec updates.
  const persist = useCallback(
    (next: ScholarPin[]) => {
      if (!artifactId) return;
      void setPinsMutation({ artifactId, pins: next }).catch((err) => {
        console.error("Failed to save map pins:", err);
      });
    },
    [artifactId, setPinsMutation],
  );

  const handlePinDrop = useCallback(
    (lngLat: LngLat) => {
      if (!stored) return;
      if (stored.scholarPins.length >= GEOMAP_MAX_SCHOLAR_PINS) return;
      persist([...stored.scholarPins, { id: newPinId(), lngLat }]);
    },
    [stored, persist],
  );

  const handlePinRemove = useCallback(
    (pinId: string) => {
      if (!stored) return;
      persist(stored.scholarPins.filter((p) => p.id !== pinId));
    },
    [stored, persist],
  );

  const handlePinsClear = useCallback(() => {
    persist([]);
  }, [persist]);

  // The commit affordance: a task map asks the tutor to CHECK the answer; an
  // explore map just shares the pins. Same send path either way (onMapCommit →
  // SessionInterface's typed send+stream).
  const hasTask = !!stored?.spec.task;
  const commitLabel = hasTask ? "Check my answer" : "Share my pins with my tutor";
  const commitUtterance = hasTask
    ? "I placed my answer on the map — can you check it?"
    : "I dropped my pins on the map — take a look.";
  const noPins = !stored || stored.scholarPins.length === 0;
  const showCommit = !readOnly && !!onMapCommit;
  // Enabled exactly when SessionInterface's send path would accept the turn:
  // pins present, not mid-stream, and kickoff not blocking.
  const commitDisabled = noPins || isStreaming || kickoffBlocksSending;
  const handleCommit = useCallback(() => {
    if (!onMapCommit || commitDisabled) return;
    onMapCommit(commitUtterance);
  }, [onMapCommit, commitDisabled, commitUtterance]);

  if (!stored) {
    return (
      <Center h="100%" w="100%" bg="white" p={6}>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400" textAlign="center">
          This map couldn&apos;t be opened.
        </Text>
      </Center>
    );
  }

  return (
    <Flex direction="column" h="100%" w="100%">
      <Box flex={1} minH={0}>
        <GeoMap
          spec={stored.spec}
          scholarPins={stored.scholarPins}
          onPinDrop={readOnly ? undefined : handlePinDrop}
          onPinRemove={readOnly ? undefined : handlePinRemove}
          onPinsClear={readOnly ? undefined : handlePinsClear}
          token={token}
          compact={compact}
        />
      </Box>
      {showCommit && (
        <Flex
          justify="flex-end"
          align="center"
          px={compact ? 3 : 4}
          py={compact ? 2 : 3}
          borderTopWidth="1px"
          borderColor="blackAlpha.100"
          bg="white"
        >
          <Button
            size={compact ? "xs" : "sm"}
            colorPalette="teal"
            onClick={handleCommit}
            disabled={commitDisabled}
          >
            {commitLabel}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

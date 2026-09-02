"use client";

/**
 * GeoLocate — the geography sibling of `coordinatePlane`: instead of a math
 * grid, the scholar drops pin(s) on a REAL map (the shared GeoMap renderer) to
 * answer a graded locate/region/pinSet task. The map, its base, camera, and the
 * (redacted) task all come from the framework-free `GeoLocateSpec.map`; this
 * component owns only the pin state + the manipulative host handshake.
 *
 * Pin rules follow the task shape:
 *   • locate / region — a SINGLE answer: a new tap REPLACES the pin (one max).
 *   • pinSet          — up to N pins (N = task.targets.length), each removable.
 *
 * The optimistic self-check (via `geoLocateSolved`) is UI only — in practice
 * mode the host shows the SERVER's verdict, and the served task is redacted, so
 * this can't reveal the answer. Grading is authoritative server-side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KindProps } from "../Manipulative";
import type { GeoLocateSpec } from "@/lib/manipulative/types";
import type { GeoTask, LngLat, ScholarPin } from "@/lib/geomap/types";
import { GEOMAP_MAX_TASK_TARGETS } from "@/lib/geomap/types";
import type { GeoLocateState } from "@/lib/manipulative/logic";
import { geoLocateSolved } from "@/lib/manipulative/logic";
import { resolveRegion } from "@/lib/geomap/registry";
import { Box } from "@chakra-ui/react";
import GeoMap from "@/components/geomap/GeoMap";

/** How many pins this task accepts: N for a pinSet, otherwise a single answer. */
function maxPinsForTask(task: GeoTask): number {
  if (task.kind === "pinSet") {
    return Math.min(Math.max(task.targets.length, 1), GEOMAP_MAX_TASK_TARGETS);
  }
  return 1;
}

export function GeoLocateManipulative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<GeoLocateSpec>) {
  const maxPins = useMemo(() => maxPinsForTask(spec.map.task), [spec.map.task]);
  const [pins, setPins] = useState<ScholarPin[]>([]);
  // Monotonic pin ids — stable across re-renders, unique within this board.
  const nextId = useRef(0);

  const onPinDrop = useCallback(
    (lngLat: LngLat) => {
      const pin: ScholarPin = { id: `pin-${nextId.current++}`, lngLat };
      setPins((prev) => {
        // Single-answer tasks: a new tap REPLACES the pin (last answer wins).
        if (maxPins <= 1) return [pin];
        // pinSet: append until the cap, then ignore extra taps (the scholar
        // removes a pin to place a different one).
        if (prev.length >= maxPins) return prev;
        return [...prev, pin];
      });
    },
    [maxPins],
  );

  const onPinRemove = useCallback((pinId: string) => {
    setPins((prev) => prev.filter((p) => p.id !== pinId));
  }, []);

  const onPinsClear = useCallback(() => {
    setPins([]);
  }, []);

  useEffect(() => {
    const state: GeoLocateState = { pins };
    // resolveRegion is harmless for locate/pinSet and correct for a `region`
    // task in the dev/standalone path (where the spec is unredacted); in
    // practice mode the served task is redacted, so this stays optimistic-only.
    onSolvedChange(geoLocateSolved(spec, state, resolveRegion));
    onStateChange?.(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, JSON.stringify(pins), onSolvedChange, onStateChange]);

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? null;

  // GeoMap (both its tokenless offline state and the real MapCanvas) sizes to
  // h=100%, so it needs an explicitly-sized parent — every other manipulative
  // kind renders intrinsically-sized SVG/Mafs content, but this one doesn't.
  // A 16/9 aspect ratio (the house idiom, matching ArtifactPanel's map region)
  // keeps the map responsive inside the max-width 620px card, with a minH floor
  // so the offline state stays legible on narrow screens.
  return (
    <Box
      borderRadius="12px"
      overflow="hidden"
      minH="220px"
      css={{ aspectRatio: "16 / 9" }}
    >
      <GeoMap
        spec={spec.map}
        scholarPins={pins}
        onPinDrop={onPinDrop}
        onPinRemove={onPinRemove}
        onPinsClear={onPinsClear}
        token={token}
      />
    </Box>
  );
}

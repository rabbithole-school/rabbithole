"use client";

/**
 * The center stage: an SVG render of one SceneFrame + a replay scrubber + a
 * downsampled metric strip. Web is mouse-first ("the office", plan §12):
 * wheel/buttons zoom, drag-pan, click an automaton to inspect it — and every
 * one of those is also keyboard/AT reachable (review Finding 6).
 *
 * TRUTH BEFORE DECORATION (review Finding 1): recorded position and ambient bob
 * live on SEPARATE transform layers (see components/workbench/viewport.ts). The
 * outer layer owns the exact recorded cell and the eased tween; the inner layer
 * owns the additive bob. The bob can never move an automaton off its cell.
 *
 * HONEST REPLAY (review Finding 2): the live scene is shown ONLY when the view
 * is parked at the live head. While scrubbing, an unavailable frame renders a
 * loading state tied to the requested day — never the live head under a past
 * day's label.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex, HStack, Spinner, Text } from "@chakra-ui/react";
import {
  ArrowCounterClockwise,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "@phosphor-icons/react";

import type {
  EcosystemBiomeId,
  EcosystemGridConfig,
  EcosystemLandscapeConfig,
  SimulatorSceneV1,
  SimulatorSpec,
} from "@/lib/simulator/contract";
import {
  projectEcosystemSense,
  type EcosystemInspectableSenseId,
  type EcosystemSenseProjection,
} from "@/lib/simulator/ecosystemPerception";
import {
  getWorkbenchRendererFamily,
  workbenchTimeNoun,
} from "@/lib/simulator/templates/registry";
import {
  ECOSYSTEM_LANDSCAPE_BANDS,
  ecosystemLandscapeVisualPaths,
  generateEcosystemLandscape,
} from "@/lib/simulator/ecosystemLandscape";
import {
  ecosystemBiome,
  ecosystemCurrentScreenVector,
  ecosystemPhysicsTerrainPositionSet,
  ecosystemTerrainKindHasPhysics,
  ecosystemTerrainSurfaceColor,
} from "@/lib/simulator/ecosystemTerrainTiles";
import type {
  EcosystemSenseEvidenceRequest,
  PopulationTraitEvidence,
} from "@/lib/simulator/scene";
import { ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS } from "@/lib/simulator/scene";
import { ECOSYSTEM_TRAIT_DOMAIN } from "@/lib/simulator/templates/ecosystemGrid";
import {
  clampIsometricCamera,
  DEFAULT_ISOMETRIC_GEOMETRY,
  fitIsometricCamera,
  fittedIsometricPoint,
  isometricCellAtScreen,
  isometricCellCenter,
  isometricScreenPoint,
  isometricTileDiamond,
  isometricWorldBounds,
  sortIsometricDepth,
  type IsoCamera,
  type IsoFit,
  type IsoSize,
} from "@/lib/simulator/isometricProjection";
import type { SceneFrame } from "@/hooks/useWorkbenchScene";
import type { SimulatorRun } from "@/hooks/useWorkbenchData";
import {
  AMBIENT_BOB_PX,
  chartMetricKeys,
  chartTimeSpan,
  criterionMetricKey,
  formatMetric,
  metricLabel,
  runCriterionScore,
} from "./helpers";
import {
  automatonLayout,
  clientDragToViewBox,
  clientPointToViewBox,
  isPointInViewBox,
  pointerPan,
} from "./viewport";
import { isPoolEntityKind, isRoundTokenEntityKind, tokenBadgeGlyph } from "./helpers";

// Bob is an ADDITIVE translateY on the INNER layer — it composes over the outer
// layer's recorded position and is disabled under reduced-motion.
const BOB_KEYFRAMES = `
@keyframes wb-bob { 0% { transform: translateY(0); } 50% { transform: translateY(-${AMBIENT_BOB_PX}px); } 100% { transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .wb-bob { animation: none !important; } }
`;

// ── Algae as DISCRETE, kid-legible units (not a continuous green wash) ────────
// The ecosystemGrid template caps a cell's resource biomass at RESOURCE_CAPACITY
// (= 10) and the scene frame exposes it as `intensity = biomass / 10` (0…1). We
// bucket that into a discrete 0–3 so a child reads quantity by COUNTING charm
// sprites ("3 → 2 → 1 → none"), not by decoding a shade of green. Full cell = 3.
// Web ↔ native parity: identical thresholds + top-left corner cluster.
export const ALGAE_ICON_LABEL = "algae";
const ALGAE_PIP_OFFSETS = [
  { x: 0.18, y: 0.18 },
  { x: 0.4, y: 0.18 },
  { x: 0.18, y: 0.4 },
] as const;
function algaeLevel(intensity: number): number {
  const clamped = Math.min(1, Math.max(0, intensity));
  if (clamped <= 0) return 0;
  // (0, 1/3] → 1 · (1/3, 2/3] → 2 · (2/3, 1] → 3 (biomass 0–3.33 · 3.33–6.67 · 6.67–10)
  return Math.min(3, Math.ceil(clamped * 3));
}

interface ProjectionWorld {
  fit: IsoFit;
  viewport: IsoSize;
}

function useCamera(
  worldRef: React.RefObject<ProjectionWorld | null>,
  svgRef: React.RefObject<SVGSVGElement | null>,
) {
  const [camera, setCamera] = useState<IsoCamera>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{
    startX: number;
    startY: number;
    camX: number;
    camY: number;
    moved: boolean;
  } | null>(null);

  const zoomBy = useCallback(
    (factor: number) => {
      setCamera((current) => {
        const world = worldRef.current;
        return clampIsometricCamera(
          { ...current, scale: current.scale * factor },
          world?.fit ?? null,
          world?.viewport ?? { width: 1, height: 1 },
        );
      });
    },
    [worldRef],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (event.deltaY === 0) return;
      setCamera((current) => {
        const world = worldRef.current;
        return clampIsometricCamera(
          { ...current, scale: current.scale * (event.deltaY < 0 ? 1.1 : 0.9) },
          world?.fit ?? null,
          world?.viewport ?? { width: 1, height: 1 },
        );
      });
    },
    [worldRef],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!svgRef.current || !worldRef.current) return;
      drag.current = {
        startX: event.clientX,
        startY: event.clientY,
        camX: camera.x,
        camY: camera.y,
        moved: false,
      };
    },
    [camera.x, camera.y, svgRef, worldRef],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      const { moved, pan } = pointerPan({ dx, dy, moved: state.moved });
      state.moved = moved;
      // Do NOT pan below the threshold — a plain click must not shift the scene
      // out from under the pointer (QB walkthrough W1), or no `click` is ever
      // synthesized on the automaton. Clamp so a drag can't reveal empty space.
      if (pan) {
        const svg = svgRef.current;
        const world = worldRef.current;
        if (!svg || !world) return;
        const viewDelta = clientDragToViewBox(
          { x: state.startX, y: state.startY },
          { x: event.clientX, y: event.clientY },
          svg.getBoundingClientRect(),
          world.viewport,
        );
        if (!viewDelta) return;
        setCamera((current) => {
          return clampIsometricCamera(
            {
              ...current,
              x: state.camX + viewDelta.dx,
              y: state.camY + viewDelta.dy,
            },
            world.fit,
            world.viewport,
          );
        });
      }
    },
    [svgRef, worldRef],
  );

  const onPointerUp = useCallback(() => {
    // Do NOT null `drag.current` here. The browser dispatches `click` AFTER
    // pointerup for the same gesture (pointerdown → pointerup → click), and
    // `consumedDrag()` below is read from that trailing click's handler
    // (onSelectGuarded) to decide whether a pan drag should suppress
    // selection. Clearing synchronously in pointerup meant the click always
    // saw `null` (i.e. "not consumed"), so a real pan drag ALSO selected the
    // automaton it ended over — the guard was dead code. The next
    // pointerdown always overwrites this with a fresh gesture, so leaving
    // the finished gesture's state around until then is safe.
  }, []);

  // Unlike a real release, a pointer LEAVING the viewport mid-drag is never
  // followed by a click on an entity inside it (the event target has
  // changed), so nothing needs to read `moved` afterward — clear immediately
  // so a drag doesn't appear to resume with stale start coordinates if the
  // same press re-enters the viewport.
  const onPointerLeave = useCallback(() => {
    drag.current = null;
  }, []);

  // A drag consumed the gesture, so a trailing click should not also select.
  const consumedDrag = useCallback(() => drag.current?.moved ?? false, []);

  // Re-clamp against the world that is now known. A camera panned/zoomed while
  // the scene was still loading — or held across a run whose world is SMALLER —
  // would otherwise sit out of bounds (showing empty space) until the next
  // pointer event, so the caller runs this the moment the bounds change.
  const clampToWorld = useCallback(() => {
    setCamera((current) => {
      const world = worldRef.current;
      return clampIsometricCamera(
        current,
        world?.fit ?? null,
        world?.viewport ?? { width: 1, height: 1 },
      );
    });
  }, [worldRef]);

  return {
    camera,
    zoomBy,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    consumedDrag,
    clampToWorld,
  };
}

type EcosystemCertaintyCell = { x: number; y: number; opacity: number };

/** Each mark is a replay-confirmed cell, never a projection of the current world. */
function ecosystemCertaintyCells(
  frame: SceneFrame | null,
  actorId: string | null,
  senseId: EcosystemInspectableSenseId | "world",
): EcosystemCertaintyCell[] {
  if (!frame || !actorId || senseId === "world") return [];
  const confirmations = (frame.ecosystemSenseConfirmations ?? []).filter(
    (confirmation) => confirmation.actorId === actorId && confirmation.senseId === senseId,
  );
  if (confirmations.length === 0) return [];
  const currentDecisionTick = Math.max(0, frame.tick - 1);
  const latestByCell = new Map<string, number>();
  for (const confirmation of confirmations) {
    for (const cell of confirmation.cells) {
      const key = `${cell.x}:${cell.y}`;
      latestByCell.set(key, Math.max(latestByCell.get(key) ?? -Infinity, confirmation.tick));
    }
  }
  return [...latestByCell].flatMap(([key, lastConfirmedTick]) => {
    const age = currentDecisionTick - lastConfirmedTick;
    if (age > ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS) return [];
    const [x, y] = key.split(":").map(Number);
    // The newest pre-action decision is solid; each older confirmation halves.
    return [{ x, y, opacity: 0.32 * 0.5 ** age }];
  });
}

function SceneLayer({
  scene,
  selectedAutomatonId,
  onSelect,
  onSelectKeyboard,
  speciesIcons,
  camera,
  projection,
  svgRef,
  biomeId,
  landscapeConfig,
  physicsTerrainConfig,
  senseProjection,
  certaintyCells = [],
  ariaLabel,
}: {
  scene: SimulatorSceneV1;
  selectedAutomatonId: string | null;
  onSelect: (id: string) => void;
  /** Ungated keyboard activation (Enter/Space) — a keyboard event can never be
   *  a pointer drag, so it must not be gated on the click path's
   *  consumedDrag() guard (see onSelectGuarded below). */
  onSelectKeyboard: (id: string) => void;
  speciesIcons: Record<string, string | undefined>;
  camera: IsoCamera;
  projection: ProjectionWorld;
  svgRef: React.RefObject<SVGSVGElement | null>;
  biomeId?: EcosystemBiomeId;
  landscapeConfig?: EcosystemLandscapeConfig;
  physicsTerrainConfig?: EcosystemGridConfig["terrain"];
  senseProjection?: EcosystemSenseProjection | null;
  certaintyCells?: readonly EcosystemCertaintyCell[];
  ariaLabel: string;
}) {
  const { width, height } = scene.viewport;
  const biome = ecosystemBiome(biomeId);
  const resourceIcon = biome.resource.iconLabel
    ? speciesIcons[biome.resource.iconLabel]
    : undefined;
  const cellByPosition = useMemo(
    () => new Map(scene.cells.map((cell) => [`${cell.x}:${cell.y}`, cell])),
    [scene.cells],
  );
  const tiles = useMemo(
    () =>
      sortIsometricDepth(
        Array.from({ length: width * height }, (_, index) => ({
          id: `tile-${index}`,
          x: index % width,
          y: Math.floor(index / width),
        })),
      ),
    [width, height],
  );
  const tileFaces = useMemo(
    () =>
      tiles.map((tile) => {
        const [top, right, bottom, left] = isometricTileDiamond(tile).map((point) =>
          fittedIsometricPoint(point, projection.fit),
        );
        return { ...tile, top, right, bottom, left };
      }),
    [projection.fit, tiles],
  );
  const landscape = useMemo(
    () =>
      landscapeConfig
        ? generateEcosystemLandscape({ width, height, config: landscapeConfig })
        : undefined,
    [height, landscapeConfig, width],
  );
  const landscapeByPosition = useMemo(
    () =>
      new Map(
        (landscape?.cells ?? []).map((cell) => [`${cell.x}:${cell.y}`, cell]),
      ),
    [landscape],
  );
  const physicsTerrainPositions = useMemo(
    () => ecosystemPhysicsTerrainPositionSet(physicsTerrainConfig),
    [physicsTerrainConfig],
  );
  const entities = useMemo(() => sortIsometricDepth(scene.entities), [scene.entities]);
  const pointString = (points: readonly { x: number; y: number }[]) =>
    points.map((point) => `${point.x},${point.y}`).join(" ");
  const fitPoint = (point: { x: number; y: number }) =>
    fittedIsometricPoint(point, projection.fit);

  // ── Continuous shared-edge terrain ─────────────────────────────────────────
  // A terrain board is structural geometry, not a collage of independently
  // framed images. Every ecosystem cell therefore shares the same exact SVG
  // diamond edges; only its catalog-owned semantic fill varies. Discrete art
  // (shelter species/resources) remains an overlay concern.
  const isEcosystemGrid = scene.templateId === "ecosystemGrid";
  const visualPaths = useMemo(
    () =>
      isEcosystemGrid && landscape && landscapeConfig
        ? ecosystemLandscapeVisualPaths({
            landscape,
            seed: landscapeConfig.seed,
            biomeId: biome.id,
            faces: tileFaces,
            physicsTerrainPositions,
          })
        : null,
    [
      biome.id,
      isEcosystemGrid,
      landscape,
      landscapeConfig,
      physicsTerrainPositions,
      tileFaces,
    ],
  );

  const cellFromPointer = (event: React.MouseEvent<SVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const screenPoint = clientPointToViewBox(
      { x: event.clientX, y: event.clientY },
      rect,
      projection.viewport,
    );
    if (!screenPoint) return null;
    // A click in the centered letterbox margin maps outside the viewBox; the
    // inverse projection could still fold it onto an in-bounds edge cell, so
    // reject out-of-content points before hit-testing.
    if (!isPointInViewBox(screenPoint, projection.viewport)) return null;
    return isometricCellAtScreen(
      screenPoint,
      projection.fit,
      camera,
      scene.viewport,
    );
  };
  const frontmostAutomatonAt = (cell: { x: number; y: number }) => {
    for (let index = entities.length - 1; index >= 0; index -= 1) {
      const candidate = entities[index];
      if (
        candidate.kind === "automaton" &&
        !candidate.hidden &&
        Math.floor(candidate.x) === cell.x &&
        Math.floor(candidate.y) === cell.y
      ) {
        return candidate;
      }
    }
    return null;
  };
  const selectFromPointer = (
    event: React.MouseEvent<SVGGElement>,
    entity: SimulatorSceneV1["entities"][number],
  ) => {
    event.stopPropagation();
    const cell = cellFromPointer(event);
    const candidate = cell ? frontmostAutomatonAt(cell) : null;
    // A sprite can protrude above its floor diamond. In that case the explicit
    // DOM sprite target remains the honest fallback; same-cell overlap resolves
    // through inverse projection and painter order.
    onSelect(entity.automatonId ?? candidate?.id ?? entity.id);
  };
  const selectFromStage = (event: React.MouseEvent<SVGSVGElement>) => {
    const cell = cellFromPointer(event);
    const candidate = cell ? frontmostAutomatonAt(cell) : null;
    if (candidate) onSelect(candidate.id);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${projection.viewport.width} ${projection.viewport.height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
      role="group"
      aria-label={ariaLabel}
      onClick={selectFromStage}
    >
      <style>{BOB_KEYFRAMES}</style>
      <rect
        x={0}
        y={0}
        width={projection.viewport.width}
        height={projection.viewport.height}
        fill={biome.rendering.stageColor}
      />
      <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
        {tileFaces.map((tile) => {
          const { top, right, bottom, left } = tile;
          const depth = DEFAULT_ISOMETRIC_GEOMETRY.tileDepth * projection.fit.scale;
          const cell = cellByPosition.get(`${tile.x}:${tile.y}`);
          const landscapeCell = landscapeByPosition.get(`${tile.x}:${tile.y}`);
          const physicsTerrain = ecosystemTerrainKindHasPhysics(cell?.kind);
          const surfaceColor = isEcosystemGrid
            ? ecosystemTerrainSurfaceColor(cell?.kind, biomeId, landscapeCell?.band)
            : undefined;
          const currentVector = ecosystemCurrentScreenVector(cell?.kind);
          const unknown = isEcosystemGrid && cell !== undefined && surfaceColor === undefined;
          const wallColors =
            landscapeCell && !physicsTerrain
              ? biome.rendering.landscapeWalls[landscapeCell.band]
              : {
                  left: biome.rendering.leftWallColor,
                  right: biome.rendering.rightWallColor,
                };
          // The diamond's own screen center (see the isometricCellCenter /
          // isometricTileDiamond math: top.x === bottom.x and right.y ===
          // left.y, both landing exactly on the diamond's center lines) --
          // reused here instead of recomputing via isometricCellCenter.
          const centerX = top.x;
          const centerY = right.y;
          return (
            <g
              key={tile.id}
              data-world-cell-kind={cell?.kind}
              data-ecosystem-landscape-band={landscapeCell?.band}
              data-ecosystem-physics-terrain={physicsTerrain || undefined}
            >
              <polygon
                points={pointString([
                  left,
                  bottom,
                  { x: bottom.x, y: bottom.y + depth },
                  { x: left.x, y: left.y + depth },
                ])}
                fill={wallColors.left}
              />
              <polygon
                points={pointString([
                  bottom,
                  right,
                  { x: right.x, y: right.y + depth },
                  { x: bottom.x, y: bottom.y + depth },
                ])}
                fill={wallColors.right}
              />
              <polygon
                points={pointString([top, right, bottom, left])}
                fill={
                  unknown
                    ? "#64748B"
                    : surfaceColor ??
                      ((tile.x + tile.y) % 2 ? "#167891" : "#1D88A0")
                }
                fillOpacity={unknown ? 0.78 : 1}
                stroke={
                  physicsTerrain
                    ? biome.rendering.physicsOutlineColor
                    : biome.rendering.outlineColor
                }
                strokeWidth={physicsTerrain ? 1.6 : 0.01}
                vectorEffect={physicsTerrain ? "non-scaling-stroke" : undefined}
              />
              {currentVector ? (
                <path
                  d={`M ${centerX - currentVector.dx} ${centerY - currentVector.dy} L ${
                    centerX + currentVector.dx
                  } ${centerY + currentVector.dy} m ${-currentVector.dx * 0.8} ${
                    -currentVector.dy * 0.8
                  } l ${-currentVector.dy * 0.45} ${currentVector.dx * 0.45} m ${
                    currentVector.dy * 0.45
                  } ${-currentVector.dx * 0.45} l ${-currentVector.dy * 0.45} ${
                    currentVector.dx * 0.45
                  }`}
                  fill="none"
                  stroke="#E0F7FA"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={0.035}
                  opacity={0.8}
                />
              ) : null}
            </g>
          );
        })}
        {visualPaths?.sunkenFacet ? (
          <path
            data-ecosystem-landscape-vector="sunken-facet"
            d={visualPaths.sunkenFacet}
            fill={biome.rendering.landscapeSunkenFacetColor}
            fillOpacity={0.2}
            pointerEvents="none"
          />
        ) : null}
        {visualPaths?.raisedFacet ? (
          <path
            data-ecosystem-landscape-vector="raised-facet"
            d={visualPaths.raisedFacet}
            fill={biome.rendering.landscapeRaisedFacetColor}
            fillOpacity={0.2}
            pointerEvents="none"
          />
        ) : null}
        {visualPaths?.reliefShadow ? (
          <path
            data-ecosystem-landscape-vector="relief-shadow"
            data-ecosystem-landscape-contour-segments={visualPaths.contourSegmentCount}
            data-ecosystem-landscape-decorated-cells={visualPaths.decoratedCellCount}
            d={visualPaths.reliefShadow}
            fill="none"
            stroke={biome.rendering.landscapeReliefShadowColor}
            strokeWidth={2.35}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            opacity={0.64}
            pointerEvents="none"
          />
        ) : null}
        {visualPaths
          ? ECOSYSTEM_LANDSCAPE_BANDS.map((band) =>
              visualPaths.marks[band] ? (
                <path
                  key={band}
                  data-ecosystem-landscape-vector={`mark-${band}`}
                  d={visualPaths.marks[band]}
                  fill="none"
                  stroke={biome.rendering.landscapeMarks[band]}
                  strokeWidth={band === "ridge" ? 1.55 : 1.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  opacity={0.88}
                  pointerEvents="none"
                />
              ) : null,
            )
          : null}

        {scene.cells.flatMap((cell) => {
          if (cell.kind !== "resource") return [];
          const level = algaeLevel(cell.intensity);
          if (level <= 0) return [];
          const pr = 0.09;
          const els = [];
          for (let i = 0; i < level; i += 1) {
            const o = ALGAE_PIP_OFFSETS[i];
            const center = isometricScreenPoint(
              { x: cell.x + o.x, y: cell.y + o.y },
              projection.fit,
            );
            els.push(
              resourceIcon ? (
                <image
                  key={`c${cell.x}-${cell.y}-p${i}`}
                  href={resourceIcon}
                  x={center.x - pr}
                  y={center.y - pr}
                  width={pr * 2}
                  height={pr * 2}
                  preserveAspectRatio="xMidYMid meet"
                />
              ) : (
                <circle
                  key={`c${cell.x}-${cell.y}-p${i}`}
                  cx={center.x}
                  cy={center.y}
                  r={pr}
                  fill={biome.resource.markerColor}
                />
              ),
            );
          }
          return els;
        })}

        {certaintyCells.length > 0 ? (
          <g pointerEvents="none" aria-label="Replay-confirmed sense certainty">
            {certaintyCells.map((cell) => (
              <polygon
                key={`${cell.x}:${cell.y}`}
                points={isometricTileDiamond(cell)
                  .map((point) => fitPoint(point))
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                fill={senseProjection?.senseId === "vision" ? "#0891B2" : "#D97706"}
                fillOpacity={cell.opacity}
              />
            ))}
          </g>
        ) : null}

        {senseProjection ? (
          <g
            data-ecosystem-sense={senseProjection.senseId}
            pointerEvents="none"
            aria-label={`${senseProjection.actorLabel} ${senseProjection.senseId} evidence`}
          >
            {senseProjection.targets.map((target) => {
              const color =
                target.status === "hidden"
                  ? "#D92D20"
                  : senseProjection.senseId === "vision"
                    ? "#0891B2"
                    : "#D97706";
              if (target.kind === "automaton" || target.kind === "corpse") {
                const center = fitPoint(isometricCellCenter(target));
                return (
                  <g key={target.key}>
                    <title>{target.label}</title>
                    <circle
                      cx={center.x}
                      cy={center.y}
                      r={0.47}
                      fill="none"
                      stroke={color}
                      strokeWidth={0.08}
                      strokeDasharray={target.status === "hidden" ? "0.12 0.08" : undefined}
                    />
                    {target.status === "hidden" ? (
                      <path
                        d={`M ${center.x - 0.18} ${center.y - 0.18} L ${center.x + 0.18} ${center.y + 0.18} M ${center.x + 0.18} ${center.y - 0.18} L ${center.x - 0.18} ${center.y + 0.18}`}
                        stroke={color}
                        strokeWidth={0.05}
                      />
                    ) : null}
                  </g>
                );
              }
              const points = isometricTileDiamond(target)
                .map((point) => fitPoint(point))
                .map((point) => `${point.x},${point.y}`)
                .join(" ");
              return (
                <polygon
                  key={target.key}
                  points={points}
                  fill={color}
                  fillOpacity={0.16}
                  stroke={color}
                  strokeWidth={0.045}
                >
                  <title>{target.label}</title>
                </polygon>
              );
            })}
          </g>
        ) : null}

        {entities.map((entity) => {
          const layout = automatonLayout(entity);
          const position = isometricCellCenter(entity);
          const fittedPosition = fitPoint(position);
          const r = layout.radius * 0.9;
          const selected = entity.id === selectedAutomatonId || entity.automatonId === selectedAutomatonId;
          const icon = entity.label ? speciesIcons[entity.label] : undefined;
          const isAutomaton = entity.kind === "automaton";
          const isCorpse = entity.kind === "corpse";
          const isInspectable = isAutomaton || (isCorpse && entity.automatonId !== undefined);
          const isToken = isRoundTokenEntityKind(entity.kind);
          const isPool = isPoolEntityKind(entity.kind);
          const isUnknown = !isAutomaton && !isCorpse && !isToken && !isPool;
          const heading = entity.heading ?? 0;
          const normalizedHeading = ((heading % 360) + 360) % 360;
          const flip = normalizedHeading > 90 && normalizedHeading < 270 ? -1 : 1;
          return (
            <g
              key={entity.id}
              data-world-entity-kind={entity.kind}
              transform={`translate(${fittedPosition.x} ${fittedPosition.y})`}
              style={{ transition: "transform 380ms cubic-bezier(0.4,0,0.2,1)" }}
              opacity={entity.hidden ? 0.45 : 1}
            >
              <g
                className={isAutomaton ? "wb-bob" : undefined}
                style={{
                  cursor: isAutomaton ? "pointer" : "default",
                  animation: isAutomaton
                    ? `wb-bob ${layout.bob.durationSeconds}s ease-in-out infinite`
                    : undefined,
                  animationDelay: `${layout.bob.delaySeconds}s`,
                  outline: "none",
                }}
                tabIndex={isInspectable ? 0 : undefined}
                role={isInspectable ? "button" : undefined}
                aria-label={
                  isInspectable
                    ? `${isCorpse ? "last decision at" : entity.label ?? "automaton"} cell ${entity.x}, ${entity.y}${selected ? " (selected)" : ""} — inspect`
                    : undefined
                }
                aria-pressed={isInspectable ? selected : undefined}
                onClick={isInspectable ? (event) => selectFromPointer(event, entity) : undefined}
                onKeyDown={
                  isInspectable
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelectKeyboard(entity.automatonId ?? entity.id);
                        }
                      }
                    : undefined
                }
              >
                {selected ? (
                  <circle cx={0} cy={0} r={r + 0.18} fill="none" stroke="#7C3AED" strokeWidth={0.08} />
                ) : null}
                {entity.energy !== undefined ? (
                  <circle
                    cx={0}
                    cy={0}
                    r={r + 0.09}
                    fill="none"
                    stroke={entity.energy > 0 ? "#FACC15" : "#94A3B8"}
                    strokeWidth={0.045}
                    opacity={0.85}
                  />
                ) : null}
                <ellipse cx={0} cy={r * 0.55} rx={r * 0.72} ry={r * 0.24} fill="#032337" opacity={0.32} />
                <g transform={`rotate(${heading}) scale(${flip} 1)`}>
                  {icon && isAutomaton ? (
                    <>
                      <circle cx={0} cy={0} r={r} fill={entity.color ?? "#0E7490"} opacity={0.25} />
                      <image
                        href={icon}
                        x={-r}
                        y={-r}
                        width={r * 2}
                        height={r * 2}
                        preserveAspectRatio="xMidYMid meet"
                      />
                    </>
                  ) : isUnknown ? (
                    <polygon
                      points={`0,${-r * 0.65} ${r * 0.65},0 0,${r * 0.65} ${-r * 0.65},0`}
                      fill={entity.color ?? "#64748B"}
                      stroke="#E2E8F0"
                      strokeWidth={0.035}
                    />
                  ) : isToken || isPool ? null : (
                    <circle cx={0} cy={0} r={r} fill={entity.color ?? "#78716C"} />
                  )}
                </g>
                {/* Round-token badges (prisonersDilemma/matrixGame/publicGoods'
                    "token:<actionId>" convention) — a small coin-like chip in
                    the token's own semantic color, with its authored action
                    label's first letter for at-a-glance legibility. Never
                    rotated by heading (tokens don't set one). */}
                {isToken ? (
                  <>
                    <circle
                      cx={0}
                      cy={0}
                      r={r}
                      fill={entity.color ?? "#64748B"}
                      stroke="#F8FAFC"
                      strokeWidth={0.03}
                    />
                    <circle
                      cx={0}
                      cy={0}
                      r={r * 0.72}
                      fill="none"
                      stroke="#F8FAFC"
                      strokeWidth={0.02}
                      opacity={0.55}
                    />
                    <text
                      x={0}
                      y={0}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={r * 1.15}
                      fontWeight={700}
                      fill="#F8FAFC"
                      style={{ userSelect: "none", fontSize: `${r * 1.15}px` }}
                    >
                      {tokenBadgeGlyph(entity.label)}
                    </text>
                  </>
                ) : null}
                {/* publicGoods's shared pool entity — a real pot/pool graphic
                    (not the generic unknown-kind diamond): a basin with a
                    soft highlight and a warm glint standing in for the
                    village's shared resource, `size` already tracks the
                    round's normalized pool. */}
                {isPool ? (
                  <>
                    <circle cx={0} cy={0} r={r} fill={entity.color ?? "#0369A1"} />
                    <circle
                      cx={0}
                      cy={0}
                      r={r}
                      fill="none"
                      stroke="#082F49"
                      strokeWidth={0.05}
                      opacity={0.6}
                    />
                    <ellipse
                      cx={-r * 0.28}
                      cy={-r * 0.32}
                      rx={r * 0.4}
                      ry={r * 0.24}
                      fill="#7DD3FC"
                      opacity={0.55}
                    />
                    <circle cx={0} cy={0} r={r * 0.32} fill="#FDE68A" opacity={0.9} />
                  </>
                ) : null}
              </g>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function PopulationTraitBand({
  evidence,
  targetTicks,
  selectedTick,
}: {
  evidence: PopulationTraitEvidence;
  targetTicks: number;
  selectedTick?: number;
}) {
  const width = 320;
  const height = 54;
  const chartTickSpan = chartTimeSpan(evidence.samples, targetTicks);
  const domain = evidence.metricKey === "traitMean"
    ? ECOSYSTEM_TRAIT_DOMAIN.metabolic
    : ECOSYSTEM_TRAIT_DOMAIN.perception;
  const span = domain.max - domain.min;
  return (
    <Box>
      <Text fontSize="2xs" color="gray.500" fontWeight="700" mb={1}>
        {evidence.label} · each mark is one living animal
      </Text>
      <svg
        width={width}
        height={height}
        style={{ flexShrink: 0 }}
        role="img"
        aria-label={`${evidence.label} distribution across sampled population snapshots`}
      >
        {evidence.samples.flatMap((sample) =>
          sample.values.map((value, index) => (
            <circle
              key={`${sample.tick}:${index}`}
              cx={(sample.tick / chartTickSpan) * width}
              cy={height - ((value - domain.min) / span) * (height - 8) - 4}
              r={2.4}
              fill="#7C3AED"
              opacity={0.78}
            />
          )),
        )}
        {selectedTick !== undefined ? (
          <line
            x1={(selectedTick / chartTickSpan) * width}
            x2={(selectedTick / chartTickSpan) * width}
            y1={0}
            y2={height}
            stroke="#172033"
            strokeWidth={1.5}
          />
        ) : null}
      </svg>
    </Box>
  );
}

export function MetricStrip({
  run,
  spec,
  selectedTick,
  populationTraitEvidence,
}: {
  run: SimulatorRun;
  spec: SimulatorSpec;
  selectedTick?: number;
  populationTraitEvidence?: PopulationTraitEvidence;
}) {
  const key = criterionMetricKey(spec);
  const series = run.summarySeries;
  const keys = useMemo(() => {
    if (spec.templateId !== "ecosystemGrid") return chartMetricKeys(spec, series);
    const available = new Set(
      series.flatMap((sample) => sample.values.map((value) => value.key)),
    );
    const usesDistributionBand =
      populationTraitEvidence !== undefined &&
      populationTraitEvidence.samples.length >= 2 &&
      (key === "traitMean" || key === "perceptionMean");
    const ecosystemKeys = usesDistributionBand || !key
      ? ["livingAutomata", "resourceBiomass"]
      : ["livingAutomata", "resourceBiomass", key];
    return [...new Set(ecosystemKeys)].filter(
      (metricKey) => available.has(metricKey),
    );
  }, [key, populationTraitEvidence, spec, series]);

  if (series.length < 2 && !populationTraitEvidence) {
    return (
      <Text fontSize="xs" color="gray.400" px={2} py={1}>
        metrics appear as the run ticks
      </Text>
    );
  }

  const width = 320;
  const height = 54;
  const chartTickSpan = series.length >= 2 ? chartTimeSpan(series, run.targetTicks) : 1;
  const isRoundGame = getWorkbenchRendererFamily(spec.templateId) !== "field";
  const terminalTick =
    run.haltReason === "terminal_physics" &&
    (!isRoundGame || run.latestCommittedTick < run.targetTicks)
      ? run.latestCommittedTick
      : null;
  const palette = ["#7C3AED", "#0E7490", "#C2410C", "#15803D"];
  const bounds = keys.map((metricKey) => {
    const values = series.flatMap((sample) =>
      sample.values.filter((value) => value.key === metricKey).map((value) => value.value),
    );
    return { min: Math.min(0, ...values), max: Math.max(1, ...values) };
  });

  return (
    <HStack gap={3} px={3} py={2} align="center" flexWrap="wrap" aria-label="Sampled run trace">
      <Box>
        <Text fontSize="2xs" color="gray.500" fontWeight="700" mb={1}>
          {spec.templateId === "ecosystemGrid"
            ? `Population + ${ecosystemBiome(spec.config.biome).resource.label.toLowerCase()}`
            : "Run trace"}{" "}
          · sampled
        </Text>
        {series.length >= 2 ? (
        <svg width={width} height={height} style={{ flexShrink: 0 }} role="img" aria-label="Sampled metric series over the run">
          {keys.map((metricKey, ki) => {
            const { min, max } = bounds[ki];
            const span = max - min || 1;
            const points = series.flatMap((sample) => {
              const value = sample.values.find((candidate) => candidate.key === metricKey);
              if (!value) return [];
              return [{
                x: (sample.tick / chartTickSpan) * width,
                y: height - ((value.value - min) / span) * (height - 4) - 2,
              }];
            });
            return (
              <g key={metricKey}>
                <polyline
                  points={points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
                  fill="none"
                  stroke={palette[ki % palette.length]}
                  strokeWidth={metricKey === key ? 2 : 1.5}
                  opacity={metricKey === key ? 1 : 0.72}
                />
                {points.map((point, index) => (
                  <circle key={index} cx={point.x} cy={point.y} r={1.8} fill={palette[ki % palette.length]} />
                ))}
              </g>
            );
          })}
          {selectedTick !== undefined ? (
            <line
              x1={(selectedTick / chartTickSpan) * width}
              x2={(selectedTick / chartTickSpan) * width}
              y1={0}
              y2={height}
              stroke="#172033"
              strokeWidth={1.5}
            />
          ) : null}
          {terminalTick !== null ? (
            <line
              x1={(terminalTick / chartTickSpan) * width}
              x2={(terminalTick / chartTickSpan) * width}
              y1={0}
              y2={height}
              stroke="#78716C"
              strokeDasharray="2 2"
              strokeWidth={1}
            />
          ) : null}
        </svg>
        ) : null}
      </Box>
      {populationTraitEvidence && populationTraitEvidence.samples.length >= 2 ? (
        <PopulationTraitBand
          evidence={populationTraitEvidence}
          targetTicks={run.targetTicks}
          selectedTick={selectedTick}
        />
      ) : null}
      <HStack gap={2} flexWrap="wrap">
        {keys.map((metricKey, ki) => {
          const current = run.currentMetrics.find((metric) => metric.key === metricKey);
          return (
            <HStack key={metricKey} gap={1}>
              <Box w="8px" h="8px" borderRadius="full" bg={palette[ki % palette.length]} />
              <Text fontSize="xs" color="gray.600">
                {current
                  ? `${formatMetric(current.value)} ${metricLabel(metricKey, current.value)}`
                  : `— ${metricLabel(metricKey)}`}
              </Text>
            </HStack>
          );
        })}
        {terminalTick !== null ? (
          <Text fontSize="xs" color="gray.500">
            world stopped at day {terminalTick}
          </Text>
        ) : null}
      </HStack>
    </HStack>
  );
}

/** A watchable day-per-tick cadence for playback (ms/day). */
export const DAY_ADVANCE_MS = 600;

/** A one-line, kid-legible reason a run is over — about the SIM, never the scholar. */
export function runEndReasonLine(
  status: SimulatorRun["status"],
  haltReason: SimulatorRun["haltReason"],
  targetTicks: number,
  _runKind: SimulatorRun["runKind"],
  timeUnit: "day" | "round" = "day",
  committedTicks = targetTicks,
): string | null {
  if (
    haltReason === "terminal_physics" &&
    (timeUnit === "day" || committedTicks < targetTicks)
  ) {
    return timeUnit === "day"
      ? "Ended early · the world reached a standstill"
      : "Ended early · the run reached a standstill";
  }
  switch (status) {
    case "completed":
      if (timeUnit === "round") {
        return `Simulation complete · reached ${targetTicks} rounds`;
      }
      return `Simulation complete · reached ${targetTicks} ${timeUnit}${targetTicks === 1 ? "" : "s"}`;
    case "halted":
      switch (haltReason) {
        case "budget":
          return "Reached the run limit";
        case "scholar_stop":
          return "You stopped this run";
        case "teacher_pause":
          return "Your teacher paused runs";
        default:
          return "Run ended";
      }
    case "crashed":
      return "This run hit a snag";
    default:
      return null;
  }
}

/**
 * The run transport — CONVENTIONAL MEDIA CONTROLS. Three centered controls —
 * [⏮ step-back a day] [▶/⏸ play·pause] [⏭ step-forward a day] — over a draggable
 * scrubber track and a "day t/max" caption; zoom stays secondary at the edge.
 * Play (driven by the parent) auto-advances one recorded day at a watchable
 * cadence; at the live head it keeps FOLLOWING into each freshly-committed day (a
 * quiet "computing…" hint, never a dead disabled button). When the run is over the
 * primary becomes ↺ Replay and a muted line states WHY it ended — about the SIM,
 * never a judgement of the scholar's strategy.
 */
export function TickScrubber({
  tick,
  maxTick,
  moreComing,
  onScrub,
  playing,
  onTogglePlay,
  status,
  haltReason,
  targetTicks,
  runKind,
  onZoomIn,
  onZoomOut,
  timeUnit = "day",
}: {
  tick: number;
  maxTick: number;
  moreComing: boolean;
  onScrub: (tick: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  status: SimulatorRun["status"];
  haltReason: SimulatorRun["haltReason"];
  targetTicks: number;
  runKind: SimulatorRun["runKind"];
  /** Zoom controls live with the transport only in the stacked layout; in the
   *  two-column layout zoom sits on the viewport itself, so these are omitted. */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  timeUnit?: "day" | "round";
}) {
  const atHead = tick >= maxTick;
  const ended =
    atHead &&
    !moreComing &&
    (status === "completed" || status === "halted" || status === "crashed");
  const computing = atHead && moreComing;
  const endReason = ended
    ? runEndReasonLine(
        status,
        haltReason,
        targetTicks,
        runKind,
        timeUnit,
        maxTick,
      )
    : null;
  const statusLine = endReason ?? (computing ? `computing ${timeUnit} ${maxTick + 1}…` : null);

  return (
    <Box borderTop="1px solid" borderColor="gray.200" px={3} py={2}>
      {statusLine ? (
        <Text fontSize="xs" color="gray.500" textAlign="center" mb={1.5} lineClamp={1}>
          {statusLine}
        </Text>
      ) : null}

      <HStack gap={2}>
        {onZoomOut ? (
          <Button size="xs" variant="ghost" onClick={onZoomOut} aria-label="Zoom out">
            <MagnifyingGlassMinus />
          </Button>
        ) : null}

        <HStack gap={1} flex={1} justify="center">
          <Button
            size="sm"
            variant="ghost"
            colorPalette="violet"
            onClick={() => onScrub(Math.max(0, tick - 1))}
            transition="transform 0.08s ease"
            _active={{ transform: "scale(0.88)" }}
            disabled={tick <= 0}
            aria-label={`Step back one ${timeUnit}`}
          >
            <SkipBack weight="fill" />
          </Button>
          <Button
            size="sm"
            colorPalette="violet"
            borderRadius="full"
            onClick={onTogglePlay}
            position="relative"
            transition="transform 0.08s ease"
            _active={{ transform: "scale(0.9)" }}
            aria-label={ended ? "Replay from the start" : playing ? "Pause" : "Play"}
          >
            {/* While a day bakes, the glyph reads as "working" (dimmed) and a
                thin violet ring circles the button's perimeter — a progress
                ring, not a broken corner badge. */}
            <Box as="span" opacity={computing && !playing ? 0.45 : 1}>
              {ended ? (
                <ArrowCounterClockwise weight="bold" />
              ) : playing ? (
                <Pause weight="fill" />
              ) : (
                <Play weight="fill" />
              )}
            </Box>
            {computing && !playing ? (
              <Spinner
                position="absolute"
                inset="-3px"
                boxSize="auto"
                borderWidth="2px"
                color="violet.500"
                css={{ "--spinner-track-color": "transparent" }}
              />
            ) : null}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            colorPalette="violet"
            onClick={() => onScrub(Math.min(maxTick, tick + 1))}
            transition="transform 0.08s ease"
            _active={{ transform: "scale(0.88)" }}
            disabled={tick >= maxTick}
            aria-label={`Step forward one ${timeUnit}`}
          >
            <SkipForward weight="fill" />
          </Button>
        </HStack>

        {onZoomIn ? (
          <Button size="xs" variant="ghost" onClick={onZoomIn} aria-label="Zoom in">
            <MagnifyingGlassPlus />
          </Button>
        ) : null}
      </HStack>

      <HStack gap={2} mt={1} align="center">
        <input
          type="range"
          min={0}
          max={Math.max(0, maxTick)}
          value={Math.min(tick, maxTick)}
          onChange={(event) => onScrub(Number(event.target.value))}
          style={{ flex: 1, accentColor: "#7C3AED" }}
          aria-label={`Scrub run ${timeUnit}`}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, maxTick)}
          aria-valuenow={Math.min(tick, maxTick)}
          aria-valuetext={`${timeUnit} ${tick} of ${maxTick}`}
        />
        <Text fontSize="xs" color="gray.600" whiteSpace="nowrap" minW="72px" textAlign="right">
          {timeUnit} {tick}/{maxTick}
        </Text>
      </HStack>
    </Box>
  );
}

export function SimulatorViewport({
  spec,
  frame,
  liveScene,
  isLiveHead,
  run,
  tick,
  maxTick,
  moreComing,
  playing,
  onScrub,
  onTogglePlay,
  onSelectAutomaton,
  selectedAutomatonId,
  speciesIcons,
  runLabel,
  personalDelta,
  showTransport = true,
  onSenseEvidenceDemand,
}: {
  spec: SimulatorSpec;
  frame: SceneFrame | null;
  liveScene: SimulatorSceneV1 | null;
  /** True only when the view is parked at the live head (review Finding 2). */
  isLiveHead: boolean;
  run: SimulatorRun | null;
  tick: number;
  maxTick: number;
  /** The engine is still committing ticks (run queued/ticking). */
  moreComing: boolean;
  playing: boolean;
  onScrub: (tick: number) => void;
  onTogglePlay: () => void;
  onSelectAutomaton: (id: string) => void;
  selectedAutomatonId: string | null;
  speciesIcons: Record<string, string | undefined>;
  runLabel: string;
  personalDelta: string | null;
  /**
   * When false (the two-column layout), the viewport renders ONLY the world —
   * the metric strip + playback transport move into the WorkbenchPanel so the
   * whole square is the reef. Mouse zoom stays reachable via a small floating
   * control on the stage. Defaults to true (the stacked layout keeps them here).
   */
  showTransport?: boolean;
  onSenseEvidenceDemand?: (request: EcosystemSenseEvidenceRequest | undefined) => void;
}) {
  const worldRef = useRef<ProjectionWorld | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cam = useCamera(worldRef, svgRef);
  const [requestedSense, setRequestedSense] = useState<
    "world" | EcosystemInspectableSenseId
  >("world");

  // HONEST REPLAY: use the replayed frame for the requested tick; fall back to
  // the live scene ONLY when parked at the live head.
  const scene = frame?.scene ?? (isLiveHead ? liveScene : null);
  // Keep the camera's clamp bounds in sync with the rendered world's dims (set in
  // an effect, never during render — the handlers read it lazily at event time),
  // then re-clamp immediately so the FIRST rendered frame of a newly-known world
  // is already in bounds rather than waiting for the next pointer event.
  const worldW = scene ? scene.viewport.width : null;
  const worldH = scene ? scene.viewport.height : null;
  const projection = useMemo<ProjectionWorld | null>(() => {
    if (worldW === null || worldH === null) return null;
    const grid = { width: worldW, height: worldH };
    const bounds = isometricWorldBounds(grid);
    const padding = 0.8;
    const viewport = {
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    };
    return {
      fit: fitIsometricCamera(grid, viewport, padding),
      viewport,
    };
  }, [worldW, worldH]);
  const clampToWorld = cam.clampToWorld;
  useEffect(() => {
    if (!projection) return;
    worldRef.current = projection;
    clampToWorld();
  }, [projection, clampToWorld]);

  const score = run ? runCriterionScore(spec, run.criterionScores) : null;
  const timeUnit = workbenchTimeNoun(spec.templateId);
  const selectedSceneEntity = scene?.entities.find(
    (entity) => entity.kind === "automaton" && entity.id === selectedAutomatonId,
  );
  const selectedSpeciesSlot =
    spec.templateId === "ecosystemGrid"
      ? spec.speciesSlots.find(
          (slot) => slot.slotId === selectedSceneEntity?.slotId,
        )
      : undefined;
  const hasSense = (senseId: EcosystemInspectableSenseId) =>
    selectedSpeciesSlot?.senses.some((sense) => sense.senseId === senseId) ?? false;
  const senseProjection = useMemo(
    () =>
      spec.templateId === "ecosystemGrid" &&
      scene &&
      selectedAutomatonId &&
      requestedSense !== "world"
        ? projectEcosystemSense({
            spec,
            scene,
            actorId: selectedAutomatonId,
            senseId: requestedSense,
          })
        : null,
    [requestedSense, scene, selectedAutomatonId, spec],
  );
  const activeSense = senseProjection ? requestedSense : "world";
  const certaintyCells = useMemo(
    () => ecosystemCertaintyCells(frame, selectedAutomatonId, activeSense),
    [activeSense, frame, selectedAutomatonId],
  );
  useEffect(() => {
    onSenseEvidenceDemand?.(
      activeSense === "world" || !selectedAutomatonId
        ? undefined
        : { actorId: selectedAutomatonId, senseId: activeSense },
    );
  }, [activeSense, onSenseEvidenceDemand, selectedAutomatonId]);
  const sceneAriaLabel =
    run === null && scene?.entities.length === 0
      ? "Simulator viewport — authored terrain and resources before the first run"
      : "Simulator viewport — living automata on their recorded cells";

  const onSelectGuarded = useCallback(
    (id: string) => {
      // A pan drag must not also select an automaton.
      if (cam.consumedDrag()) return;
      onSelectAutomaton(id);
    },
    [cam, onSelectAutomaton],
  );

  return (
    <Flex flexDir="column" flex={1} minW={0} minH={0} bg="gray.50" role="region" aria-label="Simulator viewport">
      {run ? (
        <Flex align="center" justify="space-between" px={3} py={1.5} gap={2}>
          <Text fontSize="xs" color="charcoal.600" fontWeight="600">
            {runLabel}
            {score !== null ? ` · ${formatMetric(score)} ${spec.criterion.kind === "measured" ? metricLabel(spec.criterion.metricKey, score) : ""}` : ""}
          </Text>
          {personalDelta ? (
            <Text fontSize="xs" color="violet.600" fontWeight="600">
              {personalDelta}
            </Text>
          ) : null}
        </Flex>
      ) : null}

      {spec.templateId === "ecosystemGrid" ? (
        <HStack px={3} py={1.5} gap={2} flexWrap="wrap" borderTopWidth="1px" borderColor="gray.100">
          {(
            [
              { id: "world", label: "World" },
              { id: "vision", label: "Sight" },
              { id: "smell", label: "Scent" },
            ] as const
          ).map((lens) => {
            const disabled =
              lens.id !== "world" &&
              (!selectedAutomatonId || !hasSense(lens.id));
            return (
              <Button
                key={lens.id}
                size="xs"
                variant={activeSense === lens.id ? "solid" : "outline"}
                colorPalette={lens.id === "smell" ? "orange" : lens.id === "vision" ? "cyan" : "gray"}
                disabled={disabled}
                onClick={() => setRequestedSense(lens.id)}
                aria-pressed={activeSense === lens.id}
              >
                {lens.label}
              </Button>
            );
          })}
          {senseProjection ? (
            <>
              <Text fontSize="2xs" color="gray.500">
                {senseProjection.targets.length} sensed · range {senseProjection.range} · solid = pre-action decision tick
              </Text>
              <HStack gap={2.5} flexWrap="wrap">
                <HStack gap={1}>
                  <Box w="8px" h="8px" borderRadius="full" border="2px solid" borderColor={senseProjection.senseId === "vision" ? "cyan.600" : "orange.500"} />
                  <Text fontSize="2xs" color="gray.500">{senseProjection.senseId === "vision" ? "In sight" : "Scented"}</Text>
                </HStack>
                {senseProjection.senseId === "smell" ? (
                  <HStack gap={1}>
                    <Text fontSize="2xs" color="red.600" fontWeight="800">×</Text>
                    <Text fontSize="2xs" color="gray.500">Hidden from sight</Text>
                  </HStack>
                ) : null}
              </HStack>
            </>
          ) : (
            <Text fontSize="2xs" color="gray.500">
              {selectedAutomatonId
                ? "Choose one of this automaton’s senses"
                : "Select an automaton to inspect its senses"}
            </Text>
          )}
        </HStack>
      ) : null}

      <Box
        flex={1}
        minH={0}
        position="relative"
        px={3}
        pb={1}
        onWheel={cam.onWheel}
        onPointerDown={cam.onPointerDown}
        onPointerMove={cam.onPointerMove}
        onPointerUp={cam.onPointerUp}
        onPointerLeave={cam.onPointerLeave}
      >
        {scene && projection ? (
          <SceneLayer
            scene={scene}
            selectedAutomatonId={selectedAutomatonId}
            onSelect={onSelectGuarded}
            onSelectKeyboard={onSelectAutomaton}
            speciesIcons={speciesIcons}
            camera={cam.camera}
            projection={projection}
            svgRef={svgRef}
            biomeId={spec.templateId === "ecosystemGrid" ? spec.config.biome : undefined}
            landscapeConfig={
              spec.templateId === "ecosystemGrid" &&
              spec.config.width === scene.viewport.width &&
              spec.config.height === scene.viewport.height
                ? spec.config.landscape
                : undefined
            }
            physicsTerrainConfig={
              spec.templateId === "ecosystemGrid" ? spec.config.terrain : undefined
            }
            senseProjection={senseProjection}
            certaintyCells={certaintyCells}
            ariaLabel={sceneAriaLabel}
          />
        ) : (
          <Flex align="center" justify="center" h="100%" color="gray.400" fontSize="sm" textAlign="center" px={4}>
            {run ? (isLiveHead ? "loading the world…" : `${timeUnit} ${tick} is loading…`) : null}
          </Flex>
        )}

        {/* Two-column layout: the transport moved to the panel, so zoom lives on
            the stage itself (wheel works too). Kept off the stacked layout, which
            keeps its zoom buttons in the transport below. */}
        {!showTransport && scene && projection ? (
          <HStack
            gap={1}
            position="absolute"
            bottom={2}
            right={4}
            bg="whiteAlpha.900"
            borderRadius="md"
            borderWidth="1px"
            borderColor="gray.200"
            p={0.5}
          >
            <Button size="xs" variant="ghost" onClick={() => cam.zoomBy(0.8)} aria-label="Zoom out">
              <MagnifyingGlassMinus />
            </Button>
            <Button size="xs" variant="ghost" onClick={() => cam.zoomBy(1.25)} aria-label="Zoom in">
              <MagnifyingGlassPlus />
            </Button>
          </HStack>
        ) : null}
      </Box>

      {showTransport && run ? (
        <MetricStrip
          run={run}
          spec={spec}
          selectedTick={tick}
          populationTraitEvidence={frame?.populationTraitEvidence}
        />
      ) : null}
      {showTransport && run ? (
        <TickScrubber
          tick={tick}
          maxTick={maxTick}
          moreComing={moreComing}
          onScrub={onScrub}
          playing={playing}
          onTogglePlay={onTogglePlay}
          status={run.status}
          haltReason={run.haltReason}
          targetTicks={run.targetTicks}
          runKind={run.runKind}
          onZoomIn={() => cam.zoomBy(1.25)}
          onZoomOut={() => cam.zoomBy(0.8)}
          timeUnit={timeUnit}
        />
      ) : null}
    </Flex>
  );
}

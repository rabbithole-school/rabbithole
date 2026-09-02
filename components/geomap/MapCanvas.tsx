"use client";

/**
 * MapCanvas — the imperative mapbox-gl renderer behind {@link ./GeoMap}. Loaded
 * ONLY client-side and ONLY when a token exists (GeoMap gates it via
 * next/dynamic ssr:false), so the mapbox-gl bundle + its CSS never touch SSR or
 * the tokenless empty state.
 *
 * It renders a `GeoMapSpec`: curated base (from ./baseStyles — the one place raw
 * style URLs live), closed-set overlay paint (./paintPresets), optional 3D
 * terrain / globe, tutor markers, controlled scholar pins, and the kid-facing
 * controls (base pill, layer chips, stepper). Pins are CONTROLLED (the host owns
 * persistence); camera gestures are uncontrolled. Base switches setStyle, which
 * drops custom layers — so every overlay/terrain/projection is re-applied on
 * `style.load`.
 */
import mapboxgl, {
  type Map as MapboxMap,
  type Marker as MapboxMarker,
  type MapMouseEvent,
} from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import type {
  GeoBase,
  GeoJsonFeatureCollection,
  GeoLayer,
  GeoLayerSource,
  GeoMapRendererProps,
  GeoMapSpec,
  PaintPreset,
  ScholarPin,
} from "@/lib/geomap/types";
import { resolveRegistryEntry } from "@/lib/geomap/registry";
import { resolveHistoricalBasemap } from "@/lib/geomap/historicalBasemaps";
import {
  drawableFeatureCollection,
  pathStyleForPreset,
  type PathStyle,
} from "@/lib/geomap/geo";
import { baseStyle, baseLabel, eraBaseStyle } from "./baseStyles";
import { buildPaintLayers } from "./paintPresets";

/**
 * The style actually driving the canvas. An era (`spec.historicalBasemap`) is
 * a MODE across every base, not one style: the political base uses the era's
 * HOSTED style (borders/labels baked in, modern chrome removed at the style
 * level — nothing to clean at runtime); satellite/terrain use era base
 * variants (raw imagery / outdoors) that the reconcile pass CLEANS at runtime
 * (modern labels + admin + road line-work hidden) and DRESSES with the era's
 * injected borders/labels. The KEY feeds the last-applied-style guard; an
 * unknown era key falls back to the plain base (the validator rejects unknown
 * keys upstream — belt-and-suspenders).
 */
function resolveStyle(
  historicalBasemap: string | undefined,
  base: GeoBase,
): {
  key: string;
  url: string;
  /** On the pre-cleaned hosted era style (skip all runtime cleaning). */
  isHostedEra: boolean;
  /** Era mode on a runtime-cleaned base (strip modern line-work, inject era). */
  isEraCleaned: boolean;
  era?: ReturnType<typeof resolveHistoricalBasemap>;
} {
  const era = historicalBasemap ? resolveHistoricalBasemap(historicalBasemap) : undefined;
  if (era) {
    const eraVariant = eraBaseStyle(base);
    if (eraVariant) {
      // satellite / terrain in era mode: cleaned base + injected era borders.
      return {
        key: `era:${historicalBasemap}:${base}`,
        url: eraVariant.styleUrl,
        isHostedEra: false,
        isEraCleaned: true,
        era,
      };
    }
    // political / politicalUnlabeled in era mode: the hosted era style.
    return {
      key: `era:${historicalBasemap}:map`,
      url: era.styleUrl,
      isHostedEra: true,
      isEraCleaned: false,
      era,
    };
  }
  return {
    key: `base:${base}`,
    url: baseStyle(base).styleUrl,
    isHostedEra: false,
    isEraCleaned: false,
  };
}

const SUBLAYER_PREFIX = "geolayer::";
const SOURCE_PREFIX = "geosrc::";
const DEM_SOURCE = "mapbox-dem";
const HILLSHADE_LAYER = "geo-hillshade";
// Era injection (satellite/terrain in era mode) — internal, never toggleable.
const ERA_PREFIX = "geoera::";
const ERA_SOURCE = "geoera::src";
const ERA_CASING_LAYER = "geoera::casing";
const ERA_LINE_LAYER = "geoera::line";
const ERA_NAME_LAYER = "geoera::name";
// Marker/pin LABELS — one source + one symbol layer, so Mapbox's own collision
// engine places them (the native renderer does exactly this; see
// native/src/components/GeoMapNative.tsx). The emoji stays a DOM marker; the
// text lives in the style.
const LABEL_SOURCE = "geolabels::src";
const LABEL_LAYER = "geolabels::text";
const LABEL_PREFIX = "geolabels::";
// A fully transparent icon, registered programmatically (no asset round-trip).
// It draws nothing; it exists so collision RESERVES the emoji marker's
// footprint, and therefore places labels clear of every marker — not merely
// clear of other labels. The emoji itself is a DOM overlay above the canvas and
// is invisible to the collision engine.
const LABEL_SPACER_IMAGE = "geolabel-spacer";
const LABEL_SPACER_PX = 26;

/** Layers WE added (overlay sublayers + era injection) — never base-cleaned. */
function isOwnLayer(id: string): boolean {
  return (
    id.startsWith(SUBLAYER_PREFIX) || id.startsWith(ERA_PREFIX) || id.startsWith(LABEL_PREFIX)
  );
}

/**
 * Every label the map wants to show, as one GeoJSON FeatureCollection. Mirrors
 * `labelFeatures` in the native renderer, including `sortKey` — the priority the
 * collision engine breaks ties with, so a tutor's authored marker outranks a
 * scholar's own pin.
 */
function buildLabelFeatures(
  markers: GeoMapSpec["markers"],
  scholarPins: ScholarPin[],
): GeoJsonFeatureCollection {
  const features = [
    ...(markers ?? [])
      .filter((m) => (m.label?.trim() ?? "").length > 0)
      .map((m) => ({
        type: "Feature" as const,
        properties: { label: m.label!.trim(), sortKey: 0 },
        geometry: { type: "Point" as const, coordinates: m.lngLat },
      })),
    ...scholarPins
      .filter((p) => (p.label?.trim() ?? "").length > 0)
      .map((p) => ({
        type: "Feature" as const,
        properties: { label: p.label!.trim(), sortKey: 1 },
        geometry: { type: "Point" as const, coordinates: p.lngLat },
      })),
  ];
  return { type: "FeatureCollection", features };
}

type MapCanvasProps = GeoMapRendererProps & { token: string };

/**
 * Redrawn-path cache. `reconcileOverlays` decides whether to push new data by
 * IDENTITY (`prev.data !== data`), so the redraw has to be memoized per input
 * collection or every settled reconcile would issue a fresh `setData` and
 * churn the whole source. Keyed weakly on the authored collection, then on the
 * layer's path style, since the same registry dataset can legitimately be
 * mounted under two presets.
 */
const drawableCache = new WeakMap<
  GeoJsonFeatureCollection,
  Map<PathStyle, GeoJsonFeatureCollection>
>();

/**
 * Resolve a layer's data AND draw its paths for a flat map.
 *
 * This is the one funnel where authored GeoJSON becomes a Mapbox source, so it
 * is the one place the Mercator straight-line lie can be corrected. Doing it
 * HERE rather than at storage time is deliberate — see the design note on
 * `drawableFeatureCollection`: the stored spec stays exactly what the tutor
 * wrote, so `show_map op:"read"` still round-trips the author's own vertices,
 * a patch can never compound a transformed path, and no durable artifact is
 * rewritten (every map in prod is fixed on next paint, with nothing to migrate
 * and nothing to undo if this is wrong).
 *
 * The curve is computed as a plain polyline in framework-free shared math, not
 * drawn by a web-only GPU layer, so the native renderer can draw the identical
 * geometry from the identical function.
 */
function resolveSourceData(
  source: GeoLayerSource,
  preset: PaintPreset,
): GeoJsonFeatureCollection | null {
  const raw =
    "registry" in source
      ? ((resolveRegistryEntry(source.registry)?.data as GeoJsonFeatureCollection) ?? null)
      : (source.geojson ?? null);
  if (!raw) return null;

  const style = pathStyleForPreset(preset);
  let byStyle = drawableCache.get(raw);
  if (!byStyle) {
    byStyle = new Map();
    drawableCache.set(raw, byStyle);
  }
  const cached = byStyle.get(style);
  if (cached) return cached;
  const drawn = drawableFeatureCollection(raw, style);
  byStyle.set(style, drawn);
  return drawn;
}

/** A layer's paint identity — a change here means its sublayers must be rebuilt. */
function overlaySig(layer: GeoLayer): string {
  return `${layer.paint}|${layer.tint ?? ""}`;
}

/** Add every concrete Mapbox sublayer for one overlay, visibility stamped at add time. */
function addOverlaySublayers(
  map: MapboxMap,
  layer: GeoLayer,
  sourceId: string,
  vis: "visible" | "none",
) {
  for (const layerSpec of buildPaintLayers(layer.id, sourceId, layer.paint, layer.tint)) {
    map.addLayer({
      ...layerSpec,
      layout: { ...("layout" in layerSpec ? layerSpec.layout : {}), visibility: vis },
    } as Parameters<typeof map.addLayer>[0]);
  }
}

export default function MapCanvas({
  spec,
  scholarPins,
  onPinDrop,
  onPinRemove,
  onPinsClear,
  token,
  compact,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const [ready, setReady] = useState(false);

  // Base mode (may be flipped by the kid via the base pill).
  const [base, setBase] = useState<GeoBase>(spec.base);
  // Stepper position (only when spec.steps present).
  const [stepIndex, setStepIndex] = useState(0);
  // Per-layer toggle state for step-less maps.
  const [layerVisible, setLayerVisible] = useState<Record<string, boolean>>({});

  // Refs mirror latest values so the stable map callbacks never go stale.
  const specRef = useRef(spec);
  const baseRef = useRef(base);
  const stepRef = useRef(stepIndex);
  const visibilityRef = useRef(layerVisible);
  const onPinDropRef = useRef(onPinDrop);
  const appliedInitialRef = useRef<Record<string, boolean>>({});
  const tutorMarkersRef = useRef<MapboxMarker[]>([]);
  const pinMarkersRef = useRef<MapboxMarker[]>([]);
  // Label features + the last collection actually pushed, so a settled
  // reconcile issues no setData (same guarded-write discipline as overlays).
  const labelFeaturesRef = useRef<GeoJsonFeatureCollection>({
    type: "FeatureCollection",
    features: [],
  });
  const lastLabelDataRef = useRef<GeoJsonFeatureCollection | null>(null);
  const lastCameraRef = useRef(spec.camera);
  // Last style KEY actually pushed to the map (`base:<b>` or `era:<key>`, at
  // creation then on real switches). Guards the style-switch effect from
  // redundantly setStyle-ing the SAME style when `ready` first flips true —
  // that redundant setStyle asynchronously reloads the style, dropping the
  // overlays + un-hiding base symbols that style.load's reconcile just
  // applied, with NO fresh style.load to re-apply them. That was the
  // initial-load race this renderer exists to kill.
  const appliedStyleKeyRef = useRef<string>(
    resolveStyle(spec.historicalBasemap, spec.base).key,
  );
  // Per-overlay-source change detection (paint/tint signature + data identity)
  // so a repeated reconcile is a genuine no-op instead of a wipe-and-re-add.
  const overlayStateRef = useRef<
    Record<string, { sig: string; data: GeoJsonFeatureCollection }>
  >({});

  const hasSteps = !!spec.steps?.length;
  const interactions = spec.interactions ?? {};
  const stepCount = spec.steps?.length ?? 0;
  // Derived (not stored) so a shrinking spec can't leave the stepper stranded —
  // avoids a setState-in-effect clamp.
  const clampedStep = stepCount > 0 ? Math.min(stepIndex, stepCount - 1) : 0;

  // Keep the imperative-callback refs fresh WITHOUT writing them during render
  // (react-hooks/refs). Declared first so it runs before the map effects below.
  useEffect(() => {
    specRef.current = spec;
    baseRef.current = base;
    stepRef.current = clampedStep;
    visibilityRef.current = layerVisible;
    onPinDropRef.current = onPinDrop;
  });

  // Which bases the kid may flip between. Hidden for graded tasks or when the
  // spec turns it off; defaults to the explore trio.
  const baseToggleBases = useMemo<GeoBase[] | null>(() => {
    if (spec.task) return null;
    // The pill STAYS in era mode: every base has an era-appropriate rendering
    // (hosted style for Map; cleaned imagery/terrain + injected era borders
    // for the others), so flipping bases never leaves the time period.
    if (interactions.baseToggle === false) return null;
    // Model tolerance: the contract says GeoBase[] | false, but tutors send
    // `baseToggle: true` meaning "yes, allow it" (seen live). Anything that
    // isn't an explicit array means the default explore trio.
    const raw = interactions.baseToggle;
    const bases = Array.isArray(raw)
      ? raw
      : (["satellite", "terrain", "political"] as GeoBase[]);
    return bases.length > 0 ? bases : null;
  }, [spec.task, interactions.baseToggle]);

  // ── Tutor-reveal reconciliation ──────────────────────────────────────────
  // A layer's visibility is seeded from `initiallyVisible`. When the tutor's
  // spec CHANGES that value (predict-before-reveal), the new value WINS over any
  // local toggle; otherwise the kid's toggle is preserved.
  useEffect(() => {
    const layers = spec.layers ?? [];
    setLayerVisible((prev) => {
      const next = { ...prev };
      const appliedInit = appliedInitialRef.current;
      for (const l of layers) {
        const desired = l.initiallyVisible ?? true;
        if (!(l.id in appliedInit) || appliedInit[l.id] !== desired) {
          next[l.id] = desired;
          appliedInit[l.id] = desired;
        }
      }
      for (const id of Object.keys(next)) {
        if (!layers.some((l) => l.id === id)) {
          delete next[id];
          delete appliedInit[id];
        }
      }
      return next;
    });
  }, [spec.layers]);

  // ── Imperative helpers (stable; read refs) ───────────────────────────────
  // The set of layer ids that should currently render (stepper wins over chips).
  const computeVisibleIds = useCallback((): Set<string> => {
    const s = specRef.current;
    const layers = s.layers ?? [];
    if (s.steps?.length) {
      const step = s.steps[Math.min(stepRef.current, s.steps.length - 1)];
      return new Set(step?.visibleLayerIds ?? []);
    }
    return new Set(layers.filter((l) => visibilityRef.current[l.id]).map((l) => l.id));
  }, []);

  const applyVisibility = useCallback(
    (map: MapboxMap) => {
      // No isStyleLoaded() gate: that flag is often still false inside the
      // style.load handler, and silently skipping here let answer-bearing
      // layers paint VISIBLE before their hide landed (a predict-before-reveal
      // leak caught live — the rainfall label showed pre-reveal). getStyle() +
      // getLayer() are safe during load and are all we need.
      const style = map.getStyle();
      if (!style) return;
      const visibleIds = computeVisibleIds();
      for (const layer of specRef.current.layers ?? []) {
        const vis = visibleIds.has(layer.id) ? "visible" : "none";
        const prefix = `${SUBLAYER_PREFIX}${layer.id}::`;
        for (const l of style.layers ?? []) {
          if (l.id.startsWith(prefix) && map.getLayer(l.id)) {
            // Guard the write so a re-entrant reconcile (e.g. on `idle`) mutates
            // nothing when already correct and can't spin the map's render loop.
            if ((map.getLayoutProperty(l.id, "visibility") ?? "visible") !== vis) {
              map.setLayoutProperty(l.id, "visibility", vis);
            }
          }
        }
      }
    },
    [computeVisibleIds],
  );

  // Idempotent overlay sync: add missing sources/sublayers, refresh changed
  // data, rebuild a layer whose paint/tint changed, and prune layers no longer
  // in the spec. Existence is checked against the LIVE map (getSource/getLayer),
  // so after a setStyle wipes the custom style everything is transparently
  // re-added. A no-op reconcile issues ZERO mapbox writes.
  const reconcileOverlays = useCallback(
    (map: MapboxMap) => {
      const style = map.getStyle();
      if (!style) return;
      const layers = specRef.current.layers ?? [];
      const desiredIds = new Set(layers.map((l) => l.id));

      // Prune stale sublayers first, then their now-orphaned sources.
      for (const l of style.layers ?? []) {
        if (l.id.startsWith(SUBLAYER_PREFIX)) {
          const owner = l.id.slice(SUBLAYER_PREFIX.length).split("::")[0];
          if (!desiredIds.has(owner) && map.getLayer(l.id)) map.removeLayer(l.id);
        }
      }
      for (const sid of Object.keys(style.sources ?? {})) {
        if (sid.startsWith(SOURCE_PREFIX)) {
          const owner = sid.slice(SOURCE_PREFIX.length);
          if (!desiredIds.has(owner) && map.getSource(sid)) {
            map.removeSource(sid);
            delete overlayStateRef.current[sid];
          }
        }
      }

      const visibleIds = computeVisibleIds();
      for (const layer of layers) {
        const data = resolveSourceData(layer.source, layer.paint);
        if (!data) {
          // Loud skip: an unresolvable source is an authoring/registry bug the
          // validator should have caught — never silently render "no layer".
          console.warn(`[GeoMap] layer "${layer.id}" source did not resolve`, layer.source);
          continue;
        }
        const sourceId = `${SOURCE_PREFIX}${layer.id}`;
        const sig = overlaySig(layer);
        const vis = visibleIds.has(layer.id) ? "visible" : "none";
        const prev = overlayStateRef.current[sourceId];
        const src = map.getSource(sourceId) as
          | { setData?: (d: GeoJsonFeatureCollection) => void }
          | undefined;
        const hasSublayers = (style.layers ?? []).some((l) =>
          l.id.startsWith(`${SUBLAYER_PREFIX}${layer.id}::`),
        );

        if (!src) {
          // Fresh add (first paint, or after a base setStyle wiped the style).
          map.addSource(sourceId, { type: "geojson", data } as Parameters<
            typeof map.addSource
          >[1]);
          addOverlaySublayers(map, layer, sourceId, vis);
        } else {
          if (!prev || prev.data !== data) src.setData?.(data);
          if (!prev || prev.sig !== sig || !hasSublayers) {
            for (const l of style.layers ?? []) {
              if (l.id.startsWith(`${SUBLAYER_PREFIX}${layer.id}::`) && map.getLayer(l.id)) {
                map.removeLayer(l.id);
              }
            }
            addOverlaySublayers(map, layer, sourceId, vis);
          }
        }
        overlayStateRef.current[sourceId] = { sig, data };
      }
    },
    [computeVisibleIds],
  );

  /**
   * Marker/pin labels, placed by MAPBOX rather than by us.
   *
   * `textVariableAnchor` gives the renderer eight candidate anchors per label
   * and it picks the first that is free, per frame, as part of the render pass —
   * so a label can never drift behind the map during a pan. When nothing is
   * free, `textOptional` HIDES the label rather than parking it elsewhere and
   * drawing a leader line to it: shifting and hiding are the two moves in this
   * model. Previously each marker drew its own pinned DOM pill, outside
   * collision entirely, so clustered markers produced overlapping pills.
   *
   * Idempotent like every other reconcile step: existence is checked against
   * the LIVE map, so a base `setStyle` (which wipes custom layers AND images)
   * transparently re-adds all three pieces.
   */
  const reconcileLabels = useCallback((map: MapboxMap) => {
    const style = map.getStyle();
    if (!style) return;

    if (!map.hasImage(LABEL_SPACER_IMAGE)) {
      map.addImage(LABEL_SPACER_IMAGE, {
        width: LABEL_SPACER_PX,
        height: LABEL_SPACER_PX,
        data: new Uint8Array(LABEL_SPACER_PX * LABEL_SPACER_PX * 4),
      });
    }

    const data = labelFeaturesRef.current;
    const src = map.getSource(LABEL_SOURCE) as
      | { setData?: (d: GeoJsonFeatureCollection) => void }
      | undefined;
    if (!src) {
      map.addSource(LABEL_SOURCE, { type: "geojson", data } as Parameters<
        typeof map.addSource
      >[1]);
    } else if (lastLabelDataRef.current !== data) {
      src.setData?.(data);
    }
    lastLabelDataRef.current = data;

    if (map.getLayer(LABEL_LAYER)) {
      // Keep labels on TOP. `reconcileOverlays` removes and re-adds an
      // overlay's sublayers whenever its paint identity changes, and a re-add
      // appends ABOVE this layer — so an edited overlay's fill would start
      // washing out the marker labels. Guarded like every other reconcile
      // write: only move when it isn't already last, so a settled pass is inert.
      const ids = (map.getStyle()?.layers ?? []).map((l) => l.id);
      if (ids[ids.length - 1] !== LABEL_LAYER) map.moveLayer(LABEL_LAYER);
    } else {
      map.addLayer({
        id: LABEL_LAYER,
        type: "symbol",
        source: LABEL_SOURCE,
        layout: {
          "icon-image": LABEL_SPACER_IMAGE,
          "icon-allow-overlap": true,
          "icon-anchor": "center",
          "text-field": ["get", "label"],
          "text-size": 12.5,
          "text-variable-anchor": [
            "top",
            "bottom",
            "left",
            "right",
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
          ],
          "text-radial-offset": 1.1,
          "text-justify": "auto",
          "text-allow-overlap": false,
          "text-optional": true,
          "text-padding": 4,
          "symbol-sort-key": ["get", "sortKey"],
        },
        paint: {
          "text-color": "#111827",
          "text-halo-color": "rgba(255,255,255,0.95)",
          "text-halo-width": 1.6,
        },
      } as Parameters<typeof map.addLayer>[0]);
    }
  }, []);

  // Everything mapbox drops on setStyle (projection, base-symbol visibility,
  // terrain, overlays), re-applied IDEMPOTENTLY. Driven by the map's own
  // lifecycle events (style.load, idle) plus the prop-change effects — never a
  // fragile one-shot. Every write is guarded, so a settled reconcile is inert.
  const reconcile = useCallback(
    (map: MapboxMap) => {
      // getStyle() (not isStyleLoaded()) is the only guard: the flag is
      // routinely still false inside style.load, and gating on it silently
      // skipped the whole pass on a fresh load (modern labels leaking on the
      // unlabeled base, overlays never added). No mapbox `error` is swallowed —
      // a dev error listener is wired at creation.
      const style = map.getStyle();
      if (!style) return;
      const s = specRef.current;
      const b = baseRef.current;

      // Projection (guarded — write only on an actual change).
      const desiredProjection = s.globe ? "globe" : "mercator";
      if ((map.getProjection()?.name ?? "mercator") !== desiredProjection) {
        map.setProjection({ name: desiredProjection });
      }

      // How the base gets cleaned depends on which style is driving the canvas:
      // · hosted era style   → pre-cleaned at the STYLE level; touch nothing
      //   (hiding its symbols would erase the era's own names).
      // · era-cleaned base   → satellite/terrain in era mode: hide ALL base
      //   symbols AND all modern human line-work (admin borders, roads,
      //   transit) — the era's borders/labels are injected separately below.
      // · curated base       → the pre-era behavior (hideSymbols for
      //   politicalUnlabeled; hideBaseBoundaries on request).
      const resolved = resolveStyle(s.historicalBasemap, b);

      const hideAllBaseSymbols =
        !resolved.isHostedEra && (resolved.isEraCleaned || baseStyle(b).hideSymbols);
      if (hideAllBaseSymbols) {
        for (const l of style.layers ?? []) {
          if (l.type === "symbol" && !isOwnLayer(l.id) && map.getLayer(l.id)) {
            if (map.getLayoutProperty(l.id, "visibility") !== "none") {
              map.setLayoutProperty(l.id, "visibility", "none");
            }
          }
        }
      }

      // Modern line-work suppression. Two triggers: `hideBaseBoundaries` hides
      // admin borders only (the historical-overlay case — today's Poland must
      // not bleed through under Europe-in-1914); era-cleaned bases hide admin
      // AND roads/transit ("modern highway boundaries" have no place on a 1914
      // satellite). Bidirectional + guarded, so a tutor update flipping the
      // era/flag off brings the modern base back. Core mapbox styles name
      // these layers admin-* / road-* / bridge-* / tunnel-* / transit-* /
      // aerialway-* / ferry*; our own sublayers are excluded by prefix.
      if (!resolved.isHostedEra) {
        const hideAdmin = resolved.isEraCleaned || s.hideBaseBoundaries === true;
        const hideRoads = resolved.isEraCleaned;
        for (const l of style.layers ?? []) {
          if (isOwnLayer(l.id) || !map.getLayer(l.id)) continue;
          if (l.type !== "line" && l.type !== "symbol") continue;
          const isAdmin = l.id.startsWith("admin-");
          const isRoadish = /^(road|bridge|tunnel|transit|aerialway|ferry)/.test(l.id);
          let desired: "visible" | "none" | null = null;
          if (isAdmin) desired = hideAdmin ? "none" : "visible";
          else if (isRoadish) desired = hideRoads ? "none" : "visible";
          if (desired === null) continue;
          // Symbols already handled above when hiding everything.
          if (l.type === "symbol" && hideAllBaseSymbols) continue;
          const current = map.getLayoutProperty(l.id, "visibility") ?? "visible";
          if (current !== desired) {
            map.setLayoutProperty(l.id, "visibility", desired);
          }
        }
      }

      // 3D terrain: on for the terrain base even without the flag (guarded).
      const terrainOn = b === "terrain" ? true : (s.terrain3d ?? false);
      if (terrainOn) {
        if (!map.getSource(DEM_SOURCE)) {
          map.addSource(DEM_SOURCE, {
            type: "raster-dem",
            url: "mapbox://mapbox.mapbox-terrain-dem-v1",
            tileSize: 512,
            maxzoom: 14,
          });
        }
        if (!map.getTerrain()) map.setTerrain({ source: DEM_SOURCE, exaggeration: 1.5 });
        if (!map.getLayer(HILLSHADE_LAYER)) {
          map.addLayer({
            id: HILLSHADE_LAYER,
            type: "hillshade",
            source: DEM_SOURCE,
            paint: { "hillshade-exaggeration": 0.5 },
          });
        }
      } else if (map.getTerrain()) {
        map.setTerrain(null);
      }

      // Era injection on cleaned bases (satellite/terrain in era mode): the
      // era's borders + names drawn as always-on LINES + LABELS — never a fill,
      // the base's own imagery/land shows through. Not a spec layer: no chip,
      // no toggle, it IS the basemap's line-work for that era. Removed
      // (guarded) the moment the era or base stops needing it. The hosted
      // political era style carries its own borders, so it never gets this.
      {
        const wantEra = resolved.isEraCleaned && resolved.era;
        const onSatellite = b === "satellite";
        if (wantEra) {
          const entry = resolveRegistryEntry(resolved.era!.datasetId);
          if (!entry) {
            console.warn(
              `[GeoMap] era dataset "${resolved.era!.datasetId}" did not resolve`,
            );
          } else {
            if (!map.getSource(ERA_SOURCE)) {
              map.addSource(ERA_SOURCE, {
                type: "geojson",
                data: entry.data,
              } as Parameters<typeof map.addSource>[1]);
            }
            if (!map.getLayer(ERA_CASING_LAYER)) {
              map.addLayer({
                id: ERA_CASING_LAYER,
                type: "line",
                source: ERA_SOURCE,
                paint: {
                  "line-color": onSatellite ? "#0b1220" : "#ffffff",
                  "line-width": 3,
                  "line-opacity": 0.55,
                },
              });
            }
            if (!map.getLayer(ERA_LINE_LAYER)) {
              map.addLayer({
                id: ERA_LINE_LAYER,
                type: "line",
                source: ERA_SOURCE,
                paint: {
                  "line-color": onSatellite ? "#ffffff" : "#4a5568",
                  "line-width": 1.5,
                },
              });
            }
            if (!map.getLayer(ERA_NAME_LAYER)) {
              map.addLayer({
                id: ERA_NAME_LAYER,
                type: "symbol",
                source: ERA_SOURCE,
                filter: ["==", ["get", "labelPoint"], true],
                layout: {
                  "symbol-placement": "point",
                  "text-field": ["get", "name"],
                  "text-size": 11,
                  "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
                },
                paint: {
                  "text-color": onSatellite ? "#ffffff" : "#374151",
                  "text-halo-color": onSatellite
                    ? "rgba(11,18,32,0.85)"
                    : "rgba(255,255,255,0.85)",
                  "text-halo-width": 1.2,
                },
              });
            }
            // Era layers are ALWAYS visible while era-cleaned — repair, don't
            // just add (the reconcile-desired-state principle; a stale hide
            // must not stick).
            for (const lid of [ERA_NAME_LAYER, ERA_LINE_LAYER, ERA_CASING_LAYER]) {
              if (
                map.getLayer(lid) &&
                (map.getLayoutProperty(lid, "visibility") ?? "visible") !== "visible"
              ) {
                map.setLayoutProperty(lid, "visibility", "visible");
              }
            }
          }
        } else {
          for (const lid of [ERA_NAME_LAYER, ERA_LINE_LAYER, ERA_CASING_LAYER]) {
            if (map.getLayer(lid)) map.removeLayer(lid);
          }
          if (map.getSource(ERA_SOURCE)) map.removeSource(ERA_SOURCE);
        }
      }

      reconcileOverlays(map);
      reconcileLabels(map);
      applyVisibility(map);
    },
    [reconcileOverlays, reconcileLabels, applyVisibility],
  );

  // ── Create the map once (StrictMode-safe) ─────────────────────────────────
  // The instance is created HERE and FULLY torn down in cleanup, with no shared
  // module state, so React's dev double-mount (mount → cleanup → mount) can't
  // leave a torn-down instance driving the canvas or race two setups on one
  // container. All dynamic state is read through refs, and the imperative work
  // is an idempotent reconcile bound to the map's OWN events — so whichever
  // instance survives converges to the correct picture on its own.
  useEffect(() => {
    if (!containerRef.current) return;
    mapboxgl.accessToken = token;
    const cam = specRef.current.camera;
    const initialStyle = resolveStyle(specRef.current.historicalBasemap, baseRef.current);
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: initialStyle.url,
      center: cam.center,
      zoom: cam.zoom,
      pitch: cam.pitch ?? 0,
      bearing: cam.bearing ?? 0,
      projection: { name: specRef.current.globe ? "globe" : "mercator" },
      attributionControl: true,
    });
    mapRef.current = map;
    appliedStyleKeyRef.current = initialStyle.key;
    overlayStateRef.current = {};
    if (process.env.NODE_ENV !== "production") {
      // Dev-only debug handle (agent/browser-console inspection of the live map).
      (window as unknown as { __rhGeoMap?: unknown }).__rhGeoMap = map;
    }
    // ALWAYS log mapbox error events — including in production. A silently
    // failing map is exactly how the prod blank-map bug shipped: every failure
    // mode (style/tile/token errors) surfaced only through this event, and the
    // old dev-only gate meant prod consoles showed nothing at all.
    map.on("error", (e) => console.error("[GeoMap] mapbox error:", e?.error ?? e));

    // The map's OWN lifecycle events drive the idempotent reconcile — never a
    // one-shot. `style.load` fires on the initial style AND after every base
    // setStyle (which drops all custom layers); `idle` is the settled-state
    // safety net that heals anything that didn't stick at the earlier,
    // still-loading moment. Because every reconcile write is guarded, a settled
    // `idle` reconcile is inert and cannot spin the render loop.
    let didInitialResize = false;
    map.on("style.load", () => reconcile(map));
    map.on("idle", () => {
      if (!didInitialResize) {
        didInitialResize = true;
        map.resize(); // correct any stale internal size cached at creation.
      }
      reconcile(map);
    });
    map.on("load", () => {
      map.resize();
      setReady(true);
    });

    // tapToPin: a bare-map click drops a scholar pin (marker clicks don't fire
    // this — they're DOM overlays above the canvas). Default GENEROUS on an
    // explore map (no task): pinning is the kid's basic annotation power and
    // the quests' predict-before-reveal beats depend on it. Graded task maps
    // manage their own pin flow (the geoLocate renderer), so they default off.
    map.on("click", (e: MapMouseEvent) => {
      const spec = specRef.current;
      const tapToPin = spec.interactions?.tapToPin ?? !spec.task;
      if (!tapToPin) return;
      onPinDropRef.current?.([e.lngLat.lng, e.lngLat.lat]);
    });

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => map.resize())
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);

    return () => {
      ro?.disconnect();
      for (const m of tutorMarkersRef.current) m.remove();
      for (const m of pinMarkersRef.current) m.remove();
      tutorMarkersRef.current = [];
      pinMarkersRef.current = [];
      map.remove();
      // Only clear the ref if THIS instance still owns it (StrictMode cleanup
      // for map A must not null out a freshly-created map B).
      if (mapRef.current === map) mapRef.current = null;
      setReady(false);
    };
    // Create exactly once; token is fixed for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Style switch (base pill OR a tutor update adding/removing a historical
  // basemap) → setStyle (style.load then reconciles everything). Guard on the
  // LAST-APPLIED style key, not just `ready`: without this the effect re-fires
  // when `ready` flips true and redundantly setStyle's the SAME style,
  // async-reloading it and wiping the overlays/symbol-hiding style.load just
  // applied — with no fresh style.load to re-apply them (the initial-load race).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const resolved = resolveStyle(spec.historicalBasemap, base);
    if (appliedStyleKeyRef.current === resolved.key) return;
    appliedStyleKeyRef.current = resolved.key;
    overlayStateRef.current = {}; // setStyle drops custom sources; forget them.
    map.setStyle(resolved.url);
  }, [base, ready, spec.historicalBasemap]);

  // Spec changed (data/terrain/globe/layers) without a base switch → reconcile
  // live and in place (never re-create the map or steal camera focus).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    reconcile(map);
  }, [spec, ready, reconcile]);

  // Visibility / step changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    applyVisibility(map);
  }, [layerVisible, clampedStep, ready, applyVisibility]);

  // Camera flyTo ONLY when the spec's camera identity changes (tutor update);
  // never on unrelated re-renders (local state, pin edits keep the same object).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (spec.camera === lastCameraRef.current) return;
    lastCameraRef.current = spec.camera;
    map.flyTo({
      center: spec.camera.center,
      zoom: spec.camera.zoom,
      pitch: spec.camera.pitch ?? 0,
      bearing: spec.camera.bearing ?? 0,
      duration: 1200,
      essential: true,
    });
  }, [spec.camera, ready]);

  // Step camera moves.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !hasSteps) return;
    const cam = spec.steps?.[clampedStep]?.camera;
    if (!cam?.center) return;
    map.flyTo({
      center: cam.center,
      zoom: cam.zoom ?? map.getZoom(),
      pitch: cam.pitch ?? map.getPitch(),
      bearing: cam.bearing ?? map.getBearing(),
      duration: 900,
      essential: true,
    });
  }, [clampedStep, ready, hasSteps, spec.steps]);

  // Gestures — honor the interaction booleans (default enabled).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const i = spec.interactions ?? {};
    if (i.pan ?? true) map.dragPan.enable();
    else map.dragPan.disable();
    if (i.zoom ?? true) {
      map.scrollZoom.enable();
      map.doubleClickZoom.enable();
      map.touchZoomRotate.enable();
    } else {
      map.scrollZoom.disable();
      map.doubleClickZoom.disable();
    }
    if (i.rotate ?? true) {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
    } else {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
    }
    if (i.pitch ?? true) map.touchPitch.enable();
    else map.touchPitch.disable();
  }, [spec.interactions, ready]);

  // Tutor markers — the emoji glyph only, centred on the coordinate so it lines
  // up with the transparent spacer icon that reserves its footprint in
  // collision. Byte-for-byte the native `markerGlyph` treatment.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of tutorMarkersRef.current) m.remove();
    tutorMarkersRef.current = [];
    for (const marker of spec.markers ?? []) {
      const el = document.createElement("div");
      el.style.cssText =
        "font-size:22px;line-height:24px;" +
        "filter:drop-shadow(0 1px 2px rgba(0,0,0,0.35));";
      // Emoji ONLY — the label is drawn by the symbol layer (reconcileLabels),
      // so it participates in collision. An emoji cannot go in `text-field`:
      // Mapbox renders text through an SDF glyph pipeline with no emoji
      // coverage, so the glyph would silently drop.
      el.textContent = marker.emoji ?? "📌";
      if (marker.label) el.title = marker.label;
      const mk = new mapboxgl.Marker({ element: el, anchor: "center" })
        .setLngLat(marker.lngLat)
        .addTo(map);
      tutorMarkersRef.current.push(mk);
    }
  }, [spec.markers, ready]);

  // Keep the label source in step with markers + pins. The ref feeds
  // `reconcileLabels` (which also runs on style.load, after a base switch wipes
  // the style); this effect pushes the change when only the DATA moved.
  useEffect(() => {
    labelFeaturesRef.current = buildLabelFeatures(spec.markers, scholarPins);
    const map = mapRef.current;
    if (map && ready) reconcileLabels(map);
  }, [spec.markers, scholarPins, ready, reconcileLabels]);

  // Scholar pins (controlled; the kid's own marks — tap to remove).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of pinMarkersRef.current) m.remove();
    pinMarkersRef.current = [];
    for (const pin of scholarPins) {
      const el = document.createElement("button");
      el.type = "button";
      el.title = onPinRemove ? "Tap to remove your pin" : (pin.label ?? "Your pin");
      el.style.cssText =
        "border:none;background:transparent;cursor:pointer;font-size:22px;line-height:1;" +
        "filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4));";
      el.textContent = "📍";
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onPinRemove?.(pin.id);
      });
      const mk = new mapboxgl.Marker({ element: el, anchor: "bottom" })
        .setLngLat(pin.lngLat)
        .addTo(map);
      pinMarkersRef.current.push(mk);
    }
  }, [scholarPins, ready, onPinRemove]);

  // ── Controls (React overlays) ─────────────────────────────────────────────
  const ctrlSize = compact ? "2xs" : "xs";
  const layers = spec.layers ?? [];
  const showLayerChips = !hasSteps && layers.length > 0;
  const activeStep = hasSteps ? spec.steps?.[clampedStep] : undefined;

  return (
    <Box position="relative" h="100%" w="100%" bg="gray.100" overflow="hidden">
      {/* INLINE styles, deliberately: mapbox-gl.css stamps `.mapboxgl-map
          { position: relative }` on this very element, and a Chakra/emotion
          class ties it on specificity — stylesheet ORDER then decides, and
          dev (emotion last) vs prod (extracted CSS last) order DIFFERS. Prod
          silently collapsed the container to 0-height (blank map, no error,
          mapbox's 300px default canvas). Inline styles outrank any stylesheet
          in every build. Keep width/height alongside inset so the box fills
          its relative parent even if position ever falls back to relative. */}
      <Box
        ref={containerRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />

      {/* Title caption + layer chips, stacked top-left. The bottom edge belongs
          to Mapbox chrome (wordmark bottom-left, attribution bottom-right) —
          nothing of ours may sit there. */}
      {((!compact && spec.title) || showLayerChips) && (
        <Flex
          position="absolute"
          top={2}
          left={2}
          direction="column"
          align="flex-start"
          gap={1.5}
          maxW="70%"
        >
          {!compact && spec.title && (
            <Box
              bg="white"
              px={2.5}
              py={1}
              borderRadius="md"
              shadow="0 1px 3px rgba(0,0,0,0.2)"
            >
              <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="charcoal.500">
                {spec.title}
              </Text>
            </Box>
          )}
          {showLayerChips && (
            <HStack gap={1} flexWrap="wrap">
              {layers.map((l) => {
                const on = !!layerVisible[l.id];
                return (
                  <Button
                    key={l.id}
                    size={ctrlSize}
                    variant={on ? "solid" : "outline"}
                    colorPalette="violet"
                    bg={on ? undefined : "white"}
                    borderRadius="full"
                    fontFamily="heading"
                    shadow="0 1px 3px rgba(0,0,0,0.2)"
                    onClick={() =>
                      setLayerVisible((prev) => ({ ...prev, [l.id]: !prev[l.id] }))
                    }
                  >
                    {l.label}
                  </Button>
                );
              })}
            </HStack>
          )}
        </Flex>
      )}

      {/* Clear pins — appears only when the kid HAS pins and the host lets us
          clear them. Bottom-RIGHT above mapbox's attribution line (the ⓘ
          collapses at these widths), clear of the top controls and of the
          wordmark's bottom-left corner. When a stepper is present it owns the
          bottom band edge-to-edge at narrow widths, so sit above it. */}
      {onPinsClear && scholarPins.length > 0 && (
        <Button
          position="absolute"
          bottom={hasSteps ? 14 : 9}
          right={2}
          size={ctrlSize}
          variant="outline"
          colorPalette="violet"
          bg="white"
          borderRadius="full"
          fontFamily="heading"
          shadow="0 1px 3px rgba(0,0,0,0.2)"
          onClick={onPinsClear}
        >
          Clear pins
        </Button>
      )}

      {/* Base toggle pill */}
      {baseToggleBases && (
        <HStack
          position="absolute"
          top={2}
          right={2}
          gap={0.5}
          bg="white"
          p={0.5}
          borderRadius="full"
          shadow="0 1px 3px rgba(0,0,0,0.2)"
        >
          {baseToggleBases.map((b) => (
            <Button
              key={b}
              size={ctrlSize}
              variant={b === base ? "solid" : "ghost"}
              colorPalette="violet"
              borderRadius="full"
              fontFamily="heading"
              onClick={() => setBase(b)}
            >
              {baseLabel(b)}
            </Button>
          ))}
        </HStack>
      )}

      {/* Stepper */}
      {hasSteps && (
        <Flex
          position="absolute"
          bottom={2}
          left="50%"
          transform="translateX(-50%)"
          align="center"
          gap={2}
          bg="white"
          px={2}
          py={1.5}
          borderRadius="full"
          shadow="0 1px 4px rgba(0,0,0,0.25)"
          maxW="calc(100% - 16px)"
        >
          <Button
            size="sm"
            variant="ghost"
            colorPalette="violet"
            borderRadius="full"
            disabled={clampedStep <= 0}
            onClick={() => setStepIndex(Math.max(0, clampedStep - 1))}
            aria-label="Previous step"
          >
            <CaretLeft />
          </Button>
          <Box textAlign="center" minW={0}>
            <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="charcoal.500">
              {activeStep?.label ?? `Step ${clampedStep + 1}`}
            </Text>
            {activeStep?.description && (
              <Text
                fontFamily="body"
                fontSize="xs"
                color="charcoal.400"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                maxW="240px"
              >
                {activeStep.description}
              </Text>
            )}
          </Box>
          <Button
            size="sm"
            variant="ghost"
            colorPalette="violet"
            borderRadius="full"
            disabled={clampedStep >= (spec.steps?.length ?? 1) - 1}
            onClick={() =>
              setStepIndex(Math.min((spec.steps?.length ?? 1) - 1, clampedStep + 1))
            }
            aria-label="Next step"
          >
            <CaretRight />
          </Button>
        </Flex>
      )}
    </Box>
  );
}

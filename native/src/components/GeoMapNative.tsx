import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import Mapbox, {
  Camera,
  CircleLayer,
  FillLayer,
  Images,
  LineLayer,
  MapView,
  PointAnnotation,
  RasterDemSource,
  ShapeSource,
  SymbolLayer,
  Terrain,
} from "@rnmapbox/maps";

import {
  GEOMAP_MAX_SCHOLAR_PINS,
  type GeoBase,
  type GeoJsonFeatureCollection,
  type GeoLayer,
  type GeoLayerSource,
  type GeoMapRendererProps,
  type GeoMapSpec,
  type LngLat,
  type PaintPreset,
  type PaintTint,
  type ScholarPin,
} from "../../vendor/geomap/types";
import { resolveHistoricalBasemap } from "../../vendor/geomap/historicalBasemaps";
import {
  drawableFeatureCollection,
  pathStyleForPreset,
  type PathStyle,
} from "../../vendor/geomap/geo";
import { fonts, useColors } from "@/theme";

/**
 * GeoMapNative — the native (@rnmapbox/maps) renderer for a `GeoMapSpec`, the
 * inline twin of the web `components/geomap/GeoMap.tsx`. Both implement the SAME
 * shared `GeoMapRendererProps` contract (vendored `../../vendor/geomap/types`),
 * so a scholar sees the same governed cartography on iPad as on the web — no
 * webview, native gestures, native haptics.
 *
 * Token-gated exactly like the web renderer: with no `token` it renders the
 * friendly no-token/offline state and never touches Mapbox. When a token is
 * present, `GeoMapCard` mounts this inline (the webview launcher stays as the
 * no-token/offline fallback — see the swap seam in GeoMapCard.tsx).
 *
 * Governance is unchanged: a spec never carries a raw style URL. Bases come from
 * the closed `GeoBase` set (BASE_STYLE_URLS below); an era (`historicalBasemap`)
 * resolves through the vendored `historicalBasemaps` catalog; overlay paint is
 * the closed `PaintPreset` set (buildPaintLayers). The SDK is declarative, so
 * React reconciles source/layer/camera changes — no imperative add/remove churn.
 *
 * KNOWN NATIVE-vs-WEB GAPS (spike scope — see .lane-reports/lane-m.md):
 *   • Registry-keyed overlay layers (`source: { registry }`) and the
 *     satellite/terrain ERA border-injection both need the 15 MB `lib/geomap/
 *     registry` data, which is deliberately NOT vendored to native. Inline
 *     GeoJSON layers render fully; a registry layer renders nothing (dev-warn).
 *     Era mode is fully faithful on the POLITICAL base (the hosted era style
 *     bakes borders + names in — no registry needed).
 *   • `politicalUnlabeled` / era-cleaned label suppression: the RN SDK has no
 *     cheap per-base-layer visibility toggle for the loaded style's OWN layers,
 *     so base labels are not hidden natively (web hides them at style.load).
 */

// The ONE place raw base style URLs live on native — the closed GeoBase set,
// mirroring web `components/geomap/baseStyles.ts`. A spec never supplies these.
const BASE_STYLE_URLS: Record<GeoBase, string> = {
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
  terrain: "mapbox://styles/mapbox/outdoors-v12",
  political: "mapbox://styles/mapbox/light-v11",
  politicalUnlabeled: "mapbox://styles/mapbox/light-v11",
};

// Era base variants (a historical basemap is active) for the non-political
// bases — raw imagery / outdoors. Border/label INJECTION is a registry-backed
// gap on native (see header), so these render era-appropriate imagery without
// the injected historical line-work; the political base uses the hosted era
// style (fully baked) via resolveStyle below.
const ERA_BASE_STYLE_URLS: Partial<Record<GeoBase, string>> = {
  satellite: "mapbox://styles/mapbox/satellite-v9",
  terrain: "mapbox://styles/mapbox/outdoors-v12",
};

function baseLabel(base: GeoBase): string {
  switch (base) {
    case "satellite":
      return "Satellite";
    case "terrain":
      return "Terrain";
    case "political":
      return "Map";
    case "politicalUnlabeled":
      return "Plain";
  }
}

/**
 * The style URL actually driving the map + a stable key. An era is a MODE across
 * every base (mirrors web `resolveStyle`): political → the hosted era style;
 * satellite/terrain → the era base variant. The key changes only on a real
 * style switch, so React remounts the MapView style just once per switch.
 */
function resolveStyle(
  historicalBasemap: string | undefined,
  base: GeoBase,
): { key: string; url: string } {
  const era = historicalBasemap ? resolveHistoricalBasemap(historicalBasemap) : undefined;
  if (era) {
    const variant = ERA_BASE_STYLE_URLS[base];
    if (variant) return { key: `era:${historicalBasemap}:${base}`, url: variant };
    return { key: `era:${historicalBasemap}:map`, url: era.styleUrl };
  }
  return { key: `base:${base}`, url: BASE_STYLE_URLS[base] ?? BASE_STYLE_URLS.satellite };
}

// The small named palette — byte-for-byte the web `paintPresets.TINT_HEX`, so
// an overlay tints identically on both surfaces.
const TINT_HEX: Record<PaintTint, string> = {
  violet: "#AD60BF",
  blue: "#2b6cb0",
  green: "#1f9d6b",
  amber: "#b45309",
  red: "#b91c1c",
  gray: "#6b7280",
};
function tintHex(tint?: PaintTint): string {
  return TINT_HEX[tint ?? "violet"] ?? TINT_HEX.violet;
}

/**
 * Drawn-path cache. `ShapeSource` re-uploads whenever its `shape` prop changes
 * IDENTITY, and this runs inside render, so a fresh collection every pass would
 * push the whole source to the GPU on every re-render. Keyed weakly on the
 * authored collection, then on the layer's path style — the native twin of the
 * web renderer's cache, for the same reason.
 */
const drawableCache = new WeakMap<
  GeoJsonFeatureCollection,
  Map<PathStyle, GeoJsonFeatureCollection>
>();

function resolveSourceData(
  source: GeoLayerSource,
  preset: PaintPreset,
): GeoJsonFeatureCollection | null {
  // Native does NOT vendor the 15 MB registry (see header) — only inline GeoJSON
  // resolves here. A registry-keyed layer renders nothing (loud dev warn), the
  // same "loud skip" posture the web renderer takes for an unresolvable source.
  let raw: GeoJsonFeatureCollection | null = null;
  if ("geojson" in source) {
    raw = source.geojson ?? null;
  } else {
    if (__DEV__) {
      console.warn(
        `[GeoMapNative] registry layer "${(source as { registry: string }).registry}" ` +
          "is not available natively (registry data is web/server-only) — skipped.",
      );
    }
    return null;
  }
  if (!raw) return null;

  // Draw journey paths as schematic arcs, exactly as web does — SAME function,
  // same per-preset record, both read from vendor/geomap/geo. A journey arrow
  // that arced on web and ran straight on iPad would be a scholar-facing parity
  // gap, so neither surface reimplements the curve.
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

/**
 * The concrete @rnmapbox layer elements for one overlay's `PaintPreset` (+ tint),
 * mirroring web `buildPaintLayers` — same closed preset set, same palette, same
 * label rules — expressed as the RN SDK's declarative layer components (camelCase
 * style props). A preset may expand to several layers (fill + outline, line +
 * label).
 */
function buildPaintLayers(
  layerId: string,
  sourceId: string,
  preset: PaintPreset,
  tint: PaintTint | undefined,
): ReactElement[] {
  const color = tintHex(tint);
  const lid = (part: string) => `geolayer::${layerId}::${part}`;

  // Region datasets label themselves from an authored `labelPoint` companion
  // Point (one per state) — never every MultiPolygon part. Matches web.
  const regionNameLabel = (
    <SymbolLayer
      key={lid("name")}
      id={lid("name")}
      sourceID={sourceId}
      filter={["==", ["get", "labelPoint"], true]}
      style={{
        symbolPlacement: "point",
        textField: ["coalesce", ["get", "name"], ["get", "label"], ""],
        textSize: 11,
        textColor: "#374151",
        textHaloColor: "rgba(255,255,255,0.85)",
        textHaloWidth: 1.2,
      }}
    />
  );

  switch (preset) {
    case "regionFill":
      return [
        <FillLayer
          key={lid("fill")}
          id={lid("fill")}
          sourceID={sourceId}
          style={{ fillColor: color, fillOpacity: 0.18 }}
        />,
        <LineLayer
          key={lid("outline")}
          id={lid("outline")}
          sourceID={sourceId}
          style={{ lineColor: color, lineWidth: 2, lineOpacity: 1 }}
        />,
        regionNameLabel,
      ];
    case "regionOutline":
      return [
        <LineLayer
          key={lid("outline")}
          id={lid("outline")}
          sourceID={sourceId}
          style={{ lineColor: color, lineWidth: 2 }}
        />,
        regionNameLabel,
      ];
    case "isolines":
      return [
        <LineLayer
          key={lid("line")}
          id={lid("line")}
          sourceID={sourceId}
          style={{ lineColor: color, lineWidth: 1.5, lineOpacity: 0.9 }}
        />,
        <SymbolLayer
          key={lid("label")}
          id={lid("label")}
          sourceID={sourceId}
          style={{
            symbolPlacement: "line",
            textField: ["coalesce", ["get", "label"], ""],
            textSize: 12,
            textMaxAngle: 30,
            textColor: color,
            textHaloColor: "#ffffff",
            textHaloWidth: 1.4,
          }}
        />,
      ];
    case "arrows":
      return [
        <LineLayer
          key={lid("line")}
          id={lid("line")}
          sourceID={sourceId}
          style={{ lineColor: color, lineWidth: 2, lineOpacity: 0.9 }}
        />,
        <SymbolLayer
          key={lid("arrows")}
          id={lid("arrows")}
          sourceID={sourceId}
          style={{
            symbolPlacement: "line",
            symbolSpacing: 80,
            textField: "▶",
            textSize: 14,
            textKeepUpright: false,
            textRotationAlignment: "map",
            textAllowOverlap: true,
            textColor: color,
            textHaloColor: "#ffffff",
            textHaloWidth: 1,
          }}
        />,
      ];
    case "routeLine":
      return [
        <LineLayer
          key={lid("line")}
          id={lid("line")}
          sourceID={sourceId}
          style={{
            lineColor: color,
            lineWidth: 3,
            lineCap: "round",
            lineJoin: "round",
          }}
        />,
      ];
    case "points":
      return [
        <CircleLayer
          key={lid("circle")}
          id={lid("circle")}
          sourceID={sourceId}
          style={{
            circleColor: color,
            circleRadius: 5,
            circleStrokeColor: "#ffffff",
            circleStrokeWidth: 1.5,
          }}
        />,
        <SymbolLayer
          key={lid("label")}
          id={lid("label")}
          sourceID={sourceId}
          style={{
            textField: ["coalesce", ["get", "label"], ""],
            textSize: 12,
            textOffset: [0, 1.1],
            textAnchor: "top",
            textOptional: true,
            textColor: "#1a202c",
            textHaloColor: "#ffffff",
            textHaloWidth: 1.4,
          }}
        />,
      ];
  }
}

function NoTokenState({ compact }: { compact?: boolean }) {
  const colors = useColors();
  return (
    <View style={[styles.noToken, { backgroundColor: colors.bg }]}>
      <Text style={{ fontSize: compact ? 32 : 44, lineHeight: compact ? 36 : 48 }}>🗺️</Text>
      <Text style={[styles.noTokenTitle, { color: colors.navy }]}>
        Maps need the internet and a map key
      </Text>
      <Text style={[styles.noTokenBody, { color: colors.fgMuted }]}>
        Ask your teacher to turn maps on!
      </Text>
    </View>
  );
}

/** Which bases the kid may flip between (mirrors web `baseToggleBases`). */
function resolveBaseToggle(spec: GeoMapSpec): GeoBase[] | null {
  if (spec.task) return null;
  const raw = spec.interactions?.baseToggle;
  if (raw === false) return null;
  const bases = Array.isArray(raw) ? raw : (["satellite", "terrain", "political"] as GeoBase[]);
  return bases.length > 0 ? bases : null;
}

export function GeoMapNative(props: GeoMapRendererProps) {
  if (!props.token) return <NoTokenState compact={props.compact} />;
  return <GeoMapCanvas {...props} token={props.token} />;
}

type CanvasProps = GeoMapRendererProps & { token: string };

// The label source's two id namespaces (a feature's `kind` decides what a tap
// does — the layer is inert, see the note above the label ShapeSource).
const LABEL_SOURCE_ID = "geolabels";
const LABEL_LAYER_ID = "geolabels::text";
// A fully transparent 26×26 icon. It draws nothing; it exists so the renderer's
// collision engine RESERVES the emoji marker's footprint, and therefore places
// every label clear of every marker — not just clear of other labels.
const LABEL_SPACER_IMAGE = "geolabel-spacer";
// Module-level so the object identity is stable — `Images` is a PureComponent
// and an inline literal would re-fetch the asset on every render of the map.
const LABEL_IMAGES = {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro asset id.
  [LABEL_SPACER_IMAGE]: require("../../assets/images/geolabel-spacer.png"),
};

let tokenApplied: string | null = null;

function GeoMapCanvas({
  spec,
  scholarPins,
  onPinDrop,
  onPinRemove,
  onPinsClear,
  token,
  compact,
}: CanvasProps) {
  const colors = useColors();
  const cameraRef = useRef<Camera>(null);
  const [mapboxReady, setMapboxReady] = useState(tokenApplied === token);

  const [base, setBase] = useState<GeoBase>(spec.base);
  const [stepIndex, setStepIndex] = useState(0);
  const [layerVisible, setLayerVisible] = useState<Record<string, boolean>>({});

  const interactions = spec.interactions ?? {};
  const layers = useMemo(() => spec.layers ?? [], [spec.layers]);
  const hasSteps = !!spec.steps?.length;
  const stepCount = spec.steps?.length ?? 0;
  const clampedStep = stepCount > 0 ? Math.min(stepIndex, stepCount - 1) : 0;
  const baseToggle = useMemo(() => resolveBaseToggle(spec), [spec]);
  /**
   * Every label the map wants to show, as ONE GeoJSON source. Placement is the
   * RENDERER's job from here on: the SymbolLayer below declares variable anchors
   * and the engine picks a free one per frame (or drops the label), on the GPU,
   * in lockstep with the camera. Nothing here projects coordinates or measures
   * text — a JS-side layout pass can only ever chase the map by a frame.
   *
   * `sortKey` is the priority the collision engine breaks ties with: a tutor's
   * authored marker outranks a scholar's own pin.
   */
  const labelFeatures = useMemo<GeoJSON.FeatureCollection>(() => {
    const markers = (spec.markers ?? [])
      .filter((marker) => (marker.label?.trim() ?? "").length > 0)
      .map((marker) => ({
        type: "Feature" as const,
        id: `marker::${marker.id}`,
        properties: {
          kind: "marker",
          refId: marker.id,
          label: marker.label!.trim(),
          sortKey: 0,
        },
        geometry: { type: "Point" as const, coordinates: marker.lngLat },
      }));
    const pins = scholarPins
      .filter((pin) => (pin.label?.trim() ?? "").length > 0)
      .map((pin) => ({
        type: "Feature" as const,
        id: `pin::${pin.id}`,
        properties: {
          kind: "pin",
          refId: pin.id,
          label: pin.label!.trim(),
          sortKey: 1,
        },
        geometry: { type: "Point" as const, coordinates: pin.lngLat },
      }));
    return { type: "FeatureCollection", features: [...markers, ...pins] };
  }, [scholarPins, spec.markers]);

  const resolvedStyle = useMemo(
    () => resolveStyle(spec.historicalBasemap, base),
    [spec.historicalBasemap, base],
  );

  // Set the Mapbox access token before the MapView mounts (idempotent).
  useEffect(() => {
    let cancelled = false;
    if (tokenApplied !== token) {
      Mapbox.setAccessToken(token);
      tokenApplied = token;
    }
    Promise.resolve().then(() => {
      if (!cancelled) setMapboxReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Tutor-reveal reconciliation: `initiallyVisible` seeds a layer's visibility;
  // when the tutor's spec CHANGES that value the new value wins, else the kid's
  // toggle is kept (mirrors the web renderer's predict-before-reveal handling).
  const appliedInitRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    setLayerVisible((prev) => {
      const next = { ...prev };
      const appliedInit = appliedInitRef.current;
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
  }, [layers]);

  // Camera flyTo on a tutor camera change (identity change), never on unrelated
  // re-renders — the camera is otherwise uncontrolled (native gestures own it).
  const lastCameraRef = useRef<GeoMapSpec["camera"] | null>(null);
  useEffect(() => {
    if (spec.camera === lastCameraRef.current) return;
    lastCameraRef.current = spec.camera;
    cameraRef.current?.setCamera({
      centerCoordinate: spec.camera.center,
      zoomLevel: spec.camera.zoom,
      pitch: spec.camera.pitch ?? 0,
      heading: spec.camera.bearing ?? 0,
      animationDuration: 1200,
    });
  }, [spec.camera]);

  // Step camera moves.
  useEffect(() => {
    if (!hasSteps) return;
    const cam = spec.steps?.[clampedStep]?.camera;
    if (!cam?.center) return;
    cameraRef.current?.setCamera({
      centerCoordinate: cam.center,
      zoomLevel: cam.zoom,
      pitch: cam.pitch,
      heading: cam.bearing,
      animationDuration: 900,
    });
  }, [clampedStep, hasSteps, spec.steps]);

  const visibleLayerIds = useMemo<Set<string>>(() => {
    if (hasSteps) {
      const step = spec.steps?.[clampedStep];
      return new Set(step?.visibleLayerIds ?? []);
    }
    return new Set(layers.filter((l) => layerVisible[l.id]).map((l) => l.id));
  }, [hasSteps, spec.steps, clampedStep, layers, layerVisible]);

  const handleMapPress = useCallback(
    (feature: GeoJSON.Feature<GeoJSON.Point>) => {
      const tapToPin = interactions.tapToPin ?? !spec.task;
      if (!tapToPin || !onPinDrop) return;
      if (scholarPins.length >= GEOMAP_MAX_SCHOLAR_PINS) return;
      const coords = feature.geometry?.coordinates;
      if (!coords || coords.length < 2) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      onPinDrop([coords[0], coords[1]] as LngLat);
    },
    [interactions.tapToPin, spec.task, onPinDrop, scholarPins.length],
  );

  const removePin = useCallback(
    (pinId: string) => {
      if (!onPinRemove) return;
      Haptics.selectionAsync().catch(() => {});
      onPinRemove(pinId);
    },
    [onPinRemove],
  );

  /**
   * NOTE — the label layer is deliberately NOT interactive.
   *
   * It was, briefly: a `ShapeSource.onPress` made each label a 44×44 hit target.
   * But every label also carries an always-rendered transparent spacer icon (see
   * LABEL_SPACER_IMAGE), and iOS hit-tests RENDERED features — so the source
   * swallowed taps in a 44×44 box around every marker, including markers whose
   * label collision had hidden. The scholar-visible symptom is the bad one:
   * tap-to-pin silently doing nothing near a marker. Since a marker label has no
   * action to offer anyway, dropping the handler removes the dead zone outright.
   * Re-adding interactivity means giving the labels their own source WITHOUT the
   * spacer, not putting `onPress` back on this one.
   */

  const ctrlColor = colors.violet;

  if (!mapboxReady) return <View style={styles.root} />;

  return (
    <View style={styles.root}>
      <MapView
        style={styles.map}
        styleURL={resolvedStyle.url}
        projection={spec.globe ? "globe" : "mercator"}
        scaleBarEnabled={false}
        compassEnabled={false}
        attributionEnabled
        logoEnabled
        zoomEnabled={interactions.zoom ?? true}
        scrollEnabled={interactions.pan ?? true}
        rotateEnabled={interactions.rotate ?? true}
        pitchEnabled={interactions.pitch ?? true}
        onPress={handleMapPress}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: spec.camera.center,
            zoomLevel: spec.camera.zoom,
            pitch: spec.camera.pitch ?? 0,
            heading: spec.camera.bearing ?? 0,
          }}
        />

        {(base === "terrain" || spec.terrain3d) && (
          <RasterDemSource
            id="geo-dem"
            url="mapbox://mapbox.mapbox-terrain-dem-v1"
            tileSize={514}
          >
            <Terrain exaggeration={1.5} />
          </RasterDemSource>
        )}

        {/* Overlay layers (inline GeoJSON only on native — see header). Whole
            layers are conditionally rendered by visibility so React add/removes
            the source + sublayers together. */}
        {layers.map((layer: GeoLayer) => {
          if (!visibleLayerIds.has(layer.id)) return null;
          const data = resolveSourceData(layer.source, layer.paint);
          if (!data) return null;
          const sourceId = `geosrc::${layer.id}`;
          return (
            <ShapeSource key={sourceId} id={sourceId} shape={data as GeoJSON.FeatureCollection}>
              {buildPaintLayers(layer.id, sourceId, layer.paint, layer.tint)}
            </ShapeSource>
          );
        })}

        {/* Tutor markers — emoji stays pinned; labels are decluttered above. */}
        {(spec.markers ?? []).map((marker) => (
          <PointAnnotation
            key={`marker::${marker.id}`}
            id={`marker::${marker.id}`}
            coordinate={marker.lngLat}
          >
            <Text style={styles.markerGlyph}>{marker.emoji ?? "📌"}</Text>
          </PointAnnotation>
        ))}

        {/* Scholar pins — controlled; tap to remove the kid's own mark. */}
        {scholarPins.map((pin: ScholarPin) => (
          <PointAnnotation
            key={`pin::${pin.id}`}
            id={`pin::${pin.id}`}
            coordinate={pin.lngLat}
            onSelected={() => removePin(pin.id)}
          >
            <Text style={styles.pinGlyph}>📍</Text>
          </PointAnnotation>
        ))}

        {/*
          Labels for markers + named scholar pins, placed by Mapbox itself.

          `textVariableAnchor` hands the renderer eight candidate anchors and it
          picks the first that is free — the same "try positions around the pin"
          idea a JS layout pass would implement, except it runs per frame on the
          GPU, so a label can never drift behind the map during a gesture. When
          NOTHING is free, `textOptional` hides the label rather than parking it
          somewhere else and drawing a leader line to it: shifting and hiding are
          the two moves in this model, and a leader line is not one of them.

          The transparent spacer icon is what makes labels dodge MARKERS and not
          merely each other — the emoji itself is an RN view (PointAnnotation),
          invisible to collision, so the icon stands in for its footprint.
        */}
        <Images images={LABEL_IMAGES} />
        <ShapeSource id={LABEL_SOURCE_ID} shape={labelFeatures}>
          <SymbolLayer
            id={LABEL_LAYER_ID}
            style={{
              iconImage: LABEL_SPACER_IMAGE,
              iconAllowOverlap: true,
              iconAnchor: "center",
              textField: ["get", "label"],
              textSize: 12.5,
              textFont: ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
              textColor: "#111827",
              textHaloColor: "rgba(255,255,255,0.95)",
              textHaloWidth: 1.6,
              textVariableAnchor: [
                "top",
                "bottom",
                "left",
                "right",
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
              ],
              textRadialOffset: 1.1,
              textJustify: "auto",
              textAllowOverlap: false,
              textOptional: true,
              textPadding: 4,
              symbolSortKey: ["get", "sortKey"],
            }}
          />
        </ShapeSource>
      </MapView>

      {/* Title + layer chips, top-left (Mapbox chrome owns the bottom edge). */}
      {((!compact && spec.title) || (!hasSteps && layers.length > 0)) && (
        <View style={styles.topLeft} pointerEvents="box-none">
          {!compact && !!spec.title && (
            <View style={styles.titlePill}>
              <Text style={[styles.titleText, { color: colors.navy }]} numberOfLines={1}>
                {spec.title}
              </Text>
            </View>
          )}
          {!hasSteps && layers.length > 0 && (
            <View style={styles.chipRow}>
              {layers.map((l) => {
                const on = !!layerVisible[l.id];
                return (
                  <Pressable
                    key={l.id}
                    onPress={() =>
                      setLayerVisible((prev) => ({ ...prev, [l.id]: !prev[l.id] }))
                    }
                    style={[
                      styles.chip,
                      { borderColor: ctrlColor },
                      on ? { backgroundColor: ctrlColor } : { backgroundColor: "#ffffff" },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: on ? "#ffffff" : ctrlColor }]}>
                      {l.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      )}

      {/* Base toggle pill, top-right. */}
      {baseToggle && (
        <View style={styles.basePill} pointerEvents="box-none">
          {baseToggle.map((b) => {
            const on = b === base;
            return (
              <Pressable
                key={b}
                onPress={() => setBase(b)}
                style={[styles.baseBtn, on && { backgroundColor: ctrlColor }]}
              >
                <Text style={[styles.baseBtnText, { color: on ? "#ffffff" : colors.navy }]}>
                  {baseLabel(b)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Stepper. */}
      {hasSteps && (
        <View style={styles.stepper} pointerEvents="box-none">
          <Pressable
            disabled={clampedStep <= 0}
            onPress={() => setStepIndex(Math.max(0, clampedStep - 1))}
            style={styles.stepBtn}
          >
            <Text style={[styles.stepArrow, { color: clampedStep <= 0 ? colors.fgMuted : ctrlColor }]}>
              ‹
            </Text>
          </Pressable>
          <View style={styles.stepLabelWrap}>
            <Text style={[styles.stepLabel, { color: colors.navy }]} numberOfLines={1}>
              {spec.steps?.[clampedStep]?.label ?? `Step ${clampedStep + 1}`}
            </Text>
            {!!spec.steps?.[clampedStep]?.description && (
              <Text style={[styles.stepDesc, { color: colors.fgMuted }]} numberOfLines={1}>
                {spec.steps?.[clampedStep]?.description}
              </Text>
            )}
          </View>
          <Pressable
            disabled={clampedStep >= stepCount - 1}
            onPress={() => setStepIndex(Math.min(stepCount - 1, clampedStep + 1))}
            style={styles.stepBtn}
          >
            <Text
              style={[
                styles.stepArrow,
                { color: clampedStep >= stepCount - 1 ? colors.fgMuted : ctrlColor },
              ]}
            >
              ›
            </Text>
          </Pressable>
        </View>
      )}

      {/* Clear pins — only when the kid HAS pins and the host lets us clear.
          Sits ABOVE the bottom band: @rnmapbox's attribution ⓘ defaults to
          the bottom-right corner and the stepper owns the bottom-center, so
          the pill must not squat on either. Violet outline matches the layer
          chips (the shared control vocabulary, web parity). */}
      {onPinsClear && scholarPins.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear pins"
          hitSlop={8}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            onPinsClear();
          }}
          style={[styles.clearPins, { borderColor: ctrlColor }]}
        >
          <Text style={[styles.clearPinsText, { color: ctrlColor }]}>Clear pins</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden", backgroundColor: "#e5e7eb" },
  map: { flex: 1 },
  noToken: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, gap: 6 },
  noTokenTitle: { fontFamily: fonts.bold, fontSize: 16, textAlign: "center" },
  noTokenBody: { fontFamily: fonts.regular, fontSize: 13.5, textAlign: "center" },
  markerGlyph: {
    fontSize: 22,
    lineHeight: 24,
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  pinGlyph: { fontSize: 24, lineHeight: 26 },
  topLeft: { position: "absolute", top: 8, left: 8, gap: 6, maxWidth: "70%" },
  titlePill: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: "flex-start",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  titleText: { fontFamily: fonts.bold, fontSize: 14 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    borderWidth: 1,
    borderRadius: 9999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  chipText: { fontFamily: fonts.semibold, fontSize: 13 },
  basePill: {
    position: "absolute",
    top: 8,
    right: 8,
    flexDirection: "row",
    backgroundColor: "#ffffff",
    borderRadius: 9999,
    padding: 3,
    gap: 2,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  baseBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9999 },
  baseBtnText: { fontFamily: fonts.semibold, fontSize: 13 },
  stepper: {
    position: "absolute",
    bottom: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ffffff",
    borderRadius: 9999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: "90%",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  clearPins: {
    position: "absolute",
    bottom: 44,
    right: 8,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderRadius: 9999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  clearPinsText: { fontFamily: fonts.semibold, fontSize: 13 },
  stepBtn: { paddingHorizontal: 8, paddingVertical: 2 },
  stepArrow: { fontSize: 22, fontFamily: fonts.bold },
  stepLabelWrap: { minWidth: 0, maxWidth: 240, alignItems: "center" },
  stepLabel: { fontFamily: fonts.bold, fontSize: 14 },
  stepDesc: { fontFamily: fonts.regular, fontSize: 12, maxWidth: 240 },
});

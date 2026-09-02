/**
 * The GeoMap contract — real cartography as a governed, spec-driven surface.
 *
 * Design doc: review/geography-quest-mapbox-plan.html. The shape mirrors the
 * manipulative system deliberately (lib/manipulative/types.ts): framework-free
 * data (no React, no mapbox imports), so the tutor / curriculum author emits a
 * `GeoMapSpec` as JSON and a renderer instantiates it. Three surfaces share
 * this file:
 *   • the web renderer        — components/geomap/* (mapbox-gl)
 *   • the native renderer     — the native session map card (webview embed
 *                               today; @rnmapbox/maps when the SDK lands)
 *   • the Convex backend      — show_map validation + GeoTask grading
 *
 * THE GOVERNANCE RULE (load-bearing): a spec never carries a raw Mapbox style
 * URL, arbitrary tile source, or author-supplied image. Bases come from the
 * closed `GeoBase` set; overlay paint from closed `PaintPreset`s; overlay DATA
 * is either inline GeoJSON (size-capped, validated) or a key into the
 * checked-in registry (lib/geomap/registry/). Every historical border a child
 * sees traces to a reviewable file in this repo.
 *
 * Grading note: like manipulatives, the client's own solved-check is
 * optimistic UI only — the server re-runs `isSolved` (lib/geomap/grade.ts) on
 * the submitted state. No answer string is ever serialized; a locate task's
 * target IS in the spec, so task specs are never sent to the client while a
 * graded attempt is open (the serving path strips `task.target*` — see
 * `redactTaskForClient`).
 */

/** [longitude, latitude] — GeoJSON axis order, everywhere in this contract. */
export type LngLat = [number, number];

/** Closed set of curated base modes — never a raw style URL. */
export type GeoBase = "satellite" | "terrain" | "political" | "politicalUnlabeled";

/**
 * Closed set of overlay paint treatments. Renderers own the concrete styling
 * (colors/widths per preset + tint); specs only name the intent.
 */
export type PaintPreset =
  | "regionFill" // translucent filled polygons (empires, blocs, districts)
  | "regionOutline" // polygon outlines only (border comparisons)
  | "isolines" // labeled contour-style lines (rainfall, elevation bands)
  | "arrows" // directional line decoration (winds, currents, movements)
  | "routeLine" // plain emphasized line (routes, rivers, fronts)
  | "points"; // small labeled dots (cities, events)

/** Small named palette a layer may tint its preset with (renderer-defined hues). */
export type PaintTint = "blue" | "green" | "amber" | "red" | "violet" | "gray";

/**
 * Minimal structural GeoJSON typing — enough for validation + grading without
 * pulling in @types/geojson everywhere. Registry data files export this shape.
 */
export type GeoJsonPosition = LngLat | [number, number, number];
export type GeoJsonGeometry =
  | { type: "Point"; coordinates: GeoJsonPosition }
  | { type: "MultiPoint"; coordinates: GeoJsonPosition[] }
  | { type: "LineString"; coordinates: GeoJsonPosition[] }
  | { type: "MultiLineString"; coordinates: GeoJsonPosition[][] }
  | { type: "Polygon"; coordinates: GeoJsonPosition[][] }
  | { type: "MultiPolygon"; coordinates: GeoJsonPosition[][][] };
export type GeoJsonFeature = {
  type: "Feature";
  geometry: GeoJsonGeometry;
  properties?: Record<string, unknown> | null;
};
export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

/** Overlay data source: a checked-in registry dataset, or small inline GeoJSON. */
export type GeoLayerSource =
  | { registry: string } // key into lib/geomap/registry
  | { geojson: GeoJsonFeatureCollection };

export interface GeoLayer {
  /** Stable id, unique within the spec (toggle + stepper reference it). */
  id: string;
  /** Kid-facing toggle label ("wind direction", "1914 borders"). */
  label: string;
  source: GeoLayerSource;
  paint: PaintPreset;
  tint?: PaintTint;
  /**
   * Visibility when the map has no `steps`. Default true. The
   * predict-before-reveal choreography (§9 of the plan) is `false` here +
   * a later show_map patch toggling it on.
   */
  initiallyVisible?: boolean;
}

export interface GeoMarker {
  id: string;
  lngLat: LngLat;
  label?: string;
  emoji?: string;
}

/**
 * One state of a spec-level stepper (the WWI declaration chain). When `steps`
 * is present the renderer shows step controls and layer visibility follows the
 * active step (layers not listed are hidden); `initiallyVisible` is ignored.
 */
export interface GeoStep {
  id: string;
  /** Short label shown on the step control ("28 Jul 1914"). */
  label: string;
  /** One-line caption shown with the step ("Austria-Hungary declares on Serbia"). */
  description?: string;
  visibleLayerIds: string[];
  /** Optional camera move when this step activates. */
  camera?: Partial<GeoCamera>;
}

export interface GeoCamera {
  center: LngLat;
  /** Mapbox zoom, 0 (globe) … 22 (street). */
  zoom: number;
  /** Degrees, 0 (top-down) … 85. */
  pitch?: number;
  /** Degrees clockwise from north. */
  bearing?: number;
}

export interface GeoInteractions {
  pan?: boolean; // default true
  zoom?: boolean; // default true
  rotate?: boolean; // default true
  pitch?: boolean; // default true
  /**
   * Which bases the kid may flip between with the mode pill. `false` hides the
   * control. Default: ["satellite","terrain","political"] in explore mode;
   * graded tasks default to `false` (the base is part of the task design).
   */
  baseToggle?: GeoBase[] | false;
  /** Kid may drop/move pins (explore mode: annotate; task mode: answer). */
  tapToPin?: boolean;
}

// ── Graded tasks (the Phase-2 manipulative path) ─────────────────────────────

export type GeoTask =
  | {
      kind: "locate";
      /** The question ("Tap where Washington, DC is."). */
      prompt: string;
      target: LngLat;
      /** Great-circle tolerance. Generous at low zoom, tighter as the ladder descends. */
      toleranceKm: number;
    }
  | {
      kind: "region";
      /** ("Tap anywhere inside the United States.") */
      prompt: string;
      /** Registry key of a Polygon/MultiPolygon dataset (server resolves it). */
      targetRegion: { registry: string };
    }
  | {
      kind: "pinSet";
      /** ("Pin all three West Coast states' capitals.") */
      prompt: string;
      targets: Array<{ lngLat: LngLat; toleranceKm: number; label?: string }>;
    };

/** The kid's runtime state for a graded GeoTask (what the client submits). */
export interface GeoTaskState {
  pins: ScholarPin[];
}

// ── Scholar annotations (Phase-1 free exploration) ───────────────────────────

/**
 * A pin the SCHOLAR dropped. Lives in the stored artifact beside the spec —
 * never inside it — so show_map patches can merge tutor-side spec changes
 * without ever clobbering the kid's marks (the one-map merge rule, plan §8).
 */
export interface ScholarPin {
  id: string;
  lngLat: LngLat;
  label?: string;
}

// ── The spec + the stored artifact shape ─────────────────────────────────────

export interface GeoMapSpec {
  /** Contract version, for forward migration. */
  v: 1;
  id: string;
  /** Small caption above the map ("Oʻahu from space"). */
  title?: string;
  camera: GeoCamera;
  base: GeoBase;
  /** 3D DEM terrain + hillshade. The terrain base defaults it on. */
  terrain3d?: boolean;
  /** Globe projection at low zooms. */
  globe?: boolean;
  /**
   * Hide the base style's admin boundary LINES (modern country/state borders).
   * For historical overlays: Europe-in-1914 must not render on top of today's
   * borders — today's Poland showing through is both visual noise and a
   * spoiler. Labels are governed separately by the politicalUnlabeled base.
   */
  hideBaseBoundaries?: boolean;
  /**
   * Curated key into lib/geomap/historicalBasemaps — the map's TIME PERIOD.
   * An era transforms every base: the political base uses the hosted era
   * style (borders + names baked in); satellite/terrain render era-cleaned
   * (modern labels/admin/road line-work stripped) with the era's borders and
   * names injected as always-on line-work — never a fill. Don't also add the
   * era's overlay layer or hideBaseBoundaries; the base toggle keeps working
   * (every base is era-appropriate). The preferred way to show a historical
   * map.
   */
  historicalBasemap?: string;
  layers?: GeoLayer[];
  markers?: GeoMarker[];
  steps?: GeoStep[];
  interactions?: GeoInteractions;
  /** Present ⇒ graded (the manipulative path). Absent ⇒ tutor-narrated explore map. */
  task?: GeoTask;
}

/**
 * What an artifacts row with `type: "map"` stores in `content` (JSON).
 * `scholarPins` is the kid's namespace; `spec` is the tutor's. show_map
 * `patch` changes `spec` and MUST preserve `scholarPins` verbatim.
 */
export interface StoredMapArtifact {
  v: 1;
  spec: GeoMapSpec;
  scholarPins: ScholarPin[];
}

// ── Caps (enforced by validate.ts; keep specs small and honest) ──────────────

export const GEOMAP_MAX_INLINE_GEOJSON_BYTES = 60_000;
export const GEOMAP_MAX_LAYERS = 8;
export const GEOMAP_MAX_MARKERS = 30;
export const GEOMAP_MAX_STEPS = 14;
export const GEOMAP_MAX_SCHOLAR_PINS = 24;
export const GEOMAP_MAX_TASK_TARGETS = 8;

// ── Renderer props (the shared component interface both frontends implement) ─

/**
 * The one props contract for a GeoMap renderer (web `components/geomap/GeoMap`,
 * native map card). Defined here so parallel lanes code against the same seam.
 * Renderers are CONTROLLED for pins (the host owns persistence) and
 * uncontrolled for camera gestures.
 */
export interface GeoMapRendererProps {
  spec: GeoMapSpec;
  scholarPins: ScholarPin[];
  /** Fired when the kid drops a pin (host persists + echoes back via props). */
  onPinDrop?: (lngLat: LngLat) => void;
  /** Fired when the kid removes their own pin. */
  onPinRemove?: (pinId: string) => void;
  /** Fired by the "Clear pins" control (host persists the empty set). */
  onPinsClear?: () => void;
  /** Mapbox public token; null renders the friendly no-token/offline state. */
  token: string | null;
  /** Compact mode for narrow layouts (hides captions, shrinks controls). */
  compact?: boolean;
}

/**
 * Strip answer-bearing fields from a task before serving it to a client with
 * an open graded attempt (the no-spoilers rule: the map can't answer its own
 * quiz). Grading always happens server-side against the UNredacted spec.
 */
export function redactTaskForClient(task: GeoTask): GeoTask {
  switch (task.kind) {
    case "locate":
      return { ...task, target: [0, 0] };
    case "region":
      // The region key names the answer region; the client never needs to
      // resolve it (grading is server-side), so blank the key.
      return { ...task, targetRegion: { registry: "" } };
    case "pinSet":
      return {
        ...task,
        targets: task.targets.map((t) => ({
          ...t,
          lngLat: [0, 0] as LngLat,
        })),
      };
  }
}

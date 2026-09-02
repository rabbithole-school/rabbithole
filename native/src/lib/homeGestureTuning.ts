// Live tuning store for the Home Earth→Sky pull gesture (dev overlay only).
//
// The home screen's sky transition is driven by the SectionList's native
// top-overscroll (see native/src/app/index.tsx). Every feel-parameter of that
// mapping — pull distance, resistance, commit thresholds, parallax — lives here
// as a reanimated shared value so it can be read from the scroll-handler
// worklet AND written live at runtime. The on-screen GestureTuningPanel that
// originally wrote these was removed after the feel settled (revert that
// removal PR to bring it back); the store stays because the worklets read the
// shared values and Home reads `bounces` via useTuningValue.
import { useSyncExternalStore } from "react";
import { makeMutable, type SharedValue } from "react-native-reanimated";

// The concrete value each param holds (numbers for sliders, booleans for
// toggles). Kept as a single source of truth for DEFAULTS, the shared-value
// store, and the JS mirror.
export type TuningValues = {
  overscrollDistance: number;
  resistance: number;
  commitProgress: number;
  commitVelocity: number;
  commitAnimMs: number;
  bgParallax: number;
  travel: number;
  contentFade: number;
  skyPeek: number;
  bounces: boolean;
  momentumCommit: boolean;
  commitHaptic: boolean;
};

export type TuningKey = keyof TuningValues;

// The store shape: one shared value per param, readable from worklets.
export type TuningStore = {
  [K in TuningKey]: SharedValue<TuningValues[K]>;
};

export type TuningParam = {
  key: TuningKey;
  label: string;
  kind: "number" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
};

// Ordered — this array drives the panel UI generically (one row per entry).
export const TUNING_SPEC: TuningParam[] = [
  { key: "overscrollDistance", label: "Pull distance (px)", kind: "number", min: 60, max: 600, step: 20, decimals: 0 },
  { key: "resistance", label: "Resistance (exp)", kind: "number", min: 0.5, max: 2.5, step: 0.05, decimals: 2 },
  { key: "commitProgress", label: "Commit at (frac)", kind: "number", min: 0.1, max: 0.95, step: 0.05, decimals: 2 },
  { key: "commitVelocity", label: "Commit velocity (px/s)", kind: "number", min: 100, max: 3000, step: 100, decimals: 0 },
  { key: "commitAnimMs", label: "Commit anim (ms)", kind: "number", min: 100, max: 600, step: 20, decimals: 0 },
  { key: "bgParallax", label: "BG parallax (×)", kind: "number", min: 0, max: 1, step: 0.05, decimals: 2 },
  { key: "travel", label: "Commit travel (px)", kind: "number", min: 200, max: 1400, step: 40, decimals: 0 },
  { key: "contentFade", label: "Content fade", kind: "number", min: 0, max: 1, step: 0.05, decimals: 2 },
  { key: "skyPeek", label: "Sky peek (px)", kind: "number", min: -240, max: 240, step: 10, decimals: 0 },
  { key: "bounces", label: "List bounces", kind: "toggle" },
  { key: "momentumCommit", label: "Fling can commit", kind: "toggle" },
  { key: "commitHaptic", label: "Threshold haptic", kind: "toggle" },
];

export const DEFAULTS: TuningValues = {
  overscrollDistance: 220,
  resistance: 1.0,
  commitProgress: 0.5,
  commitVelocity: 900,
  commitAnimMs: 220,
  bgParallax: 0.35,
  travel: 760,
  contentFade: 0.6,
  skyPeek: 100,
  bounces: true,
  momentumCommit: false,
  commitHaptic: true,
};

// The shared-value store — created once at module scope with makeMutable so the
// worklet on the UI thread and React on the JS thread read the same cells.
export const tuning: TuningStore = {
  overscrollDistance: makeMutable(DEFAULTS.overscrollDistance),
  resistance: makeMutable(DEFAULTS.resistance),
  commitProgress: makeMutable(DEFAULTS.commitProgress),
  commitVelocity: makeMutable(DEFAULTS.commitVelocity),
  commitAnimMs: makeMutable(DEFAULTS.commitAnimMs),
  bgParallax: makeMutable(DEFAULTS.bgParallax),
  travel: makeMutable(DEFAULTS.travel),
  contentFade: makeMutable(DEFAULTS.contentFade),
  skyPeek: makeMutable(DEFAULTS.skyPeek),
  bounces: makeMutable(DEFAULTS.bounces),
  momentumCommit: makeMutable(DEFAULTS.momentumCommit),
  commitHaptic: makeMutable(DEFAULTS.commitHaptic),
};

// JS-thread mirror of the current values, so React subscribers (useTuningValue)
// return stable primitives without touching a shared value during render.
const values: TuningValues = { ...DEFAULTS };

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setTuning<K extends TuningKey>(key: K, value: TuningValues[K]): void {
  values[key] = value;
  tuning[key].set(value);
  emit();
  console.log("[gesture-tuning]", key, "=", value);
}

export function resetTuning(): void {
  Object.assign(values, DEFAULTS);
  // Write each shared value explicitly — a keyed loop cannot narrow the
  // number|boolean union for the corresponding `.set()` call.
  tuning.overscrollDistance.set(DEFAULTS.overscrollDistance);
  tuning.resistance.set(DEFAULTS.resistance);
  tuning.commitProgress.set(DEFAULTS.commitProgress);
  tuning.commitVelocity.set(DEFAULTS.commitVelocity);
  tuning.commitAnimMs.set(DEFAULTS.commitAnimMs);
  tuning.bgParallax.set(DEFAULTS.bgParallax);
  tuning.travel.set(DEFAULTS.travel);
  tuning.contentFade.set(DEFAULTS.contentFade);
  tuning.skyPeek.set(DEFAULTS.skyPeek);
  tuning.bounces.set(DEFAULTS.bounces);
  tuning.momentumCommit.set(DEFAULTS.momentumCommit);
  tuning.commitHaptic.set(DEFAULTS.commitHaptic);
  emit();
  console.log("[gesture-tuning] reset");
}

export function getTuningSnapshot(): TuningValues {
  return { ...values };
}

// Subscriber hook: returns the live JS-mirror value for one param and
// re-renders on change. Used by the panel for display and by Home for `bounces`.
export function useTuningValue<K extends TuningKey>(key: K): TuningValues[K] {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => values[key],
  );
}

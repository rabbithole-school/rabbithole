/**
 * NativeManipulative — the spec-driven dispatcher that maps a `ManipulativeSpec`
 * to its React Native renderer. This is the native analogue of the web
 * `ManipulativeStage` (components/manipulative/Manipulative.tsx): it owns ONLY
 * the switch from `spec.kind` to the matching kind component, and threads the
 * two callbacks every renderer speaks — `onSolvedChange` (the optimistic
 * control-of-error self-check) and `onStateChange` (the kind-matched runtime
 * state, lifted so a practice-item host can submit it for authoritative
 * server grading; see `NativeManipulativeItem`).
 *
 * The spec union + the pure predicates the renderers compute against are the
 * SAME vendored source the web + server grade with (../../../vendor/manipulative
 * — a read-only copy of lib/manipulative synced by native/scripts/sync-vendor.js),
 * so native and web can never drift on what "solved" means.
 *
 * The switch is exhaustive over `ManipulativeKind` by construction (TS narrows
 * each case and errors on an unhandled member). `NATIVE_MANIPULATIVE_KINDS` +
 * `isNativeManipulativeKind` expose that coverage at RUNTIME so a host can pick
 * the inline native renderer for a supported kind and fall back to the web
 * `/embed/manipulative` WebView for anything outside it (a forward-compat spec
 * kind that has no native renderer yet, or a malformed stored spec).
 */

import type { ManipulativeSpec } from "../../../vendor/manipulative/types";
import {
  isNativeManipulativeKind,
  NATIVE_MANIPULATIVE_KINDS,
} from "./nativeManipulativeKinds";
import { AreaPerimeterNative } from "./AreaPerimeter.native";
import { ArrayNative } from "./Array.native";
import { BalanceNative } from "./Balance.native";
import { CoordinatePlaneNative } from "./CoordinatePlane.native";
import { DiceNative } from "./Dice.native";
import { DistributeNative } from "./Distribute.native";
import { DistributorNative } from "./Distributor.native";
import { FunctionMachineNative } from "./FunctionMachine.native";
import { NumberLineNative } from "./NumberLine.native";
import { PartitionNative } from "./Partition.native";
import { PlaceValueNative } from "./PlaceValue.native";
import { ProtractorNative } from "./Protractor.native";
import { RekenrekNative } from "./Rekenrek.native";
import { RiemannNative } from "./Riemann.native";
import { RulerNative } from "./Ruler.native";
import { ClockNative } from "./Clock.native";
import { LiquidNative } from "./Liquid.native";
import { MoneyNative } from "./Money.native";

// Re-exported here so a host can import the renderer + its routing table from
// one place; the table itself lives in the React-free `nativeManipulativeKinds`
// module (unit-testable without the renderer graph).
export { isNativeManipulativeKind, NATIVE_MANIPULATIVE_KINDS };

export interface NativeManipulativeProps {
  spec: ManipulativeSpec;
  /** Optimistic self-check — UI feel only, never the graded record. */
  onSolvedChange: (solved: boolean) => void;
  /** The kind-matched runtime state, lifted for the practice-item grade path. */
  onStateChange?: (state: unknown) => void;
}

/**
 * Render the interactive stage for `spec`. Returns `null` for any kind without
 * a native renderer — callers should gate on `isNativeManipulativeKind(spec.kind)`
 * first and fall back to the WebView embed rather than render an empty stage.
 */
export function NativeManipulative({ spec, onSolvedChange, onStateChange }: NativeManipulativeProps) {
  switch (spec.kind) {
    case "partition":
      return <PartitionNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "numberline":
      return <NumberLineNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "array":
      return <ArrayNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "balance":
      return <BalanceNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "areaPerimeter":
      return <AreaPerimeterNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "distribute":
      return <DistributeNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "rekenrek":
      return <RekenrekNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "distributor":
      return <DistributorNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "riemann":
      return <RiemannNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "functionMachine":
      return <FunctionMachineNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "placeValue":
      return <PlaceValueNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "dice":
      return <DiceNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "protractor":
      return <ProtractorNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "coordinatePlane":
      return <CoordinatePlaneNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "ruler":
      return <RulerNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "clock":
      return <ClockNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "liquid":
      return <LiquidNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "money":
      return <MoneyNative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "geoLocate":
      // WEBVIEW-ONLY kind (no @rnmapbox native renderer yet): a host routes it
      // to the /embed WebView before ever reaching this switch (see
      // NativeManipulativeItem's `unsupported` guard). Handled explicitly so the
      // exhaustive `assertNever` below stays a real compile-time guard; if this
      // is somehow reached, render nothing rather than a broken stage.
      return null;
    default:
      // Exhaustive over the union today; the `never` binding makes an
      // unhandled future kind a compile error rather than a silent empty stage.
      return assertNever(spec);
  }
}

function assertNever(_spec: never): null {
  return null;
}

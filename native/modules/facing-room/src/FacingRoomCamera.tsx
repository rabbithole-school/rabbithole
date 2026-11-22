import { useEffect, type ComponentType, type Ref } from "react";
import { requireNativeView } from "expo";
import type { StyleProp, ViewStyle } from "react-native";

/** One live reading of the largest face: degrees, degrees, pixels (see HeadPoseFrame). */
export type LiveHeadPose =
  | { face: true; yaw: number; pitch: number; faceWidth: number }
  | { face: false };

/** What a ref to the camera can do. */
export type FacingRoomCameraHandle = {
  /** Records until `stopRecording`; rejects if nothing could be recorded. */
  record(): Promise<{ uri: string }>;
  stopRecording(): Promise<void>;
};

type NativeProps = {
  ref?: Ref<FacingRoomCameraHandle>;
  style?: StyleProp<ViewStyle>;
  poseFrameMs: number;
  videoBitrate: number;
  onReady?: () => void;
  onMountError?: (event: { nativeEvent: { message: string } }) => void;
  onHeadPose?: (event: { nativeEvent: LiveHeadPose }) => void;
};

// Null in a dev client built before the camera was added.
let NativeView: ComponentType<NativeProps> | null = null;
try {
  NativeView = requireNativeView<NativeProps>("FacingRoom");
} catch {
  NativeView = null;
}

/**
 * The decibel meter's camera: the front camera's picture, takes recorded
 * with `ref.record()` and `ref.stopRecording()`, and the presenter's head
 * direction read live from the same frames, every `poseFrameMs`. iOS only.
 */
export function FacingRoomCamera({
  ref,
  style,
  poseFrameMs,
  videoBitrate,
  onReady,
  onMountError,
  onHeadPose,
}: {
  ref?: Ref<FacingRoomCameraHandle>;
  style?: StyleProp<ViewStyle>;
  poseFrameMs: number;
  videoBitrate: number;
  onReady?: () => void;
  onMountError?: (message: string) => void;
  onHeadPose?: (pose: LiveHeadPose) => void;
}) {
  useEffect(() => {
    if (!NativeView) onMountError?.("This build has no camera for the decibel meter.");
  }, [onMountError]);
  if (!NativeView) return null;
  return (
    <NativeView
      ref={ref}
      style={style}
      poseFrameMs={poseFrameMs}
      videoBitrate={videoBitrate}
      onReady={onReady}
      onMountError={onMountError ? (event) => onMountError(event.nativeEvent.message) : undefined}
      onHeadPose={onHeadPose ? (event) => onHeadPose(event.nativeEvent) : undefined}
    />
  );
}

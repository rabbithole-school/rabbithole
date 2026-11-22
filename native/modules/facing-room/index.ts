import { requireOptionalNativeModule } from "expo-modules-core";

/** [yaw, pitch, faceWidth]: degrees (+ toward the presenter's left), degrees (+ chin down), pixels. */
export type HeadPoseFrame = [number, number, number] | null;

export type HeadPoseTrack = {
  durationMs: number;
  frameMs: number;
  /** One per `frameMs` from the start of the video; null where no face was found. */
  frames: HeadPoseFrame[];
};

type FacingRoomModule = {
  readHeadPose(uri: string, frameMs: number): Promise<HeadPoseTrack>;
  /** Absent from builds made before it was added. */
  extractAudio?: (uri: string) => Promise<string>;
};

// Null in a dev client or fleet build that predates the module.
const nativeModule = requireOptionalNativeModule<FacingRoomModule>("FacingRoom");

/**
 * Reads the presenter's head direction from a recorded video, a frame every
 * `frameMs`, on this BunnyPad. Null when the module isn't in this build, the
 * video can't be read, or it takes longer than `timeoutMs`: callers carry on
 * without it.
 */
export async function readHeadPose(
  uri: string,
  frameMs: number,
  timeoutMs: number,
): Promise<HeadPoseTrack | null> {
  if (!nativeModule) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      nativeModule.readHeadPose(uri, frameMs),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn("[facing-room] reading head direction failed", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Copies a recorded video's sound into a small .m4a file beside it, on this
 * BunnyPad, for transcribing. Null when this build lacks it, the video has no
 * sound, or it takes longer than `timeoutMs`: callers save the take without a
 * transcript.
 */
export async function extractAudio(uri: string, timeoutMs: number): Promise<string | null> {
  const facingRoom = nativeModule;
  if (!facingRoom?.extractAudio) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      facingRoom.extractAudio(uri),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn("[facing-room] copying the take's sound failed", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export {
  FacingRoomCamera,
  type FacingRoomCameraHandle,
  type LiveHeadPose,
} from "./src/FacingRoomCamera";

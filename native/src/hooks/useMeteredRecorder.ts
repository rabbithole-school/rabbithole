import {
  RecordingPresets,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from "expo-audio";

import { levelFromDbfs, METER_FRAME_MS } from "@/lib/micLevel";

/** How the app records the microphone: high quality, with loudness metering. */
export const METERED_RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

/**
 * A metered expo-audio recorder whose state is polled every `METER_FRAME_MS`,
 * with its level on the app's 0..1 scale. Dictation and the bug-report
 * recorder share it so they record the same way and read the same level.
 * Starting, stopping and the audio session stay with each caller.
 */
export function useMeteredRecorder() {
  const recorder = useAudioRecorder(METERED_RECORDING);
  const state = useAudioRecorderState(recorder, METER_FRAME_MS);
  return { recorder, state, level: levelFromDbfs(state.metering) };
}

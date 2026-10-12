import { requireOptionalNativeModule } from "expo-modules-core";
import { useEffect, useState } from "react";

import type {
  OutputVolumeChangeEvent,
  OutputVolumeModule,
} from "./src/OutputVolume.types";

export type { OutputVolumeChangeEvent } from "./src/OutputVolume.types";

// `requireOptionalNativeModule` returns null (instead of throwing) when the
// module isn't in the running binary — a dev client or fleet build that
// predates it, or a non-Apple platform. Consumers then get `null` ("unknown")
// and must treat it as "no reading", never as silence.
const nativeModule =
  requireOptionalNativeModule<OutputVolumeModule>("OutputVolume");

/** Point-in-time read (0…1), or null when the module is unavailable. */
export function getOutputVolume(): number | null {
  try {
    return nativeModule ? nativeModule.getVolume() : null;
  } catch {
    return null;
  }
}

/**
 * Live system output volume (0…1) while `active`, or null when unknown (module
 * missing, or not active). Subscribing activates the app's audio session — see
 * the Swift module — so only pass `active` when the screen is about to play
 * audio anyway (voice mode on).
 */
export function useOutputVolume(active: boolean): number | null {
  const [volume, setVolume] = useState<number | null>(null);

  useEffect(() => {
    if (!active || !nativeModule) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- not observing: the reading is unknown, not stale
      setVolume(null);
      return;
    }
    setVolume(getOutputVolume());
    const subscription = nativeModule.addListener(
      "onChange",
      (event: OutputVolumeChangeEvent) => setVolume(event.volume),
    );
    return () => subscription.remove();
  }, [active]);

  return volume;
}

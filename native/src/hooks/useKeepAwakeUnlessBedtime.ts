import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useId } from "react";

import { useIsBedtime } from "@/contexts/BedtimeContext";

/**
 * `useKeepAwake`, except at bedtime: a deck or app left presenting at 8 pm
 * must not hold the iPad's screen on all night.
 */
export function useKeepAwakeUnlessBedtime(): void {
  const isBedtime = useIsBedtime();
  const tag = useId();
  useEffect(() => {
    if (isBedtime) return;
    void activateKeepAwakeAsync(tag).catch(() => {});
    return () => {
      void deactivateKeepAwake(tag).catch(() => {});
    };
  }, [isBedtime, tag]);
}

import { useEffect } from "react";
import { AppState } from "react-native";

import { setManagedMaximumBrightness } from "@/lib/singleAppMode";

/**
 * Maximum brightness follows the managed-install lifetime, not transient ASAM
 * lock state. Connectivity recovery may release ASAM without dimming the iPad.
 */
export function useManagedMaximumBrightness(enabled: boolean): void {
  useEffect(() => {
    void setManagedMaximumBrightness(enabled);
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void setManagedMaximumBrightness(enabled);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [enabled]);
}

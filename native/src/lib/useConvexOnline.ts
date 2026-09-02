import { useCallback, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";

/** The Convex WebSocket is the cross-platform connectivity signal for native. */
export function useConvexOnline(): boolean {
  const convex = useConvex();
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      convex.subscribeToConnectionState(onStoreChange),
    [convex],
  );
  const snapshot = useCallback(
    () => convex.connectionState().isWebSocketConnected,
    [convex],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

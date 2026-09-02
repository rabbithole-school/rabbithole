import type { Id } from "@/lib/convex";

export type AppRouteStatus = {
  route: string;
  sessionId?: Id<"sessions">;
};

type Listener = () => void;
export type MicOwnerToken = symbol;

let routeStatus: AppRouteStatus = { route: "/" };
const micOwners = new Set<MicOwnerToken>();
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

export const appStatusBus = {
  setRoute(route: string) {
    const normalized = route || "/";
    const sessionId =
      routeStatus.route === normalized ? routeStatus.sessionId : undefined;
    if (
      routeStatus.route === normalized &&
      routeStatus.sessionId === sessionId
    ) {
      return;
    }
    routeStatus = { route: normalized, sessionId };
    emit();
  },

  setSessionRoute(route: string, sessionId: Id<"sessions">) {
    const normalized = route || "/";
    if (
      routeStatus.route === normalized &&
      routeStatus.sessionId === sessionId
    ) {
      return;
    }
    routeStatus = { route: normalized, sessionId };
    emit();
  },

  clearSession(sessionId: Id<"sessions">) {
    if (routeStatus.sessionId !== sessionId) return;
    routeStatus = { route: routeStatus.route };
    emit();
  },

  getRoute(): AppRouteStatus {
    return routeStatus;
  },

  createMicOwner(label: string): MicOwnerToken {
    return Symbol(label);
  },

  setMicOwned(owner: MicOwnerToken, owned: boolean) {
    const changed = owned ? !micOwners.has(owner) : micOwners.has(owner);
    if (!changed) return;
    if (owned) micOwners.add(owner);
    else micOwners.delete(owner);
    emit();
  },

  isMicOwned(): boolean {
    return micOwners.size > 0;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

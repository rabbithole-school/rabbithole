"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * The aide "dock" — one Robot in the header pops ONE docked right panel.
 * In the teacher dashboard the panel's body is derived from the current
 * route's SCOPE (published by each tab via `useSetAideScope`), so the aide
 * is always about what you're looking at:
 *
 *   - scholar → the scholar-scoped aide (dossier / mastery / next steps)
 *   - unit    → the unit designer's Curriculum Bot
 *   - global  → the general curriculum assistant (all scholars)
 *
 * This replaces the old tangle of per-tab bot triggers + near-identical
 * right panels (see review/teacher-bot-panel-unification-plan.html). The
 * backend is already converged (one `chats` table + `/aide-stream`), so this
 * is purely a frontend consolidation of the trigger, placement, and state.
 *
 * The PARENT portal reuses this same provider for its own dock
 * (<ParentAideDock> + the header Robot in the parent page): it consumes the
 * open/toggle + composer-seed mechanics and ignores scope (always the one
 * guardianship-scoped parent thread), so the dock behavior — toggle, push
 * placement, "seed the composer, never auto-send" — can't drift per portal.
 */

export type AideScope =
  | { kind: "global" }
  | { kind: "scholar"; scholarId: Id<"users"> }
  | {
      /**
       * Practice studio (the Skills tab) — the domain/node the teacher is
       * viewing. Shares the ONE persistent general thread (see <AideDock>); the
       * domain/node ride along as an ephemeral `practiceContext` hint, exactly
       * like `scholar` scope's `focusScholarId`. Label fields are scholar-
       * agnostic catalog data (no learner records).
       */
      kind: "practice";
      domain: string | null;
      domainLabel?: string | null;
      nodeKey?: string | null;
      nodeLabel?: string | null;
    }
  | {
      kind: "unit";
      unitId: Id<"units">;
      /** Soft outline-selection context forwarded to the Curriculum Bot. */
      lessonId?: Id<"lessons"> | null;
      activityId?: Id<"activities"> | null;
    };

const GLOBAL_SCOPE: AideScope = { kind: "global" };

/** An imperative prompt push into the active (unit) thread, keyed by a
 *  monotonic nonce so repeat sends of the same text still fire. Stamped with
 *  the unitId it was issued for so a stale/cancelled send can never fire into a
 *  DIFFERENT unit's chat (see the dispatch guard in <AideDock> + the clear
 *  effect below). */
export interface AidePendingSend {
  prompt: string;
  nonce: number;
  unitId: Id<"units"> | null;
}

/** A one-shot seed of the global dock composer. By default this PREFILLS the
 *  composer (not a send) — the teacher edits/confirms before sending. When
 *  `send` is true the caller passed a fully-formed question and the tap IS the
 *  send (used by the parent canned-question chips; teacher surfaces never set
 *  it). Keyed by a monotonic nonce so re-seeding the same text still fires. */
export interface AideComposerSeed {
  text: string;
  nonce: number;
  send?: boolean;
}

interface AideDockContextValue {
  open: boolean;
  setOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  toggle: () => void;
  scope: AideScope;
  setScope: (scope: AideScope) => void;
  /** Open the dock and push a prompt into the active thread (unit scope). */
  send: (prompt: string) => void;
  /** Internal — the pending imperative send, consumed by <AideDock>. */
  pendingSend: AidePendingSend | null;
  consumePendingSend: () => void;
  /**
   * The dock's active (global/scholar) chat thread id. Lifted here — above the
   * <AideDock> that unmounts on close / on the Chat tab / on unit scope — so the
   * one persistent thread survives close→reopen, a Chat-tab roundtrip, and
   * scholar→unit→scholar. "New chat" is still the only fork.
   */
  dockSessionId: string | null;
  setDockSessionId: (id: string | null) => void;
  /**
   * Open the dock (global scope) and seed its composer. Prefill by default;
   * `send: true` means the caller passed a fully-formed question and the tap
   * IS the send (used by the parent canned chips; teacher surfaces never set
   * it).
   */
  seedComposer: (text: string, opts?: { send?: boolean }) => void;
  /** Internal — the pending composer prefill, consumed by the dock body. */
  pendingComposerSeed: AideComposerSeed | null;
  consumeComposerSeed: () => void;
}

const AideDockContext = createContext<AideDockContextValue | null>(null);

export function AideDockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [scope, setScopeState] = useState<AideScope>(GLOBAL_SCOPE);
  const [pendingSend, setPendingSend] = useState<AidePendingSend | null>(null);
  const [dockSessionId, setDockSessionId] = useState<string | null>(null);
  const [pendingComposerSeed, setPendingComposerSeed] =
    useState<AideComposerSeed | null>(null);
  const nonceRef = useRef(0);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Always-current scope, so `send()` can stamp the pending prompt with the
  // unit it was issued for without recreating the callback on every scope tick.
  const scopeRef = useRef(scope);
  // eslint-disable-next-line react-hooks/refs -- Keep send stable while stamping its prompt with the current unit scope.
  scopeRef.current = scope;

  // Ignore no-op scope writes so a tab re-rendering with the same scope
  // doesn't churn the context (and re-key the dock body).
  const setScope = useCallback((next: AideScope) => {
    setScopeState((prev) => (scopeEquals(prev, next) ? prev : next));
  }, []);

  const send = useCallback((prompt: string) => {
    const text = prompt.trim();
    if (!text) return;
    nonceRef.current += 1;
    // Stamp the unit this send targets (send() is only invoked from the unit
    // designer, so the live scope is that unit). The dispatch guard fires it
    // only into that unit's chat; anything else drops it.
    const s = scopeRef.current;
    const unitId = s.kind === "unit" ? s.unitId : null;
    setPendingSend({ prompt: text, nonce: nonceRef.current, unitId });
    setOpen(true);
  }, []);

  const consumePendingSend = useCallback(() => setPendingSend(null), []);

  // Drop a pending imperative send that can no longer fire against the unit it
  // was issued for: the dock closed, or the scope moved off that unit before
  // the unit chat mounted + dispatched it. A cancelled/stale send must DROP,
  // never fire later into the wrong unit's chat.
  useEffect(() => {
    if (!pendingSend) return;
    const staleScope =
      scope.kind !== "unit" ||
      pendingSend.unitId === null ||
      String(scope.unitId) !== String(pendingSend.unitId);
    if (!open || staleScope) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- drops a pending one-shot send when its dock scope closes or no longer matches.
      setPendingSend(null);
    }
  }, [open, scope, pendingSend]);

  // Seed the global dock composer — the "Ask the bot to draft one" door on the
  // Curriculum landing. Prefill by default; `send: true` means the caller
  // passed a fully-formed question and the tap IS the send (the parent canned
  // chips). Force global scope so the seeded request lands in the general
  // assistant, open the dock, then stage the text.
  const seedComposer = useCallback((text: string, opts?: { send?: boolean }) => {
    const t = text.trim();
    if (!t) return;
    nonceRef.current += 1;
    setScope(GLOBAL_SCOPE);
    setPendingComposerSeed({ text: t, nonce: nonceRef.current, send: opts?.send });
    setOpen(true);
  }, [setScope]);

  const consumeComposerSeed = useCallback(() => setPendingComposerSeed(null), []);

  const value = useMemo<AideDockContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      scope,
      setScope,
      send,
      pendingSend,
      consumePendingSend,
      dockSessionId,
      setDockSessionId,
      seedComposer,
      pendingComposerSeed,
      consumeComposerSeed,
    }),
    [
      open,
      toggle,
      scope,
      setScope,
      send,
      pendingSend,
      consumePendingSend,
      dockSessionId,
      seedComposer,
      pendingComposerSeed,
      consumeComposerSeed,
    ],
  );

  return <AideDockContext.Provider value={value}>{children}</AideDockContext.Provider>;
}

export function useAideDock(): AideDockContextValue {
  const ctx = useContext(AideDockContext);
  if (!ctx) {
    throw new Error("useAideDock must be used within an <AideDockProvider>");
  }
  return ctx;
}

/**
 * Optional accessor for surfaces that MAY render outside the dashboard
 * provider (e.g. a shared component reused on a detail subroute). Returns
 * null instead of throwing when there's no provider.
 */
export function useAideDockOptional(): AideDockContextValue | null {
  return useContext(AideDockContext);
}

/**
 * Publish the aide scope for the current tab. Call it from a tab's layout (or
 * a scoped shell like ReportShell) with the scope the aide should adopt while
 * that surface is mounted; it resets to global when the surface unmounts, so
 * navigating to a non-contextual tab falls back to the general aide. No-op if
 * there's no provider (the surface is rendered outside the dashboard).
 */
export function useSetAideScope(scope: AideScope) {
  const ctx = useAideDockOptional();
  const setScope = ctx?.setScope;
  // Serialize so the effect only re-runs when the scope's identity changes,
  // not on every render (scope objects are rebuilt each render).
  const key = scopeKey(scope);
  const scopeRef = useRef(scope);
  // eslint-disable-next-line react-hooks/refs -- Mirror the current scope while the effect remains keyed by semantic, not object, identity.
  scopeRef.current = scope;

  useEffect(() => {
    if (!setScope) return;
    setScope(scopeRef.current);
    return () => setScope(GLOBAL_SCOPE);
  }, [key, setScope]);
}

function scopeKey(scope: AideScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "scholar":
      return `scholar:${String(scope.scholarId)}`;
    case "practice":
      return `practice:${scope.domain ?? ""}:${scope.domainLabel ?? ""}:${scope.nodeKey ?? ""}:${scope.nodeLabel ?? ""}`;
    case "unit":
      return `unit:${String(scope.unitId)}:${String(scope.lessonId ?? "")}:${String(
        scope.activityId ?? "",
      )}`;
  }
}

function scopeEquals(a: AideScope, b: AideScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

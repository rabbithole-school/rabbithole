/**
 * The Studio's host↔sandbox bridge — the ONLY place that speaks
 * `appStateBridge.mjs`'s protocol for this screen.
 *
 * All traffic here is deliberately slow-path: level changes, saves, run
 * results and the syntax-fix fallback. The fast loop (keystroke → Run →
 * redraw) never leaves the WebView document — see `StudioScreen`'s header
 * comment for why.
 *
 * Protocol notes (confirmed against `studio/src/bridge.ts` and
 * `studio/src/main.ts`, the sandbox's own half, running in a browser):
 *  - Host → sandbox actions, via `rabbithole.registerAction` on the sandbox
 *    side: `setLevel({levelId, source?, seed})`, `rollWorld({seed})`,
 *    `setCharms({urls})`, `applyFix({requestId, result})`.
 *  - Sandbox → host, via `rabbithole.setState` patches surfaced as `change`
 *    messages: `{levelId, source}` together (debounced ~2.5s idle
 *    sandbox-side already; posted once immediately on level open too),
 *    `{lastRun}` (including `"stopped"` when playback is interrupted),
 *    `{rollRequest}` (the document asks the host for the next seeded world),
 *    `{fixRequest}` (only when both the deterministic pass AND a plain parse
 *    have failed).
 *  - `fixRequest` is a user-visible, BLOCKING wait on the sandbox side — it
 *    has already shown its own "Let me look at that…" state, so there is no
 *    native spinner to add here. The one hard rule: every `fixRequest` must
 *    get an `applyFix` echoing the same `requestId` back, success or
 *    failure, or the scholar is stuck staring at that state forever. See
 *    `handleFixRequest`'s catch branch.
 *  - The bridge SDK fires `"ready"` the instant it is injected — which is
 *    BEFORE any of the sandbox's own bundle has run, and therefore before
 *    `bridge.connect()` near the end of that bundle has registered a single
 *    action. Worse, the SDK only emits `"ready"` while it is uninitialized, so
 *    once the host answers with `init` there is no second `"ready"` to retry
 *    on. A host action dispatched on `"ready"` therefore does not race
 *    *sometimes* — it loses *every* time, coming back
 *    `{ok:false, error:"Action is no longer registered"}`.
 *
 *    That is survivable for anything the scholar can simply tap again, and
 *    fatal for anything dispatched exactly once. So the sandbox's `"actions"`
 *    announcement — re-sent on every `registerAction` — is tracked separately
 *    as `actionsReady`, and one-shot dispatches wait for that instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type WebView from "react-native-webview";

import { api } from "@/lib/convex";
import {
  appStateHostInjectionScript,
  matchesAppStateBridgeNonce,
  parseAppStateBridgeMessage,
} from "../../../vendor/shared/appStateBridge.mjs";
import {
  STUDIO_ACTIONS,
  type StudioBridgeDoc,
  type StudioFixRequest,
  type StudioFixResult,
  type StudioRollRequest,
  type StudioRunResult,
  isStudioRunResult,
} from "../../../vendor/shared/studioContract";
import { deriveStudioWorldSeed } from "../../../vendor/shared/studioLevels";

export type StudioWebViewHandle = WebView;

/** Shape of one row from `studio.myPrograms` (see `convex/studio.ts`). Declared
 * locally so this file typechecks whether or not `npx convex codegen` has run
 * yet — `api.studio` doesn't exist in the generated API until it does, which
 * would otherwise make `myPrograms` (and this row) implicitly `any`. */
interface StudioProgramRow {
  levelId: string;
  source: string;
  solved: boolean;
  bestSteps?: number;
  updatedAt: number;
}

/** How long to let a scholar sit idle before persisting their source to
 * Convex. The sandbox already debounces `source` patches ~2.5s internally
 * (see `studio/src/main.ts`'s `scheduleSave`), so this is a second,
 * defense-in-depth layer — every keystroke hitting Convex is waste, and this
 * makes that true even if the sandbox's own debounce ever changes. */
const SAVE_DEBOUNCE_MS = 2_500;

export interface UseStudioBridgeResult {
  webViewRef: RefObject<StudioWebViewHandle | null>;
  onLoadStart: () => void;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  /** True once the sandbox has completed at least one handshake. */
  ready: boolean;
  /** True once the sandbox has actually registered its actions. Dispatching a
   * host action before this is a no-op that comes back
   * `{ok:false, error:"Action is no longer registered"}`, so anything that
   * fires ONCE (rather than in response to a tap the scholar can repeat) must
   * wait for this rather than for `ready`. */
  actionsReady: boolean;
  /** The level the sandbox last reported it has open (echoed back after any
   * `setLevel` action, or after the scholar's own edits settle). */
  activeLevelId: string | undefined;
  /** levelId → saved-progress row, from `studio.myPrograms`. Undefined while
   * the query is still loading. */
  programs: Record<string, { source: string; solved: boolean; bestSteps?: number; updatedAt: number }> | undefined;
  /** Ask the sandbox to open a level, restoring saved source for it if any. */
  openLevel: (levelId: string) => void;
  /** "Change the world" — re-roll the level's randomized world. Not called
   * from the rail: rolling a world is a run-loop move (solve it, then press
   * 🎲 and re-run against a world you haven't seen), and the sandbox's own
   * verdict already surfaces that button next to Run. Kept wired here
   * because it costs nothing and a future teacher-facing surface may want
   * it. */
  rollWorld: () => void;
  /** Push resolved charm artwork URLs (keyed however the sandbox expects —
   * see `studioCharms.ts`). */
  sendCharms: (urls: Record<string, string>) => void;
}

export interface UseStudioBridgeOptions {
  allowedLevelIds: readonly string[];
  seedBase: string;
  nextWorldSeed?: (levelId: string) => string;
  onRun?: (run: StudioRunResult) => void;
}

export function useStudioBridge(options: UseStudioBridgeOptions): UseStudioBridgeResult {
  const {
    allowedLevelIds: allowedLevelIdList,
    seedBase,
    nextWorldSeed,
    onRun,
  } = options;
  const webViewRef = useRef<StudioWebViewHandle | null>(null);
  const readyRef = useRef(false);
  const initializedRef = useRef(false);
  const nonceRef = useRef<string | null>(null);
  const actionSeqRef = useRef(0);
  const directAttemptsRef = useRef<Record<string, number>>({});
  const handledRollRequestRef = useRef<string | null>(null);

  // `docRef` mirrors the sandbox's own state doc so every `"update"` message
  // carries the FULL accumulated doc (an `"update"` replaces the sandbox's
  // mirror wholesale — it is not itself a patch).
  const docRef = useRef<StudioBridgeDoc>({});

  const [ready, setReady] = useState(false);
  const [actionsReady, setActionsReady] = useState(false);
  const [activeLevelId, setActiveLevelId] = useState<string | undefined>(undefined);

  const saveProgram = useMutation(api.studio.saveProgram);
  const recordRun = useMutation(api.studio.recordRun);
  const runFixer = useAction(api.studioFixer.fix);
  const myPrograms = useQuery(api.studio.myPrograms, {});

  const programs = useMemo(
    () =>
      myPrograms
        ? (Object.fromEntries(
            (myPrograms as StudioProgramRow[]).map((row) => [row.levelId, row]),
          ) as UseStudioBridgeResult["programs"])
        : undefined,
    [myPrograms],
  );

  const postDoc = useCallback((actionRequest?: { id: string; name: string; args: unknown }) => {
    if (!readyRef.current || !webViewRef.current || !nonceRef.current) return;
    const type = initializedRef.current ? "update" : "init";
    webViewRef.current.injectJavaScript(
      appStateHostInjectionScript(type, docRef.current, nonceRef.current, undefined, actionRequest),
    );
    initializedRef.current = true;
  }, []);

  const dispatch = useCallback(
    (name: string, args: unknown) => {
      actionSeqRef.current += 1;
      postDoc({ id: `studio-${actionSeqRef.current}`, name, args });
    },
    [postDoc],
  );

  const allowedLevelIds = useMemo(
    () => new Set(allowedLevelIdList),
    [allowedLevelIdList],
  );

  const nextSeed = useCallback(
    (levelId: string) => {
      if (nextWorldSeed) return nextWorldSeed(levelId);
      const attempt = directAttemptsRef.current[levelId] ?? 0;
      directAttemptsRef.current[levelId] = attempt + 1;
      return deriveStudioWorldSeed(seedBase, levelId, attempt);
    },
    [nextWorldSeed, seedBase],
  );

  const openLevel = useCallback(
    (levelId: string) => {
      if (!allowedLevelIds.has(levelId)) return;
      const saved = programs?.[levelId];
      setActiveLevelId(levelId); // optimistic — instant rail feedback
      dispatch(
        STUDIO_ACTIONS.setLevel,
        saved
          ? { levelId, source: saved.source, seed: nextSeed(levelId) }
          : { levelId, seed: nextSeed(levelId) },
      );
    },
    [allowedLevelIds, programs, dispatch, nextSeed],
  );

  const rollWorld = useCallback(() => {
    const levelId = activeLevelId;
    if (!levelId || !allowedLevelIds.has(levelId)) return;
    dispatch(STUDIO_ACTIONS.rollWorld, { seed: nextSeed(levelId) });
  }, [activeLevelId, allowedLevelIds, dispatch, nextSeed]);

  const sendCharms = useCallback(
    (urls: Record<string, string>) => {
      dispatch(STUDIO_ACTIONS.setCharms, { urls });
    },
    [dispatch],
  );

  // ── Save debounce ──────────────────────────────────────────────────────
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSaveRef = useRef<{ levelId: string; source: string } | null>(null);

  const flushSave = useCallback(() => {
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    saveTimerRef.current = undefined;
    if (!pending) return;
    void saveProgram(pending).catch((error) => {
      console.warn("[studio] failed to save progress", error);
    });
  }, [saveProgram]);

  const scheduleSave = useCallback(
    (levelId: string, source: string) => {
      pendingSaveRef.current = { levelId, source };
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  useEffect(
    () => () => {
      clearTimeout(saveTimerRef.current);
      flushSave(); // flush a trailing save so leaving mid-idle doesn't lose it
    },
    [flushSave],
  );

  // ── Fix requests ───────────────────────────────────────────────────────
  const fixInFlightIdRef = useRef<string | null>(null);

  const handleFixRequest = useCallback(
    async (request: StudioFixRequest) => {
      if (fixInFlightIdRef.current === request.requestId) return;
      fixInFlightIdRef.current = request.requestId;
      // The sandbox is already showing its own "Let me look at that…" state
      // by the time this fires (confirmed with the sandbox's author), so
      // there is no native spinner to drive here — just complete the round
      // trip. That wait IS user-visible and blocking on the sandbox side
      // (the editor is not), so this must always answer with an `applyFix`,
      // success or failure, echoing the same `requestId` — never leave the
      // sandbox's outstanding request unanswered.
      try {
        const result: StudioFixResult = await runFixer({
          source: request.source,
          error: request.error,
          line: request.line,
        });
        dispatch(STUDIO_ACTIONS.applyFix, { requestId: request.requestId, result });
      } catch (error) {
        console.warn("[studio] fixer action failed", error);
        // Still answer: `ok: false` with the untouched source tells the
        // sandbox to stop waiting and show the scholar their original error,
        // exactly as if the model itself couldn't make sense of the program.
        dispatch(STUDIO_ACTIONS.applyFix, {
          requestId: request.requestId,
          result: { source: request.source, fixes: [], ok: false },
        });
      } finally {
        if (fixInFlightIdRef.current === request.requestId) fixInFlightIdRef.current = null;
      }
    },
    [runFixer, dispatch],
  );

  const handleRollRequest = useCallback(
    (request: StudioRollRequest) => {
      if (
        handledRollRequestRef.current === request.requestId ||
        !allowedLevelIds.has(request.levelId)
      ) {
        return;
      }
      handledRollRequestRef.current = request.requestId;
      dispatch(STUDIO_ACTIONS.rollWorld, { seed: nextSeed(request.levelId) });
    },
    [allowedLevelIds, dispatch, nextSeed],
  );

  // ── WebView lifecycle ──────────────────────────────────────────────────
  const onLoadStart = useCallback(() => {
    readyRef.current = false;
    initializedRef.current = false;
    nonceRef.current = null;
    setReady(false);
    setActionsReady(false);
  }, []);

  const onMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const message = parseAppStateBridgeMessage(event.nativeEvent.data);
      if (!message) return;

      if (message.type === "ready") {
        readyRef.current = true;
        initializedRef.current = false;
        nonceRef.current = message.nonce;
        postDoc();
        setReady(true);
        return;
      }

      if (!matchesAppStateBridgeNonce(message, nonceRef.current)) return;

      // The sandbox re-announces its whole action registry every time
      // `registerAction` runs, so a non-empty list is the only trustworthy
      // signal that a host-dispatched action will actually find a handler.
      // `"ready"` is NOT that signal: the SDK fires it the instant it is
      // injected, which is before a single line of the sandbox's own bundle
      // has run. See the resume-on-open note in `StudioScreen`.
      if (message.type === "actions") {
        if ((message.actions?.length ?? 0) > 0) setActionsReady(true);
        return;
      }

      if (message.type === "actionResult") {
        if (!message.ok) console.warn("[studio] bridge action failed:", message.error);
        return;
      }

      if (message.type !== "change") return;
      if (!message.patch) return;
      const patch = message.patch as Partial<StudioBridgeDoc>;
      docRef.current = { ...docRef.current, ...patch };

      if (patch.levelId) setActiveLevelId(patch.levelId);
      if (patch.source !== undefined && patch.levelId) {
        scheduleSave(patch.levelId, patch.source);
      }
      if (patch.lastRun !== undefined) {
        const run = patch.lastRun;
        if (isStudioRunResult(run) && allowedLevelIds.has(run.levelId)) {
          void recordRun({
            levelId: run.levelId,
            status: run.status,
            steps: run.steps,
            message: run.message,
            line: run.line,
          }).catch((error) => console.warn("[studio] failed to record run", error));
          onRun?.(run);
        } else {
          console.warn("[studio] ignored malformed or disallowed run result");
        }
      }
      if (patch.fixRequest) {
        void handleFixRequest(patch.fixRequest);
      }
      const rollRequest = patch.rollRequest as Partial<StudioRollRequest> | undefined;
      if (
        rollRequest &&
        typeof rollRequest.requestId === "string" &&
        typeof rollRequest.levelId === "string"
      ) {
        handleRollRequest(rollRequest as StudioRollRequest);
      }
    },
    [
      allowedLevelIds,
      postDoc,
      scheduleSave,
      recordRun,
      handleFixRequest,
      handleRollRequest,
      onRun,
    ],
  );

  return {
    webViewRef,
    onLoadStart,
    onMessage,
    ready,
    actionsReady,
    activeLevelId,
    programs,
    openLevel,
    rollWorld,
    sendCharms,
  };
}

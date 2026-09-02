/**
 * GameHost — the whole games platform on the client, in one file, mounted once
 * at the app root next to `ExternalAppHost` and `NativeManipulativeHost`.
 *
 * What it owns, and what that costs a game:
 *
 *  - **Session lifecycle.** start/resume on open, complete or crash on close.
 *    A game never learns a session id.
 *  - **Checkpointing.** `checkpoint.transact({ state, events })` writes durable
 *    state AND queued evidence in ONE server transaction, with optimistic
 *    concurrency on `lastSeq`. A retried write is rejected, not doubled.
 *  - **Active time.** wall-clock minus backgrounded time, via `AppState`. A
 *    game never asserts elapsed time — it does not have the signal that makes
 *    the number honest, and a game that could would eventually shade it.
 *  - **The help affordance.** "Hint" is HOST chrome and emits `host.help`.
 *    A game is never asked to report it, and therefore cannot decline to. The
 *    `host.` prefix is reserved server-side so a game cannot forge one either.
 *  - **Crash containment.** An error boundary around the game's Screen closes
 *    the session as `crashed`, keeps the evidence collected so far, and shows
 *    the scholar a plain sentence instead of a white screen.
 *
 * What it owns NOTHING of: rendering, rules, levels, physics, scoring, or the
 * game loop. This is a host, not an engine. Every temptation to "just add a
 * small scoring helper here" is the beginning of an engine — put it in the game.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";
import { useConvex } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { closeGame, useGameRequest, type GameRequest } from "@/lib/gameHost";
import { createActiveClock } from "@/lib/activeClock";
import { loadGame, type LoadedGame } from "@/games/registry";
import {
  GameCoachSheet,
  type GameCoachMessage,
} from "@/components/games/GameCoachSheet";
import {
  HOST_EVENT_KEYS,
  type GameCheckpoint,
  type GameEventInput,
  type GameHostApi,
  type GameLaunch,
} from "../../../vendor/games/contract";
import { getGame } from "../../../vendor/games/catalog";

type SessionHandle = {
  sessionId: Id<"gameSessions">;
  seed: string;
  lastSeq: number;
};

type Status =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "playing" };

export function GameHost() {
  const request = useGameRequest();
  return request ? <GameSurface request={request} /> : null;
}

/**
 * Keyed remount per request: a fresh session must never inherit the previous
 * game's state, timers or error-boundary flag. Cheaper and more obviously
 * correct than resetting six pieces of state on request change.
 */
function GameSurface({ request }: { request: GameRequest }) {
  return (
    <GameSurfaceInner
      key={`${request.activityId}:${request.assignmentId ?? ""}`}
      request={request}
    />
  );
}

function GameSurfaceInner({ request }: { request: GameRequest }) {
  const colors = useColors();
  const convex = useConvex();
  // GameSurface's key defines a game session. Keep its startup inputs tied to
  // that keyed mount even if a parent re-renders with an equivalent request.
  const [startup] = useState(() => ({ convex, request }));

  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [loaded, setLoaded] = useState<LoadedGame | null>(null);
  const [launch, setLaunch] = useState<GameLaunch<never, never> | null>(null);
  const [pending, setPending] = useState(false);
  const [coachMessages, setCoachMessages] = useState<GameCoachMessage[]>([]);
  const [coachEnded, setCoachEnded] = useState(false);
  const [coachVisible, setCoachVisible] = useState(false);
  // The round's session id, mirrored into state for RENDERING the coach sheet
  // (session.current is a ref — reading it during render is fenced). Same
  // value; the ref stays the write-path authority.
  const [coachSessionId, setCoachSessionId] = useState<Id<"gameSessions"> | null>(null);
  /**
   * How many evidence writes have failed since the last one that landed.
   *
   * Found by playing: a contract bound rejected the game's very first event, and
   * the round carried on perfectly — board, scores, opponent turns — while every
   * write to the server failed. The only signal was a dev-only LogBox toast, and
   * a fleet build has no LogBox. The scholar plays a full round, the teacher
   * gets an empty digest, and nothing anywhere says so.
   *
   * Evidence capture is the host's ONE load-bearing job (state restoration was
   * deliberately dropped; this was what remained). So a host that cannot capture
   * has to say it out loud rather than let the game paint over the failure.
   */
  const [writeFailures, setWriteFailures] = useState(0);

  const session = useRef<SessionHandle | null>(null);
  // Whether this session has already been closed (completed, abandoned or
  // crashed), so an unmount after completion doesn't fire a spurious report.
  const closed = useRef(false);
  // Serialises every write. See `submit`.
  const queue = useRef<Promise<void>>(Promise.resolve());

  // ── Active time ────────────────────────────────────────────────────────────
  // Wall-clock since the session opened, MINUS any paused span. The math lives
  // in a pure, injectable clock (see lib/activeClock) and is held in a ref so
  // reading it never triggers a render, and so a game can't get at it.
  const clock = useRef(createActiveClock());

  const activeMs = useCallback(() => clock.current.activeMs(Date.now()), []);

  const setPauseReason = useCallback(
    (reason: "background" | "coach", paused: boolean) => {
      clock.current.setPauseReason(reason, paused, Date.now());
    },
    [],
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      setPauseReason("background", next !== "active");
    });
    return () => sub.remove();
  }, [setPauseReason]);

  useEffect(() => {
    // Coach time is thinking time, not game-active time.
    setPauseReason("coach", coachVisible);
    return () => setPauseReason("coach", false);
  }, [coachVisible, setPauseReason]);

  /**
   * The single write path. Serialised through `session.current.lastSeq`, which
   * the server checks: a duplicated or out-of-order batch is REJECTED rather
   * than appended twice, so a flaky network can't fabricate a second move.
   */
  const submit = useCallback(
    async (events: readonly GameEventInput[], opts: { host?: boolean } = {}): Promise<boolean> => {
      // SERIALISED, not merely optimistic. `expectedLastSeq` is a compare-and-set
      // the server enforces, so two overlapping writes cannot both succeed — but
      // without this queue the SECOND one reads `lastSeq` before the first
      // resolves and is permanently stale, and its evidence is simply lost.
      // Rare with deliberate taps; certain the moment a game has an opponent
      // writing on a timer while the scholar taps.
      let ok = true;
      const run = queue.current.then(async () => {
        const s = session.current;
        if (!s || closed.current || events.length === 0) return;
        setPending(true);
        try {
          const res = await convex.mutation(api.games.checkpoint, {
            sessionId: s.sessionId,
            ...(opts.host
              ? { hostEvents: events as GameEventInput[] }
              : { events: events as GameEventInput[] }),
            atActiveMs: activeMs(),
            expectedLastSeq: s.lastSeq,
          });
          s.lastSeq = res.lastSeq;
          setWriteFailures(0);
        } catch (err) {
          // Counted, surfaced, and re-thrown. NOT retried: the failure that
          // exposed this was a permanent validation rejection, and a blind retry
          // loop against one of those is a worse bug than the silence.
          console.error("[games] checkpoint failed:", err);
          setWriteFailures((n) => n + 1);
          ok = false;
        } finally {
          setPending(false);
        }
      });
      // The chain must survive a failed link: one rejected write must not wedge
      // every later one.
      queue.current = run.catch(() => {});
      return run.then(
        () => ok,
        () => false,
      );
    },
    [activeMs, convex],
  );

  // ── Start / resume ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const started = await startup.convex.mutation(api.games.start, {
          activityId: startup.request.activityId,
          ...(startup.request.assignmentId ? { assignmentId: startup.request.assignmentId } : {}),
        });
        if (cancelled) return;

        const game = await loadGame(started.gameId);
        if (!game.ok) {
          // A registry miss is OUR bug, not the scholar's. Close the session as
          // crashed so it doesn't sit "active" forever and block the next start.
          console.error("[games] load failed:", game.detail);
          await startup.convex
            .mutation(api.games.reportCrash, { sessionId: started.sessionId })
            .catch(() => {});
          if (!cancelled) setStatus({ phase: "failed", message: game.message });
          return;
        }

        // Config and initial state are the game's own code running for the
        // first time. A throw here is an authoring bug, and it must close the
        // server session — otherwise a mis-configured activity leaves an
        // `active` row behind on every launch attempt.
        let config: never;
        let state: never;
        try {
          config = game.module.config.parse(JSON.parse(started.configJson)) as never;
          state = game.module.state.create({ config, seed: started.seed }) as never;
        } catch (err) {
          console.error("[games] init failed:", err);
          await startup.convex
            .mutation(api.games.reportCrash, { sessionId: started.sessionId })
            .catch(() => {});
          if (!cancelled) {
            setStatus({
              phase: "failed",
              message: "This game isn't set up right. Tell your teacher.",
            });
          }
          return;
        }

        const now = Date.now();
        clock.current.open(
          now,
          started.activeMs,
          AppState.currentState !== "active",
        );
        session.current = {
          sessionId: started.sessionId,
          seed: started.seed,
          lastSeq: started.lastSeq,
        };
        setCoachMessages([]);
        setCoachEnded(false);
        setCoachVisible(false);
        setCoachSessionId(started.sessionId);
        setLoaded(game);
        setLaunch({ config, state, seed: started.seed });
        setStatus({ phase: "playing" });
      } catch (err) {
        if (cancelled) return;
        console.error("[games] start failed:", err);
        setStatus({
          phase: "failed",
          message: "This game didn't start. Tell your teacher.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startup]);

  const checkpoint: GameCheckpoint<never> = useMemo(
    () => ({
      pending,
      async transact(next) {
        return await submit(next.events ?? []);
      },
    }),
    [pending, submit],
  );

  const finish = useCallback(() => {
    closed.current = true;
    closeGame();
  }, []);

  // Declared ABOVE the `host` memo on purpose. `host` reads `exit: close`
  // inside a useMemo FACTORY, which React runs during render — so with the
  // declaration below the memo, that read landed in `close`'s temporal dead
  // zone and threw `ReferenceError: Cannot access 'close' before
  // initialization` on every game launch. Note that adding `close` to the
  // memo's dependency array would NOT have fixed it: evaluating the array
  // reads the same uninitialized binding.
  /**
   * Backing out ENDS the round — there is no resume. So this asks first, and
   * only when there is something to lose: a scholar who opened a game by
   * mistake should not have to argue with a dialog, and one who is nine moves
   * into a build should not lose it to a stray tap on a kiosk iPad.
   *
   * Either way the server session is closed and digested. A round that stayed
   * `active` forever would strand its evidence undigested and leave the next
   * launch cleaning up after it.
   */
  const close = useCallback(() => {
    const s = session.current;
    if (!s || closed.current) {
      closed.current = true;
      closeGame();
      return;
    }
    const abandon = () => {
      closed.current = true;
      void convex.mutation(api.games.abandon, { sessionId: s.sessionId }).catch(() => {});
      closeGame();
    };
    // `lastSeq` is the honest measure of "has anything happened yet" — it counts
    // evidence that actually reached the server, not taps.
    if (s.lastSeq === 0) {
      abandon();
      return;
    }
    Alert.alert(
      "Leave this game?",
      "You can't pick this round up again — you'd start over. What you've done so far is saved for your teacher.",
      [
        { text: "Keep playing", style: "cancel" },
        { text: "Leave", style: "destructive", onPress: abandon },
      ],
    );
  }, [convex]);

  const host: GameHostApi = useMemo(
    () => ({
      async complete(outcome) {
        const s = session.current;
        if (!s || closed.current) return;
        // Completion jumps the queue's tail rather than the queue itself: it
        // must land AFTER every checkpoint already in flight, or it would
        // complete against a stale seq and reject.
        await queue.current;
        if (closed.current) return;
        await convex.mutation(api.games.requestCompletion, {
          sessionId: s.sessionId,
          outcomeKey: outcome.outcomeKey,
          events: (outcome.events ?? []) as GameEventInput[],
          atActiveMs: activeMs(),
          expectedLastSeq: s.lastSeq,
          ...(outcome.finalState === undefined
            ? {}
            : { finalStateJson: JSON.stringify(outcome.finalState) }),
        });
        finish();
      },
      exit: close,
    }),
    [activeMs, convex, finish, close],
  );

  /**
   * "Hint" is host chrome on purpose — and the NAME is doctrine: the coaching
   * ladder's one-front-door rule (stuck-coaching proposal §5) names every help
   * door "Hint" — strategy, never confession. Asking for help is the single most
   * useful thing a scholar can do and the single easiest thing for a game to
   * forget to report — so the game is never asked. It cannot suppress this, and
   * because `host.` keys are reserved server-side, it cannot forge one either.
   * And the door DELIVERS: every tap logs the unforgeable evidence AND opens
   * the Socratic coach grounded in the round so far — a help door that only
   * logs is a dead door (integration review, 2026-07-27).
   */
  const onHint = useCallback(() => {
    void submit([{ eventKey: HOST_EVENT_KEYS.help, payload: { kind: "help_requested" } }], {
      host: true,
    });
    setCoachVisible(true);
  }, [submit]);

  const onCrash = useCallback(
    (err: unknown) => {
      const s = session.current;
      console.error("[games] renderer crashed:", err);
      if (s && !closed.current) {
        closed.current = true;
        void convex
          .mutation(api.games.reportCrash, { sessionId: s.sessionId })
          .catch(() => {});
      }
      setStatus({
        phase: "failed",
        message: "This game stopped working. Your work up to now was saved.",
      });
    },
    [convex],
  );


  const Screen = loaded?.Screen;
  const title =
    request.activityTitle ?? (loaded ? getGame(loaded.gameId)?.title : null) ?? "Game";

  return (
    // FULL SCREEN, not a page sheet. A game is the only thing the scholar is
    // doing while it is open — a sheet leaves the surface it launched from
    // visible behind a card and shrinks the play area on the one device this
    // ever runs on. Same treatment the app's other take-over surface gets
    // (KioskWifiHelpOverlay).
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      {/*
        A native Modal is its OWN view hierarchy, so the app-root safe-area
        provider's insets do not reliably reach it — on a cold launch the header
        drew straight over the status bar (observed on device). The library's
        answer is a provider scoped to the modal, which measures its own frame.
      */}
      <SafeAreaProvider>
        <SafeAreaView style={[styles.container, { backgroundColor: colors.bgSubtle }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.navy }]} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.headerRight}>
              {status.phase === "playing" && (
                <Pressable
                  onPress={onHint}
                  accessibilityRole="button"
                  accessibilityLabel="Hint"
                  style={({ pressed }) => [
                    styles.hintBtn,
                    { borderColor: colors.border },
                    pressed && { opacity: 0.6 },
                  ]}
                  hitSlop={8}
                >
                  <SymbolView name="lightbulb" size={15} tintColor={colors.charcoal} />
                  <Text style={[styles.hintLabel, { color: colors.charcoal }]}>Hint</Text>
                </Pressable>
              )}
              <Pressable
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
                hitSlop={10}
              >
                <SymbolView name="xmark.circle.fill" size={26} tintColor={colors.charcoalSubtle} />
              </Pressable>
            </View>
          </View>

          {status.phase === "playing" && writeFailures > 0 && (
            <View style={[styles.notSaving, { backgroundColor: colors.bgSubtle }]}>
              <Text style={[styles.notSavingText, { color: colors.charcoal }]}>
                Not saving right now — keep playing, but your teacher may not see this round.
              </Text>
            </View>
          )}

          {status.phase === "loading" && (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          )}

          {status.phase === "failed" && (
            <View style={styles.center}>
              <Text style={[styles.failed, { color: colors.charcoal }]}>{status.message}</Text>
            </View>
          )}

          {status.phase === "playing" && Screen && launch && (
            <>
              {coachSessionId ? (
                <GameCoachSheet
                  visible={coachVisible}
                  onClose={() => setCoachVisible(false)}
                  gameSessionId={coachSessionId}
                  messages={coachMessages}
                  setMessages={setCoachMessages}
                  ended={coachEnded}
                  setEnded={setCoachEnded}
                />
              ) : null}
              <GameErrorBoundary onCrash={onCrash}>
                <Screen launch={launch} checkpoint={checkpoint} host={host} />
              </GameErrorBoundary>
            </>
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

/**
 * The containment wall. A game's renderer is the least-reviewed code in the
 * app and runs on kiosk iPads with no app switcher and no USB recovery — a
 * render throw that escaped to the root would be indistinguishable from a
 * bricked device. It stops here.
 */
class GameErrorBoundary extends Component<
  { children: ReactNode; onCrash: (err: unknown) => void },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onCrash(error);
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { fontFamily: fonts.bold, fontSize: 18, flexShrink: 1 },
  hintBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  hintLabel: { fontFamily: fonts.bold, fontSize: 13 },
  closeBtn: { padding: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  failed: { fontFamily: fonts.regular, fontSize: 16, textAlign: "center" },
  notSaving: { paddingHorizontal: 20, paddingVertical: 8 },
  notSavingText: { fontFamily: fonts.regular, fontSize: 14 },
});

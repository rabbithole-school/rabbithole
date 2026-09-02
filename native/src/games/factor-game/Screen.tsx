/**
 * `factor-game` — the renderer.
 *
 * A close port of the retired `FactorGame.native.tsx` manipulative: same board,
 * same cell treatment, same `usePressPop` tactility, same choreographed
 * opponent turn through the shared `useAiTurn` scheduler (thinking → revealing
 * → settling, 650 / 550 / 500 ms) so the CAUSE lands a beat before the
 * CONSEQUENCE. The board stays inert for that whole span.
 *
 * What changed in the move, and why:
 *
 * - **The readout is honest now.** As a manipulative this had to stay neutral
 *   ("Game over") because a frame above it was grading the round. Nothing
 *   grades a game, so the standing is just shown.
 * - **Every move banks evidence.** A tap is a `choice_made` with the full set
 *   of legal numbers as its option space, plus what the pick handed over and
 *   the game's labelled guess at why it was worth taking. The opponent's moves
 *   are tagged `actor: "opponent"` so nothing downstream can read the machine's
 *   choice as the child's thinking.
 * - **Finishing is a deliberate tap.** `host.complete()` is terminal and tears
 *   the surface down, so the final board and score are rendered first and the
 *   scholar leaves when they are ready.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { fonts, palette } from "@/theme";
import { lightImpact, successNotify, usePressPop } from "@/components/manipulatives/kit";
import type { GameEventInput, GameScreenProps } from "../../../vendor/games/contract";
import { useAiTurn } from "../useAiTurn";
import {
  applyChoice,
  applyFactors,
  applyMove,
  chooseOpponentMove,
  describeGiveaway,
  isLegalMove,
  isTerminal,
  legalMoves,
  netValue,
  outcomeOf,
  properFactors,
  rationaleFor,
  scores,
  type FactorConfig,
  type FactorState,
} from "./rules";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function wash(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export default function FactorGameScreen({
  launch,
  checkpoint,
  host,
}: GameScreenProps<FactorConfig, FactorState>) {
  const config = launch.config;
  const [state, setState] = useState<FactorState>(launch.state);
  const [boardW, setBoardW] = useState(0);

  // The opponent's choreography fires on a timer, so its callbacks need the
  // CURRENT board, not the one captured when the turn started. Mirrored in an
  // effect (never during render) — the same discipline `useAiTurn` uses for its
  // own callback refs, and safe here because the beats are ~500ms apart.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const commit = useCallback(
    async (next: FactorState, events: readonly GameEventInput[]) => {
      setState(next);
      await checkpoint.transact({ state: next, events });
    },
    [checkpoint],
  );

  // Open a phase so the digest has a frame to attribute time against — the host
  // supplies none, deliberately (a host that named your phases would be an
  // engine). Fires once; a round never resumes, so there is no re-entry case.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    void checkpoint.transact({
      state: launch.state,
      events: [{ eventKey: "phase", payload: { kind: "phase_changed", phase: "play" } }],
    });
  }, [checkpoint, launch.state]);

  const terminal = isTerminal(config, state);
  const opponentActive = state.turn === "opponent" && !terminal;

  /** The events that close a round out, appended to whichever move ended it. */
  const closingEvents = useCallback(
    (next: FactorState): GameEventInput[] => {
      if (!isTerminal(config, next)) return [];
      const s = scores(next);
      return [
        {
          eventKey: "no_moves_left",
          actor: "system",
          payload: {
            kind: "observation_recorded",
            value: `no number left has an unclaimed factor — you ${s.scholar}, opponent ${s.opponent}`,
          },
        },
        { eventKey: "phase", payload: { kind: "phase_changed", phase: "over" } },
      ];
    },
    [config],
  );

  const { phase: aiPhase, chosenMove: aiChosenMove } = useAiTurn<number>({
    active: opponentActive,
    chooseMove: () => chooseOpponentMove(config, stateRef.current),
    // Presentation beat: the opponent's number claims and pulses. No evidence
    // yet — the move is not complete until its factors have fanned out.
    revealMove: (move) => setState((s) => applyChoice(config, s, move)),
    applyMove: (move) => {
      const before = stateRef.current;
      const given = properFactors(move).filter((f) => before.claimedBy[f] == null);
      const next = applyFactors(config, before, move);
      void commit(next, [
        {
          eventKey: "opponent_pick",
          actor: "opponent",
          payload: {
            kind: "choice_made",
            choice: String(move),
            among: legalMoves(config, before).map(String),
          },
        },
        {
          eventKey: "opponent_giveaway",
          actor: "opponent",
          payload: {
            kind: "observation_recorded",
            value: `${move} handed you ${describeGiveaway(given)}`,
          },
        },
        ...closingEvents(next),
      ]);
    },
  });

  const tally = scores(state);
  const scholarTurn = state.turn === "scholar" && !terminal;
  // `applyMove`'s state update and the "settling" phase land in the same React
  // batch, so `scholarTurn` alone would re-enable the board a beat early.
  const boardInteractive = scholarTurn && aiPhase === "idle" && !checkpoint.pending;

  const pick = useCallback(
    (n: number) => {
      if (!boardInteractive || !isLegalMove(config, state, n)) return;
      lightImpact();
      const given = properFactors(n).filter((f) => state.claimedBy[f] == null);
      const net = netValue(state, n);
      const next = applyMove(config, state, n);
      void commit(next, [
        {
          eventKey: "scholar_pick",
          payload: {
            kind: "choice_made",
            choice: String(n),
            among: legalMoves(config, state).map(String),
          },
        },
        {
          eventKey: "giveaway_seen",
          payload: {
            kind: "observation_recorded",
            value: `${n} handed over ${describeGiveaway(given)} — net ${signed(net)}`,
          },
        },
        {
          eventKey: "pick_rationale",
          payload: { kind: "strategy_inferred", strategy: rationaleFor(config, state, n) },
        },
        ...closingEvents(next),
      ]);
    },
    [boardInteractive, closingEvents, commit, config, state],
  );

  const finishedRef = useRef(false);
  useEffect(() => {
    if (terminal && !finishedRef.current) {
      finishedRef.current = true;
      successNotify();
    }
  }, [terminal]);

  const finish = useCallback(async () => {
    const outcomeKey = outcomeOf(state);
    await host.complete({
      outcomeKey,
      finalState: state,
      events: [{ eventKey: "round_ended", payload: { kind: "outcome_claimed", outcomeKey } }],
    });
  }, [host, state]);

  const cols = config.boardSize <= 20 ? 5 : config.boardSize <= 42 ? 7 : 8;
  const gap = 8;
  const cellW = boardW > 0 ? (boardW - gap * (cols - 1)) / cols : 0;

  const statusText = terminal
    ? tally.scholar > tally.opponent
      ? "You finished ahead"
      : tally.opponent > tally.scholar
        ? "The opponent finished ahead"
        : "A tie"
    : aiPhase === "revealing"
      ? `Opponent picks ${aiChosenMove}…`
      : aiPhase === "settling"
        ? "Opponent claims its factors…"
        : scholarTurn
          ? "Your move"
          : "Opponent is thinking…";

  const onLayout = (e: LayoutChangeEvent) => setBoardW(e.nativeEvent.layout.width);

  return (
    <View style={styles.root}>
      <Text style={styles.prompt}>
        {terminal
          ? "No number left has an unclaimed factor."
          : "Claim a number. Your opponent takes every factor you leave behind."}
      </Text>

      <View style={styles.scoreRow}>
        <View style={styles.scoreGroup}>
          <View style={[styles.swatch, { backgroundColor: wash(palette.cyan[500], 0.9) }]} />
          <Text style={[styles.scoreText, { color: palette.navy[500] }]}>You {tally.scholar}</Text>
        </View>
        <View style={styles.scoreGroup}>
          <View style={[styles.swatch, { backgroundColor: wash(palette.violet[500], 0.9) }]} />
          <Text style={[styles.scoreText, { color: palette.charcoal[400] }]}>
            Opponent {tally.opponent}
          </Text>
        </View>
        <Text
          style={[
            styles.status,
            {
              color: terminal
                ? palette.charcoal[400]
                : boardInteractive
                  ? palette.green[600]
                  : palette.violet[500],
            },
          ]}
        >
          {statusText}
        </Text>
      </View>

      <View
        style={styles.board}
        onLayout={onLayout}
        pointerEvents={boardInteractive ? "auto" : "none"}
      >
        {cellW > 0 &&
          Array.from({ length: config.boardSize }, (_, i) => i + 1).map((n) => {
            const claimant = state.claimedBy[n];
            const legalNow = boardInteractive && isLegalMove(config, state, n);
            const isOpponentChoosing = aiPhase === "revealing" && n === aiChosenMove;
            const bg =
              claimant === "scholar"
                ? wash(palette.cyan[500], 0.55)
                : claimant === "opponent"
                  ? wash(palette.violet[500], 0.4)
                  : palette.white;
            const border = isOpponentChoosing
              ? palette.violet[500]
              : claimant
                ? "transparent"
                : legalNow
                  ? palette.navy[500]
                  : palette.gray[200];
            return (
              <FactorCell
                key={n}
                n={n}
                cellW={cellW}
                bg={bg}
                borderColor={border}
                legalNow={legalNow}
                isOpponentChoosing={isOpponentChoosing}
                textColor={claimant || legalNow ? palette.navy[500] : palette.charcoal[300]}
                dimmed={!claimant && !legalNow}
                accessibilityLabel={
                  isOpponentChoosing
                    ? `${n}, the opponent is claiming this`
                    : claimant
                      ? `${n}, claimed by ${claimant === "scholar" ? "you" : "the opponent"}`
                      : legalNow
                        ? `${n}, tap to claim`
                        : `${n}, not a legal move`
                }
                onPress={() => pick(n)}
              />
            );
          })}
      </View>

      {terminal && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void finish()}
          disabled={checkpoint.pending}
          style={({ pressed }) => [
            styles.doneBtn,
            { opacity: pressed || checkpoint.pending ? 0.6 : 1 },
          ]}
        >
          <Text style={styles.doneLabel}>Done</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * One board cell. Owns the shared press pop (haptic + scale on pressIn) AND the
 * opponent's "revealing" pulse — a scale + violet glow that plays BEFORE the
 * move's consequences land, so the pick is unmissable. They never overlap: the
 * board is inert while the opponent reveals.
 */
function FactorCell({
  n,
  cellW,
  bg,
  borderColor,
  legalNow,
  isOpponentChoosing,
  textColor,
  dimmed,
  accessibilityLabel,
  onPress,
}: {
  n: number;
  cellW: number;
  bg: string;
  borderColor: string;
  legalNow: boolean;
  isOpponentChoosing: boolean;
  textColor: string;
  dimmed: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const { pop, scale } = usePressPop();
  // Derived rather than imperatively assigned in an effect: the games lint
  // fence runs the React Compiler rules, which reject writing to a value a hook
  // returned. `useDerivedValue` constructs it where it is used instead, which
  // is also just less machinery.
  const reveal = useDerivedValue(() =>
    isOpponentChoosing
      ? withSequence(
          withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) }),
          withTiming(0.7, { duration: 220, easing: Easing.inOut(Easing.quad) }),
        )
      : withTiming(0, { duration: 160 }),
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() * (1 + reveal.get() * 0.12) }],
    shadowColor: palette.violet[500],
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.85 * reveal.get(),
    shadowRadius: 12 * reveal.get(),
  }));

  return (
    <AnimatedPressable
      onPressIn={() => {
        if (legalNow) pop();
      }}
      onPress={onPress}
      disabled={!legalNow}
      accessibilityRole="button"
      accessibilityState={{ disabled: !legalNow }}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.cell,
        { width: cellW, backgroundColor: bg, borderColor, opacity: dimmed ? 0.45 : 1 },
        animStyle,
      ]}
    >
      <Text style={[styles.cellText, { color: textColor }]}>{n}</Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  root: { width: "100%", gap: 16 },
  prompt: { fontFamily: fonts.bold, fontSize: 18, color: palette.navy[500] },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  scoreGroup: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 4 },
  scoreText: { fontFamily: fonts.bold, fontSize: 15 },
  status: { fontFamily: fonts.bold, fontSize: 14, marginLeft: "auto" },
  board: { width: "100%", flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cell: {
    height: 52,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  cellText: { fontFamily: fonts.bold, fontSize: 17 },
  doneBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: palette.navy[500],
  },
  doneLabel: { fontFamily: fonts.bold, fontSize: 16, color: palette.white },
});

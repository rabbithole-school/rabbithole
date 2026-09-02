/**
 * Dice (native) — tactile SceneKit probability experiment for the iPad app.
 * Scholars roll/flip in the same 3D tray as the spike, watch an empirical tally
 * build up, then commit a prediction for the practice frame to grade.
 */

import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

import {
  diceCount,
  diceFaces,
  diceSolved,
  diceSumDistribution,
  initialDice,
  parseDicePrediction,
  rollDiceFaces,
  DICE_BATCH_SIZE,
} from "../../../vendor/manipulative/logic";
import type { DiceState } from "../../../vendor/manipulative/logic";
import type { DiceEvent, DiceSpec } from "../../../vendor/manipulative/types";
import {
  SceneDiceView,
  type DiceSettledEvent,
} from "../../../modules/scene-dice";
import {
  lightImpact,
  ManipulativeScrollContext,
  mediumImpact,
  type KindProps,
} from "./kit";
import { applyKey, padGridKeys, type PadAnswerType } from "@/lib/practicePad";
import { fonts, palette, useColors } from "@/theme";

type Tally = Record<number, number>;
type SettledHandler = (e: { nativeEvent: DiceSettledEvent }) => void;
type DiceTrayHandle = { roll: (x: number, y: number, power: number) => void };
type TallyMode = "face" | "total";

// Roll ×10 mini-grid cadence — mirrors the web renderer so the batch feels the
// same on both surfaces. The native tray is a single heavy SceneKit view, so the
// batch grid uses these lightweight 2D mini-dice (RN Views) instead.
const MINI_ROLL_MS = 380;
const MINI_STAGGER = 55;
const MINI_SHUFFLE_MS = 70;
const MINI_DIE = 22;
const MINI_PIP = 3.6;
const BATCH_COLS = 5;

// d6 pip layout as fractional positions within the die face (mirrors web PIPS).
const MINI_PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.26], [0.72, 0.26], [0.28, 0.5], [0.72, 0.5], [0.28, 0.74], [0.72, 0.74]],
};

export function DiceNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<DiceSpec, DiceState>) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const trayRef = useRef<DiceTrayHandle>(null);

  const trayCount = diceCount(spec);
  const faces = useMemo(() => diceFaces(spec.diceType), [spec.diceType]);
  const tallyMode: TallyMode =
    spec.prediction?.type === "mostLikelyTotal" || (!spec.prediction && trayCount > 1)
      ? "total"
      : "face";
  const outcomes = useMemo(
    () =>
      tallyMode === "face"
        ? faces
        : [...diceSumDistribution(spec.diceType, trayCount).keys()].sort((a, b) => a - b),
    [faces, spec.diceType, tallyMode, trayCount],
  );

  const [state, setState] = useState<DiceState>(() => initialDice());
  const stateRef = useRef(state);
  const [tally, setTally] = useState<Tally>({});
  const [lastResults, setLastResults] = useState<number[]>([]);
  const [rolling, setRolling] = useState(false);
  const [input, setInput] = useState("");

  // Roll ×10 batch: each cell shuffles then settles, tallying as it lands.
  const [batch, setBatch] = useState<number[][]>([]);
  const [batchId, setBatchId] = useState(0);
  const [batchRolling, setBatchRolling] = useState(false);
  const batchSettledRef = useRef(0);

  const themeColor =
    spec.themeColor ??
    (spec.diceType === "coin"
      ? colors.orange
      : spec.diceType === "d20"
        ? colors.violet
        : colors.navy);

  const commitState = useCallback(
    (next: DiceState) => {
      stateRef.current = next;
      setState(next);
      onStateChange?.(next);
      onSolvedChange(diceSolved(spec, next));
    },
    [onSolvedChange, onStateChange, spec],
  );

  // Shared roll → tally path for both a single tray roll and each batch cell.
  // Reads rollCount/predicted from stateRef so the staggered batch cascade
  // increments correctly instead of racing a stale closure.
  const recordRoll = useCallback(
    (results: number[]) => {
      const samples =
        tallyMode === "face" ? results : [results.reduce((a, b) => a + b, 0)];
      setLastResults(results);
      setTally((prev) => {
        const next = { ...prev };
        for (const value of samples) next[value] = (next[value] ?? 0) + 1;
        return next;
      });
      commitState({
        rollCount: stateRef.current.rollCount + 1,
        predicted: stateRef.current.predicted,
      });
    },
    [commitState, tallyMode],
  );

  const onRollStart = useCallback(() => {
    setRolling(true);
    setBatch([]);
  }, []);
  const onSettled = useCallback<SettledHandler>(
    (e) => {
      setRolling(false);
      recordRoll(e.nativeEvent.results);
    },
    [recordRoll],
  );

  const onCellSettled = useCallback(
    (results: number[]) => {
      recordRoll(results);
      batchSettledRef.current += 1;
      if (batchSettledRef.current >= DICE_BATCH_SIZE) setBatchRolling(false);
    },
    [recordRoll],
  );

  const rollBatch = useCallback(() => {
    if (rolling || batchRolling) return;
    mediumImpact();
    const rolls = Array.from({ length: DICE_BATCH_SIZE }, () =>
      rollDiceFaces(spec.diceType, trayCount),
    );
    batchSettledRef.current = 0;
    setBatch(rolls);
    setBatchId((n) => n + 1);
    setBatchRolling(true);
  }, [batchRolling, rolling, spec.diceType, trayCount]);

  const commitPrediction = (parsed: { num: number; den: number }) => {
    lightImpact();
    commitState({
      rollCount: stateRef.current.rollCount,
      predicted: parsed,
    });
  };

  const maxTally = Math.max(1, ...Object.values(tally));
  const visibleOutcomes =
    outcomes.length <= 28
      ? outcomes
      : Object.keys(tally)
          .map((k) => Number(k))
          .sort((a, b) => a - b);
  const sampleCount = Object.values(tally).reduce((sum, n) => sum + n, 0);

  const isProbability = spec.prediction?.type === "probability";
  const padType: PadAnswerType = isProbability ? "fraction" : "integer";
  const parsedPrediction = parseDicePrediction(input);
  const canCommit = parsedPrediction != null;
  const predictionPlaceholder = isProbability ? "tap 1 / 2" : "tap a number";
  const onPredictionKey = (k: string) => setInput((prev) => applyKey(prev, k));

  return (
    <View style={styles.wrap}>
      <DiceTray
        ref={trayRef}
        diceType={spec.diceType}
        diceCount={trayCount}
        themeColor={themeColor}
        onRollStart={onRollStart}
        onSettled={onSettled}
        style={styles.tray}
      />

      <View style={styles.readoutRow}>
        <Text style={styles.readout}>{resultText(spec, lastResults, rolling)}</Text>
        <View style={styles.rollButtons}>
          <Pressable
            onPress={() => trayRef.current?.roll(0, -0.6, 0.75)}
            disabled={rolling || batchRolling}
            accessibilityRole="button"
            accessibilityLabel={spec.diceType === "coin" ? "Flip" : "Roll"}
            accessibilityState={{ disabled: rolling || batchRolling }}
            style={({ pressed }) => [
              styles.rollButton,
              pressed && styles.rollButtonPressed,
              (rolling || batchRolling) && styles.rollButtonDisabled,
            ]}
          >
            <Text style={styles.rollButtonText}>
              {spec.diceType === "coin" ? "Flip" : "Roll"}
            </Text>
          </Pressable>
          <Pressable
            onPress={rollBatch}
            disabled={rolling || batchRolling}
            accessibilityRole="button"
            accessibilityLabel={`${spec.diceType === "coin" ? "Flip" : "Roll"} ${DICE_BATCH_SIZE} times`}
            accessibilityState={{ disabled: rolling || batchRolling }}
            style={({ pressed }) => [
              styles.rollBatchButton,
              pressed && styles.rollBatchPressed,
              (rolling || batchRolling) && styles.rollButtonDisabled,
            ]}
          >
            <Text style={styles.rollBatchText}>
              {spec.diceType === "coin" ? "Flip" : "Roll"} ×{DICE_BATCH_SIZE}
            </Text>
          </Pressable>
        </View>
      </View>

      {batch.length > 0 ? (
        <View style={styles.batchCard}>
          <Text style={styles.sectionLabel}>
            {batchRolling
              ? `${spec.diceType === "coin" ? "Flipping" : "Rolling"} ×${DICE_BATCH_SIZE}…`
              : `Last ${DICE_BATCH_SIZE} ${spec.diceType === "coin" ? "flips" : "rolls"}`}
          </Text>
          {Array.from({ length: Math.ceil(batch.length / BATCH_COLS) }).map(
            (_, row) => (
              <View key={row} style={styles.batchRow}>
                {batch
                  .slice(row * BATCH_COLS, row * BATCH_COLS + BATCH_COLS)
                  .map((rollFaces, col) => {
                    const idx = row * BATCH_COLS + col;
                    return (
                      <MiniRollCell
                        key={`${batchId}-${idx}`}
                        diceType={spec.diceType}
                        count={trayCount}
                        faces={rollFaces}
                        themeColor={themeColor}
                        delay={idx * MINI_STAGGER}
                        styles={styles}
                        onSettled={onCellSettled}
                      />
                    );
                  })}
              </View>
            ),
          )}
        </View>
      ) : null}

      <View style={styles.tallyCard}>
        <View style={styles.tallyHeader}>
          <Text style={styles.sectionLabel}>
            {tallyMode === "face" ? "Observed faces" : "Observed totals"}
          </Text>
          <Text style={styles.tallyMeta}>
            {state.rollCount} roll{state.rollCount === 1 ? "" : "s"}
            {sampleCount > 0 ? ` · ${sampleCount} sample${sampleCount === 1 ? "" : "s"}` : ""}
          </Text>
        </View>
        {sampleCount === 0 ? (
          <Text style={styles.emptyTally}>
            Roll a few times and watch what shows up.
          </Text>
        ) : (
          <View style={styles.histRow}>
            {visibleOutcomes.map((outcome) => {
              const count = tally[outcome] ?? 0;
              return (
                <View key={outcome} style={styles.histCol}>
                  <Text style={styles.histCount}>{count || ""}</Text>
                  <View style={styles.histBarTrack}>
                    <View
                      style={[
                        styles.histBar,
                        {
                          height: `${Math.max(4, (count / maxTally) * 100)}%`,
                          backgroundColor:
                            count > 0 ? colors.cyan : "transparent",
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.histLabel}>{formatOutcome(spec, outcome, tallyMode)}</Text>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {spec.prediction ? (
        <View style={styles.predictionCard}>
          <Text style={styles.sectionLabel}>Your prediction</Text>
          <Text style={styles.predictionPrompt}>{predictionPrompt(spec)}</Text>
          <View
            style={styles.predInputBox}
            accessible={true}
            accessibilityLabel="Prediction entry"
            accessibilityValue={{ text: input || "empty" }}
          >
            <Text style={[styles.predInputText, !input && styles.predInputPlaceholder]}>
              {input || predictionPlaceholder}
            </Text>
          </View>
          <PredictionPad
            padType={padType}
            styles={styles}
            onKey={onPredictionKey}
          />
          <CommitButton
            label={isProbability ? "Commit fraction" : "Commit prediction"}
            disabled={!canCommit}
            onPress={() => parsedPrediction && commitPrediction(parsedPrediction)}
          />
          {state.predicted ? (
            <Text style={styles.committed}>
              Prediction set: {state.predicted.den === 1
                ? state.predicted.num
                : `${state.predicted.num}/${state.predicted.den}`}{" "}
              — tap Done.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const DiceTray = forwardRef<
  DiceTrayHandle,
  {
    diceType: DiceSpec["diceType"];
    diceCount: number;
    themeColor: string;
    onRollStart: () => void;
    onSettled: SettledHandler;
    style?: StyleProp<ViewStyle>;
  }
>(function DiceTray({ diceType, diceCount, themeColor, onRollStart, onSettled, style }, ref) {
  const [rollToken, setRollToken] = useState(0);
  const [thr, setThr] = useState({ x: 0, y: -0.6, power: 0.7 });
  const [drag, setDrag] = useState({ active: false, x: 0, y: 0 });
  const scrollRef = useContext(ManipulativeScrollContext);

  const doRoll = useCallback(
    (x: number, y: number, power: number) => {
      setThr({ x, y, power });
      onRollStart();
      mediumImpact();
      requestAnimationFrame(() => setRollToken((t) => t + 1));
    },
    [onRollStart],
  );

  useImperativeHandle(ref, () => ({ roll: doRoll }), [doRoll]);

  const startDrag = useCallback(
    (px: number, py: number) => {
      onRollStart();
      setDrag({ active: true, x: px, y: py });
    },
    [onRollStart],
  );
  const moveDrag = useCallback((px: number, py: number) => {
    setDrag((d) => (d.active ? { active: true, x: px, y: py } : d));
  }, []);
  const endDrag = useCallback((x: number, y: number, power: number) => {
    setThr({ x, y, power });
    requestAnimationFrame(() => setDrag((d) => ({ ...d, active: false })));
  }, []);

  const pan = useMemo(() => {
    let gesture = Gesture.Pan()
      .minDistance(0)
      .onStart((e) => {
        "worklet";
        runOnJS(startDrag)(e.x, e.y);
      })
      .onUpdate((e) => {
        "worklet";
        runOnJS(moveDrag)(e.x, e.y);
      })
      .onEnd((e) => {
        "worklet";
        const mag = Math.max(1, Math.hypot(e.velocityX, e.velocityY));
        const power = Math.min(1.3, Math.max(0.2, mag / 2600));
        runOnJS(endDrag)(e.velocityX / mag, e.velocityY / mag, power);
      });
    if (scrollRef) {
      gesture = gesture.blocksExternalGesture(
        scrollRef as Parameters<typeof gesture.blocksExternalGesture>[0],
      );
    }
    return gesture;
  }, [endDrag, moveDrag, scrollRef, startDrag]);

  return (
    <GestureDetector gesture={pan}>
      <View style={style}>
        <SceneDiceView
          style={StyleSheet.absoluteFill}
          diceType={diceType}
          diceCount={diceCount}
          themeColor={themeColor}
          rollToken={rollToken}
          throwX={thr.x}
          throwY={thr.y}
          throwPower={thr.power}
          dragActive={drag.active}
          dragX={drag.x}
          dragY={drag.y}
          onSettled={onSettled}
        />
      </View>
    </GestureDetector>
  );
});

function CommitButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.commitButton,
        pressed && !disabled && styles.commitPressed,
        disabled && styles.commitDisabled,
      ]}
    >
      <Text style={styles.commitText}>{label}</Text>
    </Pressable>
  );
}

/**
 * The on-screen number pad for the prediction — the native practice pad
 * (`padGridKeys` layout + `applyKey` semantics), so a scholar taps 1, /, 2 for a
 * fraction exactly like every other fraction item. A probability prediction
 * shows the `/` key; a count/total (integer) hides it.
 */
function PredictionPad({
  padType,
  styles,
  onKey,
}: {
  padType: PadAnswerType;
  styles: ReturnType<typeof makeStyles>;
  onKey: (k: string) => void;
}) {
  const keys = padGridKeys(padType);
  return (
    <View style={styles.padGrid}>
      {keys.map((k, i) => (
        <Pressable
          key={i}
          disabled={k === ""}
          onPress={() => k && onKey(k)}
          accessibilityRole="button"
          accessibilityLabel={
            k === "" ? undefined : k === "⌫" ? "key backspace" : k === "/" ? "key fraction bar" : `key ${k}`
          }
          style={({ pressed }) => [
            styles.padKey,
            k === "" && styles.padKeyHidden,
            pressed && k !== "" && styles.padKeyPressed,
          ]}
        >
          <Text style={styles.padKeyText}>{k}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * One cell of the Roll ×10 grid: a lightweight 2D mini-roll that shuffles random
 * faces then settles on its predetermined result, tallying via `onSettled`. Used
 * instead of the SceneKit tray (a single heavy native view can't be instanced 10×).
 */
function MiniRollCell({
  diceType,
  count,
  faces,
  themeColor,
  delay,
  styles,
  onSettled,
}: {
  diceType: DiceSpec["diceType"];
  count: number;
  faces: number[];
  themeColor: string;
  delay: number;
  styles: ReturnType<typeof makeStyles>;
  onSettled: (results: number[]) => void;
}) {
  const [display, setDisplay] = useState<number[]>(faces);
  const [settled, setSettled] = useState(false);
  const settle = useEffectEvent((settledFaces: number[]) => onSettled(settledFaces));

  useEffect(() => {
    const iv = setInterval(() => {
      setDisplay(rollDiceFaces(diceType, count));
    }, MINI_SHUFFLE_MS);
    const to = setTimeout(() => {
      clearInterval(iv);
      setDisplay(faces);
      setSettled(true);
      settle(faces);
    }, delay + MINI_ROLL_MS);
    return () => {
      clearInterval(iv);
      clearTimeout(to);
    };
    // Keyed remount per batch; these are constant for a given cell instance.
  }, [count, delay, diceType, faces]);

  const showTotal = count > 1 && diceType !== "coin";
  const total = faces.reduce((a, b) => a + b, 0);

  return (
    <View style={styles.miniCell}>
      <View style={[styles.miniDiceRow, !settled && styles.miniRolling]}>
        {display.map((v, i) => (
          <MiniDie
            key={i}
            diceType={diceType}
            value={v}
            themeColor={themeColor}
            styles={styles}
          />
        ))}
      </View>
      {showTotal ? (
        <Text style={[styles.miniTotal, settled && styles.miniTotalSettled]}>
          {settled ? total : "…"}
        </Text>
      ) : null}
    </View>
  );
}

function MiniDie({
  diceType,
  value,
  themeColor,
  styles,
}: {
  diceType: DiceSpec["diceType"];
  value: number;
  themeColor: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (diceType === "coin") {
    return (
      <View style={[styles.miniDie, styles.miniCoin, { backgroundColor: themeColor }]}>
        <Text style={styles.miniGlyph}>{value === 1 ? "H" : "T"}</Text>
      </View>
    );
  }
  if (diceType === "d20") {
    return (
      <View style={[styles.miniDie, { backgroundColor: themeColor }]}>
        <Text style={styles.miniD20Glyph}>{value}</Text>
      </View>
    );
  }
  const pips = MINI_PIPS[value] ?? [];
  return (
    <View style={[styles.miniDie, { backgroundColor: themeColor }]}>
      {pips.map(([px, py], i) => (
        <View
          key={i}
          style={[
            styles.miniPip,
            { left: px * MINI_DIE - MINI_PIP / 2, top: py * MINI_DIE - MINI_PIP / 2 },
          ]}
        />
      ))}
    </View>
  );
}

function predictionPrompt(spec: DiceSpec): string {
  const prediction = spec.prediction;
  if (!prediction) return "";
  if (prediction.type === "mostLikelyTotal") {
    return `Which total will show up most often when ${piecePhrase(spec)} roll?`;
  }
  const event = eventLabel(prediction.event, spec.diceType);
  if (prediction.type === "probability") {
    return `What fraction of one ${pieceName(spec.diceType)} is ${event}?`;
  }
  return `How many faces on one ${pieceName(spec.diceType)} are ${event}?`;
}

function eventLabel(event: DiceEvent, diceType: DiceSpec["diceType"]): string {
  switch (event.type) {
    case "face":
      if (diceType === "coin") return event.value === 1 ? "heads" : "tails";
      return `${event.value}`;
    case "even":
      return "even";
    case "odd":
      return "odd";
    case "atLeast":
      return `at least ${event.value}`;
    case "greaterThan":
      return `greater than ${event.value}`;
  }
}

function resultText(spec: DiceSpec, results: number[], rolling: boolean): string {
  if (rolling) return spec.diceType === "coin" ? "Flipping…" : "Rolling…";
  if (results.length === 0) {
    return `Drag and flick, or tap ${spec.diceType === "coin" ? "Flip" : "Roll"}.`;
  }
  if (spec.diceType === "coin") {
    const heads = results.filter((r) => r === 1).length;
    const tails = results.length - heads;
    if (results.length === 1) return heads === 1 ? "Heads" : "Tails";
    return `${heads} heads · ${tails} tails`;
  }
  const total = results.reduce((a, b) => a + b, 0);
  return results.length === 1
    ? `You rolled ${total}`
    : `You rolled ${results.join(" + ")} = ${total}`;
}

function formatOutcome(spec: DiceSpec, outcome: number, mode: TallyMode): string {
  if (spec.diceType === "coin" && mode === "face") {
    return outcome === 1 ? "H" : "T";
  }
  return String(outcome);
}

function pieceName(diceType: DiceSpec["diceType"]): string {
  if (diceType === "coin") return "coin";
  return diceType;
}

function piecePhrase(spec: DiceSpec): string {
  const count = diceCount(spec);
  if (spec.diceType === "coin") return `${count} coin${count === 1 ? "" : "s"}`;
  return `${count} ${spec.diceType === "d20" ? "d20" : "d6"} ${count === 1 ? "die" : "dice"}`;
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    wrap: { width: "100%", gap: 12 },
    tray: {
      width: "100%",
      height: 300,
      borderRadius: 20,
      backgroundColor: "#faf7ef",
      borderWidth: 2,
      borderColor: "rgba(20,24,60,0.10)",
      overflow: "hidden",
    },
    readoutRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    readout: {
      flex: 1,
      fontFamily: fonts.bold,
      fontSize: 16,
      lineHeight: 21,
      color: c.navy,
    },
    rollButton: {
      paddingHorizontal: 18,
      paddingVertical: 11,
      borderRadius: 14,
      backgroundColor: c.navy,
      minWidth: 76,
      alignItems: "center",
    },
    rollButtonPressed: { backgroundColor: c.navyHover },
    rollButtonDisabled: { opacity: 0.45 },
    rollButtonText: { fontFamily: fonts.bold, fontSize: 15, color: c.white },
    rollButtons: { flexDirection: "row", alignItems: "center", gap: 8 },
    rollBatchButton: {
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderRadius: 14,
      backgroundColor: c.violet,
      alignItems: "center",
    },
    rollBatchPressed: { backgroundColor: c.violetSolid },
    rollBatchText: { fontFamily: fonts.bold, fontSize: 15, color: c.white },
    batchCard: {
      padding: 14,
      borderRadius: 16,
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      gap: 10,
    },
    batchRow: {
      flexDirection: "row",
      justifyContent: "space-around",
      alignItems: "flex-start",
    },
    miniCell: { alignItems: "center", gap: 3, minWidth: MINI_DIE * 2 + 8 },
    miniDiceRow: { flexDirection: "row", gap: 3 },
    miniRolling: { opacity: 0.7 },
    miniDie: {
      width: MINI_DIE,
      height: MINI_DIE,
      borderRadius: 5,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    miniCoin: { borderRadius: MINI_DIE / 2 },
    miniPip: {
      position: "absolute",
      width: MINI_PIP,
      height: MINI_PIP,
      borderRadius: MINI_PIP / 2,
      backgroundColor: c.white,
    },
    miniGlyph: { fontFamily: fonts.bold, fontSize: 11, color: c.white },
    miniD20Glyph: { fontFamily: fonts.bold, fontSize: 10, color: c.white },
    miniTotal: { fontFamily: fonts.bold, fontSize: 12, color: c.fgMuted },
    miniTotalSettled: { color: c.navy },
    tallyCard: {
      padding: 14,
      borderRadius: 16,
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      gap: 10,
    },
    tallyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    sectionLabel: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
      letterSpacing: 1,
      textTransform: "uppercase",
      color: c.charcoalSubtle,
    },
    tallyMeta: { fontFamily: fonts.medium, fontSize: 12.5, color: c.fgMuted },
    emptyTally: {
      fontFamily: fonts.medium,
      fontSize: 14,
      color: c.fgMuted,
      textAlign: "center",
      paddingVertical: 10,
    },
    histRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      minHeight: 92,
      gap: 4,
    },
    histCol: { flex: 1, alignItems: "center", justifyContent: "flex-end", gap: 4 },
    histCount: { fontFamily: fonts.semibold, fontSize: 11, color: c.fgMuted, minHeight: 14 },
    histBarTrack: {
      width: "100%",
      maxWidth: 34,
      height: 54,
      justifyContent: "flex-end",
      borderRadius: 8,
      backgroundColor: `${palette.gray[200]}55`,
      overflow: "hidden",
    },
    histBar: {
      width: "100%",
      borderTopLeftRadius: 8,
      borderTopRightRadius: 8,
      minHeight: 0,
    },
    histLabel: {
      fontFamily: fonts.bold,
      fontSize: 11,
      color: c.navy,
      minHeight: 14,
    },
    predictionCard: {
      padding: 16,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.violetMuted,
      backgroundColor: c.violetSubtle,
      gap: 12,
      alignItems: "center",
    },
    predictionPrompt: {
      fontFamily: fonts.bold,
      fontSize: 17,
      lineHeight: 22,
      color: c.navy,
      textAlign: "center",
    },
    predInputBox: {
      width: "100%",
      minHeight: 54,
      borderWidth: 2,
      borderColor: c.violet,
      borderRadius: 12,
      backgroundColor: c.white,
      paddingHorizontal: 16,
      paddingVertical: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    predInputText: { fontFamily: fonts.bold, fontSize: 26, color: c.navy },
    predInputPlaceholder: { color: c.charcoalSubtle, fontFamily: fonts.regular, fontSize: 18 },
    padGrid: {
      width: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: 8,
    },
    padKey: {
      width: "31.5%",
      height: 54,
      borderRadius: 12,
      backgroundColor: c.gray50,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    padKeyHidden: { opacity: 0, borderWidth: 0, backgroundColor: "transparent" },
    padKeyPressed: { backgroundColor: c.gray200, transform: [{ scale: 0.96 }] },
    padKeyText: { fontFamily: fonts.semibold, fontSize: 22, color: c.fg },
    commitButton: {
      marginTop: 2,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: c.violet,
      minWidth: 160,
      alignItems: "center",
    },
    commitPressed: { backgroundColor: c.violetSolid },
    commitDisabled: { opacity: 0.45 },
    commitText: { fontFamily: fonts.bold, fontSize: 15, color: c.white },
    committed: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      lineHeight: 19,
      color: c.fgMuted,
      textAlign: "center",
    },
  });
}

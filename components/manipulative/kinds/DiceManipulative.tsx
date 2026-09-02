"use client";

/**
 * Dice — a tactile probability experiment. The tray is empirical evidence; the
 * prediction is a separate committed answer that the shared grader checks by
 * theory, so the material never prints the answer for the scholar.
 */
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent } from "react";
import type MatterNS from "matter-js";
import { Box, Button, Field, Flex, HStack, SimpleGrid, Text } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { DiceEvent, DiceSpec, DiceType } from "@/lib/manipulative/types";
import type { DiceFraction, DiceState } from "@/lib/manipulative/logic";
import { clamp, diceCount, diceFaces, diceSolved, initialDice, parseDicePrediction, rollDiceFaces, DICE_BATCH_SIZE } from "@/lib/manipulative/logic";
import { applyKey } from "@/shared/practiceLoop";
import { C, wash } from "../colors";

const TRAY_H = 340;
const MAX_PIECE = 66;
const MIN_PIECE = 42;

// "Roll ×N" mini-grid: how long each cell shuffles before it settles, plus the
// per-cell stagger that gives the batch a left-to-right cascade.
const MINI_ROLL_MS = 380;
const MINI_STAGGER = 55;
const MINI_DIE = 22;

const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.3], [0.72, 0.3], [0.28, 0.5], [0.72, 0.5], [0.28, 0.7], [0.72, 0.7]],
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function safeThemeColor(color: string | undefined, fallback: string) {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
}

function randomFace(values: number[]) {
  return values[Math.floor(Math.random() * values.length)] ?? values[0] ?? 1;
}

function startingFaces(values: number[], count: number) {
  return Array.from({ length: count }, (_, i) => values[i % values.length] ?? 1);
}

function pieceSizeFor(width: number, count: number) {
  const columns = Math.min(count, 5);
  const available = (width - 56) / columns - 10;
  return clamp(Math.floor(available), MIN_PIECE, MAX_PIECE);
}

function drawDie(ctx: CanvasRenderingContext2D, cx: number, cy: number, angle: number, face: number, size: number, accent: string, scale: number) {
  const half = (size / 2) * scale;
  ctx.save();
  ctx.translate(cx, cy + 5);
  ctx.fillStyle = "rgba(20,24,60,0.14)";
  roundRect(ctx, -half, -half, half * 2, half * 2, 14 * scale);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const grad = ctx.createLinearGradient(-half, -half, half, half);
  grad.addColorStop(0, "#fffdf8");
  grad.addColorStop(1, wash(accent, 0.18));
  ctx.fillStyle = grad;
  roundRect(ctx, -half, -half, half * 2, half * 2, 14 * scale);
  ctx.fill();
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = "rgba(34,38,86,0.18)";
  ctx.stroke();
  ctx.fillStyle = C.navy;
  const pipR = size * 0.085 * scale;
  for (const [px, py] of PIPS[face] ?? []) {
    ctx.beginPath();
    ctx.arc((px - 0.5) * size * scale, (py - 0.5) * size * scale, pipR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function polygonPath(ctx: CanvasRenderingContext2D, sides: number, radius: number) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i / sides) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawNumberToken(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  angle: number,
  face: number,
  size: number,
  accent: string,
  scale: number,
) {
  const r = (size / 2) * scale;
  ctx.save();
  ctx.translate(cx, cy + 5);
  ctx.fillStyle = "rgba(20,24,60,0.14)";
  polygonPath(ctx, 10, r);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const grad = ctx.createLinearGradient(-r, -r, r, r);
  grad.addColorStop(0, "#fffdf8");
  grad.addColorStop(1, wash(accent, 0.28));
  ctx.fillStyle = grad;
  polygonPath(ctx, 10, r);
  ctx.fill();
  ctx.strokeStyle = C.navy;
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = "rgba(34,38,86,0.22)";
  polygonPath(ctx, 10, r);
  ctx.stroke();
  ctx.fillStyle = C.navy;
  ctx.font = `800 ${Math.max(19, size * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(face), 0, 1);
  ctx.restore();
}

function drawCoin(ctx: CanvasRenderingContext2D, cx: number, cy: number, angle: number, face: number, size: number, accent: string, scale: number) {
  const r = (size / 2) * scale;
  ctx.save();
  ctx.translate(cx, cy + 5);
  ctx.fillStyle = "rgba(20,24,60,0.14)";
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const grad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.15, 0, 0, r);
  grad.addColorStop(0, "#fff8d7");
  grad.addColorStop(1, wash(accent, 0.55));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(34,38,86,0.14)";
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(34,38,86,0.26)";
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = C.navy;
  ctx.font = `900 ${Math.max(22, size * 0.46)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(face === 1 ? "H" : "T", 0, 1);
  ctx.restore();
}

function drawPiece(
  ctx: CanvasRenderingContext2D,
  diceType: DiceType,
  cx: number,
  cy: number,
  angle: number,
  face: number,
  size: number,
  accent: string,
  scale: number,
) {
  if (diceType === "coin") drawCoin(ctx, cx, cy, angle, face, size, accent, scale);
  else if (diceType === "d20") drawNumberToken(ctx, cx, cy, angle, face, size, accent, scale);
  else drawDie(ctx, cx, cy, angle, face, size, accent, scale);
}

function faceLabel(diceType: DiceType, value: number) {
  if (diceType !== "coin") return String(value);
  return value === 1 ? "Heads" : "Tails";
}

function eventLabel(diceType: DiceType, event: DiceEvent) {
  switch (event.type) {
    case "face":
      return diceType === "coin" ? faceLabel(diceType, event.value) : `a ${event.value}`;
    case "even":
      return "an even face";
    case "odd":
      return "an odd face";
    case "atLeast":
      return `at least ${event.value}`;
    case "greaterThan":
      return `greater than ${event.value}`;
  }
}

function outcomeFor(faces: number[]) {
  return faces.length === 1 ? (faces[0] ?? 0) : faces.reduce((sum, value) => sum + value, 0);
}

function outcomeLabel(diceType: DiceType, count: number, outcome: number) {
  if (diceType === "coin" && count === 1) return faceLabel(diceType, outcome);
  if (diceType === "coin") return `${outcome} H`;
  return String(outcome);
}

function resultSummary(diceType: DiceType, faces: number[], rolling: boolean) {
  if (rolling) return diceType === "coin" ? "Flipping…" : "Rolling…";
  if (faces.length === 1) return diceType === "coin" ? `Result: ${faceLabel(diceType, faces[0] ?? 0)}` : `Result: ${faces[0]}`;
  const total = outcomeFor(faces);
  if (diceType === "coin") return `${faces.map((f) => faceLabel(diceType, f)).join(" + ")} = ${total} head${total === 1 ? "" : "s"}`;
  return `${faces.join(" + ")} = ${total}`;
}

function PredictionForm({
  spec,
  predicted,
  onCommit,
}: {
  spec: DiceSpec;
  predicted: DiceFraction | null;
  onCommit: (prediction: DiceFraction | null) => void;
}) {
  const prediction = spec.prediction;
  const [input, setInput] = useState("");

  if (!prediction) return null;

  const isProbability = prediction.type === "probability";
  const parsed = parseDicePrediction(input);
  const canCommit = isProbability
    ? parsed != null && parsed.den > 0
    : parsed != null && parsed.den === 1 && parsed.num >= 0;
  const helper =
    prediction.type === "probability"
      ? `Commit P(${eventLabel(spec.diceType, prediction.event)}) as a fraction.`
      : prediction.type === "favorableCount"
        ? `Commit how many faces are ${eventLabel(spec.diceType, prediction.event)}.`
        : "Commit the total you think is most likely.";
  const placeholder = isProbability ? "tap 1 / 2" : "tap a number";

  // The SAME on-screen number pad every other fraction item uses: tap 1, /, 2.
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", isProbability ? "/" : "", "0", "⌫"];

  const onKey = (k: string) => {
    setInput((prev) => applyKey(prev, k));
    onCommit(null);
  };

  const commit = () => {
    if (canCommit && parsed) onCommit(parsed);
  };

  return (
    <Box
      as="form"
      mt={4}
      p={3}
      borderRadius="16px"
      borderWidth="1px"
      borderColor="border.default"
      style={{ background: wash(C.cyan, 0.08) }}
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <Field.Root>
        <Field.Label fontSize="13px" fontWeight="800" color="brand.primary">
          Your prediction
        </Field.Label>
        <Field.HelperText color="fg.muted">{helper}</Field.HelperText>
        <Box mx="auto" mt={2} w="100%" maxW="300px">
          <Flex
            h="52px"
            align="center"
            justify="center"
            borderRadius="12px"
            borderWidth="2px"
            borderColor={C.cyan}
            bg="white"
            aria-label="Prediction entry"
          >
            <Text fontSize="26px" fontWeight="900" color={input ? C.navy : "fg.muted"}>
              {input || placeholder}
            </Text>
          </Flex>
          <SimpleGrid columns={3} gap={2} mt={2}>
            {keys.map((k, i) => (
              <Button
                key={i}
                type="button"
                h="52px"
                fontSize="22px"
                fontWeight="700"
                variant="outline"
                bg="#f1ede4"
                visibility={k === "" ? "hidden" : "visible"}
                onClick={() => k && onKey(k)}
                aria-label={k === "⌫" ? "backspace" : k === "/" ? "fraction bar" : k ? `digit ${k}` : undefined}
                userSelect="none"
                style={{
                  WebkitUserSelect: "none",
                  WebkitTouchCallout: "none",
                  touchAction: "manipulation",
                }}
                _active={{ bg: "#e4dcc9", transform: "scale(0.95)" }}
                transition="transform 0.06s ease-out, background 0.06s ease-out"
              >
                {k}
              </Button>
            ))}
          </SimpleGrid>
          <Button
            type="submit"
            mt={2}
            w="100%"
            size="lg"
            bg="brand.primary"
            color="white"
            disabled={!canCommit}
          >
            Commit
          </Button>
        </Box>
      </Field.Root>
      <Text mt={2} minH="18px" fontSize="12px" fontWeight="700" color={predicted ? C.teal : "fg.muted"}>
        {predicted ? `Prediction committed: ${predicted.den === 1 ? predicted.num : `${predicted.num}/${predicted.den}`}. Tap Done when you are ready.` : "Not committed yet."}
      </Text>
    </Box>
  );
}

/** A single small die/coin face for the "Roll ×N" grid (flat, pip/number/H-T). */
function MiniDie({ diceType, value, size, accent }: { diceType: DiceType; value: number; size: number; accent: string }) {
  if (diceType === "coin") {
    return (
      <Flex align="center" justify="center" style={{ width: size, height: size, borderRadius: "50%", background: accent, color: "white", fontWeight: 800, fontSize: size * 0.5 }}>
        {value === 1 ? "H" : "T"}
      </Flex>
    );
  }
  if (diceType === "d20") {
    return (
      <Flex align="center" justify="center" style={{ width: size, height: size, borderRadius: size * 0.28, background: accent, color: "white", fontWeight: 800, fontSize: value >= 10 ? size * 0.42 : size * 0.5 }}>
        {value}
      </Flex>
    );
  }
  const pips = PIPS[value] ?? [];
  return (
    <Box position="relative" style={{ width: size, height: size, borderRadius: size * 0.22, background: accent }}>
      {pips.map(([px, py], i) => (
        <Box key={i} position="absolute" style={{ width: size * 0.17, height: size * 0.17, borderRadius: "50%", background: "white", left: `${px * 100}%`, top: `${py * 100}%`, transform: "translate(-50%,-50%)" }} />
      ))}
    </Box>
  );
}

/**
 * One cell of the "Roll ×N" grid — the pieces for a single roll. Shuffles random
 * faces for a beat (staggered by `delay`), then settles on `faces` and reports
 * the settled roll up so the parent can tally it. Keyed per batch so a new batch
 * remounts and replays the animation.
 */
function MiniRoll({
  diceType,
  count,
  faces,
  accent,
  delay,
  onSettled,
}: {
  diceType: DiceType;
  count: number;
  faces: number[];
  accent: string;
  delay: number;
  onSettled: () => void;
}) {
  const [display, setDisplay] = useState<number[]>(faces);
  const [settled, setSettled] = useState(false);
  const settle = useEffectEvent(onSettled);

  useEffect(() => {
    const iv = setInterval(() => setDisplay(rollDiceFaces(diceType, count)), 70);
    const to = setTimeout(() => {
      clearInterval(iv);
      setDisplay(faces);
      setSettled(true);
      settle();
    }, delay + MINI_ROLL_MS);
    return () => {
      clearInterval(iv);
      clearTimeout(to);
    };
  }, [diceType, count, delay, faces]);

  const total = faces.reduce((a, b) => a + b, 0);
  const showTotal = count > 1 && diceType !== "coin";
  return (
    <Flex
      direction="column"
      align="center"
      gap={1}
      p="6px"
      borderRadius="12px"
      bg="white"
      borderWidth="1px"
      borderColor={settled ? "border.default" : accent}
      opacity={settled ? 1 : 0.92}
      transition="border-color .2s ease, opacity .2s ease"
    >
      <HStack gap={1}>
        {display.map((v, i) => (
          <MiniDie key={i} diceType={diceType} value={v} size={MINI_DIE} accent={accent} />
        ))}
      </HStack>
      {showTotal ? (
        <Text fontSize="11px" fontWeight="800" color={settled ? C.navy : "fg.muted"}>
          {settled ? total : "…"}
        </Text>
      ) : null}
    </Flex>
  );
}

export function DiceManipulative({ spec, onSolvedChange, onStateChange }: KindProps<DiceSpec>) {
  const pieceCount = diceCount(spec);
  const faceValues = useMemo(() => diceFaces(spec.diceType), [spec.diceType]);
  const accent = safeThemeColor(spec.themeColor, spec.diceType === "coin" ? C.orange : C.violet);
  const initial = initialDice();
  const [rollCount, setRollCount] = useState(initial.rollCount);
  const [predicted, setPredicted] = useState<DiceState["predicted"]>(initial.predicted);
  const [faces, setFaces] = useState(() => startingFaces(faceValues, pieceCount));
  const [rolling, setRolling] = useState(false);
  const [tally, setTally] = useState<Record<number, number>>({});
  const [batch, setBatch] = useState<number[][]>([]);
  const [batchId, setBatchId] = useState(0);
  const [batchRolling, setBatchRolling] = useState(false);
  const batchSettledRef = useRef(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MatterNS.Engine | null>(null);
  const bodiesRef = useRef<MatterNS.Body[]>([]);
  const matterRef = useRef<typeof MatterNS | null>(null);
  const facesRef = useRef(faces);
  const rollingRef = useRef(false);
  const calmSinceRef = useRef<number | null>(null);
  const faceValuesRef = useRef(faceValues);
  const pieceCountRef = useRef(pieceCount);
  const pieceSizeRef = useRef(MAX_PIECE);
  const sizeRef = useRef({ w: 560, h: TRAY_H });
  const dragRef = useRef<{ x: number; y: number; t: number } | null>(null);

  useEffect(() => {
    faceValuesRef.current = faceValues;
    pieceCountRef.current = pieceCount;
  }, [faceValues, pieceCount]);

  const state = useMemo<DiceState>(() => ({ rollCount, predicted }), [rollCount, predicted]);

  useEffect(() => {
    onStateChange?.(state);
    onSolvedChange(diceSolved(spec, state));
  }, [onSolvedChange, onStateChange, spec, state]);

  useEffect(() => {
    const start = startingFaces(faceValues, pieceCount);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Puzzle inputs define a new atomic gameplay round, so every retained roll value must reset together.
    setFaces(start);
    facesRef.current = start;
    setTally({});
    setRollCount(0);
    setPredicted(null);
    setRolling(false);
    rollingRef.current = false;
    calmSinceRef.current = null;
    setBatch([]);
    setBatchRolling(false);
    batchSettledRef.current = 0;
  }, [faceValues, pieceCount, spec.id]);

  // The one place a settled roll (single OR one cell of a ×N batch) folds into
  // the running tally — keeps both paths counting identically.
  const recordRoll = useCallback((finalFaces: number[]) => {
    const outcome = outcomeFor(finalFaces);
    setTally((current) => ({ ...current, [outcome]: (current[outcome] ?? 0) + 1 }));
    setRollCount((count) => count + 1);
  }, []);

  const commitOutcome = useCallback(
    (finalFaces: number[]) => {
      setFaces(finalFaces);
      facesRef.current = finalFaces;
      recordRoll(finalFaces);
      setRolling(false);
      rollingRef.current = false;
    },
    [recordRoll],
  );

  const onCellSettled = useCallback(
    (finalFaces: number[]) => {
      recordRoll(finalFaces);
      batchSettledRef.current += 1;
      if (batchSettledRef.current >= DICE_BATCH_SIZE) setBatchRolling(false);
    },
    [recordRoll],
  );

  const rollBatch = useCallback(() => {
    if (rollingRef.current || batchRolling) return;
    const rolls = Array.from({ length: DICE_BATCH_SIZE }, () => rollDiceFaces(spec.diceType, pieceCount));
    batchSettledRef.current = 0;
    setBatch(rolls);
    setBatchId((n) => n + 1);
    setBatchRolling(true);
  }, [batchRolling, spec.diceType, pieceCount]);

  const buildWorld = useCallback(
    (M: typeof MatterNS) => {
      const { w, h } = sizeRef.current;
      const size = pieceSizeRef.current;
      const engine = M.Engine.create();
      engine.gravity.scale = 0;
      const wall = 200;
      const wallOptions = { isStatic: true, restitution: 0.62, friction: 0.05 };
      M.Composite.add(engine.world, [
        M.Bodies.rectangle(w / 2, -wall / 2, w + wall * 2, wall, wallOptions),
        M.Bodies.rectangle(w / 2, h + wall / 2, w + wall * 2, wall, wallOptions),
        M.Bodies.rectangle(-wall / 2, h / 2, wall, h + wall * 2, wallOptions),
        M.Bodies.rectangle(w + wall / 2, h / 2, wall, h + wall * 2, wallOptions),
      ]);

      const columns = Math.min(pieceCountRef.current, 5);
      const rows = Math.ceil(pieceCountRef.current / columns);
      const pieces: MatterNS.Body[] = [];
      for (let i = 0; i < pieceCountRef.current; i++) {
        const row = Math.floor(i / columns);
        const colsInRow = row === rows - 1 ? pieceCountRef.current - row * columns : columns;
        const col = i % columns;
        const x = w / 2 + (col - (colsInRow - 1) / 2) * (size + 18);
        const y = h / 2 + (row - (rows - 1) / 2) * (size + 24);
        const options = {
          restitution: 0.56,
          friction: 0.18,
          frictionAir: 0.046,
          frictionStatic: 0.6,
          density: 0.004,
        };
        const body =
          spec.diceType === "coin"
            ? M.Bodies.circle(x, y, size * 0.46, options)
            : spec.diceType === "d20"
              ? M.Bodies.polygon(x, y, 10, size * 0.52, options)
              : M.Bodies.rectangle(x, y, size, size, { ...options, chamfer: { radius: size * 0.18 } });
        pieces.push(body);
      }
      M.Composite.add(engine.world, pieces);
      engineRef.current = engine;
      bodiesRef.current = pieces;
    },
    [spec.diceType],
  );

  const throwPieces = useCallback((vx: number, vy: number) => {
    const M = matterRef.current;
    if (!M || bodiesRef.current.length === 0 || rollingRef.current) return;
    setRolling(true);
    rollingRef.current = true;
    calmSinceRef.current = null;
    setBatch([]);
    const speed = Math.hypot(vx, vy);
    const base = speed < 4 ? 14 + Math.random() * 8 : Math.min(speed, 42);
    const dir =
      speed < 1
        ? { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2 }
        : { x: vx / speed, y: vy / speed };
    for (const b of bodiesRef.current) {
      M.Body.setVelocity(b, {
        x: dir.x * base + (Math.random() - 0.5) * 12,
        y: dir.y * base + (Math.random() - 0.5) * 12,
      });
      M.Body.setAngularVelocity(b, (Math.random() - 0.5) * 1.05);
    }
  }, []);
  useEffect(() => {
    let raf = 0;
    let disposed = false;
    let lastFaceCycle = 0;

    void (async () => {
      const mod = await import("matter-js");
      const M = (mod as unknown as { default?: typeof MatterNS }).default ?? (mod as unknown as typeof MatterNS);
      if (disposed) return;
      matterRef.current = M;

      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.min(wrap.clientWidth || 560, 620);
      sizeRef.current = { w: width, h: TRAY_H };
      pieceSizeRef.current = pieceSizeFor(width, pieceCountRef.current);
      canvas.width = width * dpr;
      canvas.height = TRAY_H * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${TRAY_H}px`;

      buildWorld(M);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      let prev = performance.now();

      const loop = (now: number) => {
        if (disposed) return;
        const dt = Math.min(now - prev, 32);
        prev = now;
        const engine = engineRef.current;
        if (engine) M.Engine.update(engine, dt);

        const pieces = bodiesRef.current;
        const maxSpeed = pieces.reduce((max, b) => Math.max(max, Math.hypot(b.velocity.x, b.velocity.y), Math.abs(b.angularVelocity) * 12), 0);
        if (rollingRef.current) {
          if (maxSpeed < 0.35) {
            if (calmSinceRef.current == null) calmSinceRef.current = now;
            else if (now - calmSinceRef.current > 280) {
              pieces.forEach((b) => {
                M.Body.setVelocity(b, { x: 0, y: 0 });
                M.Body.setAngularVelocity(b, 0);
              });
              commitOutcome(pieces.map(() => randomFace(faceValuesRef.current)));
            }
          } else {
            calmSinceRef.current = null;
          }
          if (now - lastFaceCycle > 80) {
            lastFaceCycle = now;
            facesRef.current = pieces.map(() => randomFace(faceValuesRef.current));
          }
        }

        const { w } = sizeRef.current;
        const size = pieceSizeRef.current;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, TRAY_H);
        ctx.fillStyle = C.cream;
        roundRect(ctx, 0, 0, w, TRAY_H, 20);
        ctx.fill();
        ctx.strokeStyle = "rgba(34,38,86,0.10)";
        ctx.lineWidth = 2;
        ctx.stroke();

        pieces.forEach((b, i) => {
          const speed = Math.hypot(b.velocity.x, b.velocity.y);
          const scale = 1 + Math.min(speed, 20) * 0.004;
          drawPiece(ctx, spec.diceType, b.position.x, b.position.y, b.angle, facesRef.current[i] ?? faceValuesRef.current[0] ?? 1, size, accent, scale);
        });

        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      const M = matterRef.current;
      const engine = engineRef.current;
      if (M && engine) {
        M.World.clear(engine.world, false);
        M.Engine.clear(engine);
      }
      bodiesRef.current = [];
      engineRef.current = null;
    };
  }, [accent, buildWorld, commitOutcome, pieceCount, spec.diceType]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const dtSec = Math.max((performance.now() - drag.t) / 1000, 0.016);
    throwPieces(((e.clientX - drag.x) / dtSec) * 0.02, ((e.clientY - drag.y) / dtSec) * 0.02);
  };

  const outcomes = useMemo(() => {
    if (pieceCount === 1) return faceValues;
    const min = Math.min(...faceValues) * pieceCount;
    const max = Math.max(...faceValues) * pieceCount;
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }, [faceValues, pieceCount]);
  const maxTally = Math.max(1, ...Object.values(tally));
  const activeOutcome = outcomeFor(faces);
  const chartTitle = pieceCount === 1 ? (spec.diceType === "coin" ? "Side tally" : "Face tally") : spec.diceType === "coin" ? "Heads per flip" : "Total tally";

  return (
    <Box>
      <Flex align="center" justify="space-between" gap={3} wrap="wrap" mb={3}>
        <Text fontSize="13px" fontWeight="700" color="fg.muted">
          {pieceCount} {spec.diceType === "coin" ? "coin" : spec.diceType}
          {pieceCount === 1 ? "" : spec.diceType === "coin" ? "s" : " dice"} in the tray
        </Text>
        <HStack gap={2}>
          <Button size="sm" variant="outline" onClick={() => throwPieces(0, 0)} disabled={rolling || batchRolling}>
            {spec.diceType === "coin" ? "Flip" : "Roll"}
          </Button>
          <Button size="sm" variant="solid" colorPalette="purple" onClick={rollBatch} disabled={rolling || batchRolling}>
            {spec.diceType === "coin" ? "Flip" : "Roll"} ×{DICE_BATCH_SIZE}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTally({});
              setRollCount(0);
              setBatch([]);
            }}
          >
            Clear tally
          </Button>
        </HStack>
      </Flex>

      <Box ref={wrapRef} css={{ touchAction: "none", userSelect: "none" }} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (dragRef.current = null)}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${spec.diceType === "coin" ? "Coin" : "Dice"} tray. ${resultSummary(spec.diceType, faces, rolling)}`}
          style={{ display: "block", cursor: rolling ? "wait" : "grab", borderRadius: 20, maxWidth: "100%" }}
        />
      </Box>

      <Flex mt={3} align="center" justify="space-between" gap={3} wrap="wrap">
        <Box aria-live="polite">
          <Text fontSize="15px" fontWeight="800" color={C.navy}>
            {resultSummary(spec.diceType, faces, rolling)}
          </Text>
          <Text fontSize="12px" color="fg.muted">
            {rollCount} observed throw{rollCount === 1 ? "" : "s"}
          </Text>
        </Box>
        <SimpleGrid columns={{ base: Math.min(pieceCount, 4), md: Math.min(pieceCount, 6) }} gap={2}>
          {faces.map((face, i) => (
            <Box
              key={`${i}-${face}`}
              px="10px"
              py="6px"
              minW="44px"
              borderRadius="12px"
              textAlign="center"
              fontSize="13px"
              fontWeight="800"
              color={C.navy}
              borderWidth="1px"
              borderColor="border.default"
              bg="white"
            >
              {faceLabel(spec.diceType, face)}
            </Box>
          ))}
        </SimpleGrid>
      </Flex>

      {batch.length > 0 ? (
        <Box mt={3} p={3} borderRadius="16px" bg={wash(accent, 0.06)} borderWidth="1px" borderColor="border.default">
          <Text fontSize="12px" fontWeight="800" letterSpacing="0.06em" textTransform="uppercase" color="fg.muted" mb={3}>
            {batchRolling ? `${spec.diceType === "coin" ? "Flipping" : "Rolling"} ×${DICE_BATCH_SIZE}…` : `Last ${DICE_BATCH_SIZE} ${spec.diceType === "coin" ? "flips" : "rolls"}`}
          </Text>
          <SimpleGrid columns={5} gap={2}>
            {batch.map((rollFaces, i) => (
              <MiniRoll
                key={`${batchId}-${i}`}
                diceType={spec.diceType}
                count={pieceCount}
                faces={rollFaces}
                accent={accent}
                delay={i * MINI_STAGGER}
                onSettled={() => onCellSettled(rollFaces)}
              />
            ))}
          </SimpleGrid>
        </Box>
      ) : null}

      <Box mt={4} p={3} borderRadius="16px" bg="white" borderWidth="1px" borderColor="border.default">
        <Text fontSize="12px" fontWeight="800" letterSpacing="0.06em" textTransform="uppercase" color="fg.muted" mb={3}>
          {chartTitle}
        </Text>
        <Flex align="flex-end" gap={2} h="126px" overflowX="auto" pb={1} role="list" aria-label={`${chartTitle} histogram`}>
          {outcomes.map((outcome) => {
            const count = tally[outcome] ?? 0;
            const active = outcome === activeOutcome && !rolling && rollCount > 0;
            return (
              <Flex key={outcome} direction="column" align="center" justify="flex-end" gap={1} h="100%" minW={outcomes.length > 16 ? "22px" : "0"} flex="1" role="listitem" aria-label={`${outcomeLabel(spec.diceType, pieceCount, outcome)}: ${count}`}>
                <Text fontSize="10px" color="fg.muted" fontWeight="700">
                  {count || ""}
                </Text>
                <Box
                  w="100%"
                  maxW="40px"
                  borderTopRadius="7px"
                  bg={active ? accent : C.cyan}
                  h={`${(count / maxTally) * 100}%`}
                  minH={count ? "4px" : "0"}
                  transition="height .25s ease, background .2s ease"
                />
                <Text fontSize="11px" color={C.navy} fontWeight="800" whiteSpace="nowrap">
                  {outcomeLabel(spec.diceType, pieceCount, outcome)}
                </Text>
              </Flex>
            );
          })}
        </Flex>
      </Box>

      <PredictionForm spec={spec} predicted={predicted} onCommit={setPredicted} />
    </Box>
  );
}

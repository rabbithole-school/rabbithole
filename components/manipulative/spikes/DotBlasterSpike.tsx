"use client";

/*
 * Dot blaster (multiplication as repeated blasting) — the equal-groups model.
 *
 * The metaphor: a blaster whose chamber is LOADED with a group size. In "3
 * mode" the chamber literally shows three dots (arranged in a ten-frame), not a
 * numeral. Tap the trigger and a cluster of exactly that many dots flies out,
 * recoils the blaster, and lands as its own distinct group down the field.
 * Blast five times in 3 mode and you have built 5 × 3 = 15 by DOING it five
 * times — the product is generated one group at a time, not resized as an area.
 *
 * What the child's finger does: taps the chamber (or the dial's chevrons) to
 * change the loaded group size — the chamber's dots change count so the size is
 * a quantity you can see, never just a digit; taps the trigger to fire a shot;
 * drags any landed group off the field to undo that one blast (this is how you
 * fix an overshoot — no reset needed); hits reset to clear.
 *
 * What it teaches that nothing else in the repo does: beside the stacked groups
 * runs a SKIP-COUNT LADDER — as each group lands its cumulative total appears
 * beside it, so the field reads 3, 6, 9, 12, 15 down the side. The repo's array
 * manipulative already does multiplication as AREA (drag a corner, a rectangle
 * resizes continuously); this is the complementary equal-groups reading, so the
 * landed groups are separated ten-frame clusters with clear vertical gaps, a
 * STACK of groups and NEVER one tight rectangular grid. Division falls out for
 * free: lock the mode to 3, aim for 15, and "how many blasts?" is quotative
 * division — which the repo's partition/share kind (share into N plates) does
 * not cover, because that one is partitive.
 *
 * SpikeProps mapping — a spike-harness compromise: this shares the number-bond
 * SpikeProps signature, but here `target` means THE PRODUCT TO MAKE (target 15
 * = "make 15 dots") and `total` is ignored for the goal. onChange reports
 * left = dots on the field, right = max(0, target - left), solved = left ===
 * target. Multiple routes are accepted — five blasts of 3 and three blasts of 5
 * both make 15, exactly as the array manipulative accepts every factor pair;
 * changing modes between blasts even lets you reach non-multiples. The real spec
 * will carry an explicit product goal and a mode list instead of this overload.
 *
 * Robustness note (why the flight is decorative): a blast is committed to state
 * the MOMENT the child fires — that is when the act happened — and the flying
 * cluster is a purely decorative overlay animating a group that already exists
 * and is already counted. A dropped/throttled animation frame (backgrounded tab,
 * low-power iPad) can never change what the field contains or wedge the trigger;
 * the flight self-clears on a timeout that does not depend on requestAnimationFrame.
 *
 * Group-size range: 2..10, laid out as a ten-frame (five per row). 7–10 are
 * exactly the group sizes children struggle with, so the tool has to reach them;
 * the ten-frame arrangement keeps the 5-structure legible and rhymes with the
 * ten-frame / rekenrek spikes, which a dice-pip face (capped at 6) could not.
 *
 * Known rough edges:
 *  - Flight/recoil are lerp + CSS transitions, not a physics sim; a shot can't
 *    miss, so there's no satisfying-failure beat on firing (the undo is the
 *    drag-off instead).
 *  - Many groups (small mode, large target) make a tall stage; it grows with the
 *    field rather than scrolling, so a very large product runs off the bottom.
 *  - No sound; the "recoil" is purely the eased body kick.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { C, wash } from "@/components/manipulative/colors";

export interface SpikeProps {
  total: number;
  target: number;
  onChange?: (s: { left: number; right: number; solved: boolean }) => void;
}

export const SPIKE_META = {
  id: "dot-blaster-mult",
  title: "Dot blaster",
  metaphor: "Blast equal groups of dots",
  blurb:
    "Load the blaster with a group size, then fire it again and again — each shot flings out that many dots as its own group, and a skip-count ladder tallies 3, 6, 9, 12, 15 down the side.",
  why: "Multiplication built one equal group at a time by an act (not a resized rectangle), and — with the mode locked and a product to hit — 'how many blasts?' is quotative division, which the share-into-plates kind can't show.",
} as const;

const MODE_MIN = 2;
const MODE_MAX = 10;
const HEADER_H = 112; // blaster zone
const FOOTER_H = 34;
const ROW = 58; // vertical space per landed group — the field grows by this
const MUZZLE_Y = 92;
const CELL = 15; // ten-frame cell for a landed cluster
const CH_CELL = 15; // ten-frame cell inside the chamber
const REMOVE_DIST = 84;

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function defaultMode(target: number): number {
  for (const m of [3, 4, 5, 2, 6, 7, 8, 9, 10]) if (target > 0 && target % m === 0) return m;
  return 3;
}

/**
 * A cluster of `value` cyan dots in a ten-frame (up to 5 per row, filling
 * left-to-right, top row first). Generalizes cleanly to 10 and keeps the
 * 5-structure visible; a group is a separated block, not part of a grid.
 */
function Pips({ value, cell, opacity = 1 }: { value: number; cell: number; opacity?: number }) {
  const v = clampN(Math.round(value), 1, 10);
  const r = cell * 0.32;
  return (
    <>
      {Array.from({ length: v }, (_, i) => {
        const col = i % 5;
        const row = Math.floor(i / 5);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              background: C.cyan,
              left: col * cell + cell / 2 - r,
              top: row * cell + cell / 2 - r,
              opacity,
            }}
          />
        );
      })}
    </>
  );
}

function boxW(value: number, cell: number) {
  return Math.min(value, 5) * cell;
}
function boxH(value: number, cell: number) {
  return Math.ceil(value / 5) * cell;
}

interface Group {
  id: number;
  value: number;
}

export function DotBlasterSpike({ target, onChange }: SpikeProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  const [mode, setMode] = useState(() => defaultMode(target));
  const [groups, setGroups] = useState<Group[]>([]);
  const [flight, setFlight] = useState<{ id: number; value: number; x: number; y: number } | null>(null);
  const [recoil, setRecoil] = useState(false);
  const [flash, setFlash] = useState(false);
  const [drag, setDrag] = useState<{ id: number; dx: number; dy: number } | null>(null);

  const rafRef = useRef<number | null>(null);
  const timersRef = useRef<number[]>([]);
  const reducedRef = useRef(false);
  const idRef = useRef(0);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const geo = useMemo(() => {
    const colX = Math.round(width * 0.42);
    return { colX, ladderX: colX + boxW(5, CELL) / 2 + 22 };
  }, [width]);

  const slotY = useCallback((i: number) => HEADER_H + i * ROW + ROW / 2, []);

  // Measure the stage width so pixel math tracks the host box.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) > 1) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  // Reduced motion: shorten the flight, never remove it.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;
    const on = () => (reducedRef.current = mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Truth: report the running total from committed groups, never from animation.
  useEffect(() => {
    const left = groups.reduce((s, g) => s + g.value, 0);
    onChange?.({ left, right: Math.max(0, target - left), solved: left === target });
  }, [groups, target, onChange]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      timersRef.current.forEach((t) => clearTimeout(t));
    },
    [],
  );

  const after = (ms: number, fn: () => void) => {
    const id = window.setTimeout(fn, ms);
    timersRef.current.push(id);
  };

  const fire = useCallback(() => {
    const value = mode;
    const id = idRef.current++;
    const idx = groups.length;

    // Commit the blast immediately — the act happened now. Everything below is
    // decorative and cannot change what the field contains.
    setGroups((gs) => {
      return [...gs, { id, value }];
    });

    const reduced = reducedRef.current;
    const dur = reduced ? 120 : 380;
    const targetY = slotY(idx);

    setFlash(true);
    setRecoil(true);
    after(reduced ? 70 : 140, () => setFlash(false));
    after(reduced ? 110 : 210, () => setRecoil(false));

    setFlight({ id, value, x: geo.colX, y: MUZZLE_Y });
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = easeOut(p);
      setFlight((f) => (f && f.id === id ? { ...f, y: lerp(MUZZLE_Y, targetY, e) } : f));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        setFlight((f) => (f && f.id === id ? null : f));
      }
    };
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);
    // Fallback: reveal the landed group even if rAF is throttled (backgrounded
    // tab, low-power iPad) so the flight can never leave a group hidden.
    after(dur + 200, () => setFlight((f) => (f && f.id === id ? null : f)));
  }, [geo.colX, groups.length, mode, slotY]);

  const cycleMode = (dir: number) =>
    setMode((m) => {
      const span = MODE_MAX - MODE_MIN + 1;
      return MODE_MIN + (((m - MODE_MIN + dir) % span) + span) % span;
    });

  // Drag a landed group off the field to undo that blast.
  const onGroupDown = (id: number) => (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    setDrag({ id, dx: 0, dy: 0 });
  };
  const onGroupMove = (id: number) => (e: React.PointerEvent) => {
    const s = dragStartRef.current;
    if (!s) return;
    setDrag((d) => (d && d.id === id ? { ...d, dx: e.clientX - s.x, dy: e.clientY - s.y } : d));
  };
  const onGroupUp = (id: number) => (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragStartRef.current = null;
    setDrag((d) => {
      if (d && d.id === id && Math.hypot(d.dx, d.dy) > REMOVE_DIST) {
        setGroups((gs) => {
          return gs.filter((g) => g.id !== id);
        });
      }
      return null;
    });
  };

  const count = groups.length;
  const total = groups.reduce((s, g) => s + g.value, 0);
  const stageHeight = HEADER_H + Math.max(count, 1) * ROW + FOOTER_H;

  // Cumulative skip-count for the ladder.
  const cumulative = groups.reduce<number[]>(
    (totals, group) => [...totals, (totals.at(-1) ?? 0) + group.value],
    [],
  );

  const bodyW = 236;
  const bodyLeft = geo.colX - bodyW / 2;
  const chamberW = boxW(5, CH_CELL) + 12;
  const chamberH = boxH(10, CH_CELL) + 12;

  return (
    <div
      ref={stageRef}
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 560,
        height: stageHeight,
        margin: "0 auto",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {/* ---- blaster ---- */}
      <div
        style={{
          position: "absolute",
          left: bodyLeft,
          top: 12,
          width: bodyW,
          height: 76,
          borderRadius: 16,
          background: C.cream,
          border: `2px solid ${wash(C.charcoal, 0.35)}`,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 12px",
          transform: `translateY(${recoil ? -9 : 0}px)`,
          transition: "transform 160ms cubic-bezier(0.22, 1, 0.36, 1)",
          boxSizing: "border-box",
        }}
      >
        {/* chamber — tap to change the loaded group size; shows the size as dots */}
        <button
          type="button"
          onClick={() => cycleMode(1)}
          aria-label={`Group size ${mode}, tap to change`}
          style={{
            position: "relative",
            width: chamberW,
            height: chamberH,
            borderRadius: 10,
            background: C.bg,
            border: `2px solid ${wash(C.charcoal, 0.4)}`,
            padding: 0,
            cursor: "pointer",
            flex: "0 0 auto",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: (chamberW - boxW(mode, CH_CELL)) / 2,
              top: (chamberH - boxH(mode, CH_CELL)) / 2,
              width: boxW(mode, CH_CELL),
              height: boxH(mode, CH_CELL),
            }}
          >
            <Pips value={mode} cell={CH_CELL} />
          </div>
        </button>

        {/* dial — chevrons for a reversible size change */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "0 0 auto" }}>
          <DialButton label="Increase group size" glyph="▲" onTap={() => cycleMode(1)} />
          <DialButton label="Decrease group size" glyph="▼" onTap={() => cycleMode(-1)} />
        </div>

        {/* trigger */}
        <button
          type="button"
          onClick={fire}
          aria-label="Fire"
          style={{
            marginLeft: "auto",
            minWidth: 64,
            height: 48,
            borderRadius: 10,
            background: C.cream,
            border: `2px solid ${wash(C.charcoal, 0.4)}`,
            color: C.navy,
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Fire
        </button>
      </div>

      {/* muzzle nub + firing flash (orange is reserved for this moment only) */}
      <div
        style={{
          position: "absolute",
          left: geo.colX - 9,
          top: 84 + (recoil ? -9 : 0),
          width: 18,
          height: 16,
          borderRadius: "0 0 6px 6px",
          background: wash(C.charcoal, 0.35),
          transition: "top 160ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      />
      {flash && (
        <div
          style={{
            position: "absolute",
            left: geo.colX - 13,
            top: MUZZLE_Y - 4,
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: C.orange,
            opacity: 0.9,
            pointerEvents: "none",
          }}
        />
      )}

      {/* ---- skip-count ladder (neutral gray) ---- */}
      {count > 1 && (
        <div
          style={{
            position: "absolute",
            left: geo.ladderX - 14,
            top: slotY(0),
            width: 2,
            height: Math.max(0, slotY(count - 1) - slotY(0)),
            background: C.line,
          }}
        />
      )}
      {cumulative.map((n, i) => {
        const y = slotY(i);
        const last = i === count - 1;
        return (
          <div key={`rung-${groups[i].id}`}>
            <div
              style={{
                position: "absolute",
                left: geo.ladderX - 18,
                top: y - 1,
                width: 10,
                height: 2,
                background: C.line,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: geo.ladderX,
                top: y,
                transform: "translateY(-50%)",
                fontSize: last ? 20 : 16,
                fontWeight: last ? 700 : 500,
                color: last ? C.navy : C.charcoal,
              }}
            >
              {n}
            </div>
          </div>
        );
      })}

      {/* ---- landed groups (the truth; always present, always counted) ---- */}
      {groups.map((g, i) => {
        const isDrag = drag?.id === g.id;
        const w = boxW(g.value, CELL);
        const h = boxH(g.value, CELL);
        const baseX = geo.colX - w / 2;
        const baseY = slotY(i) - h / 2;
        const ox = isDrag ? drag!.dx : 0;
        const oy = isDrag ? drag!.dy : 0;
        const dist = isDrag ? Math.hypot(drag!.dx, drag!.dy) : 0;
        // Hidden only while its decorative flight is overhead; the fallback
        // timeout guarantees it reveals even if animation frames are dropped.
        const hidden = flight?.id === g.id;
        const opacity = hidden ? 0 : isDrag ? Math.max(0.3, 1 - dist / 200) : 1;
        return (
          <div
            key={g.id}
            onPointerDown={onGroupDown(g.id)}
            onPointerMove={onGroupMove(g.id)}
            onPointerUp={onGroupUp(g.id)}
            onPointerCancel={onGroupUp(g.id)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: Math.max(w, 44),
              height: Math.max(h, 44),
              paddingLeft: Math.max(0, (44 - w) / 2),
              paddingTop: Math.max(0, (44 - h) / 2),
              boxSizing: "content-box",
              transform: `translate(${baseX - Math.max(0, (44 - w) / 2) + ox}px, ${baseY - Math.max(0, (44 - h) / 2) + oy}px)`,
              transition: isDrag ? "opacity 120ms linear" : "transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms linear",
              opacity,
              touchAction: "none",
              cursor: "grab",
              zIndex: isDrag ? 3 : 1,
            }}
          >
            <div style={{ position: "relative", width: w, height: h }}>
              <Pips value={g.value} cell={CELL} />
            </div>
          </div>
        );
      })}

      {/* decorative projectile in flight — animates a group that already exists */}
      {flight && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: boxW(flight.value, CELL),
            height: boxH(flight.value, CELL),
            transform: `translate(${flight.x - boxW(flight.value, CELL) / 2}px, ${flight.y - boxH(flight.value, CELL) / 2}px)`,
            zIndex: 4,
            pointerEvents: "none",
          }}
        >
          <Pips value={flight.value} cell={CELL} />
        </div>
      )}

      {/* running total */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 2,
          textAlign: "center",
          fontSize: 14,
          color: C.charcoal,
        }}
      >
        {count > 0 ? `${count} ${count === 1 ? "group" : "groups"} · ${total} dots` : "Load a size, then fire"}
      </div>

      {/* reset — clear the whole field (per-blast undo is the drag-off) */}
      {count > 0 && (
        <button
          type="button"
          onClick={() => {
            setGroups([]);
            setFlight(null);
          }}
          style={{
            position: "absolute",
            right: 6,
            top: 6,
            height: 30,
            padding: "0 12px",
            borderRadius: 8,
            background: C.bg,
            border: `1.5px solid ${wash(C.charcoal, 0.35)}`,
            color: C.charcoal,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Reset
        </button>
      )}
    </div>
  );
}

function DialButton({ label, glyph, onTap }: { label: string; glyph: string; onTap: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onTap}
      style={{
        width: 26,
        height: 22,
        borderRadius: 5,
        background: C.bg,
        border: `1.5px solid ${wash(C.charcoal, 0.4)}`,
        color: C.charcoal,
        fontSize: 10,
        lineHeight: 1,
        padding: 0,
        cursor: "pointer",
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * Rod train — build a train that fits the reference rod exactly.
 * The child drags proportional rods from a tray, snaps them end-to-end, and pulls placed rods back out.
 * The measured lengths and remaining gap make the number bond tangible in a way a divider cannot.
 * Three-or-more-rod trains are valid when the first rod matches the target; the remaining rough
 * edge is that alignment clicks are visual-only rather than audible.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { C, wash } from "@/components/manipulative/colors";
export interface SpikeProps {
  /** The whole. Assume 10 for the demo, but do not hardcode it. */
  total: number;
  /** The required size of the FIRST/left group (e.g. 6 in "6 + 4 = 10"). */
  target: number;
  /** Fires on every change of the scholar's arrangement. */
  onChange?: (s: { left: number; right: number; solved: boolean }) => void;
}
export const SPIKE_META = {
  id: "rod-train",
  title: "Rod train",
  metaphor: "Fit rods to the whole",
  blurb: "Drag measured rods into a track and snap them end-to-end. Pull any rod out to try another fit.",
  why: "Length, not counting, reveals each part. The empty measured gap asks which rod will complete the whole.",
} as const;
type PlacedRod = { id: number; length: number };
type Drag = {
  pointerId: number;
  length: number;
  source: "tray" | "track";
  placedId?: number;
  trackIndex?: number;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  offsetX: number;
  offsetY: number;
  phase: "dragging" | "returning" | "refused";
};
export function RodTrainSpike({ total, target, onChange }: SpikeProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const trayRefs = useRef(new Map<number, HTMLButtonElement>());
  const nextId = useRef(1);
  const motionTimer = useRef<number | undefined>(undefined);
  const snapTimer = useRef<number | undefined>(undefined);
  const [trackWidth, setTrackWidth] = useState(0);
  const [placed, setPlaced] = useState<PlacedRod[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setTrackWidth(Math.max(0, stage.clientWidth - 24));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const left = placed[0]?.length ?? 0;
  const used = placed.reduce((sum, rod) => sum + rod.length, 0);
  const remaining = total - used;
  const solved = used === total && left === target;
  const unit = total > 0 ? trackWidth / total : 0;
  const lengths = Array.from({ length: Math.max(0, Math.floor(total)) }, (_, i) => i + 1);

  useEffect(() => {
    onChange?.({ left, right: total - left, solved });
  }, [left, onChange, placed, solved, total]);

  useEffect(
    () => () => {
      if (motionTimer.current !== undefined) clearTimeout(motionTimer.current);
      if (snapTimer.current !== undefined) clearTimeout(snapTimer.current);
    },
    [],
  );

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    length: number,
    source: Drag["source"],
    placedId?: number,
    trackIndex?: number,
  ) {
    const stageBox = stageRef.current?.getBoundingClientRect();
    if (!stageBox) return;
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      length,
      source,
      placedId,
      trackIndex,
      x: box.left - stageBox.left,
      y: box.top - stageBox.top,
      homeX: box.left - stageBox.left,
      homeY: box.top - stageBox.top,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
      phase: "dragging",
    });
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return;
    setDrag((current) =>
      current?.pointerId === event.pointerId && current.phase === "dragging"
        ? { ...current, x: event.clientX - box.left - current.offsetX, y: event.clientY - box.top - current.offsetY }
        : current,
    );
  }

  function returnRod(current: Drag, x: number, y: number, phase: Drag["phase"]) {
    setDrag({ ...current, x, y, phase });
    if (motionTimer.current !== undefined) clearTimeout(motionTimer.current);
    motionTimer.current = window.setTimeout(() => setDrag(null), 280);
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!drag || drag.pointerId !== event.pointerId || drag.phase !== "dragging") return;

    if (drag.source === "track") {
      setPlaced((rods) => rods.filter((rod) => rod.id !== drag.placedId));
      const stageBox = stageRef.current?.getBoundingClientRect();
      const trayBox = trayRefs.current.get(drag.length)?.getBoundingClientRect();
      returnRod(
        drag,
        stageBox && trayBox ? trayBox.left - stageBox.left : drag.homeX,
        stageBox && trayBox ? trayBox.top - stageBox.top : drag.homeY,
        "returning",
      );
      return;
    }

    const box = trackRef.current?.getBoundingClientRect();
    const overTrack =
      box &&
      event.clientX >= box.left - 12 &&
      event.clientX <= box.right + 12 &&
      event.clientY >= box.top - 16 &&
      event.clientY <= box.bottom + 16;

    if (overTrack && used + drag.length <= total) {
      setPlaced((rods) => [...rods, { id: nextId.current++, length: drag.length }]);
      setDrag(null);
      setSnapAt((used + drag.length) * unit);
      if (snapTimer.current !== undefined) clearTimeout(snapTimer.current);
      snapTimer.current = window.setTimeout(() => setSnapAt(null), 320);
    } else {
      returnRod(drag, drag.homeX, drag.homeY, overTrack ? "refused" : "returning");
    }
  }

  function cancelDrag(event: ReactPointerEvent<HTMLElement>) {
    if (drag?.pointerId === event.pointerId) setDrag(null);
  }

  const pointerHandlers = { onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: cancelDrag };

  return (
    <div
      ref={stageRef}
      className="rod-train-stage"
      style={{ minHeight: 190 + lengths.length * 48 }}
    >
      {trackWidth > 0 && (
        <>
          <div className="rod-reference" style={{ width: trackWidth }} aria-label={`Reference rod, length ${total}`}>
            {total}
          </div>

          <div ref={trackRef} className="rod-track" style={{ width: trackWidth }} aria-label={`${remaining} remaining`}>
            {lengths.slice(0, -1).map((mark) => (
              <span
                key={mark}
                className="rod-tick"
                style={{ left: mark * unit, top: mark === 5 ? 4 : 14, bottom: mark === 5 ? 4 : 14 }}
              />
            ))}

            {placed.map((rod, index) => {
              const before = placed.slice(0, index).reduce((sum, item) => sum + item.length, 0);
              const moving = drag?.source === "track" && drag.placedId === rod.id;
              return (
                <button
                  key={rod.id}
                  type="button"
                  className="rod-piece rod-placed"
                  aria-label={`Return length ${rod.length} rod to tray`}
                  onPointerDown={(event) => beginDrag(event, rod.length, "track", rod.id, index)}
                  {...pointerHandlers}
                  style={{
                    left: before * unit,
                    width: rod.length * unit,
                    background: index === 0 ? C.cyan : C.violet,
                    opacity: moving ? 0.18 : 1,
                    animation: moving ? undefined : "rodTrainSettle 220ms cubic-bezier(.2,.9,.3,1.18)",
                  }}
                >
                  {rod.length}
                </button>
              );
            })}

            {placed.length > 0 && remaining > 0 && (
              <div className="rod-gap" style={{ left: used * unit, width: remaining * unit }} aria-label={`Gap of ${remaining}`}>
                {remaining}
              </div>
            )}
            {snapAt !== null && <span className="rod-snap" style={{ left: snapAt - 2 }} />}
            <div className="rod-track-outline" aria-hidden="true" />
          </div>

          <div className="rod-tray-label">Rod tray</div>
          <div className="rod-tray" style={{ width: trackWidth }}>
            {lengths.map((length) => (
              <button
                key={length}
                ref={(node) => {
                  if (node) trayRefs.current.set(length, node);
                  else trayRefs.current.delete(length);
                }}
                type="button"
                className="rod-piece rod-tray-piece"
                aria-label={`Length ${length} rod`}
                onPointerDown={(event) => beginDrag(event, length, "tray")}
                {...pointerHandlers}
                style={{ width: length * unit }}
              >
                {length}
              </button>
            ))}
          </div>
        </>
      )}

      {drag && (
        <div
          className="rod-piece rod-drag"
          aria-hidden="true"
          style={{
            left: drag.x,
            top: drag.y,
            width: drag.length * unit,
            height: drag.source === "track" ? 54 : 44,
            background:
              drag.source === "track" ? (drag.trackIndex === 0 ? C.cyan : C.violet) : wash(C.charcoal, 0.16),
            transform: drag.phase === "refused" ? "rotate(-3deg) scale(.96)" : undefined,
            transition:
              drag.phase === "dragging"
                ? "none"
                : "left 260ms cubic-bezier(.4,0,.2,1.2), top 260ms cubic-bezier(.4,0,.2,1.2), transform 140ms ease",
          }}
        >
          {drag.length}
        </div>
      )}

      <style>{`
        .rod-train-stage { position:relative; width:100%; padding:12px; box-sizing:border-box;
          color:${C.navy}; user-select:none; }
        .rod-reference { height:44px; display:grid; place-items:center; box-sizing:border-box;
          border:0; border-radius:7px; background:${C.charcoal}; color:${C.cream}; font-size:17px; font-weight:800; }
        .rod-track { position:relative; height:54px; margin-top:20px; background:transparent; border-radius:7px; }
        .rod-tick { position:absolute; z-index:0; width:1px; background:${C.line}; }
        .rod-piece { appearance:none; box-sizing:border-box; padding:0; border:2px solid ${C.charcoal};
          border-radius:6px; color:${C.navy}; font-size:17px; font-weight:900; touch-action:none; }
        .rod-placed { position:absolute; z-index:2; top:0; height:54px; cursor:grab; }
        .rod-gap { position:absolute; z-index:1; top:0; height:54px; display:grid; place-items:center;
          box-sizing:border-box; border:2px dashed ${C.charcoal}; color:${C.charcoal}; font-size:16px; font-weight:800; }
        .rod-snap { position:absolute; z-index:5; top:-7px; width:4px; height:68px; border-radius:2px;
          background:${C.charcoal}; pointer-events:none; animation:rodTrainClick 320ms ease-out forwards; }
        .rod-track-outline { position:absolute; z-index:4; inset:0; border:2px solid ${C.charcoal};
          border-radius:7px; pointer-events:none; }
        .rod-tray-label { margin-top:40px; color:${C.charcoal}; font-size:12px; font-weight:800; }
        .rod-tray { display:flex; flex-direction:column; align-items:flex-start; gap:4px; margin-top:7px; }
        .rod-tray-piece { height:44px; flex:0 0 auto; border-color:${C.line};
          background:${wash(C.charcoal, 0.07)}; cursor:grab; }
        .rod-drag { position:absolute; z-index:20; display:grid; place-items:center; pointer-events:none; }
        @keyframes rodTrainSettle {
          0% { transform:translateY(-9px) scaleX(.98); }
          68% { transform:translateY(2px) scaleX(1.01); }
          100% { transform:translateY(0) scaleX(1); }
        }
        @keyframes rodTrainClick {
          0% { opacity:0; transform:scaleY(.25); }
          35% { opacity:.8; transform:scaleY(1); }
          100% { opacity:0; transform:scaleY(.7); }
        }
      `}</style>
    </div>
  );
}

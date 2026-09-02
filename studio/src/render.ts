/**
 * The renderer.
 *
 * One canvas draws both modes. In `"puzzle"` mode it draws a grid world with a
 * robot in it; in `"art"` mode the grid and the robot fade back and the pen
 * trail is the subject. That is one surface rather than two because the whole
 * argument of the elective is that they are the same act — you are always
 * telling a machine what to do and watching it happen.
 *
 * The canvas is a fixed 720 square in canvas units and is scaled by CSS to fill
 * whatever the iPad gives us. Everything below is therefore written in a stable
 * coordinate space and never has to think about the viewport.
 */
import type { StudioWorld } from "../../shared/studioContract";
import { CELL, DIRS, GRID, PAPER, type Frame, type Stroke } from "./runtime";
import { HEX, colorOf } from "./palette";
import { charm } from "./charms";

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

export function mountCanvas(el: HTMLCanvasElement) {
  canvas = el;
  ctx = el.getContext("2d")!;
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
}

/**
 * Size the backing store to the device pixels actually available, then let CSS
 * letterbox it. Skipping this is how a canvas ends up looking soft on a Retina
 * iPad — and soft artwork reads as "this is a website", which is the exact
 * impression we are trying not to leave.
 */
function resize() {
  if (!canvas) return;
  const stage = canvas.parentElement!;
  const box = Math.max(80, Math.min(stage.clientWidth, stage.clientHeight) - 12);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.style.width = `${box}px`;
  canvas.style.height = `${box}px`;
  canvas.width = Math.round(box * dpr);
  canvas.height = Math.round(box * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const s = (box * dpr) / PAPER;
  ctx.scale(s, s);
}

/** Re-measure after a layout change (rotation, keyboard, level switch). */
export const relayout = () => resize();

const mid = (n: number) => n * CELL + CELL / 2;

function sprite(img: HTMLImageElement, cx: number, cy: number, box: number) {
  const s = box / Math.max(img.naturalWidth, img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
}

export function draw(world: StudioWorld, frame: Frame, trail: Stroke[]) {
  ctx.clearRect(0, 0, PAPER, PAPER);
  ctx.fillStyle = HEX.cream;
  ctx.fillRect(0, 0, PAPER, PAPER);

  const art = world.free;

  if (!art) paintedFloor(world);
  grid(art);
  if (!art) walls(world);
  if (!art) goal(world);

  penTrail(trail, art);

  if (!art) treasure(world, frame);
  robot(frame, art);
}

/** The painted floor is the only thing `onColor()` reads, so it must be obvious. */
function paintedFloor(world: StudioWorld) {
  for (const [k, c] of world.paint) {
    const [px, py] = k.split(",").map(Number);
    const hex = colorOf(c);
    ctx.fillStyle = hex + "44";
    ctx.fillRect(px * CELL, py * CELL, CELL, CELL);
    ctx.strokeStyle = hex;
    ctx.lineWidth = 3;
    ctx.strokeRect(px * CELL + 4, py * CELL + 4, CELL - 8, CELL - 8);
  }
}

function grid(faint: boolean) {
  ctx.strokeStyle = faint ? "#00000008" : "#0000000f";
  ctx.lineWidth = 1;
  for (let i = 1; i < GRID; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL, 0);
    ctx.lineTo(i * CELL, PAPER);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL);
    ctx.lineTo(PAPER, i * CELL);
    ctx.stroke();
  }
}

/**
 * A solid tile ALWAYS, with the charm laid on top when one has loaded. "This
 * cell is blocked" is a rule of the puzzle and must stay legible no matter what
 * the artwork is doing — half-loaded art must never make a wall look passable.
 */
function walls(world: StudioWorld) {
  const img = charm("wall");
  for (const w of world.walls) {
    const [wx, wy] = w.split(",").map(Number);
    if (wx < 0 || wy < 0 || wx >= GRID || wy >= GRID) continue;
    ctx.fillStyle = img ? "#e4e7ee" : "#c9cdd6";
    ctx.fillRect(wx * CELL + 2, wy * CELL + 2, CELL - 4, CELL - 4);
    if (img) sprite(img, mid(wx), mid(wy), CELL - 8);
  }
}

function goal(world: StudioWorld) {
  if (!world.goal) return;
  const gx = world.goal.x * CELL;
  const gy = world.goal.y * CELL;
  ctx.fillStyle = HEX.green + "33";
  ctx.fillRect(gx + 6, gy + 6, CELL - 12, CELL - 12);
  ctx.strokeStyle = HEX.green;
  ctx.lineWidth = 3;
  ctx.strokeRect(gx + 6, gy + 6, CELL - 12, CELL - 12);
  const img = charm("goal");
  if (img) sprite(img, gx + CELL / 2, gy + CELL / 2, CELL - 18);
}

/** Under the robot, so the robot never hides its own work. */
function penTrail(trail: Stroke[], art: boolean) {
  ctx.lineWidth = art ? 13 : 10;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const t of trail) {
    ctx.strokeStyle = t.c;
    ctx.beginPath();
    ctx.moveTo(mid(t.x0), mid(t.y0));
    ctx.lineTo(mid(t.x1), mid(t.y1));
    ctx.stroke();
  }
}

function treasure(world: StudioWorld, frame: Frame) {
  const img = charm("treasure");
  world.treasure.forEach((g, i) => {
    if (frame.taken.includes(i)) return;
    const cx = mid(g.x);
    const cy = mid(g.y);
    if (img) {
      sprite(img, cx, cy, CELL - 20);
      return;
    }
    ctx.fillStyle = HEX.gold;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 18);
    ctx.lineTo(cx + 15, cy);
    ctx.lineTo(cx, cy + 18);
    ctx.lineTo(cx - 15, cy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#00000022";
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

function robot(frame: Frame, art: boolean) {
  const cx = mid(frame.x);
  const cy = mid(frame.y);
  const bumped = frame.note === "bump";
  const img = art ? null : charm("robot");

  if (img) {
    // Upright, never rotated: the charm camera is a three-quarter pose, so
    // spinning it reads as the robot falling over rather than turning.
    ctx.fillStyle = "#ffffffcc";
    ctx.beginPath();
    ctx.arc(cx, cy, CELL / 2 - 8, 0, Math.PI * 2);
    ctx.fill();
    sprite(img, cx, cy, CELL - 22);
  } else {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((frame.dir * Math.PI) / 2);
    ctx.fillStyle = bumped ? HEX.red : HEX.blue;
    const s = art ? 0.6 : 1;
    ctx.globalAlpha = art ? 0.75 : 1;
    ctx.beginPath();
    ctx.moveTo(24 * s, 0);
    ctx.lineTo(-16 * s, 18 * s);
    ctx.lineTo(-8 * s, 0);
    ctx.lineTo(-16 * s, -18 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // WHICH WAY AM I POINTED is load-bearing on every single level, so it gets
  // its own mark instead of relying on a sprite's rotation to carry it.
  if (img) {
    const [dx, dy] = DIRS[frame.dir];
    ctx.save();
    ctx.translate(cx + dx * (CELL / 2 - 10), cy + dy * (CELL / 2 - 10));
    ctx.rotate((frame.dir * Math.PI) / 2);
    ctx.fillStyle = bumped ? HEX.red : HEX.blue;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, 7);
    ctx.lineTo(-5, -7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  if (bumped) {
    const [dx, dy] = DIRS[frame.dir];
    ctx.strokeStyle = HEX.red;
    ctx.lineWidth = 6;
    ctx.strokeRect(
      (frame.x + dx) * CELL + 4,
      (frame.y + dy) * CELL + 4,
      CELL - 8,
      CELL - 8,
    );
  }
}

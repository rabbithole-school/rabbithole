// The Studio's 11-level puzzle ladder — ported from the browser-verified
// spike at review/coding-elective/spike-7-robot.html. Read that file's
// "the world" / "the ladder" sections alongside this one; this is a faithful
// port of its world generator and level table, not a redesign.
//
// The load-bearing idea, carried over unchanged: every level's `starter` is
// the PREVIOUS level's solution. It runs — and falls short in exactly one
// instructive way, which the level's `idea` then supplies the fix for. A
// scholar is never handed a blank page and never handed two new ideas at
// once. Two starters (hallway, stairs) legitimately solve their CANONICAL
// world; that is deliberate, because the lesson is pressing "change the
// world" and watching the same program fail — see `rollFrom` below.

import {
  cellKey,
  type StudioCellKey,
  type StudioColor,
  type StudioDir,
  type StudioLevel,
  type StudioRung,
  type StudioWorld,
  type StudioWorldSeed,
} from "./studioContract";

/** 9x9 cells, matching the spike's `N`. Exported so a test runner that
 *  replicates `execute()`'s bounds check doesn't have to duplicate the
 *  constant and risk it drifting from the worlds actually generated here. */
export const STUDIO_GRID_SIZE = 9;

/** East, south, west, north, clockwise. right() is +1, left() is +3. Screen
 *  coordinates, so index 1 (south) is +y — matches StudioDir's contract. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * The seed `build(i)` reset to before every canonical `make()` in the spike.
 * `buildWorld` defaults to it, so calling it with no seed reproduces exactly
 * the world the prototype was hand-verified against.
 */
export const CANONICAL_SEED = 20261006;

/**
 * One rolled world's random inputs. The spike kept its randomness as module-
 * level globals (`let seed`, `let roll`) that every level function read
 * implicitly; that's fine for a single-document spike with one world alive
 * at a time, but shared/ code has no such singleton, and the contract asks
 * for "the same seed reproduces a world exactly" — including on a re-roll,
 * not only the canonical one. So the port closes every generator over an
 * explicit context instead of reading globals.
 */
interface RollCtx {
  /** True only for `CANONICAL_SEED`. Selects the hand-verified shape instead
   *  of a rolled one — see `rnd`/`rollFrom` below. */
  readonly canonical: boolean;
  /** Next pseudo-random number in [0, 1), consumed in the same order the
   *  spike's calls would have consumed `Math.random()`/`srand()`. */
  readonly rng: () => number;
}

/**
 * The spike's LCG, byte-for-byte: `seed = (seed * 1103515245 + 12345) &
 * 0x7fffffff`. The multiply overflows a double's 53 bits of integer
 * precision, so this is not a textbook-correct LCG — some low-order bits are
 * already lost before the `&` truncates to 31. That imprecision is harmless
 * (determinism only requires "same seed, same stream", not mathematical
 * purity) and is preserved rather than "fixed", per the porting brief: this
 * is the exact arithmetic the browser spike ran, and IEEE-754 doubles behave
 * identically in every JS runtime this code ships to.
 */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function numericSeed(seed: StudioWorldSeed): number {
  if (typeof seed === "number") return Math.trunc(seed) & 0x7fffffff;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash & 0x7fffffff;
}

function makeCtx(seed: StudioWorldSeed): RollCtx {
  return { canonical: seed === CANONICAL_SEED, rng: makeRng(numericSeed(seed)) };
}

/**
 * `rnd`/`rollFrom` in the spike bypass randomness entirely in canonical mode
 * — they hand back the hardcoded value the level was hand-tuned around,
 * without touching `Math.random()`/`srand()` at all. Preserved exactly:
 * every OTHER random draw in a level's `make()` still runs in canonical
 * mode (so the RNG's call sequence for, say, the maze's shape or a
 * treasure shuffle is identical whether canonical or not) — only these two
 * helpers short-circuit.
 */
function rnd(ctx: RollCtx, lo: number, hi: number, canonical: number): number {
  return ctx.canonical ? canonical : lo + Math.floor(ctx.rng() * (hi - lo + 1));
}

/**
 * `rollFrom` exists so a re-roll can EXCLUDE the canonical size. `hallway`
 * and `stairs` both hand a starter that legitimately solves the canonical
 * world (that is their whole lesson — win, "change the world", watch it
 * die), so the dice landing back on that exact size would silently teach
 * the wrong thing: "see, hardcoding was fine." `list` therefore never
 * contains `canonical`, and this never draws it. This was a real bug the
 * spike caught during its own verification; the fix must survive the port
 * unchanged.
 */
function rollFrom<T>(ctx: RollCtx, list: readonly T[], canonical: T): T {
  return ctx.canonical ? canonical : list[Math.floor(ctx.rng() * list.length)];
}

function shuffle<T>(ctx: RollCtx, arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function blankWorld(): StudioWorld {
  return {
    walls: new Set<StudioCellKey>(),
    paint: new Map<StudioCellKey, StudioColor>(),
    start: { x: 0, y: 4, dir: 0 },
    goal: null,
    treasure: [],
    needCarry: null,
    free: false,
  };
}

/**
 * The path IS the world: every cell NOT in `cells` becomes a wall. A
 * corridor built this way is exactly one cell wide by construction, so a
 * wall-following program can never find a leak to cheat through — see the
 * "corridor is exactly one cell wide" structural test.
 */
function carve(w: StudioWorld, cells: ReadonlyArray<readonly [number, number]>): void {
  const open = new Set(cells.map(([x, y]) => cellKey(x, y)));
  for (let x = 0; x < STUDIO_GRID_SIZE; x++) {
    for (let y = 0; y < STUDIO_GRID_SIZE; y++) {
      if (!open.has(cellKey(x, y))) w.walls.add(cellKey(x, y));
    }
  }
}

/** Walks a list of arm lengths, turning after each one. `turn` is +1 for a
 *  right turn, -1 for left. Used by `spiral`, whose every corner turns the
 *  same way by construction (`turn` is fixed for the whole path) — the
 *  reason a single "turn this way when blocked" rule can solve it. */
function armPath(
  x0: number,
  y0: number,
  dir0: StudioDir,
  arms: readonly number[],
  turn: 1 | -1,
): Array<[number, number]> {
  let x = x0;
  let y = y0;
  let dir = dir0;
  const cells: Array<[number, number]> = [[x, y]];
  for (const len of arms) {
    for (let i = 0; i < len; i++) {
      x += DIRS[dir][0];
      y += DIRS[dir][1];
      cells.push([x, y]);
    }
    dir = ((dir + (turn > 0 ? 1 : 3)) % 4) as StudioDir;
  }
  return cells;
}

/**
 * A staircase: east 2, north 2, east 2, north 2, ... The corners ALTERNATE
 * direction, which is exactly why a single always-turn-one-way rule
 * (`elbows`'s given starter) cannot walk it, but sensing "can I go left?"
 * and falling back to right (`elbows`'s solution) can.
 */
function stairPath(x0: number, y0: number, n: number): Array<[number, number]> {
  let x = x0;
  let y = y0;
  const cells: Array<[number, number]> = [[x, y]];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 2; k++) {
      x += 1;
      cells.push([x, y]);
    }
    for (let k = 0; k < 2; k++) {
      y -= 1;
      cells.push([x, y]);
    }
  }
  return cells;
}

/**
 * A perfect maze on the 5x5 lattice of even cells, carved with a recursive
 * backtracker. "Perfect" means exactly one path between any two cells — no
 * loops — which is precisely the precondition that makes a left-hand
 * wall-following rule provably reach the exit: with no loop, following one
 * wall can never spiral around and miss a passage.
 */
function mazeWorld(w: StudioWorld, ctx: RollCtx): StudioWorld {
  for (let x = 0; x < STUDIO_GRID_SIZE; x++) {
    for (let y = 0; y < STUDIO_GRID_SIZE; y++) {
      w.walls.add(cellKey(x, y));
    }
  }
  const lattice = 5;
  const seen = new Set<string>(["0,0"]);
  const stack: Array<[number, number]> = [[0, 0]];
  w.walls.delete(cellKey(0, 0));
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const nbrs = DIRS.map(([dx, dy]) => [cx + dx, cy + dy] as [number, number]).filter(
      ([nx, ny]) => nx >= 0 && ny >= 0 && nx < lattice && ny < lattice && !seen.has(`${nx},${ny}`),
    );
    if (!nbrs.length) {
      stack.pop();
      continue;
    }
    const [nx, ny] = nbrs[Math.floor(ctx.rng() * nbrs.length)];
    seen.add(`${nx},${ny}`);
    w.walls.delete(cellKey(nx * 2, ny * 2)); // the lattice cell itself
    w.walls.delete(cellKey(cx + nx, cy + ny)); // the wall between the two lattice cells
    stack.push([nx, ny]);
  }
  w.start = { x: 0, y: 0, dir: 0 };
  w.goal = { x: 8, y: 8 };
  return w;
}

type RoadTurn = "r" | "l" | null;

const CANONICAL_ROAD_PLAN: ReadonlyArray<readonly [number, RoadTurn]> = [
  [3, "r"],
  [2, "l"],
  [3, "r"],
  [1, null],
];

/**
 * The painted road for `redroad`: no walls at all, so the only thing telling
 * the robot when to turn is the colour underfoot — `onColor()` is the ONLY
 * way through. Retries up to 400 random layouts (a plan that walks off the
 * grid or crosses its own earlier path is rejected), falling back to the
 * hand-picked canonical plan if none land — the same escape hatch the spike
 * used, so a pathological seed still yields a playable world.
 */
function rollRoad(ctx: RollCtx): ReadonlyArray<readonly [number, RoadTurn]> {
  for (let attempt = 0; attempt < 400; attempt++) {
    let x = 0;
    let y = 4;
    let dir: StudioDir = 0;
    let ok = true;
    const seenCells = new Set<string>([cellKey(0, 4)]);
    const plan: Array<[number, RoadTurn]> = [];
    const legs = 3 + Math.floor(ctx.rng() * 2);
    for (let i = 0; i < legs && ok; i++) {
      const len = 2 + Math.floor(ctx.rng() * 2);
      for (let k = 0; k < len; k++) {
        x += DIRS[dir][0];
        y += DIRS[dir][1];
        if (x < 0 || y < 0 || x >= STUDIO_GRID_SIZE || y >= STUDIO_GRID_SIZE || seenCells.has(cellKey(x, y))) {
          ok = false;
          break;
        }
        seenCells.add(cellKey(x, y));
      }
      if (!ok) break;
      const turn: RoadTurn = ctx.rng() < 0.5 ? "r" : "l";
      plan.push([len, turn]);
      dir = ((dir + (turn === "r" ? 1 : 3)) % 4) as StudioDir;
    }
    if (!ok) continue;
    const finalLen = 1 + Math.floor(ctx.rng() * 2);
    let fx = x;
    let fy = y;
    let fine = true;
    for (let k = 0; k < finalLen; k++) {
      fx += DIRS[dir][0];
      fy += DIRS[dir][1];
      if (fx < 0 || fy < 0 || fx >= STUDIO_GRID_SIZE || fy >= STUDIO_GRID_SIZE || seenCells.has(cellKey(fx, fy))) {
        fine = false;
        break;
      }
      seenCells.add(cellKey(fx, fy));
    }
    if (!fine) continue;
    plan.push([finalLen, null]);
    return plan;
  }
  return CANONICAL_ROAD_PLAN;
}

// ── The ladder ────────────────────────────────────────────────────────────

/** Builds one level's world for a given roll context. Keyed by `id` so
 *  `buildWorld` can find the right generator from just a `StudioLevel`
 *  object (whose public shape has no room for a builder function — see
 *  `defineLevel` below). */
const LEVEL_BUILDERS = new Map<string, (ctx: RollCtx) => StudioWorld>();

interface LevelSpec {
  id: string;
  title: string;
  mode: StudioLevel["mode"];
  rung: StudioRung;
  idea: string | null;
  hint: string;
  starter: string;
  build: (ctx: RollCtx) => StudioWorld;
}

/**
 * Wires a spec into a public `StudioLevel`. Every caller supplies the seed:
 * game sessions derive it from the server-issued launch seed, while direct
 * entry derives it from its own explicit session seed. World generation never
 * reaches for ambient randomness.
 */
function defineLevel(spec: LevelSpec): StudioLevel {
  const level: StudioLevel = {
    id: spec.id,
    title: spec.title,
    mode: spec.mode,
    rung: spec.rung,
    idea: spec.idea,
    hint: spec.hint,
    starter: spec.starter,
    make: (seed) => buildWorld(level, seed),
  };
  LEVEL_BUILDERS.set(spec.id, spec.build);
  return level;
}

export function deriveStudioWorldSeed(
  launchSeed: string,
  levelId: string,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("Studio world attempt must be a non-negative integer");
  }
  const material = `${launchSeed}\u0000${levelId}\u0000${attempt}`;
  const hash = (offset: number) => {
    let value = offset;
    for (let i = 0; i < material.length; i++) {
      value ^= material.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(16).padStart(8, "0");
  };
  return `studio:${hash(2166136261)}${hash(3339675911)}`;
}

export const STUDIO_LEVELS: readonly StudioLevel[] = [
  defineLevel({
    id: "go",
    title: "Go",
    mode: "puzzle",
    rung: 1,
    idea: "forward()",
    hint: "Drive onto the pad. <b>forward()</b> is one step.",
    starter: "forward()\n",
    build: (ctx) => {
      const w = blankWorld();
      const len = rnd(ctx, 2, 6, 3);
      w.start = { x: 1, y: 4, dir: 0 };
      w.goal = { x: 1 + len, y: 4 };
      return w;
    },
  }),
  defineLevel({
    id: "corner",
    title: "Corner",
    mode: "puzzle",
    rung: 1,
    idea: "left() / right()",
    hint: "The pad is around a corner. <b>left()</b> and <b>right()</b> turn the robot. Turning is not moving.",
    starter: "forward()\nforward()\nforward()\n",
    build: (ctx) => {
      const w = blankWorld();
      const across = rnd(ctx, 2, 5, 3);
      const up = rnd(ctx, 2, 5, 3);
      w.start = { x: 1, y: 7, dir: 0 };
      w.goal = { x: 1 + across, y: 7 - up };
      return w;
    },
  }),
  defineLevel({
    id: "hallway",
    title: "Hallway",
    mode: "puzzle",
    rung: 1,
    idea: "while (canGo())",
    hint:
      "Walls on both sides. Get to the end \u2014 then press <b>\ud83c\udfb2 Change the world</b> and run the <i>same</i> program again.",
    starter: "forward()\nforward()\nforward()\n",
    build: (ctx) => {
      const w = blankWorld();
      const len = rollFrom(ctx, [4, 5, 6, 7], 3);
      const cells: Array<[number, number]> = [];
      for (let i = 0; i <= len; i++) cells.push([i, 4]);
      carve(w, cells);
      w.start = { x: 0, y: 4, dir: 0 };
      w.goal = { x: len, y: 4 };
      return w;
    },
  }),
  defineLevel({
    id: "pickup",
    title: "Pickup",
    mode: "puzzle",
    rung: 2,
    idea: "onTreasure() / take()",
    hint:
      "Same hallway, but there is stuff on the floor. <b>onTreasure()</b> is true when you are standing on some; <b>take()</b> picks it up.",
    starter: "while (canGo()) {\n  forward()\n}\n",
    build: (ctx) => {
      const w = blankWorld();
      const len = rnd(ctx, 4, 7, 5);
      const cells: Array<[number, number]> = [];
      for (let i = 0; i <= len; i++) cells.push([i, 4]);
      carve(w, cells);
      w.start = { x: 0, y: 4, dir: 0 };
      w.goal = { x: len, y: 4 };
      for (let i = 1; i < len; i++) {
        // The spike drew this straight from Math.random() even in its
        // canonical branch's *shape* of the check (`i % 2 === 1` replaces it
        // outright there); only the re-roll branch actually consumed
        // randomness. Ported onto the shared ctx.rng() so a re-roll's
        // treasure layout is reproducible by seed like everything else.
        const put = ctx.canonical ? i % 2 === 1 : ctx.rng() < 0.55;
        if (put) w.treasure.push({ x: i, y: 4 });
      }
      if (!w.treasure.length) w.treasure.push({ x: 1, y: 4 });
      return w;
    },
  }),
  defineLevel({
    id: "count",
    title: "Count",
    mode: "puzzle",
    rung: 2,
    idea: "carrying() < 3",
    hint:
      "Take exactly <b>three</b> \u2014 no more. <b>carrying()</b> is how many you are holding. There is no pad here: stop yourself.",
    starter: "while (canGo()) {\n  forward()\n  if (onTreasure()) {\n    take()\n  }\n}\n",
    build: (ctx) => {
      const w = blankWorld();
      const cells: Array<[number, number]> = [];
      for (let i = 0; i <= 8; i++) cells.push([i, 4]);
      carve(w, cells);
      w.start = { x: 0, y: 4, dir: 0 };
      w.goal = null;
      w.needCarry = 3;
      const spots = [1, 2, 3, 4, 5, 6, 7, 8];
      const chosen = ctx.canonical
        ? [1, 2, 4, 5, 7]
        : shuffle(ctx, spots).slice(0, 5).sort((a, b) => a - b);
      for (const i of chosen) w.treasure.push({ x: i, y: 4 });
      return w;
    },
  }),
  defineLevel({
    id: "spiral",
    title: "Spiral",
    mode: "puzzle",
    rung: 2,
    idea: "wallAhead() / !atGoal()",
    hint:
      'A corridor that keeps turning the same way. <b>wallAhead()</b> is true when the next step is blocked. <b>!</b> means <i>not</i>, so <b>while (!atGoal())</b> is "keep going until you are home".',
    starter: "while (canGo()) {\n  forward()\n}\n",
    build: (ctx) => {
      const w = blankWorld();
      const arms = [8, 8, 6, 6, 4, 4, 2, 2].slice(0, rnd(ctx, 4, 8, 8));
      const cells = armPath(0, 0, 0, arms, 1);
      carve(w, cells);
      w.start = { x: 0, y: 0, dir: 0 };
      const last = cells[cells.length - 1];
      w.goal = { x: last[0], y: last[1] };
      return w;
    },
  }),
  defineLevel({
    id: "redroad",
    title: "Red road",
    mode: "puzzle",
    rung: 2,
    idea: 'onColor("red")',
    hint:
      'No walls at all \u2014 a painted road instead. <b>onColor(red)</b> is true when the floor under you is red. Red turns right, blue turns left.',
    starter: "while (!atGoal()) {\n  forward()\n}\n",
    build: (ctx) => {
      const w = blankWorld();
      w.start = { x: 0, y: 4, dir: 0 };
      const plan = ctx.canonical ? CANONICAL_ROAD_PLAN : rollRoad(ctx);
      let x = 0;
      let y = 4;
      let dir: StudioDir = 0;
      for (const [len, turn] of plan) {
        x += DIRS[dir][0] * len;
        y += DIRS[dir][1] * len;
        if (turn) {
          // The spike painted with raw hex (its COLORS object maps bare
          // identifiers like `red` to hex strings). StudioWorld.paint is
          // typed as StudioColor — one of the 10 predeclared words — so the
          // port paints with the word itself rather than a hex code. Same
          // signal (`onColor("red")`), contract-legal value.
          w.paint.set(cellKey(x, y), turn === "r" ? "red" : "blue");
          dir = ((dir + (turn === "r" ? 1 : 3)) % 4) as StudioDir;
        }
      }
      w.goal = { x, y };
      return w;
    },
  }),
  defineLevel({
    id: "elbows",
    title: "Elbows",
    mode: "puzzle",
    rung: 3,
    idea: "canGoLeft(), else",
    hint:
      'A staircase. The corners do <i>not</i> all turn the same way. <b>canGoLeft()</b> and <b>canGoRight()</b> look sideways without turning \u2014 and <b>else</b> is what to do when the first thing was false.',
    starter: "while (!atGoal()) {\n  if (wallAhead()) {\n    right()\n  }\n  forward()\n}\n",
    build: (ctx) => {
      const w = blankWorld();
      const n = rnd(ctx, 2, 4, 4);
      const cells = stairPath(0, 8, n);
      carve(w, cells);
      w.start = { x: 0, y: 8, dir: 0 };
      const last = cells[cells.length - 1];
      w.goal = { x: last[0], y: last[1] };
      return w;
    },
  }),
  defineLevel({
    id: "stairs",
    title: "Stairs",
    mode: "puzzle",
    rung: 3,
    idea: "function",
    hint:
      "You are about to type the same four lines over and over. Give them a <b>name</b> instead \u2014 that is all <b>function</b> is.",
    starter:
      "forward()\nleft()\nforward()\nright()\nforward()\nleft()\nforward()\nright()\nforward()\nleft()\nforward()\nright()\n",
    build: (ctx) => {
      const w = blankWorld();
      const n = rollFrom(ctx, [2, 4, 5, 6], 3);
      w.start = { x: 1, y: 7, dir: 0 };
      w.goal = { x: 1 + n, y: 7 - n };
      return w;
    },
  }),
  defineLevel({
    id: "maze",
    title: "Maze",
    mode: "puzzle",
    rung: 3,
    idea: "the left-hand rule",
    hint:
      "A real maze, different every time. One rule solves <i>every</i> maze: keep your left hand on the wall. Say that in code.",
    starter:
      "while (!atGoal()) {\n  if (wallAhead()) {\n    if (canGoLeft()) {\n      left()\n    } else {\n      right()\n    }\n  }\n  forward()\n}\n",
    build: (ctx) => mazeWorld(blankWorld(), ctx),
  }),
  defineLevel({
    id: "pen",
    title: "Pen",
    mode: "art",
    rung: 3,
    idea: "free drawing",
    hint: "No walls, no pad, nothing to win. The robot has a pen. Same words you already know.",
    // `coral` is deliberately not one of STUDIO_COLORS' ten words. That list is
    // what we TEACH; `studio/src/palette.ts` resolves a wider set, so a colour
    // a scholar guesses at works instead of erroring. Opening on `coral` shows
    // that the ten are a floor, not a fence. Do not "correct" this to `red`.
    starter: "penDown()\ncolor(coral)\n\nfor (let side of count(4)) {\n  forward()\n  forward()\n  forward()\n  right()\n}\n",
    build: () => {
      const w = blankWorld();
      w.start = { x: 2, y: 6, dir: 3 };
      w.free = true;
      return w;
    },
  }),
];

export function levelById(id: string): StudioLevel | undefined {
  return STUDIO_LEVELS.find((level) => level.id === id);
}

/**
 * The deterministic primitive the spike's own `build(i)` was: reset the RNG
 * to a known seed, then run the level's generator. Defaulting `seed` to
 * `CANONICAL_SEED` reproduces exactly the hand-verified world every level's
 * `starter` was written against; any other seed reproduces exactly that
 * seed's world, every time — the property "the teacher and the kid are
 * looking at the same maze" (and this whole test suite) depends on.
 */
export function buildWorld(
  level: StudioLevel,
  seed: StudioWorldSeed = CANONICAL_SEED,
): StudioWorld {
  const build = LEVEL_BUILDERS.get(level.id);
  if (!build) {
    throw new Error(`buildWorld: unknown level id "${level.id}"`);
  }
  return build(makeCtx(seed));
}

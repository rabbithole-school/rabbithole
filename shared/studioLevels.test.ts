import { describe, expect, it } from "vitest";

import { cellKey, STUDIO_COLORS, STUDIO_VOCABULARY, type StudioDir, type StudioWorld } from "./studioContract";
import { buildWorld, CANONICAL_SEED, levelById, STUDIO_GRID_SIZE, STUDIO_LEVELS } from "./studioLevels";

// ─────────────────────────────────────────────────────────────────────────
// This suite replicates the browser spike's own verification harness (see
// review/coding-elective/spike-7-robot.html, "running the program"): run
// every level's starter and every level's intended solution against a real
// world and check the win condition, not just that the world SHAPE looks
// right. The runner below is a deliberately test-only re-implementation of
// the spike's `execute()` — it is NOT exported, because the real runtime
// (the sandbox that actually executes a scholar's program) lives elsewhere
// and is not this port's job.
//
// One trap from the spike is load-bearing here too: every predicate below is
// an ARROW function closing over x/y/dir, never an object method. `new
// Function(...)` spreads the scope into plain parameters, so `this` is
// undefined inside them — a method reading `this.x` would silently break
// every predicate at once.
// ─────────────────────────────────────────────────────────────────────────

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

const count = (n: number): number[] => Array.from({ length: Math.max(0, Math.floor(n)) }, (_, i) => i);

// The spike's colours are bare identifiers bound to hex strings; the port's
// StudioColor is bare identifiers bound to the WORD itself (paint stores
// "red", not a hex code — see studioLevels.ts's redroad comment), so binding
// `red -> "red"` is what makes `onColor(red)` and the world's stored paint
// value compare equal. `coral` is not a StudioColor at all; it's bound here
// only because the ported `pen` starter references it verbatim (see the
// discrepancy noted on that level in studioLevels.ts) and a program that
// references an unbound name should fail with a ReferenceError, not by
// accident of a missing test fixture.
const COLOR_BINDINGS: Record<string, string> = Object.fromEntries(STUDIO_COLORS.map((c) => [c, c]));
COLOR_BINDINGS.coral = "coral";

class Halt extends Error {}

interface RunResult {
  won: boolean;
  /** null when the run didn't throw. */
  error: string | null;
  atGoal: boolean;
  /** Treasure remaining, i.e. NOT taken. */
  left: number;
  carried: number;
  x: number;
  y: number;
  dir: StudioDir;
}

/** Runs `source` against `world` and reports how it ended, mirroring the
 *  spike's `execute()`: forward/left/right/take can throw (a wall, the
 *  edge, or take() on empty ground); every OTHER error (a real bug in a
 *  program) is caught the same way, because a scholar's typo must never
 *  crash the app — it must just lose. A step budget stands in for the
 *  spike's per-line `budget`, guarding against a genuinely infinite loop
 *  without needing line-by-line instrumentation. */
function runProgram(world: StudioWorld, source: string): RunResult {
  let x = world.start.x;
  let y = world.start.y;
  let dir: StudioDir = world.start.dir;
  const taken: number[] = [];
  let budget = 20_000;

  const inside = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < STUDIO_GRID_SIZE && cy < STUDIO_GRID_SIZE;
  const open = (cx: number, cy: number) => inside(cx, cy) && !world.walls.has(cellKey(cx, cy));
  const clear = (d: number) => open(x + DIRS[d][0], y + DIRS[d][1]);
  const treasureHere = () => world.treasure.findIndex((g, j) => g.x === x && g.y === y && !taken.includes(j));

  const tick = () => {
    if (--budget <= 0) throw new Halt("This program never stopped.");
  };

  const api = {
    forward: () => {
      tick();
      const [dx, dy] = DIRS[dir];
      const nx = x + dx;
      const ny = y + dy;
      if (!open(nx, ny)) {
        throw new Halt(inside(nx, ny) ? "The robot walked into a wall." : "The robot walked off the edge of the world.");
      }
      x = nx;
      y = ny;
    },
    left: () => {
      tick();
      dir = ((dir + 3) % 4) as StudioDir;
    },
    right: () => {
      tick();
      dir = ((dir + 1) % 4) as StudioDir;
    },
    canGo: () => {
      tick();
      return clear(dir);
    },
    canGoLeft: () => {
      tick();
      return clear((dir + 3) % 4);
    },
    canGoRight: () => {
      tick();
      return clear((dir + 1) % 4);
    },
    // Deliberately the same signal as !canGo(), said the other way round —
    // ported unchanged from the spike, which keeps both on purpose (a
    // beginner reaches for the positive sentence first).
    wallAhead: () => {
      tick();
      return !clear(dir);
    },
    onTreasure: () => {
      tick();
      return treasureHere() >= 0;
    },
    carrying: () => {
      tick();
      return taken.length;
    },
    atGoal: () => {
      tick();
      return !!world.goal && world.goal.x === x && world.goal.y === y;
    },
    onColor: (v: string) => {
      tick();
      return world.paint.get(cellKey(x, y)) === v;
    },
    take: () => {
      tick();
      const i = treasureHere();
      if (i < 0) throw new Halt("take() but there is nothing here to take.");
      taken.push(i);
    },
    penDown: () => tick(),
    penUp: () => tick(),
    color: (_v: string) => tick(),
    count,
    ...COLOR_BINDINGS,
  };

  let error: string | null = null;
  try {
    const fn = new Function(...Object.keys(api), `"use strict";\n${source}`);
    fn(...Object.values(api));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const left = world.treasure.length - taken.length;
  const atGoal = world.goal ? world.goal.x === x && world.goal.y === y : true;
  let won: boolean;
  if (world.free) won = error === null; // the pen: nothing to win but not erroring
  else if (world.needCarry != null) won = error === null && taken.length === world.needCarry;
  else won = error === null && atGoal && left === 0;

  return { won, error, atGoal, left, carried: taken.length, x, y, dir };
}

// ─────────────────────────────────────────────────────────────────────────
// The 11 intended solutions. Derived from each level's `idea` (see the
// ladder table in the porting brief), then verified by actually running
// them below — these are not transcribed from the spike, which never wrote
// them down as code (only as a hint sentence and a starter for the NEXT
// level).
// ─────────────────────────────────────────────────────────────────────────

const SOLUTIONS: Readonly<Record<string, string>> = {
  go: "while (!atGoal()) {\n  forward()\n}\n",

  // Not general — see "12/12 re-roll robustness" below for why `corner` is
  // deliberately excluded from that assertion. The goal is an independent
  // (across, up) pair and the vocabulary this rung teaches has no landmark
  // that senses "have I gone far enough": no predicate here can tell x=3
  // from x=4. So the only solution rung 1's words can express is the
  // canonical numbers, hardcoded — which is exactly what the level asks a
  // scholar to notice and complain about, before rung 1 hands them `while`.
  corner: "forward()\nforward()\nforward()\nleft()\nforward()\nforward()\nforward()\n",

  hallway: "while (canGo()) {\n  forward()\n}\n",

  pickup: "while (canGo()) {\n  forward()\n  if (onTreasure()) {\n    take()\n  }\n}\n",

  // No pad on this level — winning is "stop at exactly 3", not "get
  // somewhere". `carrying() < 3` in the loop guard is the whole idea: the
  // loop condition is re-checked BEFORE every further move, so the moment
  // the 3rd item is taken, the walk stops without needing to know in
  // advance where the treasures are.
  count: "while (canGo() && carrying() < 3) {\n  forward()\n  if (onTreasure()) {\n    take()\n  }\n}\n",

  // Every corner of this corridor turns the SAME way by construction
  // (armPath's `turn` is fixed for the whole path), so "turn right when
  // blocked" is the entire rule — unlike elbows, one turn direction is
  // always enough here.
  spiral: "while (!atGoal()) {\n  if (wallAhead()) {\n    right()\n  }\n  forward()\n}\n",

  // The road paints the CURRENT cell before the robot is meant to turn off
  // it, so the check happens before forward(), not after.
  redroad: "while (!atGoal()) {\n  if (onColor(red)) {\n    right()\n  } else if (onColor(blue)) {\n    left()\n  }\n  forward()\n}\n",

  // The staircase alternates which way is open at each corner, so a single
  // fallback direction (the starter's always-right rule) is wrong half the
  // time. Sensing left first and falling back to right is enough because
  // this shape never branches three ways.
  elbows:
    "while (!atGoal()) {\n  if (wallAhead()) {\n    if (canGoLeft()) {\n      left()\n    } else {\n      right()\n    }\n  }\n  forward()\n}\n",

  // across === up always (the goal is always on the diagonal), so a single
  // named 4-line zigzag repeated with `while` generalizes to every n — the
  // whole point of rung 3's `function` idea is that this stops being 12
  // lines of copy-paste and becomes 1 loop around a name.
  stairs: "function step() {\n  forward()\n  left()\n  forward()\n  right()\n}\nwhile (!atGoal()) {\n  step()\n}\n",

  // The classic left-hand rule: prefer left, else straight, else right,
  // else you're at a dead end — turn around. The elbows starter (this
  // level's given starter) has only the middle two branches and no
  // dead-end/180° case, which is exactly why it cannot solve a maze with
  // real branches and dead ends, even though it solves elbows' own
  // two-choices-per-corner staircase fine.
  maze:
    "while (!atGoal()) {\n  if (canGoLeft()) {\n    left()\n    forward()\n  } else if (canGo()) {\n    forward()\n  } else if (canGoRight()) {\n    right()\n    forward()\n  } else {\n    right()\n    right()\n  }\n}\n",

  // Free mode: nothing to win but not erroring, so any legal drawing
  // program is "the" solution. Reuses the starter's own square (proven to
  // stay in-bounds from (2,6) facing north) with a real StudioColor instead
  // of the ported starter's out-of-vocabulary `coral`.
  pen: "penDown()\ncolor(red)\n\nfor (let side of count(4)) {\n  forward()\n  forward()\n  forward()\n  right()\n}\n",
};

// A test-only replica of the sandbox's autoDeclare() (studio/src/runtime.ts):
// the idle-reformat pass that inserts a missing `let` before a `for (x of
// ...)` loop variable or a first bare assignment. It exists so a scholar who
// forgets `let` still gets a working program instead of a silent stray
// global — but when it rewrites a level's STARTER, the level opens and
// immediately flashes "we changed your code" about a program the scholar
// never wrote. So every starter (and every intended solution above) must
// already be a fixed point of this transform: `autoDeclare(src) === src`.
// This is a second, independent port of the same small algorithm rather than
// an import of the real one, for the same reason `runProgram` above is not
// an import of the real `execute()` — the real runtime lives in studio/,
// this suite's job is to pin an invariant on shared/'s data, not to take a
// dependency on another module's in-flight code.
const AUTO_DECLARE_KNOWN = new Set<string>([
  ...STUDIO_VOCABULARY,
  ...STUDIO_COLORS,
  // Ported verbatim from the prototype's `pen` starter (see its vocabulary-
  // mismatch note in studioLevels.ts). These are read as CALLS, never as a
  // for-of loop variable or an assignment target, so whether they're
  // "known" makes no difference to this specific check — listed anyway so
  // this known-set matches the real runtime's PREDECLARED list in spirit.
  "penDown",
  "penUp",
  "count",
  "coral",
]);

function autoDeclare(src: string): string {
  const known = new Set(AUTO_DECLARE_KNOWN);
  const declRe = /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g;
  let decl: RegExpExecArray | null;
  while ((decl = declRe.exec(src))) known.add(decl[1]);
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  let fn: RegExpExecArray | null;
  while ((fn = fnRe.exec(src))) known.add(fn[1]);

  return src
    .split("\n")
    .map((line) => {
      // for (x of ...)  ->  for (let x of ...), unless x is already declared.
      const forOf = line.match(/^(\s*for\s*\(\s*)([A-Za-z_$][\w$]*)(\s+of\s)/);
      if (forOf && !/\b(?:let|const|var)\s*$/.test(forOf[1])) {
        if (!known.has(forOf[2])) known.add(forOf[2]);
        return line.replace(/^(\s*for\s*\(\s*)/, "$1let ");
      }
      // x = ...  ->  let x = ..., only the first time the name is seen.
      const assign = line.match(/^(\s*)([A-Za-z_$][\w$]*)(\s*=(?!=))/);
      if (assign && !known.has(assign[2])) {
        known.add(assign[2]);
        return assign[1] + "let " + line.trim();
      }
      return line;
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────

describe("structural invariants", () => {
  it("has the 11 expected ids, stable and in ladder order", () => {
    expect(STUDIO_LEVELS.map((level) => level.id)).toEqual([
      "go",
      "corner",
      "hallway",
      "pickup",
      "count",
      "spiral",
      "redroad",
      "elbows",
      "stairs",
      "maze",
      "pen",
    ]);
  });

  it("ids are unique", () => {
    const ids = STUDIO_LEVELS.map((level) => level.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rungs are non-decreasing through the array (the rungs ARE the elective's 3 sessions, in order)", () => {
    const rungs = STUDIO_LEVELS.map((level) => level.rung);
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i]).toBeGreaterThanOrEqual(rungs[i - 1]);
    }
  });

  it("every level has a make(seed) that returns a fresh, valid world", () => {
    for (const level of STUDIO_LEVELS) {
      const world = level.make(CANONICAL_SEED);
      expect(world.start).toBeDefined();
      expect(typeof world.free).toBe("boolean");
    }
  });
});

describe("every starter is already canonical (survives the sandbox's idle autoDeclare unchanged)", () => {
  // A level that opens and immediately rewrites itself is the machine talking
  // to itself: the reformat message is supposed to explain a scholar's OWN
  // missing `let`, not a starter authored that way. So `starter` must be a
  // fixed point of autoDeclare, not merely runnable after one silent pass.
  for (const level of STUDIO_LEVELS) {
    it(`${level.id}: starter is unchanged by autoDeclare and parses`, () => {
      expect(autoDeclare(level.starter)).toBe(level.starter);
      expect(() => new Function(level.starter)).not.toThrow();
    });
  }
});

describe("every intended solution is already canonical too", () => {
  // Same rule for the reference programs this suite runs — a solution that
  // needed autoDeclare's help would mean the SOLUTIONS map itself isn't
  // written the way a starter (or a scholar) is required to be.
  for (const [id, program] of Object.entries(SOLUTIONS)) {
    it(`${id}: solution is unchanged by autoDeclare and parses`, () => {
      expect(autoDeclare(program)).toBe(program);
      expect(() => new Function(program)).not.toThrow();
    });
  }
});

describe("determinism: the same seed reproduces an identical world", () => {
  function serialize(world: StudioWorld) {
    return {
      walls: Array.from(world.walls).sort(),
      paint: Array.from(world.paint.entries()).sort(),
      start: world.start,
      goal: world.goal,
      treasure: world.treasure,
      needCarry: world.needCarry,
      free: world.free,
    };
  }

  for (const level of STUDIO_LEVELS) {
    it(`${level.id}: buildWorld(level, seed) called twice with the same seed matches`, () => {
      expect(serialize(buildWorld(level, 555))).toEqual(serialize(buildWorld(level, 555)));
      // And the canonical (default) seed is just as deterministic.
      expect(serialize(buildWorld(level))).toEqual(serialize(buildWorld(level)));
    });
  }

  it("different seeds produce different generated worlds", () => {
    const maze = levelById("maze")!;
    expect(serialize(buildWorld(maze, "world-a"))).not.toEqual(
      serialize(buildWorld(maze, "world-b")),
    );
  });
});

describe("every level's intended solution wins on the canonical world", () => {
  for (const level of STUDIO_LEVELS) {
    it(level.id, () => {
      const result = runProgram(buildWorld(level), SOLUTIONS[level.id]);
      expect(result.error).toBeNull();
      expect(result.won).toBe(true);
    });
  }
});

describe("every starter fails exactly as the ladder table says (canonical world)", () => {
  it("go: stops short of the pad", () => {
    const r = runProgram(buildWorld(levelById("go")!), levelById("go")!.starter);
    expect(r.won).toBe(false);
    expect(r.error).toBeNull();
    expect(r.atGoal).toBe(false);
  });

  it("corner: walks past the corner (never turns, so never reaches the pad)", () => {
    const r = runProgram(buildWorld(levelById("corner")!), levelById("corner")!.starter);
    expect(r.won).toBe(false);
    expect(r.error).toBeNull();
    expect(r.atGoal).toBe(false);
  });

  it("hallway: WINS on the canonical world (that's the whole trap)", () => {
    const r = runProgram(buildWorld(levelById("hallway")!), levelById("hallway")!.starter);
    expect(r.won).toBe(true);
  });

  it("pickup: reaches the pad but leaves the treasure", () => {
    const r = runProgram(buildWorld(levelById("pickup")!), levelById("pickup")!.starter);
    expect(r.won).toBe(false);
    expect(r.error).toBeNull();
    expect(r.atGoal).toBe(true);
    expect(r.left).toBeGreaterThan(0);
  });

  it("count: takes all 5 when 3 were needed", () => {
    const r = runProgram(buildWorld(levelById("count")!), levelById("count")!.starter);
    expect(r.won).toBe(false);
    expect(r.error).toBeNull();
    expect(r.carried).toBe(5);
  });

  it("spiral: stops at the first corner", () => {
    const r = runProgram(buildWorld(levelById("spiral")!), levelById("spiral")!.starter);
    expect(r.won).toBe(false);
    expect(r.error).toBeNull();
    expect(r.atGoal).toBe(false);
  });

  it("redroad: walks off the edge (no colour-sensing, no turning)", () => {
    const r = runProgram(buildWorld(levelById("redroad")!), levelById("redroad")!.starter);
    expect(r.won).toBe(false);
    expect(r.error).not.toBeNull();
  });

  it("elbows: the right-only rule turns the wrong way and walks off", () => {
    const r = runProgram(buildWorld(levelById("elbows")!), levelById("elbows")!.starter);
    expect(r.won).toBe(false);
    expect(r.error).not.toBeNull();
  });

  it("stairs: WINS canonically at 12 hardcoded lines (the second flagship trap)", () => {
    const r = runProgram(buildWorld(levelById("stairs")!), levelById("stairs")!.starter);
    expect(r.won).toBe(true);
  });

  it("maze: the elbows rule (no dead-end handling) fails to solve a real branching maze", () => {
    const r = runProgram(buildWorld(levelById("maze")!), levelById("maze")!.starter);
    expect(r.won).toBe(false);
  });

  it("pen: the starter's square wins trivially (free mode: nothing to win but not erroring)", () => {
    const r = runProgram(buildWorld(levelById("pen")!), levelById("pen")!.starter);
    expect(r.won).toBe(true);
  });
});

describe("re-roll robustness: every general solution survives 12 different seeds, 12/12", () => {
  // `corner` is the one level whose solution is NOT general (see the comment
  // on SOLUTIONS.corner) and is deliberately excluded here — asserting
  // 12/12 for it would be asserting something false about the level design,
  // not verifying the port.
  const GENERAL_LEVEL_IDS = ["go", "hallway", "pickup", "count", "spiral", "redroad", "elbows", "stairs", "maze", "pen"];
  // A large prime step keeps the 12 seeds from landing in a periodic
  // pattern of the LCG (a small fixed step like +1 correlates too strongly
  // with the multiplier below to sample the level's re-roll space well).
  const SEEDS = Array.from({ length: 12 }, (_, i) => 1 + i * 104_729);

  for (const id of GENERAL_LEVEL_IDS) {
    it(`${id}: solution wins on all 12 re-rolled seeds`, () => {
      const level = levelById(id)!;
      const wins = SEEDS.filter((seed) => runProgram(buildWorld(level, seed), SOLUTIONS[id]).won).length;
      expect(wins).toBe(SEEDS.length);
    });
  }

  it("corner: the hardcoded solution still wins on the canonical world (sanity check for the exclusion above)", () => {
    const level = levelById("corner")!;
    expect(runProgram(buildWorld(level), SOLUTIONS.corner).won).toBe(true);
  });
});

describe("hardcoded starters die on re-roll: 0/20 survival (the rollFrom guarantee)", () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => 3 + i * 104_729);

  for (const id of ["hallway", "stairs"]) {
    it(`${id}: starter never wins on 20 different re-rolled seeds`, () => {
      const level = levelById(id)!;
      const survivals = SEEDS.filter((seed) => runProgram(buildWorld(level, seed), level.starter).won).length;
      expect(survivals).toBe(0);
    });
  }

  it("none of the 20 re-roll seeds accidentally lands back on the canonical size (rollFrom's exclusion, directly)", () => {
    // hallway's canonical length is 3, drawn from rollFrom([4,5,6,7], 3) —
    // the list itself never contains 3, so this can never happen; this
    // pins that invariant against the actual re-rolled worlds rather than
    // just trusting the list literal.
    const hallway = levelById("hallway")!;
    for (const seed of SEEDS) {
      const world = buildWorld(hallway, seed);
      expect(world.goal!.x).not.toBe(3);
    }
    // stairs' canonical n is 3 (goal at (4,4)), drawn from rollFrom([2,4,5,6], 3).
    const stairs = levelById("stairs")!;
    for (const seed of SEEDS) {
      const world = buildWorld(stairs, seed);
      expect(world.goal).not.toEqual({ x: 4, y: 4 });
    }
  });
});

describe("carved corridors are exactly one cell wide", () => {
  function openNeighborCount(world: StudioWorld, x: number, y: number): number {
    return DIRS.filter(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return (
        nx >= 0 &&
        ny >= 0 &&
        nx < STUDIO_GRID_SIZE &&
        ny < STUDIO_GRID_SIZE &&
        !world.walls.has(cellKey(nx, ny))
      );
    }).length;
  }

  function assertOneCellWide(world: StudioWorld) {
    let deadEnds = 0;
    for (let x = 0; x < STUDIO_GRID_SIZE; x++) {
      for (let y = 0; y < STUDIO_GRID_SIZE; y++) {
        if (world.walls.has(cellKey(x, y))) continue;
        const degree = openNeighborCount(world, x, y);
        // A branch/junction (degree 3+) would be a leak a wall-follower
        // could cheat through — carve()'s whole guarantee is that this
        // never happens.
        expect(degree).toBeLessThanOrEqual(2);
        if (degree <= 1) deadEnds++;
      }
    }
    // A single corridor has exactly two ends: the start and the far end
    // (goal or last spiral/staircase cell).
    expect(deadEnds).toBe(2);
  }

  for (const id of ["hallway", "pickup", "count", "spiral", "elbows"]) {
    it(`${id}: no cell has more than 2 open neighbors; exactly 2 dead ends`, () => {
      const level = levelById(id)!;
      assertOneCellWide(buildWorld(level));
      for (const seed of [11, 22, 33]) {
        assertOneCellWide(buildWorld(level, seed));
      }
    });
  }
});

describe("maze: the carved lattice is a perfect maze (a spanning tree — no loops)", () => {
  const LATTICE = 5;

  for (const seed of [CANONICAL_SEED, 101, 202, 303]) {
    it(`seed ${seed}: exactly 24 edges connect the 25 lattice cells, and all 25 are reachable`, () => {
      const world = buildWorld(levelById("maze")!, seed);

      let edges = 0;
      const adjacency = new Map<string, string[]>();
      const addEdge = (a: string, b: string) => {
        adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
        adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
      };

      for (let latX = 0; latX < LATTICE; latX++) {
        for (let latY = 0; latY < LATTICE; latY++) {
          // Only the two "forward" directions (east, south), so each edge
          // between a pair of lattice cells is counted exactly once.
          for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
            const nLatX = latX + dx;
            const nLatY = latY + dy;
            if (nLatX >= LATTICE || nLatY >= LATTICE) continue;
            const corridorCell = cellKey(latX * 2 + dx, latY * 2 + dy);
            if (!world.walls.has(corridorCell)) {
              edges++;
              addEdge(`${latX},${latY}`, `${nLatX},${nLatY}`);
            }
          }
        }
      }

      // A tree on 25 nodes has exactly 24 edges. More would mean a loop
      // (the left-hand rule is only provably correct on a loop-free maze);
      // fewer would mean the maze is disconnected.
      expect(edges).toBe(LATTICE * LATTICE - 1);

      const seen = new Set<string>(["0,0"]);
      const queue = ["0,0"];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const next of adjacency.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.size).toBe(LATTICE * LATTICE);
    });
  }
});

/**
 * The runtime — the scholar's program, executed against a world.
 *
 * Ported from the browser-verified prototype (`review/coding-elective/
 * spike-7-robot.html`). Three properties are load-bearing and easy to break:
 *
 * 1. **It records, it does not animate.** `execute()` runs to completion and
 *    returns a list of frames. Playback and scrubbing then walk that list. This
 *    is why the scrubber can exist at all, and why a program that loops forever
 *    still ENDS instead of hanging the tab.
 * 2. **Every command is a closure, never a method.** The scope object is spread
 *    into `new Function(...)` parameters, so `this` is `undefined` inside. A
 *    method reading `this.x` would silently read nothing.
 * 3. **Winning is the WORLD's judgement, not the program's.** We do not compare
 *    against an expected program. A kid who reaches the pad by a route nobody
 *    thought of has solved it, and the surface says so.
 */
import type {
  StudioDir,
  StudioWorld,
} from "../../shared/studioContract";
import { cellKey, STUDIO_VOCABULARY } from "../../shared/studioContract";
import { HEX, colorOf } from "./palette";

/** Cells per side. Levels are generated against this, so it is shared truth. */
export const GRID = 9;

/** Canvas units per cell. The canvas is a fixed 720 square, scaled by CSS. */
export const CELL = 720 / GRID;

export const PAPER = 720;

/** East, south, west, north — matching `StudioDir`, with `y` growing downward. */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * A run that ended on purpose: a wall, an empty hand, a forever-loop. Carries
 * the line so the editor can point at it. Distinct from a JavaScript error so
 * the two can be phrased differently — one is the robot's problem, the other is
 * the program's.
 */
export class Halt extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "Halt";
    this.line = line;
  }
}

/** One recorded moment. `trailLen` lets playback replay the pen incrementally. */
export interface Frame {
  line: number;
  x: number;
  y: number;
  dir: StudioDir;
  note: string;
  trailLen: number;
  taken: number[];
}

export interface Stroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  c: string;
}

export interface Recording {
  frames: Frame[];
  trail: Stroke[];
  error: Halt | null;
  won: boolean;
  left: number;
  atGoal: boolean;
  carried: number;
  /** True when the recording was cut short by the frame cap, not by the program. */
  truncated: boolean;
}

/**
 * The words the runtime hands the program, so an unknown name can be reported
 * as "you haven't taught the robot that yet" instead of a raw ReferenceError.
 *
 * The robot half comes from the contract — one canonical list, so the friendly
 * message can never fire on a word that actually works. The rest are JS's own
 * names, which are in scope whether we list them or not.
 */
const PREDECLARED = [
  ...STUDIO_VOCABULARY,
  "Math", "console", "true", "false", "null", "undefined",
];

/**
 * `let` is taught, not hidden — declaring a name is a real idea and skipping it
 * would leave a hole. But a forgotten `let` in sloppy mode creates a global that
 * outlives the line that made it, which produces a bug with no visible cause.
 * So we repair it, and the caller announces the repair by writing `let` into the
 * buffer where the scholar can see it. Forgiving at runtime, honest on screen.
 */
export function autoDeclare(src: string, born?: string[]): string {
  const known = new Set<string>([...PREDECLARED, ...Object.keys(HEX)]);

  // A name declared anywhere counts as known everywhere, so a `let` further
  // down the file does not make an earlier assignment look like a new name.
  const declRe = /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) known.add(m[1]);
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  while ((m = fnRe.exec(src))) known.add(m[1]);

  return src
    .split("\n")
    .map((line) => {
      // for (x of ...)  ->  for (let x of ...)
      const f = line.match(/^(\s*for\s*\(\s*)([A-Za-z_$][\w$]*)(\s+of\s)/);
      if (f && !/\b(let|const|var)\s*$/.test(f[1])) {
        if (!known.has(f[2])) {
          known.add(f[2]);
          born?.push(f[2]);
        }
        return line.replace(/^(\s*for\s*\(\s*)/, "$1let ");
      }
      // x = ...  ->  let x = ...   (only the first time the name is seen)
      const a = line.match(/^(\s*)([A-Za-z_$][\w$]*)(\s*=(?!=))/);
      if (a && !known.has(a[2])) {
        known.add(a[2]);
        born?.push(a[2]);
        return a[1] + "let " + line.trim();
      }
      return line;
    })
    .join("\n");
}

/** Frames kept for playback. A runaway loop still ends; it just stops recording. */
const MAX_FRAMES = 400;

/** Statements allowed before we call it a forever-loop. */
const BUDGET = 4000;

export function execute(src: string, world: StudioWorld): Recording {
  const frames: Frame[] = [];
  const trail: Stroke[] = [];
  const taken: number[] = [];

  let x = world.start.x;
  let y = world.start.y;
  let dir: StudioDir = world.start.dir;
  let pen = false;
  let penColor = HEX.ink;
  let line = 0;
  let budget = BUDGET;
  let truncated = false;

  const snap = (note: string) => {
    if (frames.length < MAX_FRAMES) {
      frames.push({ line, x, y, dir, note, trailLen: trail.length, taken: taken.slice() });
    } else {
      truncated = true;
    }
  };

  const inside = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < GRID && cy < GRID;
  const open = (cx: number, cy: number) => inside(cx, cy) && !world.walls.has(cellKey(cx, cy));
  const clear = (d: number) => open(x + DIRS[d][0], y + DIRS[d][1]);
  const treasureAt = () =>
    world.treasure.findIndex((g, j) => g.x === x && g.y === y && !taken.includes(j));

  // Closures, not methods. See the header note — `this` is undefined in here.
  const api = {
    forward() {
      const [dx, dy] = DIRS[dir];
      const nx = x + dx;
      const ny = y + dy;
      if (!open(nx, ny)) {
        snap("bump");
        throw new Halt(
          inside(nx, ny)
            ? "The robot walked into a wall."
            : "The robot walked off the edge of the world.",
          line,
        );
      }
      if (pen) trail.push({ x0: x, y0: y, x1: nx, y1: ny, c: penColor });
      x = nx;
      y = ny;
      snap("move");
    },
    right: () => {
      dir = ((dir + 1) % 4) as StudioDir;
      snap("turn");
    },
    left: () => {
      dir = ((dir + 3) % 4) as StudioDir;
      snap("turn");
    },

    // The question words. `wallAhead()` is deliberately the same signal as
    // `!canGo()` said the other way round: a beginner reaches for the positive
    // sentence, and discovering later that these are one fact is exactly where
    // `!` earns its introduction.
    canGo: () => clear(dir),
    canGoLeft: () => clear((dir + 3) % 4),
    canGoRight: () => clear((dir + 1) % 4),
    wallAhead: () => !clear(dir),
    onTreasure: () => treasureAt() >= 0,
    carrying: () => taken.length,
    atGoal: () => !!world.goal && world.goal.x === x && world.goal.y === y,
    onColor: (v: unknown) => {
      const here = world.paint.get(cellKey(x, y));
      return here != null && colorOf(here) === colorOf(v);
    },

    take() {
      const i = treasureAt();
      if (i < 0) {
        snap("nogem");
        throw new Halt("take() but there is nothing here to take.", line);
      }
      taken.push(i);
      snap("take");
    },

    penDown: () => {
      pen = true;
      snap("pen");
    },
    penUp: () => {
      pen = false;
      snap("pen");
    },
    color: (v: unknown) => {
      penColor = colorOf(v);
      snap("pen");
    },
    say: (v: unknown) => {
      snap("say:" + String(v));
    },

    /** Injected before every statement: tracks the line and enforces the budget. */
    __line(n: number) {
      line = n;
      if (--budget <= 0) {
        throw new Halt("This program never stopped. Something is looping forever.", n);
      }
    },
  };

  /** `count(4)` gives `[0,1,2,3]`, so `for (n of count(4))` reads as English. */
  const count = (n: number) =>
    Array.from({ length: Math.max(0, Math.floor(Number(n) || 0)) }, (_, i) => i);

  const declared = autoDeclare(src);
  const instrumented = declared
    .split("\n")
    .map((l, i) => (l.trim() === "" || l.trim().startsWith("//") ? l : `__line(${i + 1});${l}`))
    .join("\n");

  // A name the scholar declared is theirs; we withdraw the command of that name
  // rather than let it collide with our injected parameter. See declaredNames.
  const mine = declaredNames(declared);
  const scope: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...api, ...HEX, count })) {
    // __line is ours, not a taught word — instrumentation breaks without it.
    if (k === "__line" || !mine.has(k)) scope[k] = v;
  }

  let error: Halt | null = null;
  snap("start");
  try {
    new Function(...Object.keys(scope), '"use strict";\n' + instrumented)(
      ...Object.values(scope),
    );
  } catch (e) {
    error =
      e instanceof Halt ? e : new Halt(humanize(e), line);
  }
  snap("end");

  const left = world.treasure.length - taken.length;
  const atGoal = world.goal ? world.goal.x === x && world.goal.y === y : true;

  let won: boolean;
  if (world.free) {
    // The pen levels: nothing to win, so finishing without an error IS the win.
    won = !error;
  } else if (world.needCarry != null) {
    won = !error && taken.length === world.needCarry;
  } else {
    won = !error && atGoal && left === 0;
  }

  return { frames, trail, error, won, left, atGoal, carried: taken.length, truncated };
}

/**
 * Names the scholar declares themselves, so the runtime can get out of the way.
 *
 * Every command is injected as a parameter of the generated function, and JS
 * forbids a `let`/`const` in a function body from colliding with that
 * function's own parameter. So `let count = 0` — the single most natural line
 * in a counting exercise, and one we actively teach — was a hard SyntaxError
 * reading "Identifier 'count' has already been declared". The same held for
 * `let color = "red"`, `let left = 0`, and any other command name a kid
 * reasonably picks for a variable. No fixer could repair it either, because the
 * clash is in our generated wrapper rather than in anything they wrote.
 *
 * So a declaration wins. If the program declares a name, we stop injecting the
 * command of that name and their variable is simply the only one — which is
 * what shadowing would do in any ordinary nested scope, and what a kid means.
 * The cost is that `count()` is unavailable in a program that declared its own
 * `count`; that is the correct trade and matches how JS behaves everywhere else.
 */
function declaredNames(src: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bfor\s*\(\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\s/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  return names;
}

/**
 * Turn a JavaScript exception into a sentence. The raw messages are written for
 * people who already know what a token is; these are written for someone who
 * has been programming for forty minutes.
 *
 * Every pattern here must cover BOTH engines. The sandbox is developed in
 * Chromium (V8: "dance is not defined") and shipped inside an iPad WebView
 * (JavaScriptCore: "Can't find variable: dance"). Matching only V8 means the
 * single most common beginner error — a misspelled command — reads as a raw
 * engine message on the one device this is actually for.
 */
export function humanize(e: unknown): string {
  const raw = String((e as Error)?.message ?? e);

  // V8 and JavaScriptCore phrase an unknown name completely differently.
  const undef =
    raw.match(/^(\w+) is not defined$/) ?? raw.match(/^Can't find variable: (\w+)$/);
  if (undef) {
    return `There is no command called ${undef[1]}.${suggest(undef[1])}`;
  }

  // V8: "dance is not a function". JSC appends an evaluation trace, so match
  // the head rather than anchoring the whole string.
  const notFn = raw.match(/^(\w+) is not a function/);
  if (notFn) {
    return `${notFn[1]} is not something you can call.${suggest(notFn[1])}`;
  }

  // V8: "Assignment to constant variable."  JSC: "Attempted to assign to
  // readonly property."
  if (/Assignment to constant|assign to readonly/i.test(raw)) {
    return "That name was made with const, so it cannot change. Use let when a value needs to change.";
  }
  if (/Maximum call stack/i.test(raw)) {
    return "A function kept calling itself and never stopped.";
  }
  return raw;
}

/**
 * The payoff for keeping STUDIO_VOCABULARY honest: when an unknown name is one
 * or two typos away from a word the robot knows, say which. `foward()` is the
 * error a scholar makes over and over, and "did you mean forward()" ends it in
 * one read instead of a minute of staring.
 *
 * Deliberately silent when nothing is close. A confident wrong guess is worse
 * than no guess — it sends the scholar to fix a line that was never the
 * problem.
 */
function suggest(name: string): string {
  let best: string | null = null;
  let bestD = Infinity;
  for (const word of STUDIO_VOCABULARY) {
    const d = editDistance(name.toLowerCase(), word.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = word;
    }
  }
  // Two edits is the practical ceiling: at three, near-misses stop being near.
  const limit = name.length <= 4 ? 1 : 2;
  return best && bestD <= limit
    ? ` Did you mean ${best}?`
    : " Check the spelling, or look at the list of words the robot knows.";
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

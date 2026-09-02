/**
 * The Studio — boot and wiring.
 *
 * This file owns the loop a scholar actually lives in: type, Run, watch, scrub,
 * change one thing, Run again. Everything expensive it delegates; what it keeps
 * is the sequencing, because the sequencing is the feel.
 *
 * Two decisions here are worth defending, because both look like extra work:
 *
 * **A repair is offered, never applied.** When the generous fixer straightens a
 * program, we run the REPAIRED version — a kid who typed `Forward()` should see
 * their robot move, not a lecture — but we leave their buffer alone and show
 * what we did, with one tap to accept it. Silently rewriting a child's work
 * teaches them the machine is capricious and fights their typing. Showing the
 * work turns a typo into the smallest possible lesson.
 *
 * **A run is recorded first, then played back.** The program finishes in
 * microseconds; the animation is a reading of the recording. That is what makes
 * the scrubber possible, and the scrubber is the reason to build this surface
 * instead of using an online editor — you can drag back to the moment it went
 * wrong and see which line was responsible.
 */
import type {
  StudioFix,
  StudioFixResult,
  StudioLevel,
  StudioRunResult,
  StudioWorld,
  StudioWorldSeed,
} from "../../shared/studioContract";
import { STUDIO_RUN_TRACE_FRAME_LIMIT } from "../../shared/studioContract";
import {
  CANONICAL_SEED,
  STUDIO_LEVELS,
  deriveStudioWorldSeed,
  levelById,
} from "../../shared/studioLevels";
import { execute, type Frame, type Recording } from "./runtime";
import { draw, mountCanvas, relayout } from "./render";
import { charmKey, setCharmUrls, setSkin, skinId } from "./charms";
import { mountEditor, type EditorHandle } from "./editor";
import { fixRuntimeSource, parses, studioFix } from "./fix";
import * as bridge from "./bridge";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  paper: $<HTMLCanvasElement>("paper"),
  verdict: $<HTMLDivElement>("verdict"),
  hint: $<HTMLDivElement>("hint"),
  editor: $<HTMLDivElement>("editor"),
  offer: $<HTMLDivElement>("offer"),
  run: $<HTMLButtonElement>("run"),
  stop: $<HTMLButtonElement>("stop"),
  roll: $<HTMLButtonElement>("roll"),
  reset: $<HTMLButtonElement>("reset"),
  scrub: $<HTMLInputElement>("scrub"),
  steps: $<HTMLSpanElement>("steps"),
};

let level: StudioLevel = STUDIO_LEVELS[0];
let worldSeed: StudioWorldSeed = CANONICAL_SEED;
let world: StudioWorld = level.make(worldSeed);
let record: Recording | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let pendingFix: string | null = null;
let runAssisted = false;
const directAttempts = new Map<string, number>();

const restFrame = (): Frame => ({
  ...world.start,
  note: "start",
  line: 0,
  trailLen: 0,
  taken: [],
});

// ── the world view ───────────────────────────────────────────────────────────

function redraw() {
  if (record) showFrame(Number(els.scrub.value) || 0);
  else draw(world, restFrame(), []);
}

function showFrame(i: number) {
  if (!record) return;
  const n = record.frames.length;
  const idx = Math.max(0, Math.min(i, n - 1));
  const f = record.frames[idx];
  draw(world, f, record.trail.slice(0, f.trailLen));
  els.scrub.value = String(idx);
  els.steps.textContent = `${idx} / ${n - 1}`;
  // Light the responsible line, in red only at the moment it actually failed.
  const failing = !!record.error && idx >= n - 2;
  editor.blame(f.line > 0 ? f.line : null, failing);
}

function clearRecording() {
  stopPlayback();
  record = null;
  els.scrub.value = "0";
  els.scrub.max = "0";
  els.scrub.disabled = true;
  els.steps.textContent = "";
  editor.blame(null);
  redraw();
}

// ── the verdict ──────────────────────────────────────────────────────────────

let verdictTimer: ReturnType<typeof setTimeout> | null = null;

function say(html: string, kind?: "win" | "err" | "warn", holdMs = 0) {
  els.verdict.className = "show" + (kind ? " " + kind : "");
  els.verdict.innerHTML = html;
  if (verdictTimer) clearTimeout(verdictTimer);
  if (holdMs > 0) verdictTimer = setTimeout(hush, holdMs);
}

function hush() {
  els.verdict.className = "";
}

// ── running ──────────────────────────────────────────────────────────────────

function stopPlayback() {
  if (timer) clearInterval(timer);
  timer = null;
  els.stop.disabled = true;
  els.run.disabled = false;
}

/**
 * True when a program ran all the way through and left no mark on the world:
 * the robot never moved, nothing was picked up, no ink was laid down. It is not
 * an error — JavaScript is perfectly happy — which is exactly what makes it the
 * cruellest outcome this surface can produce. `forward` without its parentheses
 * parses, evaluates, and does nothing, and a scholar staring at a motionless
 * robot has been told nothing at all about why.
 */
function didNothing(r: Recording): boolean {
  return (
    !r.error &&
    !r.won &&
    r.trail.length === 0 &&
    !r.frames.some((f) => f.note === "move" || f.note === "take" || f.note === "drop")
  );
}

function run() {
  const typed = editor.text();

  if (parses(typed).ok) {
    // It parses, so run it — but on paper first. `execute` records to
    // completion without animating, so we can look at the outcome before the
    // scholar watches a single frame, and spend a repair on the two failures
    // that parse cleanly and teach nothing: a capital letter, and a command
    // written without its parentheses.
    const dry = execute(typed, world);
    if (dry.error || didNothing(dry)) {
      const rescued = fixRuntimeSource(typed);
      if (rescued.ok && rescued.fixes.length) {
        play(rescued.source, rescued.fixes);
        return;
      }
    }
    play(typed, []);
    return;
  }

  // It does not parse. Try the deterministic pass first — it is instant and
  // offline, and it handles the overwhelming majority of what actually goes
  // wrong (a capital letter, a missing bracket, a word from another language).
  const fixed = studioFix(typed);
  if (fixed.ok) {
    play(fixed.source, fixed.fixes);
    return;
  }

  // Still unparseable. Ask the host to escalate, and keep the editor live: the
  // scholar does not stop being allowed to type because we are thinking.
  const err = parses(typed);
  const message = err.ok ? "" : err.error;
  if (!bridge.hasHost()) {
    say(`<b>I could not read that yet.</b> ${esc(message)}`, "err");
    return;
  }
  const requestId = `fix-${Date.now()}`;
  pendingFix = requestId;
  say("<b>Let me look at that…</b>", "warn");
  bridge.publishFixRequest({ requestId, source: typed, error: message });
}

/** `fixes` is what was repaired to make this run possible, if anything. */
function play(source: string, fixes: StudioFix[]) {
  stopPlayback();
  hush();
  runAssisted = fixes.length > 0;
  record = execute(source, world);

  const n = record.frames.length;
  els.scrub.max = String(Math.max(0, n - 1));
  els.scrub.disabled = n <= 1;
  showFrame(0);

  if (fixes.length) showOffer(source, fixes);
  else hideOffer();

  // A four-step level should feel deliberate; a three-hundred-step maze should
  // not take forty-five seconds. Speed scales with length so both read as
  // "the robot is thinking".
  const ms = n <= 40 ? 150 : Math.max(22, Math.round(6000 / n));
  let i = 0;
  els.run.disabled = true;
  els.stop.disabled = false;
  timer = setInterval(() => {
    i++;
    if (i >= n) {
      stopPlayback();
      finish();
      return;
    }
    showFrame(i);
  }, ms);
}

function finish(forcedStatus?: "stopped") {
  if (!record) return;
  const r = record;
  const steps = r.frames.filter((f) => f.note === "move").length;

  let status: StudioRunResult["status"];
  if (forcedStatus === "stopped") {
    status = "stopped";
    say("<b>Stopped.</b> Change the code or scrub the run, then try again.", "warn");
  } else if (r.error) {
    status = "error";
    say(`<b>Stopped on line ${r.error.line}.</b> ${esc(r.error.message)}`, "err");
    editor.blame(r.error.line, true);
  } else if (r.won) {
    status = "win";
    say(
      world.free
        ? "<b>Nothing to win here.</b> That is the point — change a number and run it again."
        : "<b>Solved.</b> Now press 🎲 Change the world and run the same program again.",
      "win",
    );
  } else {
    status = "short";
    if (didNothing(r)) {
      // Reporting the puzzle state here would be true and useless: it would
      // say "the robot is not on the pad", implying the plan was wrong, when
      // the plan may have been perfect and the program simply never asked the
      // robot to do anything. Say the smaller, truer thing.
      say(
        "<b>It ran, but the robot never moved.</b> Every line was read — none of them told it to do something.",
        "warn",
      );
    } else {
      const bits: string[] = [];
      if (world.needCarry != null) {
        bits.push(`you are carrying ${r.carried}, and the job was exactly ${world.needCarry}`);
      } else {
        if (!r.atGoal) bits.push("the robot is not on the pad");
        if (r.left > 0) bits.push(`${r.left} left behind`);
      }
      say(`<b>It ran, but it did not solve it</b> — ${bits.join(", ")}.`, "warn");
    }
  }

  bridge.publishRun({
    levelId: level.id,
    status,
    steps,
    seed: String(worldSeed),
    assisted: runAssisted,
    trace: {
      frames: r.frames
        .slice(0, STUDIO_RUN_TRACE_FRAME_LIMIT)
        .map(({ line, x, y, note }) => ({ line, x, y, note })),
      totalFrames: r.frames.length,
      truncated: r.truncated || r.frames.length > STUDIO_RUN_TRACE_FRAME_LIMIT,
    },
    message: els.verdict.textContent ?? "",
    ...(r.error ? { line: r.error.line } : {}),
  });
}

// ── the fix offer ────────────────────────────────────────────────────────────

function showOffer(repaired: string, fixes: StudioFix[]) {
  // A scholar who forgot the parentheses once forgot them on every line. Three
  // copies of the same sentence reads as nagging and buries the idea; one
  // sentence with the lines it applies to reads as a lesson.
  const groups: Array<{ lines: number[]; was: string; now: string; note: string }> = [];
  for (const f of fixes) {
    const prior = groups.find((g) => g.note === f.note && g.was === f.was && g.now === f.now);
    if (prior) prior.lines.push(f.line);
    else groups.push({ lines: [f.line], was: f.was, now: f.now, note: f.note });
  }

  const shown = groups.slice(0, 4);
  const lines = shown
    .map((g) => {
      const where =
        g.lines.length === 1
          ? `Line ${g.lines[0]}`
          : `Lines ${g.lines.slice(0, -1).join(", ")} and ${g.lines[g.lines.length - 1]}`;
      return `<div>${where}: <code>${esc(g.was)}</code> → <code>${esc(g.now)}</code> — ${esc(g.note)}</div>`;
    })
    .join("");
  const more = groups.length > 4 ? `<div>…and ${groups.length - 4} more.</div>` : "";
  els.offer.innerHTML =
    `<div><b>I ran it as if you had written this:</b></div>${lines}${more}` +
    `<div class="row"><button id="takefix" class="primary">Fix my code</button>` +
    `<button id="keepmine" class="ghost">Leave it</button></div>`;
  els.offer.classList.add("show");
  $("takefix").onclick = () => {
    editor.setText(repaired);
    hideOffer();
    say("<b>Fixed.</b> Run it again.", undefined, 2600);
  };
  $("keepmine").onclick = hideOffer;
}

const hideOffer = () => els.offer.classList.remove("show");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── levels ───────────────────────────────────────────────────────────────────

function openLevel(next: StudioLevel, source: string | undefined, seed: StudioWorldSeed) {
  level = next;
  worldSeed = seed;
  world = level.make(seed);
  clearRecording();
  hideOffer();
  editor.setText(source ?? level.starter);
  els.hint.innerHTML = level.hint;
  els.roll.style.display = level.mode === "art" ? "none" : "";
  hush();
  relayout();
  redraw();
  bridge.publishSource(level.id, editor.text());
}

function applyWorldSeed(seed: StudioWorldSeed) {
  worldSeed = seed;
  world = level.make(seed);
  clearRecording();
  say("New world, same program. <b>Run it again without changing a line.</b>", "warn");
}

function nextDirectSeed(levelId: string): string {
  const attempt = directAttempts.get(levelId) ?? 0;
  directAttempts.set(levelId, attempt + 1);
  return deriveStudioWorldSeed("direct-document", levelId, attempt);
}

function requestWorldRoll() {
  if (!bridge.hasHost()) {
    applyWorldSeed(nextDirectSeed(level.id));
    return;
  }
  bridge.publishRollRequest({
    requestId: `roll-${Date.now()}`,
    levelId: level.id,
  });
}

// ── save ─────────────────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => bridge.publishSource(level.id, editor.text()), 2500);
}

// ── boot ─────────────────────────────────────────────────────────────────────

mountCanvas(els.paper);

const editor: EditorHandle = mountEditor({
  parent: els.editor,
  doc: level.starter,
  onChange() {
    // The recording no longer describes what is on screen. Say so by dropping
    // the blame highlight; keep the frames so the scrubber still works.
    editor.blame(null);
    scheduleSave();
  },
  onTidy(born) {
    if (!born.length) return;
    const names = born.map((n) => `<b>let ${esc(n)}</b>`).join(", ");
    say(`Added ${names} — a new name needs one.`, undefined, 2800);
  },
  onStraighten(caught) {
    say(
      `Straightened <b>${esc(caught)}</b> — the iPad's curly quotes would have broken this.`,
      undefined,
      3200,
    );
  },
  busy: () => timer != null,
});

els.run.addEventListener("click", run);
els.stop.addEventListener("click", () => {
  stopPlayback();
  finish("stopped");
});
els.roll.addEventListener("click", requestWorldRoll);
els.reset.addEventListener("click", () => {
  editor.setText(level.starter);
  clearRecording();
  hideOffer();
});
els.scrub.addEventListener("input", (e) => {
  stopPlayback();
  showFrame(Number((e.target as HTMLInputElement).value));
});

bridge.connect({
  setLevel(levelId, source, seed) {
    const next = levelById(levelId);
    if (next) openLevel(next, source, seed);
  },
  rollWorld: applyWorldSeed,
  setCharms(urls) {
    setCharmUrls(urls, redraw);
  },
  applyFix(requestId, result: StudioFixResult) {
    if (requestId !== pendingFix) return;
    pendingFix = null;
    if (!result.ok) {
      const err = parses(editor.text());
      say(`<b>I could not read that one.</b> ${err.ok ? "" : esc(err.error)}`, "err");
      return;
    }
    play(result.source, result.fixes);
  },
});

// The skin is the world's costume, not its rules. Exposed so the host (or a
// person poking at the console) can switch it without reloading.
(window as unknown as Record<string, unknown>).studio = {
  setSkin: (id: string) => {
    setSkin(id);
    redraw();
  },
  skinId,
  charmKey,
  levels: STUDIO_LEVELS.map((l) => ({ id: l.id, title: l.title, rung: l.rung })),
  open: (id: string, source?: string) => {
    const l = levelById(id);
    if (l) openLevel(l, source, nextDirectSeed(l.id));
  },
  /**
   * Console and test-harness handles. The iPad has no keyboard for an
   * automated run and no console to type in, so a remote smoke test drives the
   * Studio through these.
   */
  setSource: (text: string) => editor.setText(text),
  source: () => editor.text(),
  run: () => run(),
  verdict: () => els.verdict.textContent ?? "",
  offer: () => (els.offer.classList.contains("show") ? els.offer.textContent : null),
};

els.hint.innerHTML = level.hint;
els.steps.textContent = "";
requestAnimationFrame(() => {
  relayout();
  redraw();
});

/**
 * Pure helpers for the stance-fit decision-point replay (no API calls, no
 * convex imports) — prefix construction, record shapes, aggregation, and the
 * compare report. run.ts / compare.ts are thin CLIs over this file so the
 * logic is unit-testable (lib.test.ts).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Message {
  role: "user" | "assistant";
  content: string;
  createdAt?: number | string | null;
}

/** One transcript, in the stance-fit out-dir `data/*.json` shape (fetch.mjs). */
export interface SessionData {
  sessionId: string;
  title?: string;
  unitTitle: string | null;
  activityTitle: string | null;
  readingLevel: string | null;
  createdAt?: number | string;
  scholarId?: string;
  messages: Message[];
}

export interface DecisionPoint {
  sessionId: string;
  scholarIndex: number;
  tutorIndex: number;
  state: string;
  originalMove: string;
  originalFit: string;
}

export interface Generation {
  key: string; // `${dpKey}#${sample}`
  dpKey: string;
  sample: number;
  sessionId: string;
  scholarIndex: number;
  state: string;
  text: string;
  textSha256: string;
  systemPromptSha256: string;
  generatedAt: string;
}

export interface GenerationsFile {
  label: string;
  gitSha: string;
  /** SHA-256 of `git diff HEAD -- convex/`; null when convex/ is clean. */
  convexDiffSha256: string | null;
  tutorModel: string;
  tutorEffort: string | null;
  /** Tutor tokens accumulated across every invocation that wrote this file. */
  usage: { calls: number; input: number; output: number; cacheRead: number; cacheCreate: number };
  generations: Record<string, Generation>;
}

export interface Verdict {
  scholarState: string;
  tutorMove: string;
  stanceFit: string;
  teachingSentences: number;
  rationale: string;
}

export interface JudgedVerdict extends Verdict {
  key: string;
  dpKey: string;
  textSha256: string;
}

export interface VerdictsFile {
  label: string;
  judgeModel: string;
  judgePromptSha256: string;
  verdicts: Record<string, JudgedVerdict>;
}

export const TEACHING_MOVES = new Set([
  "direct_explanation",
  "worked_example_parallel",
  "answer_given",
]);
export const GUIDED_MOVES = new Set(["probe_question", "narrowing_hint"]);

export function dpKey(dp: Pick<DecisionPoint, "sessionId" | "scholarIndex">) {
  return `${dp.sessionId}:${dp.scholarIndex}`;
}

export function loadSessions(outDir: string): Map<string, SessionData> {
  const dataDir = join(outDir, "data");
  const sessions = new Map<string, SessionData>();
  for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".json")).sort()) {
    const session = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as SessionData;
    sessions.set(session.sessionId, session);
  }
  return sessions;
}

export function loadDecisionPoints(outDir: string): DecisionPoint[] {
  const raw = JSON.parse(readFileSync(join(outDir, "decision-points.json"), "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.decisionPoints;
  if (!Array.isArray(list)) {
    throw new Error("decision-points.json must be an array (or { decisionPoints: [...] })");
  }
  return list as DecisionPoint[];
}

/**
 * The conversation the tutor would have seen when composing the turn at
 * `dp.tutorIndex`: messages[0..scholarIndex] inclusive. Throws (with a reason
 * the CLI reports as a skip) when the decision point doesn't line up with the
 * transcript — a mismatch would silently replay the wrong moment.
 */
export function buildPrefix(session: SessionData, dp: DecisionPoint): Message[] {
  const { messages } = session;
  const scholar = messages[dp.scholarIndex];
  if (!scholar) throw new Error(`scholarIndex ${dp.scholarIndex} out of range`);
  if (scholar.role !== "user") {
    throw new Error(`message ${dp.scholarIndex} is ${scholar.role}, not a scholar turn`);
  }
  if (scholar.content.trim().toLowerCase() === "<start>") {
    throw new Error(`message ${dp.scholarIndex} is the <start> sentinel (greeting is not a decision point)`);
  }
  if (dp.tutorIndex !== dp.scholarIndex + 1) {
    throw new Error(`tutorIndex ${dp.tutorIndex} must immediately follow scholarIndex ${dp.scholarIndex}`);
  }
  if (messages[dp.tutorIndex] && messages[dp.tutorIndex].role !== "assistant") {
    throw new Error(`message ${dp.tutorIndex} is not a tutor turn`);
  }
  // Image-only or attachment-only turns arrive with empty text; the API rejects
  // empty messages, so stand in a marker for what the replay cannot carry.
  return messages.slice(0, dp.scholarIndex + 1).map((m) => ({
    role: m.role,
    content: m.content.trim() === "" ? "[image or attachment not carried in replay]" : m.content,
  }));
}

/**
 * Prod renders the open-exploration "Wrap up" note when the session has no
 * activity (and is conversation mode, not a test drive — fetch.mjs already
 * drops test drives; session mode isn't carried, so we assume conversation).
 */
export function inferOffersWrapUp(session: SessionData) {
  return session.activityTitle == null;
}

export function questionMarks(text: string) {
  return (text.match(/\?/g) ?? []).length;
}

export function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface Sample {
  dpKey: string;
  state: string; // the decision point's state (stable pairing key)
  judgedState: string;
  move: string;
  fit: string;
  questionMarks: number;
  chars: number;
  words: number;
}

export function joinSamples(
  dps: DecisionPoint[],
  gens: GenerationsFile,
  verdicts: VerdictsFile,
): Sample[] {
  const byDp = new Map(dps.map((dp) => [dpKey(dp), dp]));
  const out: Sample[] = [];
  for (const gen of Object.values(gens.generations)) {
    const v = verdicts.verdicts[gen.key];
    // A verdict for an older generation (the text was regenerated) is stale.
    if (!v || v.textSha256 !== gen.textSha256) continue;
    const dp = byDp.get(gen.dpKey);
    out.push({
      dpKey: gen.dpKey,
      state: dp?.state ?? gen.state,
      judgedState: v.scholarState,
      move: v.tutorMove,
      fit: v.stanceFit,
      questionMarks: questionMarks(gen.text),
      chars: gen.text.length,
      words: wordCount(gen.text),
    });
  }
  return out;
}

export type Predicate = (s: Pick<Sample, "move" | "fit">) => boolean;

export interface HeadlineMetric {
  name: string;
  /** Restrict to decision points in this state; null = all. */
  state: string | null;
  hit: Predicate;
  /** Direction we hope the candidate moves: "up", "down", or "hold". */
  want: "up" | "down" | "hold";
}

export const HEADLINES: HeadlineMetric[] = [
  {
    name: "stuck_repeating → teaching move (direct_explanation|worked_example_parallel|answer_given)",
    state: "stuck_repeating",
    hit: (s) => TEACHING_MOVES.has(s.move),
    want: "up",
  },
  {
    name: "demonstrated → closure_summary",
    state: "demonstrated",
    hit: (s) => s.move === "closure_summary",
    want: "up",
  },
  {
    name: "over_socratic + funnel (all states)",
    state: null,
    hit: (s) => s.fit === "over_socratic" || s.fit === "funnel",
    want: "down",
  },
  {
    name: "over_didactic (all states) — the regression to watch",
    state: null,
    hit: (s) => s.fit === "over_didactic",
    want: "down",
  },
  {
    name: "has_footing → probe_question (control)",
    state: "has_footing",
    hit: (s) => s.move === "probe_question",
    want: "hold",
  },
  {
    name: "has_footing → probe_question|narrowing_hint (control)",
    state: "has_footing",
    hit: (s) => GUIDED_MOVES.has(s.move),
    want: "hold",
  },
];

/** Per decision point, the fraction of its samples satisfying `hit`. */
export function perDpRate(samples: Sample[], metric: HeadlineMetric): Map<string, number> {
  const tally = new Map<string, { hit: number; n: number }>();
  for (const s of samples) {
    if (metric.state && s.state !== metric.state) continue;
    const t = tally.get(s.dpKey) ?? { hit: 0, n: 0 };
    t.n++;
    if (metric.hit(s)) t.hit++;
    tally.set(s.dpKey, t);
  }
  return new Map([...tally].map(([k, t]) => [k, t.hit / t.n]));
}

export interface PairedHeadline {
  name: string;
  want: HeadlineMetric["want"];
  nDp: number;
  rateA: number | null;
  rateB: number | null;
  rateOriginal: number | null;
  bBetter: number; // dps where B's rate moved in the wanted direction
  bWorse: number;
  ties: number;
}

/**
 * Paired headline: only decision points present (and judged) in BOTH runs.
 * Rates are means of per-dp rates, so a dp with more samples doesn't count
 * more. `rateOriginal` uses the shipped turn's labels from decision-points.json
 * over the same paired dps — the prod reference point.
 */
export function pairedHeadline(
  metric: HeadlineMetric,
  a: Sample[],
  b: Sample[],
  dps: DecisionPoint[],
): PairedHeadline {
  const ra = perDpRate(a, metric);
  const rb = perDpRate(b, metric);
  const keys = [...ra.keys()].filter((k) => rb.has(k)).sort();
  const mean = (m: Map<string, number>) =>
    keys.length ? keys.reduce((sum, k) => sum + (m.get(k) ?? 0), 0) / keys.length : null;
  const byDp = new Map(dps.map((dp) => [dpKey(dp), dp]));
  const orig = keys
    .map((k) => byDp.get(k))
    .filter((dp): dp is DecisionPoint => !!dp)
    .map((dp) => (metric.hit({ move: dp.originalMove, fit: dp.originalFit }) ? 1 : 0));
  let bBetter = 0;
  let bWorse = 0;
  let ties = 0;
  for (const k of keys) {
    const d = (rb.get(k) ?? 0) - (ra.get(k) ?? 0);
    if (d === 0 || metric.want === "hold") {
      if (d === 0) ties++;
      else if (d > 0) bBetter++; // for "hold": count raw up/down
      else bWorse++;
      continue;
    }
    if ((metric.want === "up" && d > 0) || (metric.want === "down" && d < 0)) bBetter++;
    else bWorse++;
  }
  return {
    name: metric.name,
    want: metric.want,
    nDp: keys.length,
    rateA: mean(ra),
    rateB: mean(rb),
    rateOriginal: orig.length ? orig.reduce((x: number, y: number) => x + y, 0) / orig.length : null,
    bBetter,
    bWorse,
    ties,
  };
}

export function distribution(samples: Sample[], field: "move" | "fit") {
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s[field], (counts.get(s[field]) ?? 0) + 1);
  return counts;
}

export function mechanical(samples: Sample[]) {
  const n = samples.length;
  const avg = (f: (s: Sample) => number) => (n ? samples.reduce((x, s) => x + f(s), 0) / n : null);
  return {
    n,
    questionMarks: avg((s) => s.questionMarks),
    chars: avg((s) => s.chars),
    words: avg((s) => s.words),
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const num = (x: number | null, d = 1) => (x == null ? "—" : x.toFixed(d));

export interface CompareInput {
  labelA: string;
  labelB: string;
  dps: DecisionPoint[];
  gensA: GenerationsFile;
  gensB: GenerationsFile;
  verdictsA: VerdictsFile;
  verdictsB: VerdictsFile;
}

export function renderCompare(input: CompareInput): string {
  const { labelA, labelB, dps, gensA, gensB, verdictsA, verdictsB } = input;
  const allA = joinSamples(dps, gensA, verdictsA);
  const allB = joinSamples(dps, gensB, verdictsB);
  const paired = new Set(allA.map((s) => s.dpKey).filter((k) => allB.some((s) => s.dpKey === k)));
  const a = allA.filter((s) => paired.has(s.dpKey));
  const b = allB.filter((s) => paired.has(s.dpKey));

  const lines: string[] = [];
  lines.push(`# Stance-fit replay: ${labelA} vs ${labelB}`, "");
  lines.push("| | A | B |", "|---|---|---|");
  lines.push(`| label | ${labelA} | ${labelB} |`);
  lines.push(`| git SHA | \`${gensA.gitSha.slice(0, 12)}\` | \`${gensB.gitSha.slice(0, 12)}\` |`);
  lines.push(`| convex/ uncommitted diff | ${gensA.convexDiffSha256?.slice(0, 12) ?? "clean"} | ${gensB.convexDiffSha256?.slice(0, 12) ?? "clean"} |`);
  lines.push(`| tutor model / effort | ${gensA.tutorModel} / ${gensA.tutorEffort ?? "default"} | ${gensB.tutorModel} / ${gensB.tutorEffort ?? "default"} |`);
  lines.push(`| judge model | ${verdictsA.judgeModel} | ${verdictsB.judgeModel} |`);
  lines.push(`| judge prompt sha | ${verdictsA.judgePromptSha256.slice(0, 12)} | ${verdictsB.judgePromptSha256.slice(0, 12)} |`);
  lines.push(`| judged samples (paired) | ${a.length} | ${b.length} |`);
  lines.push("");
  const warnings: string[] = [];
  if (gensA.tutorModel !== gensB.tutorModel || gensA.tutorEffort !== gensB.tutorEffort) {
    warnings.push("Tutor model/effort differ between runs — this is not a prompt-only A/B.");
  }
  if (verdictsA.judgeModel !== verdictsB.judgeModel || verdictsA.judgePromptSha256 !== verdictsB.judgePromptSha256) {
    warnings.push("Judge model or judge prompt differ between runs — label shifts may be judge drift, not tutor change.");
  }
  if (allA.length !== a.length || allB.length !== b.length) {
    warnings.push(`Unpaired samples dropped: A ${allA.length - a.length}, B ${allB.length - b.length}.`);
  }
  for (const w of warnings) lines.push(`> **Warning:** ${w}`, "");

  lines.push(`Paired decision points: **${paired.size}**. Rates are means of per-decision-point rates over samples; "B better/worse" counts decision points whose rate moved in/against the wanted direction (for controls: up/down).`, "");

  lines.push("## Headline", "");
  lines.push("| metric | want | n dp | original (prod) | A | B | Δ (B−A) | B better | B worse | tie |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const metric of HEADLINES) {
    const h = pairedHeadline(metric, a, b, dps);
    const delta = h.rateA == null || h.rateB == null ? null : h.rateB - h.rateA;
    const d = delta == null ? "—" : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)} pts`;
    // Headline names contain literal "|" (move alternatives); escape so they
    // don't split the Markdown table into extra columns.
    const name = h.name.replace(/\|/g, "\\|");
    lines.push(`| ${name} | ${h.want} | ${h.nDp} | ${pct(h.rateOriginal)} | ${pct(h.rateA)} | ${pct(h.rateB)} | ${d} | ${h.bBetter} | ${h.bWorse} | ${h.ties} |`);
  }
  lines.push("");

  const ma = mechanical(a);
  const mb = mechanical(b);
  lines.push("## Mechanical (per generated turn)", "");
  lines.push("| metric | A | B |", "|---|---|---|");
  lines.push(`| mean '?' count | ${num(ma.questionMarks, 2)} | ${num(mb.questionMarks, 2)} |`);
  lines.push(`| mean words | ${num(ma.words)} | ${num(mb.words)} |`);
  lines.push(`| mean chars | ${num(ma.chars, 0)} | ${num(mb.chars, 0)} |`);
  lines.push("");

  const agree = (xs: Sample[]) => (xs.length ? xs.filter((s) => s.judgedState === s.state).length / xs.length : null);
  lines.push(`Judge re-labelled scholar state agrees with the decision point's state: A ${pct(agree(a))}, B ${pct(agree(b))} (low agreement means the state grouping below is noisy).`, "");

  lines.push("## By scholar state", "");
  const states = [...new Set([...a, ...b].map((s) => s.state))].sort();
  for (const state of states) {
    const sa = a.filter((s) => s.state === state);
    const sb = b.filter((s) => s.state === state);
    const nDp = new Set(sa.map((s) => s.dpKey)).size;
    lines.push(`### ${state} (${nDp} dp; A n=${sa.length}, B n=${sb.length})`, "");
    for (const field of ["move", "fit"] as const) {
      const da = distribution(sa, field);
      const db = distribution(sb, field);
      const labels = [...new Set([...da.keys(), ...db.keys()])].sort();
      lines.push(`| ${field} | A | B |`, "|---|---|---|");
      for (const l of labels) {
        const ca = da.get(l) ?? 0;
        const cb = db.get(l) ?? 0;
        lines.push(`| ${l} | ${ca} (${pct(sa.length ? ca / sa.length : null)}) | ${cb} (${pct(sb.length ? cb / sb.length : null)}) |`);
      }
      lines.push("");
    }
  }

  lines.push("## Per decision point (fit, all samples)", "");
  lines.push("| decision point | state | original | A | B |", "|---|---|---|---|---|");
  const byDp = new Map(dps.map((dp) => [dpKey(dp), dp]));
  for (const k of [...paired].sort()) {
    const dp = byDp.get(k);
    const fa = a.filter((s) => s.dpKey === k).map((s) => `${s.move}/${s.fit}`).join(", ");
    const fb = b.filter((s) => s.dpKey === k).map((s) => `${s.move}/${s.fit}`).join(", ");
    lines.push(`| \`${k}\` | ${dp?.state ?? "?"} | ${dp ? `${dp.originalMove}/${dp.originalFit}` : "?"} | ${fa} | ${fb} |`);
  }
  lines.push("");
  return lines.join("\n");
}

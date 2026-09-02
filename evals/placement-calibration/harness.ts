/**
 * Placement-calibration harness — MEASURE the adaptive placement search, tune
 * nothing.
 *
 * This drives the REAL production placement path (`api.practiceSkills.
 * submitPlacementAnswer`) through `convex-test`, exactly the way
 * `convex/__tests__/impliesPlacement.test.ts` does — it is NOT a parallel
 * reimplementation of the search. A SYNTHETIC scholar is an ORACLE: its true
 * knowledge is "knows every node at/below grade G in this domain", with optional
 * noise (a p(slip) careless miss on a known node; a p(guess-correct) lucky guess
 * on an unknown multiple-choice item). We feed the oracle's answers into the real
 * mutation and read back what the server actually served + credited.
 *
 * Per run we measure (all defined in ./metrics-doc in the README):
 *   • probes            — probes to converge (probe-log length)
 *   • idkBurden         — honest IDKs a kid at level G eats (server `unknown`s)
 *   • overshoot (grades)— how far ABOVE the true frontier the first probe of each
 *                         strand opens (the pilot's "formal angle language for a
 *                         grade-2 kid")
 *   • oscillation       — direction changes in served difficulty
 *   • over/under-credit — credited-vs-true frontier error, counted separately
 *
 * Pure/deterministic given (cell, seed): a seeded PRNG drives all noise, and the
 * server-side item seed is pinned. With zero noise the run is identical across
 * RNG seeds.
 */

import type { convexTest } from "convex-test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { gradeTemplateItem } from "../../convex/lib/practice/session";
import { accessProven } from "../../convex/lib/practice/scheduler";
import {
  strandOrders,
  gradeRank,
  DEFAULT_PLACEMENT_STRAND,
} from "../../convex/lib/practice/placement";
import { PLACEMENT_GLOBAL_CAP } from "../../shared/practiceLoop";

export type Cx = ReturnType<typeof convexTest>;

/** Server-side template item seed. Pinned so a run is reproducible; the item
 *  content never changes which NODE the search probes (that is driven only by
 *  the oracle's outcomes), so a fixed seed keeps runs comparable + deterministic. */
export const PLACEMENT_ITEM_SEED = 7;

// ── Oracle / cell types ────────────────────────────────────────────────────

export type NoiseProfile = {
  /** P(a KNOWN node is answered WRONG anyway — a careless slip). */
  pSlip: number;
  /** P(an UNKNOWN multiple-choice node is GUESSED correctly). */
  pGuessMc: number;
};

export type OracleProfile = {
  /** The true frontier grade: the oracle knows every node at/below this grade. */
  grade: string;
  noise: NoiseProfile;
};

/**
 * Entry kind — how the scholar reached this single-domain placement:
 *   • "default-foundational": the system knows the scholar's grade and passes it
 *     as a prior (`gradeLevel = G`). The affect-safe first probe is grade-anchored
 *     and the grade ring caps how high the search reaches. Models a domain entered
 *     with an accurate prior (e.g. the foundational default after onboarding).
 *   • "you-pick": the scholar deliberately picked this domain with NO grade prior
 *     (`gradeLevel` unset → the first probe defaults to ~1/3 up the strand). This
 *     is the pilot's geometry case (Nova chose Area & Perimeter cold).
 */
export type EntryKind = "default-foundational" | "you-pick";

export type CellSpec = {
  domain: string;
  entry: EntryKind;
  oracle: OracleProfile;
  /** RNG seed for this run's noise. With zero-noise oracles the run is seed-invariant. */
  seed: number;
};

export type RunMetrics = {
  domain: string;
  entry: EntryKind;
  grade: string;
  pSlip: number;
  pGuessMc: number;
  seed: number;
  /** Probe-log length = probes to converge. */
  probes: number;
  /** Honest IDKs (server-side `unknown` outcomes). */
  idkBurden: number;
  /** Max over probed strands of (first-probe grade rank − true frontier grade rank). */
  overshootMaxGrades: number;
  /** Mean over probed strands of the same signed grade overshoot. */
  overshootMeanGrades: number;
  /** Direction changes in the served grade-rank sequence (global felt oscillation). */
  oscillationGlobal: number;
  /** Mean per-strand direction changes in served topo index. */
  oscillationPerStrandMean: number;
  /** Credited nodes the oracle does NOT truly know (over-credit). */
  overCredit: number;
  /** Truly-known nodes NOT credited (under-credit). */
  underCredit: number;
  /** |true known set| over ALL domain nodes at/below G. */
  trueKnown: number;
  /** |credited set| (placement, non-frontier, access-proven). */
  credited: number;
  /** Total nodes in the domain (for normalizing credit error across domains). */
  domainNodeCount: number;
  placedThroughGrade: string | null;
  /** The IDEAL placed-through-grade for this oracle (label if credit were exact);
   *  null when the oracle knows nothing at/below the domain's floor. */
  expectedPlacedThroughGrade: string | null;
  /** rank(placedThroughGrade) − rank(expectedPlacedThroughGrade): the label error
   *  RELATIVE to the ideal label — so a domain with no content at/below G (where
   *  a null label is CORRECT) scores 0, not a spurious deficit. */
  gradeError: number;
  /** True when the run hit the global probe cap (a non-clean finish). */
  capHit: boolean;
};

// ── Deterministic PRNG ─────────────────────────────────────────────────────

/** mulberry32 — a tiny deterministic PRNG so noise is reproducible per seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Domain metadata (read once from the seeded graph) ──────────────────────

export type DomainMeta = {
  domain: string;
  /** nodeKey → grade tag (may be undefined for an untagged node). */
  gradeOf: Map<string, string | undefined>;
  /** strand → topological node order (index 0 = most foundational). */
  orderedByStrand: Map<string, string[]>;
  /** nodeKey → strand. */
  strandOf: Map<string, string>;
  /** All node keys in the domain. */
  allKeys: string[];
};

export async function loadDomainMeta(t: Cx, domain: string): Promise<DomainMeta> {
  const nodes = await t.run(async (ctx) =>
    (await ctx.db.query("knowledgeNodes").collect())
      .filter((n) => n.domain === domain)
      .map((n) => ({ nodeKey: n.nodeKey, grade: n.grade, strand: n.strand, order: n.order })),
  );
  const edges = await t.run(async (ctx) =>
    (await ctx.db.query("knowledgeNodeEdges").collect())
      .filter((e) => e.domain === domain && e.kind === "buildsOn")
      .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })),
  );
  const orders = strandOrders(
    nodes.map((n) => ({ nodeKey: n.nodeKey, strand: n.strand, order: n.order })),
    edges,
  );
  const orderedByStrand = new Map(orders.map((o) => [o.strand, o.orderedKeys]));
  const gradeOf = new Map(nodes.map((n) => [n.nodeKey, n.grade]));
  const strandOf = new Map(nodes.map((n) => [n.nodeKey, n.strand ?? DEFAULT_PLACEMENT_STRAND]));
  return { domain, gradeOf, orderedByStrand, strandOf, allKeys: nodes.map((n) => n.nodeKey) };
}

/** The set of node keys the oracle truly knows: grade tag present and ≤ G. */
export function trueKnownSet(meta: DomainMeta, grade: string): Set<string> {
  const gr = gradeRank(grade);
  const known = new Set<string>();
  for (const key of meta.allKeys) {
    const g = meta.gradeOf.get(key);
    const r = g ? gradeRank(g) : -1;
    if (r >= 0 && r <= gr) known.add(key);
  }
  return known;
}

/**
 * The contiguous "placed-through grade" a credited set implies — the highest
 * grade for which EVERY node of that grade (and all lower grades) is credited.
 * Mirrors the server's private `derivePlacedThroughGrade` (convex/practiceSkills.ts)
 * so we can compute the IDEAL label an oracle should receive; this is the metric's
 * reference, not a reimplementation of the SEARCH.
 */
export function contiguousPlacedThroughGrade(meta: DomainMeta, credited: Set<string>): string | null {
  const grades = [...new Set(meta.allKeys.map((k) => meta.gradeOf.get(k)).filter((g): g is string => !!g))].sort(
    (a, b) => gradeRank(a) - gradeRank(b),
  );
  let placed: string | null = null;
  for (const g of grades) {
    const all = meta.allKeys
      .filter((k) => meta.gradeOf.get(k) === g)
      .every((k) => credited.has(k));
    if (all) placed = g;
    else break;
  }
  return placed;
}

// ── Oracle answering ───────────────────────────────────────────────────────

type ProbeWire = {
  itemId: string;
  skillKey: string;
  strand: string;
  grade: string;
  answerType: string;
  choices?: string[];
};

/** The submission the oracle sends for one probe, plus whether it truly knew it. */
type OracleDecision = {
  submit: { itemId: string; answer?: string; dontKnow?: boolean };
  knows: boolean;
};

/** A submission graded CORRECT for a template probe (index for MC, else the
 *  canonical display answer). Returns null only for a non-template probe. */
function correctAnswerFor(probe: ProbeWire): string | null {
  if (probe.answerType === "multipleChoice") {
    const k = probe.choices?.length ?? 0;
    for (let i = 0; i < k; i++) {
      if (gradeTemplateItem(probe.itemId, String(i))?.correct) return String(i);
    }
    return null;
  }
  const graded = gradeTemplateItem(probe.itemId, "");
  return graded ? graded.correctAnswer : null;
}

/** A submission graded INCORRECT for a template probe (a slip / wrong guess). */
function wrongAnswerFor(probe: ProbeWire): string | null {
  const candidates =
    probe.answerType === "multipleChoice"
      ? Array.from({ length: probe.choices?.length ?? 0 }, (_, i) => String(i))
      : ["0", "1", "2", "3", "7", "999999", "-1", "1/2"];
  for (const c of candidates) {
    const g = gradeTemplateItem(probe.itemId, c);
    if (g && !g.correct) return c;
  }
  return null;
}

/** Decide the oracle's answer to one probe (deterministic given `rng`). */
export function decideAnswer(
  probe: ProbeWire,
  grade: string,
  noise: NoiseProfile,
  rng: () => number,
): OracleDecision {
  const r = probe.grade ? gradeRank(probe.grade) : -1;
  const knows = r >= 0 && r <= gradeRank(grade);
  if (knows) {
    // A careless SLIP: knew it, answered wrong.
    if (noise.pSlip > 0 && rng() < noise.pSlip) {
      const wrong = wrongAnswerFor(probe);
      if (wrong !== null) return { submit: { itemId: probe.itemId, answer: wrong }, knows };
    }
    const correct = correctAnswerFor(probe);
    if (correct !== null) return { submit: { itemId: probe.itemId, answer: correct }, knows };
    // Non-template (shouldn't happen with graph-only seeding): honest IDK.
    return { submit: { itemId: probe.itemId, dontKnow: true }, knows };
  }
  // Unknown node: a lucky GUESS only on multiple-choice; otherwise an honest IDK.
  if (probe.answerType === "multipleChoice" && noise.pGuessMc > 0 && rng() < noise.pGuessMc) {
    const correct = correctAnswerFor(probe);
    if (correct !== null) return { submit: { itemId: probe.itemId, answer: correct }, knows };
  }
  return { submit: { itemId: probe.itemId, dontKnow: true }, knows };
}

// ── One placement run ──────────────────────────────────────────────────────

let scholarCounter = 0;

type SubmitResult = {
  done: boolean;
  probe: ProbeWire | null;
  graded: { outcome: string } | null;
  placedThroughGrade: string | null;
};

/**
 * Drive ONE full placement for a synthetic oracle through the real mutation and
 * return its calibration metrics. Requires the graph already seeded on `t`.
 */
export async function runCell(t: Cx, meta: DomainMeta, cell: CellSpec): Promise<RunMetrics> {
  const rng = mulberry32(cell.seed);
  const username = `calib_${cell.domain}_${cell.entry}_${cell.oracle.grade}_${scholarCounter++}`;
  const gradeLevel = cell.entry === "default-foundational" ? cell.oracle.grade : undefined;

  const scholarId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Oracle",
      username,
      role: "scholar" as const,
      ...(gradeLevel ? { gradeLevel } : {}),
    }),
  );
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId: scholarId, expirationTime: 8_000_000_000_000 }),
  );
  const asScholar = t.withIdentity({ subject: `${scholarId}|${sessionId}`, issuer: "https://convex.dev" });

  const base = { scholarId, domain: cell.domain, seed: PLACEMENT_ITEM_SEED };

  type Event = { strand: string; grade: string; skillKey: string; outcome: string };
  const events: Event[] = [];

  let cur = (await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base)) as SubmitResult;
  for (let i = 0; i < 500 && !cur.done && cur.probe; i++) {
    const probe = cur.probe;
    const decision = decideAnswer(probe, cell.oracle.grade, cell.oracle.noise, rng);
    const resp = (await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      ...decision.submit,
    })) as SubmitResult;
    events.push({
      strand: probe.strand,
      grade: probe.grade,
      skillKey: probe.skillKey,
      outcome: resp.graded?.outcome ?? "unknown",
    });
    cur = resp;
  }

  return computeMetrics(t, meta, cell, scholarId, events, cur.placedThroughGrade);
}

// ── Metrics ────────────────────────────────────────────────────────────────

type Event = { strand: string; grade: string; skillKey: string; outcome: string };

async function computeMetrics(
  t: Cx,
  meta: DomainMeta,
  cell: CellSpec,
  scholarId: Id<"users">,
  events: Event[],
  placedThroughGrade: string | null,
): Promise<RunMetrics> {
  const G = cell.oracle.grade;
  const gRank = gradeRank(G);

  // Credited set: placement-sourced, non-frontier, access-proven mastery.
  const creditedKeys = await t.run(async (ctx) => {
    const rows = await ctx.db.query("practiceMastery").collect();
    return rows
      .filter(
        (r) =>
          r.scholarId === scholarId &&
          r.domain === cell.domain &&
          r.source === "placement" &&
          !r.frontier &&
          accessProven(r),
      )
      .map((r) => r.skillKey);
  });
  const credited = new Set(creditedKeys);
  const known = trueKnownSet(meta, G);

  let overCredit = 0;
  for (const k of credited) if (!known.has(k)) overCredit++;
  let underCredit = 0;
  for (const k of known) if (!credited.has(k)) underCredit++;

  // Overshoot: first probe of each probed strand, in signed grades above the
  // oracle's true frontier grade.
  const firstByStrand = new Map<string, Event>();
  for (const e of events) if (!firstByStrand.has(e.strand)) firstByStrand.set(e.strand, e);
  const overshoots: number[] = [];
  for (const e of firstByStrand.values()) {
    const r = e.grade ? gradeRank(e.grade) : -1;
    if (r >= 0) overshoots.push(r - gRank);
  }
  const overshootMaxGrades = overshoots.length ? Math.max(...overshoots) : 0;
  const overshootMeanGrades = overshoots.length
    ? overshoots.reduce((a, b) => a + b, 0) / overshoots.length
    : 0;

  // Global oscillation: direction changes in the served grade-rank sequence.
  const gradeSeq = events.map((e) => (e.grade ? gradeRank(e.grade) : -1)).filter((r) => r >= 0);
  const oscillationGlobal = directionChanges(gradeSeq);

  // Per-strand oscillation: direction changes in served topo index within each strand.
  const perStrand: number[] = [];
  for (const [strand, list] of groupBy(events, (e) => e.strand)) {
    const order = meta.orderedByStrand.get(strand) ?? [];
    const idxSeq = list.map((e) => order.indexOf(e.skillKey)).filter((i) => i >= 0);
    perStrand.push(directionChanges(idxSeq));
  }
  const oscillationPerStrandMean = perStrand.length
    ? perStrand.reduce((a, b) => a + b, 0) / perStrand.length
    : 0;

  const idkBurden = events.filter((e) => e.outcome === "unknown").length;
  const expectedPTG = contiguousPlacedThroughGrade(meta, known);
  const ptgRank = placedThroughGrade ? gradeRank(placedThroughGrade) : -1;
  const expRank = expectedPTG ? gradeRank(expectedPTG) : -1;
  const gradeError = ptgRank - expRank;

  return {
    domain: cell.domain,
    entry: cell.entry,
    grade: G,
    pSlip: cell.oracle.noise.pSlip,
    pGuessMc: cell.oracle.noise.pGuessMc,
    seed: cell.seed,
    probes: events.length,
    idkBurden,
    overshootMaxGrades,
    overshootMeanGrades,
    oscillationGlobal,
    oscillationPerStrandMean,
    overCredit,
    underCredit,
    trueKnown: known.size,
    credited: credited.size,
    domainNodeCount: meta.allKeys.length,
    placedThroughGrade,
    expectedPlacedThroughGrade: expectedPTG,
    gradeError,
    capHit: events.length >= PLACEMENT_GLOBAL_CAP,
  };
}

/** Count sign flips in the first-difference of a numeric sequence (0 diffs skipped). */
export function directionChanges(seq: number[]): number {
  let changes = 0;
  let lastDir = 0;
  for (let i = 1; i < seq.length; i++) {
    const d = Math.sign(seq[i] - seq[i - 1]);
    if (d === 0) continue;
    if (lastDir !== 0 && d !== lastDir) changes++;
    lastDir = d;
  }
  return changes;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/**
 * Placement — find a new scholar's starting point instead of grinding from
 * "count to 10". Scholars here typically begin ABOVE grade level,
 * so placement TRUSTS UPWARD: it credits the scholar for everything they
 * demonstrably know, marking those skills fluent (placed out) so real practice
 * starts at their actual frontier.
 *
 * This module carries TWO placement models:
 *
 *   1. The CURRENT (default) model — a PER-STRAND ADAPTIVE BINARY SEARCH on
 *      topological order (roadmap §3). Each strand is ordered topologically from
 *      the `buildsOn` graph, then binary-searched for its frontier independently
 *      (~3–4 probes/strand because strands are small). "Trust upward" credits
 *      every node below the discovered frontier as fluent, but at a SHORT
 *      half-life (`PLACEMENT_HALF_LIFE_DAYS = 4`, vs. earned fluency's 7) so an
 *      over-generous placement resurfaces and self-corrects within days. This is
 *      not grade-anchored: a kid strong in mult but shaky in add places high in
 *      one strand, low in another — the DAG enforces the cross-strand constraint.
 *
 *   2. The LEGACY grade-anchored model (`PLACEMENT_ANCHORS` / `gradeRank` /
 *      `anchorGrade` / `placedThroughGrade`) — retained for the internal
 *      `placeScholarInternal` fixture/teacher-override path and its tests until
 *      those callers move. NOT used by the new adaptive placement flow.
 *
 * Pure module — the Convex wiring (placementCurrent / submitPlacementAnswer, the
 * server-authoritative one-item-at-a-time loop) lives in convex/practiceSkills.ts.
 */

import { PLACEMENT_MAX_PROBES_PER_STRAND } from "../../../shared/practiceLoop";
import { normalizeGradeTag } from "../../../shared/grade";

// ── Trust-upward tuning (roadmap §3) ──────────────────────────────────────

/**
 * The half-life (days) placement stamps on TRUSTED-UPWARD credited skills. Short
 * by design: a placement credits a whole prefix off a few probes, so an
 * over-generous guess must resurface fast. At 4 days a credited skill's retention
 * crosses the `DUE_THRESHOLD` (0.6) in ~3 days, so it comes back as a due review
 * and self-corrects — vs. earned fluency's longer, growing half-life.
 */
export const PLACEMENT_HALF_LIFE_DAYS = 4;

/** Earned fluency's baseline half-life (days) — kept here for contrast/reference. */
export const EARNED_HALF_LIFE_DAYS = 7;

/**
 * Soft cap on probes per strand. A binary search over a ~13-node strand converges
 * in ~4 probes; the cap stops a pathological (non-probeable-riddled) strand from
 * over-asking. When hit, the search finalizes at the current confirmed floor.
 */
export const MAX_PROBES_PER_STRAND = PLACEMENT_MAX_PROBES_PER_STRAND;

// ── Per-strand adaptive placement (roadmap §3) ────────────────────────────
//
// (The one-open-run-per-scholar cap that used to live here — MAX_OPEN_PLACEMENT_RUNS,
// isOpenPlacementRun, pickHeldPlacementRun, PLACEMENT_RUN_STALE_MS — was deleted
// by finish-the-check-in (founder 2026-08-18). Its job was to stop a scholar
// accumulating runs they never chose; breadth-first serving replaces it: every
// eligible strand gets first coverage, then domains deepen to convergence
// foundational-first, so runs are finished rather than abandoned. A scholar may
// now hold several in-progress rows at once — that is the intended shape, and
// the engine must tolerate it.)

/**
 * One probe's graded outcome, keyed by the node it tested. Carries the FULL
 * ternary kind (not a collapsed boolean) because "confirm before you cap" has to
 * tell a genuinely-conceded miss (`"unknown"` — caps immediately) apart from a
 * possible slip (`"incorrect"` — one is not yet a ceiling; see `searchBounds`).
 */
export type ProbeOutcome = { nodeKey: string; kind: PlacementOutcomeKind };

/**
 * The TERNARY placement outcome (placement v2):
 *   • `"correct"` — the only outcome that raises the confirmed-pass floor.
 *   • `"incorrect"` — a TYPED wrong answer. ONE is treated as a possible slip: it
 *     does NOT cap the ceiling on its own; the search re-serves a fresh item on
 *     the same skill (the "confirm"). Only a SECOND miss on the node caps. This
 *     restores the engine-wide rule that a later correct answer supersedes an
 *     earlier miss (`recordAttemptCore` resets `missStreak` on a correct answer),
 *     which placement alone used to ignore — one careless slip permanently
 *     lowered the ceiling and locked away every skill above it.
 *   • `"unknown"` — an honest "I haven't learned this yet". First-class and the
 *     FAST path: it caps the ceiling IMMEDIATELY (it IS signal — the scholar
 *     hasn't reached this node), logged distinctly with supportive copy, no
 *     confirm required.
 */
export type PlacementOutcomeKind = "correct" | "incorrect" | "unknown";

/** Only a genuinely correct answer credits (raises the floor). A miss OR an
 *  explicit "don't know" is a non-pass — but they differ in how they cap the
 *  ceiling (see `PlacementOutcomeKind` / `searchBounds`). */
export function outcomeCredits(kind: PlacementOutcomeKind): boolean {
  return kind === "correct";
}

/** Build a `ProbeOutcome` from a ternary kind (the persisted probe log stores the
 *  kind verbatim, so this is the identity-shaped adapter the reconstruction uses). */
export function probeOutcomeFromKind(nodeKey: string, kind: PlacementOutcomeKind): ProbeOutcome {
  return { nodeKey, kind };
}

/**
 * The number of MISSES on one node that make a real ceiling. The first typed miss
 * is a possible slip (the search re-serves a fresh item on the same skill — the
 * "confirm"); the SECOND miss confirms it. An explicit "don't know" (`"unknown"`)
 * caps on its own, bypassing this — honest self-report is the fast path. Two is
 * also the exploit bound: a "silly mistake" retry cannot be brute-forced because
 * it serves a fresh item and a second miss caps regardless.
 */
export const PLACEMENT_CONFIRM_MISSES = 2;

/** One node's folded outcomes across the probe log. */
type NodeFold = {
  index: number;
  correct: boolean;
  misses: number;
  unknown: boolean;
  /** Total outcomes recorded on this node. A node with ≥2 has already consumed a
   *  confirm from the strand's budget. */
  total: number;
  /** Position of this node's FIRST outcome in the log — the deterministic order
   *  in which pending nodes claim the strand's confirm budget. */
  firstSeq: number;
};

/** Fold a strand's probe outcomes by node (outcomes for keys not in the strand are
 *  ignored — cross-strand safety). A node PASSES if ANY outcome was correct. */
function foldOutcomesByNode(
  orderedKeys: string[],
  outcomes: ProbeOutcome[],
): Map<string, NodeFold> {
  const indexOf = new Map(orderedKeys.map((k, i) => [k, i]));
  const folds = new Map<string, NodeFold>();
  let seq = 0;
  for (const o of outcomes) {
    const i = indexOf.get(o.nodeKey);
    if (i === undefined) continue;
    seq += 1;
    let f = folds.get(o.nodeKey);
    if (!f) {
      f = { index: i, correct: false, misses: 0, unknown: false, total: 0, firstSeq: seq };
      folds.set(o.nodeKey, f);
    }
    f.total += 1;
    if (o.kind === "correct") f.correct = true;
    else if (o.kind === "unknown") f.unknown = true;
    else f.misses += 1;
  }
  return folds;
}

/**
 * How many CONFIRMS one strand may spend. A confirm is the extra question a slip
 * costs, so this is the whole cost control: without it a strand of 5 probeable
 * nodes could run to 10 questions, and measured across strand sizes 8–17 a
 * scholar who GUESSES rather than tapping "I don't understand this yet" faced
 * ~54% more questions (a 67-probe check-in → ~103). At 2 the worst case lands
 * near 7, and the real repair case is still fully covered: the scholar this was
 * built for slipped at most twice in any one strand.
 *
 * Past the budget a single typed miss caps immediately — i.e. the pre-fix
 * behaviour — so the rule reads simply as "two second chances per strand".
 */
export const PLACEMENT_MAX_CONFIRMS_PER_STRAND = 2;

/**
 * Which pending nodes may still claim a confirm, given the strand's budget.
 * Nodes that already carry ≥2 outcomes have spent one; the remainder goes to the
 * earliest-logged pending nodes, so the answer is a pure function of the log and
 * a resumed run reconstructs the identical decision.
 */
function confirmableKeys(folds: Map<string, NodeFold>): Set<string> {
  let spent = 0;
  const pending: { key: string; firstSeq: number }[] = [];
  for (const [key, f] of folds) {
    if (f.total >= PLACEMENT_CONFIRM_MISSES) spent += 1;
    if (!f.correct && !f.unknown && f.misses === 1) pending.push({ key, firstSeq: f.firstSeq });
  }
  const budget = Math.max(0, PLACEMENT_MAX_CONFIRMS_PER_STRAND - spent);
  pending.sort((a, b) => a.firstSeq - b.firstSeq);
  return new Set(pending.slice(0, budget).map((p) => p.key));
}

/** Does this node CAP the ceiling? A pass never caps; a "don't know" always does;
 *  a typed miss caps once CONFIRMED (≥2 misses) — or immediately when the strand
 *  has no confirm budget left, since no confirm will ever be served for it. */
function nodeCaps(f: NodeFold, key: string, confirmable: Set<string>): boolean {
  if (f.correct) return false;
  if (f.unknown || f.misses >= PLACEMENT_CONFIRM_MISSES) return true;
  return f.misses === 1 && !confirmable.has(key);
}

/** Is this node an UNCONFIRMED single miss awaiting its confirm — and does the
 *  strand still have budget to serve one? Such a node neither caps nor passes;
 *  the search re-serves a fresh item on it. Past the budget it caps instead. */
function nodePending(f: NodeFold, key: string, confirmable: Set<string>): boolean {
  return !f.correct && !f.unknown && f.misses === 1 && confirmable.has(key);
}

/** A strand and the topological order of its nodes (index 0 = most foundational). */
export type StrandOrder = { strand: string; orderedKeys: string[] };

/** The resolved placement for one strand (the seed the engine starts from). */
export type StrandFrontier = {
  strand: string;
  /**
   * The frontier index = the count of leading nodes the scholar is credited for
   * (0 = nothing credited, `n` = whole strand credited).
   */
  frontierIndex: number;
  /** The frontier node (repetition 0, `frontier: true`), or null if the whole strand is credited. */
  frontierKey: string | null;
  /** Nodes strictly below the frontier — credited fluent (trust upward). */
  creditedKeys: string[];
};

/**
 * Topological order of a set of nodes using ONLY the `buildsOn` edges whose
 * endpoints are BOTH in the set (intra-strand prerequisites). Kahn's algorithm;
 * ties (and any nodes touched by no intra-set edge) are broken by the node's
 * `order` field, then by nodeKey — so the result is deterministic and, absent
 * edges, degrades to the pre-computed display order. A cycle (should never happen
 * on the validated DAG) is broken deterministically by falling back to `order`.
 */
export function topoOrderStrand(
  nodes: { nodeKey: string; order?: number }[],
  edges: { fromKey: string; toKey: string }[],
): string[] {
  const keys = nodes.map((n) => n.nodeKey);
  const inSet = new Set(keys);
  const orderOf = new Map(nodes.map((n) => [n.nodeKey, n.order ?? 0]));
  // Deterministic tiebreak: lower `order` first, then nodeKey.
  const tiebreak = (a: string, b: string): number =>
    (orderOf.get(a)! - orderOf.get(b)!) || (a < b ? -1 : a > b ? 1 : 0);

  const indeg = new Map<string, number>(keys.map((k) => [k, 0]));
  const adj = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of edges) {
    if (!inSet.has(e.fromKey) || !inSet.has(e.toKey) || e.fromKey === e.toKey) continue;
    adj.get(e.fromKey)!.push(e.toKey);
    indeg.set(e.toKey, (indeg.get(e.toKey) ?? 0) + 1);
  }

  const out: string[] = [];
  const placed = new Set<string>();
  // Repeatedly emit the tiebreak-smallest node whose prereqs are all placed.
  while (out.length < keys.length) {
    const ready = keys
      .filter((k) => !placed.has(k) && (indeg.get(k) ?? 0) === 0)
      .sort(tiebreak);
    if (ready.length === 0) {
      // Cycle (unexpected): emit the smallest remaining by tiebreak to stay total.
      const remaining = keys.filter((k) => !placed.has(k)).sort(tiebreak);
      const next = remaining[0];
      out.push(next);
      placed.add(next);
      for (const t of adj.get(next) ?? []) indeg.set(t, (indeg.get(t) ?? 1) - 1);
      continue;
    }
    const next = ready[0];
    out.push(next);
    placed.add(next);
    for (const t of adj.get(next) ?? []) indeg.set(t, (indeg.get(t) ?? 1) - 1);
  }
  return out;
}

/** Sentinel strand for nodes that carry no strand (single-track domain). */
export const DEFAULT_PLACEMENT_STRAND = "";

/**
 * Partition a domain's nodes into per-strand topological orders. Nodes with no
 * `strand` collapse into the single `DEFAULT_PLACEMENT_STRAND`, so an unstranded
 * domain degrades to a single binary search over the whole topological order.
 * Strands are returned in a deterministic order (by strand key).
 */
export function strandOrders(
  nodes: { nodeKey: string; strand?: string; order?: number }[],
  edges: { fromKey: string; toKey: string }[],
): StrandOrder[] {
  const byStrand = new Map<string, { nodeKey: string; order?: number }[]>();
  for (const n of nodes) {
    const s = n.strand ?? DEFAULT_PLACEMENT_STRAND;
    const list = byStrand.get(s);
    if (list) list.push(n);
    else byStrand.set(s, [n]);
  }
  return [...byStrand.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((strand) => ({ strand, orderedKeys: topoOrderStrand(byStrand.get(strand)!, edges) }));
}

/**
 * Binary-search bounds `[lo, hi)` on a strand's ordered nodes, reconstructed from
 * observed outcomes (folded by node) and an optional resume floor. Assumes
 * difficulty is monotone in topological order — a pass at index i implies passes
 * below, a confirmed miss implies misses above — and "trusts upward" on any
 * violation:
 *   - `lo` (confirmed-pass boundary) = max over PASSED nodes of (index + 1),
 *     never below `resumeFloor`. A node PASSES if ANY of its outcomes was correct
 *     (a correct answer supersedes an earlier slip). Everything below `lo` is
 *     credited.
 *   - `hi` (lowest CAPPING node) = min over capping nodes of index, but never
 *     at/below `lo` (a higher pass dominates a lower miss → trust upward). A node
 *     caps only when it is CONFIRMED — a "don't know", or a SECOND typed miss. A
 *     single typed miss is a possible slip: it does NOT cap (the search re-serves
 *     the node to confirm; see `nextStrandProbe`).
 * Outcomes for keys not in `orderedKeys` are ignored (cross-strand safety).
 */
function searchBounds(
  orderedKeys: string[],
  outcomes: ProbeOutcome[],
  resumeFloor = 0,
  opts: { gradeOf?: (key: string) => string | undefined; scholarGrade?: string } = {},
): { lo: number; hi: number; hiNoRing: number } {
  const n = orderedKeys.length;
  let lo = Math.max(0, Math.min(resumeFloor, n));
  let hi = ringHi(orderedKeys, outcomes, opts);
  // The SAME ceiling WITHOUT the affect-safe grade ring: bounded only by real
  // confirmed misses (starts at the top of the strand). `hi` caps how HIGH we
  // probe for affect-safety; `hiNoRing` is the true search ceiling — used so a
  // low grade ring can never be mistaken for convergence, and as the relaxed
  // fallback window when the ring excludes every probeable node (below).
  let hiNoRing = n;
  const folds = foldOutcomesByNode(orderedKeys, outcomes);
  const confirmable = confirmableKeys(folds);
  for (const f of folds.values()) {
    if (f.correct) lo = Math.max(lo, f.index + 1);
  }
  for (const [key, f] of folds) {
    // A capping node only lowers the ceiling if it sits ABOVE the confirmed-pass
    // floor; one at/below `lo` is overridden by a higher pass (trust upward). A
    // single unconfirmed miss is NOT a capping node — it awaits its confirm.
    if (nodeCaps(f, key, confirmable) && f.index >= lo) {
      hi = Math.min(hi, f.index);
      hiNoRing = Math.min(hiNoRing, f.index);
    }
  }
  if (hi < lo) hi = lo;
  if (hiNoRing < lo) hiNoRing = lo;
  return { lo, hi, hiNoRing };
}

/**
 * The EFFECTIVE grade cap of the affect-safe ring: scholar grade + 2, expanded
 * by one grade per correct answer at/near the ring top (trust upward). Returns
 * null when the ring doesn't apply (no grade tags, or unknown/unparseable
 * scholar grade) — the search then spans the whole strand.
 */
function ringMaxGrade(
  orderedKeys: string[],
  outcomes: ProbeOutcome[],
  opts: { gradeOf?: (key: string) => string | undefined; scholarGrade?: string },
): number | null {
  const initialMaxGrade = initialAffectSafeMaxGrade(opts.scholarGrade);
  if (!opts.gradeOf || initialMaxGrade === null) return null;

  let maxGrade = initialMaxGrade;
  for (const o of outcomes) {
    if (o.kind !== "correct") continue;
    const i = orderedKeys.indexOf(o.nodeKey);
    if (i < 0) continue;
    const hi = hiForMaxGrade(orderedKeys, opts.gradeOf, maxGrade);
    const ringTop = hi - 1;
    if (hi < orderedKeys.length && i >= ringTop - 1) maxGrade += 1;
  }
  return maxGrade;
}

function initialAffectSafeMaxGrade(
  scholarGrade: string | undefined,
): number | null {
  const scholarRank = scholarGrade ? gradeRank(scholarGrade) : -1;
  return scholarRank < 0 ? null : scholarRank + 2;
}

/**
 * The grade the AUTOMATIC-placement eligibility gate reads (finish-the-check-in,
 * founder 2026-08-18). `domainHasAffectSafeEntry(nodes, undefined)` admits EVERY
 * domain, because the ring is a humane prior and an unknown level must never
 * strand a graph. That was latent while the check-in served one domain at a time;
 * under breadth-first serving it means a scholar with no enrolled grade — which
 * is most of the real roster — opens every graph in the registry at once, up to
 * Algebra 1. So the eligibility seam (and the N-of-M denominator with it) treats
 * a missing or unparseable grade as the MOST RESTRICTIVE real one, the K ring.
 * No new threshold: it reuses the existing grade+2 ring anchored at K.
 *
 * This deliberately does NOT change `domainHasAffectSafeEntry`'s own contract —
 * the search-side ring still degrades open, and a DELIBERATE pick still bypasses
 * the gate entirely and may map any domain.
 */
export const AUTOMATIC_PLACEMENT_FALLBACK_GRADE = "K";

export function automaticPlacementGrade(scholarGrade: string | undefined): string {
  if (scholarGrade === undefined || gradeRank(scholarGrade) < 0) {
    return AUTOMATIC_PLACEMENT_FALLBACK_GRADE;
  }
  return scholarGrade;
}

/**
 * Whether a domain has any node inside a scholar's INITIAL affect-safe ring.
 * Automatic placement may open the domain only when this is true. Missing or
 * unparseable grade data remains eligible: grade is a humane prior, never a
 * reason to strand a graph whose level cannot be determined. (Callers gating
 * AUTOMATIC placement pass `automaticPlacementGrade(...)` above, which resolves
 * the missing case to the K ring before it reaches here.)
 */
export function domainHasAffectSafeEntry(
  nodes: Iterable<{ grade?: string }>,
  scholarGrade: string | undefined,
): boolean {
  const maxGrade = initialAffectSafeMaxGrade(scholarGrade);
  if (maxGrade === null) return true;

  let hasNodes = false;
  for (const node of nodes) {
    hasNodes = true;
    const rank = node.grade ? gradeRank(node.grade) : -1;
    if (rank < 0 || rank <= maxGrade) return true;
  }
  return !hasNodes;
}

function ringHi(
  orderedKeys: string[],
  outcomes: ProbeOutcome[],
  opts: { gradeOf?: (key: string) => string | undefined; scholarGrade?: string },
): number {
  const maxGrade = ringMaxGrade(orderedKeys, outcomes, opts);
  if (maxGrade === null || !opts.gradeOf) return orderedKeys.length;
  return hiForMaxGrade(orderedKeys, opts.gradeOf, maxGrade);
}

function hiForMaxGrade(
  orderedKeys: string[],
  gradeOf: (key: string) => string | undefined,
  maxGrade: number,
): number {
  let hi = 0;
  for (let i = 0; i < orderedKeys.length; i++) {
    const grade = gradeOf(orderedKeys[i]);
    const rank = grade ? gradeRank(grade) : -1;
    // Missing/unparseable tags are within the ring: grade is a humane prior, not
    // a way to strand untagged graph nodes.
    if (rank < 0 || rank <= maxGrade) hi = i + 1;
  }
  return hi;
}

/**
 * The nearest PROBEABLE node to a target index within `[lo, hi)`, searched
 * outward from `target` (ties prefer the lower index — the more conservative,
 * "credit less" choice). Returns null if no probeable node lies in the window.
 */
function nearestProbeable(
  orderedKeys: string[],
  isProbeable: (key: string) => boolean,
  target: number,
  lo: number,
  hi: number,
): number | null {
  for (let d = 0; d <= hi - lo; d++) {
    const lower = target - d;
    if (lower >= lo && lower < hi && isProbeable(orderedKeys[lower])) return lower;
    const upper = target + d;
    if (upper >= lo && upper < hi && isProbeable(orderedKeys[upper])) return upper;
  }
  return null;
}

/**
 * The next node to probe in a strand's adaptive binary search, given the outcomes
 * so far — or null when the search has CONVERGED, no probeable node remains, or
 * the probe cap is reached. The probe is the nearest probeable node to the
 * affect-safe grade-ring midpoint; but the ring NEVER strands a scholar — if it
 * excluded every probeable node in the strand, the search relaxes to the full
 * miss-bounded window and probes the lowest available node. Deterministic + pure.
 *
 * "Confirm before you cap": if a node carries a single UNCONFIRMED miss (a
 * possible slip), that node is re-served FIRST — a fresh item on the same skill —
 * regardless of the per-strand probe budget (`pendingConfirm: true`). A confirm
 * resolves an already-counted node, so it must never be truncated by the cap, and
 * the per-strand budget counts DISTINCT nodes probed (not raw outcomes) so a
 * confirm never eats a narrowing step.
 */
export function nextStrandProbe(
  orderedKeys: string[],
  isProbeable: (key: string) => boolean,
  outcomes: ProbeOutcome[],
  opts: {
    resumeFloor?: number;
    maxProbes?: number;
    firstProbeTarget?: number;
    gradeOf?: (key: string) => string | undefined;
    scholarGrade?: string;
  } = {},
): { probeKey: string; index: number; pendingConfirm: boolean } | null {
  const { resumeFloor = 0, maxProbes = MAX_PROBES_PER_STRAND, firstProbeTarget, gradeOf, scholarGrade } = opts;

  const { lo, hi, hiNoRing } = searchBounds(orderedKeys, outcomes, resumeFloor, { gradeOf, scholarGrade });
  const folds = foldOutcomesByNode(orderedKeys, outcomes);

  // PENDING CONFIRM takes priority over everything: an unconfirmed single miss
  // above the confirmed floor is re-served (a fresh item on the SAME skill) before
  // any new node and BEFORE the probe-cap check — it resolves a node already
  // counted, so the cap must not truncate it. A pending node at/below `lo` is
  // trust-upward-superseded by a higher pass and needs no confirm; one at/above
  // the true ceiling is already below a confirmed cap, so it is left alone too.
  const confirmable = confirmableKeys(folds);
  for (const [key, f] of folds) {
    if (nodePending(f, key, confirmable) && f.index >= lo && f.index < hiNoRing && isProbeable(orderedKeys[f.index])) {
      return { probeKey: orderedKeys[f.index], index: f.index, pendingConfirm: true };
    }
  }

  // Per-strand probe budget: count DISTINCT nodes probed (a confirm re-serves a
  // node already counted, so it never consumes a narrowing step).
  const used = folds.size;
  if (used >= maxProbes) return null;

  // Converged: the confirmed-pass floor has met the true (miss-bounded) ceiling.
  // Uses `hiNoRing`, not `hi`, so a LOW affect-safe grade ring is never mistaken
  // for convergence — the ring caps how HIGH the first probes reach, it must not
  // end the search (that regression left a young scholar with ZERO probes when
  // they entered a domain whose floor sits above their grade+2, e.g. Fractions).
  if (lo >= hiNoRing) return null;

  // Affect-safe FIRST probe (placement v2): on a genuinely fresh strand (no
  // outcomes, no resume floor) aim the first probe at `firstProbeTarget` (anchored
  // to the scholar's grade, or ~1/3 up the strand) instead of the topo midpoint —
  // so a young kid doesn't open on a grade-5 item. The binary search then climbs
  // on correct answers (trust upward — early success beats early failure).
  const target =
    used === 0 && resumeFloor === 0 && firstProbeTarget !== undefined
      ? Math.max(lo, Math.min(firstProbeTarget, hi - 1))
      : lo + Math.floor((hi - lo) / 2);
  // The ring is a PER-NODE predicate, not just the prefix window [lo, hi): a
  // strand's topo order need not be grade-monotone (e.g. a grade-6 origin can
  // sort before a grade-5 node), so an above-ring node can sit INSIDE the
  // window. Skip any node whose own grade exceeds the ring cap when picking a
  // probe; untagged/unparseable nodes stay in-ring (grade is a humane prior,
  // not a way to strand untagged graph nodes).
  const ringMax = ringMaxGrade(orderedKeys, outcomes, { gradeOf, scholarGrade });
  const inRing = (key: string): boolean => {
    if (ringMax === null || !gradeOf) return true;
    const grade = gradeOf(key);
    const rank = grade ? gradeRank(grade) : -1;
    return rank < 0 || rank <= ringMax;
  };
  // Probe the nearest probeable IN-RING node within the affect-safe window [lo, hi)…
  let idx =
    hi > lo
      ? nearestProbeable(orderedKeys, (k) => isProbeable(k) && inRing(k), target, lo, hi)
      : null;
  // …but never STRAND the scholar: when the grade ring excluded every probeable
  // node (the whole strand sits above their grade+2), relax to the full
  // miss-bounded window [lo, hiNoRing) and probe the nearest (lowest) probeable
  // node. Trust-upward then climbs from that gentle floor on correct answers.
  if (idx === null) idx = nearestProbeable(orderedKeys, isProbeable, target, lo, hiNoRing);
  if (idx === null) return null; // nothing probeable left to narrow with
  return { probeKey: orderedKeys[idx], index: idx, pendingConfirm: false };
}

/**
 * The affect-safe FIRST-probe target index for a strand (placement v2). If the
 * scholar's chronological grade is known AND nodes carry grade tags, aim just
 * ABOVE the highest node at/below that grade (trust-upward: start where they
 * likely already are, then climb). When that known grade sits BELOW every tagged
 * node in the strand, start at the FLOOR (index 0) — never above the kid.
 * Otherwise (grade unknown, or the strand carries no grade tags) aim ~1/3 up the
 * strand — deliberately below the midpoint so early failure (which stings a young
 * kid) is rarer than early success. Pure + deterministic.
 */
export function affectSafeFirstProbeIndex(
  orderedKeys: string[],
  opts: { gradeOf?: (key: string) => string | undefined; scholarGrade?: string } = {},
): number {
  const n = orderedKeys.length;
  if (n === 0) return 0;
  const { gradeOf, scholarGrade } = opts;
  if (scholarGrade && gradeOf) {
    const targetRank = gradeRank(scholarGrade);
    if (targetRank >= 0) {
      let highestAtOrBelow = -1;
      let anyTagged = false;
      for (let i = 0; i < n; i++) {
        const g = gradeOf(orderedKeys[i]);
        const r = g ? gradeRank(g) : -1;
        if (r >= 0) anyTagged = true;
        if (r >= 0 && r <= targetRank) highestAtOrBelow = i;
      }
      if (highestAtOrBelow >= 0) return Math.min(highestAtOrBelow + 1, n - 1);
      // A KNOWN grade that sits BELOW every tagged node in this strand: the kid is
      // under the whole strand, so start the search at its FLOOR (index 0), never
      // the generic ~1/3 anchor that would open ABOVE them (findings minimal-fix
      // #4). Only when the strand is actually grade-tagged — an untagged strand
      // carries no grade signal, so it falls through to the ~1/3 anchor below.
      if (anyTagged) return 0;
    }
  }
  return Math.floor(n / 3);
}

/**
 * Finalize a strand's placement from its outcomes (roadmap §3 output): the
 * frontier is the confirmed-pass boundary `lo` (trust upward — everything below
 * is credited, even nodes that were individually missed under a higher pass).
 * `frontierKey` is null when the whole strand is credited. `resumeFloor` carries
 * a previously-confirmed floor across a paused/resumed diagnostic.
 */
export function strandFrontier(
  strand: string,
  orderedKeys: string[],
  outcomes: ProbeOutcome[],
  resumeFloor = 0,
): StrandFrontier {
  const n = orderedKeys.length;
  const { lo } = searchBounds(orderedKeys, outcomes, resumeFloor);
  const frontierIndex = Math.min(lo, n);
  return {
    strand,
    frontierIndex,
    frontierKey: frontierIndex < n ? orderedKeys[frontierIndex] : null,
    creditedKeys: orderedKeys.slice(0, frontierIndex),
  };
}

/**
 * True when a strand's adaptive search has nothing left to ask — either it has
 * converged or no probeable node remains in the open window. Convenience wrapper
 * over `nextStrandProbe` for the Convex "are we done?" check.
 */
export function isStrandConverged(
  orderedKeys: string[],
  isProbeable: (key: string) => boolean,
  outcomes: ProbeOutcome[],
  opts: {
    resumeFloor?: number;
    maxProbes?: number;
    gradeOf?: (key: string) => string | undefined;
    scholarGrade?: string;
  } = {},
): boolean {
  return nextStrandProbe(orderedKeys, isProbeable, outcomes, opts) === null;
}

// ── Legacy grade-anchored placement (retained for placeScholarInternal) ────

export const PLACEMENT_ANCHORS: { grade: string; skillKey: string }[] = [
  { grade: "K", skillKey: "add_within_10" },
  { grade: "1", skillKey: "add_within_20_regroup" },
  { grade: "2", skillKey: "add_2digit_regroup" },
  { grade: "3", skillKey: "mult_facts_3_4_6" },
  { grade: "4", skillKey: "mult_2digit_by_1digit" },
  { grade: "5", skillKey: "mult_2digit_by_2digit" },
];

const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function gradeRank(grade: string): number {
  // Normalize the string SHAPE first ("Grade 2" ≡ "2") so a legacy/seed long-form
  // tag ranks identically to the canonical notch — the single seam that stops a
  // cross-domain prior being skewed by string shape (findings §Profile discrepancy).
  return GRADE_ORDER.indexOf(normalizeGradeTag(grade) ?? grade);
}

/**
 * The higher of two grade tags by rank, treating `undefined` (and any
 * unparseable tag) as "no signal". The cross-domain inference primitive for
 * MIXED multi-domain placement: a completed domain's discovered grade lifts the
 * grade PRIOR (first-probe target + ring ceiling) of the domains still to be
 * probed, so a G3 whole-number placement shortens the fraction probe instead of
 * restarting from zero. Grade is only ever a humane prior here — it moves where
 * the adaptive search STARTS, never what it credits — so nothing this touches
 * becomes green: all placement credit still flows through the normal trust-upward
 * path at source "placement" (inferred, provisional). Pure + deterministic.
 */
export function higherGrade(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return gradeRank(a) >= gradeRank(b) ? a : b;
}

/**
 * The domain's foundational FLOOR grade: the lowest grade tag present on any of
 * its nodes (by rank), or undefined when the domain carries no parseable grade
 * tags. This is the conservative default grade PRIOR for a COLD single-domain
 * entry — a scholar who cold-picks a domain (You-Pick) with NO chronological
 * grade and no cross-domain signal. Feeding the floor as the START grade anchors
 * the affect-safe first probe at the domain's foundation, instead of the blind
 * `~1/3 up the strand` anchor (findings pilot9 #6: a grade-2 kid opened on formal
 * angles). Mirroring the mixed-path start/ceiling split, the floor moves only
 * where the search STARTS; the affect-safe ring CEILING stays tied to the real
 * chronological grade (undefined for a cold pick ⇒ uncapped), so trust-upward can
 * climb a genuinely higher-grade cold-picker to their true level without the
 * conservative prior ever stranding them. Grade is only ever a humane prior — it
 * never changes what the search credits. Pure + deterministic.
 */
export function domainFloorGrade(
  nodes: Iterable<{ grade?: string }>,
): string | undefined {
  let floor: string | undefined;
  let floorRank = Infinity;
  for (const n of nodes) {
    const g = n.grade;
    if (!g) continue;
    const r = gradeRank(g);
    if (r < 0) continue;
    if (r < floorRank) {
      floorRank = r;
      floor = g;
    }
  }
  return floor;
}

/** The grade an anchor skill belongs to (null if it isn't an anchor). */
export function anchorGrade(skillKey: string): string | null {
  return PLACEMENT_ANCHORS.find((a) => a.skillKey === skillKey)?.grade ?? null;
}

/**
 * The placed-through grade: the highest grade for which this anchor AND every
 * lower-grade anchor were answered correctly (contiguous mastery). Returns null
 * when even the lowest anchor is missed (start from the bottom). A scholar who
 * clears K–3 but misses grade 4 places "through 3" → grade-4 frontier.
 *
 * Generous by design (one correct anchor credits the whole grade) — placement
 * trusts upward; any genuinely shaky skill resurfaces via spaced repetition once
 * the scholar actually practices at the frontier.
 */
export function placedThroughGrade(
  results: { grade: string; correct: boolean }[],
): string | null {
  const ordered = [...results].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade));
  let placed: string | null = null;
  for (const r of ordered) {
    if (r.correct) placed = r.grade;
    else break; // first miss stops the contiguous run
  }
  return placed;
}

/**
 * Hard cap on a placement answer's length. Placement answers are numbers /
 * fractions / short expressions, so this comfortably fits any real answer while
 * bounding the stored `answerRaw` — a defense against DB-size blowups from a
 * hostile / oversized answer. Enforced in `submitPlacementAnswer` before
 * storage. (Moved here from the retired placementExplain module when the
 * streamed /placement-explain surface was removed — the deterministic
 * reveal-line floor replaced it.)
 */
export const MAX_PLACEMENT_ANSWER_LEN = 64;

/**
 * Sanitize a scholar-typed placement answer for storage / display: strip control
 * characters (incl. newlines — a legit math answer has none) and hard-cap the
 * length. Returns `undefined` for `undefined` input so callers can keep "no
 * answer was sent" (a Don't-Know) distinct from an empty string.
 */
export function sanitizePlacementAnswer(answer: string | undefined): string | undefined {
  if (answer === undefined) return undefined;
  // Drop ASCII C0/C1 control characters (includes \n, \r, \t) then cap length.
  const stripped = answer.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
  return stripped.slice(0, MAX_PLACEMENT_ANSWER_LEN);
}

/**
 * Hard cap on a snapshotted problem stem (`practiceAttempts.stemSnapshot`).
 * Stems can run longer than a bare answer (a full word-problem sentence), so
 * this cap is generous relative to `MAX_PLACEMENT_ANSWER_LEN` while still
 * bounding storage. Mirrors the ad hoc `.slice(0, 400)` precedent already used
 * for stored-item stems elsewhere in the practice engine.
 */
export const MAX_STEM_SNAPSHOT_LEN = 400;

/**
 * Sanitize a graded item's stem for teacher-only snapshotting on a miss: strip
 * control characters and hard-cap the length, same treatment as
 * `sanitizePlacementAnswer`. Returns `undefined` for `undefined`/empty input.
 */
export function sanitizeStemSnapshot(stem: string | undefined): string | undefined {
  if (!stem) return undefined;
  const stripped = stem.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
  return stripped.slice(0, MAX_STEM_SNAPSHOT_LEN);
}

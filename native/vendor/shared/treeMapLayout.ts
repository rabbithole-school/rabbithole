// The framework-free core of the Map's tree layout, frontier-line math, and
// redacted tree view-model derivation that BOTH surfaces must run identically:
//
//   • web — components/map/MapTreeView.tsx + MapTreeCanvas.tsx (imports
//           @/shared/treeMapLayout through compatibility shims)
//   • native — native's Tree map vendors this file under
//              native/vendor/shared/treeMapLayout.ts; kept in sync by
//              native/scripts/sync-vendor.js, mirroring shared/practiceLoop.ts
//
// Lane 1 (shared/) owns the pure layout and VM semantics; native vendors a
// read-only copy so it renders the SAME columns, lanes, frontier lines, and
// redaction-ready node VMs as web — never a hand-maintained drift copy. This
// module imports nothing so it resolves standalone under Metro when vendored.

/**
 * Compute the longest-prerequisite-path depth for every node in a DAG.
 *
 * Edge convention (mirrors knowledgeNodeEdges): an edge `{ fromKey, toKey }`
 * means "toKey BUILDS ON fromKey" — i.e. fromKey is a direct prerequisite of
 * toKey. Roots (no incoming prerequisites) get depth 0.
 *
 * depth(root) = 0
 * depth(N)    = 1 + max( depth(P) for all direct prerequisites P of N )
 *
 * Memoised recursion: safe because the graph is validated acyclic (a DAG).
 */
export function computeDepths(
  nodeKeys: string[],
  edges: { fromKey: string; toKey: string }[],
): Map<string, number> {
  // prereqsOf[node] = direct prerequisite keys
  const prereqsOf = new Map<string, string[]>();
  for (const key of nodeKeys) prereqsOf.set(key, []);
  for (const e of edges) {
    const list = prereqsOf.get(e.toKey);
    if (list !== undefined) list.push(e.fromKey);
    // edges pointing to unknown keys are silently skipped (cross-domain refs)
  }

  const cache = new Map<string, number>();

  function depth(key: string): number {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const prereqs = prereqsOf.get(key) ?? [];
    const d = prereqs.length === 0 ? 0 : 1 + Math.max(...prereqs.map(depth));
    cache.set(key, d);
    return d;
  }

  for (const key of nodeKeys) depth(key);
  return cache;
}

/**
 * treeMapLayout — the cross-strand longest-path COLUMN layout for the Map's
 * tech-tree skin (roadmap §4; the composed-map v3 spec, verified in
 * review/practice/tree-map-composed-v3.html).
 *
 * COLUMN(node) = max(maxPrereqColumn + 1, prevInStrand.column + 1,
 * gradeAnchorColumn(node.grade), 0), walking all nodes in (depth, key)-
 * ascending order — a valid GLOBAL topological order (a direct edge always has
 * depth(prereq) < depth(dependent)) that is also each strand's own
 * within-strand order. So by the time a node is visited, every prerequisite
 * (any strand) AND its own lane's previous node already have a column. This
 * guarantees:
 *   • every prerequisite is strictly LEFT of its dependent → 0 backwards edges;
 *   • one node per column within a strand → no vertical pile-up;
 *   • basic strands (few cross-strand prereqs, e.g. counting) start at the left,
 *     advanced strands (e.g. number-theory) start far right — a natural gradient;
 *   • a domain whose OWN roots are authored at a later grade (e.g. early-
 *     algebra's "generate terms from a pattern rule" at grade 4) begins at that
 *     grade's column instead of colliding with a grade-K root at column 0 — the
 *     grade anchor is a FLOOR only, so it never re-orders or truncates anything
 *     the prerequisite/strand-chain math above already required (Andy,
 *     2026-07-13 — the Tree Map put "Count to 10" and a grade-4 early-algebra
 *     root at the same x).
 */

const DEFAULT_STRAND = "general";

export type LayoutNode = { skillKey: string; strand?: string | null; grade?: string | null };
export type LayoutEdge = { fromKey: string; toKey: string };

// ── Grade anchoring (the x-axis's PRIMARY signal; topology is the tie-break) ──
// `grade` is a soft K–9 band hint (knowledgeNodes.grade — "not identity"), so
// this is a FLOOR nudging a node's column no earlier than its own grade's
// column band; it never overrides the prerequisite/strand-chain requirement
// above (0 backwards edges stays guaranteed). Mirrors the K..9 order
// convex/lib/practice/placement.ts's `gradeRank` uses for placement, kept as
// an independent copy here (this module imports nothing so native can vendor
// it standalone under Metro).
export const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** K → 0 … 9 → 9; -1 for anything missing or outside the known K–9 set. */
export function gradeRank(grade: string | null | undefined): number {
  if (grade == null) return -1;
  return GRADE_ORDER.indexOf(grade as (typeof GRADE_ORDER)[number]);
}

// Columns of runway reserved per grade band before within-band prerequisite/
// strand chaining takes over. A FLOOR, not a ceiling — a domain's own chain
// freely grows past it (whole-number-arithmetic's own K→6 progression already
// spans ~6 columns/grade at its densest; see
// convex/lib/__tests__/graphGrades.test.ts for the density invariant this
// leans on). Tuned a little above that average so a lightly-populated grade
// band still reads as its own region instead of melting into its neighbour.
export const GRADE_COLUMN_WIDTH = 8;

/**
 * The column FLOOR a node's grade band anchors to, or -Infinity (no anchor —
 * a NO-OP in the Math.max below) when `grade` is missing or unrecognized. An
 * un-graded node is expected — not every node is grade-tagged — so it simply
 * falls back to its domain/strand's pure topological position, exactly as
 * before this change (never crashes, never gets a fabricated grade).
 */
function gradeAnchorColumn(grade: string | null | undefined): number {
  const rank = gradeRank(grade);
  return rank < 0 ? -Infinity : rank * GRADE_COLUMN_WIDTH;
}

// ── Domain-namespaced lanes (the unified all-domains map) ─────────────────────
// On the unified map every domain's strands share one canvas, so a lane must be
// identified by (domain, strand) — two domains BOTH have a "concept"/"operations"
// strand, and they must NOT collapse into one lane. We namespace the strand a
// node is laid out under as `${domain}⟟${strand}`; `computeStrandColumns` then
// treats that composite as the strand, and a `groupOrder` keeps every domain's
// lanes contiguous (one vertical band per domain — the tree analogue of the sky's
// per-domain regions). Single-domain callers pass plain strands and skip all of
// this, so their layout is byte-for-byte unchanged.
export const LANE_SEP = "␟";

export function laneStrand(
  domain: string | null | undefined,
  strand: string | null | undefined,
): string {
  return `${domain ?? ""}${LANE_SEP}${strand ?? DEFAULT_STRAND}`;
}

export function splitLaneStrand(lane: string): { domain: string; strand: string } {
  const i = lane.indexOf(LANE_SEP);
  if (i === -1) return { domain: "", strand: lane };
  return { domain: lane.slice(0, i), strand: lane.slice(i + 1) };
}

// Extra lane-units of vertical space inserted at each DOMAIN boundary on the
// unified map, so a coloured domain header can sit in the gap above each band's
// first strand (and the bands read as distinct regions). Single-domain layouts
// have no boundaries, so their lane spacing is byte-for-byte unchanged.
//
// Was `1` (a single extra unit) — on a many-domain unified map that's only
// marginally more than an ordinary strand-to-strand gap, so the domain header
// floated above the band (a FIXED CSS offset from its own row) could land on
// top of the previous domain's LAST strand label (FTUE M6: "Multiplication &
// Division" clipped behind "FRACTIONS"). Two changes together fix this:
// bumping this constant to `2` widens the boundary gap a bit further without
// meaningfully compressing ordinary in-domain spacing (verified live against
// the unified 7-domain map), and MapTreeCanvas's rail now positions each
// domain header ADAPTIVELY — centred in whatever gap actually renders between
// it and the previous domain's last row, rather than a fixed offset — so the
// header can never land ON TOP of that row regardless of exact lane density.
export const DOMAIN_BAND_GAP = 2;

/**
 * yPct per lane index, distributed across the SAME vertical span [8, 92]
 * (clamped to [6, 94]) that buildTreeVMs / the rail / the frontier line use —
 * but with an extra `gap` lane-units of space inserted wherever the domain
 * changes between adjacent lanes. `laneDomains[i]` is the domain of lane `i`,
 * in lane order (index === lane). With ≤1 lane or a single domain (no
 * boundaries) this reduces EXACTLY to the original uniform formula
 * `8 + (lane / (laneCount - 1)) * 84`, so single-domain layouts don't move.
 */
export function laneYPcts(
  laneDomains: (string | null | undefined)[],
  gap: number = DOMAIN_BAND_GAP,
): number[] {
  const n = laneDomains.length;
  if (n === 0) return [];
  if (n === 1) return [50];
  const pos = new Array<number>(n);
  pos[0] = 0;
  for (let i = 1; i < n; i++) {
    const boundary =
      laneDomains[i] != null &&
      laneDomains[i - 1] != null &&
      laneDomains[i] !== laneDomains[i - 1];
    pos[i] = pos[i - 1] + 1 + (boundary ? gap : 0);
  }
  const total = pos[n - 1] || 1;
  return pos.map((p) => Math.max(6, Math.min(94, 8 + (p / total) * 84)));
}

export type StrandColumnOpts = {
  /** Extract the GROUP a strand belongs to (e.g. its domain), for lane grouping. */
  groupKeyOf?: (strand: string) => string;
  /** Group order (e.g. domain display order); groups sort by this index first. */
  groupOrder?: string[];
};

export type StrandLayout = {
  /** Integer column per node; a prerequisite is ALWAYS in a lower column. */
  columnByKey: Map<string, number>;
  /** Strands present, ordered basic → advanced (ascending min column). */
  strands: string[];
  /** Lane index (0..strands.length-1) for each node, by its strand. */
  laneByKey: Map<string, number>;
  maxColumn: number;
};

export function computeStrandColumns(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts?: StrandColumnOpts,
): StrandLayout {
  const nodeStrand = new Map(nodes.map((n) => [n.skillKey, n.strand ?? DEFAULT_STRAND]));
  const strandOf = (k: string) => nodeStrand.get(k) ?? DEFAULT_STRAND;

  const depths = computeDepths(nodes.map((n) => n.skillKey), edges);

  const preds = new Map<string, string[]>();
  for (const n of nodes) preds.set(n.skillKey, []);
  for (const e of edges) preds.get(e.toKey)?.push(e.fromKey);

  const order = nodes
    .map((n) => n.skillKey)
    .slice()
    .sort((a, b) => (depths.get(a)! - depths.get(b)!) || a.localeCompare(b));

  const nodeGrade = new Map(nodes.map((n) => [n.skillKey, n.grade ?? null]));

  const columnByKey = new Map<string, number>();
  const lastInStrand = new Map<string, string>();
  for (const key of order) {
    const strand = strandOf(key);
    let maxPrereqCol = -1;
    for (const p of preds.get(key) ?? []) {
      maxPrereqCol = Math.max(maxPrereqCol, columnByKey.get(p) ?? -1);
    }
    const prevKey = lastInStrand.get(strand);
    const prevCol = prevKey != null ? (columnByKey.get(prevKey) ?? -1) : -1;
    // Grade anchor is a FLOOR only (see gradeAnchorColumn) — it can only push a
    // column LATER than the prerequisite/strand-chain math requires, never
    // earlier, so "0 backwards edges" is untouched by this term.
    const gradeFloor = gradeAnchorColumn(nodeGrade.get(key));
    columnByKey.set(key, Math.max(maxPrereqCol + 1, prevCol + 1, gradeFloor, 0));
    lastInStrand.set(strand, key);
  }

  // Order strands basic → advanced by their earliest (min) column, stable. When
  // a `groupKeyOf`/`groupOrder` is given (the unified map), strands sort by their
  // GROUP (domain) first, so every domain's strands stay contiguous as one
  // vertical band, ordered basic→advanced within the band.
  const strandMinCol = new Map<string, number>();
  for (const n of nodes) {
    const s = strandOf(n.skillKey);
    const c = columnByKey.get(n.skillKey) ?? 0;
    if (!strandMinCol.has(s) || c < strandMinCol.get(s)!) strandMinCol.set(s, c);
  }
  const groupKeyOf = opts?.groupKeyOf;
  const groupOrder = opts?.groupOrder ?? [];
  const groupRank = (s: string) => {
    if (!groupKeyOf) return 0;
    const i = groupOrder.indexOf(groupKeyOf(s));
    return i === -1 ? groupOrder.length : i;
  };
  const strands = [...strandMinCol.keys()].sort(
    (a, b) =>
      groupRank(a) - groupRank(b) ||
      strandMinCol.get(a)! - strandMinCol.get(b)! ||
      a.localeCompare(b),
  );
  const laneOf = new Map(strands.map((s, i) => [s, i] as const));
  const laneByKey = new Map(
    nodes.map((n) => [n.skillKey, laneOf.get(strandOf(n.skillKey)) ?? 0] as const),
  );

  let maxColumn = 0;
  for (const c of columnByKey.values()) maxColumn = Math.max(maxColumn, c);

  return { columnByKey, strands, laneByKey, maxColumn };
}

/**
 * The leading (lowest-column, i.e. earliest) frontier node per strand — the
 * "trailing edge" of what's already fluent, i.e. what's next in that lane. A
 * strand with no frontier node contributes nothing (no label). Used to label
 * exactly one node per strand.
 */
export function leadingFrontierPerStrand(
  nodes: LayoutNode[],
  columnByKey: Map<string, number>,
  isFrontier: (key: string) => boolean,
): Set<string> {
  const bestByStrand = new Map<string, { key: string; col: number }>();
  for (const n of nodes) {
    if (!isFrontier(n.skillKey)) continue;
    const s = n.strand ?? DEFAULT_STRAND;
    const col = columnByKey.get(n.skillKey) ?? 0;
    const cur = bestByStrand.get(s);
    if (!cur || col < cur.col) bestByStrand.set(s, { key: n.skillKey, col });
  }
  return new Set([...bestByStrand.values()].map((v) => v.key));
}

// ── Frontier LINES (the "how far along am I" boundary, drawn over time) ────────
// The frontier is where mastered work meets not-yet: per lane, the boundary
// between the last contiguous mastered node and the first unmastered one. Drawn
// as a zig-zag connecting every lane's boundary top→bottom. Snapshots at now /
// yesterday / a week ago (from each node's exact becameFluentAt crossing when
// available, with lastPracticedAt as a legacy/placement fallback) let the scholar
// watch the boundary march forward — the map's "what changed" made spatial.

export type FrontierNode = {
  skillKey: string;
  strand?: string | null;
  repetition: number;
  becameFluentAt?: number | null;
  lastPracticedAt: number | null;
};
export type FrontierLinePoint = { xPct: number; yPct: number };
export type FrontierLineKey = "current" | "yesterday" | "weekAgo";
export type FrontierLine = { key: FrontierLineKey; label: string; points: FrontierLinePoint[] };

/**
 * One dashed poly-line per snapshot (current / yesterday / week-ago). Uses the
 * SAME xPct/yPct formulas as `buildTreeVMs`, so the line sits exactly on the
 * node grid. A historical line is OMITTED when it's identical to the current one
 * (nothing moved → nothing to ghost). `fluentReps` is the mastery bar
 * (FLUENT_REPS). The current line uses the live repetition gate. Historical
 * snapshots use becameFluentAt when stamped, otherwise lastPracticedAt for
 * legacy and placement/accelerated rows.
 */
export function computeFrontierLines(
  nodes: FrontierNode[],
  columnByKey: Map<string, number>,
  strands: string[],
  maxColumn: number,
  now: number,
  fluentReps: number,
): FrontierLine[] {
  const laneCount = Math.max(1, strands.length);
  const laneOf = new Map(strands.map((s, i) => [s, i] as const));
  const xOf = (col: number) =>
    Math.max(2, Math.min(98, maxColumn === 0 ? 50 : 6 + (col / maxColumn) * 88));
  // Same domain-gapped lane→yPct mapping as buildTreeVMs / the rail, so the
  // frontier poly-line sits exactly on the node grid across every domain band.
  const yPctByLane = laneYPcts(strands.map((s) => splitLaneStrand(s).domain));
  const yOf = (lane: number) => yPctByLane[lane] ?? 50;

  // Group each lane's node columns (ascending).
  const byLane = new Map<number, {
    col: number;
    repetition: number;
    becameFluentAt: number | null;
    lastPracticedAt: number | null;
  }[]>();
  for (const n of nodes) {
    const lane = laneOf.get(n.strand ?? DEFAULT_STRAND) ?? 0;
    const col = columnByKey.get(n.skillKey) ?? 0;
    const list = byLane.get(lane) ?? [];
    list.push({
      col,
      repetition: n.repetition,
      becameFluentAt: n.becameFluentAt ?? null,
      lastPracticedAt: n.lastPracticedAt,
    });
    byLane.set(lane, list);
  }

  const DAY = 86_400_000;
  const snapshots: { key: FrontierLineKey; label: string; t: number }[] = [
    { key: "current", label: "You are here", t: now },
    { key: "yesterday", label: "Yesterday", t: now - DAY },
    { key: "weekAgo", label: "1 week ago", t: now - 7 * DAY },
  ];

  const linePoints = (t: number, current: boolean): FrontierLinePoint[] => {
    const masteredAt = (n: {
      repetition: number;
      becameFluentAt: number | null;
      lastPracticedAt: number | null;
    }) => {
      if (n.repetition < fluentReps) return false;
      if (current) return true;
      const historicalStamp = n.becameFluentAt ?? n.lastPracticedAt;
      return historicalStamp != null && historicalStamp <= t;
    };

    // Classify each lane. A PARTIAL lane (some mastered, some not) is a HARD
    // anchor — the line notches to its boundary. Fully-mastered / fully-unmastered
    // lanes are SOFT: no bend to hug their edge — the line interpolates through
    // them from the real (partial) anchors. Their boundaryCol is only a fallback
    // used when a snapshot has no partial lane at all.
    type Lane = { lane: number; kind: "partial" | "right" | "left"; boundaryCol: number };
    const laneInfo: Lane[] = [];
    for (let lane = 0; lane < laneCount; lane++) {
      const laneNodes = (byLane.get(lane) ?? []).slice().sort((a, b) => a.col - b.col);
      if (laneNodes.length === 0) continue;
      let fi = laneNodes.findIndex((n) => !masteredAt(n));
      if (fi === -1) fi = laneNodes.length;
      if (fi === 0) {
        laneInfo.push({ lane, kind: "left", boundaryCol: laneNodes[0].col - 0.6 });
      } else if (fi === laneNodes.length) {
        laneInfo.push({ lane, kind: "right", boundaryCol: laneNodes[laneNodes.length - 1].col + 0.6 });
      } else {
        laneInfo.push({ lane, kind: "partial", boundaryCol: (laneNodes[fi - 1].col + laneNodes[fi].col) / 2 });
      }
    }
    if (laneInfo.length === 0) return [];

    const anchors = laneInfo.filter((l) => l.kind === "partial");

    // No partial lane at this snapshot → every lane is fully mastered or fully
    // not-yet. There's no per-lane frontier to trace (a fully-unmastered ADVANCED
    // strand starts far right, so its own left edge is NOT where the frontier is).
    // Draw a single clean vertical at the global mastered↔not-yet boundary.
    if (anchors.length === 0) {
      const rights = laneInfo.filter((l) => l.kind === "right").map((l) => l.boundaryCol);
      const lefts = laneInfo.filter((l) => l.kind === "left").map((l) => l.boundaryCol);
      let fx: number;
      if (rights.length && lefts.length) fx = (Math.max(...rights) + Math.min(...lefts)) / 2;
      else if (rights.length) fx = Math.max(...rights); // all mastered → far right
      else fx = Math.min(...lefts); // all not-yet → at the very start
      return laneInfo.map((l) => ({ xPct: xOf(fx), yPct: yOf(l.lane) }));
    }

    // x (in column units) at a given lane, interpolated between partial anchors
    // (flat beyond the outermost anchors → a straight vertical run, no detour).
    // Soft lanes always follow the anchors — never their own (possibly far-right)
    // edge — so an unmastered advanced strand doesn't yank the line rightward.
    const interpCol = (lane: number): number => {
      if (lane <= anchors[0].lane) return anchors[0].boundaryCol;
      if (lane >= anchors[anchors.length - 1].lane) return anchors[anchors.length - 1].boundaryCol;
      for (let i = 0; i < anchors.length - 1; i++) {
        const a = anchors[i], b = anchors[i + 1];
        if (lane >= a.lane && lane <= b.lane) {
          const f = (lane - a.lane) / (b.lane - a.lane);
          return a.boundaryCol + f * (b.boundaryCol - a.boundaryCol);
        }
      }
      return anchors[anchors.length - 1].boundaryCol;
    };

    return laneInfo.map((l) => {
      // PARTIAL lanes anchor the line; soft lanes just interpolate between the
      // partial anchors (flat beyond them) — no bend to hug a fully-green/grey
      // lane's edge, even if that means the line passes through a uniform region.
      const col = l.kind === "partial" ? l.boundaryCol : interpCol(l.lane);
      return { xPct: xOf(col), yPct: yOf(l.lane) };
    });
  };

  const sameLine = (a: FrontierLinePoint[], b: FrontierLinePoint[]) =>
    a.length === b.length && a.every((p, i) => Math.abs(p.xPct - b[i].xPct) < 0.01);

  const current = linePoints(now, true);
  const lines: FrontierLine[] = [];
  if (current.length > 0) lines.push({ key: "current", label: "You are here", points: current });
  for (const snap of snapshots.slice(1)) {
    const pts = linePoints(snap.t, false);
    // Only ghost a past line if the frontier actually moved since then.
    if (pts.length > 0 && !sameLine(pts, current)) {
      lines.push({ key: snap.key, label: snap.label, points: pts });
    }
  }
  return lines;
}

// "placed" is the PROVISIONAL render state: a node whose credit is access-proven
// (reps ≥ FLUENT_REPS) but INFERRED — its source is not demonstrated (placement /
// accelerated / re-probe), so it must NOT read as the full "fluent" green. The
// two-axis doctrine made visible (rabbithole-practice-engine.md: "Never render
// inferred credit as green"): it's on the scholar's map at this level, not yet
// proven. Derived at render time from the same source rule `isFluent` uses.
//
// "struggling" is the RECENCY-of-failure render state: a node whose most recent
// graded attempts were ≥ STRUGGLING_MISS_THRESHOLD consecutive misses, not yet
// superseded by a later correct answer (`practiceMastery.missStreak`). It is the
// TOP-priority state — it overrides the rep-band derivation, including a stale
// green (a previously-fluent skill just missed twice), because the freshest
// evidence is failure. TEACHER/PARENT-FACING ONLY: `missStreak` is redacted from
// the scholar's own map server-side, so a scholar never derives it (they keep
// seeing amber "frontier"). Distinct from "due" (time-decay, not error) and the
// misconception flag (one classified Ashlock pattern, not generic repeated miss).
export type MasteryState =
  | "locked"
  | "frontier"
  | "placed"
  | "fluent"
  | "overlearned"
  | "struggling";

// Mirror of convex/lib/practice/scheduler.ts STRUGGLING_MISS_THRESHOLD, kept
// local because shared/ must not import from convex/ (same reason FLUENT_REPS is
// duplicated below). The canonical home is the scheduler; keep the two in step.
export const STRUGGLING_MISS_THRESHOLD = 2;

// Structural SUBSET of treeForScholar's node (only what the layout/dial need) —
// so the generated query type flows in without a brittle `as` cast.
export type TreeNode = {
  skillKey: string;
  label: string;
  domain: string;
  strand?: string | null;
  /** Soft K–9 band hint (knowledgeNodes.grade) — the x-axis's grade anchor. */
  grade?: string | null;
  repetition: number;
  becameFluentAt?: number | null;
  lastPracticedAt?: number | null;
  proficiency: "not_started" | "practicing" | "fluent" | "overlearned";
  retention: "fresh" | "due" | "none";
  frontier: boolean;
  /** Whether the credit at this node is DEMONSTRATED (earned through real
   *  practice — source ∈ DEMONSTRATED_SOURCES) rather than an INFERRED credit
   *  (placement / accelerated / re-probe). Derived server-side by the SAME rule
   *  `isFluent` uses for the green claim. Access-proven-but-not-demonstrated
   *  reps render as "placed" (provisional), never the full "fluent" green.
   *  Omitted (legacy/pre-flag callers) reads as demonstrated so nothing that
   *  was green silently goes hollow. */
  demonstrated?: boolean;
  /** Consecutive recent misses on this skill, not yet superseded by a correct
   *  answer (`practiceMastery.missStreak`). At ≥ STRUGGLING_MISS_THRESHOLD the
   *  node renders "struggling" (red). TEACHER/PARENT-FACING: the server omits it
   *  from the scholar's own map, so a scholar-facing node reads undefined → never
   *  struggling. Omitted everywhere it isn't threaded (defaults to not-struggling). */
  missStreak?: number;
};

export type Reading = { nodeKey: string; depth: number; hasOpenMisconception?: boolean };

export type TreeNodeVM = {
  nodeKey: string;
  label: string;
  /** 0..100 plane coords (X from DAG depth, Y barycentric spread). */
  xPct: number;
  yPct: number;
  /** translateZ parallax lane (px, small). */
  z: number;
  mastery: MasteryState;
  /** 0..1 — already redacted (0 hides the arc for parent tier). */
  automaticity: number;
  depth: number;
  frontier: boolean;
  /** The domain this node belongs to — drives the unified map's per-domain rail. */
  domain: string | null;
  /** Human label for the domain (from the server registry) — the rail pill text. */
  domainLabel?: string | null;
  strand: string | null;
  lane: number;
  /** the one permanently-labelled node in its strand (leading frontier). */
  isLeadingFrontier: boolean;
  /** teacher-only; already redacted to false for scholar/parent. */
  flagged: boolean;
};

export type TreeEdgeVM = { fromKey: string; toKey: string };

// ── pure helpers (redaction + reading derivation) ─────────────────────────────

export function masteryOf(n: TreeNode): MasteryState {
  // TOP priority: the freshest evidence is failure. ≥2 consecutive recent misses
  // not yet superseded by a correct answer → "struggling" (red), overriding the
  // rep-band derivation below, INCLUDING a stale green. Safe against a truly
  // fluent skill because a correct answer resets missStreak to 0 (recordAttemptCore),
  // so only a genuinely-wobbling node reaches the bar. Server-redacted from the
  // scholar's own map, so `missStreak` is undefined there and this never fires.
  if ((n.missStreak ?? 0) >= STRUGGLING_MISS_THRESHOLD) return "struggling";
  // ACCESS-proven but INFERRED credit (source not demonstrated) → "placed":
  // it's at this level on the map, but not a green fluency claim. Applies to any
  // fluent-or-better rep band; the derivation mirrors `isFluent`'s source gate
  // (a demonstrated flag threaded from the server) — see MasteryState above.
  const provisional = n.demonstrated === false;
  if (n.proficiency === "overlearned") return provisional ? "placed" : "overlearned";
  if (n.proficiency === "fluent") return provisional ? "placed" : "fluent";
  if (n.proficiency === "practicing" || n.frontier) return "frontier";
  return "locked";
}

/**
 * Automaticity PROXY — treeForScholar doesn't return a raw automaticity/
 * lastPracticedAt, so we approximate from the retention band. The NodeDrawer
 * shows the precise value; this is only the at-a-glance dial arc.
 */
export function automaticityProxy(n: TreeNode): number {
  if (n.retention === "fresh") return 0.85;
  if (n.retention === "due") return 0.3;
  return n.repetition > 0 ? 0.55 : 0;
}

export function buildTreeVMs(
  tree: { nodes: TreeNode[]; edges: TreeEdgeVM[] },
  readings: Reading[],
  audience: "scholar" | "teacher" | "parent",
  domainOrder: string[] = [],
  domainLabels: Record<string, string> = {},
): TreeNodeVM[] {
  // Cross-strand longest-path columns: a prerequisite is ALWAYS in a lower
  // column (0 backwards edges), one node per column within a strand (no
  // pile-up), and basic strands sit left → advanced strands right. Lanes = one
  // horizontal band per (domain, strand). On the unified map the strand a node
  // is laid out under is namespaced by domain (`laneStrand`) + a `groupOrder` so
  // every domain's strands stay contiguous as one vertical band — the tree
  // analogue of the sky's per-domain regions. (roadmap §4; lib/treeMapLayout.)
  const layoutNodes = tree.nodes.map((n) => ({
    skillKey: n.skillKey,
    strand: laneStrand(n.domain, n.strand),
    grade: n.grade ?? null,
  }));
  const { columnByKey, strands, laneByKey, maxColumn } = computeStrandColumns(
    layoutNodes,
    tree.edges,
    { groupKeyOf: (s) => splitLaneStrand(s).domain, groupOrder: domainOrder },
  );
  // Domain-gapped lane→yPct (extra space at each domain boundary on the unified
  // map; a single domain reduces to the old uniform formula). Shared with the
  // rail + frontier line so labels, dots, and the gold line all stay aligned.
  const yPctByLane = laneYPcts(strands.map((s) => splitLaneStrand(s).domain));

  const readingByKey = new Map(readings.map((r) => [r.nodeKey, r]));

  // The only PERMANENTLY-labelled nodes: one leading (earliest) frontier node
  // per (domain, strand) lane — the "trailing edge" of what's fluent there.
  const frontierKeys = new Set(
    tree.nodes.filter((n) => n.frontier).map((n) => n.skillKey),
  );
  const leading = leadingFrontierPerStrand(
    layoutNodes,
    columnByKey,
    (k) => frontierKeys.has(k),
  );

  return tree.nodes.map((n) => {
    const col = columnByKey.get(n.skillKey) ?? 0;
    const lane = laneByKey.get(n.skillKey) ?? 0;
    const xPct = maxColumn === 0 ? 50 : 6 + (col / maxColumn) * 88;
    const yPct = yPctByLane[lane] ?? 50;

    const reading = readingByKey.get(n.skillKey);
    const tier1 = audience === "parent"; // TIER_1: mastery/frontier only
    // Belt & braces: "struggling" (red) is teacher/parent-facing. The server
    // already omits missStreak from the scholar's own map, but if a scholar-audience
    // node ever carries it, zero it here so it can only ever derive to the amber
    // "frontier"/rep-band state a scholar is meant to see (never a red deficit mark).
    const nn = audience === "scholar" ? { ...n, missStreak: undefined } : n;
    return {
      nodeKey: n.skillKey,
      label: n.label,
      xPct: Math.max(2, Math.min(98, xPct)),
      yPct: Math.max(6, Math.min(94, yPct)),
      z: 0,
      domain: n.domain,
      domainLabel: domainLabels[n.domain] ?? n.domain,
      strand: n.strand ?? null,
      lane,
      mastery: masteryOf(nn),
      // redaction: parent tier zeroes the detail arcs (dial has no arc tracks,
      // so 0 renders as "no arc" — only the mastery dot + frontier glow remain)
      automaticity: tier1 ? 0 : automaticityProxy(n),
      depth: tier1 ? 0 : reading?.depth ?? 0,
      frontier: n.frontier,
      isLeadingFrontier: leading.has(n.skillKey),
      // misconception flags are teacher-only AND server-redacted; belt & braces
      flagged: audience === "teacher" && !!reading?.hasOpenMisconception,
    };
  });
}

// FLUENT_REPS is the mastery bar; treeForScholar returns raw repetition so the
// frontier-line math stays a pure client computation.
export const FLUENT_REPS = 3;

/**
 * The frontier poly-lines (current + moved-since ghosts) for the tree, using the
 * SAME column layout as buildTreeVMs. Empty until the scholar has practiced
 * enough for a boundary to exist. Separate from buildTreeVMs so the canvas can
 * take it as its own prop.
 */
export function buildFrontierLines(
  tree: { nodes: TreeNode[]; edges: TreeEdgeVM[] },
  now: number,
  domainOrder: string[] = [],
): FrontierLine[] {
  // Same domain-namespaced lanes + group order as buildTreeVMs, so the frontier
  // poly-line sits exactly on the node grid across every domain band.
  const layoutNodes = tree.nodes.map((n) => ({
    skillKey: n.skillKey,
    strand: laneStrand(n.domain, n.strand),
    grade: n.grade ?? null,
  }));
  const { columnByKey, strands, maxColumn } = computeStrandColumns(
    layoutNodes,
    tree.edges,
    { groupKeyOf: (s) => splitLaneStrand(s).domain, groupOrder: domainOrder },
  );
  return computeFrontierLines(
    tree.nodes.map((n) => ({
      skillKey: n.skillKey,
      strand: laneStrand(n.domain, n.strand),
      repetition: n.repetition,
      becameFluentAt: n.becameFluentAt ?? null,
      lastPracticedAt: n.lastPracticedAt ?? null,
    })),
    columnByKey,
    strands,
    maxColumn,
    now,
    FLUENT_REPS,
  );
}

export type GradeRulerTick = { grade: string; xPct: number };

/**
 * The top-of-map grade ruler (K · 1 · 2 · … 8) — one tick per grade band
 * actually present among the tree's nodes, positioned at the LEFTMOST column
 * any node of that grade landed on (after grade anchoring), via the SAME xOf
 * formula buildTreeVMs uses, so a tick sits exactly above its band's leading
 * edge. Purely derived from the tree's own nodes/edges — no separate prop to
 * keep in sync. Labels CONTENT (a grade band), never a scholar — no "you are
 * behind" framing; see .claude/rules/visual-design.md.
 */
export function computeGradeRuler(
  tree: { nodes: TreeNode[]; edges: TreeEdgeVM[] },
  domainOrder: string[] = [],
): GradeRulerTick[] {
  const layoutNodes = tree.nodes.map((n) => ({
    skillKey: n.skillKey,
    strand: laneStrand(n.domain, n.strand),
    grade: n.grade ?? null,
  }));
  const { columnByKey, maxColumn } = computeStrandColumns(layoutNodes, tree.edges, {
    groupKeyOf: (s) => splitLaneStrand(s).domain,
    groupOrder: domainOrder,
  });
  // Same xOf as buildTreeVMs's xPct derivation, so a tick lines up exactly
  // with the columns its grade's nodes actually render in.
  const xOf = (col: number) =>
    Math.max(2, Math.min(98, maxColumn === 0 ? 50 : 6 + (col / maxColumn) * 88));

  const minColByGrade = new Map<string, number>();
  for (const n of tree.nodes) {
    if (!n.grade) continue; // ungraded nodes don't anchor a tick
    const col = columnByKey.get(n.skillKey) ?? 0;
    const cur = minColByGrade.get(n.grade);
    if (cur === undefined || col < cur) minColByGrade.set(n.grade, col);
  }

  return GRADE_ORDER.filter((g) => minColByGrade.has(g)).map((g) => ({
    grade: g,
    xPct: xOf(minColByGrade.get(g)!),
  }));
}

// ── Checkpoint markers (strand × grade milestones) ────────────────────────────
// A checkpoint is a NAMED milestone at a strand × grade boundary: "grade N of
// this strand is done." It is NOT a knowledgeNode and never carries mastery of
// its own — it is an AGGREGATE READING over the grade-N nodes in a strand,
// rendered as a positioned sibling in the lane (the same architectural shape as
// the grade ruler + frontier line: derived purely from the tree the map already
// loads, no table, no per-scholar row, no serving path). See
// review/practice/strand-checkpoints-plan.html §6 Option A.
//
// The ONLY new signal it adds over the existing map is the grade-level
// AGGREGATION: a band "certifies" when EVERY grade-N node in the strand is
// DEMONSTRATED-green (masteryOf ∈ {fluent, overlearned} — inferred "placed"
// credit deliberately does NOT count, mirroring `isFluent`'s green claim), so
// it can never re-render an un-proven placement as a milestone.

export type CheckpointStatus = "certified" | "in_progress" | "not_started";

export type CheckpointMarker = {
  /** Stable id: `${domain}␟${strand}␟g${grade}` (survives re-layout). */
  id: string;
  domain: string;
  /** Raw strand (not lane-namespaced) — for the human label. */
  strand: string | null;
  /** The grade band this checkpoint certifies ("K".."8"). */
  grade: string;
  /** Lane index (row) — same lane math as buildTreeVMs, so it sits in-lane. */
  lane: number;
  /** 0..100 plane coords, same xOf/yPct formulas as buildTreeVMs. */
  xPct: number;
  yPct: number;
  status: CheckpointStatus;
  /** Demonstrated-green nodes in the band. */
  solid: number;
  /** Total nodes in the band. */
  total: number;
};

// A single grade-tagged skill is not a "grade level" worth certifying — a
// checkpoint needs a band of at least this many nodes. Bands below it are
// omitted so lightly-populated grades (e.g. a lone probability node) don't
// scatter meaningless gates across a lane.
export const MIN_CHECKPOINT_BAND = 2;

/**
 * One checkpoint marker per (strand × grade) band present in the tree (bands
 * with fewer than MIN_CHECKPOINT_BAND nodes omitted), positioned at the band's
 * RIGHT edge — the boundary between the last node of grade N and the first of
 * grade N+1 — using the SAME column/lane/yPct layout as buildTreeVMs so the
 * marker sits exactly on the node grid. Purely derived from the tree's nodes +
 * their mastery; no separate prop to keep in sync.
 *
 * `status` is a pure aggregate read: `certified` when every node in the band is
 * demonstrated-green, `in_progress` once at least one is, else `not_started`.
 * Callers choose which statuses to SHOW (the map hides `not_started` future
 * gates; a teacher/parent index may list them).
 */
export function computeCheckpointMarkers(
  tree: { nodes: TreeNode[]; edges: TreeEdgeVM[] },
  domainOrder: string[] = [],
): CheckpointMarker[] {
  const layoutNodes = tree.nodes.map((n) => ({
    skillKey: n.skillKey,
    strand: laneStrand(n.domain, n.strand),
    grade: n.grade ?? null,
  }));
  const { columnByKey, strands, maxColumn } = computeStrandColumns(layoutNodes, tree.edges, {
    groupKeyOf: (s) => splitLaneStrand(s).domain,
    groupOrder: domainOrder,
  });
  const laneOf = new Map(strands.map((s, i) => [s, i] as const));
  const yPctByLane = laneYPcts(strands.map((s) => splitLaneStrand(s).domain));
  // Same xOf as buildTreeVMs's xPct derivation.
  const xOf = (col: number) =>
    Math.max(2, Math.min(98, maxColumn === 0 ? 50 : 6 + (col / maxColumn) * 88));

  type Band = {
    lane: number;
    domain: string;
    strand: string | null;
    grade: string;
    solid: number;
    total: number;
    maxCol: number;
  };
  const bands = new Map<string, Band>();
  for (const n of tree.nodes) {
    if (!n.grade) continue; // ungraded nodes don't belong to a grade band
    const lane = laneStrand(n.domain, n.strand);
    const key = `${lane}${LANE_SEP}${n.grade}`;
    const col = columnByKey.get(n.skillKey) ?? 0;
    const m = masteryOf(n); // the SAME green rule the node dots use
    const green = m === "fluent" || m === "overlearned";
    const b =
      bands.get(key) ??
      {
        lane: laneOf.get(lane) ?? 0,
        domain: n.domain,
        strand: n.strand ?? null,
        grade: n.grade,
        solid: 0,
        total: 0,
        maxCol: -Infinity,
      };
    b.total += 1;
    if (green) b.solid += 1;
    if (col > b.maxCol) b.maxCol = col;
    bands.set(key, b);
  }

  const markers: CheckpointMarker[] = [];
  for (const [, b] of bands) {
    if (b.total < MIN_CHECKPOINT_BAND) continue;
    const status: CheckpointStatus =
      b.solid === 0 ? "not_started" : b.solid >= b.total ? "certified" : "in_progress";
    markers.push({
      id: `${b.domain}${LANE_SEP}${b.strand ?? DEFAULT_STRAND}${LANE_SEP}g${b.grade}`,
      domain: b.domain,
      strand: b.strand,
      grade: b.grade,
      lane: b.lane,
      // Just to the right of the band's last node — the grade boundary.
      xPct: xOf(b.maxCol + 0.6),
      yPct: Math.max(6, Math.min(94, yPctByLane[b.lane] ?? 50)),
      status,
      solid: b.solid,
      total: b.total,
    });
  }
  // Stable order: top-to-bottom lane, then grade.
  markers.sort((a, b) => a.lane - b.lane || gradeRank(a.grade) - gradeRank(b.grade));
  return markers;
}

/** Smooth an open polyline that PASSES THROUGH every point (so the frontier sits
 *  exactly on each lane's between-nodes boundary). Uses ONE Catmull-Rom tangent
 *  per point (so it's C1 — no cusps) whose X component is clamped so neither
 *  control point leaves that point's adjacent segment X-range. Result: a clean
 *  curve that stays in the between-nodes corridor (never bulges onto a node) and,
 *  at a left↔right reversal, simply eases through vertically — no sharp corner and
 *  no overshoot. */
export function smoothPath(p: { sx: number; sy: number }[]): string {
  const n = p.length;
  if (n === 0) return "";
  if (n === 1) return `M${p[0].sx.toFixed(1)},${p[0].sy.toFixed(1)}`;
  // Catmull-Rom tangents (one-sided at the ends).
  const m = p.map((_, i) => {
    const a = p[Math.max(0, i - 1)];
    const b = p[Math.min(n - 1, i + 1)];
    return { x: (b.sx - a.sx) / 2, y: (b.sy - a.sy) / 2 };
  });
  // Clamp each tangent's X so the outgoing control (p[i].x + tx/3) and incoming
  // control (p[i].x − tx/3) both stay within their segment's X-range. Clamping
  // the single tangent (not the two controls independently) preserves C1: at a
  // reversal the ranges meet at 0 → the tangent goes vertical, smoothly.
  for (let i = 0; i < n; i++) {
    let lo = -Infinity, hi = Infinity;
    if (i < n - 1) { const d = 3 * (p[i + 1].sx - p[i].sx); lo = Math.max(lo, Math.min(0, d)); hi = Math.min(hi, Math.max(0, d)); }
    if (i > 0) { const d = 3 * (p[i].sx - p[i - 1].sx); lo = Math.max(lo, Math.min(0, d)); hi = Math.min(hi, Math.max(0, d)); }
    m[i].x = Math.max(lo, Math.min(hi, m[i].x));
  }
  let d = `M${p[0].sx.toFixed(1)},${p[0].sy.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = p[i].sx + m[i].x / 3, c1y = p[i].sy + m[i].y / 3;
    const c2x = p[i + 1].sx - m[i + 1].x / 3, c2y = p[i + 1].sy - m[i + 1].y / 3;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p[i + 1].sx.toFixed(1)},${p[i + 1].sy.toFixed(1)}`;
  }
  return d;
}

// ── The left rail's strand tier: does it still fit? ──────────────────────────
//
// The rail carries two levels — an ALL-CAPS DOMAIN header per band and a
// Title-Case STRAND pill per lane. Zoomed out, the lanes render only a few px
// apart and every strand pill lands on top of its neighbours: an unreadable
// stack of half-occluded words down the left edge (Andy, 2026-08-19, iPad).
// Overlap is not a lesser rendering of the same information — it destroys it —
// so the strand TIER drops out wholesale and the domain headers, which are far
// fewer and stay legible, carry the rail alone until there is room again.
//
// Shared because both surfaces must make the same call at the same density:
// web (components/map/MapTreeCanvas.tsx, per rAF frame) and native
// (native/src/components/tree/TreeMapNative.tsx, per camera settle).

/** The text half of a strand pill's height: 10px on a 1.4 line. This is the
 *  ONLY part that follows a surface's label scale — a caller that enlarges its
 *  labels multiplies THIS and adds the chrome below, rather than scaling the
 *  whole allowance (padding and borders are fixed px, so scaling them too
 *  hides the tier while there is still room — cross-model review, 2026-08-19). */
export const STRAND_RAIL_ROW_TEXT_PX = 14;
/** The rest of a strand pill: 2px padding top and bottom + hairline borders,
 *  plus a few px of air. Fixed regardless of type scale. */
export const STRAND_RAIL_ROW_CHROME_PX = 10;
/** A strand pill's full height at label scale 1. */
export const STRAND_RAIL_ROW_MIN_PX =
  STRAND_RAIL_ROW_TEXT_PX + STRAND_RAIL_ROW_CHROME_PX;

/**
 * Is there room for the rail's strand tier?
 *
 * @param rowsScreenPx each rail row's vertical position in SCREEN px (i.e.
 *   already through the camera) — content-space coordinates would answer a
 *   question about the model, not about what the eye can read.
 * @param minRowPx the caller's own strand-pill height + air.
 */
export function railStrandsFit(
  rowsScreenPx: readonly number[],
  minRowPx: number = STRAND_RAIL_ROW_MIN_PX,
): boolean {
  if (rowsScreenPx.length < 2) return true;
  let gap = Infinity;
  for (let i = 1; i < rowsScreenPx.length; i++) {
    gap = Math.min(gap, Math.abs(rowsScreenPx[i] - rowsScreenPx[i - 1]));
  }
  // `!(gap < min)` not `gap >= min`: a NaN row (a not-yet-measured layout)
  // must not silently hide the tier.
  return !(gap < minRowPx);
}

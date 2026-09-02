/**
 * PURE renderer for the weekly digest's qualitative "Stories" section.
 *
 * The Convex query (practiceDigest.ts → storyDigestSnapshot) hands this module
 * plain rows read off `knowledgeNodeEdges.story` + `crossDomainConnections` +
 * `knowledgeNodes` labels. This module does NO reads, NO writes, and NO model
 * calls; it windows/classifies those rows and renders a calm Slack-mrkdwn block.
 *
 * QUALITATIVE-FIRST by design: at pilot N, transcripts are the signal and rates
 * are noise. Everything here is a read-the-transcript pointer for a teacher — a
 * story a scholar just brushed up against, not a metric. There are deliberately
 * no percentages, no per-scholar "engagement" scores, and no learner-vs-learner
 * comparison.
 *
 * Three parts:
 *   1. Registry deltas — story edges created/edited in the window, grouped by
 *      provenance, as `hook — fromLabel→toLabel` one-liners (not full narratives).
 *   2. Story-adjacent leaps — crossDomainConnections in the window whose
 *      concept labels / domains fuzzy-match a story edge's near/far label. These
 *      are the core qualitative signal: "this scholar wandered next to a story".
 *   3. Curation state — one line: story-edge totals by provenance + the count of
 *      story-less curated bridge tombstones (teacher-removed stories).
 */

export type StoryProvenance = "registry" | "generated" | "authored";

const PROVENANCE_ORDER: StoryProvenance[] = ["registry", "generated", "authored"];

/** One story-bearing bridge edge, with its endpoints resolved to node labels. */
export interface StoryEdgeInput {
  hook: string;
  provenance: StoryProvenance;
  fromKey: string;
  fromLabel: string;
  toKey: string;
  toLabel: string;
  // The edge's own creation time (`_creationTime`) — a NEW story this window.
  createdAt: number;
  // `story.updatedAt` — an EDIT this window (validateStory stamps it on every
  // write). Null on legacy rows that predate the field.
  updatedAt: number | null;
}

/** One crossDomainConnection, teacher-facing, ready for fuzzy matching. */
export interface StoryConnectionInput {
  scholarName: string;
  description: string;
  conceptLabels: string[];
  domains: string[];
  createdAt: number;
}

export interface StoryDigestInput {
  now: number;
  since: number;
  storyEdges: StoryEdgeInput[];
  connections: StoryConnectionInput[];
  // Story-less curated bridges — the durable tombstones a teacher's story
  // removal leaves behind (see edgeStories.coreRemove). Counted in the query.
  tombstoneCount: number;
}

export interface StoryDigestSection {
  text: string;
  deltaCount: number;
  leapCount: number;
  tombstoneCount: number;
}

const PROVENANCE_LABEL: Record<StoryProvenance, string> = {
  registry: "registry",
  generated: "generated",
  authored: "authored",
};

function inWindow(ts: number | null | undefined, since: number, now: number): ts is number {
  return typeof ts === "number" && ts >= since && ts <= now;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Meaningful tokens only (>=4 chars) — drops "the"/"of"/"a" so overlap is real. */
function meaningfulTokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length >= 4);
}

/**
 * Normalized-substring OR meaningful-token-overlap match — precision over
 * recall. Whole-phrase containment (either direction) catches "modular
 * arithmetic" ↔ "arithmetic, modular"; a shared >=4-char token catches
 * "cicada" ↔ "cicada life cycles". Short/generic strings can't spuriously match.
 */
export function fuzzyLabelMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  const ta = new Set(meaningfulTokens(a));
  if (ta.size === 0) return false;
  for (const t of meaningfulTokens(b)) {
    if (ta.has(t)) return true;
  }
  return false;
}

/**
 * Does this connection wander next to `edge`? True when any of the connection's
 * concept labels or domains fuzzy-matches the story's near (fromLabel) or far
 * (toLabel) endpoint.
 */
function connectionNeighborsEdge(
  conn: StoryConnectionInput,
  edge: StoryEdgeInput,
): boolean {
  const anchors = [edge.fromLabel, edge.toLabel];
  const candidates = [...conn.conceptLabels, ...conn.domains];
  for (const anchor of anchors) {
    for (const cand of candidates) {
      if (fuzzyLabelMatch(cand, anchor)) return true;
    }
  }
  return false;
}

function oneLiner(edge: StoryEdgeInput): string {
  return `*${edge.hook}* — _${edge.fromLabel}→${edge.toLabel}_`;
}

function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Render the qualitative Stories block. Deterministic; if nothing landed in the
 * window it collapses to a single quiet line rather than an empty scaffold.
 */
export function computeStoryDigestSection(input: StoryDigestInput): StoryDigestSection {
  const { now, since, storyEdges, connections, tombstoneCount } = input;

  // ── 1. Registry deltas: created OR edited in-window, grouped by provenance ──
  const deltas = storyEdges.filter(
    (e) => inWindow(e.createdAt, since, now) || inWindow(e.updatedAt, since, now),
  );
  const deltasByProvenance = new Map<StoryProvenance, StoryEdgeInput[]>();
  for (const e of deltas) {
    const list = deltasByProvenance.get(e.provenance) ?? [];
    list.push(e);
    deltasByProvenance.set(e.provenance, list);
  }

  // ── 2. Story-adjacent leaps: in-window connections neighboring a story ──
  // Precision over recall: a connection is reported once, tagged with the FIRST
  // story it neighbors (edges are considered in a stable order).
  const windowConnections = connections.filter((c) => inWindow(c.createdAt, since, now));
  const leaps: { scholarName: string; description: string; nearHook: string }[] = [];
  for (const conn of windowConnections) {
    for (const edge of storyEdges) {
      if (connectionNeighborsEdge(conn, edge)) {
        leaps.push({
          scholarName: conn.scholarName,
          description: conn.description,
          nearHook: edge.hook,
        });
        break;
      }
    }
  }

  // ── 3. Curation state: story totals by provenance + tombstones ──
  const totalsByProvenance = new Map<StoryProvenance, number>();
  for (const e of storyEdges) {
    totalsByProvenance.set(e.provenance, (totalsByProvenance.get(e.provenance) ?? 0) + 1);
  }
  const totalStories = storyEdges.length;

  const empty = deltas.length === 0 && leaps.length === 0;

  const lines: string[] = ["📚 *Stories*"];

  if (empty) {
    // Quiet window: one calm line, not an empty scaffold. The curation totals
    // still give a durable-corpus heartbeat.
    const totalsBits = PROVENANCE_ORDER.filter((p) => (totalsByProvenance.get(p) ?? 0) > 0).map(
      (p) => `${totalsByProvenance.get(p) ?? 0} ${PROVENANCE_LABEL[p]}`,
    );
    const corpus =
      totalStories > 0
        ? ` (${pluralize(totalStories, "story edge", "story edges")}${
            totalsBits.length > 0 ? ` — ${totalsBits.join(", ")}` : ""
          }${tombstoneCount > 0 ? `, ${tombstoneCount} removed` : ""} in the corpus)`
        : "";
    lines.push(`_No new stories and no story-adjacent leaps this week${corpus}._`);
    return {
      text: lines.join("\n"),
      deltaCount: 0,
      leapCount: 0,
      tombstoneCount,
    };
  }

  // Registry deltas
  if (deltas.length > 0) {
    lines.push(`_New & edited stories (${deltas.length}):_`);
    for (const p of PROVENANCE_ORDER) {
      const list = deltasByProvenance.get(p);
      if (!list || list.length === 0) continue;
      lines.push(`  *${PROVENANCE_LABEL[p]}*`);
      for (const e of list) lines.push(`  • ${oneLiner(e)}`);
    }
  }

  // Story-adjacent leaps — the core qualitative signal (read-the-transcript
  // pointers, not metrics).
  if (leaps.length > 0) {
    lines.push(`_Story-adjacent leaps (${leaps.length}) — worth reading the transcript:_`);
    for (const leap of leaps) {
      lines.push(`  • *${leap.scholarName}*: ${leap.description} _(near: ${leap.nearHook})_`);
    }
  }

  // (serves funnel lands with tutor-side story integration) — once a serving
  // surface exists, per-serve outcomes (served → hooked → probed → leapt) slot
  // in HERE as a fourth subsection, keyed off the same story edges. No serve
  // logging is built yet, so there is nothing to render.

  // Curation state — one line.
  const totalsBits = PROVENANCE_ORDER.filter((p) => (totalsByProvenance.get(p) ?? 0) > 0).map(
    (p) => `${totalsByProvenance.get(p) ?? 0} ${PROVENANCE_LABEL[p]}`,
  );
  lines.push(
    `_Curation: ${pluralize(totalStories, "story edge", "story edges")}${
      totalsBits.length > 0 ? ` (${totalsBits.join(", ")})` : ""
    }; ${pluralize(tombstoneCount, "removed-story tombstone", "removed-story tombstones")}._`,
  );

  return {
    text: lines.join("\n"),
    deltaCount: deltas.length,
    leapCount: leaps.length,
    tombstoneCount,
  };
}

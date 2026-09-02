// ─── Bloom rigor: where a scholar lands relative to a standard's OWN bar ──────
//
// Option C of the Knowledge-Tree depth design (review/knowledge-tree-depth-
// automaticity.html §3): instead of an invented mastery %, colour a cell/node
// by whether the scholar has MET or gone BEYOND the rigor the standard itself
// asks for — its expected Bloom verb. Four stops, gray → yellow → green → blue;
// the goal is to "turn the squares blue".
//
//   gray   "not yet"      no evidence
//   yellow "approaching"  demonstrated below the standard's expected level
//   green  "met"          demonstrated at the standard's expected level
//   blue   "beyond"       demonstrated past it (earned, not a branded >100%)
//
// `expectedBloomForStandard` derives the bar deterministically from the
// standard's wording (its strongest cognitive-demand verb) — "mostly derivable
// in a one-time pass", computed live here so the view needs no LLM tagging or
// schema migration. It's approximate by design; a teacher override could refine
// it later.

export type BloomStop = "notyet" | "approaching" | "met" | "beyond";

// Verb → Bloom level (0 Remember … 5 Create). Scanned against the standard's
// description; the HIGHEST level matched wins (a standard asking to "analyze and
// explain" expects Analyze). CCSS/NGSS phrasing leans on these stems.
const VERB_BLOOM: Array<{ level: number; verbs: string[] }> = [
  { level: 5, verbs: ["create", "design", "construct", "develop", "compose", "generate", "produce", "formulate", "invent", "build", "plan a", "write an? (?:argument|narrative|opinion|story|poem|essay)", "model "] },
  { level: 4, verbs: ["evaluate", "assess", "critique", "judge", "justify", "argue", "defend", "prove", "appraise", "support .* claim", "make a logical argument"] },
  { level: 3, verbs: ["analyze", "compare", "contrast", "examine", "investigate", "categorize", "classify", "differentiate", "distinguish", "draw .* conclusion", "infer", "decompose", "relate", "explain why", "explain how"] },
  { level: 2, verbs: ["apply", "solve", "use ", "calculate", "compute", "multiply", "divide", "add ", "subtract", "convert", "determine", "estimate", "measure", "demonstrate", "represent", "graph", "round", "find ", "fluently"] },
  { level: 1, verbs: ["explain", "describe", "summarize", "interpret", "illustrate", "understand", "give .* example", "retell", "ask and answer", "demonstrate understanding"] },
  { level: 0, verbs: ["recall", "name", "list", "recognize", "label", "state", "define", "count", "read ", "identify", "locate", "know "] },
];

const DEFAULT_EXPECTED = 2; // CCSS default leans on application

export function expectedBloomForStandard(description: string): number {
  const text = ` ${description.toLowerCase()} `;
  let best = -1;
  for (const { level, verbs } of VERB_BLOOM) {
    if (level <= best) continue;
    for (const v of verbs) {
      // word-boundary-ish match; the verbs already include trailing context.
      const re = new RegExp(`\\b${v}`, "i");
      if (re.test(text)) {
        best = level;
        break;
      }
    }
  }
  return best >= 0 ? best : DEFAULT_EXPECTED;
}

// Classify a demonstrated Bloom level against the standard's expected bar.
// `demonstrated` is the 0–5 mastery level; `expected` is the standard's bar.
// null demonstrated → not yet evidenced.
export function fourStop(demonstrated: number | null | undefined, expected: number): BloomStop {
  if (demonstrated === null || demonstrated === undefined) return "notyet";
  if (demonstrated >= expected + 0.5) return "beyond";
  if (demonstrated >= expected - 0.5) return "met";
  return "approaching";
}

// Roll a band's per-standard stops into the cell's overall stop: the strongest
// stop a clear plurality reaches, by comparing the band's AVERAGE demonstrated
// to its average expected. (The ring carries the full spread; this is just the
// cell's headline colour.)
export function cellStop(avgDemonstrated: number | null, avgExpected: number): BloomStop {
  return fourStop(avgDemonstrated, avgExpected);
}

// ─── Band summary: the ONE place a (strand, grade) band's headline is computed ─
//
// The grid cell number AND the drawer's distribution ring are the SAME metric —
// derive both from this so they can never drift apart again. A band is just a
// list of its standards, each with the scholar's demonstrated level (undefined =
// no evidence yet) and the standard's own expected bar.

export type BandStandard = { demonstrated: number | undefined; expected: number };

export type BandSummary = {
  /** Every grade-specific leaf standard in the band. */
  total: number;
  /** Standards with any evidence (demonstrated !== undefined). */
  evidenced: number;
  /** The four-stop spread across ALL the band's standards (drives the ring). */
  dist: Record<BloomStop, number>;
  /**
   * THE headline: % of the band's standards met-or-beyond their own bar, over
   * ALL standards (goal 100%). The grid cell number and the ring both show this.
   */
  coveragePct: number;
  /**
   * The band's four-stop COLOUR — where the scholar's reached (evidenced) work
   * averages relative to those standards' bars. Orthogonal to coveragePct
   * (depth-of-what's-touched vs breadth-of-coverage); `notyet` when unevidenced.
   */
  stop: BloomStop;
};

export function summarizeBand(standards: BandStandard[]): BandSummary {
  const dist: Record<BloomStop, number> = { notyet: 0, approaching: 0, met: 0, beyond: 0 };
  let evidenced = 0;
  let sumDemonstrated = 0;
  let sumExpected = 0;
  for (const s of standards) {
    dist[fourStop(s.demonstrated ?? null, s.expected)]++;
    if (s.demonstrated !== undefined) {
      evidenced++;
      sumDemonstrated += s.demonstrated;
      sumExpected += s.expected;
    }
  }
  const total = standards.length;
  const coveragePct = total === 0 ? 0 : Math.round(((dist.met + dist.beyond) / total) * 100);
  const stop: BloomStop = evidenced === 0 ? "notyet" : cellStop(sumDemonstrated / evidenced, sumExpected / evidenced);
  return { total, evidenced, dist, coveragePct, stop };
}

/**
 * The manipulative catalog — ONE code-owned index of every manipulative kind,
 * derived from the closed `ManipulativeKind` union so a new mechanic cannot ship
 * unlisted.
 *
 * Why this file exists: kinds are React/React-Native code selected by a closed
 * TypeScript union (see `lib/manipulative/types.ts`), not Convex rows a teacher
 * creates — so their catalog is code, not a table (the same call Games made in
 * `lib/games/catalog.ts`, for the same reason: a fleet iPad can only run
 * mechanics in its binary, and a database catalog would drift from it).
 *
 * Two consumers share this one source of truth:
 *   - the node-scoped authoring picker in `NodeItemPool` (kind buttons + the
 *     known-good example each seeds), which used to own these constants; and
 *   - the browse-first Manipulative Library lens of the Math Skills studio,
 *     which additionally reads the prose blurb / "what you can change" sentence
 *     / idea grouping so a teacher can compare mechanics WITHOUT reading a
 *     single line of JSON (the whole point of the Library — every kind has a
 *     different spec shape, so raw JSON teaches you nothing about the next one).
 *
 * The blurbs and "what you can change" sentences are hand-written prose, sourced
 * from `reports/ia-spike/A2-library.md` §1 (which enumerated all fifteen). They
 * make the shapes comparable BECAUSE they are all the same shape of sentence.
 */

import { makeLocateItem } from "@/lib/geomap/registry/data/gazetteer";
import type { ManipulativeKind, ManipulativeSpec } from "@/lib/manipulative/types";
import { ALL_SPECS } from "./library";

/** Friendly labels for every ManipulativeKind, in picker display order.
 *  Object key order = insertion order, so this also drives the picker row AND
 *  the Library's "All mechanics" card order. */
export const MANIPULATIVE_KIND_LABELS: Record<ManipulativeKind, string> = {
  partition: "Partition",
  numberline: "Number line",
  array: "Array",
  balance: "Balance",
  areaPerimeter: "Area & perimeter",
  distribute: "Distribute",
  rekenrek: "Rekenrek",
  distributor: "Distributor",
  riemann: "Riemann sum",
  functionMachine: "Function machine",
  placeValue: "Place value",
  dice: "Dice",
  protractor: "Protractor",
  coordinatePlane: "Coordinate plane",
  geoLocate: "Locate on map",
  ruler: "Ruler",
  clock: "Clock",
  liquid: "Measuring jars",
  money: "Money",
};

export const MANIPULATIVE_KINDS = Object.keys(
  MANIPULATIVE_KIND_LABELS,
) as ManipulativeKind[];

/** One representative, gradable example spec per kind — sourced from the same
 *  library the scholar-facing gallery uses, so a teacher starts from a spec
 *  that's already known-good and just needs a tweak, and the Library renders a
 *  live, playable canonical example rather than a screenshot. */
export const EXAMPLE_BY_KIND: Map<ManipulativeKind, ManipulativeSpec> = (() => {
  const map = new Map<ManipulativeKind, ManipulativeSpec>();
  // GOAL-BEARING SPECS WIN. This example is not only rendered — "Use on a
  // skill…" seeds it straight into the node authoring form, where a goalless
  // spec is rejected ("no usable goal — a scholar could never be marked
  // correct"). Several playlists open with an Explore/sandbox entry (the
  // rekenrek's first spec is `rack-explore-8`), so taking the FIRST match
  // handed a teacher who did exactly what the Library invites a prefill they
  // had to repair by hand-editing JSON — the one thing this surface exists to
  // avoid. Prefer a spec with a goal; fall back to any spec for the kinds that
  // legitimately have none (functionMachine's typed prediction IS its verdict).
  for (const spec of ALL_SPECS) {
    const better = "goal" in spec && spec.goal !== undefined;
    if (!map.has(spec.kind) || (better && !("goal" in map.get(spec.kind)!))) {
      map.set(spec.kind, spec);
    }
  }
  // geoLocate has no math-playlist entry — seed a known-good example from the
  // gazetteer generator so the picker starts a teacher from a valid spec.
  map.set("geoLocate", makeLocateItem("capital-hi"));
  // placeValue isn't in the scholar-facing math playlist (its consumers are the
  // wave-4 default seeds); seed a known-good buildNumber example so the picker
  // starts a teacher from a valid, gradable spec.
  map.set("placeValue", {
    kind: "placeValue",
    id: "placevalue-example-437",
    mode: "buildNumber",
    concept: "Place value",
    prompt: "Build 437 with hundreds, tens, and ones.",
    places: [100, 10, 1],
    goal: { type: "buildValue", value: 437 },
  });
  return map;
})();

export function exampleSpecJson(kind: ManipulativeKind): string {
  return JSON.stringify(EXAMPLE_BY_KIND.get(kind), null, 2);
}

/** The coarse "idea" a kind belongs to — the Library's left-rail grouping, so a
 *  teacher browses by what they're teaching, not by alphabet. Five buckets by
 *  mathematical domain. Sentence case (locked nomenclature). */
export type ManipulativeGroup =
  | "Number sense"
  | "Fractions"
  | "Multiplication"
  | "Geometry"
  | "Measurement and money"
  | "Chance and data";

/** Rail order for the groups (curriculum-ish: quantity → fractions → operations
 *  → space → measure → data). */
export const MANIPULATIVE_GROUP_ORDER: readonly ManipulativeGroup[] = [
  "Number sense",
  "Fractions",
  "Multiplication",
  "Geometry",
  "Measurement and money",
  "Chance and data",
];

export interface ManipulativeCatalogEntry {
  /** One/two-sentence plain-language description of the mechanic. */
  blurb: string;
  /** The configurable surface as a SENTENCE ("you choose … the goal is …"),
   *  never the schema — the Library never shows raw JSON in the browse path. */
  whatYouCanChange: string;
  /** The Library's left-rail idea grouping. */
  group: ManipulativeGroup;
  /**
   * `true` when the mechanic is a shipped production kind (usable on a skill,
   * renders on iPad); `false` for a prototype/demo. Every current union member
   * is production — the flag exists because prototype mechanics can live only in
   * `components/manipulative/spikes/` without being kinds, so a reader must be
   * able to tell shipped mechanics from demos on sight (the "Counters" finding,
   * A2 §"Counters"). It is also the promotion gate the rekenrek once walked: it
   * started as `RekenrekSpike` and graduated into the production union — while
   * its sibling counter spikes (ten-frame, bond bowls) were evaluated on the
   * same bar and deleted, because the rekenrek already carries their five/ten
   * structure and `groupOf` number-bond goal on the same skill nodes.
   */
  production: boolean;
}

/**
 * The Library index. A `Record<ManipulativeKind, …>` on the CLOSED union, so a
 * new kind added to `ManipulativeKind` without a catalog entry is a COMPILE
 * ERROR here — the whole reason the old dev gallery was incomplete (it missed
 * Place value) is that it was assembled from playlists, not the type.
 *
 * Prose sourced from `reports/ia-spike/A2-library.md` §1. Group assignments are
 * by mathematical domain; the non-obvious calls are defended inline.
 */
export const MANIPULATIVE_CATALOG: Record<
  ManipulativeKind,
  ManipulativeCatalogEntry
> = {
  partition: {
    blurb:
      "Cut discs into equal wedges and shade them. A “half” lights up whether you make 1/2, 2/4 or 3/6 — the same value, many partitions.",
    whatYouCanChange:
      "You choose how many discs, how many equal parts each is cut into, and which parts a scholar may re-cut or shade; the goal is a disc equal to a target fraction, two discs with equal shaded area, or several discs each hitting their own fraction.",
    group: "Fractions",
    production: true,
  },
  numberline: {
    blurb:
      "Drag one handle to locate a whole number, decimal or fraction. Position is the only feedback — the answer is never printed; a vertical scale can also frame elevation or floors.",
    whatYouCanChange:
      "You set the line's range and tick spacing, whether the handle snaps, any fixed labelled markers, and optionally its horizontal or vertical presentation with a mountain or building context; the goal is to place the handle at a target value or a target fraction, within a tolerance you choose.",
    group: "Number sense",
    production: true,
  },
  array: {
    blurb:
      "Resize a rectangle of tiles to model multiplication, factor pairs, commutativity and area.",
    whatYouCanChange:
      "You set the starting rows and columns and the most a scholar may drag to; the goal can be a target product or area, a count of factor pairs, a named side plus product, or a square of a target area.",
    group: "Multiplication",
    production: true,
  },
  balance: {
    blurb:
      "Add and remove unit weights on a pan balance for equality and hidden-number algebra.",
    // Number sense, not algebra: at its grade band the job is "make the two
    // sides hold the same quantity" — quantity equivalence, the concrete root
    // that later becomes an equation.
    whatYouCanChange:
      "You set the starting weights on each pan, which pans a scholar may change, and an optional hidden “mystery” weight; the goal is to make the two pans balance.",
    group: "Number sense",
    production: true,
  },
  areaPerimeter: {
    blurb:
      "Reshape a rectangle while the total fence length stays fixed, making the trade between area and perimeter visible.",
    whatYouCanChange:
      "You fix the perimeter and the starting width; the goal is either the largest possible area or an exact target area.",
    group: "Geometry",
    production: true,
  },
  distribute: {
    blurb:
      "Slide a vertical cut through a rectangular area model to expose a × (b + c) — the distributive property, made physical.",
    // Multiplication: it is the distributive law over a multiplication area
    // model, not a geometry-of-area task.
    whatYouCanChange:
      "You set the rectangle's width and height and where the cut starts; the goal is to slide the cut to a target column.",
    group: "Multiplication",
    production: true,
  },
  rekenrek: {
    blurb:
      "Push a train of beads across one or two rods to compose and decompose a whole; five- and ten-structure become visible.",
    whatYouCanChange:
      "You choose the total number of beads (up to 20) and where they start; the goal is a group of an exact size.",
    group: "Number sense",
    production: true,
  },
  distributor: {
    blurb:
      "Deal a total into equal plates — remainder and all — for partitive division and the root of fractions-as-sharing.",
    // Fractions: partitive division (equal sharing with a visible remainder) is
    // the concrete origin of fractions-as-division, so it sits with Partition.
    whatYouCanChange:
      "You set the total to share and the number of plates; the goal is to share it equally, leaving any true remainder visible.",
    group: "Fractions",
    production: true,
  },
  riemann: {
    blurb:
      "Vary the number of bars under a straight speed–time graph to approximate the distance travelled — an area model that foreshadows the integral.",
    // Multiplication: distance = rate × time is the accumulated product; the
    // bars are a multiplicative area model (its stretch/extra-credit reach into
    // calculus doesn't change the underlying operation).
    whatYouCanChange:
      "You set the line (its slope and intercept), the time span, and the starting number of bars; the goal is to approximate the area within a tolerance.",
    group: "Multiplication",
    production: true,
  },
  functionMachine: {
    blurb:
      "Inspect input/output pairs, infer the hidden rule, then predict one more output.",
    // Multiplication: the hidden rule is affine (multiply-and-add), so this is
    // multiplicative pattern reasoning.
    whatYouCanChange:
      "You set the hidden affine rule (multiply-and-add), the worked examples a scholar sees, and the input they must predict; the typed prediction is the answer, so there is nothing to drag.",
    group: "Multiplication",
    production: true,
  },
  placeValue: {
    blurb:
      "Assemble base-ten columns to build a number, read expanded form, or shift digits by powers of ten.",
    whatYouCanChange:
      "You pick the mode (build a number, expanded form, or shift by tens), which place-value columns show, and their starting counts; the goal is to build a target value or shift to one.",
    group: "Number sense",
    production: true,
  },
  dice: {
    blurb:
      "Roll dice or flip coins, tally the evidence, then make a theoretical prediction — graded on the reasoning, never on luck.",
    whatYouCanChange:
      "You pick the die or coin and how many, and optionally what to predict — the count of favourable faces, the probability of an event, or the most likely total; with no prediction it is a free sandbox.",
    group: "Chance and data",
    production: true,
  },
  protractor: {
    blurb:
      "Rotate a free ray on a 0–180° scale to construct an angle by hand.",
    whatYouCanChange:
      "You set an optional fixed base ray and the ray's starting angle; the goal is to construct a target angle within a tolerance.",
    group: "Geometry",
    production: true,
  },
  coordinatePlane: {
    blurb:
      "Drag one to three points on a snapping x/y grid to plot, complete a rectangle, or reflect across an axis.",
    whatYouCanChange:
      "You set the grid's range and step, any fixed points or drawn segments, and the draggable points' starts; the goal is to place a point, place a whole set, complete an axis-aligned rectangle, or reflect a point across an axis.",
    group: "Geometry",
    production: true,
  },
  geoLocate: {
    blurb:
      "Drop one or more pins on a real-world map to locate a place, a region, or a set of places.",
    // Geometry: it is spatial location on a coordinate surface (a real map),
    // the applied cousin of the coordinate plane.
    whatYouCanChange:
      "You configure the map — where it starts, its basemap and any markers — and the task; the goal is to drop the pin(s) on the target place, region, or set, within a tolerance.",
    group: "Geometry",
    production: true,
  },
  ruler: {
    blurb:
      "Drag the free end of a bar along a printed ruler until the bar is the length you were asked for.",
    // Its own group, not Geometry: the Geometry mechanics are all DERIVED
    // measure (area, angle, coordinate distance), while these four read a
    // quantity straight off a printed scale — the Measurement & Data idea the
    // catalog had no home for.
    whatYouCanChange:
      "You choose the unit and scale length, the gradation (whole units, halves, quarter-inches), and — the interesting one — where the bar is PINNED: start it off zero and the number its end lands on stops being its length.",
    group: "Measurement and money",
    production: true,
  },
  clock: {
    blurb:
      "Wind a geared analog clock. Drag the minute hand and the hour hand creeps with it, so at 3:45 the hour hand sits nearly on the 4.",
    whatYouCanChange:
      "You set the starting time, how finely the hands snap (hour, half hour, five minutes, every minute) and whether the minute numerals are printed; the goal is either to show a stated time or to move the hands on by a number of minutes.",
    group: "Measurement and money",
    production: true,
  },
  liquid: {
    blurb:
      "Pour into graduated jars by dragging the liquid's surface to a printed mark.",
    whatYouCanChange:
      "You choose one to three jars and their capacities, the unit and the gradation; the goal is either one jar at a stated level, or a stated total across jars — which authoring forces to exceed any single jar, so the amount has to be shared out.",
    group: "Measurement and money",
    production: true,
  },
  money: {
    blurb:
      "Tap US coins and bills between a bank and a tray. Pieces are drawn at their real relative sizes, so a dime is smaller than a nickel while being worth twice as much.",
    whatYouCanChange:
      "You choose which denominations the bank offers and the target amount; the goal is to make it any way, to make it with an exact number of pieces, or to make it with as few pieces as possible.",
    group: "Measurement and money",
    production: true,
  },
};

/**
 * Seed data: the geometry-and-measurement prerequisite knowledge graph.
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * Modeled on the other practice graphs (same SeedSkill/SeedEdge shape), loaded
 * by the multi-graph rebuild in convex/knowledgeNodes.ts.
 *
 * DOMAIN SLUG is "geometry-measurement" (kebab), with five strands, grades 1–6:
 *   • measurement-data    — length, time, money and liquid volume (grades 1–3)
 *   • area-perimeter      — unit squares through composite polygon area
 *   • volume              — unit cubes through nets and surface area
 *   • angles              — angle measure through shape classification
 *   • coordinate-geometry — ordered pairs through coordinate area/perimeter
 *
 * WHY `measurement-data` EXISTS (added 2026-08-06). This domain is NAMED for
 * measurement, but its original four strands are all DERIVED measure — area,
 * volume, angle, coordinate distance. Nothing in any of the eight registered
 * graphs modelled measuring a length with a ruler, telling time, counting
 * money, or reading a liquid level: Common Core's Measurement & Data (1.MD,
 * 2.MD, 3.MD), and the most concrete measuring a young scholar does. The graph
 * jumped straight from "count unit squares" to "area of a trapezoid".
 *
 * The gap was invisible to `review/content-coverage-audit.md`, and structurally
 * so: that audit iterates the REGISTERED nodes and asks whether each is
 * covered, so it reports a coverage hole on a node that exists but has no way
 * to report a whole absent domain. Every one of its 16 ranked gaps is a missing
 * manipulative/stretch on an existing node. Worth remembering before reading
 * that table as the full picture of what the curriculum lacks.
 *
 * This is also the first strand whose nodes were added to serve EXISTING
 * interactive material rather than the reverse — the `ruler`, `clock`, `liquid`
 * and `money` manipulatives were built for exactly these skills.
 *
 * CROSS-DOMAIN: three LIVE, grade-forward hard prerequisites connect the graph
 * to the arithmetic it applies: arrays → rectangle area, and fraction
 * multiplication → fractional area and volume. They are declared here (the
 * target side), so rebuild stamps them with this domain and the foreign-aware
 * frontier resolver checks the scholar's actual mastery in the source domain.
 */

import type { SeedSkill, SeedEdge } from "./wholeNumberArithmeticGraph";

export const GEOMETRY_MEASUREMENT_DOMAIN = "geometry-measurement";

export const GEOMETRY_MEASUREMENT_SKILLS: SeedSkill[] = [
  // ── measurement-data ─────────────────────────────────────────────────────
  // Length (1.MD.A / 2.MD.A / 3.MD.B), time (1.MD.B / 2.MD.C / 3.MD.A), money
  // (2.MD.C.8) and liquid volume (3.MD.A.2). Four short chains rather than one
  // ladder: a scholar can be fluent at telling time and hopeless at counting
  // coins, so nothing here gates anything in another chain.
  { skillKey: "length_iterate_units", label: "Measure a length by laying same-size units end to end with no gaps or overlaps", grade: "1", ccCodes: ["1.MD.A.2"], strand: "measurement-data", rationale: "Lay a unit down repeatedly and count the copies — measuring BEFORE a ruler exists, which is what makes a ruler's marks mean anything later." },
  { skillKey: "measure_with_ruler", label: "Measure a length in whole units with a ruler, lining the object up with zero", grade: "2", ccCodes: ["2.MD.A.1"], strand: "measurement-data", rationale: "Read a length off a printed scale — the iterated unit made permanent as a tool, and the first measurement a scholar can do quickly." },
  { skillKey: "measure_from_nonzero", label: "Find a length when the object does not start at the ruler's zero mark", grade: "2", ccCodes: ["2.MD.A.1"], strand: "measurement-data", rationale: "Length is end minus start, not the number the object stops on — the single most common ruler misconception, and the one that proves a scholar is measuring rather than reading." },
  { skillKey: "compare_lengths_difference", label: "Compare two lengths and find how much longer one is", grade: "2", ccCodes: ["2.MD.A.4"], strand: "measurement-data", rationale: "Turn two measurements into a difference — where measuring stops being a reading and starts being data you reason with." },
  { skillKey: "measure_half_quarter_inch", label: "Measure lengths to the nearest half and quarter inch", grade: "3", ccCodes: ["3.MD.B.4"], strand: "measurement-data", rationale: "Read the sub-unit marks between the whole numbers — the first place fractions show up as something physically measured rather than a shaded shape." },
  { skillKey: "tell_time_hour_half_hour", label: "Tell and write time to the hour and half hour on an analog clock", grade: "1", ccCodes: ["1.MD.B.3"], strand: "measurement-data", rationale: "Read the two hands at the coarsest grain — the entry point to a dial, where the hour hand's position between numerals starts to mean something." },
  { skillKey: "tell_time_five_minutes", label: "Tell and write time to the nearest five minutes, and use a.m. and p.m.", grade: "2", ccCodes: ["2.MD.C.7"], strand: "measurement-data", rationale: "Count the minute ring by fives — the skip-counting scholars already have, applied to a scale that wraps." },
  { skillKey: "tell_time_to_minute", label: "Tell and write time to the nearest minute", grade: "3", ccCodes: ["3.MD.A.1"], strand: "measurement-data", rationale: "Read every tick, not just the labelled fives — full precision on a circular scale." },
  { skillKey: "elapsed_time_minutes", label: "Find the time after a given number of minutes have passed, including across the hour", grade: "3", ccCodes: ["3.MD.A.1"], strand: "measurement-data", rationale: "Add minutes to a time and carry across 60 — arithmetic on a scale that wraps, and a scholar's first taste of modular thinking." },
  { skillKey: "coin_values", label: "Know the value of a penny, nickel, dime and quarter", grade: "2", ccCodes: ["2.MD.C.8"], strand: "measurement-data", rationale: "Attach a value to each coin — necessary because a coin's SIZE actively misleads: the dime is the smallest and worth more than the nickel." },
  { skillKey: "count_mixed_coins", label: "Count a mixed collection of coins to find its total value", grade: "2", ccCodes: ["2.MD.C.8"], strand: "measurement-data", rationale: "Sort high-to-low then count on by unequal steps — the first place a scholar adds a set of DIFFERENT units and has to order them to stay sane." },
  { skillKey: "make_amount_with_coins", label: "Make a given amount with coins, including with the fewest coins", grade: "2", ccCodes: ["2.MD.C.8"], strand: "measurement-data", rationale: "Run the count backwards to build a target amount — a genuine search with a best answer, which is real optimisation inside grade-2 arithmetic." },
  { skillKey: "liquid_volume_measure", label: "Measure liquid volume with a graduated container", grade: "3", ccCodes: ["3.MD.A.2"], strand: "measurement-data", rationale: "Read a level off a scale printed on a jar — the same act as the ruler in a second physical quantity, which is what makes 'measure' a general idea." },
  { skillKey: "liquid_volume_combine", label: "Add and compare liquid volumes across containers", grade: "3", ccCodes: ["3.MD.A.2"], strand: "measurement-data", rationale: "Combine measured amounts and compare capacities — volumes add, and a taller jar does not always hold more." },

  // ── area-perimeter ───────────────────────────────────────────────────────
  { skillKey: "partition_rectangles_rows_cols", label: "Partition a rectangle into equal rows and columns of same-size squares", grade: "2", ccCodes: ["2.G.A.2"], strand: "area-perimeter", rationale: "Cover a rectangle with a grid of equal squares and count them — the physical root of area and the bridge to arrays and multiplication." },
  { skillKey: "area_unit_squares", label: "Measure area by counting unit squares", grade: "3", ccCodes: ["3.MD.C.5", "3.MD.C.6"], strand: "area-perimeter", rationale: "Understand area as the number of unit squares that exactly cover a region — the meaning behind every area formula." },
  { skillKey: "perimeter_polygons", label: "Find the perimeter of a polygon by adding its side lengths", grade: "3", ccCodes: ["3.MD.D.8"], strand: "area-perimeter", rationale: "Add the side lengths that bound a shape — distance around, kept distinct from area from the start." },
  { skillKey: "area_rectangle", label: "Find the area of a rectangle by tiling and by multiplying side lengths", grade: "3", ccCodes: ["3.MD.C.7a", "3.MD.C.7b"], strand: "area-perimeter", rationale: "See that a rectangle of unit squares is rows x columns, so its area is length x width — the first formula grounded in structure." },
  { skillKey: "area_distributive", label: "Show area of a split rectangle as a x (b + c) = a x b + a x c", grade: "3", ccCodes: ["3.MD.C.7c"], strand: "area-perimeter", rationale: "Cut a rectangle into two and see the areas add — the area picture of the distributive property, reused all through arithmetic and algebra." },
  { skillKey: "area_rectilinear_decompose", label: "Find the area of an L-shaped (rectilinear) figure by decomposing it into rectangles", grade: "3", ccCodes: ["3.MD.C.7d"], strand: "area-perimeter", rationale: "Break a rectilinear figure into rectangles and add their areas — the first real composite-figure reasoning." },
  { skillKey: "area_perimeter_relationship", label: "Compare rectangles with the same perimeter but different area (and the reverse)", grade: "3", ccCodes: ["3.MD.D.8"], strand: "area-perimeter", rationale: "Discover that area and perimeter vary independently — the guard against the classic confusion between them, subsuming a bare tell-them-apart task." },
  { skillKey: "perimeter_composite", label: "Find the perimeter of a composite (rectilinear) figure with unlabeled sides", grade: "4", ccCodes: ["4.MD.A.3"], strand: "area-perimeter", rationale: "Trace the full boundary of an irregular figure, deducing unlabeled sides — perimeter reasoning that resists formula-plugging." },
  { skillKey: "area_perimeter_unknown_side", label: "Find an unknown side length of a rectangle from its area or perimeter", grade: "4", ccCodes: ["4.MD.A.3"], strand: "area-perimeter", rationale: "Reverse a formula numerically to recover a missing length — inverse reasoning without symbolic equations." },
  { skillKey: "area_word_problems", label: "Solve multi-step area and perimeter problems", grade: "4", ccCodes: ["4.MD.A.3"], strand: "area-perimeter", rationale: "Chain area and perimeter facts across several steps in a real context — where the ideas become a tool, not a drill." },
  { skillKey: "same_perimeter_optimize", label: "Find the rectangle with the greatest area for a given perimeter", grade: "4", ccCodes: ["3.MD.D.8"], strand: "area-perimeter", rationale: "Search whole-number rectangles for the largest area at a fixed perimeter — a genuine optimization a gifted scholar can reason through without algebra." },
  { skillKey: "area_fraction_side", label: "Find the area of a rectangle with fractional side lengths by tiling with unit-fraction squares", grade: "5", ccCodes: ["5.NF.B.4b"], strand: "area-perimeter", rationale: "Tile a rectangle whose sides are fractions and count unit-fraction squares — the area meaning of multiplying two fractions (chosen over a fractional-triangle node as the canonical 5.NF.B.4b form)." },
  { skillKey: "area_parallelogram", label: "Find the area of a parallelogram (base x height)", grade: "6", ccCodes: ["6.G.A.1"], strand: "area-perimeter", rationale: "Cut and rearrange a parallelogram into a rectangle to justify base x height — the first area formula proved by dissection." },
  { skillKey: "area_triangle", label: "Find the area of a triangle (1/2 x base x height)", grade: "6", ccCodes: ["6.G.A.1"], strand: "area-perimeter", rationale: "See a triangle as half a parallelogram to justify 1/2 x base x height, including when the height falls outside the triangle." },
  { skillKey: "area_trapezoid", label: "Find the area of a trapezoid by decomposing it", grade: "6", ccCodes: ["6.G.A.1"], strand: "area-perimeter", rationale: "Split a trapezoid into simpler pieces and add — extending dissection reasoning to a shape with no memorized formula needed." },
  { skillKey: "area_composite_polygons", label: "Find the area of a composite polygon by decomposing into triangles, rectangles, and parallelograms", grade: "6", ccCodes: ["6.G.A.1"], strand: "area-perimeter", rationale: "Compose and decompose arbitrary polygons into known pieces — the ceiling of plane-area reasoning for this band." },

  // ── volume ───────────────────────────────────────────────────────────────
  { skillKey: "volume_unit_cubes", label: "Measure volume by counting unit cubes", grade: "5", ccCodes: ["5.MD.C.3", "5.MD.C.4"], strand: "volume", rationale: "Understand volume as the number of unit cubes that fill a solid — the 3D analog of covering area with unit squares (folds Sol's understand/measure split)." },
  { skillKey: "volume_by_layers", label: "Find a prism's volume by counting equal layers of unit cubes", grade: "5", ccCodes: ["5.MD.C.5a"], strand: "volume", rationale: "See a prism as height copies of one base-area layer — the layer model that makes base-area x height (and l x w x h) make sense rather than be memorized." },
  { skillKey: "volume_conservation", label: "Understand that volume is additive and unchanged when a solid is rearranged", grade: "5", ccCodes: ["5.MD.C.5c"], strand: "volume", rationale: "See that moving cubes around conserves total volume and that volumes add — the principle behind composite solids." },
  { skillKey: "volume_rectangular_prism", label: "Find the volume of a rectangular prism (length x width x height, and base area x height)", grade: "5", ccCodes: ["5.MD.C.5a", "5.MD.C.5b"], strand: "volume", rationale: "Justify V = l x w x h = (base area) x height from the layer model — volume grounded in the area formula (folds Sol's two separate formula nodes)." },
  { skillKey: "volume_composite_prisms", label: "Find the volume of a solid made of two rectangular prisms", grade: "5", ccCodes: ["5.MD.C.5c"], strand: "volume", rationale: "Decompose a solid into non-overlapping prisms and add their volumes — composite reasoning carried into three dimensions." },
  { skillKey: "volume_unknown_dimension", label: "Find an unknown edge length of a prism from its volume", grade: "5", ccCodes: ["5.MD.C.5b"], strand: "volume", rationale: "Undo the volume formula numerically to recover a missing edge — inverse reasoning in three dimensions." },
  { skillKey: "volume_fractional_edges", label: "Find the volume of a right rectangular prism with fractional edge lengths", grade: "6", ccCodes: ["6.G.A.2"], strand: "volume", rationale: "Pack a prism with 1/b-sized cubes to extend V = l x w x h to fractional edges — the volume face of fraction multiplication." },
  { skillKey: "nets_of_solids", label: "Represent a 3D figure with a net of its faces", grade: "6", ccCodes: ["6.G.A.4"], strand: "volume", rationale: "Unfold a prism or pyramid into a flat net and back — the spatial link between a solid and its faces, and the gateway to surface area." },
  { skillKey: "surface_area_nets", label: "Find the surface area of a prism or pyramid using its net", grade: "6", ccCodes: ["6.G.A.4"], strand: "volume", rationale: "Add the areas of all faces from a net — surface area as applied composite-area reasoning (broadened from Sol's rectangular-prism-only to prism or pyramid)." },

  // ── angles ───────────────────────────────────────────────────────────────
  { skillKey: "angle_concept", label: "Recognize an angle as two rays from a shared endpoint, and angle size as an amount of turn", grade: "4", ccCodes: ["4.MD.C.5", "4.G.A.1"], strand: "angles", rationale: "See an angle as a turn between two rays, not a pointy corner — the mental model that makes measurement make sense (subsumes basic ray/segment vocab)." },
  { skillKey: "angle_turns_circle", label: "Understand a one-degree angle as 1/360 of a full circular turn", grade: "4", ccCodes: ["4.MD.C.5a"], strand: "angles", rationale: "Ground the degree as a unit fraction of a full turn — why 90 and 180 are special and how the protractor scale is built (absorbs Sol's quarter/half-turn intuition)." },
  { skillKey: "angle_measure_protractor", label: "Measure and draw angles in whole degrees with a protractor", grade: "4", ccCodes: ["4.MD.C.6"], strand: "angles", rationale: "Read and construct angle measures with a protractor — the hands-on skill that turns the degree idea into precise numbers (folds Sol's measure/draw split)." },
  { skillKey: "benchmark_angles", label: "Estimate angle size against 90-degree and 180-degree benchmarks", grade: "4", ccCodes: ["4.MD.C.6"], strand: "angles", rationale: "Judge an angle against right and straight benchmarks — angle number sense that catches protractor misreadings." },
  { skillKey: "angle_classification", label: "Classify angles as acute, right, obtuse, or straight", grade: "4", ccCodes: ["4.G.A.1"], strand: "angles", rationale: "Sort angles by their relation to 90 and 180 degrees — the vocabulary that supports classifying shapes." },
  { skillKey: "parallel_perpendicular_lines", label: "Identify parallel lines, perpendicular lines, and right angles in figures", grade: "4", ccCodes: ["4.G.A.1"], strand: "angles", rationale: "Recognize parallel and perpendicular relationships — the structural language for classifying polygons." },
  { skillKey: "angle_additivity", label: "Compose adjacent angles and find an unknown angle by adding or subtracting", grade: "4", ccCodes: ["4.MD.C.7"], strand: "angles", rationale: "Treat a big angle as the sum of its parts and solve for a missing part by arithmetic — decomposition reasoning without symbolic equations (folds Sol's additivity/find-unknown split)." },
  { skillKey: "classify_triangles_sides", label: "Classify triangles by side lengths (equilateral, isosceles, scalene)", grade: "4", ccCodes: ["4.G.A.2"], strand: "angles", rationale: "Sort triangles by equal sides — the concrete, visual lens on triangles that precedes the angle lens." },
  { skillKey: "classify_triangles_angles", label: "Classify triangles by their angles (acute, right, obtuse)", grade: "5", ccCodes: ["5.G.B.3", "4.G.A.2"], strand: "angles", rationale: "Sort triangles by their largest angle — the angle lens that pairs with the side lens for full triangle description." },
  { skillKey: "classify_quadrilaterals", label: "Classify quadrilaterals by parallel sides, equal sides, and right angles", grade: "5", ccCodes: ["5.G.B.3"], strand: "angles", rationale: "Name quadrilaterals from their properties — the properties-first habit that a shape can carry several names." },
  { skillKey: "quadrilateral_hierarchy", label: "Place quadrilaterals in a hierarchy (every square is a rectangle)", grade: "5", ccCodes: ["5.G.B.4"], strand: "angles", rationale: "Reason that a subclass inherits every property of its parent class — early deductive classification, prized headroom for gifted logicians." },
  { skillKey: "angle_sum_triangle", label: "Use the 180-degree angle sum of a triangle to find a missing angle", grade: "6", ccCodes: ["8.G.A.5"], strand: "angles", rationale: "Apply the triangle angle-sum fact to recover the third angle by subtraction — a striking result reachable by arithmetic alone (an enrichment reach; formal proof waits for later grades)." },

  // ── coordinate-geometry ──────────────────────────────────────────────────
  { skillKey: "ordered_pair_meaning", label: "Understand an ordered pair as (across, then up) from the origin on labeled axes", grade: "5", ccCodes: ["5.G.A.1"], strand: "coordinate-geometry", rationale: "Learn the coordinate convention: first number across, second up, from a fixed origin on scaled axes — the grammar of the plane (folds Sol's axes-setup + read-pair)." },
  { skillKey: "coordinate_plane_first_quadrant", label: "Plot and read points in the first quadrant, including real-world contexts", grade: "5", ccCodes: ["5.G.A.1", "5.G.A.2"], strand: "coordinate-geometry", rationale: "Plot and read ordered pairs and interpret them in context — coordinates as a way to pin down and communicate location (folds Sol's plot + interpret-in-context)." },
  { skillKey: "line_symmetry", label: "Identify and draw lines of symmetry in 2D figures", grade: "4", ccCodes: ["4.G.A.3"], strand: "coordinate-geometry", rationale: "Find fold lines that map a figure onto itself — the intuition of a mirror line that reflections later make precise." },
  { skillKey: "four_quadrant_plane", label: "Plot and read points in all four quadrants (integer coordinates)", grade: "6", ccCodes: ["6.NS.C.6b", "6.NS.C.6c"], strand: "coordinate-geometry", rationale: "Extend the plane to negative coordinates and read signs as directions from the origin — the full coordinate plane." },
  { skillKey: "reflect_across_axis", label: "Reflect a point across an axis and predict the sign change", grade: "6", ccCodes: ["6.NS.C.6b"], strand: "coordinate-geometry", rationale: "Connect reflection across an axis to flipping the sign of one coordinate — where symmetry becomes an operation on numbers." },
  { skillKey: "coordinate_distance", label: "Find the distance between two points on the same horizontal or vertical line", grade: "6", ccCodes: ["6.NS.C.8", "6.G.A.3"], strand: "coordinate-geometry", rationale: "Find same-line distances by subtracting the differing coordinate (across quadrants too) — measurement fused with coordinates." },
  { skillKey: "coordinate_missing_vertex", label: "Find a missing vertex of an axis-aligned polygon from the others", grade: "6", ccCodes: ["6.G.A.3"], strand: "coordinate-geometry", rationale: "Deduce an unlisted vertex from the coordinates that are given — spatial-logical reasoning that gives a gifted scholar real headroom on the plane." },
  { skillKey: "polygons_on_coordinate_plane", label: "Draw polygons from vertex coordinates and find side lengths", grade: "6", ccCodes: ["6.G.A.3"], strand: "coordinate-geometry", rationale: "Build polygons from listed vertices and measure horizontal and vertical sides — geometry driven entirely by coordinates (folds Sol's first-quadrant + four-quadrant polygon drawing)." },
  { skillKey: "coordinate_perimeter_area", label: "Find the perimeter or area of an axis-aligned polygon drawn on the coordinate plane", grade: "6", ccCodes: ["6.G.A.1", "6.G.A.3"], strand: "coordinate-geometry", rationale: "Combine coordinate side lengths with area and perimeter formulas — the strand's ceiling, tying measurement to the plane." },
];

export const GEOMETRY_MEASUREMENT_EDGES: SeedEdge[] = [
  // measurement-data — four independent chains (length, time, money,
  // capacity), each ≤1 grade per hop. Deliberately NOT joined to each other:
  // telling time is not a prerequisite for counting coins, and pretending
  // otherwise would gate a scholar out of money work for an unrelated miss.
  { fromKey: "length_iterate_units", toKey: "measure_with_ruler" },
  { fromKey: "measure_with_ruler", toKey: "measure_from_nonzero" },
  { fromKey: "measure_with_ruler", toKey: "compare_lengths_difference" },
  // Re-parented to `measure_with_ruler`, not `measure_from_nonzero`: reading
  // quarter marks on a ruler you START AT ZERO does not require the broken-ruler
  // subtraction first. Gating it there would strand a scholar who reads
  // sub-unit marks fine behind an unrelated miss.
  { fromKey: "measure_with_ruler", toKey: "measure_half_quarter_inch" },
  { fromKey: "tell_time_hour_half_hour", toKey: "tell_time_five_minutes" },
  { fromKey: "tell_time_five_minutes", toKey: "tell_time_to_minute" },
  { fromKey: "tell_time_to_minute", toKey: "elapsed_time_minutes" },
  { fromKey: "coin_values", toKey: "count_mixed_coins" },
  { fromKey: "count_mixed_coins", toKey: "make_amount_with_coins" },
  { fromKey: "liquid_volume_measure", toKey: "liquid_volume_combine" },
  // DECLINED, on review: `measure_with_ruler -> liquid_volume_measure`. The two
  // are ANALOGOUS (both read a quantity off a printed scale), and the analogy is
  // exactly why one manipulative family serves both — but analogy is not
  // prerequisite. Nothing about reading a ruler is needed to read a jar, and a
  // hard gate here would hold a scholar out of capacity work for a length miss.
  // `liquid_volume_measure` is therefore a grade-3 root of its own chain.

  // Audited and deliberately declined for this strand:
  // • measure_with_ruler → perimeter_polygons. A true dependency (perimeter IS
  //   summed measured lengths), but P9 below already declined a prerequisite on
  //   that node so small-number perimeter stays reachable; adding a grade-2
  //   measuring gate would re-close the door P9 deliberately left open.
  // • skip_count_2s_5s_10s → count_mixed_coins, and add_within_100 → the money
  //   chain. Both genuine, both CROSS-domain, and the 2026-07-19 entrance audit
  //   declined this entire class of cross-domain hard gate. If they ever land it
  //   should be as inference-only `implies` edges, with the same vetting the
  //   surviving `implies` set got — not smuggled in here.

  // area-perimeter
  { fromKey: "partition_rectangles_rows_cols", toKey: "area_unit_squares" },
  { fromKey: "area_unit_squares", toKey: "area_rectangle" },
  { fromKey: "area_rectangle", toKey: "area_distributive" },
  { fromKey: "area_rectangle", toKey: "area_rectilinear_decompose" },
  { fromKey: "perimeter_polygons", toKey: "area_perimeter_relationship" },
  { fromKey: "area_rectangle", toKey: "area_perimeter_relationship" },
  { fromKey: "perimeter_polygons", toKey: "perimeter_composite" },
  { fromKey: "area_rectilinear_decompose", toKey: "perimeter_composite" },
  { fromKey: "area_rectangle", toKey: "area_perimeter_unknown_side" },
  { fromKey: "perimeter_polygons", toKey: "area_perimeter_unknown_side" },
  { fromKey: "area_perimeter_unknown_side", toKey: "area_word_problems" },
  { fromKey: "area_perimeter_relationship", toKey: "area_word_problems" },
  { fromKey: "area_perimeter_relationship", toKey: "same_perimeter_optimize" },
  { fromKey: "area_rectangle", toKey: "area_fraction_side" },
  { fromKey: "area_rectangle", toKey: "area_parallelogram" },
  { fromKey: "area_parallelogram", toKey: "area_triangle" },
  { fromKey: "area_parallelogram", toKey: "area_trapezoid" },
  { fromKey: "area_triangle", toKey: "area_trapezoid" },
  { fromKey: "area_triangle", toKey: "area_composite_polygons" },
  { fromKey: "area_parallelogram", toKey: "area_composite_polygons" },
  { fromKey: "area_rectilinear_decompose", toKey: "area_composite_polygons" },

  // volume
  { fromKey: "area_unit_squares", toKey: "volume_unit_cubes" },
  { fromKey: "volume_unit_cubes", toKey: "volume_conservation" },
  { fromKey: "volume_unit_cubes", toKey: "volume_by_layers" },
  { fromKey: "area_rectangle", toKey: "volume_by_layers" },
  { fromKey: "volume_by_layers", toKey: "volume_rectangular_prism" },
  { fromKey: "volume_conservation", toKey: "volume_composite_prisms" },
  { fromKey: "volume_rectangular_prism", toKey: "volume_composite_prisms" },
  { fromKey: "volume_rectangular_prism", toKey: "volume_unknown_dimension" },
  { fromKey: "volume_rectangular_prism", toKey: "volume_fractional_edges" },
  { fromKey: "volume_rectangular_prism", toKey: "nets_of_solids" },
  { fromKey: "nets_of_solids", toKey: "surface_area_nets" },
  { fromKey: "area_rectangle", toKey: "surface_area_nets" },
  { fromKey: "area_triangle", toKey: "surface_area_nets" },

  // angles
  { fromKey: "angle_concept", toKey: "angle_turns_circle" },
  { fromKey: "angle_turns_circle", toKey: "angle_measure_protractor" },
  { fromKey: "angle_measure_protractor", toKey: "benchmark_angles" },
  { fromKey: "angle_measure_protractor", toKey: "angle_classification" },
  { fromKey: "benchmark_angles", toKey: "angle_classification" },
  { fromKey: "angle_concept", toKey: "parallel_perpendicular_lines" },
  { fromKey: "angle_classification", toKey: "parallel_perpendicular_lines" },
  { fromKey: "angle_measure_protractor", toKey: "angle_additivity" },
  { fromKey: "angle_concept", toKey: "classify_triangles_sides" },
  { fromKey: "classify_triangles_sides", toKey: "classify_triangles_angles" },
  { fromKey: "angle_classification", toKey: "classify_triangles_angles" },
  { fromKey: "parallel_perpendicular_lines", toKey: "classify_quadrilaterals" },
  { fromKey: "angle_classification", toKey: "classify_quadrilaterals" },
  { fromKey: "classify_quadrilaterals", toKey: "quadrilateral_hierarchy" },
  { fromKey: "angle_additivity", toKey: "angle_sum_triangle" },
  { fromKey: "classify_triangles_angles", toKey: "angle_sum_triangle" },

  // coordinate-geometry
  { fromKey: "ordered_pair_meaning", toKey: "coordinate_plane_first_quadrant" },
  { fromKey: "coordinate_plane_first_quadrant", toKey: "four_quadrant_plane" },
  { fromKey: "four_quadrant_plane", toKey: "reflect_across_axis" },
  { fromKey: "line_symmetry", toKey: "reflect_across_axis" },
  { fromKey: "four_quadrant_plane", toKey: "coordinate_distance" },
  { fromKey: "coordinate_distance", toKey: "polygons_on_coordinate_plane" },
  { fromKey: "four_quadrant_plane", toKey: "polygons_on_coordinate_plane" },
  { fromKey: "polygons_on_coordinate_plane", toKey: "coordinate_missing_vertex" },
  { fromKey: "polygons_on_coordinate_plane", toKey: "coordinate_perimeter_area" },
  { fromKey: "coordinate_missing_vertex", toKey: "coordinate_perimeter_area" },
  { fromKey: "coordinate_distance", toKey: "coordinate_perimeter_area" },

  // ── Cross-domain HARD prerequisites — LIVE ───────────────────────────────
  // Arrays are the grade-3 arithmetic structure beneath rectangle area.
  { fromKey: "arrays_concept", toKey: "area_rectangle" },
  // Fractional side/edge measures apply grade-5 fraction multiplication. Both
  // bridges are grade-forward, so they expose the dependency without stranding
  // a younger geometry node behind later work.
  { fromKey: "multiply_fractions", toKey: "area_fraction_side" },
  { fromKey: "multiply_fractions", toKey: "volume_fractional_edges" },
  // The fractional-side items present their side/edge lengths in DECIMAL form
  // (0.75 m, 2.5 m — see templates.ts), so as served they are computed as
  // decimal products, and the pretest audit (#881) found a miss on them was
  // unattributable with no decimal-operations node anywhere in the graph.
  // `multiply_decimals` (grade 5, fraction-arithmetic decimals strand) is the
  // honest hard prerequisite — grade-forward into these grade-5/6 nodes.
  { fromKey: "multiply_decimals", toKey: "area_fraction_side" },
  { fromKey: "multiply_decimals", toKey: "volume_fractional_edges" },

  // Audited and deliberately declined hard gates:
  // P5 HOLD: mult_2digit_by_1digit → area_composite_polygons/area_word_problems is typical, not necessary; small-number reasoning must remain accessible.
  // P9 HOLD: whole-number addition → perimeter_polygons is a true dependency (perimeter IS the sum of side lengths), but no grade-sane source clears the bar: a 3-digit-addition source OVER-gates small-number perimeter (sides 3,4,5), and a within-20 source is near-universal clutter by grade 3. Per P5 (small-number reasoning must remain accessible), left off.
];

/**
 * INFERENCE-ONLY cross-domain edges (kind:"implies") — genuine information
 * dependencies from the 2026-07-19 entrance audit, given a home that never gates.
 * `implies` feeds the two blessed inference consumers only (implicit credit +
 * placement diagnostic); it is invisible to the frontier gate and prereq
 * recommendations. Stamped with this (to-side) domain by the rebuild.
 *
 * Contract (vetted against the real target TEMPLATE): a line of symmetry
 * partitions a figure into two equal (mirror-image) halves, and the
 * `line_symmetry` item asks the learner to count those fold lines — so the
 * equal-partition idea `partition_shapes` teaches genuinely underlies it. (The
 * weakest surviving edge; kept because the equal-halves connection is real, unlike
 * the pruned `partition_shapes -> angle_concept`.)
 *
 * PRUNED (an adversarial template-vetting review (§5) — target template does NOT exercise
 * the source): `add_3digit_no_regroup -> perimeter_polygons` (the perimeter target
 * is a small rectangle, 2*(w+h) with w,h ≤ 14 — no three-digit addition), and
 * `partition_shapes -> angle_concept` (the target only names two rays + a turn; no
 * partitioning). Per P5, small-number reasoning must stay accessible.
 */
export const GEOMETRY_MEASUREMENT_IMPLIES_EDGES: SeedEdge[] = [
  // a line of symmetry partitions a figure into two equal (mirror) halves.
  { fromKey: "partition_shapes", toKey: "line_symmetry" },
];

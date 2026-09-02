/**
 * Synthetic "scholar evidence binder" fixtures for the rating-calibration
 * harness — compact, hand-written binder-summary text (the same shape
 * convex/courseNarrativeAI.ts's summarizeBinder() renders for the model),
 * each carrying a TEACHER-assigned "gold" 1–7 PCM rating per dimension.
 * Deliberately spans the whole rubric range (Emerging → Exemplary) plus one
 * deliberately UNEVEN profile (`mixed-e`) — a rater that tracks overall vibe
 * rather than the per-dimension evidence would flatten that spread.
 */
import type { BinderFixture } from "./lib/suggestRatings";

export const BINDERS: BinderFixture[] = [
  {
    id: "emerging-a",
    scholarName: "Milo R.",
    periodLabel: "Fall 2026, Quarter 1",
    subject: "Science",
    goldRatings: { core: 2, connections: 1, practice: 2, identity: 2 },
    binderText: `Scholar: Milo R. Period: Fall 2026, Quarter 1. Coverage: mostly teacher-observed.

### CORE — thin evidence, mostly recall with prompting (0 student-initiated)
- [mastery] Correctly recalled that plants need sunlight, water, and soil to grow, after being asked directly.
- [granule] Probed: could name the three states of matter with prompting.

### CONNECTIONS — no independent links observed this period
- (no episodes this period)

### PRACTICE — one guided investigation, did not revise independently
- [deliverable] Deliverable: 2/5 criteria met on the "grow a bean plant" observation log; entries were mostly filled in after teacher reminders.

### IDENTITY — limited self-direction signals
- [signal] task_commitment: needed multiple redirects to stay on the plant-growth journal across the two weeks.

### Teacher anecdotes
- [minor] Seemed disengaged during the ecosystem unit discussion, participated only when called on.

### Counter-evidence lane
- [misconception] Believes all plants need soil to grow (hasn't yet encountered hydroponics/aeroponics examples).

### Goals & progress
- Build a two-week observation habit (active) — 2 check-ins`,
  },
  {
    id: "developing-b",
    scholarName: "Priya K.",
    periodLabel: "Fall 2026, Quarter 1",
    subject: "Science",
    goldRatings: { core: 3, connections: 2, practice: 3, identity: 3 },
    binderText: `Scholar: Priya K. Period: Fall 2026, Quarter 1. Coverage: mixed.

### CORE — solid grasp, some independent explanation (1 student-initiated)
- [mastery, student-initiated] Explained unprompted that the water cycle repeats because the sun's energy keeps recycling water between evaporation and condensation.
- [granule] Demonstrated: correctly identified evaporation, condensation, precipitation, and collection stages.

### CONNECTIONS — one connection, made after a teacher prompt
- [connection] Linked the water cycle to a rain-shadow desert example after the teacher asked "why do deserts form near mountains?"

### PRACTICE — followed the investigation protocol closely, adjusted after a teacher suggestion
- [deliverable] Deliverable: 3/5 criteria met on the rain-gauge data log; noted an outlier reading but didn't investigate why until prompted.
- [signal] productive_struggle: worked through a data-graphing error for several minutes before asking for help.

### IDENTITY — engaged, some emerging interest signals
- [seed] Explored: "Why does it rain more in some places" (frontier, completed)
- [signal] intellectual_intensity: asked several follow-up questions about cloud formation across two sessions.

### Teacher anecdotes
- [minor] Volunteered to present the water-cycle poster to the class.

### Counter-evidence lane
- (none this period)

### Goals & progress
- Practice explaining reasoning out loud (active) — 3 check-ins`,
  },
  {
    id: "proficient-c",
    scholarName: "Theo N.",
    periodLabel: "Fall 2026, Quarter 1",
    subject: "Science",
    goldRatings: { core: 5, connections: 4, practice: 5, identity: 4 },
    binderText: `Scholar: Theo N. Period: Fall 2026, Quarter 1. Coverage: mostly on-platform.

### CORE — regularly demonstrates strong understanding, largely independently (2 student-initiated)
- [mastery, student-initiated] Explained unprompted why removing a keystone predator (sea otters) collapses a kelp-forest ecosystem via a trophic cascade, citing specific population effects.
- [granule] Demonstrated: applied energy-pyramid reasoning to a novel food web without teacher scaffolding.

### CONNECTIONS — regularly makes thoughtful interdisciplinary links, largely unprompted (1 student-initiated)
- [connection, student-initiated] Connected the kelp-forest trophic cascade to a US history lesson on fur-trade over-hunting of otters, unprompted.
- [connection] Related population-graph shapes in ecosystems to exponential-growth graphs from math class.

### PRACTICE — designed and revised an investigation based on evidence
- [deliverable] Deliverable: 5/5 criteria met on the schoolyard biodiversity survey; used a second sampling method after the first undercounted insects.
- [signal] metacognition: noted "my first count was probably wrong because I only looked during the day" and adjusted the protocol.

### IDENTITY — clear personal investment, chose the harder path
- [signal] task_commitment: chose the optional advanced ecosystem-modeling extension over the standard worksheet.
- [seed] Explored: "Building a simple predator-prey population model" (depth_probe, completed)

### Teacher anecdotes
- [major] Led a small-group discussion on invasive species without being asked.

### Counter-evidence lane
- [misconception] Briefly conflated "keystone species" with "the most abundant species" before self-correcting during the discussion.

### Goals & progress
- Design an original investigation (achieved) — 4 check-ins`,
  },
  {
    id: "exemplary-d",
    scholarName: "Aria S.",
    periodLabel: "Fall 2026, Quarter 1",
    subject: "Science",
    goldRatings: { core: 7, connections: 6, practice: 6, identity: 7 },
    binderText: `Scholar: Aria S. Period: Fall 2026, Quarter 1. Coverage: mostly on-platform.

### CORE — consistently, independently masters and extends concepts across contexts (2 student-initiated)
- [mastery, student-initiated] Explained unprompted, in her own words, how a single point mutation in a coding region can change one amino acid and alter protein folding, then correctly predicted what would happen if the same mutation occurred in a non-coding region instead.
- [granule] Demonstrated: applied Punnett-square reasoning to a novel three-trait cross she designed herself.

### CONNECTIONS — independently, consistently transfers learning across multiple contexts (2 student-initiated)
- [connection, student-initiated] Connected antibiotic-resistance evolution in bacteria to a computer-science lesson on genetic algorithms, unprompted, across two separate sessions.
- [connection, student-initiated] Related Mendelian ratios to probability distributions from math class and used one to predict the other.

### PRACTICE — works like a practicing scientist, revises independently, cites sources
- [deliverable] Deliverable: 5/5 criteria met on the fruit-fly cross simulation project; revised her hypothesis twice as data came in and cited a peer-reviewed abstract she found on her own.
- [signal] metacognition: kept a running log of "things my first model got wrong" and used it to improve the next version.

### IDENTITY — deep personal investment, explicitly names the kind of thinker she wants to be
- [signal] task_commitment: chose to redo the entire simulation from scratch rather than patch it, "because a real geneticist wouldn't just paper over a broken model."
- [seed] Explored: "CRISPR and the ethics of gene editing" (frontier, completed) — said she wants "to be the kind of scientist who thinks about the consequences, not just the cool factor."

### Teacher anecdotes
- [major] Mentored a struggling classmate through the same simulation, unprompted.

### Counter-evidence lane
- (none this period)

### Goals & progress
- Publish findings to the class science blog (achieved) — 5 check-ins`,
  },
  {
    id: "mixed-e",
    scholarName: "Deshawn L.",
    periodLabel: "Fall 2026, Quarter 1",
    subject: "Science",
    // Deliberately uneven: strong core + connections, thin practice + identity.
    goldRatings: { core: 6, connections: 5, practice: 2, identity: 2 },
    binderText: `Scholar: Deshawn L. Period: Fall 2026, Quarter 1. Coverage: mixed.

### CORE — regularly demonstrates strong, largely independent understanding (1 student-initiated)
- [mastery, student-initiated] Explained unprompted why a heavier and a lighter ball fall at the same rate in a vacuum, correctly separating mass, weight, and air resistance.
- [granule] Demonstrated: derived the relationship between force, mass, and acceleration from a ramp experiment's own data, without being given the formula first.

### CONNECTIONS — makes strong, largely unprompted interdisciplinary links (1 student-initiated)
- [connection, student-initiated] Connected free-fall equations to a video-game physics engine he was building on his own, unprompted, across three sessions.

### PRACTICE — thin evidence, mostly followed the given protocol exactly
- [deliverable] Deliverable: 2/5 criteria met on the ramp-friction lab; ran the exact procedure once and didn't investigate the one outlier trial.

### IDENTITY — very few self-direction/interest signals surfaced this period
- [signal] task_commitment: completed assigned work reliably but rarely spoke about it outside class; no seeds explored this period.

### Teacher anecdotes
- [minor] Quiet during discussions but answers precisely and correctly when called on.

### Counter-evidence lane
- (none this period)

### Goals & progress
- Share reasoning out loud in group work (active) — 1 check-in`,
  },
];

// DEV-ONLY demo seed for the Concept Atlas. The base rich-cohort seed is
// intentionally sparse (a handful of mastery rows), which makes the per-scholar
// Sky + Class Galaxy thin. This inserts realistic, diverse mastery for the three
// canonical test scholars — using label + evidence (so the atlas embeds them
// well) and a concept ("proportional reasoning") shared by all three, which the
// Class Galaxy surfaces as a convergence. Idempotent per scholar. NOT for prod.
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

type Obs = [concept: string, domain: string, level: number, studentInitiated: boolean, evidence: string];

const SETS: Record<string, Obs[]> = {
  "test-scholar-001": [ // Kai — toxicology rabbit-hole + grade-5 math
    ["dose-response relationships", "biology", 3.8, true, "Kai reasoned a substance's harm depends on the amount, predicting a threshold below which effects vanish."],
    ["molecular mimicry", "biology", 3.5, true, "Kai explained how a toxin fools a receptor by resembling the molecule it normally binds."],
    ["biomagnification", "biology", 2.8, true, "Kai traced how a toxin concentrates up a food chain from plankton to apex predator."],
    ["food chains", "biology", 2.6, true, "Kai mapped energy flow from producers through consumers."],
    ["cross-species extrapolation", "biology", 2.2, false, "Kai questioned whether a mouse result transfers to humans, citing metabolism differences."],
    ["toxicology thresholds", "biology", 2.4, false, "Kai separated a safe dose from a harmful one using a threshold."],
    ["ratio reasoning", "math", 3.0, false, "Kai scaled a recipe by a constant factor, keeping ingredient ratios fixed."],
    ["proportional reasoning", "math", 2.7, false, "Kai found a missing value by setting two ratios equal."],
    ["scaling quantities", "math", 2.5, false, "Kai enlarged a grid drawing by doubling every coordinate."],
    ["conservation of mass", "chemistry", 2.0, true, "Kai noticed the mass before and after a reaction stayed the same."],
  ],
  "test-scholar-002": [ // Lani — small-moments writing + music
    ["small moments", "writing", 3.6, true, "Lani stretched a two-minute event across a full page of careful description."],
    ["sensory detail in narrative", "writing", 3.2, true, "Lani layered sight, sound, and smell into a single zoomed-in moment."],
    ["metaphor", "writing", 3.0, true, "Lani compared dusk to a closing door to carry a feeling of ending."],
    ["narrative arc", "writing", 2.9, false, "Lani shaped a piece with rising tension toward a turning point."],
    ["character interiority", "writing", 2.5, false, "Lani revealed a character's fear through her thoughts, not narration."],
    ["figurative language", "reading", 2.8, false, "Lani identified a simile and explained the comparison it draws."],
    ["note values", "music", 3.1, true, "Lani filled a 4/4 measure with note values that sum to one whole."],
    ["rhythm subdivision", "music", 2.4, true, "Lani split a beat into evenly spaced sixteenth notes."],
    ["harmonic ratios", "music", 2.1, false, "Lani noticed simple whole-number ratios behind consonant intervals."],
    ["proportional reasoning", "math", 2.3, false, "Lani related note durations as fractions of a whole measure."],
  ],
  "test-scholar-003": [ // Noah — history + civics
    ["chronological thinking", "history", 3.0, true, "Noah ordered events on a timeline and reasoned about durations."],
    ["primary vs secondary sources", "history", 2.7, false, "Noah judged a source's reliability by who wrote it and when."],
    ["historical causation", "history", 2.5, false, "Noah distinguished a trigger from deeper underlying causes."],
    ["bias in sources", "history", 2.2, false, "Noah flagged a source's slant and looked for corroboration."],
    ["supply and demand", "civics-econ", 2.4, false, "Noah predicted a price rise when supply fell and demand held."],
    ["opportunity cost", "civics-econ", 2.6, true, "Noah weighed what is given up when choosing one option."],
    ["perspective-taking", "social-emotional", 2.3, false, "Noah argued a historical decision from two opposing viewpoints."],
    ["proportional reasoning", "math", 2.0, false, "Noah compared army sizes as ratios across two empires."],
  ],
};

export const seedAtlasDemo = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scholars: string[]; inserted: number }> => {
    let inserted = 0;
    const scholars: string[] = [];
    for (const [username, set] of Object.entries(SETS)) {
      const user = await ctx.db.query("users").withIndex("by_username", (q) => q.eq("username", username)).first();
      if (!user) continue;
      const session = (await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", user._id)).first())
        ?? (await ctx.db.query("sessions").first()); // sessionId is an FK the atlas views don't read
      if (!session) continue;
      // idempotent: skip if the first demo concept already present for this scholar
      const existing = await ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
        .collect();
      if (existing.some((o) => o.conceptLabel === set[0][0])) continue;

      for (const [concept, domain, level, studentInitiated, evidence] of set) {
        await ctx.db.insert("masteryObservations", {
          scholarId: user._id as Id<"users">,
          conceptLabel: concept,
          domain,
          observedAt: Date.now() - Math.floor(Math.random() * 12) * 86400000,
          sessionId: session._id,
          transcriptExcerpt: `"${evidence.split(",")[0]}…"`,
          masteryLevel: level,
          confidenceScore: 0.7 + Math.random() * 0.25,
          evidenceSummary: evidence,
          evidenceType: "direct_demonstration",
          attemptContext: "demo-seed",
          studentInitiated,
          isSuperseded: false,
        });
        inserted++;
      }
      scholars.push(username);
    }
    return { scholars, inserted };
  },
});

/**
 * DEV-ONLY: attach a few atlas-resident, grade-specific Math standards to Kai's
 * math mastery so his Knowledge Tree shows evidenced cells — making the Phase-4
 * "meat on the skeleton" reachable (drill a cell → standard → related concepts).
 */
export const attachDemoStandards = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ attached: number; scholar: string | null; usableStandards: number }> => {
    const kai = await ctx.db.query("users").withIndex("by_username", (q) => q.eq("username", "test-scholar-001")).first();
    if (!kai) return { attached: 0, scholar: null, usableStandards: 0 };
    const stdConcepts = await ctx.db.query("knowledgeNodes").withIndex("by_source", (q) => q.eq("source", "standard")).collect();
    const usable: Id<"standards">[] = [];
    for (const c of stdConcepts) {
      if (c.domain.toLowerCase() !== "math" || !c.standardId) continue;
      const s = await ctx.db.get(c.standardId);
      if (s && (s.gradeLevels ?? []).some((g) => ["3", "4", "5", "6"].includes(g))) {
        usable.push(c.standardId);
        if (usable.length >= 6) break;
      }
    }
    if (!usable.length) return { attached: 0, scholar: kai.name ?? null, usableStandards: 0 };
    const targets = ["ratio reasoning", "proportional reasoning", "scaling quantities"];
    const obs = await ctx.db.query("masteryObservations").withIndex("by_scholar", (q) => q.eq("scholarId", kai._id)).collect();
    let attached = 0, i = 0;
    for (const o of obs) {
      if (!targets.includes(o.conceptLabel) || (o.standardIds && o.standardIds.length)) continue;
      await ctx.db.patch(o._id, { standardIds: [usable[i % usable.length]] });
      i++; attached++;
    }
    return { attached, scholar: kai.name ?? null, usableStandards: usable.length };
  },
});

// Inserts the 3 complete production units (Aquaponics QUEST, SpaceX & the IPO
// Question, Autorotation) — each with its full lesson + activity tree — into a
// dev deployment. These give the seed a few REALISTIC, fully-built units (with
// online activities, deliverables, and process refs) instead of only the bare
// shell units the bulk seed produces. Called from seedData.seedAll.
//
// The data lives in the auto-generated seedProdUnitsData.ts. Process refs are
// resolved by slug — reusing an already-seeded process with that slug, or
// creating it from the fixture — so this is safe to run before or after the
// bulk process seed.
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeGranules } from "./lib/granules";
import { PROD_UNITS_SEED } from "./seedProdUnitsData";

type Strand = NonNullable<Doc<"lessons">["strand"]>;
type Kind = Doc<"activities">["kind"];
type Deliverable = Doc<"activities">["deliverable"];

// The auto-generated fixture is plain JSON; describe its shape so the inserter
// is typed without per-field casts. (Field-level optionality mirrors what the
// prod docs actually carried.)
interface SeedProcess {
  slug: string;
  title: string;
  emoji?: string;
  description?: string;
  systemPrompt?: string;
  steps?: { key: string; title: string; description?: string }[];
}
interface SeedActivity {
  title: string;
  kind: string;
  order: number;
  systemPrompt?: string;
  description?: string;
  // Scholar-facing blurb for the scholar's home card / activity nav — distinct
  // audience from `description` (teacher-facing). Omitted on fixture entries
  // that are pure teacher facilitation steps with no scholar-facing task.
  scholarDescription?: string;
  durationMinutes?: number;
  deliverable?: unknown;
  processSlug?: string;
}
interface SeedLesson {
  title: string;
  order: number;
  strand?: string;
  systemPrompt?: string;
  durationMinutes?: number;
  processSlug?: string;
  activities: SeedActivity[];
}
interface SeedUnit {
  title: string;
  slug: string;
  isActive: boolean;
  emoji?: string;
  subject?: string;
  gradeLevel?: string;
  bigIdea?: string;
  description?: string;
  essentialQuestions?: string[];
  enduringUnderstandings?: string[];
  lessons: SeedLesson[];
}
const SEED = PROD_UNITS_SEED as unknown as {
  processes: SeedProcess[];
  units: SeedUnit[];
};

/** Returns the number of units inserted. */
export async function insertProdUnits(
  ctx: MutationCtx,
  teacherId: Id<"users">,
): Promise<number> {
  // Resolve each referenced process by slug — reuse an existing one, else
  // create it from the fixture.
  const slugToProcess = new Map<string, Id<"processes">>();
  for (const p of SEED.processes) {
    const existing = await ctx.db
      .query("processes")
      .withIndex("by_slug", (q) => q.eq("slug", p.slug))
      .first();
    if (existing) {
      slugToProcess.set(p.slug, existing._id);
      continue;
    }
    const id = await ctx.db.insert("processes", {
      teacherId,
      title: p.title,
      slug: p.slug,
      emoji: p.emoji,
      description: p.description,
      systemPrompt: p.systemPrompt,
      steps: p.steps ?? [],
      isActive: true,
    });
    slugToProcess.set(p.slug, id);
  }

  for (const u of SEED.units) {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: u.title,
      slug: u.slug,
      isActive: true,
      emoji: u.emoji,
      subject: u.subject,
      gradeLevel: u.gradeLevel,
      bigIdea: u.bigIdea,
      description: u.description,
      essentialQuestions: u.essentialQuestions
        ? normalizeGranules(u.essentialQuestions, "eq")
        : undefined,
      enduringUnderstandings: u.enduringUnderstandings
        ? normalizeGranules(u.enduringUnderstandings, "eu")
        : undefined,
    });
    for (const l of u.lessons) {
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: l.title,
        order: l.order,
        strand: l.strand as Strand | undefined,
        systemPrompt: l.systemPrompt,
        durationMinutes: l.durationMinutes,
        processId: l.processSlug ? slugToProcess.get(l.processSlug) : undefined,
      });
      for (const a of l.activities) {
        await ctx.db.insert("activities", {
          lessonId,
          title: a.title,
          order: a.order,
          kind: a.kind as Kind,
          systemPrompt: a.systemPrompt,
          description: a.description,
          // Explicitly authored fixture value only — never derived from
          // `description` (different audience; see SeedActivity comment).
          scholarDescription: a.scholarDescription,
          durationMinutes: a.durationMinutes,
          deliverable: a.deliverable as Deliverable,
          processId: a.processSlug
            ? slugToProcess.get(a.processSlug)
            : undefined,
        });
      }
    }
  }

  return SEED.units.length;
}

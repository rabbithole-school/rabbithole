// Fictional Moli-School physical-environment inventory (DEV ONLY).
//
// Seeds a few real-feeling rooms + equipment so the tutor's PHYSICAL
// ENVIRONMENT prompt section (see convex/prompts.ts) has something to invite
// scholars toward, and so the /admin/school-space editor has content to show.
// Everything is tutor-suggestable by default here (dev) so the loop is
// immediately testable; a curator flips individual items in the editor.
//
// Institution-scoped, keyed to "Moli School" (the dev primary — the fictional
// primary school). Idempotent on (institution, name) for both rooms and gear, so
// it's safe to re-run and safe to run after seed/institutions.
//
// NEVER runs on prod: real rooms are curated with staff via the
// editor, never fictional data (see the plan's "Out of scope").
//
// Concept tagging (equipment.conceptIds → the Knowledge-Tree lens) is left to
// the editor / a later two-lens wiring pass: the `concepts` table is built
// separately (concepts.rebuild) and is typically empty on a fresh seed, so
// tagging here would attach nothing. The prompt loop works fully without it.

import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { ensureDevInstitutions } from "./institutions";

/** Dev-only guard — never seed fictional rooms into the real school. */
function isProdDeployment(): boolean {
  let isProduction = false;
  return isProduction;
}

type SpaceKind =
  | "classroom"
  | "lab"
  | "music"
  | "art"
  | "library"
  | "makerspace"
  | "outdoor"
  | "gym"
  | "other";

type Supervision = "none" | "adult_present" | "teacher_only";

type EquipmentSeed = {
  name: string;
  category?: string;
  description?: string;
  quantity?: string;
  supervision?: Supervision;
  safetyNotes?: string;
  usageIdeas?: string[];
};

type SpaceSeed = {
  name: string;
  kind: SpaceKind;
  description?: string;
  equipment: EquipmentSeed[];
};

const MOLI_INVENTORY: SpaceSeed[] = [
  {
    name: "Music Room",
    kind: "music",
    description: "Instruments and sound-making gear.",
    equipment: [
      {
        name: "Set of hand bells",
        category: "musical",
        description: "Tuned hand bells, one octave",
        quantity: "8 bells (C–C)",
        usageIdeas: [
          "Ring two bells together and listen for which pairs sound especially good together — describe what you hear.",
          "Explore whether some pairs blend and others clash, and see if you can find a pattern in which ones do.",
        ],
      },
      {
        name: "Singing bowl",
        category: "musical",
        description: "Metal bowl that hums when struck or rubbed",
        quantity: "1",
        usageIdeas: [
          "Strike the bowl with different objects (a soft mallet, a pencil, your finger) and describe how the sound changes.",
          "Rest a hand lightly on the rim while it rings and notice what happens.",
        ],
      },
      {
        name: "Upright piano",
        category: "musical",
        description: "Acoustic piano",
        quantity: "1",
        usageIdeas: [
          "Look closely at how the black and white keys are grouped and see what pattern you notice.",
          "Find two keys that sound good together and then find another pair that sounds the same way higher up.",
        ],
      },
    ],
  },
  {
    name: "Math Corner",
    kind: "classroom",
    description: "Hands-on math manipulatives and measuring tools.",
    equipment: [
      {
        name: "Compass & straight-edge",
        category: "tools",
        description: "Geometry compass and a ruler",
        quantity: "class set",
        supervision: "none",
        safetyNotes: "The compass point is sharp — keep it pointed at the paper.",
        usageIdeas: [
          "Try to draw a perfect hexagon using only the compass and straight-edge, and notice what stays the same each step.",
          "See if you can divide a line exactly in half without measuring it.",
        ],
      },
      {
        name: "Tape measures",
        category: "measurement",
        description: "Retractable tape measures",
        quantity: "6",
        usageIdeas: [
          "Measure something big in the room and something small, and describe anything surprising about the numbers.",
        ],
      },
      {
        name: "Metronome",
        category: "measurement",
        description: "Mechanical/beat metronome",
        quantity: "2",
        usageIdeas: [
          "Set it to a slow beat, then twice as fast, and describe how the two relate.",
        ],
      },
    ],
  },
  {
    name: "Science Shelf",
    kind: "lab",
    description: "A small shelf of exploration materials.",
    equipment: [
      {
        name: "Hand lenses (magnifiers)",
        category: "scientific",
        description: "Handheld magnifying glasses",
        quantity: "8",
        usageIdeas: [
          "Look closely at something ordinary (a leaf, a fingertip, fabric) and describe what you can see that you couldn't before.",
        ],
      },
      {
        name: "Balance scale",
        category: "scientific",
        description: "Two-pan balance",
        quantity: "1",
        supervision: "adult_present",
        safetyNotes: "The small masses are a choking hazard — use with a teacher.",
        usageIdeas: [
          "Find two different objects that balance each other and describe what you notice about them.",
        ],
      },
    ],
  },
];

async function findSpace(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  name: string,
) {
  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  return spaces.find((s) => s.name === name) ?? null;
}

async function findEquipment(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  name: string,
) {
  const items = await ctx.db
    .query("equipment")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  return items.find((e) => e.name === name) ?? null;
}

/**
 * Idempotently seed the Moli-School physical inventory. Re-running syncs the
 * seeded fields (name/kind/description on rooms; the descriptive + task fields
 * on gear) but never touches a curator's `tutorSuggestable` flip after the
 * first create (so hiding an item in the editor sticks across re-seeds).
 */
export const seedDevPhysicalEnvironment = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (isProdDeployment()) {
      console.log(
        "seedDevPhysicalEnvironment: SKIPPED on prod (real rooms are curated with staff).",
      );
      return { skipped: true as const };
    }

    const { moli } = await ensureDevInstitutions(ctx);
    let spacesCreated = 0;
    let equipmentCreated = 0;

    for (const room of MOLI_INVENTORY) {
      let space = await findSpace(ctx, moli, room.name);
      if (!space) {
        const id = await ctx.db.insert("spaces", {
          institutionId: moli,
          name: room.name,
          kind: room.kind,
          description: room.description,
          isActive: true,
        });
        space = await ctx.db.get(id);
        spacesCreated++;
      } else {
        await ctx.db.patch(space._id, {
          kind: room.kind,
          description: room.description,
        });
      }
      if (!space) continue;

      for (const gear of room.equipment) {
        const existing = await findEquipment(ctx, moli, gear.name);
        if (!existing) {
          await ctx.db.insert("equipment", {
            institutionId: moli,
            spaceId: space._id,
            name: gear.name,
            category: gear.category,
            description: gear.description,
            quantity: gear.quantity,
            // Suggestable by default in DEV so the loop is testable out of the
            // box; the editor is where a curator turns items off.
            tutorSuggestable: true,
            supervision: gear.supervision ?? "none",
            safetyNotes: gear.safetyNotes,
            usageIdeas: gear.usageIdeas,
            isActive: true,
          });
          equipmentCreated++;
        } else {
          // Sync descriptive fields only — preserve the curator's gate.
          await ctx.db.patch(existing._id, {
            spaceId: space._id,
            category: gear.category,
            description: gear.description,
            quantity: gear.quantity,
            supervision: gear.supervision ?? "none",
            safetyNotes: gear.safetyNotes,
            usageIdeas: gear.usageIdeas,
          });
        }
      }
    }

    console.log(
      `seedDevPhysicalEnvironment: Moli School inventory — ${spacesCreated} new room(s), ${equipmentCreated} new item(s).`,
    );
    return { skipped: false as const, spacesCreated, equipmentCreated };
  },
});

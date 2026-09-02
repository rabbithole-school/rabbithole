// Deterministic "Launchpad demo" scholars (DEV/PREVIEW ONLY).
//
// The instructional-segment Launchpad only surfaces for a scholar who is (a)
// PLACED in a domain (so no placement gate pre-empts the daily run) yet (b) has
// a genuinely NEW frontier strand with zero mastery and PASSED content. That is
// a specific mid-flow state that drifts every time the rich cohort is reseeded,
// which makes it useless for a stable demo / QA link.
//
// This seed pins scholars into the cleanest possible version of that state — a
// COMPLETE whole-number-arithmetic placement (so `needsPlacement` is false and
// no gate pre-empts the run) plus a deterministic mastery floor that parks the
// frontier at a chosen strand:
//
//   • launchpad_demo       — Kanoa (K). NO mastery rows ⇒ the frontier sits at
//     the ROOT "counting" strand ⇒ "Counting tells how many" Launchpad.
//   • launchpad_demo_mult  — Maile (grade 3). Every counting / add-subtract /
//     place-value node is fluent (repetition ≥ FLUENT_REPS) so those strands
//     leave the frontier, while mult-divide has ZERO mastery and an accessible
//     frontier node (skip_count_2s_5s_10s, whose only prereqs are the mastered
//     counting nodes). mult-divide is then the earliest-order NEW strand ⇒
//     "Multiplication is equal groups" — a 3rd/4th-grade Launchpad.
//
// Log in via:
//   /dev-login?u=launchpad_demo&to=/scholar/practice?domain=whole-number-arithmetic
//   /dev-login?u=launchpad_demo_mult&to=/scholar/practice?domain=whole-number-arithmetic
//
// Idempotent on username + on the (scholar, domain) placement + per-skill mastery
// rows, so both are safe to re-run. NEVER runs on prod.
//
// Both seeders ALSO (re)seed the authored Launchpad content, because a parked
// frontier is only half the fixture — the selector additionally requires PASSED
// `instructionContent` for the strand, and `db:reset` wipes that table.

import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { ROLES } from "../lib/roles";
import { ensureMembership } from "../memberships";
import { ensureDevInstitutions } from "./institutions";
import { seedAuthoredInstructionInto } from "../instruction";
import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
} from "./wholeNumberArithmeticGraph";

/** Dev-only guard — never create fixture scholars on prod. */
function isProdDeployment(): boolean {
  let isProduction = false;
  return isProduction;
}

export const DEMO_USERNAME = "launchpad_demo";
export const DEMO_USERNAME_MULT = "launchpad_demo_mult";

// The mult-divide demo parks the frontier by making every EARLIER strand fluent.
// mult-divide + number-theory are left untouched (zero mastery); mult-divide wins
// the "earliest new strand" tiebreak because skip_count_2s_5s_10s (its first node)
// orders ahead of number-theory's factors_and_multiples.
const MULT_DEMO_MASTERED_STRANDS = new Set([
  "counting",
  "add-subtract",
  "place-value",
]);

/**
 * Create-or-fetch a demo scholar at Moli with a COMPLETE whole-number-arithmetic
 * placement (removes the placement gate). Returns the scholar id.
 */
async function ensurePlacedDemoScholar(
  ctx: MutationCtx,
  args: {
    username: string;
    name: string;
    gradeLevel: string;
    dateOfBirth: string;
    moli: Id<"institutions">;
  },
): Promise<Id<"users">> {
  const { username, name, gradeLevel, dateOfBirth, moli } = args;
  const existing = await ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("username", username))
    .unique();
  const scholarId =
    existing?._id ??
    (await ctx.db.insert("users", {
      username,
      name,
      role: ROLES.SCHOLAR,
      institutionId: moli,
      gradeLevel,
      dateOfBirth,
      profileSetupComplete: true,
    }));
  if (existing && existing.institutionId !== moli) {
    await ctx.db.patch(scholarId, { institutionId: moli });
  }
  await ensureMembership(ctx, {
    userId: scholarId,
    role: ROLES.SCHOLAR,
    institutionId: moli,
  });

  const placement = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) =>
      q.eq("scholarId", scholarId).eq("domain", WHOLE_NUMBER_ARITHMETIC_DOMAIN),
    )
    .first();
  if (!placement) {
    await ctx.db.insert("practicePlacements", {
      scholarId,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      status: "complete",
      probesAnswered: 0,
      updatedAt: Date.now(),
    });
  } else if (placement.status !== "complete") {
    await ctx.db.patch(placement._id, { status: "complete", updatedAt: Date.now() });
  }
  return scholarId;
}

/**
 * Stamp a fluent (past-the-frontier) demonstrated mastery row for one skill:
 * repetition ≥ FLUENT_REPS so `isFluentPlus` is true and the node leaves the
 * frontier. Idempotent per (scholar, skill).
 */
async function ensureFluentMastery(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  skillKey: string,
  strand: string,
): Promise<void> {
  const existing = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar_skill", (q) =>
      q.eq("scholarId", scholarId).eq("skillKey", skillKey),
    )
    .first();
  const now = Date.now();
  if (existing) {
    if (existing.repetition < 3) {
      await ctx.db.patch(existing._id, {
        repetition: 3,
        source: "practice",
        becameFluentAt: now,
        lastPracticedAt: now,
        lastAttemptAt: now,
        updatedAt: now,
      });
    }
    return;
  }
  await ctx.db.insert("practiceMastery", {
    scholarId,
    skillKey,
    domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    strand,
    repetition: 3,
    halfLifeDays: 30,
    lastPracticedAt: now,
    lastAttemptAt: now,
    frontier: false,
    source: "practice",
    updatedAt: now,
    becameFluentAt: now,
  });
}

export const seedLaunchpadDemoScholar = internalMutation({
  handler: async (ctx: MutationCtx) => {
    if (isProdDeployment()) {
      console.log("seedLaunchpadDemoScholar: skipped (prod).");
      return;
    }
    const { moli } = await ensureDevInstitutions(ctx);

    // Zero mastery + a COMPLETE placement ⇒ no placement gate, frontier at the
    // root "counting" strand ⇒ deterministic "Counting tells how many" Launchpad.
    await ensurePlacedDemoScholar(ctx, {
      username: DEMO_USERNAME,
      name: "Kanoa (Launchpad demo)",
      gradeLevel: "K",
      dateOfBirth: "2020-01-15",
      moli,
    });

    // A parked frontier is only HALF the fixture: the selector also requires
    // PASSED instructional content for the strand (`hasContent`). `db:reset`
    // wipes `instructionContent` and no other seeder refills it, so without
    // this the demo scholar silently gets no Launchpad at all.
    const instruction = await seedAuthoredInstructionInto(ctx);

    console.log(
      `seedLaunchpadDemoScholar: ${DEMO_USERNAME} placed (WNA complete, zero mastery) @ Moli; ` +
        `${instruction.passed}/${instruction.stored} authored Launchpads passed.`,
    );
  },
});

export const seedLaunchpadDemoScholarMult = internalMutation({
  handler: async (ctx: MutationCtx) => {
    if (isProdDeployment()) {
      console.log("seedLaunchpadDemoScholarMult: skipped (prod).");
      return;
    }
    const { moli } = await ensureDevInstitutions(ctx);

    const scholarId = await ensurePlacedDemoScholar(ctx, {
      username: DEMO_USERNAME_MULT,
      name: "Maile (Launchpad demo · grade 3)",
      gradeLevel: "3",
      dateOfBirth: "2017-01-15",
      moli,
    });

    // Make every counting / add-subtract / place-value node fluent so those
    // strands leave the frontier; leave mult-divide + number-theory at zero
    // mastery. The frontier then opens at mult-divide (skip_count_2s_5s_10s),
    // the earliest NEW strand with passed content ⇒ deterministic
    // "Multiplication is equal groups" Launchpad.
    let mastered = 0;
    for (const skill of WHOLE_NUMBER_ARITHMETIC_SKILLS) {
      if (!MULT_DEMO_MASTERED_STRANDS.has(skill.strand)) continue;
      await ensureFluentMastery(ctx, scholarId, skill.skillKey, skill.strand);
      mastered++;
    }

    // Same reason as the K fixture: the parked frontier is inert without
    // PASSED instructional content for mult-divide.
    const instruction = await seedAuthoredInstructionInto(ctx);

    console.log(
      `seedLaunchpadDemoScholarMult: ${DEMO_USERNAME_MULT} placed (WNA complete, ${mastered} nodes fluent, mult-divide frontier) @ Moli; ` +
        `${instruction.passed}/${instruction.stored} authored Launchpads passed.`,
    );
  },
});

import { internalMutation, type MutationCtx } from "../_generated/server";
import { ROLES } from "../lib/roles";
import type { Id } from "../_generated/dataModel";

/**
 * Dev-only demo seed for the Scholars roster "Now vs Lately" board.
 *
 * The roster reads the observer's EXISTING `analyses` rows, but in a fresh
 * local (plane-mode) backend those cluster at ~now with flat scores — so the
 * sparklines, trend arrows, and attention pips have nothing to show. This seed
 * paints a designed engagement TRAJECTORY per scholar (rising / sliding /
 * volatile / steady-high / low-with-concerns / quiet-return) so a screenshot
 * exercises every pip, arrow, and sparkline shape.
 *
 * It is additive and idempotent: every row it writes is stamped
 * `promptVersion: "roster-pulse-demo"`, and each run first deletes the sessions
 * + analyses from a prior run (found via that stamp) before repainting. It only
 * touches its own rows — real seed data is left alone. NEVER run in production.
 *
 * Run (against a running local backend):
 *   npx convex run seed/rosterPulseDemo:run
 *   npx convex run seed/rosterPulseDemo:clear   # remove demo rows only
 */

const DEMO_MARKER = "roster-pulse-demo";

// ── Trajectory archetypes ─────────────────────────────────────────────────────
// Each is a designed sequence of observer readings (oldest → newest). Engagement
// + on-task are 0–1; `concerns` is a per-reading list (drives the recurring-
// concern chips + the attention pip). `pulse` (0–5) and `now` feed the live
// "Now" row (orb + activity line); `title` names the demo session.

interface Archetype {
  key: string;
  title: string;
  now: string; // analysisSummary — the "what are they doing now?" line
  pulse: number; // 0–5, drives the live orb
  engagement: number[];
  onTask: number[];
  concerns: string[][]; // same length as engagement
  /** Observer's most-recent sentence-level read (drives the Lately "story"). */
  summary: string;
  /** Observer's suggested next step, if any. */
  intervention?: string;
}

const N = 12;
const flat = (v: number) => Array.from({ length: N }, () => v);
const jitter = (base: number[], amp: number, seed: number) =>
  base.map((v, i) => clamp01(v + Math.sin(seed + i * 1.7) * amp));
const noConcerns = (): string[][] => Array.from({ length: N }, () => []);

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Math.round(x * 100) / 100));
}

// Linear ramp from a→b over N points.
function ramp(a: number, b: number): number[] {
  return Array.from({ length: N }, (_, i) => clamp01(a + ((b - a) * i) / (N - 1)));
}

const ARCHETYPES: Archetype[] = [
  {
    key: "rising",
    title: "Geometry proofs",
    now: "Deep in a proof — asking sharper questions each turn.",
    pulse: 4,
    engagement: ramp(0.42, 0.9),
    onTask: ramp(0.55, 0.95),
    concerns: noConcerns(),
    summary:
      "Started slow but is now justifying each step of the two-column proof unprompted.",
    intervention: "Offer a stretch proof while the momentum is there.",
  },
  {
    key: "sliding",
    title: "Persuasive essay",
    now: "Replies getting terse; starting to drift off task.",
    pulse: 2,
    engagement: ramp(0.88, 0.44),
    onTask: ramp(0.9, 0.5),
    concerns: (() => {
      const c = noConcerns();
      c[8] = ["short replies"];
      c[10] = ["disengaged"];
      c[11] = ["off-task", "disengaged"];
      return c;
    })(),
    summary:
      "Answers shrank to a few words and drifted from the essay prompt over the last stretch.",
    intervention: "Check in on the topic — it may not have clicked.",
  },
  {
    key: "volatile",
    title: "Fractions practice",
    now: "Bursts of focus between detours.",
    pulse: 3,
    engagement: [0.4, 0.8, 0.45, 0.85, 0.5, 0.75, 0.4, 0.82, 0.48, 0.7, 0.55, 0.78],
    onTask: [0.5, 0.85, 0.55, 0.8, 0.6, 0.78, 0.5, 0.84, 0.58, 0.75, 0.62, 0.8],
    concerns: (() => {
      const c = noConcerns();
      c[6] = ["off-task"];
      c[8] = ["off-task"];
      return c;
    })(),
    summary:
      "Focus comes in bursts — strong on worked examples, then wanders on the practice set.",
    intervention: "Try shorter problem sets with a clear finish line.",
  },
  {
    key: "steady-high",
    title: "Novel study",
    now: "Locked in — steady, high engagement all week.",
    pulse: 5,
    engagement: jitter(flat(0.86), 0.03, 1.2),
    onTask: jitter(flat(0.9), 0.03, 2.4),
    concerns: noConcerns(),
    summary:
      "Held steady, high engagement across the novel study — thoughtful, on-topic responses throughout.",
  },
  {
    key: "low-concern",
    title: "Algebra warm-ups",
    now: "Struggling to get started — worth a check-in.",
    pulse: 1,
    engagement: jitter(flat(0.34), 0.05, 0.6),
    onTask: jitter(flat(0.4), 0.05, 1.9),
    concerns: (() => {
      const c = noConcerns();
      c[5] = ["frustration"];
      c[7] = ["off-task"];
      c[9] = ["rushing"];
      c[10] = ["off-task"];
      c[11] = ["frustration", "rushing"];
      return c;
    })(),
    summary:
      "Repeated frustration getting started; rushed through and abandoned several warm-ups.",
    intervention: "Sit together for the first problem to lower the entry cost.",
  },
  {
    key: "quiet-return",
    title: "Science lab notebook",
    now: "Back after a quiet stretch — warming up again.",
    pulse: 3,
    // Fewer readings: a short, recent series (the roster shows a stubby line).
    engagement: [0.55, 0.58, 0.6, 0.64, 0.7, 0.72],
    onTask: [0.6, 0.62, 0.66, 0.7, 0.74, 0.78],
    concerns: [[], [], [], [], [], []],
    summary:
      "Re-engaging after a quiet stretch — engagement climbing session over session.",
  },
];

// ── Clear (idempotency) ───────────────────────────────────────────────────────

async function clearDemo(ctx: MutationCtx): Promise<{ analyses: number; sessions: number }> {
  const all = await ctx.db.query("analyses").collect();
  const demo = all.filter((a) => a.promptVersion === DEMO_MARKER);
  const sessionIds = new Set<Id<"sessions">>();
  for (const a of demo) {
    sessionIds.add(a.sessionId);
    await ctx.db.delete(a._id);
  }
  for (const sid of sessionIds) await ctx.db.delete(sid);
  return { analyses: demo.length, sessions: sessionIds.size };
}

export const clear = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await clearDemo(ctx);
  },
});

// ── Run ───────────────────────────────────────────────────────────────────────

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Repaint from clean — remove any prior demo rows first.
    const removed = await clearDemo(ctx);

    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();

    let sessions = 0;
    let analyses = 0;

    for (let i = 0; i < scholars.length; i++) {
      const scholar = scholars[i];
      const arch = ARCHETYPES[i % ARCHETYPES.length];

      // One dedicated demo session per scholar. Inserted now, so it becomes the
      // scholar's most-recent session — its pulse/summary drive the "Now" row.
      const lastEng = arch.engagement[arch.engagement.length - 1];
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar._id,
        title: arch.title,
        isArchived: false,
        seedExemplar: true,
        pulseScore: arch.pulse,
        analysisSummary: arch.now,
        lastMessageAt: Date.now(),
        lastMessageRole: "user",
        lastMessagePreview: arch.now,
      });
      sessions++;

      // A single user message so the roster's "last message" has something.
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: arch.now,
        flagged: false,
      });

      // The trajectory: one analysis per reading, oldest → newest. Insertion
      // order == _creationTime order, which is exactly how the sparkline reads
      // the sequence.
      for (let k = 0; k < arch.engagement.length; k++) {
        const isLatest = k === arch.engagement.length - 1;
        // The newest reading carries the observer's real sentence-level
        // summary + suggested next step (what the Lately "story" surfaces).
        // Earlier readings keep a lightweight progress line so the story
        // reflects the *current* read, not a stale one.
        await ctx.db.insert("analyses", {
          sessionId,
          engagementScore: arch.engagement[k],
          onTaskScore: arch.onTask[k],
          complexityLevel: clamp01(0.5 + lastEng * 0.3),
          concernFlags: arch.concerns[k] ?? [],
          summary: isLatest
            ? arch.summary
            : `${arch.title}: engagement ${Math.round(arch.engagement[k] * 100)}%`,
          ...(isLatest && arch.intervention
            ? { suggestedIntervention: arch.intervention }
            : {}),
          promptVersion: DEMO_MARKER,
        });
        analyses++;
      }
    }

    return {
      cleared: removed,
      scholars: scholars.length,
      sessionsCreated: sessions,
      analysesCreated: analyses,
    };
  },
});

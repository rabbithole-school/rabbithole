/**
 * Calls a MIRROR of the production rating-suggester
 * (convex/courseNarrativeAI.ts → suggestRatings). courseNarrativeAI.ts is a
 * "use node" Convex action — it cannot be imported into a plain script — so
 * the system prompt + RATING_TOOL schema below are a byte-for-byte copy of
 * the production ones (keep them in sync by hand if suggestRatings' prompt
 * or schema changes). What IS imported (not copied) is convex/lib/pcm.ts's
 * RUBRIC_BANDS + PCM_META — the actual rubric text the model is rated
 * against — so this eval can't drift on the one thing that matters most:
 * what "good" means.
 */
import Anthropic from "@anthropic-ai/sdk";
import { PCM_META, RUBRIC_BANDS, type PcmDimension } from "../../../convex/lib/pcm";

// Mirrors convex/courseNarrativeAI.ts's RATING_TOOL exactly.
const RATING_TOOL = {
  name: "suggest_ratings" as const,
  description: "The AI's own evidence-based PCM ratings for calibration.",
  input_schema: {
    type: "object" as const,
    required: ["pcmRatings", "rationale"],
    properties: {
      pcmRatings: {
        type: "object" as const,
        properties: {
          core: { type: "integer" as const, description: "1–7 or omit" },
          connections: { type: "integer" as const },
          practice: { type: "integer" as const },
          identity: { type: "integer" as const },
        },
      },
      courseRating: { type: "integer" as const, description: "1–7 overall, or omit" },
      rationale: {
        type: "string" as const,
        description: "Why — cite binder episodes/contexts per dimension. No cohort comparison.",
      },
    },
  },
};

export interface BinderFixture {
  id: string;
  scholarName: string;
  periodLabel: string;
  subject: string;
  /** Pre-rendered, summarizeBinder()-shaped text — a compact evidence brief. */
  binderText: string;
  /** Teacher's hand-assigned "gold" 1–7 rating per dimension. */
  goldRatings: Record<PcmDimension, number>;
}

export interface SuggestRun {
  fixtureId: string;
  ratings: Partial<Record<PcmDimension, number>>;
  courseRating?: number;
  rationale: string;
  latencyMs: number;
  usage: { input: number; output: number };
  error?: string;
}

const anthropic = new Anthropic();

/**
 * Runs the mirrored suggest_ratings call against one binder fixture.
 * `model` is passed in by the caller (the harness defaults to MODELS.OPUS,
 * matching production).
 */
export async function suggestRatingsForFixture(fixture: BinderFixture, model: string): Promise<SuggestRun> {
  const rubricText = RUBRIC_BANDS.map((b) => `${b.band} (${b.numbers.join("–")}): ${b.descriptor}`).join("\n");
  const dimText = Object.entries(PCM_META)
    .map(([, m]) => `${m.label} = ${m.blurb}`)
    .join("; ");

  const start = Date.now();
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1200,
      system:
        "You assign evidence-based PCM ratings (1–7) for a course narrative, on the PREPONDERANCE of evidence over the whole period — never a single assignment. " +
        `The four dimensions: ${dimText}. The bands (two numbers per level; the HIGHER number = secure in the band, the LOWER = entered it):\n${rubricText}\n` +
        "Rate a child against the DESCRIPTORS, never against classmates — no cohort comparison, no percentile. If a dimension's evidence is thin, rate conservatively and say so. Omit a rating you can't support from the binder.",
      tools: [RATING_TOOL],
      tool_choice: { type: "tool", name: "suggest_ratings" },
      messages: [{ role: "user", content: `## Evidence binder\n${fixture.binderText}` }],
    });
    const latencyMs = Date.now() - start;
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      return {
        fixtureId: fixture.id,
        ratings: {},
        rationale: "",
        latencyMs,
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
        error: "no tool_use block",
      };
    }
    const out = toolBlock.input as {
      pcmRatings?: Partial<Record<PcmDimension, number>>;
      courseRating?: number;
      rationale: string;
    };
    return {
      fixtureId: fixture.id,
      ratings: out.pcmRatings ?? {},
      courseRating: out.courseRating,
      rationale: out.rationale ?? "",
      latencyMs,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  } catch (e) {
    return {
      fixtureId: fixture.id,
      ratings: {},
      rationale: "",
      latencyMs: Date.now() - start,
      usage: { input: 0, output: 0 },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

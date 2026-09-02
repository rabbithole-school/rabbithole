import type Anthropic from "@anthropic-ai/sdk";

export const SEL_SYNTHESIS_PROMPT_VERSION =
  "sel-synthesis-2026-08-24-v1" as const;

export const SEL_SYNTHESIS_CITATION_KINDS = [
  "sessionSignal",
  "analysis",
  "alert",
  "observation",
] as const;

export type SelSynthesisCitationKind =
  (typeof SEL_SYNTHESIS_CITATION_KINDS)[number];

export type SelSynthesisCitation = {
  kind: SelSynthesisCitationKind;
  id: string;
  label: string;
  at: number;
};

export type SelSynthesisEvidence = {
  citation: SelSynthesisCitation;
  details: Record<string, unknown>;
};

export type SelSynthesisClaim = {
  text: string;
  cites: SelSynthesisCitation[];
};

export type SelSynthesisToolInput = {
  strengths?: unknown;
  watch?: unknown;
};

export const SEL_SYNTHESIS_TOOL_NAME = "record_sel_synthesis" as const;

export const SEL_SYNTHESIS_TOOL: Anthropic.Tool = {
  name: SEL_SYNTHESIS_TOOL_NAME,
  description:
    "Record a short, strengths-first weekly SEL synthesis for a teacher meeting.",
  input_schema: {
    type: "object",
    properties: {
      strengths: {
        type: "array",
        minItems: 0,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            cites: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: [...SEL_SYNTHESIS_CITATION_KINDS],
                  },
                  id: { type: "string" },
                },
                required: ["kind", "id"],
                additionalProperties: false,
              },
            },
          },
          required: ["text", "cites"],
          additionalProperties: false,
        },
      },
      watch: {
        type: "array",
        minItems: 0,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            cites: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: [...SEL_SYNTHESIS_CITATION_KINDS],
                  },
                  id: { type: "string" },
                },
                required: ["kind", "id"],
                additionalProperties: false,
              },
            },
          },
          required: ["text", "cites"],
          additionalProperties: false,
        },
      },
    },
    required: ["strengths", "watch"],
    additionalProperties: false,
  },
};

export function buildSelSynthesisSystemPrompt(): string {
  return `You write a weekly social-emotional-learning synthesis for a private teacher meeting.

This artifact is teacher-facing only. It never enters the scholar tutor's context.

Use ONLY the evidence rows in the user message. Do not infer a trait, event, motive, diagnosis, or trend that the rows do not support.

Return:
- 2-4 Strengths when the evidence supports them. Strengths may cite ONLY sessionSignal rows. Describe concrete persistence, curiosity, collaboration, delight, productive struggle, self-direction, or other directly observed ways the scholar worked. Category-tagged teacher observations must never be paraphrased into Strengths; the meeting surface quotes that teacher record separately.
- 0-3 Watch items. Watch may cite ONLY analysis, alert, or observation rows. State concrete observations with dates, not diagnoses, predictions, or prescriptions.

Every item must cite at least one exact evidence {kind, id} pair from the input. Never invent or alter an id.

Write plain, concise sentences a teacher can read aloud. Use the scholar's name when natural. Avoid vague praise and vibe-words. Do not output numeric scores, ratings, labels of ability, comparisons with other scholars, or deficit framing. Engagement and on-task values are diagnostic context only; translate them into a supported factual observation without quoting or rating the number.

If the evidence does not support an item, omit it. Empty arrays are honest.`;
}

export function buildSelSynthesisUserPrompt(args: {
  scholarName: string;
  weekKey: string;
  window: { startMs: number; endMs: number };
  evidence: SelSynthesisEvidence[];
}): string {
  return JSON.stringify(
    {
      scholarName: args.scholarName,
      weekKey: args.weekKey,
      window: args.window,
      evidence: args.evidence.map(({ citation, details }) => ({
        citation: {
          ...citation,
          atIso: new Date(citation.at).toISOString(),
        },
        details,
      })),
    },
    null,
    2,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCitationKind(value: unknown): value is SelSynthesisCitationKind {
  return (
    typeof value === "string" &&
    SEL_SYNTHESIS_CITATION_KINDS.includes(
      value as SelSynthesisCitationKind,
    )
  );
}

function normalizeClaims(
  input: unknown,
  citationByKey: Map<string, SelSynthesisCitation>,
  allowedKinds: ReadonlySet<SelSynthesisCitationKind>,
  limit: number,
): SelSynthesisClaim[] {
  if (!Array.isArray(input)) return [];
  const claims: SelSynthesisClaim[] = [];
  for (const rawClaim of input) {
    if (!isRecord(rawClaim) || typeof rawClaim.text !== "string") continue;
    const text = rawClaim.text.trim();
    if (!text || !Array.isArray(rawClaim.cites)) continue;

    const cites: SelSynthesisCitation[] = [];
    const seen = new Set<string>();
    for (const rawCite of rawClaim.cites) {
      if (
        !isRecord(rawCite) ||
        !isCitationKind(rawCite.kind) ||
        typeof rawCite.id !== "string" ||
        !allowedKinds.has(rawCite.kind)
      ) {
        continue;
      }
      const key = `${rawCite.kind}:${rawCite.id}`;
      const citation = citationByKey.get(key);
      if (!citation || seen.has(key)) continue;
      seen.add(key);
      cites.push(citation);
    }
    if (cites.length === 0) continue;
    claims.push({ text, cites });
    if (claims.length === limit) break;
  }
  return claims;
}

export function validateSelSynthesisClaims(
  input: SelSynthesisToolInput,
  evidence: SelSynthesisEvidence[],
): { strengths: SelSynthesisClaim[]; watch: SelSynthesisClaim[] } {
  // This proves citation existence and kind only, not that the claim faithfully
  // describes its cited rows; the grounded system prompt is that risk's mitigation.
  const citationByKey = new Map(
    evidence.map(({ citation }) => [
      `${citation.kind}:${citation.id}`,
      citation,
    ]),
  );
  return {
    strengths: normalizeClaims(
      input.strengths,
      citationByKey,
      new Set<SelSynthesisCitationKind>(["sessionSignal"]),
      4,
    ),
    watch: normalizeClaims(
      input.watch,
      citationByKey,
      new Set<SelSynthesisCitationKind>([
        "analysis",
        "alert",
        "observation",
      ]),
      3,
    ),
  };
}

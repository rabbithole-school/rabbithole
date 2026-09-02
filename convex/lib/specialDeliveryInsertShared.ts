// Shared "Special Delivery insert" artifacts — the tool schema, prompt
// builder, and response parser used by the production action
// (convex/specialDeliveryInsertActions.ts).
//
// Lives in a plain (non-"use node") module, same reason as
// convex/lib/observerShared.ts: keep the tool schema + parsing logic in one
// place any eval/test harness can import verbatim, so a test can never
// quietly drift from what production sends the model.
//
// What this call is: a scholar-safe, tenant-scoped choice among a SHORT list
// of the scholar's own same-day portfolio work (captions only — never
// transcripts, scores, analyses, or private rationale), a small generated
// black-ink charm illustration (a short grounded image brief, later rendered through
// the SAME canonical image pipeline every other generative-art surface in
// this repo uses — convex/lib/gemini.ts's geminiGenerateImage; see
// convex/specialDeliveryInsertActions.ts), or nothing. The model has real
// editorial discretion, including choosing "none" — this is a genuine
// surprise, not a guaranteed daily decoration, and it must never be treated
// as an assessment signal (no score/classification is stored, only the
// frozen editorial output).

import { PROSE_STYLE_GUIDE } from "../prompts";

/** Bump when the prompt, tool schema, or choice semantics change materially,
 * so a frozen `insert` can be traced to the rules that produced it — mirrors
 * SPECIAL_DELIVERY_COPY_VERSION's role for the deterministic letter body. */
export const SPECIAL_DELIVERY_INSERT_VERSION = "insert-v3";

/** Cap on how many same-day portfolio candidates we ever show the model —
 * keeps the prompt small and bounds how much of a scholar's day is exposed
 * at once (already same-day + scholar-scoped upstream). */
export const MAX_PORTFOLIO_CANDIDATES = 6;

export const MAX_INSERT_CAPTION_LENGTH = 140;

/** Bounds the grounded image brief the model hands to the image model — long
 * enough for one concrete, groundable subject + composition note, short
 * enough that a runaway response can never smuggle prose/instructions past
 * the fixed style prompt that wraps it (see buildSketchImagePrompt). */
export const MAX_SKETCH_BRIEF_LENGTH = 220;

export type SpecialDeliveryPortfolioCandidate = {
  /** Scholar-safe caption text only (an AI-authored 1-2 sentence
   * description of the work, or an activity title) — never a score, a
   * rubric verdict, or teacher-only rationale. */
  caption: string;
};

export type SpecialDeliveryInsertThemeFacts = {
  completedActivities: string[];
  practiceLabels: string[];
  sessionTitles: string[];
};

export type SpecialDeliveryInsertChoice =
  | { kind: "none" }
  | { kind: "portfolio"; candidateIndex: number; caption: string }
  | { kind: "sketch"; caption: string; brief: string };

// ─── Tool schema ──────────────────────────────────────────────────────

export const SPECIAL_DELIVERY_INSERT_TOOL = {
  name: "choose_special_delivery_insert",
  description:
    "Choose whether today's Special Delivery letter should include one optional surprise insert: a piece of the scholar's own same-day portfolio work, OR a tiny hand-drawn charm sketch (you describe it, a separate image model draws it), OR nothing. Use real editorial judgment — most days 'none' is the right, honest choice. Never invent facts not given to you.",
  input_schema: {
    type: "object" as const,
    required: ["choice"],
    properties: {
      choice: {
        type: "string" as const,
        enum: ["none", "portfolio", "sketch"],
        description:
          "'portfolio' only if a listed candidate is genuinely worth surfacing; 'sketch' only for a small charm doodle that fits the day; 'none' whenever nothing clearly earns inclusion.",
      },
      portfolioCandidateIndex: {
        type: "integer" as const,
        description:
          "REQUIRED when choice is 'portfolio', and ONLY meaningful then: the 0-based index of the chosen candidate from the numbered list you were given. Never invent an index outside that list.",
      },
      caption: {
        type: "string" as const,
        description: `REQUIRED when choice is 'portfolio' or 'sketch': one short, warm, scholar-safe sentence (<= ${MAX_INSERT_CAPTION_LENGTH} chars). Never mention grades, scores, rubric verdicts, concerns, or anything not given to you. It appears directly beneath an unlabelled image; write the actual subject directly, without announcing an optional or generated extra.`,
      },
      sketchBrief: {
        type: "string" as const,
        description:
          `REQUIRED when choice is 'sketch', and ONLY meaningful then: a concise (<= ${MAX_SKETCH_BRIEF_LENGTH} chars) description of ONE concrete, groundable subject for a small charm illustration (e.g. "a tide pool with a hermit crab and a starfish" or "a paper airplane looping past a cloud"). Ground it in today's real themes when given any; avoid generic smiley faces, trophies, or celebration confetti unless genuinely relevant to the day. Describe ONLY the subject/composition — never mention drawing style, colors, or medium; that is fixed separately. NEVER include text, letters, numbers, or words to render in the image.`,
      },
    },
  },
};

// ─── Prompt assembly ──────────────────────────────────────────────────

function clip(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function buildInsertUserPrompt(args: {
  scholarFirstName: string;
  candidates: SpecialDeliveryPortfolioCandidate[];
  theme: SpecialDeliveryInsertThemeFacts;
}): string {
  const { scholarFirstName, candidates, theme } = args;
  const lines: string[] = [
    `Today's Special Delivery letter is for ${scholarFirstName}. Decide whether it should carry one optional surprise insert.`,
    "",
  ];

  if (candidates.length > 0) {
    lines.push("Same-day portfolio candidates (choose by index, if any fits):");
    candidates.forEach((c, i) => {
      lines.push(`${i}. ${clip(c.caption, 200)}`);
    });
  } else {
    lines.push("No same-day portfolio candidates are available today.");
  }
  lines.push("");

  const themeBits = [
    ...theme.completedActivities.map((t) => `completed "${t}"`),
    ...theme.sessionTitles.map((t) => `worked on "${t}"`),
    ...theme.practiceLabels.map((t) => `practiced ${t}`),
  ];
  if (themeBits.length > 0) {
    lines.push(
      `If you choose a sketch, ground its subject loosely in today's themes (never a literal illustration of scores or performance): ${themeBits.slice(0, 6).join("; ")}.`,
    );
  } else {
    lines.push("No specific theme cues are available today for a sketch.");
  }
  lines.push(
    "",
    "If you choose an insert, its printed caption follows this house prose style:",
    PROSE_STYLE_GUIDE,
    "",
    "Choose based only on the evidence above: 'none' is a fully legitimate, often-correct choice. Only pick 'portfolio' or 'sketch' when it is a genuine, honest surprise worth a moment of delight. The wording rules above apply only after that choice; they do not make an insert more warranted.",
  );
  return lines.join("\n");
}

// ─── Response parsing ──────────────────────────────────────────────────

type ResponseContentBlock = { type: string; input?: unknown };

type RawInsertResponse = {
  choice?: unknown;
  portfolioCandidateIndex?: unknown;
  caption?: unknown;
  sketchBrief?: unknown;
};

/**
 * Parse + fully sanitize the model's tool-call response into a safe
 * `SpecialDeliveryInsertChoice`. Every field is re-validated here regardless
 * of what the tool schema "asked" for — the schema guides the model, it does
 * not enforce it. Returns `{ kind: "none" }` for any missing/malformed/
 * out-of-range response rather than throwing, so a parsing hiccup degrades
 * to the always-safe default.
 */
export function parseInsertToolResponse(
  content: ResponseContentBlock[],
  candidateCount: number,
): SpecialDeliveryInsertChoice {
  const toolBlock = content.find((b) => b.type === "tool_use");
  if (!toolBlock) return { kind: "none" };
  const raw = toolBlock.input as RawInsertResponse;

  const caption =
    typeof raw.caption === "string" && raw.caption.trim()
      ? clip(raw.caption, MAX_INSERT_CAPTION_LENGTH)
      : null;

  if (raw.choice === "portfolio") {
    const index = raw.portfolioCandidateIndex;
    if (
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < candidateCount &&
      caption
    ) {
      return { kind: "portfolio", candidateIndex: index, caption };
    }
    return { kind: "none" };
  }

  if (raw.choice === "sketch") {
    const brief =
      typeof raw.sketchBrief === "string" && raw.sketchBrief.trim()
        ? clip(raw.sketchBrief, MAX_SKETCH_BRIEF_LENGTH)
        : null;
    if (brief && caption) {
      return { kind: "sketch", caption, brief };
    }
    return { kind: "none" };
  }

  return { kind: "none" };
}

// ─── Image-model prompt (the sketch's actual pixels) ───────────────────

/**
 * Bump when the fixed style preamble below changes materially — kept
 * separate from SPECIAL_DELIVERY_INSERT_VERSION (the choice/schema version)
 * so a pure art-direction tweak doesn't imply the choice semantics changed.
 */
export const SPECIAL_DELIVERY_SKETCH_STYLE_VERSION = "sketch-style-v4";

/**
 * The fixed style preamble sent to the canonical image model for every
 * charm illustration, regardless of subject. This is the ONLY place its art
 * direction is defined — never let a per-call prompt improvise style, or
 * two sketches could look like they came from different products.
 *
 * Deliberately NOT a data visualization: no numbers, no rubric-shaped marks,
 * no typography of any kind. A charm illustration, not a chart.
 *
 * v2: earlier wording ("a doodle in a notebook margin") let the model draw
 * an entire notebook/sketchbook object — page edges, binding, a photographed
 * paper texture or vignette — instead of a subject floating on a plain
 * canvas. This version is deliberately blunt about forbidding the
 * paper/book/margin as a depicted object, not just the color of a wash.
 *
 * v3: an independent design critique of a real seeded batch found sketches
 * varying wildly in scale and ink weight — some subjects floated tiny and
 * faint in a mostly-empty square, thin enough to risk dropping out on a
 * home printer, while others confidently filled the frame. Added explicit
 * "fill the frame, draw with confident dark strokes" guidance so every
 * sketch reads consistently at print size, not just on screen.
 *
 * v4: moved from soft graphite/pencil doodles to original black-ink editorial
 * spot illustrations with technical-drawing precision: crisp contours,
 * controlled line weight, and selective crosshatching or stippling. Explicitly
 * excludes pencil texture, construction lines, soft gray shading, and
 * publication-specific imitation.
 */
export const SPECIAL_DELIVERY_SKETCH_STYLE = [
  "A single small original black-ink editorial spot illustration with the precision and clarity of a technical line drawing.",
  "One clear, kid-delighting subject in an uncluttered composition, drawn directly on a plain blank canvas.",
  "Use crisp, clean contours, controlled varied line weight, and selective crosshatching or stippling only where it clarifies form. Keep edges sharp and details intentional.",
  "Draw the subject boldly and confidently, filling most of the frame edge to edge — not a small faint drawing floating in a large empty margin. Use deep black marks and strong contrast against the white so it stays legible at small print size.",
  "The background is solid, seamless, pure white — completely flat white with absolutely no visible paper texture, grain, fibers, shadow, vignette, or edge.",
  "Never depict a notebook, sketchbook, page, margin, binding, torn edge, or paper surface as the BACKGROUND or container for the drawing. If one of those objects is itself the requested subject, draw it only as a clearly bounded object floating on the pure-white canvas. This is a scanned line drawing on white, never a photo of paper.",
  "No cream, beige, tan, or pale-yellow wash of any kind, anywhere in the image, including at the edges or corners.",
  "Black ink on white only — no color, colored fills, gradients, soft gray washes, or continuous-tone shading.",
  "No graphite, pencil, charcoal, chalk, brushy wash, smudging, sketchy construction lines, or paper-grain effects.",
  "No text, letters, numbers, words, or watermarks anywhere in the image.",
  "No photorealism, cartoon clip art, or imitation of any named artist or publication. The result should feel like an original, precise, hand-inked illustration.",
].join(" ");


/** Builds the exact prompt sent to the canonical image model for a charm
 * sketch: the fixed style preamble plus the model's own grounded subject
 * brief (already length-bounded and re-clipped here defensively). Frozen
 * verbatim into the letter's `insert.prompt` for traceability. */
export function buildSketchImagePrompt(brief: string): string {
  return `${SPECIAL_DELIVERY_SKETCH_STYLE}\n\nSubject: ${clip(brief, MAX_SKETCH_BRIEF_LENGTH)}`;
}

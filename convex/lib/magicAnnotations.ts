/**
 * Magic Annotations — pure logic (no Convex/runtime imports, unit-testable).
 *
 * "Magic Annotations" is the umbrella feature: hand-drawn markers on a child's
 * paper that Rabbithole recognizes and acts on. The first (and so far only)
 * kind is **Magic Corners** — four L-shaped corner crop-mark brackets framing a
 * region that contains a sketch and/or a short text description. When detected,
 * we ask the Gemini image model to redraw whatever's inside the frame as a
 * polished illustration.
 *
 * This file owns the detection prompt, the JSON parser for the vision model's
 * reply, and the Gemini edit-instruction builder. The actions that actually
 * call the models live in `convex/magicAnnotations.ts` ("use node").
 */

export type MagicAnnotationKind = "corners";

/** One detected Magic Corners frame: what to draw, and how sure we are. */
export type MagicRegion = {
  /** What to draw inside this frame. */
  instruction: string;
  /** 0–1 model confidence that this is a deliberate marker. */
  confidence: number;
};

export type MagicDetection = {
  present: boolean;
  kind: MagicAnnotationKind | null;
  /**
   * Every Magic Corners frame found on the page (empty when none). A single
   * page often has SEVERAL frames — that's why this is a list, not one region:
   * an earlier single-region shape silently dropped all but one frame.
   */
  regions: MagicRegion[];
};

/**
 * Below this confidence we treat detection as a miss and don't spend a Gemini
 * edit. Tunable; corner brackets are distinctive, so a middling bar is fine.
 */
export const MAGIC_CONFIDENCE_THRESHOLD = 0.6;

/** Vision prompt for the cheap detection pass (Haiku). JSON-only reply. */
export const DETECT_PROMPT = `You are checking a photo or scan of a child's paper for "Magic Corners" markers:
four hand-drawn L-shaped corner brackets that together frame a rectangular region
(like crop marks at the four corners of a box). Inside a framed region the child
may have drawn a rough sketch, written a short description of something they want to
see, or both.

A SINGLE page often has MORE THAN ONE such frame — for example one box near the top
and another lower down, each with its own sketch or note. You MUST find EVERY frame
on the page, not just the first or most obvious one, and return one entry per frame.

Return JSON ONLY (no prose, no code fences):
{
  "regions": [
    {
      "instruction": <one vivid sentence describing what to draw inside THIS frame, combining whatever the child sketched and/or wrote in it>,
      "confidence": <0.0-1.0 — how sure you are THIS is a deliberate Magic Corners marker (not just a box or a doodle)>
    }
    // ...one object per framed region you find. Return an empty array [] if there are no Magic Corners frames.
  ]
}`;

/** Strip ```json fences a model sometimes wraps JSON in. */
export function stripFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  return cleaned;
}

const MISS: MagicDetection = {
  present: false,
  kind: null,
  regions: [],
};

/**
 * Normalize one candidate region object. Returns null (caller drops it) unless
 * it carries a usable instruction; confidence is clamped to [0,1], defaulting
 * to 0 when missing/garbage (threshold filtering happens at the action layer).
 */
function coerceRegion(item: unknown): MagicRegion | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  const instruction =
    typeof r.instruction === "string" && r.instruction.trim() ? r.instruction.trim() : null;
  if (!instruction) return null;
  const confidence =
    typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0;
  return { instruction, confidence };
}

/**
 * Parse the detection model's reply into a normalized MagicDetection. Defensive:
 * any malformed/partial reply degrades to a miss (empty regions), never throws.
 * Tolerates both the current array shape (`{regions:[...]}`) and the legacy
 * single-object shape (`{present,instruction,confidence}`) by wrapping the
 * latter as a one-element list — so a model reply in the old format still works.
 */
export function parseDetection(raw: string): MagicDetection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return MISS;
  }
  if (typeof parsed !== "object" || parsed === null) return MISS;
  const p = parsed as Record<string, unknown>;

  const candidates: unknown[] = Array.isArray(p.regions) ? p.regions : [p];
  const regions = candidates
    .map(coerceRegion)
    .filter((r): r is MagicRegion => r !== null);

  if (regions.length === 0) return MISS;
  return { present: true, kind: "corners", regions };
}

/**
 * Build the whole-image edit instruction sent to Gemini alongside the original
 * image. Whole-image edit (per plan): redraw only the framed region(s), remove
 * the marks, leave the rest of the page alone. One Gemini call handles every
 * frame on the page — the instruction enumerates them so none is skipped.
 */
export function buildEditInstruction(instructions: string[]): string {
  const tail =
    `Remove the corner brackets and any frame lines so the result looks seamless. ` +
    `Leave everything outside the frame(s) unchanged.`;

  if (instructions.length === 1) {
    return (
      `This image has a hand-drawn rectangular frame marked by corner brackets ("Magic Corners"). ` +
      `Redraw ONLY the area inside the frame so it depicts the following, as a polished, ` +
      `child-friendly illustration that blends naturally with the surrounding page: ${instructions[0]}. ` +
      tail
    );
  }

  const list = instructions.map((ins, i) => `Frame ${i + 1}: ${ins}`).join("\n");
  return (
    `This image has ${instructions.length} separate hand-drawn rectangular frames, each marked by ` +
    `corner brackets ("Magic Corners"). Redraw ONLY the area inside EACH frame so it depicts the ` +
    `matching description below, as a polished, child-friendly illustration that blends naturally ` +
    `with the surrounding page. Treat each frame independently and redraw EVERY one of them — do ` +
    `not skip any frame:\n${list}\n` +
    tail
  );
}

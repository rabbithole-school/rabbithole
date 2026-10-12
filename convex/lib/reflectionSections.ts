// ─── Big-picture reflection: parsing the model's tool input ───────────────────
//
// `report_reflection` declares `sections` as an array of {heading, body}, but a
// tool_use block is model output, not a validated payload: Claude sometimes
// returns the array JSON-ENCODED as a string. The old inline parser trusted the
// declared shape (`(raw.sections ?? []).slice(0, 4).map(...)`), so a string
// `sections` threw `.map is not a function` — and that raw exception text was
// then persisted as `reflectionError` and rendered to a child.
//
// This normalizes instead of trusting: a JSON-encoded array is recovered (the
// model produced usable content, only mis-serialized), and anything genuinely
// unusable degrades to `[]` so the caller raises its own plain-language error.

export interface ReflectionSection {
  heading: string;
  body: string;
}

/** The model's `sections` value, recovered from a JSON-encoded array if needed. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Normalize `report_reflection` tool input into at most 4 trimmed, non-empty
 * sections. Never throws — an unusable payload returns `[]`.
 */
export function normalizeReflectionSections(input: unknown): ReflectionSection[] {
  const raw =
    input && typeof input === "object"
      ? (input as { sections?: unknown }).sections
      : undefined;
  return asArray(raw)
    .slice(0, 4)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return { heading: "", body: "" };
      const { heading, body } = entry as { heading?: unknown; body?: unknown };
      return {
        heading: typeof heading === "string" ? heading.trim() : "",
        body: typeof body === "string" ? body.trim() : "",
      };
    })
    .filter((s) => s.heading && s.body);
}

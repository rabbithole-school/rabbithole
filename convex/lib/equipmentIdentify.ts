/**
 * Equipment identify — pure logic for the add-by-photo flow (prompt + parser).
 * The model-calling wrapper lives in convex/equipmentActions.ts; keeping the
 * prompt and parser here makes them unit-testable without a model call
 * (same layering as lib/magicAnnotations.ts).
 */

/** The category vocabulary the curation UI already uses (schema comment). */
export const EQUIPMENT_CATEGORIES = [
  "musical",
  "scientific",
  "measurement",
  "art",
  "tools",
  "manipulatives",
  "sports",
  "books",
  "electronics",
  "furniture",
  "other",
] as const;

export type EquipmentIdentification = {
  name: string;
  category?: string;
  quantity?: string;
  description?: string;
  safetyNotes?: string;
};

export const IDENTIFY_PROMPT = `You are cataloging a school's physical inventory from a photo. Identify the equipment/item shown and reply with ONLY a JSON object (no prose, no code fences):

{
  "name": "short item name a teacher would recognize, e.g. 'Set of hand bells'",
  "category": "one of: ${EQUIPMENT_CATEGORIES.join(" | ")}",
  "quantity": "count/extent if visible, e.g. '8 bells (C–C)' or 'class set' — omit if unclear",
  "description": "one factual sentence about what it is (brand/model if legible)",
  "safetyNotes": "one short sentence ONLY if the item has a real hazard for children (blades, heat, chemicals) — omit otherwise"
}

If several distinct items are visible, name the most prominent one (or the natural collection, e.g. 'Woodworking hand tools') and mention the rest in the description. Omit any field you cannot determine from the photo. Never invent brands, counts, or hazards.`;

/**
 * Tolerant parse of the model's JSON reply (strips code fences, trims to the
 * outermost braces). Returns null when no usable identification came back.
 */
export function parseIdentification(
  text: string,
): EquipmentIdentification | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const name = str(obj.name);
  if (!name) return null;
  return {
    name,
    category: str(obj.category)?.toLowerCase(),
    quantity: str(obj.quantity),
    description: str(obj.description),
    safetyNotes: str(obj.safetyNotes),
  };
}

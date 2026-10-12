export type TutorWriteBoundaryResult =
  | { ok: true }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function checkSlideScaffold(value: unknown): TutorWriteBoundaryResult {
  const deck = asRecord(value);
  const title = String(deck?.title ?? "").trim();
  // "Untitled slides" is the system default (emptyDeck), not tutor prose.
  if (title !== "" && title !== "Untitled slides") {
    return { ok: false, error: "the deck title is writing" };
  }
  if (!deck || !Array.isArray(deck.slides)) return { ok: true };

  for (const rawSlide of deck.slides) {
    const slide = asRecord(rawSlide);
    if (!slide) continue;
    if (hasOwn(slide, "speakerNotes")) {
      return { ok: false, error: "speaker notes are writing" };
    }

    const elements = asRecord(slide.elements);
    if (!elements) continue;
    for (const rawElement of Object.values(elements)) {
      const element = asRecord(rawElement);
      if (
        element?.type === "text" &&
        String(element.text ?? "").trim() !== ""
      ) {
        return { ok: false, error: "text elements must be empty" };
      }
      if (element && String(element.alt ?? "").trim() !== "") {
        return { ok: false, error: "alt text is writing" };
      }
    }
  }

  return { ok: true };
}

export function checkSlideDeckLayoutOnly(
  deck: unknown,
): TutorWriteBoundaryResult {
  return checkSlideScaffold(deck);
}

export function checkSlideOpsLayoutOnly(
  ops: unknown,
  existingDeckTexts: string[],
): TutorWriteBoundaryResult {
  if (!Array.isArray(ops)) {
    return { ok: false, error: "slide operations must be an array" };
  }

  const existingTexts = new Set(existingDeckTexts.map((text) => text.trim()));

  for (const rawOp of ops) {
    const op = asRecord(rawOp);
    switch (op?.op) {
      case "setSpeakerNotes":
        return { ok: false, error: "speaker notes are writing" };
      case "setTitle":
        return { ok: false, error: "slide titles are writing" };
      case "patchElement":
        if (hasOwn(op, "text")) {
          return { ok: false, error: "text elements cannot be patched" };
        }
        break;
      case "addElement": {
        const element = asRecord(op.element);
        if (!element) {
          return { ok: false, error: "addElement requires an element" };
        }
        if (element.type === "text") {
          const text = String(element.text ?? "").trim();
          if (text !== "" && !existingTexts.has(text)) {
            return {
              ok: false,
              error: "new text cannot be added to the deck",
            };
          }
        } else if (
          // alt is prose too: an image may carry only an alt already in the
          // deck (moving the scholar's picture), never a new one.
          String(element.alt ?? "").trim() !== "" &&
          !existingTexts.has(String(element.alt).trim())
        ) {
          return { ok: false, error: "new alt text cannot be added" };
        } else if (
          element.type !== "image" &&
          element.type !== "video" &&
          element.type !== "rect" &&
          element.type !== "ellipse" &&
          element.type !== "line"
        ) {
          return { ok: false, error: "unknown slide element type" };
        }
        break;
      }
      case "addSlide":
        if (op.slide !== undefined) {
          const result = checkSlideScaffold({ slides: [op.slide] });
          if (!result.ok) return result;
        }
        break;
      case "removeElement":
      case "moveElement":
      case "removeSlide":
      case "setBackground":
        break;
      default:
        return { ok: false, error: "unknown slide operation" };
    }
  }

  return { ok: true };
}

/**
 * The vanilla-DOM keypad for the expression-editor widget — the third rendering
 * of the SAME pad the web `components/practice/ExpressionKeypad` and the native
 * controls draw, with identical key semantics:
 *
 *   • digits + the variable `x` build the active box
 *   • the FRACTION glyph inserts an empty ▢/▢ at the caret (no grab), so a
 *     whole number typed first stays put — the only way to build a mixed number
 *   • the EXPONENT glyph grabs the trailing operand as the base (like `^`)
 *   • the SQUARE-ROOT / indexed-ROOT glyphs insert √▢ / ⁿ√▢
 *   • ⌫ deletes a char, or unwraps an empty structure
 *
 * When the answer's structure is pre-scaffolded (`locked`), the structure
 * glyphs are hidden and only the number keys + backspace remain — the shape is
 * fixed and the scholar just fills the boxes.
 */

import { RADICAL_KEYPAD_PATH, RADICAL_KEYPAD_VIEWBOX } from "../../radicalGeometry";

const SVG_NS = "http://www.w3.org/2000/svg";

export type KeypadHandlers = {
  onDigit: (digit: string) => void;
  onInsertFraction: () => void;
  onInsertPower: () => void;
  onInsertSquareRoot: () => void;
  onInsertRoot: () => void;
  onDelete: () => void;
};

function keyButton(label: string, ariaLabel: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rh-expr-key rh-btn-secondary";
  btn.setAttribute("aria-label", ariaLabel);
  btn.textContent = label;
  // Keep focus on the field so the hardware keyboard keeps working after a tap.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return btn;
}

function glyphButton(ariaLabel: string, icon: Node, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rh-expr-key rh-btn-secondary";
  btn.setAttribute("aria-label", ariaLabel);
  btn.appendChild(icon);
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return btn;
}

function miniBox(): HTMLElement {
  const b = document.createElement("span");
  b.className = "rh-expr-mini-box";
  return b;
}

function fractionIcon(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "rh-expr-mini";
  wrap.appendChild(miniBox());
  const bar = document.createElement("span");
  bar.className = "rh-expr-mini-bar";
  wrap.appendChild(bar);
  wrap.appendChild(miniBox());
  return wrap;
}

function powerIcon(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "rh-expr-mini-power";
  wrap.appendChild(miniBox());
  wrap.appendChild(miniBox());
  return wrap;
}

function radicalIcon(indexed: boolean): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("height", "28");
  svg.setAttribute("width", "40");
  svg.setAttribute("viewBox", RADICAL_KEYPAD_VIEWBOX);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", RADICAL_KEYPAD_PATH);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", "2.4");
  svg.appendChild(path);
  if (indexed) {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", "1");
    text.setAttribute("y", "9");
    text.setAttribute("font-size", "9");
    text.setAttribute("font-weight", "600");
    text.setAttribute("fill", "currentColor");
    text.textContent = "n";
    svg.appendChild(text);
  }
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", "21");
  rect.setAttribute("y", "4");
  rect.setAttribute("width", "16");
  rect.setAttribute("height", "18");
  rect.setAttribute("rx", "3");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", "currentColor");
  rect.setAttribute("stroke-width", "1.6");
  svg.appendChild(rect);
  return svg;
}

/** Build the keypad. `locked` hides the structure glyphs (fixed L1 scaffold). */
export function buildKeypad(
  handlers: KeypadHandlers,
  options: { locked?: boolean } = {},
): HTMLElement {
  const pad = document.createElement("div");
  pad.className = "rh-expr-keypad";

  const digits = document.createElement("div");
  digits.className = "rh-expr-digits";
  for (const key of ["7", "8", "9", "4", "5", "6", "1", "2", "3", "x", "0", ""]) {
    if (key === "") {
      // ⌫ takes the trailing empty grid cell so the number pad stays 3-wide.
      digits.appendChild(
        glyphButton("Delete", deleteIcon(), handlers.onDelete),
      );
      continue;
    }
    const label = key === "x" ? "Variable x" : `Key ${key}`;
    digits.appendChild(keyButton(key, label, () => handlers.onDigit(key)));
  }
  pad.appendChild(digits);

  if (!options.locked) {
    const glyphs = document.createElement("div");
    glyphs.className = "rh-expr-glyphs";
    glyphs.appendChild(
      glyphButton("Insert a fraction", fractionIcon(), handlers.onInsertFraction),
    );
    glyphs.appendChild(
      glyphButton("Insert an exponent", powerIcon(), handlers.onInsertPower),
    );
    glyphs.appendChild(
      glyphButton("Insert a square root", radicalIcon(false), handlers.onInsertSquareRoot),
    );
    glyphs.appendChild(
      glyphButton("Insert a root with an index", radicalIcon(true), handlers.onInsertRoot),
    );
    pad.appendChild(glyphs);
  }

  return pad;
}

function deleteIcon(): Text {
  return document.createTextNode("\u232B");
}

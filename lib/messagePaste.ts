// Pasting into a plain-text message box keeps hyperlinks. A browser hands a
// textarea only the clipboard's text/plain, which for a link copied out of
// Gmail or a Google Doc is its label alone — the URL silently vanishes (a
// teacher's conference-booking link reached families as dead text). This
// rewrites such a paste into the body's `[label](url)` form
// (lib/messageLinks.ts) before it lands.

import { isHttpUrl } from "./messageLinks";

export type PastedAnchor = { label: string; href: string };

/** A label the `[label](url)` form can carry unambiguously. */
function linkableLabel(label: string): string | null {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized && !/[[\]]/.test(normalized) ? normalized : null;
}

/**
 * The text to insert instead of the browser's default paste, or null to let
 * the paste through untouched.
 *
 * - A lone URL pasted over selected text links that text (GitHub's gesture).
 * - Rich text with links: each anchor's label in the plain text becomes
 *   `[label](url)`. The plain text stays the browser's own rendering, so line
 *   breaks and spacing are exactly what a normal paste would have produced.
 */
export function linkedPasteText({
  text,
  anchors,
  selected,
}: {
  text: string;
  anchors: PastedAnchor[];
  selected: string;
}): string | null {
  const pastedUrl = text.trim();
  if (selected && isHttpUrl(pastedUrl) && !/\s/.test(pastedUrl)) {
    const label = linkableLabel(selected);
    if (label && !isHttpUrl(label)) return `[${label}](${pastedUrl})`;
  }

  let out = "";
  let cursor = 0;
  let changed = false;
  for (const anchor of anchors) {
    const href = anchor.href.trim();
    const label = linkableLabel(anchor.label);
    // A bare-URL anchor already pastes as its URL; a pasted text that already
    // spells the URL out needs nothing added.
    if (!label || !isHttpUrl(href) || label === href || text.includes(href)) {
      continue;
    }
    const at = text.indexOf(label, cursor);
    if (at < 0) continue;
    out += `${text.slice(cursor, at)}[${label}](${href})`;
    cursor = at + label.length;
    changed = true;
  }
  return changed ? out + text.slice(cursor) : null;
}

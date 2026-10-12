import type { ClipboardEvent } from "react";
import { linkedPasteText, type PastedAnchor } from "@/lib/messagePaste";

function anchorsIn(html: string): PastedAnchor[] {
  // DOMParser builds an inert document: no scripts run, nothing loads.
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("a[href]"), (a) => ({
    label: a.textContent ?? "",
    href: a.getAttribute("href") ?? "",
  }));
}

/**
 * `onPaste` for a message textarea: keeps hyperlinks from rich text, and links
 * selected text when a URL is pasted over it (see lib/messagePaste.ts). Any
 * other paste is left to the browser.
 */
export function pasteKeepingLinks(
  event: ClipboardEvent<HTMLTextAreaElement>,
  setValue: (value: string) => void,
) {
  const el = event.currentTarget;
  const html = event.clipboardData.getData("text/html");
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const replacement = linkedPasteText({
    text: event.clipboardData.getData("text/plain"),
    anchors: html ? anchorsIn(html) : [],
    selected: el.value.slice(start, end),
  });
  if (replacement === null) return;
  event.preventDefault();
  // insertText keeps the paste on the native undo stack and fires the input
  // event a controlled textarea listens for.
  if (document.execCommand("insertText", false, replacement)) return;
  setValue(el.value.slice(0, start) + replacement + el.value.slice(end));
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = start + replacement.length;
  });
}

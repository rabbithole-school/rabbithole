// Slack canvas → markdown.
//
// A Slack canvas is a "quip" document; downloading its `url_private` (files.info
// → GET with the bot token) returns the body as quip HTML, not markdown. This
// converts that HTML back to the markdown the bot writes with, so the marketing
// bot can READ a canvas (see the inline edits staff made) — the counterpart to
// the write-only canvases.create / canvases.edit path.
//
// It is intentionally dependency-free (no DOM, no htmlparser) so it runs
// anywhere a Convex function does, and it aims for "faithful enough for the
// model to read and re-edit", not a byte-perfect round-trip. Supported quip
// structure: h1–h6, paragraphs (`<p class="line">`, empty = blank line),
// blockquotes, ordered/unordered lists (one level of nesting), horizontal
// rules, `<br>`, and inline bold / italic / code / links, plus HTML entities.

/** Decode the handful of HTML entities Slack emits. `&amp;` MUST be last. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Convert one block's inner HTML (inline formatting only) to markdown text. */
function inlineToMd(html: string): string {
  let s = html;
  // Links first, so a link nested inside bold/italic survives as markdown text.
  s = s.replace(
    /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const label = stripTags(text).trim();
      return `[${label}](${href.trim()})`;
    },
  );
  s = s.replace(
    /<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi,
    (_m, t: string) => {
      const inner = stripTags(t).trim();
      return inner ? `**${inner}**` : "";
    },
  );
  s = s.replace(
    /<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi,
    (_m, t: string) => {
      const inner = stripTags(t).trim();
      return inner ? `*${inner}*` : "";
    },
  );
  s = s.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_m, t: string) => `\`${stripTags(t).trim()}\``,
  );
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  // Collapse runs of spaces/tabs but preserve intentional newlines (<br>).
  return s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/** Isolate the canvas body from a full HTML page (or return the input). */
function isolateBody(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  const quip = s.match(
    /<div[^>]*class="[^"]*quip[^"]*"[^>]*>([\s\S]*)<\/div>/i,
  );
  if (quip) return quip[1];
  const body = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (body) return body[1];
  return s;
}

/**
 * Index of the `</tag>` that closes the `<tag>` whose content begins at `from`,
 * accounting for nested same-name tags. -1 if unbalanced.
 */
function findClose(html: string, tag: string, from: number): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] === "/") {
      depth -= 1;
      if (depth === 0) return m.index;
    } else {
      depth += 1;
    }
  }
  return -1;
}

function convertList(inner: string, type: "ul" | "ol"): string {
  const items: string[] = [];
  const liRe = /<li\b[^>]*?>/gi;
  let n = 1;
  while (liRe.exec(inner)) {
    const openEnd = liRe.lastIndex;
    const closeIdx = findClose(inner, "li", openEnd);
    if (closeIdx === -1) break;
    const liInner = inner.slice(openEnd, closeIdx);
    liRe.lastIndex = closeIdx + "</li>".length;

    // A list item may hold a nested list after its own text.
    const nested = liInner.match(/<(ul|ol)\b/i);
    const leafHtml =
      nested && nested.index !== undefined
        ? liInner.slice(0, nested.index)
        : liInner;
    const nestedHtml =
      nested && nested.index !== undefined ? liInner.slice(nested.index) : "";

    const bullet = type === "ul" ? "-" : `${n}.`;
    const text = inlineToMd(leafHtml);
    let line = text ? `${bullet} ${text}` : `${bullet}`;
    if (nestedHtml) {
      const nestedMd = convertBlocks(nestedHtml)
        .join("\n")
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      if (nestedMd.trim()) line += `\n${nestedMd}`;
    }
    items.push(line);
    n += 1;
  }
  return items.join("\n");
}

function convertBlocks(html: string): string[] {
  const blocks: string[] = [];
  const openRe = /<(h[1-6]|p|blockquote|ul|ol|li|hr)\b[^>]*?>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const openEnd = openRe.lastIndex;

    if (tag === "hr") {
      blocks.push("---");
      continue;
    }

    const closeIdx = findClose(html, tag, openEnd);
    if (closeIdx === -1) continue;
    const inner = html.slice(openEnd, closeIdx);
    openRe.lastIndex = closeIdx + `</${tag}>`.length;

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const text = inlineToMd(inner);
      if (text) blocks.push(`${"#".repeat(level)} ${text}`);
    } else if (tag === "p") {
      const text = inlineToMd(inner);
      if (text) blocks.push(text);
    } else if (tag === "blockquote") {
      const innerMd = convertBlocks(inner).join("\n\n") || inlineToMd(inner);
      const quoted = innerMd
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
      if (quoted.replace(/[>\s]/g, "")) blocks.push(quoted);
    } else if (tag === "ul" || tag === "ol") {
      const list = convertList(inner, tag);
      if (list) blocks.push(list);
    } else if (tag === "li") {
      // A stray <li> outside a list — treat as a bullet.
      const text = inlineToMd(inner);
      if (text) blocks.push(`- ${text}`);
    }
  }
  return blocks.filter((b) => b.length > 0);
}

/** Convert Slack-canvas (quip) HTML to markdown. Never throws. */
export function quipHtmlToMarkdown(html: string): string {
  if (!html) return "";
  const body = isolateBody(html);
  const blocks = convertBlocks(body);
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

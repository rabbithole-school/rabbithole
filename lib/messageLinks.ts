export type MessageLinkToken =
  | { type: "text"; value: string }
  | { type: "url"; value: string };

function occurrences(value: string, character: string): number {
  return value.split(character).length - 1;
}

/**
 * Removes punctuation that belongs to prose, while retaining balanced brackets
 * that are genuinely part of a URL.
 */
function splitTrailingPunctuation(value: string): {
  url: string;
  trailing: string;
} {
  let url = value;
  let trailing = "";
  while (url.length > 0) {
    const last = url[url.length - 1];
    const sentencePunctuation = ".,;:!?\"'".includes(last);
    const unbalancedCloser =
      (last === ")" && occurrences(url, ")") > occurrences(url, "(")) ||
      (last === "]" && occurrences(url, "]") > occurrences(url, "[")) ||
      (last === "}" && occurrences(url, "}") > occurrences(url, "{"));
    if (!sentencePunctuation && !unbalancedCloser) break;
    trailing = last + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function isHttpUrl(value: string): boolean {
  // `new URL("https:///path")` treats `path` as a host, so require an explicit
  // authority character after the two literal slashes before parsing.
  if (!/^https?:\/\/[^/?#]/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/** Tokenize bare absolute web URLs without changing any surrounding text. */
export function tokenizeMessageLinks(value: string): MessageLinkToken[] {
  const tokens: MessageLinkToken[] = [];
  const pattern = /\bhttps?:\/\/[^\s<]+/g;
  let cursor = 0;
  const addText = (text: string) => {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.type === "text") {
      previous.value += text;
    } else {
      tokens.push({ type: "text", value: text });
    }
  };

  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined) continue;
    const { url, trailing } = splitTrailingPunctuation(match[0]);
    if (start > cursor) {
      addText(value.slice(cursor, start));
    }
    if (url && isHttpUrl(url)) {
      tokens.push({ type: "url", value: url });
      addText(trailing);
    } else {
      addText(match[0]);
    }
    cursor = start + match[0].length;
  }

  if (cursor < value.length) {
    addText(value.slice(cursor));
  }
  return tokens.length > 0 ? tokens : [{ type: "text", value }];
}

/**
 * The one URL that may earn a compact preview in a message bubble. Keeping this
 * decision alongside tokenization makes portal, email, and phone rendering agree
 * on the exact visible URL while ensuring a message never grows multiple cards.
 */
export function previewableMessageLink(value: string): string | null {
  const tokens = tokenizeMessageLinks(value);

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "url") continue;

    const before = tokens
      .slice(0, index)
      .map((part) => part.value)
      .join("");
    const after = tokens
      .slice(index + 1)
      .map((part) => part.value)
      .join("");

    // A card belongs to a URL that starts the message, or closes it apart from
    // sentence punctuation. The regular link remains the fallback everywhere.
    if (
      before.trim().length === 0 ||
      after.replace(/[\s.,;:!?"'”’)\]}]+/g, "").length === 0
    ) {
      return token.value;
    }
  }

  return null;
}

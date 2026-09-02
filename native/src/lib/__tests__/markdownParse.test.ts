import { describe, it, expect } from "vitest";
import { parseBlocks, parseInline, type Span } from "../markdownParse";

// ── parseBlocks ───────────────────────────────────────────────────────────────

describe("parseBlocks — plain paragraph", () => {
  it("wraps bare text in a paragraph block", () => {
    const blocks = parseBlocks("Hello world");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("p");
    if (blocks[0].kind === "p") expect(blocks[0].text).toBe("Hello world");
  });

  it("joins continuation lines of the same paragraph with a space", () => {
    const blocks = parseBlocks("line one\nline two");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "p") expect(blocks[0].text).toBe("line one line two");
  });

  it("splits paragraphs on blank lines", () => {
    const blocks = parseBlocks("para one\n\npara two");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("p");
    expect(blocks[1].kind).toBe("p");
  });

  it("returns empty array for empty string", () => {
    expect(parseBlocks("")).toHaveLength(0);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseBlocks("   \n  \n")).toHaveLength(0);
  });

  it("handles CRLF line endings", () => {
    const blocks = parseBlocks("hello\r\nworld");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "p") expect(blocks[0].text).toBe("hello world");
  });
});

describe("parseBlocks — headings", () => {
  it("parses h1 (#)", () => {
    const blocks = parseBlocks("# Title");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("h");
    if (blocks[0].kind === "h") {
      expect(blocks[0].level).toBe(1);
      expect(blocks[0].text).toBe("Title");
    }
  });

  it("parses h2 (##)", () => {
    const blocks = parseBlocks("## Section");
    if (blocks[0].kind === "h") expect(blocks[0].level).toBe(2);
  });

  it("parses h3 (###)", () => {
    const blocks = parseBlocks("### Subsection");
    if (blocks[0].kind === "h") expect(blocks[0].level).toBe(3);
  });

  it("heading followed by paragraph produces two blocks", () => {
    const blocks = parseBlocks("## Where we are\nYou've nailed the setup.");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("h");
    expect(blocks[1].kind).toBe("p");
  });
});

describe("parseBlocks — bullet lists", () => {
  it("parses hyphen bullets", () => {
    const blocks = parseBlocks("- alpha\n- beta\n- gamma");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "ul") {
      // items is now ListItem[] — compare text property
      expect(blocks[0].items.map((it) => it.text)).toEqual(["alpha", "beta", "gamma"]);
    }
  });

  it("parses star bullets", () => {
    const blocks = parseBlocks("* one\n* two");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "ul") expect(blocks[0].items).toHaveLength(2);
  });

  it("paragraph before list and list are separate blocks", () => {
    const blocks = parseBlocks("Intro:\n- item");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("p");
    expect(blocks[1].kind).toBe("ul");
  });
});

describe("parseBlocks — numbered lists", () => {
  it("parses ordered items", () => {
    const blocks = parseBlocks("1. First\n2. Second\n3. Third");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "ol") {
      expect(blocks[0].items).toHaveLength(3);
      // items is now ListItem[] — compare text property
      expect(blocks[0].items[0].text).toBe("First");
    }
  });
});

describe("parseBlocks — fenced code block", () => {
  it("captures everything between triple backticks", () => {
    const md = "```\nfor x in range(3):\n    print(x)\n```";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("code");
    if (blocks[0].kind === "code") {
      expect(blocks[0].text).toContain("for x");
      expect(blocks[0].text).toContain("print(x)");
    }
  });

  it("text before and after a code block become separate blocks", () => {
    const md = "Try this:\n```\ncode here\n```\nWhat prints?";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe("p");
    expect(blocks[1].kind).toBe("code");
    expect(blocks[2].kind).toBe("p");
  });

  it("extracts a language label from the opening fence", () => {
    const md = "```python\nprint('hello')\n```";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "code") {
      expect(blocks[0].lang).toBe("python");
      expect(blocks[0].text).toBe("print('hello')");
    }
  });

  it("code block without lang has no lang field", () => {
    const md = "```\nfoo()\n```";
    const blocks = parseBlocks(md);
    if (blocks[0].kind === "code") {
      expect(blocks[0].lang).toBeUndefined();
    }
  });

  it("extracts common language labels (js, ts, bash)", () => {
    for (const lang of ["js", "typescript", "bash"]) {
      const blocks = parseBlocks(`\`\`\`${lang}\ncode\n\`\`\``);
      if (blocks[0].kind === "code") expect(blocks[0].lang).toBe(lang);
    }
  });
});

describe("parseBlocks — blockquote", () => {
  it("captures the quoted text", () => {
    const blocks = parseBlocks("> The cave you fear holds the treasure.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("quote");
    if (blocks[0].kind === "quote")
      expect(blocks[0].text).toBe("The cave you fear holds the treasure.");
  });

  it("blockquote followed by paragraph produces two blocks", () => {
    const blocks = parseBlocks("> wise words\nWhat does that mean?");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("quote");
    expect(blocks[1].kind).toBe("p");
  });
});

// ── nested lists ──────────────────────────────────────────────────────────────

describe("parseBlocks — nested lists", () => {
  it("flat list items expose a .text property", () => {
    const blocks = parseBlocks("- alpha\n- beta");
    if (blocks[0].kind === "ul") {
      expect(blocks[0].items[0].text).toBe("alpha");
      expect(blocks[0].items[1].text).toBe("beta");
      expect(blocks[0].items[0].children).toBeUndefined();
    }
  });

  it("indented sub-bullet becomes a child of its parent item", () => {
    const md = "- parent\n  - child";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "ul") {
      expect(blocks[0].items).toHaveLength(1);
      expect(blocks[0].items[0].text).toBe("parent");
      expect(blocks[0].items[0].children).toBeDefined();
      expect(blocks[0].items[0].children?.kind).toBe("ul");
      expect(blocks[0].items[0].children?.items[0].text).toBe("child");
    }
  });

  it("multiple top-level items, one with children, one without", () => {
    const md = "- alpha\n- beta\n  - sub1\n  - sub2\n- gamma";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "ul") {
      expect(blocks[0].items).toHaveLength(3);
      expect(blocks[0].items[0].children).toBeUndefined();
      expect(blocks[0].items[1].children?.items).toHaveLength(2);
      expect(blocks[0].items[1].children?.items[0].text).toBe("sub1");
      expect(blocks[0].items[2].children).toBeUndefined();
    }
  });

  it("ordered list with unordered children", () => {
    const md = "1. Step one\n   - detail a\n   - detail b\n2. Step two";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "ol") {
      expect(blocks[0].items[0].text).toBe("Step one");
      expect(blocks[0].items[0].children?.kind).toBe("ul");
      expect(blocks[0].items[0].children?.items).toHaveLength(2);
      expect(blocks[0].items[1].text).toBe("Step two");
      expect(blocks[0].items[1].children).toBeUndefined();
    }
  });

  it("nested ordered list under an ordered item", () => {
    const md = "1. First\n   1. Sub-first\n   2. Sub-second\n2. Second";
    const blocks = parseBlocks(md);
    if (blocks[0].kind === "ol") {
      expect(blocks[0].items[0].children?.kind).toBe("ol");
      expect(blocks[0].items[0].children?.items).toHaveLength(2);
    }
  });
});

// ── tables ────────────────────────────────────────────────────────────────────

describe("parseBlocks — tables", () => {
  it("parses a simple pipe table into headers and data rows", () => {
    const md = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("table");
    if (blocks[0].kind === "table") {
      expect(blocks[0].headers).toEqual(["Name", "Age"]);
      expect(blocks[0].rows).toHaveLength(2);
      expect(blocks[0].rows[0]).toEqual(["Alice", "30"]);
      expect(blocks[0].rows[1]).toEqual(["Bob", "25"]);
    }
  });

  it("parses alignment markers: left, center, right", () => {
    const md = "| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "table") {
      expect(blocks[0].aligns).toEqual(["left", "center", "right"]);
    }
  });

  it("defaults alignment to left when no colons", () => {
    const md = "| A | B |\n| --- | --- |\n| x | y |";
    const blocks = parseBlocks(md);
    if (blocks[0].kind === "table") {
      expect(blocks[0].aligns).toEqual(["left", "left"]);
    }
  });

  it("table preceded by paragraph is two separate blocks", () => {
    const md = "Here is a table:\n\n| Col |\n| --- |\n| val |";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("p");
    expect(blocks[1].kind).toBe("table");
  });

  it("parses tables without leading/trailing pipes", () => {
    const md = "Name | Score\n--- | ---\nAlice | 95\nBob | 87";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === "table") {
      expect(blocks[0].headers).toEqual(["Name", "Score"]);
      expect(blocks[0].rows).toHaveLength(2);
      expect(blocks[0].rows[0]).toEqual(["Alice", "95"]);
    }
  });

  it("a table followed by a paragraph is two blocks", () => {
    const md = "| X |\n| --- |\n| 1 |\n\nSummary here.";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("table");
    expect(blocks[1].kind).toBe("p");
  });

  it("a regular paragraph containing | is NOT mistaken for a table", () => {
    // Only triggers if the next line is a separator
    const md = "Use a | b syntax here.";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("p");
  });
});

// ── parseInline ───────────────────────────────────────────────────────────────

const BASE = { bold: false, italic: false, code: false };

function textSpans(md: string): Span[] {
  return parseInline(md, BASE);
}

function spanText(spans: Span[]): string {
  return spans
    .map((s) => (s.type === "link" ? `[${s.text}→${s.href}]` : s.text))
    .join("");
}

describe("parseInline — plain text", () => {
  it("returns a single text span for plain prose", () => {
    const spans = textSpans("Hello, world!");
    expect(spans).toHaveLength(1);
    expect(spans[0].type).toBe("text");
    expect(spans[0].text).toBe("Hello, world!");
  });

  it("returns empty array for empty string", () => {
    expect(textSpans("")).toHaveLength(0);
  });

  it("preserves the base style on plain spans", () => {
    const spans = parseInline("text", { bold: true, italic: false, code: false });
    expect(spans[0].style.bold).toBe(true);
  });
});

describe("parseInline — bold", () => {
  it("parses **bold**", () => {
    const spans = textSpans("your **thesis** is clear");
    const bold = spans.find((s) => s.style.bold);
    expect(bold).toBeDefined();
    expect(bold?.text).toBe("thesis");
  });

  it("parses __bold__", () => {
    const spans = textSpans("__hello__");
    expect(spans[0].style.bold).toBe(true);
  });

  it("raw text around bold is not bold", () => {
    const spans = textSpans("before **middle** after");
    const plain = spans.filter((s) => !s.style.bold);
    expect(spanText(plain)).toContain("before");
    expect(spanText(plain)).toContain("after");
  });
});

describe("parseInline — italic", () => {
  it("parses *italic*", () => {
    const spans = textSpans("the _evidence_ is thin");
    const ital = spans.find((s) => s.style.italic);
    expect(ital).toBeDefined();
    expect(ital?.text).toBe("evidence");
  });

  it("does NOT parse arithmetic asterisks as italic", () => {
    // "3 * 4 = 12" — opener followed by space, so not left-flanking
    const spans = textSpans("If 3 * 4 = 12, then what is 3 * 5?");
    expect(spans.every((s) => !s.style.italic)).toBe(true);
  });

  it("stage direction *[text]* gets muted=true", () => {
    const spans = textSpans("*[leans in, thinking]* Hmm");
    const muted = spans.find((s) => s.style.muted);
    expect(muted).toBeDefined();
    // The muted span text is the inner bracket content
    expect(muted?.text).toBe("[leans in, thinking]");
  });
});

describe("parseInline — inline code", () => {
  it("parses `backtick` code", () => {
    const spans = textSpans("Use `array.map()` here");
    const code = spans.find((s) => s.style.code);
    expect(code).toBeDefined();
    expect(code?.text).toBe("array.map()");
  });

  it("does not parse lone backtick as code", () => {
    const spans = textSpans("one ` backtick only");
    expect(spans.every((s) => !s.style.code)).toBe(true);
  });
});

describe("parseInline — links", () => {
  it("parses [label](url) as a link span", () => {
    const spans = textSpans("read the [docs](https://mdn.io/map)");
    const link = spans.find((s) => s.type === "link");
    expect(link).toBeDefined();
    if (link?.type === "link") {
      expect(link.text).toBe("docs");
      expect(link.href).toBe("https://mdn.io/map");
    }
  });

  it("text before and after link is plain", () => {
    const spans = textSpans("see [MDN](https://mdn.io) for details");
    expect(spans).toHaveLength(3);
    expect(spans[0].type).toBe("text");
    expect(spans[2].type).toBe("text");
  });
});

describe("parseInline — nesting", () => {
  it("bold + italic nested: **_text_** → bold+italic span", () => {
    // Bold wraps italic inner content
    const spans = textSpans("**_deeply_**");
    const nested = spans.find((s) => s.style.bold && s.style.italic);
    expect(nested).toBeDefined();
  });

  it("mixed inline in a paragraph", () => {
    const spans = textSpans("Great **thesis** and `code`");
    expect(spans.some((s) => s.style.bold)).toBe(true);
    expect(spans.some((s) => s.style.code)).toBe(true);
  });

  it("total text content is preserved across all spans", () => {
    const input = "Bold **word** and italic _phrase_ here";
    const spans = textSpans(input);
    // The concatenation of all span texts should recover the raw words
    const recovered = spans.map((s) => s.text).join("");
    expect(recovered).toContain("Bold");
    expect(recovered).toContain("word");
    expect(recovered).toContain("phrase");
    expect(recovered).toContain("here");
  });

  it("***text*** produces a bold+italic span", () => {
    const spans = textSpans("***combined***");
    const bi = spans.find((s) => s.style.bold && s.style.italic);
    expect(bi).toBeDefined();
    expect(bi?.text).toBe("combined");
  });

  it("**_text_** produces bold+italic via nesting", () => {
    const spans = textSpans("**_emphasis_**");
    const bi = spans.find((s) => s.style.bold && s.style.italic);
    expect(bi).toBeDefined();
    expect(bi?.text).toBe("emphasis");
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The practice machine's shared modules are vendored byte-identically into
// the native bundle (native/vendor/shared/*), where metro resolves them with
// no web toolchain, no DOM, and no path aliases. So the whole set must stay
// framework-free and may only import its own enumerated siblings — a single
// `react`, `convex/...`, `@/...` or `node:` import anywhere in this graph
// breaks the iPad build, and it breaks it at bundle time on a device rather
// than in CI.
//
// This is the design rule from the practice-machine plan made executable, so
// a later edit can't quietly widen the graph. It complements
// vendorLockstep.test.ts, which proves the vendored COPIES match; this proves
// the SOURCES are copyable in the first place.
// ─────────────────────────────────────────────────────────────────────────

const sharedDir = dirname(fileURLToPath(import.meta.url));

/** Every module in the practice-machine shared graph, with the siblings it is
 *  allowed to import. An empty list means the file must import nothing at
 *  all. Adding an entry here is a deliberate, reviewable act. */
const ALLOWED_IMPORTS: Record<string, string[]> = {
  "practicePersistenceCore.ts": [],
  "practiceOutboxRetry.ts": [],
  "practiceLifecycleRetry.ts": ["./practiceOutboxRetry"],
  "practiceLoop.ts": [],
  "hintLadder.ts": [],
  "practiceOutboxContract.ts": ["./practicePersistenceCore"],
  "practiceResumeContract.ts": ["./practicePersistenceCore"],
  "practiceMachine.ts": [
    "./practiceLifecycleRetry",
    "./practiceLoop",
    "./practiceOutboxContract",
  ],
};

/** Matches any static or dynamic import/re-export specifier. */
const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

/**
 * Strip comments before scanning. These modules carry long doc comments, and
 * prose like "storage exists but couldn't be read … try again" contains the
 * literal `from "` sequence, which a naive scan reads as an import. Walks the
 * source tracking string/comment context so a `//` inside a string literal
 * doesn't swallow the rest of the line either.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let context: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (context === "code") {
      if (c === "/" && next === "/") {
        context = "line";
        i += 2;
      } else if (c === "/" && next === "*") {
        context = "block";
        i += 2;
      } else {
        if (c === "'" || c === '"' || c === "`") context = c;
        out += c;
        i += 1;
      }
    } else if (context === "line") {
      if (c === "\n") {
        context = "code";
        out += c;
      }
      i += 1;
    } else if (context === "block") {
      if (c === "*" && next === "/") {
        context = "code";
        i += 2;
      } else {
        i += 1;
      }
    } else {
      // Inside a string literal: copy through, honoring escapes.
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
      } else {
        if (c === context) context = "code";
        out += c;
        i += 1;
      }
    }
  }
  return out;
}

function specifiersIn(file: string): string[] {
  const src = stripComments(readFileSync(resolve(sharedDir, file), "utf8"));
  return [...src.matchAll(SPECIFIER)].map((m) => m[1]!);
}

describe("practice machine shared modules stay vendorable", () => {
  it("covers every module in the graph", () => {
    // Guards against the suite passing vacuously if the table is emptied.
    expect(Object.keys(ALLOWED_IMPORTS).length).toBeGreaterThanOrEqual(7);
  });

  for (const [file, allowed] of Object.entries(ALLOWED_IMPORTS)) {
    it(`${file} imports only its enumerated siblings`, () => {
      expect(specifiersIn(file).sort()).toEqual([...allowed].sort());
    });

    it(`${file} pulls in no framework, Convex, alias or node builtin`, () => {
      for (const spec of specifiersIn(file)) {
        // A relative sibling is the ONLY shape the vendored copy can resolve:
        // it lands next to its dependency in native/vendor/shared/, so a
        // nested path like "./practice/core" would dangle there.
        expect(spec.startsWith("./")).toBe(true);
        expect(spec.slice(2)).not.toContain("/");
        expect(spec).not.toMatch(/^node:|^@\/|^react|^convex/);
      }
    });
  }
});

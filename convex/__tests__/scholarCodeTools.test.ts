// Pure + fetch-stubbed unit tests for the Workshop Code Explorer tools
// (lib/scholarCodeTools). No network: the fetch helpers take an injectable
// `fetchImpl`, and the one tool-run test stubs the global fetch. Covers the
// read-hygiene rules the spec calls out — path validation (traversal /
// absolute / scheme / backslash rejected, good paths pass), the extension
// gate, the truncation marker, and 403/429 → a friendly message.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CODE_EXPLORER_MAX_ITERATIONS,
  CODE_EXPLORER_REPO,
  CODE_EXPLORER_REF,
  CODE_EXPLORER_PROTECTED_TERM_MESSAGE,
  guardCodeToolArguments,
  inputMentionsProtectedTerm,
  protectedTermsFromNames,
  MAX_FILE_CHARS,
  MAX_LIST_ENTRIES,
  CODE_EXPLORER_RATE_LIMIT_MESSAGE,
  CODE_EXPLORER_UNAVAILABLE_MESSAGE,
  codeSearchCredentialsPresent,
  formatCodeSearchHits,
  validateRepoPath,
  fileExtension,
  hasAllowedExtension,
  truncateForModel,
  friendlyFetchError,
  rawUrlForPath,
  treeUrl,
  normalizeListPrefix,
  filterTreePaths,
  fetchRabbitholeFile,
  listRabbitholeFiles,
  makeScholarCodeTools,
} from "../lib/scholarCodeTools";

/** A fetch stub that resolves to a fixed Response. */
function stubFetch(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CODE_EXPLORER_MAX_ITERATIONS — the cost cap", () => {
  test("stays small (≤4 tool rounds + a synthesis turn)", () => {
    expect(CODE_EXPLORER_MAX_ITERATIONS).toBeLessThanOrEqual(5);
  });
});

describe("validateRepoPath — read hygiene", () => {
  test("accepts ordinary repo-relative source paths", () => {
    for (const p of [
      "convex/schema.ts",
      "components/StarMap.tsx",
      "convex/metaPrompts.ts",
      "package.json",
      "README.md",
      "styles/app.css",
    ]) {
      expect(validateRepoPath(p)).toEqual({ ok: true, path: p });
    }
  });

  test("normalizes leading ./ and redundant . segments", () => {
    expect(validateRepoPath("./convex/schema.ts")).toEqual({
      ok: true,
      path: "convex/schema.ts",
    });
    expect(validateRepoPath("convex/./lib/models.ts")).toEqual({
      ok: true,
      path: "convex/lib/models.ts",
    });
  });

  test("rejects path traversal", () => {
    for (const p of ["../secret.ts", "convex/../../etc/passwd.ts", "a/../../b.ts"]) {
      expect(validateRepoPath(p).ok).toBe(false);
    }
  });

  test("rejects absolute paths", () => {
    expect(validateRepoPath("/etc/passwd.ts").ok).toBe(false);
    expect(validateRepoPath("/convex/schema.ts").ok).toBe(false);
  });

  test("rejects URL schemes and protocol-relative URLs", () => {
    for (const p of [
      "https://evil.example.com/x.ts",
      "http://x/y.ts",
      "file:///etc/passwd",
      "//evil.example.com/x.ts",
      "C:\\Windows\\system32\\x.ts",
    ]) {
      expect(validateRepoPath(p).ok).toBe(false);
    }
  });

  test("rejects backslashes", () => {
    expect(validateRepoPath("convex\\schema.ts").ok).toBe(false);
  });

  test("rejects empty / whitespace / over-long", () => {
    expect(validateRepoPath("").ok).toBe(false);
    expect(validateRepoPath("   ").ok).toBe(false);
    expect(validateRepoPath("a/".repeat(300) + "x.ts").ok).toBe(false);
  });

  test("extension gate: only text-y source extensions pass", () => {
    for (const good of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.json", "a.md", "a.yml", "a.css", "a.sh", "a.html"]) {
      expect(validateRepoPath(good).ok).toBe(true);
    }
    for (const bad of ["a.py", "a.png", "a.lock", "noext", ".gitignore", "a.env"]) {
      expect(validateRepoPath(bad).ok).toBe(false);
    }
  });
});

describe("fileExtension / hasAllowedExtension", () => {
  test("fileExtension is the lowercase final-segment extension", () => {
    expect(fileExtension("a/b/Foo.TS")).toBe("ts");
    expect(fileExtension("a/b/c")).toBe("");
    expect(fileExtension(".gitignore")).toBe("");
  });

  test("hasAllowedExtension follows the allow-list", () => {
    expect(hasAllowedExtension("x.ts")).toBe(true);
    expect(hasAllowedExtension("x.py")).toBe(false);
  });
});

describe("truncateForModel", () => {
  test("short content passes through untouched", () => {
    const t = "const x = 1;\n";
    expect(truncateForModel(t)).toEqual({ text: t, truncated: false });
  });

  test("long content is cut with a clear …truncated marker", () => {
    const big = "x".repeat(MAX_FILE_CHARS + 500);
    const out = truncateForModel(big);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("…truncated");
    // The visible body is capped near the limit (marker adds a little).
    expect(out.text.length).toBeLessThan(MAX_FILE_CHARS + 200);
  });
});

describe("friendlyFetchError — 403/429 → friendly, never a dump", () => {
  test("429 → catch-its-breath", () => {
    expect(friendlyFetchError(429, null)).toBe(CODE_EXPLORER_RATE_LIMIT_MESSAGE);
  });

  test("403 with an exhausted rate budget → catch-its-breath", () => {
    expect(friendlyFetchError(403, "0")).toBe(CODE_EXPLORER_RATE_LIMIT_MESSAGE);
  });

  test("403 with budget remaining, 401, 5xx → pivot-to-file (still friendly)", () => {
    expect(friendlyFetchError(403, "17")).toBe(CODE_EXPLORER_UNAVAILABLE_MESSAGE);
    expect(friendlyFetchError(401, null)).toBe(CODE_EXPLORER_UNAVAILABLE_MESSAGE);
    expect(friendlyFetchError(500, null)).toBe(CODE_EXPLORER_UNAVAILABLE_MESSAGE);
  });
});

describe("URL builders", () => {
  test("rawUrlForPath pins the public repo + its default branch + encodes segments", () => {
    expect(rawUrlForPath("convex/schema.ts")).toBe(
      `https://raw.githubusercontent.com/${CODE_EXPLORER_REPO}/${CODE_EXPLORER_REF}/convex/schema.ts`,
    );
  });

  test("treeUrl points at the public recursive git-trees API at the default branch", () => {
    expect(treeUrl()).toBe(
      `https://api.github.com/repos/${CODE_EXPLORER_REPO}/git/trees/${CODE_EXPLORER_REF}?recursive=1`,
    );
  });
});

describe("normalizeListPrefix — folder-prefix hygiene", () => {
  test("absent / empty → '' (list everything)", () => {
    expect(normalizeListPrefix(undefined)).toBe("");
    expect(normalizeListPrefix("")).toBe("");
    expect(normalizeListPrefix("   ")).toBe("");
  });

  test("keeps a clean folder prefix, drops ./ and . segments", () => {
    expect(normalizeListPrefix("components/sky")).toBe("components/sky");
    expect(normalizeListPrefix("./convex/")).toBe("convex");
    expect(normalizeListPrefix("convex/./lib")).toBe("convex/lib");
  });

  test("rejects traversal / absolute / scheme / backslash → null", () => {
    for (const bad of ["../x", "/etc", "https://x/y", "file:foo", "a\\b"]) {
      expect(normalizeListPrefix(bad)).toBeNull();
    }
  });
});

describe("filterTreePaths — text-y blobs under a prefix, capped", () => {
  const tree = [
    { path: "components/ConceptAtlasView.tsx", type: "blob" },
    { path: "components/sky", type: "tree" },
    { path: "components/sky/skyVisuals.tsx", type: "blob" },
    { path: "components/sky/StarDrawer.tsx", type: "blob" },
    { path: "public/logo.png", type: "blob" },
    { path: "pnpm-lock.yaml", type: "blob" },
    { path: "convex/schema.ts", type: "blob" },
    { path: ".gitignore", type: "blob" },
  ];

  test("drops directories, non-source files, and dotfiles; sorts", () => {
    const { paths } = filterTreePaths(tree, "");
    // pnpm-lock.yaml is dropped: ext "yaml" is NOT in the allow-list (only "yml").
    expect(paths).toEqual([
      "components/ConceptAtlasView.tsx",
      "components/sky/StarDrawer.tsx",
      "components/sky/skyVisuals.tsx",
      "convex/schema.ts",
    ]);
  });

  test("prefix filters to a folder", () => {
    const { paths } = filterTreePaths(tree, "components/sky");
    expect(paths).toEqual([
      "components/sky/StarDrawer.tsx",
      "components/sky/skyVisuals.tsx",
    ]);
  });

  test("capped=true when over the max, with the true total", () => {
    const many = Array.from({ length: MAX_LIST_ENTRIES + 25 }, (_, i) => ({
      path: `convex/f${String(i).padStart(4, "0")}.ts`,
      type: "blob",
    }));
    const { paths, capped, total } = filterTreePaths(many, "convex/");
    expect(paths.length).toBe(MAX_LIST_ENTRIES);
    expect(capped).toBe(true);
    expect(total).toBe(MAX_LIST_ENTRIES + 25);
  });
});

describe("fetchRabbitholeFile (fetch stubbed)", () => {
  test("valid path + 200 → header + real content", async () => {
    const res = new Response("export const x = 1;\n", { status: 200 });
    const out = await fetchRabbitholeFile("convex/lib/models.ts", stubFetch(res));
    expect(out).toContain("File: convex/lib/models.ts");
    expect(out).toContain("export const x = 1;");
  });

  test("rejected path never touches the network", async () => {
    const spy = vi.fn();
    const out = await fetchRabbitholeFile("../secret.ts", spy as unknown as typeof fetch);
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain("doesn't look like a file inside Rabbithole's code");
  });

  test("404 → a friendly offer to list the folder (never to search)", async () => {
    const res = new Response("Not Found", { status: 404 });
    const out = await fetchRabbitholeFile("convex/nope.ts", stubFetch(res));
    expect(out).toContain("couldn't find a file");
    expect(out).toContain("list what's in that folder");
    // There is no code-search tool to offer — see the file header.
    expect(out).not.toContain("search");
  });

  test("403 rate-limited → catch-its-breath, not an error dump", async () => {
    const res = new Response("", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
    const out = await fetchRabbitholeFile("convex/schema.ts", stubFetch(res));
    expect(out).toBe(CODE_EXPLORER_RATE_LIMIT_MESSAGE);
  });

  test("huge file → truncated with the marker", async () => {
    const res = new Response("y".repeat(MAX_FILE_CHARS + 1000), { status: 200 });
    const out = await fetchRabbitholeFile("convex/schema.ts", stubFetch(res));
    expect(out).toContain("File: convex/schema.ts (truncated)");
    expect(out).toContain("…truncated");
  });
});

describe("listRabbitholeFiles (fetch stubbed)", () => {
  const treeBody = JSON.stringify({
    tree: [
      { path: "components/ConceptAtlasView.tsx", type: "blob" },
      { path: "components/sky", type: "tree" },
      { path: "components/sky/skyVisuals.tsx", type: "blob" },
      { path: "public/logo.png", type: "blob" },
      { path: "convex/schema.ts", type: "blob" },
    ],
  });

  test("no prefix → lists text-y source files with the read hint", async () => {
    const out = await listRabbitholeFiles(
      undefined,
      stubFetch(new Response(treeBody, { status: 200 })),
    );
    expect(out).toContain("Source files in Rabbithole's code:");
    expect(out).toContain("components/ConceptAtlasView.tsx");
    expect(out).toContain("convex/schema.ts");
    expect(out).not.toContain("logo.png"); // non-source dropped
    expect(out).toContain("read_rabbithole_file");
  });

  test("prefix narrows to a folder", async () => {
    const out = await listRabbitholeFiles(
      "components/sky",
      stubFetch(new Response(treeBody, { status: 200 })),
    );
    expect(out).toContain('Source files under "components/sky":');
    expect(out).toContain("components/sky/skyVisuals.tsx");
    expect(out).not.toContain("convex/schema.ts");
  });

  test("unsafe prefix rejected without touching the network", async () => {
    const spy = vi.fn();
    const out = await listRabbitholeFiles("../etc", spy as unknown as typeof fetch);
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain("doesn't look like a folder");
  });

  test("403 rate-limited → catch-its-breath", async () => {
    const res = new Response("", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
    const out = await listRabbitholeFiles(undefined, stubFetch(res));
    expect(out).toBe(CODE_EXPLORER_RATE_LIMIT_MESSAGE);
  });

  test("prefix with no matches → a gentle narrow/blank nudge", async () => {
    const out = await listRabbitholeFiles(
      "nonexistent/dir",
      stubFetch(new Response(treeBody, { status: 200 })),
    );
    expect(out).toContain('No source files under "nonexistent/dir"');
  });
});

describe("makeScholarCodeTools", () => {
  test("exposes exactly the two public repo tools when no search credential is present", async () => {
    const tools = await makeScholarCodeTools(vi.fn());
    expect(tools.map((t) => t.name)).toEqual([
      "list_rabbithole_files",
      "read_rabbithole_file",
    ]);
  });

  test("read tool runs the public fetch and emits a toolComplete", async () => {
    vi.stubGlobal("fetch", stubFetch(new Response("const y = 2;\n", { status: 200 })));
    const emit = vi.fn();
    const tools = await makeScholarCodeTools(emit);
    const read = tools.find((t) => t.name === "read_rabbithole_file")!;
    const result = await (read as unknown as {
      run: (i: Record<string, unknown>) => Promise<unknown>;
    }).run({ path: "convex/lib/models.ts" });
    expect(String(result)).toContain("const y = 2;");
    expect(emit).toHaveBeenCalledWith({
      toolComplete: { name: "read_rabbithole_file", result: "convex/lib/models.ts" },
    });
  });
});

describe("protected-name guard (parent aide composition)", () => {
  test("names split into lowercase tokens, dropping fragments under 3 chars", () => {
    expect(protectedTermsFromNames(["Kai Kahale", "Al B. Stone", "Lani Kahale"])).toEqual([
      "kai",
      "kahale",
      "stone",
      "lani",
    ]);
  });

  test("any string in the input trips the guard, case-insensitively", () => {
    const terms = protectedTermsFromNames(["Kai Kahale"]);
    expect(inputMentionsProtectedTerm({ query: "KAHALE mastery" }, terms)).toBe(true);
    expect(inputMentionsProtectedTerm({ path: "convex/lib/practice/scheduler.ts" }, terms)).toBe(false);
    expect(inputMentionsProtectedTerm({ path: "convex/kai/x.ts" }, [])).toBe(false);
  });

  test("a guarded tool returns the refusal instead of running", async () => {
    const run = vi.fn(async (_input: { query: string }) => "ran");
    const [guarded] = guardCodeToolArguments(
      [{ name: "read_rabbithole_file", run }],
      protectedTermsFromNames(["Kai Kahale"]),
    );
    expect(await guarded.run({ query: "how is Kai placed" })).toBe(
      CODE_EXPLORER_PROTECTED_TERM_MESSAGE,
    );
    expect(run).not.toHaveBeenCalled();
    expect(await guarded.run({ query: "becameFluentAt" })).toBe("ran");
    expect(guarded.name).toBe("read_rabbithole_file");
  });

  test("no protected terms → the tools pass through untouched", () => {
    const tools = [{ name: "x", run: async () => "" }];
    expect(guardCodeToolArguments(tools, [])).toBe(tools);
  });
});

describe("code search — credentialed and conditionally registered (TRA-305)", () => {
  const APP_ENV = [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_INSTALLATION_ID",
  ] as const;

  test("all three App vars present → available; any one missing → not", () => {
    for (const v of APP_ENV) vi.stubEnv(v, "x");
    expect(codeSearchCredentialsPresent()).toBe(true);
    for (const missing of APP_ENV) {
      vi.stubEnv(missing, "");
      expect(codeSearchCredentialsPresent()).toBe(false);
      vi.stubEnv(missing, "x");
    }
  });

  test("without the App env the tool is NOT registered — the surface loses a tool, never keeps a dead one", async () => {
    for (const v of APP_ENV) vi.stubEnv(v, "");
    const names = (await makeScholarCodeTools(() => {}, { runAction: async () => ({ totalCount: 0, items: [] }) })).map(
      (t) => t.name,
    );
    expect(names).toEqual(["list_rabbithole_files", "read_rabbithole_file"]);
  });

  test("no ctx → no search tool even with the env set", async () => {
    for (const v of APP_ENV) vi.stubEnv(v, "x");
    const names = (await makeScholarCodeTools(() => {})).map((t) => t.name);
    expect(names).toEqual(["list_rabbithole_files", "read_rabbithole_file"]);
  });


  test("a throwing search degrades to the friendly line, never an error dump", async () => {
    for (const v of APP_ENV) vi.stubEnv(v, "x");
    const runAction = vi.fn(async () => {
      throw new Error("GitHub 403: secondary rate limit, token abcd1234");
    });
    const tools = await makeScholarCodeTools(() => {}, { runAction });
    // The builder's return is a union of tool shapes; narrow to this one's args.
    const search = tools.find((t) => t.name === "search_rabbithole_code") as unknown as {
      run: (input: { query: string }) => Promise<string>;
    };
    const out = await search.run({ query: "x" });
    expect(out).toBe(CODE_EXPLORER_UNAVAILABLE_MESSAGE);
    expect(out).not.toContain("abcd1234");
  });

  test("formatCodeSearchHits renders paths, and says so plainly on zero", () => {
    expect(formatCodeSearchHits("twinkle", ["a/b.ts", "c/d.tsx"])).toContain("- a/b.ts");
    expect(formatCodeSearchHits("zzz", [])).toContain('No files in the code matched "zzz"');
  });
});

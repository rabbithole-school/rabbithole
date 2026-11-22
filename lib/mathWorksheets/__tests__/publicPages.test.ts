// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { frozenSlugs, worksheetSkills } from "../catalog";
import { describedSkillKeys, skillCopy } from "../descriptions";
import { skillDescription } from "../seo";
import { isLightPublicPath } from "@/lib/lightPublicRoutes";

const ROOT = path.resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("frozen slugs", () => {
  it("serves every page at its frozen slug", () => {
    const frozen = frozenSlugs();
    for (const s of worksheetSkills()) {
      // A new skill: add `"<key>": "<slug>"` to slugs.json (never edit an entry).
      expect(frozen[s.skillKey], `${s.skillKey} has no entry in slugs.json`).toBe(s.slug);
    }
    expect(new Set(Object.values(frozen)).size).toBe(Object.keys(frozen).length);
  });
});

describe("parent descriptions", () => {
  const BANNED = [/\bworth\b/i, /—/, /\bnot just\b/i, /!(?!\s*=)/, /\bsample problems?\b|\bthe samples\b/i, /\bis listed\b/i, /\bthat said\b/i, /\bby default\b/i, /\bfoundation(al)?\b/i, /\bessential\b/i, /\bcrucial\b/i, /\bfun\b/i, /\bimportant\b/i, /\bcardinality\b/i, /\bsubitiz/i];

  it("has a gist and an about for every page, and nothing for skills without one", () => {
    const keys = new Set(worksheetSkills().map((s) => s.skillKey));
    expect(new Set(describedSkillKeys())).toEqual(keys);
  });

  it("keeps the copy plain and the snippet short", () => {
    for (const s of worksheetSkills()) {
      const c = skillCopy(s.skillKey)!;
      expect(c.gist.length, s.skillKey).toBeLessThanOrEqual(95);
      expect(c.gist, s.skillKey).toMatch(/[.?]$/);
      expect(skillDescription(s).length, s.skillKey).toBeLessThanOrEqual(160);
      const words = c.about.split(/\s+/).length;
      expect(words, s.skillKey).toBeGreaterThanOrEqual(30);
      expect(words, s.skillKey).toBeLessThanOrEqual(100);
      // Factorials (5!) are math, not exclamations.
      const text = `${c.gist} ${c.about}`.replace(/[\dnr)]!/g, "");
      for (const re of BANNED) expect(text, `${s.skillKey}: ${re}`).not.toMatch(re);
    }
  });

  it("is read only by the public worksheet pages", () => {
    const readers = ["app", "components", "convex", "lib", "hooks", "shared"]
      .flatMap((d) => walk(path.join(ROOT, d)))
      .filter((f) => /mathWorksheets\/descriptions|["']\.\/descriptions["']/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    for (const f of readers) expect(f).toMatch(/^(lib\/mathWorksheets|app\/math-worksheets)\//);
  });
});

describe("light layout", () => {
  it("matches the worksheet routes and nothing else", () => {
    expect(isLightPublicPath("/math-worksheets")).toBe(true);
    expect(isLightPublicPath("/math-worksheets/add-within-10")).toBe(true);
    expect(isLightPublicPath("/math-worksheetsx")).toBe(false);
    expect(isLightPublicPath("/scholar")).toBe(false);
    expect(isLightPublicPath(null)).toBe(false);
  });

  it("bundles no Convex client or sign-in code into the worksheet pages' browser code", async () => {
    // The real client graph, followed through every import, the way the
    // bundler sees it. A shared component that reaches for useCurrentUser or
    // the TTS hook (which needs the auth token) fails here.
    const { build } = await import("esbuild");
    const entries = ["components/mathWorksheets/WorksheetMaker.tsx", "components/mathWorksheets/SkillPicker.tsx", "components/mathWorksheets/WorksheetProviders.tsx"];
    const result = await build({
      entryPoints: entries.map((e) => path.join(ROOT, e)),
      bundle: true,
      write: false,
      metafile: true,
      outdir: "/virtual",
      format: "esm",
      platform: "browser",
      logLevel: "silent",
      external: ["react", "react-dom", "next", "katex"],
      alias: { "@": ROOT },
      loader: { ".png": "empty", ".svg": "empty", ".css": "empty" },
    });
    const inputs = Object.keys(result.metafile.inputs);
    const offenders = inputs.filter((i) => /node_modules\/(\.pnpm\/)?(convex@|@convex-dev)|\/convex\/(dist|react)|hooks\/useCurrentUser|hooks\/useTTSQueue|_generated\/api/.test(i));
    expect(offenders).toEqual([]);
  }, 60_000);
});

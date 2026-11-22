/**
 * The sheet's URL shape, kept free of the template and graph imports so the
 * browser bundle can build links without pulling in 8,000 lines of
 * templates. Parsing (which validates skills against the catalog) lives in
 * sheet.ts on the server.
 */

export const COUNT_OPTIONS = [6, 10, 12, 16, 20, 24, 30] as const;
export const DEFAULT_COUNT = 12;
export const DEFAULT_SEED = 1;
/** Most skills one sheet may mix. */
export const MAX_SKILLS = 4;
export const MAX_SEED = 999_999;

export type SheetParams = {
  /** The page's own skill first, then any mixed-in skills. */
  skillKeys: string[];
  count: number;
  seed: number;
};

/** The query string for a sheet, leaving out defaults ("" for the bare page). */
export function sheetQuery(p: SheetParams): string {
  const q = new URLSearchParams();
  if (p.skillKeys.length > 1) q.set("skills", p.skillKeys.join(","));
  if (p.count !== DEFAULT_COUNT) q.set("n", String(p.count));
  if (p.seed !== DEFAULT_SEED) q.set("seed", String(p.seed));
  const s = q.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

/** A fresh seed for "New set" (never the default, so the URL always changes). */
export function randomSeed(): number {
  return 2 + Math.floor(Math.random() * (MAX_SEED - 1));
}

export function worksheetPath(slug?: string): string {
  return slug ? `/math-worksheets/${slug}` : "/math-worksheets";
}

// Bot DRY Layer 5 — shared name→row resolvers for the aide tool layers.
//
// The aide toolsets resolve the same human-typed strings ("the Elements of
// Culture unit") to real rows, and they must do it IDENTICALLY: a loose match
// here assigns the wrong-grade unit to a cohort or files a lesson under the
// wrong unit. This module is the one implementation, imported by every
// assembler that needs it (lib/aideTools.ts's curriculum tools and
// lib/assignmentTools.ts's assignment group) instead of each closing over its
// own copy.
//
// Each export is a FACTORY closing over the request's ActionCtx, mirroring the
// make*Tools shape — the resolver itself is then a plain async function the
// tool run() bodies call.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { matchByName } from "./scholarReadTools";

// Fold the unicode dashes teachers almost never type (‒ – — ― and the
// minus sign −) to an ASCII hyphen, and treat every other run of
// non-alphanumeric characters (parentheses, extra whitespace) as a single
// space, so a natural "elements of culture k-2" matches the real title
// "Elements of Culture (K–2)". Minimal on purpose — this is NOT a fuzzy
// library; it only removes the dash/punctuation/whitespace noise that turns
// an obvious human match into a literal-substring miss.
const normalizeUnitTitle = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[^a-z0-9-]+/g, " ")
    .trim();

// Zero-match menu: titles sharing any non-trivial word with the query, so
// the model can self-correct from the error text alone (capped small).
const NEARBY_UNIT_CAP = 5;
const nearbyUnitTitles = (
  query: string,
  units: { title: string }[],
): string[] => {
  const qWords = new Set(
    normalizeUnitTitle(query)
      .split(" ")
      .filter((w) => w.length >= 3),
  );
  if (qWords.size === 0) return [];
  return units
    .filter((u) =>
      normalizeUnitTitle(u.title)
        .split(" ")
        .some((w) => qWords.has(w)),
    )
    .map((u) => u.title)
    .slice(0, NEARBY_UNIT_CAP);
};

export type ResolvedUnit = { id: Id<"units">; title: string };
export type UnitResolution =
  | { ok: true; unit: ResolvedUnit }
  | { ok: false; error: string };

/**
 * Resolve unit title → row, STRICTLY and self-correctingly — the exact mirror
 * of the scholar-group path (matchByName). The old first-substring-wins
 * resolver silently picked whichever of two same-prefix units listed first
 * (e.g. "Elements of Culture (K–2)" vs "…(Grades 3–5)"), which could assign
 * the wrong-grade unit to a cohort. Now: an exact (dash/punctuation-normalized)
 * title wins; a UNIQUE substring wins; multiple substring matches REFUSE as
 * ambiguous; zero matches return a nearby-titles menu. On any miss the error
 * text is enough for the calling LLM to retry with the exact title (or a
 * unitId where the tool accepts one) — the tool stops guessing and hands the
 * fuzzy matching back to the model.
 */
export function makeUnitResolver(ctx: ActionCtx) {
  return async (query: string): Promise<UnitResolution> => {
    const units = await ctx.runQuery(
      internal.curriculumAssistant.listUnitsInternal,
      {},
    );
    // Raw-exact pre-pass (trim/lowercase only, NO punctuation folding): the
    // literal full title must always be a usable escape hatch. Without this,
    // two titles differing only in punctuation ("Culture: K-2" vs
    // "Culture (K-2)") normalize identically and even the exact original
    // title would refuse as ambiguous forever — a dead end for the
    // title-only tools that take no unitId.
    const rawQuery = query.trim().toLowerCase();
    if (rawQuery) {
      const rawExact = units.filter(
        (u) => u.title.trim().toLowerCase() === rawQuery,
      );
      if (rawExact.length === 1) {
        return {
          ok: true,
          unit: {
            id: rawExact[0].id as Id<"units">,
            title: rawExact[0].title,
          },
        };
      }
    }
    const rows = units.map((u) => ({ ...u, name: u.title }));
    const m = matchByName(query, rows, normalizeUnitTitle);
    if (m.kind === "match") {
      return {
        ok: true,
        unit: { id: m.scholar.id as Id<"units">, title: m.scholar.title },
      };
    }
    if (m.kind === "ambiguous") {
      const list = m.candidates.map((c) => `"${c.title}"`).join(", ");
      return {
        ok: false,
        error: `Ambiguous unit title "${query}" — it matches ${m.candidates.length} units: ${list}. No action taken; retry with the exact full title (or a unitId where the tool accepts one).`,
      };
    }
    const nearby = nearbyUnitTitles(query, units);
    const hint = nearby.length
      ? ` Nearby titles: ${nearby.map((t) => `"${t}"`).join(", ")}.`
      : "";
    return {
      ok: false,
      error: `No unit found matching "${query}".${hint} Call list_units for the full list, then retry with the exact title (or a unitId where the tool accepts one).`,
    };
  };
}

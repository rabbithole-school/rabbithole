import type { SeedPortfolioItem } from "./types";

// Scanned class work (ordinary scans, not Robotics captures) filed to a
// subject assignment (no program group), so the
// family Portfolio has subject groups to show beside the Robotics captures.
// Fictional scholar, fictional work.

function worksheet({
  title,
  accent,
  lines,
}: {
  title: string;
  accent: string;
  lines: string[];
}) {
  const rows = lines
    .map(
      (line, index) =>
        `<text x="110" y="${260 + index * 70}" font-family="Arial, sans-serif" font-size="30" fill="#344054">${line}</text>`,
    )
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="#fbfaf6"/>
  <rect x="70" y="70" width="1060" height="660" rx="24" fill="#ffffff" stroke="#d9d9e8" stroke-width="4"/>
  <rect x="70" y="70" width="1060" height="24" rx="12" fill="${accent}"/>
  <text x="110" y="170" font-family="Arial, sans-serif" font-size="44" font-weight="700" fill="#25324b">${title}</text>
  ${rows}
</svg>`;
}

export const classPortfolioItems: SeedPortfolioItem[] = [
  {
    title: "Fraction strips",
    caption:
      "Folded paper strips into halves, fourths and eighths, then lined them up to show that two fourths cover the same length as one half.",
    scholarKeys: ["s.leilani"],
    source: "google_drive",
    filedTo: {
      assignmentKey: "as.fractions.honu",
      activityKey: "a.fractions.equivalence",
    },
    svg: worksheet({
      title: "Fraction strips",
      accent: "#4f8cc9",
      lines: ["1/2 = 2/4 = 4/8", "Folded three strips and compared them", "The longest piece is the smallest denominator"],
    }),
  },
  {
    title: "Island map story",
    caption:
      "Drew an island and labeled where a voyaging canoe would land, with a short story about reading the swells to find it.",
    scholarKeys: ["s.leilani"],
    source: "google_drive",
    filedTo: {
      assignmentKey: "as.islands.honu",
      activityKey: "a.islands.mapstory",
    },
    svg: worksheet({
      title: "Island map story",
      accent: "#4f9d69",
      lines: ["Landing beach on the north side", "Swells bend around the point", "Story: the canoe follows the birds home"],
    }),
  },
  {
    title: "Tide pool field notes",
    caption:
      "Recorded three tide pool animals with sketches and counted how many hermit crabs moved between two pools in ten minutes.",
    scholarKeys: ["s.leilani"],
    source: "google_drive",
    filedTo: {
      assignmentKey: "as.tidepools.honu",
      activityKey: "a.tidepools.fieldnotes",
    },
    svg: worksheet({
      title: "Tide pool field notes",
      accent: "#ad60bf",
      lines: ["Hermit crabs: 7 moved in 10 minutes", "Sea cucumber stayed under the ledge", "Question: why do crabs switch pools?"],
    }),
  },
  {
    // Unfiled: no assignment, so no subject — the one piece of Other work.
    title: "Sketchbook page",
    caption:
      "A free-draw page of a gecko on a window, shaded with cross-hatching from light to dark.",
    scholarKeys: ["s.leilani"],
    source: "google_drive",
    svg: worksheet({
      title: "Sketchbook page",
      accent: "#c98a4f",
      lines: ["Gecko on the classroom window", "Cross-hatching: light to dark"],
    }),
  },
];

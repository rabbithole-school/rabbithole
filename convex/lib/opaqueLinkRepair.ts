const GOOGLE_OPAQUE_LINK =
  /https?:\/\/(?:docs\.google\.com\/(?:document|presentation|spreadsheets|forms)\/d\/|drive\.google\.com\/(?:file\/d\/|drive\/folders\/))([A-Za-z0-9_-]{20,})/g;

function osaDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let i = 0; i <= left.length; i++) rows[i][0] = i;
  for (let j = 0; j <= right.length; j++) rows[0][j] = j;

  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + substitutionCost,
      );

      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }

  return rows[left.length][right.length];
}

export function collectOpaqueIds(text: string): string[] {
  return Array.from(text.matchAll(GOOGLE_OPAQUE_LINK), (match) => match[1]);
}

export function repairOpaqueLinks(
  text: string,
  knownIds: Iterable<string>,
): string {
  const known = [...new Set(knownIds)];
  if (known.length === 0) return text;
  const knownSet = new Set(known);

  return text.replace(GOOGLE_OPAQUE_LINK, (match, id: string) => {
    if (knownSet.has(id)) return match;
    const candidates = known.filter(
      (knownId) =>
        knownId.length === id.length && osaDistance(id, knownId) <= 2,
    );
    if (candidates.length !== 1) return match;
    return match.slice(0, -id.length) + candidates[0];
  });
}

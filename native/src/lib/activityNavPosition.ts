// "Activity N of M" carried by a ← / → tap into the next session's route
// params (navPos/navTotal), so the activity bar is drawn at once instead of
// popping in when the unit's progress arrives.
export type ActivityNavPosition = { position: number; total: number };

export function parseActivityNavPosition(
  pos?: string | null,
  total?: string | null,
): ActivityNavPosition | null {
  const p = Number(pos);
  const t = Number(total);
  return Number.isInteger(p) && Number.isInteger(t) && p >= 1 && t > 1 && p <= t
    ? { position: p, total: t }
    : null;
}

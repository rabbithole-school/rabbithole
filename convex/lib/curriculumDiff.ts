/**
 * Tiny line-level diff (LCS) for showing a teacher exactly what the Improver
 * changed in an activity's systemPrompt — the product-side twin of
 * evals/curriculum-sim/lib/diff.ts. Pure + dependency-free so it's unit-tested
 * AND importable from React (the variant-review UI renders the diff client-side)
 * with no Convex/server imports.
 */
export type DiffLine = { sign: " " | "-" | "+"; text: string };

/** Longest-common-subsequence line diff of `a` → `b`. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        A[i] === B[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ sign: " ", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: "-", text: A[i] });
      i++;
    } else {
      out.push({ sign: "+", text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ sign: "-", text: A[i++] });
  while (j < m) out.push({ sign: "+", text: B[j++] });
  return out;
}

/** Was there any change at all? */
export function hasChange(a: string, b: string): boolean {
  return lineDiff(a, b).some((d) => d.sign !== " ");
}

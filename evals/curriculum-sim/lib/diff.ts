/**
 * Tiny line-level diff (LCS) for showing a teacher exactly what the Improver
 * changed in an activity's systemPrompt. Pure + dependency-free so it's tested
 * (__tests__/diff.test.ts) and reusable in any report.
 */
export type DiffLine = { sign: " " | "-" | "+"; text: string };

/** Longest-common-subsequence line diff of `a` → `b`. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
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

/** Render a diff as a fenced ```diff block for markdown reports. */
export function renderDiff(a: string, b: string): string {
  const body = lineDiff(a, b)
    .map((d) => `${d.sign}${d.sign === " " ? "" : " "}${d.text}`)
    .join("\n");
  return "```diff\n" + body + "\n```";
}

/** Was there any change at all? */
export function hasChange(a: string, b: string): boolean {
  return lineDiff(a, b).some((d) => d.sign !== " ");
}

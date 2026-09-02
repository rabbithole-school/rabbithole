// Pure PCA (dual / Gram-matrix power iteration): project a cloud of
// high-dimensional vectors to 2D. Shared by conceptAtlas.ts (Sky projection)
// and practiceAtlas.ts (Skills-map treeY / treeY2). Kept in lib/ so both
// "use node" action files can import without touching each other.
//
// Algorithm: build the n×n Gram matrix G = X Xᵀ (after mean-centering),
// then extract the top-2 eigenvectors via power iteration. For the small
// node counts in this codebase (dozens–hundreds), the n×n Gram approach is
// faster to implement than the full d×d covariance and avoids allocating a
// 512×512 matrix in tight loops.

export function pca2d(vectors: number[][]): [number, number][] {
  const n = vectors.length;
  if (n === 0) return [];
  const d = vectors[0].length;

  // Mean-centre
  const mean = new Array(d).fill(0);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const X = vectors.map((v) => v.map((x, j) => x - mean[j]));

  // Gram matrix G = X Xᵀ (n×n, symmetric)
  const G: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = i; k < n; k++) {
      let s = 0;
      const xi = X[i], xk = X[k];
      for (let j = 0; j < d; j++) s += xi[j] * xk[j];
      G[i][k] = s;
      G[k][i] = s;
    }
  }

  function topEig(M: number[][]): { vec: number[]; val: number } {
    let v = Array.from({ length: n }, () => Math.random() - 0.5);
    let val = 0;
    for (let iter = 0; iter < 120; iter++) {
      const w = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        let s = 0;
        const Mi = M[i];
        for (let k = 0; k < n; k++) s += Mi[k] * v[k];
        w[i] = s;
      }
      const norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0)) || 1;
      v = w.map((x) => x / norm);
      val = norm;
    }
    return { vec: v, val };
  }

  const e1 = topEig(G);
  // Deflate: G -= λ₁ u₁ u₁ᵀ
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) G[i][k] -= e1.val * e1.vec[i] * e1.vec[k];
  const e2 = topEig(G);

  const s1 = Math.sqrt(Math.max(e1.val, 1e-9));
  const s2 = Math.sqrt(Math.max(e2.val, 1e-9));
  return vectors.map((_, i) => [e1.vec[i] * s1, e2.vec[i] * s2] as [number, number]);
}

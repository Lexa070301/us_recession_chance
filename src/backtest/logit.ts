/**
 * Minimal IRLS logistic regression (no external deps).
 * Used by scripts/fitModel.ts to fit a pooled 12-month recession model and by
 * future score->probability calibration. Predictors are standardized before
 * fitting; coefficients are reported in raw units as well.
 */

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Solve Ax = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) throw new Error("Singular Hessian — add ridge or drop a predictor");
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

export interface LogitFit {
  /** Coefficients on STANDARDIZED predictors; index 0 = intercept. */
  betaStd: number[];
  /** Coefficients on raw predictors; index 0 = intercept. */
  betaRaw: number[];
  means: number[];
  stds: number[];
  logLik: number;
  nullLogLik: number;
  mcfaddenR2: number;
  iterations: number;
}

export function predictProb(betaStd: number[], means: number[], stds: number[], x: number[]): number {
  let z = betaStd[0];
  for (let j = 0; j < x.length; j++) z += betaStd[j + 1] * ((x[j] - means[j]) / stds[j]);
  return sigmoid(z);
}

export function fitLogit(
  X: number[][],
  y: number[],
  opts: { ridge?: number; maxIter?: number; tol?: number } = {},
): LogitFit {
  const ridge = opts.ridge ?? 1e-4;
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-9;

  const n = X.length;
  const k = X[0].length;
  const means = new Array<number>(k).fill(0);
  const stds = new Array<number>(k).fill(0);
  for (const row of X) for (let j = 0; j < k; j++) means[j] += row[j];
  for (let j = 0; j < k; j++) means[j] /= n;
  for (const row of X) for (let j = 0; j < k; j++) stds[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < k; j++) stds[j] = Math.sqrt(stds[j] / n) || 1;

  // standardized design matrix with intercept column
  const Z = X.map((row) => [1, ...row.map((v, j) => (v - means[j]) / stds[j])]);
  const p = k + 1;
  let beta = new Array<number>(p).fill(0);
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    const grad = new Array<number>(p).fill(0);
    const H = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < p; j++) z += Z[i][j] * beta[j];
      const pi = sigmoid(z);
      const wi = Math.max(pi * (1 - pi), 1e-9);
      const ri = y[i] - pi;
      for (let a = 0; a < p; a++) {
        grad[a] += Z[i][a] * ri;
        for (let b = 0; b < p; b++) H[a][b] += Z[i][a] * wi * Z[i][b];
      }
    }
    for (let a = 0; a < p; a++) H[a][a] += ridge;
    const delta = solve(H, grad);
    let maxDelta = 0;
    for (let a = 0; a < p; a++) {
      beta[a] += delta[a];
      maxDelta = Math.max(maxDelta, Math.abs(delta[a]));
    }
    if (maxDelta < tol) break;
  }

  const ll = logLik(Z, y, beta);
  const pBar = y.reduce((s, v) => s + v, 0) / n;
  const llNull = n * (pBar * Math.log(pBar || 1e-12) + (1 - pBar) * Math.log(1 - pBar || 1e-12));

  // convert to raw units: z = b0 + Σ bj (xj - mj)/sj = (b0 - Σ bj*mj/sj) + Σ (bj/sj) xj
  const betaRaw = new Array<number>(p).fill(0);
  for (let j = 1; j < p; j++) betaRaw[j] = beta[j] / stds[j - 1];
  betaRaw[0] = beta[0] - means.reduce((s, m, j) => s + (beta[j + 1] * m) / stds[j], 0);

  return { betaStd: beta, betaRaw, means, stds, logLik: ll, nullLogLik: llNull, mcfaddenR2: 1 - ll / llNull, iterations };
}

function logLik(Z: number[][], y: number[], beta: number[]): number {
  let ll = 0;
  for (let i = 0; i < Z.length; i++) {
    let z = 0;
    for (let j = 0; j < beta.length; j++) z += Z[i][j] * beta[j];
    ll += y[i] * z - Math.log(1 + Math.exp(z));
  }
  return ll;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  avgPred: number;
  empirical: number;
}

/** Reliability table: predicted-probability bins vs observed frequency. */
export function reliability(probs: number[], y: number[], bins = 10): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = probs.map((p, i) => (p >= lo && (p < hi || (b === bins - 1 && p <= hi)) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    out.push({
      lo,
      hi,
      n: idx.length,
      avgPred: idx.reduce((s, i) => s + probs[i], 0) / idx.length,
      empirical: idx.reduce((s, i) => s + y[i], 0) / idx.length,
    });
  }
  return out;
}

/*
  Perspective Lens, tape detection. Pure functions, no DOM access, so a Node
  test harness can require() it. Loaded by perspective-lens.html as a classic
  script (sets window.LensTape).

  detectTape finds strips of (blue painter's) tape in an RGBA frame and checks
  whether their extended lines meet in one point:
    HSV threshold -> binary mask -> 3x3 open -> drop small / non-elongated
    components -> iterative RANSAC line fitting (one line per strip, along its
    centerline) -> total-least-squares refit on the inliers -> VP by weighted
    least squares on perpendicular distance.
*/
(function (root) {
  'use strict';

  const DEFAULT_TARGET = { h: 205, s: 0.55, v: 0.7 };
  // Verdict thresholds (see report): angles within PARALLEL_DEG are "parallel";
  // RMS distance of the lines from the best common point, as a fraction of the
  // image diagonal, below MEET_SPREAD is "meet".
  // Parallel vs meet is decided geometrically: lines whose angles agree within
  // PARALLEL_DEG, or whose common point is farther than PARALLEL_FAR_WIDTHS image
  // widths away, are "parallel". A common point farther than FAR_WIDTHS but
  // nearer than that is a real meet, reported with far:true ("almost parallel").
  const PARALLEL_DEG = 0.5;
  const PARALLEL_FAR_WIDTHS = 25;
  const FAR_WIDTHS = 6;
  const MEET_SPREAD = 0.025;
  const MAX_TAPE_WIDTH = 0.055;   // of the diagonal: anything fatter is a blob, not tape

  function rgb2hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
  }
  function hueDist(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Median {h,s,v} of the pixels within `radius` of (x,y). Hue is median'd
  // relative to a circular mean, so reds near 0/360 don't break it.
  function sampleColor(img, x, y, radius) {
    radius = radius == null ? 6 : radius;
    const W = img.width, H = img.height, d = img.data;
    const hs = [], ss = [], vs = [];   // per pixel
    let cx = 0, cy = 0;
    const x0 = Math.max(0, Math.floor(x - radius)), x1 = Math.min(W - 1, Math.ceil(x + radius));
    const y0 = Math.max(0, Math.floor(y - radius)), y1 = Math.min(H - 1, Math.ceil(y + radius));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      if ((i - x) * (i - x) + (j - y) * (j - y) > radius * radius) continue;
      const k = (j * W + i) * 4;
      const c = rgb2hsv(d[k], d[k + 1], d[k + 2]);
      hs.push(c.h); ss.push(c.s); vs.push(c.v);
      if (c.s > 0.05) { cx += Math.cos(c.h * Math.PI / 180); cy += Math.sin(c.h * Math.PI / 180); }
    }
    // Tape is often thinner than the tap circle, so most pixels in it are
    // background. If enough of them are blue, take the median of just those.
    const blue = [];
    for (let i = 0; i < hs.length; i++) if (hs[i] >= 160 && hs[i] <= 265 && ss[i] >= 0.15) blue.push(i);
    if (blue.length >= 5) {
      const pick = a => blue.map(i => a[i]);
      const bh = pick(hs), bs = pick(ss), bv = pick(vs);
      hs.length = ss.length = vs.length = 0;
      hs.push(...bh); ss.push(...bs); vs.push(...bv);
      cx = 0; cy = 0;
      for (const h of bh) { cx += Math.cos(h * Math.PI / 180); cy += Math.sin(h * Math.PI / 180); }
    }
    if (!hs.length) return { h: DEFAULT_TARGET.h, s: DEFAULT_TARGET.s, v: DEFAULT_TARGET.v };
    const ref = (Math.atan2(cy, cx) * 180 / Math.PI + 360) % 360;
    const rel = hs.map(h => { let r = h - ref; if (r > 180) r -= 360; if (r < -180) r += 360; return r; });
    return { h: ((ref + median(rel)) % 360 + 360) % 360, s: median(ss), v: median(vs) };
  }

  // 3x3 min (erode) or max (dilate) filter, separable.
  function morph3(src, w, h, erode) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = y * w + x;
      let v = src[o];
      if (x > 0) v = erode ? (v & src[o - 1]) : (v | src[o - 1]); else if (erode) v = 0;
      if (x < w - 1) v = erode ? (v & src[o + 1]) : (v | src[o + 1]); else if (erode) v = 0;
      tmp[o] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = y * w + x;
      let v = tmp[o];
      if (y > 0) v = erode ? (v & tmp[o - w]) : (v | tmp[o - w]); else if (erode) v = 0;
      if (y < h - 1) v = erode ? (v & tmp[o + w]) : (v | tmp[o + w]); else if (erode) v = 0;
      out[o] = v;
    }
    return out;
  }

  // Remove everything that is fatter than a tape strip (shirts, denim, sky): a
  // square of side `side` is >=80% filled inside a blob but never inside a thin strip, so
  // open the mask with it (via integral images) and subtract that blob body,
  // grown a little to take its soft edge too. Strips touching a blob survive.
  function removeBlobs(mask, w, h, side) {
    const r = side >> 1, side2 = 2 * r + 1;
    const I = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += mask[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    const core = new Uint8Array(w * h);
    let any = false;
    // Windows stay inside the image: a strip cut by the frame edge must not
    // look fat. (Sky cut by the top edge is handled by the level-top rule.)
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
      if (!mask[y * w + x]) continue;
      const a = I[(y + r + 1) * (w + 1) + x + r + 1] - I[(y - r) * (w + 1) + x + r + 1]
              - I[(y + r + 1) * (w + 1) + x - r] + I[(y - r) * (w + 1) + x - r];
      if (a >= 0.8 * side2 * side2) { core[y * w + x] = 1; any = true; }
    }
    if (!any) return;
    // Dilate the core by r + grow (the opening), by integral image again.
    const g = r + 1;
    const J = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += core[y * w + x]; J[(y + 1) * (w + 1) + x + 1] = J[y * (w + 1) + x + 1] + row; }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const x0 = Math.max(0, x - g), x1 = Math.min(w - 1, x + g), y0 = Math.max(0, y - g), y1 = Math.min(h - 1, y + g);
      const a = J[(y1 + 1) * (w + 1) + x1 + 1] - J[y0 * (w + 1) + x1 + 1] - J[(y1 + 1) * (w + 1) + x0] + J[y0 * (w + 1) + x0];
      if (a > 0) mask[y * w + x] = 0;
    }
  }

  // Remove connected components that are too small or too compact to hold a
  // segment of length minLen. In place.
  function filterComponents(mask, w, h, minArea, minLen) {
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || seen[s]) continue;
      let sp = 0, n = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      const members = [];
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const p = stack[--sp]; members.push(p); n++;
        const px = p % w, py = (p - px) / w;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (n < minArea || Math.hypot(x1 - x0, y1 - y0) < minLen) for (const p of members) mask[p] = 0;
    }
  }

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Total least squares line through points idx[]; returns centroid + unit direction.
  function tls(X, Y, idx, n) {
    let mx = 0, my = 0;
    for (let k = 0; k < n; k++) { mx += X[idx[k]]; my += Y[idx[k]]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let k = 0; k < n; k++) {
      const dx = X[idx[k]] - mx, dy = Y[idx[k]] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { mx, my, dx: Math.cos(th), dy: Math.sin(th) };
  }

  function angleOf(dx, dy) {
    let a = Math.atan2(dy, dx) * 180 / Math.PI;
    a = ((a % 180) + 180) % 180;
    return a;
  }

  function detectTape(img, opts) {
    opts = opts || {};
    const w = img.width, h = img.height, data = img.data;
    const diag = Math.hypot(w, h);
    const target = opts.target || null;
    const T = target || DEFAULT_TARGET;
    const hueTol = opts.hueTol != null ? opts.hueTol : (target ? 11 : 18);
    // Uncalibrated needs a higher floor: cool grey walls and shirts reach s~0.2.
    const satMin = opts.satMin != null ? opts.satMin : (target ? 0.18 : 0.25);
    const valMin = opts.valMin != null ? opts.valMin : 0.25;
    const minLen = (opts.minLenFrac != null ? opts.minLenFrac : 0.08) * diag;
    const maxLines = opts.maxLines != null ? opts.maxLines : 8;
    // Default blue has no calibration, so allow a wider hue band.
    const hTol = target ? hueTol : Math.max(hueTol, 30);

    // 1. HSV threshold.
    let mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const c = rgb2hsv(data[p], data[p + 1], data[p + 2]);
      if (c.s < satMin || c.v < valMin) continue;
      if (hueDist(c.h, T.h) > hTol) continue;
      if (target && (Math.abs(c.s - T.s) > 0.3 || Math.abs(c.v - T.v) > 0.35)) continue;
      mask[i] = 1;
    }
    // 2. Cleanup: open (drops speckle), then drop small / compact components.
    mask = morph3(morph3(mask, w, h, true), w, h, false);
    removeBlobs(mask, w, h, Math.round(MAX_TAPE_WIDTH * diag));
    filterComponents(mask, w, h, Math.max(20, 0.0006 * w * h), minLen * 0.8);

    let maskCount = 0;
    for (let i = 0; i < mask.length; i++) maskCount += mask[i];

    // 3. Sample mask pixels on a grid (cap ~9000) for RANSAC.
    const stride = Math.max(1, Math.ceil(Math.sqrt(maskCount / 9000)));
    const cell = stride * stride;
    const xs = [], ys = [];
    for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
      if (mask[y * w + x]) { xs.push(x); ys.push(y); }
    }
    const N = xs.length;
    const X = Float32Array.from(xs), Y = Float32Array.from(ys);
    const alive = new Uint8Array(N).fill(1);
    let aliveCount = N;
    const band = Math.max(2.5, 0.02 * diag);
    const gapMax = Math.max(3 * stride, 0.04 * diag);
    const rand = rng(12345);
    const segments = [];
    let failures = 0;
    const idxBuf = new Int32Array(N), run = new Int32Array(N);

    while (segments.length < maxLines && failures < 6 && aliveCount * cell > minLen * 2.5) {
      const list = new Int32Array(aliveCount);
      let m = 0;
      for (let i = 0; i < N; i++) if (alive[i]) list[m++] = i;
      let best = null, bestN = 0;
      for (let it = 0; it < 260; it++) {
        const a = list[(rand() * m) | 0], b = list[(rand() * m) | 0];
        const dx = X[b] - X[a], dy = Y[b] - Y[a], L = Math.hypot(dx, dy);
        if (L < minLen * 0.6) continue;
        const nx = -dy / L, ny = dx / L, c = nx * X[a] + ny * Y[a];
        let cnt = 0;
        for (let k = 0; k < m; k++) { const i = list[k]; if (Math.abs(nx * X[i] + ny * Y[i] - c) < band) cnt++; }
        if (cnt > bestN) { bestN = cnt; best = { mx: X[a], my: Y[a], dx: dx / L, dy: dy / L }; }
      }
      if (!best || bestN * cell < minLen * 2) break;

      // Refine: refit on inliers a few times, then keep the longest gap-free run.
      let ln = best, tmin = 0, tmax = 0, runN = 0, ok = false;
      for (let rep = 0; rep < 4; rep++) {
        const nx = -ln.dy, ny = ln.dx;
        let n = 0;
        for (let k = 0; k < m; k++) {
          const i = list[k];
          if (Math.abs(nx * (X[i] - ln.mx) + ny * (Y[i] - ln.my)) < band) idxBuf[n++] = i;
        }
        if (n < 3) break;
        ln = tls(X, Y, idxBuf, n);
        const nx2 = -ln.dy, ny2 = ln.dx;
        // Keep the points inside the band of the refit line, sorted along it.
        const arr = [];
        for (let k = 0; k < m; k++) {
          const i = list[k];
          const dxp = X[i] - ln.mx, dyp = Y[i] - ln.my;
          if (Math.abs(nx2 * dxp + ny2 * dyp) < band) arr.push([dxp * ln.dx + dyp * ln.dy, i]);
        }
        if (arr.length < 3) break;
        arr.sort((p, q) => p[0] - q[0]);
        let bs = 0, be = 0, s = 0;
        for (let k = 1; k <= arr.length; k++) {
          if (k === arr.length || arr[k][0] - arr[k - 1][0] > gapMax) {
            if (k - s > be - bs) { bs = s; be = k; }
            s = k;
          }
        }
        runN = be - bs;
        for (let k = 0; k < runN; k++) run[k] = arr[bs + k][1];
        tmin = arr[bs][0]; tmax = arr[be - 1][0];
        ln = tls(X, Y, run, runN);
        // Re-express t range on the refit line.
        let t0 = Infinity, t1 = -Infinity;
        for (let k = 0; k < runN; k++) {
          const t = (X[run[k]] - ln.mx) * ln.dx + (Y[run[k]] - ln.my) * ln.dy;
          if (t < t0) t0 = t; if (t > t1) t1 = t;
        }
        tmin = t0; tmax = t1; ok = true;
      }
      if (!ok) { failures++; break; }

      const extent = tmax - tmin + stride;
      const area = runN * cell;
      const width = area / Math.max(extent, 1);
      const valid = extent >= minLen && width <= 0.06 * diag && extent / Math.max(width, 1) >= 3.5;
      // Remove the points this line explained (valid or not, so we make progress).
      const nx = -ln.dy, ny = ln.dx;
      for (let k = 0; k < m; k++) {
        const i = list[k];
        const dxp = X[i] - ln.mx, dyp = Y[i] - ln.my;
        const t = dxp * ln.dx + dyp * ln.dy;
        if (Math.abs(nx * dxp + ny * dyp) < band * 1.4 && t > tmin - band && t < tmax + band) { alive[i] = 0; aliveCount--; }
      }
      if (!valid) { failures++; continue; }
      // A level line hugging the TOP border is sky or ceiling, not tape.
      const bm = Math.max(4, 0.015 * diag);
      const x1 = ln.mx + ln.dx * tmin, y1 = ln.my + ln.dy * tmin, x2 = ln.mx + ln.dx * tmax, y2 = ln.my + ln.dy * tmax;
      const ang = angleOf(ln.dx, ln.dy);
      if (y1 < bm && y2 < bm && (ang < 3 || ang > 177)) { failures++; continue; }
      segments.push({ x1, y1, x2, y2, len: extent, angle: ang, support: area });
    }
    segments.sort((a, b) => b.len - a.len);

    // 4. Pairwise intersections (skip near-parallel pairs).
    const pairwise = [];
    for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
      const A = segments[i], B = segments[j];
      const d1x = A.x2 - A.x1, d1y = A.y2 - A.y1, d2x = B.x2 - B.x1, d2y = B.y2 - B.y1;
      const den = d1x * d2y - d1y * d2x;
      if (Math.abs(den) < 1e-9 * A.len * B.len) continue;
      const t = ((B.x1 - A.x1) * d2y - (B.y1 - A.y1) * d2x) / den;
      pairwise.push({ x: A.x1 + d1x * t, y: A.y1 + d1y * t });
    }

    // 5. Verdict.
    const base = { maskCount, segments, pairwise, mask, width: w, height: h, vpDistWidths: null, far: false };
    const out = (verdict, vp, spread) => Object.assign(base, { verdict, vp: vp || null, spread: spread == null ? null : spread });
    if (segments.length < 2) return out('too-few');
    let maxDiff = 0;
    for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
      let d = Math.abs(segments[i].angle - segments[j].angle); d = Math.min(d, 180 - d);
      if (d > maxDiff) maxDiff = d;
    }
    if (maxDiff <= PARALLEL_DEG) return out('parallel');
    // Two lines always cross somewhere, which tells the kid nothing. Hand back
    // the crossing as a hint under its own verdict.
    if (segments.length === 2) return out('two', pairwise[0] || null, 0);

    // Weighted least squares: minimise sum w (n.v - c)^2. No line is dropped
    // for disagreeing: a kid who taped two families must see 'scattered'.
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, wsum = 0;
    const L = segments.map(s => {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, ny = dx / l;
      return { nx, ny, c: nx * s.x1 + ny * s.y1, w: s.len };
    });
    for (const q of L) {
      a11 += q.w * q.nx * q.nx; a12 += q.w * q.nx * q.ny; a22 += q.w * q.ny * q.ny;
      b1 += q.w * q.c * q.nx; b2 += q.w * q.c * q.ny; wsum += q.w;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12 * wsum * wsum) return out('parallel');
    const vp = { x: (b1 * a22 - b2 * a12) / det, y: (a11 * b2 - a12 * b1) / det };
    let ss = 0;
    for (const q of L) { const d = q.nx * vp.x + q.ny * vp.y - q.c; ss += q.w * d * d; }
    const spread = Math.sqrt(ss / wsum) / diag;
    const dw = Math.hypot(vp.x - w / 2, vp.y - h / 2) / w;
    base.vpDistWidths = dw; base.far = dw > FAR_WIDTHS;
    if (spread >= MEET_SPREAD) return out('scattered', vp, spread);
    if (dw > PARALLEL_FAR_WIDTHS) return out('parallel', null, spread);
    return out('meet', vp, spread);
  }

  const api = { sampleColor, detectTape, MEET_SPREAD, PARALLEL_DEG, PARALLEL_FAR_WIDTHS, FAR_WIDTHS, DEFAULT_TARGET };
  root.LensTape = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

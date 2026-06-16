(function (GM) {
  'use strict';
  // =====================================================================
  // GRID DETECTION
  // ---------------------------------------------------------------------
  // A square grid is a PERIODIC pattern of full-length lines. So:
  //   1. reduce the image to two 1-D "line-strength" profiles — for every
  //      column, how line-like is it (summed over all rows), and vice-versa.
  //      A vertical grid line lights up its whole column, so real grid lines
  //      stack into evenly-spaced peaks while map content stays noise.
  //   2. cells are assumed SQUARE, so there is ONE pixel cell-size shared by
  //      both axes (found from the COMBINED both-axis autocorrelation).
  //   3. probe FIVE windows in a dice-5 / quincunx layout (4 corners + centre)
  //      and take the median voted period — robust to local clutter and not
  //      biased toward the centre.
  //   4. refine that period + phase to sub-pixel on the FULL image so the grid
  //      fits edge-to-edge instead of drifting toward the corners.
  //   5. only search periods that keep both axes within [MIN_CELLS, MAX_CELLS]
  //      — maps with fewer than ~10 or more than ~100 cells/side are unusual.
  //   6. if no window finds a confident period, fall back to an estimate.
  // The profiles run on a downscaled copy, but cell COUNT is scale-invariant
  // (length/period), so the reported numbers don't depend on the downscale.
  // =====================================================================
  // ANALYSIS_MAX / DISPLAY_MAX / DEFAULT_CELL_PX are shared → GM.const (state.js).
  const CONF_T = 0.18;         // min autocorr confidence to trust a grid
  const MIN_CELLS = 10;        // maps under ~10 cells/side are unusual…
  const MAX_CELLS = 100;       // …and over ~100 cells/side even more so

  function toLuma(data, W, H) {
    const L = new Float32Array(W * H);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) {
      L[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return L;
  }

  // Per-column / per-row line strength: |center - surround| (a polarity-blind
  // thin-line detector) accumulated along the perpendicular axis.
  function buildProfiles(L, W, H) {
    const col = new Float32Array(W), row = new Float32Array(H), d = 2;
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = d; x < W - d; x++) col[x] += Math.abs(2 * L[o + x] - L[o + x - d] - L[o + x + d]);
    }
    for (let y = d; y < H - d; y++) {
      const o = y * W, om = (y - d) * W, op = (y + d) * W;
      for (let x = 0; x < W; x++) row[y] += Math.abs(2 * L[o + x] - L[om + x] - L[op + x]);
    }
    return { col, row };
  }

  // Detrend a profile → zero-mean signal + variance (== autocorrelation @ lag 0).
  function axisStats(prof, len) {
    let mean = 0;
    for (let i = 0; i < len; i++) mean += prof[i];
    mean /= len;
    const s = new Float32Array(len);
    let v0 = 0;
    for (let i = 0; i < len; i++) { s[i] = prof[i] - mean; v0 += s[i] * s[i]; }
    return { s, v0: v0 / len };
  }

  // Autocorrelation of a zero-mean signal at one lag (normalised by overlap).
  function acAt(s, len, lag) {
    let sum = 0; const n = len - lag;
    for (let i = 0; i < n; i++) sum += s[i] * s[i + lag];
    return sum / n;
  }

  // Line-strength profiles for a rectangular sub-region (same |center −
  // surround| detector as buildProfiles, scoped to one window).
  function regionProfiles(L, W, x0, y0, rw, rh) {
    const col = new Float32Array(rw), row = new Float32Array(rh), d = 2;
    for (let yy = 0; yy < rh; yy++) {
      const o = (y0 + yy) * W + x0;
      for (let xx = d; xx < rw - d; xx++) col[xx] += Math.abs(2 * L[o + xx] - L[o + xx - d] - L[o + xx + d]);
    }
    for (let yy = d; yy < rh - d; yy++) {
      const o = (y0 + yy) * W + x0, om = o - d * W, op = o + d * W;
      for (let xx = 0; xx < rw; xx++) row[yy] += Math.abs(2 * L[o + xx] - L[om + xx] - L[op + xx]);
    }
    return { col, row };
  }

  // The shared (square) cell period for one region: combined-axis
  // autocorrelation → fundamental pick → subharmonic guard. Confidence is the
  // weaker of the two axes' normalised autocorrelation at that period.
  function detectPeriod(col, w, row, h, pMin, pMax) {
    const cx = axisStats(col, w), cy = axisStats(row, h);
    const hi = Math.min(pMax, Math.floor(Math.min(w, h) / 3));
    if (cx.v0 <= 0 || cy.v0 <= 0 || hi < pMin) return { period: 0, confidence: 0 };
    const comb = new Float32Array(hi + 2);
    let peak = 0, period = pMin;
    for (let lag = pMin; lag <= hi; lag++) {
      comb[lag] = acAt(cx.s, w, lag) / cx.v0 + acAt(cy.s, h, lag) / cy.v0;
      if (comb[lag] > peak) { peak = comb[lag]; period = lag; }
    }
    for (let lag = pMin + 1; lag < hi; lag++) {
      if (comb[lag] >= 0.7 * peak && comb[lag] > comb[lag - 1] && comb[lag] >= comb[lag + 1]) { period = lag; break; }
    }
    for (let g = 0; g < 3; g++) {
      const half = Math.round(period / 2);
      if (half < pMin) break;
      if (comb[half] >= comb[half - 1] && comb[half] >= comb[half + 1] && comb[half] >= 0.45 * comb[period]) period = half;
      else break;
    }
    return { period, confidence: Math.min(acAt(cx.s, w, period) / cx.v0, acAt(cy.s, h, period) / cy.v0) };
  }

  // How well an evenly-spaced comb (a given period, best phase) lands on a
  // profile across its FULL length — per-line strength vs the mean (>1 ⇒ lines
  // sit on real grid lines), plus the winning offset.
  function fitAxis(prof, len, period, mean) {
    let bo = 0, bs = -Infinity;
    const step = period < 14 ? 0.5 : 1;
    for (let o = 0; o < period; o += step) {
      let s = 0; for (let x = o; x < len; x += period) s += prof[Math.round(x)];
      if (s > bs) { bs = s; bo = o; }
    }
    let n = 0; for (let x = bo; x < len; x += period) n++;
    return { offset: bo, strength: (n > 0 && mean > 0) ? (bs / n) / mean : 0 };
  }

  function analyzeImageData(img, regions, opts) {
    const { data, width: W, height: H } = img;
    const L = toLuma(data, W, H);

    // SQUARE cells → one px cell-size shared by both axes; restrict the search
    // to periods that keep both axes within [MIN_CELLS, MAX_CELLS].
    let pMin = Math.max(4, Math.ceil(Math.max(W, H) / MAX_CELLS));
    let pMax = Math.floor(Math.min(W, H) / MIN_CELLS);
    // A user-supplied cell-size hint (the "4 cells" tool) overrides the bounds
    // with a tight band around it — the ±margin isolates the true period from
    // its half/double harmonics, so detection locks onto the measured size.
    if (opts && opts.period > 0) {
      const m = opts.margin || 0.25;
      pMin = Math.max(4, Math.round(opts.period * (1 - m)));
      pMax = Math.min(Math.floor(Math.min(W, H) / 2), Math.round(opts.period * (1 + m)));
    }
    const fail = {
      cols: 0, rows: 0, detected: false, confidence: 0,
      ax: { periodFrac: 0, offsetFrac: 0 }, ay: { periodFrac: 0, offsetFrac: 0 },
    };
    if (pMax < pMin) return fail;

    // --- Probe windows that each vote on the cell period; the median is robust
    // to local clutter. Default: a dice-5 / quincunx layout (4 corners + centre).
    // If the user hand-picked region(s), probe those instead. ---
    let windows;
    if (regions && regions.length) {
      windows = regions.map((r) => {
        const x0 = Math.max(0, Math.min(W - 1, Math.round(r.x)));
        const y0 = Math.max(0, Math.min(H - 1, Math.round(r.y)));
        return [x0, y0, Math.max(1, Math.min(W - x0, Math.round(r.w))), Math.max(1, Math.min(H - y0, Math.round(r.h)))];
      });
    } else {
      const win = Math.min(W, H, Math.max(pMax * 3, Math.round(Math.min(W, H) * 0.55)));
      windows = [
        [0, 0], [W - win, 0], [0, H - win], [W - win, H - win],
        [Math.round((W - win) / 2), Math.round((H - win) / 2)],
      ].map(([x, y]) => [Math.max(0, x), Math.max(0, y), win, win]);
    }
    const good = windows
      .map(([x0, y0, rw, rh]) => {
        const { col, row } = regionProfiles(L, W, x0, y0, rw, rh);
        return detectPeriod(col, rw, row, rh, pMin, pMax);
      })
      .filter((p) => p.confidence >= CONF_T);
    if (!good.length) return fail;
    const periods = good.map((g) => g.period).sort((a, b) => a - b);
    const confs = good.map((g) => g.confidence).sort((a, b) => a - b);
    const p0 = periods[periods.length >> 1];      // median period (px) across the 5 spots
    const confidence = confs[confs.length >> 1];  // median confidence

    // --- Sub-pixel period + per-axis phase on the FULL image so the grid fits
    // edge-to-edge instead of drifting toward the corners. The search is a
    // narrow band around the voted period (so it can't slip to a harmonic) and
    // picks the period whose comb best lands on real lines across the span. ---
    const { col: fcol, row: frow } = buildProfiles(L, W, H);
    let meanC = 0; for (let i = 0; i < W; i++) meanC += fcol[i]; meanC /= W;
    let meanR = 0; for (let i = 0; i < H; i++) meanR += frow[i]; meanR /= H;
    let best = { p: p0, ox: 0, oy: 0, score: -Infinity };
    for (let pf = p0 - 1.5; pf <= p0 + 1.5 + 1e-9; pf += 0.1) {
      if (pf < pMin || pf > pMax) continue;
      const fx = fitAxis(fcol, W, pf, meanC);
      const fy = fitAxis(frow, H, pf, meanR);
      const score = fx.strength + fy.strength;
      if (score > best.score) best = { p: pf, ox: fx.offset, oy: fy.offset, score };
    }

    const period = best.p;
    return {
      cols: Math.max(1, Math.round(W / period)),
      rows: Math.max(1, Math.round(H / period)),
      detected: true, confidence,
      ax: { periodFrac: period / W, offsetFrac: best.ox / W },
      ay: { periodFrac: period / H, offsetFrac: best.oy / H },
    };
  }
  // exposed for tests / future modules
  window.GridmapDetect = { analyzeImageData, CONF_T };
  GM.detect = { analyze: analyzeImageData, CONF_T };
})(window.GM);

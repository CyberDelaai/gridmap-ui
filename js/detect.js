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

  // =====================================================================
  // HEX DETECTION (AUTO)
  // ---------------------------------------------------------------------
  // Square grids are separable per-axis; hex grids aren't, so we use a 2-D cue:
  //   1. a gradient-orientation histogram tells SQUARE (edge energy at 0°/90°)
  //      from HEX, and flat-top (extra energy at 60°/120°) from pointy-top
  //      (30°/150°). Grid lines cluster at these angles; map clutter spreads out.
  //   2. once orientation is known the size is a 1-D problem again: a regular
  //      hex grid has all 6 neighbours at distance g, and alternate columns/rows
  //      are offset half a hex, so the line-strength profile along the flats
  //      (rows for flat-top, cols for pointy-top) has FUNDAMENTAL spacing g/2 →
  //      g = 2·period. Reuses the same axisStats/acAt machinery as square.
  //   3. the 2-D origin (which hex the lattice starts on) is a coarse search of
  //      (ox,oy) that maximises how much grid-edge energy the lattice's vertices
  //      land on — also resolves the even/odd column-shift parity.
  // =====================================================================
  const HEX_DIAG_RATIO = 0.62;   // off-axis(diagonal) vs on-axis energy to call it HEX
  const HEX_CONF_T = 2.0;        // min size-autocorr peak z-score (std-devs above noise) to trust g

  // Per-pixel edge-direction histogram (⟂ to the gradient), magnitude-weighted,
  // NB bins over [0,180). Plus the gradient-magnitude map (reused for the origin).
  function gradData(L, W, H) {
    const NB = 36, hist = new Float32Array(NB), M = new Float32Array(W * H);
    // A rectangular FRAME around a map (very common — Roll20 exports, screenshots)
    // is one long horizontal + one long vertical line; its edge energy lands on
    // 0°/90° and can masquerade as a square grid. Skip a border margin when
    // building the orientation histogram so the frame can't sway the square-vs-hex
    // vote. (M, the magnitude map used for the origin search, is still full-frame.)
    const mX = Math.round(W * 0.06), mY = Math.round(H * 0.06);
    let total = 0;
    for (let y = 1; y < H - 1; y++) {
      const o = y * W, inY = y >= mY && y < H - mY;
      for (let x = 1; x < W - 1; x++) {
        const gx = L[o + x + 1] - L[o + x - 1], gy = L[o + x + W] - L[o + x - W];
        const mag = Math.hypot(gx, gy);
        M[o + x] = mag;
        if (mag < 8 || !inY || x < mX || x >= W - mX) continue;   // skip faint noise + the border frame
        let e = Math.atan2(gy, gx) + Math.PI / 2;      // edge dir = gradient + 90°
        e = ((e % Math.PI) + Math.PI) % Math.PI;
        let b = (e / Math.PI * NB) | 0; if (b >= NB) b = NB - 1;
        hist[b] += mag; total += mag;
      }
    }
    return { hist, total, NB, M };
  }
  // Mag-weighted energy within ±span° of angle A (deg), wrapped over 180°.
  function famEnergy(hist, NB, Adeg, span) {
    const per = 180 / NB; let sum = 0;
    for (let b = 0; b < NB; b++) {
      let d = Math.abs((b + 0.5) * per - Adeg) % 180; if (d > 90) d = 180 - d;
      if (d <= span) sum += hist[b];
    }
    return sum;
  }
  // SQUARE vs HEX (+ flat/pointy) from the orientation histogram.
  function classifyGrid(grad) {
    const { hist, total, NB } = grad;
    if (total <= 0) return { type: 'square', orient: 'flat', score: 0 };
    const span = 11;
    const E0 = famEnergy(hist, NB, 0, span), E90 = famEnergy(hist, NB, 90, span);
    const diagFlat = famEnergy(hist, NB, 60, span) + famEnergy(hist, NB, 120, span);
    const diagPointy = famEnergy(hist, NB, 30, span) + famEnergy(hist, NB, 150, span);
    const axis = E0 + E90 + 1e-6;
    const bestDiag = Math.max(diagFlat, diagPointy);
    const orient = diagFlat >= diagPointy ? 'flat' : 'pointy';
    return { type: bestDiag / axis >= HEX_DIAG_RATIO ? 'hex' : 'square', orient, score: bestDiag / axis };
  }
  // Coarse (ox,oy) origin: maximise grid-edge energy that the lattice's hex
  // vertices fall on. `p` flips the column/row shift parity. Result is converted
  // to the app's "odd index is the shifted one" convention.
  function hexOrigin(M, W, H, orient, g) {
    const R = g / Math.sqrt(3);
    const bw = orient === 'flat' ? 2 * R : g, bh = orient === 'flat' ? g : 2 * R;
    const dx = orient === 'flat' ? 0.75 * bw : bw, dy = orient === 'flat' ? bh : 0.75 * bh;
    const base = orient === 'flat' ? 0 : Math.PI / 6, verts = [];
    for (let i = 0; i < 6; i++) { const a = base + i * Math.PI / 3; verts.push([R * Math.cos(a), R * Math.sin(a)]); }
    const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return (xi >= 0 && yi >= 0 && xi < W && yi < H) ? M[yi * W + xi] : 0; };
    // Edge energy the lattice's vertices land on for a given origin + parity.
    const score = (ox, oy, p) => {
      let s = 0;
      for (let c = 0; ; c++) {
        const cx0 = ox + bw / 2 + c * dx; if (cx0 - bw > W) break;
        for (let r = 0; ; r++) {
          const sx = (orient === 'pointy' && ((r + p) & 1)) ? bw / 2 : 0;
          const sy = (orient === 'flat' && ((c + p) & 1)) ? bh / 2 : 0;
          const cx = cx0 + sx, cy = oy + bh / 2 + r * dy + sy;
          if (cy - bh > H) break;
          for (let v = 0; v < 6; v++) s += at(cx + verts[v][0], cy + verts[v][1]);
        }
      }
      return s;
    };
    // Coarse grid over one cell + parity, then a finer local refine for sub-px origin.
    const N = 12; let best = -1, bOx = 0, bOy = 0, bP = 0;
    for (let p = 0; p < 2; p++)
      for (let iy = 0; iy < N; iy++)
        for (let ix = 0; ix < N; ix++) {
          const s = score((ix / N) * dx, (iy / N) * dy, p);
          if (s > best) { best = s; bOx = (ix / N) * dx; bOy = (iy / N) * dy; bP = p; }
        }
    for (let pass = 0, stepX = dx / N, stepY = dy / N; pass < 2; pass++, stepX /= 4, stepY /= 4) {
      let dX = 0, dY = 0;
      for (let iy = -3; iy <= 3; iy++)
        for (let ix = -3; ix <= 3; ix++) {
          const s = score(bOx + ix * stepX, bOy + iy * stepY, bP);
          if (s > best) { best = s; dX = ix * stepX; dY = iy * stepY; }
        }
      bOx += dX; bOy += dY;
    }
    if (bP === 1) { if (orient === 'flat') bOx += dx; else bOy += dy; }
    return { ox: bOx, oy: bOy };
  }
  // Fundamental period of a 1-D line-strength profile along the hex flats →
  // g = 2·period. The period is the strongest LOCAL maximum of the
  // autocorrelation — taking the global max would lock onto the monotonic decay
  // near lag 0 (a spurious peak at the smallest lag). Confidence is the peak's
  // PROMINENCE (z-score) over the autocorrelation noise floor, so faint,
  // low-contrast grids (Roll20 exports) still pass. Shared by the full-image and
  // per-region (SELECT / RANDOM) hex sizers.
  function hexProfilePeriod(prof, len) {
    const st = axisStats(prof, len);
    const Pmin = 5, Pmax = Math.floor(len / 4);
    if (st.v0 <= 0 || Pmax < Pmin) return { period: 0, confidence: 0 };
    const acn = (lag) => acAt(st.s, len, lag) / st.v0;
    // strongest local maximum (skips the lag-0 decay tail that fools a global max)
    let P = 0, best = -Infinity, sum = 0, sum2 = 0, n = 0;
    for (let lag = Pmin; lag <= Pmax; lag++) {
      const a = acn(lag); sum += a; sum2 += a * a; n++;
      if (a >= acn(lag - 1) && a >= acn(lag + 1) && a > best) { best = a; P = lag; }
    }
    if (P === 0) return { period: 0, confidence: 0 };
    // step down to the true fundamental (g/2) when the half is also a real peak
    for (let k = 0; k < 3; k++) {
      const h = Math.round(P / 2);
      if (h < Pmin) break;
      if (acn(h) >= acn(h - 1) && acn(h) >= acn(h + 1) && acn(h) >= 0.6 * acn(P)) P = h; else break;
    }
    // confidence = z-score: how many std-devs the period peak stands above the
    // autocorrelation noise floor.
    const mean = sum / n, std = Math.sqrt(Math.max(1e-12, sum2 / n - mean * mean));
    return { period: P, confidence: (acn(P) - mean) / std };
  }

  // Hex size (g) + origin for a known orientation, sized from the WHOLE image:
  // g = 2× the fundamental period of the line-strength profile along the flats;
  // phase/parity from hexOrigin.
  function detectHexSize(L, W, H, orient, M) {
    const { col, row } = buildProfiles(L, W, H);
    const prof = orient === 'flat' ? row : col, len = orient === 'flat' ? H : W;
    const { period, confidence } = hexProfilePeriod(prof, len);
    if (period === 0) return { detected: false, confidence: 0 };
    const g = 2 * period;
    const { ox, oy } = hexOrigin(M, W, H, orient, g);
    return { detected: true, confidence, gFrac: g / W, oxFrac: ox / W, oyFrac: oy / H };
  }

  // Hex size from user-picked region(s) — the SELECT / RANDOM tools in hex mode.
  // Each region votes a period (sized within its own window); the median is
  // robust to a stray region that landed on labels or blank margins (exactly the
  // square region path's logic). The lattice origin is still searched on the full
  // image so the grid spans edge-to-edge regardless of where the patch sat.
  function detectHexSizeRegions(L, W, H, orient, M, regions) {
    const good = regions
      .map((r) => {
        const x0 = Math.max(0, Math.min(W - 1, Math.round(r.x)));
        const y0 = Math.max(0, Math.min(H - 1, Math.round(r.y)));
        const rw = Math.max(1, Math.min(W - x0, Math.round(r.w)));
        const rh = Math.max(1, Math.min(H - y0, Math.round(r.h)));
        const { col, row } = regionProfiles(L, W, x0, y0, rw, rh);
        const prof = orient === 'flat' ? row : col, len = orient === 'flat' ? rh : rw;
        return hexProfilePeriod(prof, len);
      })
      .filter((p) => p.period > 0 && p.confidence >= HEX_CONF_T);
    if (!good.length) return { detected: false, confidence: 0 };
    const periods = good.map((p) => p.period).sort((a, b) => a - b);
    const confs = good.map((p) => p.confidence).sort((a, b) => a - b);
    const g = 2 * periods[periods.length >> 1];
    const { ox, oy } = hexOrigin(M, W, H, orient, g);
    return { detected: true, confidence: confs[confs.length >> 1], gFrac: g / W, oxFrac: ox / W, oyFrac: oy / H };
  }

  function analyzeImageData(img, regions, opts) {
    const { data, width: W, height: H } = img;
    const L = toLuma(data, W, H);
    // --- HEX path: full-image AUTO, a forced-hex override, or a hex-size seed
    // (opts.hexG, the "3 HEXES" tool). The square region/seed calls (SELECT /
    // RANDOM / 4-CELLS via opts.period) stay square — they size square cells. ---
    const force = opts && opts.force;
    const fullImage = !(regions && regions.length) && !(opts && opts.period > 0);
    if (force === 'hex' || (fullImage && force !== 'square')) {
      const grad = gradData(L, W, H);
      // HEX SIZE seed (the "3 HEXES" tool): g is supplied by the caller (measured
      // from a 3-hex cluster), so skip the period search — only the lattice
      // origin/parity is searched from the image. Orientation comes from opts (the
      // user's flat/pointy choice), falling back to the gradient classifier.
      if (force === 'hex' && opts && opts.hexG > 0) {
        const orient = (opts.orient === 'flat' || opts.orient === 'pointy') ? opts.orient : classifyGrid(grad).orient;
        const g = opts.hexG;
        const { ox, oy } = hexOrigin(grad.M, W, H, orient, g);
        return { gridType: 'hex', orient, detected: true, confidence: 1,
                 hex: { gFrac: g / W, oxFrac: ox / W, oyFrac: oy / H } };
      }
      const cls = classifyGrid(grad);
      if (force === 'hex' || cls.type === 'hex') {
        // Orientation: the user's flat/pointy choice (forced hex from the app) wins
        // over the gradient classifier, mirroring the "3 HEXES" seed path.
        const orient = (opts && (opts.orient === 'flat' || opts.orient === 'pointy')) ? opts.orient : cls.orient;
        // Region picks (SELECT / RANDOM in hex mode) size from the chosen area(s);
        // otherwise size from the whole image.
        const hx = (regions && regions.length)
          ? detectHexSizeRegions(L, W, H, orient, grad.M, regions)
          : detectHexSize(L, W, H, orient, grad.M);
        if (hx.detected && hx.confidence >= HEX_CONF_T) {
          return { gridType: 'hex', orient, detected: true, confidence: hx.confidence,
                   hex: { gFrac: hx.gFrac, oxFrac: hx.oxFrac, oyFrac: hx.oyFrac } };
        }
        if (force === 'hex') return { gridType: 'hex', detected: false, confidence: hx.confidence };
        // auto-classified hex but weak signal → fall through to the square detector
      }
    }

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
      gridType: 'square', cols: 0, rows: 0, detected: false, confidence: 0,
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
      gridType: 'square',
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

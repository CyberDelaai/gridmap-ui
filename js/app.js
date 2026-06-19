(function (GM) {
  'use strict';
  const $ = GM.$;
  const t = GM.t;
  const IDB = GM.idb;
  const analyzeImageData = GM.detect.analyze;
  const { ANALYSIS_MAX, DISPLAY_MAX, DEFAULT_CELL_PX, SQRT3 } = GM.const;
  // ---- Working-area image import + analysis (drag-drop / paste / click) ----
  (function setupImport() {
    const zone = $('dropzone'), mapC = $('mapCanvas'), gridC = $('gridCanvas'), trimC = $('trimCanvas'),
      input = $('fileInput'), exportBtn = $('exportBtn'), copyBtn = $('copyBtn'), canvasWrap = $('canvasWrap');
    if (!zone || !mapC || !gridC || !input) return;
    const S = GM.state;

    // Run detection on a downscaled copy of loaded.image — over the whole image,
    // or only the user-picked region(s) — and write the result into loaded's
    // geometry. (loaded.image must already be set.)
    // pickRegions/seedCell drive the square detectors (SELECT / RANDOM / 4-CELLS).
    // force ('hex'|'square') overrides the full-image AUTO classification. Returns
    // res so callers can react (e.g. the toggle falling back to DRAW on miss).
    function detectGrid(pickRegions, seedCell, force, hexSeed) {
      const image = S.loaded.image, nW = image.naturalWidth, nH = image.naturalHeight;
      const aScale = Math.min(1, ANALYSIS_MAX / Math.max(nW, nH));
      const aW = Math.max(1, Math.round(nW * aScale)), aH = Math.max(1, Math.round(nH * aScale));
      const ac = document.createElement('canvas'); ac.width = aW; ac.height = aH;
      const actx = ac.getContext('2d', { willReadFrequently: true });
      actx.drawImage(image, 0, 0, aW, aH);
      const scaled = pickRegions && pickRegions.map((r) => ({ x: r.x * aScale, y: r.y * aScale, w: r.w * aScale, h: r.h * aScale }));
      // SELECT / RANDOM (region picks, no explicit force) follow the CURRENT grid
      // type: in hex mode they size the hex grid from the picked area(s); otherwise
      // they size square cells. An explicit `force` (AUTO toggle, 4-CELLS) still wins.
      const regionHex = pickRegions && !force && S.loaded.gridType === 'hex';
      const opts = { force: force || (regionHex ? 'hex' : (pickRegions || seedCell > 0 ? 'square' : undefined)) };
      if (regionHex) opts.orient = S.hexOrient;
      if (seedCell > 0) { opts.period = seedCell * aScale; opts.margin = 0.25; }   // cell-size hint (image px → analysis px)
      if (hexSeed && hexSeed.g > 0) { opts.force = 'hex'; opts.hexG = hexSeed.g * aScale; opts.orient = hexSeed.orient; }   // hex-size hint (the "3 HEXES" tool)
      const res = analyzeImageData(actx.getImageData(0, 0, aW, aH), scaled, opts);
      if (res.gridType === 'hex' && res.detected) {
        S.loaded.gridType = 'hex'; S.hexOrient = res.orient;
        S.loaded.hexG = res.hex.gFrac * nW;
        S.loaded.hexOX = res.hex.oxFrac * nW; S.loaded.hexOY = res.hex.oyFrac * nH;
        S.loaded.estimated = false;
        setHexWindow();   // default extent for the current EDGES MODE (crop/expand)
      } else if (res.detected) {
        S.loaded.gridType = 'square';
        S.loaded.cols = res.cols; S.loaded.rows = res.rows; S.loaded.estimated = false;
        S.loaded.vFrac = res.ax.periodFrac; S.loaded.vOff = res.ax.offsetFrac;
        S.loaded.hFrac = res.ay.periodFrac; S.loaded.hOff = res.ay.offsetFrac;
      } else {
        S.loaded.gridType = 'square';
        S.loaded.cols = Math.max(1, Math.round(nW / DEFAULT_CELL_PX));
        S.loaded.rows = Math.max(1, Math.round(nH / DEFAULT_CELL_PX));
        S.loaded.estimated = true;
        S.loaded.vFrac = 1 / S.loaded.cols; S.loaded.vOff = 0; S.loaded.hFrac = 1 / S.loaded.rows; S.loaded.hOff = 0;
      }
      S.loaded.confidence = res.confidence;
      S.loaded.drawn = false;   // an auto/select/random detection supersedes any drawn cell
      return res;
    }

    function onImage(image, restore) {
      const nW = image.naturalWidth, nH = image.naturalHeight;
      if (!nW || !nH) return;
      S.loaded = { image, cols: 1, rows: 1, vFrac: 1, vOff: 0, hFrac: 1, hOff: 0, estimated: true, confidence: 0 };
      // Fresh import → AUTO classifies square vs hex. Restore → force the saved
      // type so the base geometry matches what restoreManual() reinstates.
      const savedType = restore ? localStorage.getItem('gridmap:gridType') : null;
      detectGrid(null, 0, restore ? (savedType === 'hex' ? 'hex' : 'square') : undefined);
      S.autoFill = edgeColor(image);     // detected primary colour for the fill swatch
      S.drawMode = false; zone.classList.remove('drawing');   // never load straight into draw mode
      if (restore) {                   // reload of the saved map → restore the saved settings
        restoreManual();
        if (S.drawnCell && localStorage.getItem('gridmap:drawn') === '1') applyDrawnCell();   // re-tile the saved drawn cell
        syncToggles(); refreshFill(); syncFillMode();
      } else {                         // fresh import → detected defaults + smart fix-edges
        S.manual = false; S.drawnCell = null; S.gCols = S.loaded.cols; S.gRows = S.loaded.rows; S.offX = 0; S.offY = 0;
        applyAutoFix();                // smart fix-edges default (+ syncToggles + refreshFill)
      }
      syncAutoMode();
      zone.classList.add('has-image');
      zone.classList.remove('grid-on');  // grid hidden by default; canvas click toggles it (hover previews)
      S.panX = S.panY = 0;                   // start centred (clears any pan from a previous map)
      if (exportBtn) exportBtn.disabled = false;
      if (copyBtn) copyBtn.disabled = false;
      renderDisplay();
      requestAnimationFrame(applyZoom);   // re-apply persisted zoom once layout has settled
    }

    // persist !== false → a fresh user import, so save it to IndexedDB.
    // (Restoring a saved map passes persist=false to avoid a redundant write.)
    function load(blob, persist) {
      if (!blob || !(blob.type || '').startsWith('image/')) return;
      if (persist !== false) IDB.put(blob).catch(() => {});
      const url = URL.createObjectURL(blob);
      const image = new Image();
      const restore = persist === false;
      image.onload = () => { URL.revokeObjectURL(url); onImage(image, restore); };
      image.src = url;
    }

    const importBtn = $('importBtn');
    if (importBtn) importBtn.addEventListener('click', () => input.click());
    const ZOOM_CLICK_STEP = 25;   // Ctrl+LMB / Ctrl+RMB zoom step (centred), in %
    zone.addEventListener('click', (e) => {
      if (S.selecting || S.drawMode || S.blockZoneClick) return;
      if (!S.loaded) { input.click(); return; }                                   // empty zone → browse for an image
      if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, ZOOM_CLICK_STEP); return; }   // Ctrl+LMB → zoom in (toward cursor)
      zone.classList.toggle('grid-on');                                         // plain LMB → toggle the detected grid
    });
    zone.addEventListener('contextmenu', (e) => {
      if (S.selecting || !S.loaded || !(e.ctrlKey || e.metaKey)) return;            // plain right-click → normal menu
      e.preventDefault();                                                       // Ctrl+RMB → zoom out (toward cursor)
      zoomAt(e.clientX, e.clientY, -ZOOM_CLICK_STEP);
    });
    input.addEventListener('change', (e) => load(e.target.files[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) load(e.dataTransfer.files[0]);
    });
    window.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData.items || [])].find((i) => i.type.startsWith('image/'));
      if (item) load(item.getAsFile());
    });

    // ---- Export settings: edge-fix toggles + fill colour (all persisted) ----
    const modeToggle = $('modeToggle'),
      fillRow = $('fillRow'), fillSwatch = $('fillSwatch'), fillVibrant = $('fillVibrant'),
      fillTransparent = $('fillTransparent'), fillColor = $('fillColor');
    const nightToggle = $('nightToggle'), nightColorRow = $('nightColorRow'), nightSwatch = $('nightSwatch'), nightInput = $('nightInput'),
      potencyRow = $('potencyRow'), nightPotencySlider = $('nightPotency');
    const scaleSel = $('scaleSel'), scaleCustomRow = $('scaleCustomRow'), scaleCustom = $('scaleCustom'), algoSel = $('algoSel');
    const gridTypeSel = $('gridTypeSel');
    // The GRID TYPE control is a custom dropdown (so HEX options can carry an SVG
    // glyph). Make it quack like a <select>: a .value getter/setter that re-renders
    // the collapsed label, plus a 'change' event fired only on a real user pick.
    if (gridTypeSel && gridTypeSel.querySelector) {
      const current = gridTypeSel.querySelector('.gridtype-current');
      const opts = Array.from(gridTypeSel.querySelectorAll('.gridtype-opt'));
      let ddValue = 'square';
      const renderCurrent = () => {
        const li = opts.find((o) => o.dataset.value === ddValue) || opts[0];
        current.innerHTML = li.innerHTML;                       // mirror option (label + icon)
        opts.forEach((o) => o.classList.toggle('sel', o === li));
      };
      const open = (o) => gridTypeSel.classList.toggle('open', o);
      const pick = (v) => {                                     // user choice → fire change
        if (v === ddValue) return;
        ddValue = v; renderCurrent(); gridTypeSel.dispatchEvent(new Event('change'));
      };
      Object.defineProperty(gridTypeSel, 'value', {
        get() { return ddValue; },
        set(v) { ddValue = v; renderCurrent(); },              // silent sync (no change event)
      });
      gridTypeSel.addEventListener('click', (e) => {
        const li = e.target.closest('.gridtype-opt');
        if (li) { open(false); pick(li.dataset.value); }
        else open(!gridTypeSel.classList.contains('open'));
      });
      gridTypeSel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(!gridTypeSel.classList.contains('open')); }
        else if (e.key === 'Escape') open(false);
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const i = Math.max(0, opts.findIndex((o) => o.dataset.value === ddValue));
          const ni = Math.min(opts.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
          pick(opts[ni].dataset.value);
        }
      });
      document.addEventListener('click', (e) => { if (!gridTypeSel.contains(e.target)) open(false); });
      const langSel = $('uiLangSel');                           // keep collapsed label translated
      if (langSel) langSel.addEventListener('change', renderCurrent);
      renderCurrent();
    }
    const autoBtn = $('autoBtn'), selectBtn = $('selectBtn'), randomBtn = $('randomBtn'), cellBtn = $('cellBtn'), drawBtn = $('drawBtn'),
      drawCoordsWrap = $('drawCoordsWrap'), drawCoords = $('drawCoords'), cellX = $('cellX'), cellY = $('cellY'), cellSize = $('cellSize'),
      colVal = $('colVal'), rowVal = $('rowVal'), calcSize = $('calcSize'), calcVal = $('calcVal'), outVal = $('outVal');
    const fixEdges = true;   // edge-fixing is always on (toggle removed)
    try {
      if (localStorage.getItem('gridmap:edgeMode') === 'expand') S.edgeMode = 'expand';
      const fm = localStorage.getItem('gridmap:fillMode'); if (fm === 'solid' || fm === 'transparent') S.fillMode = fm;
      S.fillOverride = toHex(localStorage.getItem('gridmap:fillColor') || '');
      const z = parseInt(localStorage.getItem('gridmap:zoom'), 10);
      if (Number.isFinite(z)) S.zoom = Math.min(300, Math.max(10, z));
      S.nightMode = localStorage.getItem('gridmap:nightMode') === '1';
      const nc = toHex(localStorage.getItem('gridmap:nightColor') || ''); if (nc) S.nightColor = nc;
      const npp = parseInt(localStorage.getItem('gridmap:nightPotency'), 10);
      if (Number.isFinite(npp)) S.nightPotency = Math.min(1, Math.max(0, npp / 100));
      const ecp = parseInt(localStorage.getItem('gridmap:exportCellPx'), 10);
      if (Number.isFinite(ecp) && ecp > 0) S.exportCellPx = Math.min(2000, ecp);
      S.exportCustom = S.exportCellPx > 0 && (localStorage.getItem('gridmap:exportCustom') === '1' || ![70, 100, 150].includes(S.exportCellPx));
      const sa = localStorage.getItem('gridmap:scaleAlgo'); if (sa === 'nearest' || sa === 'sharp' || sa === 'smooth') S.scaleAlgo = sa;
      const ho = localStorage.getItem('gridmap:hexOrient'); if (ho === 'flat' || ho === 'pointy') S.hexOrient = ho;
    } catch (e) { /* storage blocked */ }
    const save = GM.save;

    // Average colour of the image's border ring (hex) — the detected "primary".
    function edgeColor(image) {
      const s = 48, c = document.createElement('canvas'); c.width = s; c.height = s;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(image, 0, 0, s, s);
      const d = x.getImageData(0, 0, s, s).data;
      let r = 0, g = 0, b = 0, n = 0;
      const add = (px, py) => { const i = (py * s + px) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; };
      for (let i = 0; i < s; i++) { add(i, 0); add(i, s - 1); add(0, i); add(s - 1, i); }
      const h = (v) => ('0' + Math.round(v / n).toString(16)).slice(-2);
      return '#' + h(r) + h(g) + h(b);
    }

    // Normalise any colour (#rgb, #rrggbb[aa], rgb()/rgba()) to an OPAQUE
    // #rrggbb. The EyeDropper can hand back "rgba(r,g,b,0)" (notably on file://
    // origins), which is invalid for <input type=color> and would also make the
    // fill transparent — so we drop alpha and force hex.
    function toHex(col) {
      if (!col) return '';
      col = String(col).trim();
      if (col[0] === '#') {
        if (col.length === 4) return '#' + col[1] + col[1] + col[2] + col[2] + col[3] + col[3];
        return col.slice(0, 7);
      }
      const m = col.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
      if (m) { const h = (v) => ('0' + (+v).toString(16)).slice(-2); return '#' + h(m[1]) + h(m[2]) + h(m[3]); }
      return '';
    }

    // Effective fill for EXPAND: the user's override, else the detected primary.
    function fillValue() { return S.fillOverride || S.autoFill; }
    // White palette icon, switching to black on bright swatch colours so it stays readable.
    function iconContrast(hex) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const L = 0.299 * r + 0.587 * g + 0.114 * b;        // swatch luminance (0..255)
      return L > 120 ? '#000000' : '#ffffff';
    }
    function refreshFill() {
      const v = toHex(fillValue()) || '#808080';
      if (fillSwatch) { fillSwatch.style.background = v; fillSwatch.style.color = iconContrast(v); }
      if (fillColor) fillColor.value = v;
    }

    function syncToggles() {
      if (modeToggle) modeToggle.dataset.pos = S.edgeMode === 'expand' ? 'right' : 'left';
      // the fill is used by EXPAND, by the MANUAL window's off-image area, and by a
      // hex window that pokes off the image (the EXPAND default or an extend-drag)
      if (fillRow) fillRow.classList.toggle('disabled', !(S.manual || S.edgeMode === 'expand' || hexWindowOffImage()));
    }
    if (modeToggle) modeToggle.addEventListener('click', () => {
      S.edgeMode = S.edgeMode === 'expand' ? 'crop' : 'expand'; save('gridmap:edgeMode', S.edgeMode);
      // hex re-applies the crop/expand default window (square recomputes in computeLayout)
      if (S.loaded && S.loaded.gridType === 'hex' && S.loaded.hexG > 0) setHexWindow();
      syncToggles(); renderDisplay();
    });
    function setFill(color) {
      const hex = toHex(color);
      if (!hex) return;
      S.fillOverride = hex; save('gridmap:fillColor', hex); refreshFill(); renderDisplay();
    }
    // Fill-mode selector: the radial-gradient button = VIBRANT (extend the
    // nearest edge into the padding); the colour swatch = SOLID. Active = bright border.
    function syncFillMode() {
      if (fillSwatch) fillSwatch.classList.toggle('active', S.fillMode === 'solid');
      if (fillVibrant) fillVibrant.classList.toggle('active', S.fillMode === 'vibrant');
      if (fillTransparent) fillTransparent.classList.toggle('active', S.fillMode === 'transparent');
    }
    if (fillVibrant) fillVibrant.addEventListener('click', () => {
      S.fillMode = 'vibrant'; save('gridmap:fillMode', 'vibrant'); syncFillMode(); renderDisplay();
    });
    if (fillTransparent) fillTransparent.addEventListener('click', () => {
      S.fillMode = 'transparent'; save('gridmap:fillMode', 'transparent'); syncFillMode(); renderDisplay();
    });
    // The swatch selects SOLID mode and opens the native colour-picker palette
    // (which also offers an eyedropper button on most browsers).
    if (fillSwatch) fillSwatch.addEventListener('click', () => {
      S.fillMode = 'solid'; save('gridmap:fillMode', 'solid'); syncFillMode(); renderDisplay();
      try { if (fillColor && fillColor.showPicker) { fillColor.showPicker(); return; } } catch (e) {}
      if (fillColor) fillColor.click();
    });
    ['input', 'change'].forEach((ev) => fillColor && fillColor.addEventListener(ev, () => setFill(fillColor.value)));

    // ---- EFFECTS → NIGHT MODE: a colour tint (multiply) baked into the preview
    // AND the exported PNG. Toggle on/off; the TINT swatch picks the colour. ----
    function refreshNight() {
      if (nightSwatch) nightSwatch.style.background = S.nightColor;
      if (nightInput) nightInput.value = S.nightColor;
      if (nightPotencySlider) nightPotencySlider.value = Math.round(S.nightPotency * 100);
    }
    function syncEffects() {
      if (nightToggle) nightToggle.dataset.pos = S.nightMode ? 'right' : 'left';
      if (nightColorRow) nightColorRow.classList.toggle('disabled', !S.nightMode);
      if (potencyRow) potencyRow.classList.toggle('disabled', !S.nightMode);
    }
    function setNightColor(color) {
      const hex = toHex(color); if (!hex) return;
      S.nightColor = hex; save('gridmap:nightColor', hex); refreshNight(); renderDisplay();
    }
    if (nightToggle) nightToggle.addEventListener('click', () => {
      S.nightMode = !S.nightMode; save('gridmap:nightMode', S.nightMode ? '1' : '0'); syncEffects(); renderDisplay();
    });
    if (nightSwatch) nightSwatch.addEventListener('click', () => {
      try { if (nightInput && nightInput.showPicker) { nightInput.showPicker(); return; } } catch (e) {}
      if (nightInput) nightInput.click();
    });
    ['input', 'change'].forEach((ev) => nightInput && nightInput.addEventListener(ev, () => setNightColor(nightInput.value)));
    if (nightPotencySlider) nightPotencySlider.addEventListener('input', () => {
      S.nightPotency = Math.min(1, Math.max(0, (parseInt(nightPotencySlider.value, 10) || 0) / 100));
      save('gridmap:nightPotency', Math.round(S.nightPotency * 100)); renderDisplay();
    });

    // ---- EXPORT → CELL SIZE: scale the exported PNG so each grid cell is
    // `exportCellPx` px (0 = original). The preset dropdown sets common VTT sizes;
    // CUSTOM… reveals a px field. Only the export + the readout change — the
    // on-screen preview stays native (zoom handles viewing). ----
    function syncScaleUI() {
      if (!scaleSel) return;
      scaleSel.value = S.exportCustom ? 'custom' : String(S.exportCellPx);
      if (scaleCustomRow) scaleCustomRow.hidden = !S.exportCustom;
      if (S.exportCustom && scaleCustom && document.activeElement !== scaleCustom) scaleCustom.value = S.exportCellPx || '';
      if (algoSel) algoSel.value = S.scaleAlgo;
    }
    function setExportCellPx(px) {
      S.exportCellPx = (Number.isFinite(px) && px > 0) ? Math.min(2000, px) : 0;
      save('gridmap:exportCellPx', S.exportCellPx);
      save('gridmap:exportCustom', S.exportCustom ? '1' : '0');
      if (S.loaded) renderDisplay();   // refresh the // RESULT SIZE px readout
    }
    if (scaleSel) scaleSel.addEventListener('change', () => {
      if (scaleSel.value === 'custom') {
        S.exportCustom = true;
        const n = parseInt(scaleCustom && scaleCustom.value, 10);
        setExportCellPx(Number.isFinite(n) && n > 0 ? n : (S.exportCellPx || 100));
      } else {
        S.exportCustom = false;
        setExportCellPx(parseInt(scaleSel.value, 10) || 0);
      }
      syncScaleUI();
      if (S.exportCustom && scaleCustom) scaleCustom.focus();
    });
    if (scaleCustom) scaleCustom.addEventListener('input', () => {
      S.exportCustom = true;
      setExportCellPx(parseInt(scaleCustom.value, 10));   // don't re-sync (would clobber the field mid-type)
    });
    if (algoSel) algoSel.addEventListener('change', () => {
      const v = algoSel.value;
      S.scaleAlgo = (v === 'nearest' || v === 'sharp') ? v : 'smooth';
      save('gridmap:scaleAlgo', S.scaleAlgo);
      // Affects only the (upscaled) export, not the downscaled on-screen preview;
      // no re-render needed — exportCanvas()/copy read scaleAlgo live.
    });

    // ---- AUTO | MANUAL grid mode ----
    // AUTO = the detected grid, with crop/expand handling edge cells. MANUAL =
    // a fixed-size canvas window (the detected whole-cell grid) that the
    // // CANVAS d-pad slides over the image one whole cell at a time — it may
    // run off the edges; image outside the window is greyed and trimmed away.
    function view() {
      const c = S.gCols || S.loaded.cols, r = S.gRows || S.loaded.rows;
      const vFrac = S.loaded.vFrac * S.loaded.cols / c, hFrac = S.loaded.hFrac * S.loaded.rows / r;
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const wrap = (o, f) => ((o % f) + f) % f;   // grid phase is periodic — keep it in [0, cell)
      return {
        cols: c, rows: r, vFrac, hFrac,
        vOff: wrap(S.loaded.vOff + S.offX / nW, vFrac),
        hOff: wrap(S.loaded.hOff + S.offY / nH, hFrac),
        estimated: S.loaded.estimated,
      };
    }
    function syncAutoMode() {
      // AUTO lit on the auto-detected grid; SELECT / 4-CELLS lit while picking; DRAW CELL lit while drawing
      if (autoBtn) autoBtn.classList.toggle('active', !S.manual && !S.selecting && !S.drawMode);
      if (selectBtn) selectBtn.classList.toggle('active', S.selecting && !S.cellMode);
      if (cellBtn) cellBtn.classList.toggle('active', S.selecting && S.cellMode);
      if (drawBtn) drawBtn.classList.toggle('active', S.drawMode);
      if (drawCoordsWrap) { drawCoordsWrap.classList.toggle('open', S.drawMode); drawCoordsWrap.inert = !S.drawMode; }   // slide the coord sub-panel open only while drawing
      if (S.drawMode) syncCoordInputs();
      syncGridTypeUI();   // keep the SQUARE/HEX + orientation switches in sync
      syncToggles();   // the FILL control is also usable in MANUAL (off-image fill)
    }
    // Re-apply the smart fix-edges default from the DETECTED grid — used on
    // import and when returning to AUTO (which resets everything).
    function applyAutoFix() {
      if (!S.loaded) return;
      // edge-fixing is always on; reset to the CROP default and the detected fill
      S.edgeMode = 'crop'; save('gridmap:edgeMode', 'crop');
      S.fillOverride = ''; try { localStorage.removeItem('gridmap:fillColor'); } catch (e) {}
      if (S.loaded.gridType === 'hex' && S.loaded.hexG > 0) setHexWindow();   // hex: crop window to match the reset mode
      syncToggles(); refreshFill();
    }
    // ---- // CANVAS d-pad ----
    // Plain click slides the window a cell; CTRL grows the canvas a cell on that
    // side (CTRL+SHIFT shrinks it); SHIFT reverses a plain move. The window is
    // held as grid-cell bounds [winC0,winC1) × [winR0,winR1) and may run off the
    // image. Icons reflect the held modifiers live.
    function cellGeom() {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight, v = view();
      return { nW, nH, cellW: v.vFrac * nW, cellH: v.hFrac * nH,
               baseX: v.vOff * nW, baseY: v.hOff * nH };
    }
    function initWindow() {                       // reset to the detected whole-cell extent
      const { nW, nH, cellW, cellH, baseX, baseY } = cellGeom();
      S.winC0 = 0; S.winR0 = 0;
      S.winC1 = Math.max(1, Math.floor((nW - baseX) / cellW + 1e-6));
      S.winR1 = Math.max(1, Math.floor((nH - baseY) / cellH + 1e-6));
    }
    function setManual() { if (S.loaded && !S.manual) { S.manual = true; initWindow(); } }
    // persist / restore the per-image MANUAL state (mode, factor, offset, window)
    function saveManual() {
      save('gridmap:manual', S.manual ? '1' : '0');
      save('gridmap:gCols', S.gCols); save('gridmap:gRows', S.gRows);
      save('gridmap:offX', S.offX); save('gridmap:offY', S.offY);
      save('gridmap:winC0', S.winC0); save('gridmap:winR0', S.winR0);
      save('gridmap:winC1', S.winC1); save('gridmap:winR1', S.winR1);
      save('gridmap:drawn', (S.loaded && S.loaded.drawn) ? '1' : '0');
      try { localStorage.setItem('gridmap:drawnCell', S.drawnCell ? JSON.stringify(S.drawnCell) : ''); } catch (e) {}
      // GRID TYPE + hex geometry
      save('gridmap:gridType', S.loaded ? S.loaded.gridType : S.gridType);
      save('gridmap:hexOrient', S.hexOrient);
      if (S.loaded && S.loaded.gridType === 'hex') {
        save('gridmap:hexG', S.loaded.hexG); save('gridmap:hexOX', S.loaded.hexOX); save('gridmap:hexOY', S.loaded.hexOY);
      }
    }
    function restoreManual() {
      const gi = (k, d) => { const n = parseInt(localStorage.getItem(k), 10); return Number.isFinite(n) ? n : d; };
      const gf = (k, d) => { const n = parseFloat(localStorage.getItem(k)); return Number.isFinite(n) ? n : d; };
      try {
        S.manual = localStorage.getItem('gridmap:manual') === '1';
        S.gCols = gi('gridmap:gCols', S.loaded.cols); S.gRows = gi('gridmap:gRows', S.loaded.rows);
        S.offX = gf('gridmap:offX', 0); S.offY = gf('gridmap:offY', 0);
        // parseFloat (not parseInt): hex windows may carry ½-hex bounds on the
        // staggered axis. Square windows are whole, so floats round-trip harmlessly.
        S.winC0 = gf('gridmap:winC0', 0); S.winR0 = gf('gridmap:winR0', 0);
        S.winC1 = gf('gridmap:winC1', S.gCols); S.winR1 = gf('gridmap:winR1', S.gRows);
        const dc = JSON.parse(localStorage.getItem('gridmap:drawnCell') || 'null');
        S.drawnCell = (dc && dc.w > 0 && dc.h > 0) ? dc : null;
        // GRID TYPE + hex geometry (default square keeps the detector pipeline)
        const ho = localStorage.getItem('gridmap:hexOrient'); if (ho === 'flat' || ho === 'pointy') S.hexOrient = ho;
        if (localStorage.getItem('gridmap:gridType') === 'hex') {
          S.loaded.gridType = 'hex';
          S.loaded.hexG = gf('gridmap:hexG', 0); S.loaded.hexOX = gf('gridmap:hexOX', 0); S.loaded.hexOY = gf('gridmap:hexOY', 0);
          // restore the saved hex window (its counts drive the readout); if the
          // saved bounds aren't a valid hex window, default to covering the image
          if (S.loaded.hexG > 0 && S.winC1 > S.winC0 && S.winR1 > S.winR0 && localStorage.getItem('gridmap:winC1') !== null) {
            S.loaded.cols = Math.round(S.winC1 - S.winC0); S.loaded.rows = Math.round(S.winR1 - S.winR0);
          } else if (S.loaded.hexG > 0) {
            setHexWindow();
          }
        } else {
          S.loaded.gridType = 'square';
        }
      } catch (e) { S.manual = false; S.gCols = S.loaded.cols; S.gRows = S.loaded.rows; S.offX = 0; S.offY = 0; S.drawnCell = null; }
    }
    // AUTO button: re-run the default 5-point detection and return to the auto
    // grid. The square↔hex classification is decided ONCE — at first load and by
    // the manual GRID TYPE toggle — so AUTO re-detects WITHIN the current type and
    // never re-classifies (it can't flip a map the user pinned). A forced-hex
    // detection that comes back unsure falls back to manual DRAW, like the toggle.
    function runAuto() {
      if (!S.loaded) return;
      S.selecting = false; S.cellMode = false; S.regions = []; S.dragStart = null; S.dragRect = null;   // leave region-pick
      S.drawMode = false; S.cellDrag = null; S.drawnCell = null; zone.classList.remove('selecting', 'drawing');   // leave draw-cell
      const type = S.loaded.gridType;
      const res = detectGrid(null, 0, type);        // default quincunx (5-point) detection, locked to the current type
      if (type === 'hex' && !(res.gridType === 'hex' && res.detected)) {
        S.loaded.gridType = 'hex'; enterDraw();     // hex detection unsure → draw it by hand
      } else {
        S.manual = false; S.offX = 0; S.offY = 0;
        S.gCols = S.loaded.cols; S.gRows = S.loaded.rows;
        applyAutoFix();
      }
      syncAutoMode(); renderDisplay();
    }
    if (autoBtn) autoBtn.addEventListener('click', runAuto);
    // RANDOM 3: detect from 3 randomly-placed square probe areas (each ~half the
    // short side). Each click re-rolls — handy when AUTO's fixed 5-point layout
    // lands on labels/legends/blank margins instead of the grid.
    function randomRegions(n) {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const minDim = Math.min(nW, nH), out = [];
      for (let i = 0; i < n; i++) {
        const side = Math.round(minDim * (0.4 + Math.random() * 0.2));   // 40–60% of the short side
        const w = Math.min(side, nW), h = Math.min(side, nH);
        out.push({ x: Math.round(Math.random() * (nW - w)), y: Math.round(Math.random() * (nH - h)), w: w, h: h });
      }
      return out;
    }
    function runRandom() {
      if (!S.loaded) return;
      S.selecting = false; S.cellMode = false; S.regions = []; S.dragStart = null; S.dragRect = null;   // leave region-pick
      S.drawMode = false; S.cellDrag = null; S.drawnCell = null; zone.classList.remove('selecting', 'drawing');   // leave draw-cell
      detectGrid(randomRegions(3));
      S.manual = false; S.offX = 0; S.offY = 0;
      S.gCols = S.loaded.cols; S.gRows = S.loaded.rows;
      applyAutoFix();
      syncAutoMode(); renderDisplay();
    }
    if (randomBtn) randomBtn.addEventListener('click', runRandom);

    // ---- DRAW CELL: define the grid from ONE user-drawn cell, tiled in all
    // directions. Unlike the detectors this is fully manual. Cells are kept
    // SQUARE (in image px); the cell stays adjustable: drag its interior to move
    // the grid, an edge or corner to resize it, and the grid re-tiles live. The
    // resulting geometry is written into `loaded` in the SAME shape the detectors
    // produce, so crop/expand, fill, night-tint, the readout, and PNG export all
    // just work.
    const MIN_DRAW_CELL = 8;      // smallest cell side we'll accept (image px)
    const MAX_DRAW_LINES = 400;   // cap cells/side so a tiny cell can't spawn a runaway grid
    // Enforce a SQUARE cell (and the min / runaway-grid bound): the side is the
    // larger of the two dimensions, so resizing one axis squares up the other.
    function clampDrawnCell(c) {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const min = Math.max(MIN_DRAW_CELL, Math.max(nW, nH) / MAX_DRAW_LINES);
      if (S.loaded.gridType === 'hex') {
        // HEX: the bbox follows the orientation's aspect ratio; g (flat-to-flat)
        // is the one free dimension. A square-ish drag (w≈h) seeds g = the side.
        const g = Math.max(min, Number.isFinite(c.g) ? c.g : Math.max(c.w, c.h));
        const bb = hexBBox(g, S.hexOrient);
        return { x: c.x, y: c.y, w: bb.w, h: bb.h, g: g };
      }
      const side = Math.max(min, c.w, c.h);
      c.w = side; c.h = side;
      return c;
    }
    function applyDrawnCell() {
      if (!S.loaded || !S.drawnCell) return;
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      if (S.loaded.gridType === 'hex') {
        // HEX: the drawn cell IS the hex — origin at its bbox top-left, g from its
        // bbox. Counts come from hexLayout. Written in the same loaded.cols/rows
        // shape the rest of the app reads, so the readout + export just work.
        const g = S.drawnCell.g || hexGFromBBox(S.drawnCell, S.hexOrient);
        S.loaded.hexG = g; S.loaded.hexOX = S.drawnCell.x; S.loaded.hexOY = S.drawnCell.y;
        S.loaded.estimated = false; S.loaded.confidence = 1; S.loaded.drawn = true;
        S.manual = false; S.offX = 0; S.offY = 0;
        setHexWindow();   // tile to the current EDGES MODE default (crop/expand), resizable after
        return;
      }
      const cellW = S.drawnCell.w, cellH = S.drawnCell.h;
      const wrap = (o, f) => ((o % f) + f) % f;   // grid phase is periodic — keep it in [0, cell)
      S.loaded.cols = Math.max(1, Math.round(nW / cellW));
      S.loaded.rows = Math.max(1, Math.round(nH / cellH));
      S.loaded.vFrac = cellW / nW; S.loaded.hFrac = cellH / nH;
      S.loaded.vOff = wrap(S.drawnCell.x / nW, S.loaded.vFrac);   // line through the cell's left edge, tiled
      S.loaded.hOff = wrap(S.drawnCell.y / nH, S.loaded.hFrac);   // …and its top edge
      S.loaded.estimated = false; S.loaded.confidence = 1; S.loaded.drawn = true;
      S.manual = false; S.offX = 0; S.offY = 0;
      S.gCols = S.loaded.cols; S.gRows = S.loaded.rows;
    }
    function enterDraw() {
      if (!S.loaded) return;
      S.selecting = false; S.cellMode = false; S.regions = []; S.dragStart = null; S.dragRect = null;   // leave region-pick
      zone.classList.remove('selecting');
      S.drawMode = true; S.cellDrag = null;
      zone.classList.add('drawing');
      zone.classList.remove('grid-on');
      syncAutoMode(); renderDisplay();
    }
    function exitDraw() {                          // keep the tiled grid; return to the normal view
      S.drawMode = false; S.cellDrag = null;
      zone.classList.remove('drawing');
      syncAutoMode(); renderDisplay();
    }
    if (drawBtn) drawBtn.addEventListener('click', () => { if (!S.loaded) return; S.drawMode ? exitDraw() : enterDraw(); });

    // ---- GRID TYPE (SQUARE | HEX) + hex ORIENTATION (FLAT | POINTY) ----
    // AUTO classifies the type; this toggle is a manual OVERRIDE that re-runs the
    // detector forced to the chosen type. Forcing HEX falls back to manual DRAW
    // when detection isn't confident. The switches reflect the loaded image's
    // current type and persist as the UI preference.
    function syncGridTypeUI() {
      const type = S.loaded ? S.loaded.gridType : S.gridType;
      if (gridTypeSel) gridTypeSel.value = type === 'hex' ? (S.hexOrient === 'flat' ? 'hex-h' : 'hex-v') : 'square';
      // The "4 CELLS" seed tool reads "# HEXES" in hex mode. Swap the data-i18n keys
      // (so a later language change keeps the right label) and apply them now.
      if (cellBtn) {
        const lblKey = type === 'hex' ? 'b_cells_hex' : 'b_cells';
        const titKey = type === 'hex' ? 't_cells_hex' : 't_cells';
        const lbl = cellBtn.querySelector('.cell-btn-label');
        if (lbl) { lbl.setAttribute('data-i18n', lblKey); lbl.textContent = GM.t(lblKey); }
        cellBtn.setAttribute('data-i18n-title', titKey);
        cellBtn.title = GM.t(titKey);
        cellBtn.classList.toggle('is-hex', type === 'hex');   // square ↔ hex glyph
      }
    }
    function leaveModes() {   // exit any region-pick / draw sub-mode before re-detecting
      S.selecting = false; S.cellMode = false; S.regions = []; S.dragStart = null; S.dragRect = null;
      S.drawMode = false; S.cellDrag = null; zone.classList.remove('selecting', 'drawing');
    }
    function setGridType(type) {
      S.gridType = type; save('gridmap:gridType', type);
      if (!S.loaded) { syncGridTypeUI(); return; }
      if (type === 'hex') {
        leaveModes();
        const res = detectGrid(null, 0, 'hex');     // force a hex detection attempt
        if (res.gridType === 'hex' && res.detected) {
          S.manual = false; S.offX = 0; S.offY = 0; S.drawnCell = null;
          S.gCols = S.loaded.cols; S.gRows = S.loaded.rows;
          applyAutoFix();
        } else {
          S.loaded.gridType = 'hex'; S.drawnCell = null;   // detection unsure → draw it by hand
          enterDraw();
        }
      } else {
        leaveModes();
        S.drawnCell = null;
        detectGrid(null, 0, 'square');               // force the square detector
        S.manual = false; S.offX = 0; S.offY = 0;
        S.gCols = S.loaded.cols; S.gRows = S.loaded.rows;
        applyAutoFix();
      }
      syncAutoMode(); renderDisplay();
    }
    function setHexOrient(o) {
      S.hexOrient = o; save('gridmap:hexOrient', o);
      if (S.loaded && S.loaded.gridType === 'hex' && S.drawnCell) {
        const g = S.drawnCell.g || hexGFromBBox(S.drawnCell, o);
        S.drawnCell = clampDrawnCell({ x: S.drawnCell.x, y: S.drawnCell.y, g: g });   // reshape bbox to the new orientation
        applyDrawnCell();
      } else if (S.loaded && S.loaded.gridType === 'hex' && S.loaded.hexG > 0) {
        setHexWindow();   // re-derive the window for the new staggered axis (the ½-hex
                          // bound must follow the orientation, else it strands on a whole axis)
      }
      syncGridTypeUI();
      if (S.loaded) renderDisplay();
    }
    // Unified SQUARE | HEX (H) | HEX (V) dropdown: HEX (H) = flat-top columns,
    // HEX (V) = pointy-top rows. Switching to a hex variant forces that
    // orientation rather than letting detection re-pick it.
    function setGridChoice(choice) {
      if (choice === 'square') { setGridType('square'); return; }
      const orient = choice === 'hex-h' ? 'flat' : 'pointy';
      setGridType('hex');
      if (S.hexOrient !== orient) setHexOrient(orient);
      else syncGridTypeUI();
    }
    if (gridTypeSel) gridTypeSel.addEventListener('change', () => setGridChoice(gridTypeSel.value));

    // ---- DRAW CELL sub-panel: precise X/Y (top-left) + square size, in image px.
    // Editing a field re-tiles live; dragging the cell writes the values back. The
    // field the user is typing in is left alone (force=true snaps it on blur).
    // Values may be fractional (sub-pixel) — display is trimmed to 2 decimals. ----
    const fmtCoord = (v) => String(Math.round(v * 100) / 100);
    function syncCoordInputs(force) {
      if (!cellX) return;
      const focused = document.activeElement, has = !!S.drawnCell;
      [cellX, cellY, cellSize].forEach((inp) => { if (inp) inp.disabled = !has; });
      if (drawCoords) drawCoords.querySelectorAll('.coord-btn').forEach((b) => { b.disabled = !has; });
      const set = (inp, val) => { if (inp && (force || inp !== focused)) inp.value = val; };
      if (has) {
        // SIZE is the cell's defining size: square side, or hex flat-to-flat g.
        const sz = S.loaded.gridType === 'hex' ? (S.drawnCell.g || hexGFromBBox(S.drawnCell, S.hexOrient)) : S.drawnCell.w;
        set(cellX, fmtCoord(S.drawnCell.x)); set(cellY, fmtCoord(S.drawnCell.y)); set(cellSize, fmtCoord(sz));
      } else { set(cellX, ''); set(cellY, ''); set(cellSize, ''); }
    }
    function applyCoordInputs() {
      if (!S.loaded || !S.drawnCell) return;
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const hex = S.loaded.gridType === 'hex';
      let x = parseFloat(cellX.value), y = parseFloat(cellY.value), s = parseFloat(cellSize.value);
      if (!Number.isFinite(x)) x = S.drawnCell.x;
      if (!Number.isFinite(y)) y = S.drawnCell.y;
      if (!Number.isFinite(s)) s = hex ? (S.drawnCell.g || hexGFromBBox(S.drawnCell, S.hexOrient)) : S.drawnCell.w;
      x = Math.max(0, Math.min(nW, x)); y = Math.max(0, Math.min(nH, y));
      s = Math.min(Math.min(nW, nH), Math.max(1, s));
      S.drawnCell = clampDrawnCell(hex ? { x: x, y: y, g: s } : { x: x, y: y, w: s, h: s });
      applyDrawnCell();
      renderDrawView();   // re-tiles + repaints; syncs the non-focused inputs
    }
    [cellX, cellY, cellSize].forEach((inp) => {
      if (!inp) return;
      inp.addEventListener('input', applyCoordInputs);
      inp.addEventListener('change', () => { applyCoordInputs(); syncCoordInputs(true); });   // snap to the clamped value on blur/enter
    });
    // Custom ▲▼ stepper arrows: nudge a field by ±1 px (keeping any fractional part),
    // then apply + snap to the clamped value.
    function stepCoord(inp, delta) {
      if (!inp || inp.disabled || !S.drawnCell) return;
      const cur = parseFloat(inp.value);
      inp.value = fmtCoord((Number.isFinite(cur) ? cur : 0) + delta);
      applyCoordInputs(); syncCoordInputs(true);
    }
    if (drawCoords) drawCoords.addEventListener('click', (e) => {
      const btn = e.target.closest('.coord-btn'); if (!btn) return;
      stepCoord($(btn.dataset.target), parseInt(btn.dataset.delta, 10));
    });

    // The image's top-left within the draw-view buffer (buffer px) + the buffer's
    // image-px→buffer-px scale. In CROP the buffer is the full image (origin 0,0);
    // in EXPAND it's the padded output, so the image is inset by the pad. Shared
    // by the cell-drawing, hit-testing, and screen→image mapping below.
    let drawImgOX = 0, drawImgOY = 0, drawBufScale = 1;
    // Screen px → image px, accounting for the image's offset within the buffer.
    function evToDrawImage(e) {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const r = mapC.getBoundingClientRect();
      const bx = (e.clientX - r.left) * (mapC.width / r.width);     // screen → buffer px
      const by = (e.clientY - r.top) * (mapC.height / r.height);
      const ix = (bx - drawImgOX) / drawBufScale, iy = (by - drawImgOY) / drawBufScale;
      return { x: Math.max(0, Math.min(nW, ix)), y: Math.max(0, Math.min(nH, iy)) };
    }
    // Hit-test the editable cell in SCREEN px: returns the grabbed edge(s) when
    // near an edge line, else {inside:true} when over the cell body, else null.
    function cellHitAt(cx, cy) {
      if (!S.drawnCell || !mapC.width) return null;
      const r = mapC.getBoundingClientRect();
      const kx = r.width / mapC.width, ky = r.height / mapC.height;   // buffer px → screen px
      const bx = drawImgOX + S.drawnCell.x * drawBufScale, by = drawImgOY + S.drawnCell.y * drawBufScale;
      const X = r.left + bx * kx, Y = r.top + by * ky;
      const X2 = X + S.drawnCell.w * drawBufScale * kx, Y2 = Y + S.drawnCell.h * drawBufScale * ky;
      const inX = cx >= X - EDGE_GRAB && cx <= X2 + EDGE_GRAB;
      const inY = cy >= Y - EDGE_GRAB && cy <= Y2 + EDGE_GRAB;
      const ed = { l: inY && Math.abs(cx - X) <= EDGE_GRAB, r: inY && Math.abs(cx - X2) <= EDGE_GRAB,
                   t: inX && Math.abs(cy - Y) <= EDGE_GRAB, b: inX && Math.abs(cy - Y2) <= EDGE_GRAB };
      if (ed.l || ed.r || ed.t || ed.b) return { edges: ed };
      if (cx > X && cx < X2 && cy > Y && cy < Y2) return { inside: true };
      return null;
    }
    // The magenta editable-cell rectangle (image px → buffer px, offset by the
    // image origin within the buffer), with corner grips.
    function drawCellRect(g, cell, scale, ox, oy, withGrips) {
      const x = ox + cell.x * scale, y = oy + cell.y * scale, w = cell.w * scale, h = cell.h * scale;
      g.save();
      g.fillStyle = 'rgba(255,0,60,0.16)'; g.fillRect(x, y, w, h);
      g.strokeStyle = 'rgba(255,0,60,0.95)'; g.lineWidth = 2;
      g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      if (withGrips) {
        const s = 5; g.fillStyle = 'rgba(255,0,60,0.95)';
        [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([gx, gy]) => g.fillRect(gx - s, gy - s, s * 2, s * 2));
      }
      g.restore();
    }
    // The magenta editable HEX cell: a hexagon outline at the cell's centre, with
    // the same bbox corner grips as the square handle (resize hit-testing stays
    // bbox-based). `cell` is a drawnCell {x,y,w,h,g?}; g falls back to the bbox.
    function drawHexCellHandle(g, cell, scale, ox, oy, withGrips) {
      const gg = cell.g || hexGFromBBox(cell, S.hexOrient) || Math.max(cell.w, cell.h);
      const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
      const corners = hexCorners(gg, S.hexOrient);
      g.save();
      g.beginPath();
      corners.forEach((p, i) => { const X = ox + (cx + p.x) * scale, Y = oy + (cy + p.y) * scale; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.closePath();
      g.fillStyle = 'rgba(255,0,60,0.16)'; g.fill();
      g.strokeStyle = 'rgba(255,0,60,0.95)'; g.lineWidth = 2; g.stroke();
      if (withGrips) {
        const x = ox + cell.x * scale, y = oy + cell.y * scale, w = cell.w * scale, h = cell.h * scale, s = 5;
        g.fillStyle = 'rgba(255,0,60,0.95)';
        [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([gx, gy]) => g.fillRect(gx - s, gy - s, s * 2, s * 2));
      }
      g.restore();
    }
    function drawDrawHint(g, dW, dH) {            // centred instruction shown before the first cell exists
      g.save();
      g.fillStyle = 'rgba(0,240,255,0.92)';
      g.font = '700 ' + Math.max(13, Math.round(dW * 0.02)) + 'px "JetBrains Mono", monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t('hint_draw'), dW / 2, dH / 2);
      g.restore();
    }
    // Tiled grid + editable cell on the overlay. EXPAND maps the padded output
    // (L fracs across the whole buffer); CROP maps the full image (view() fracs).
    function drawCellOverlay(L, bufW, bufH, scale, ox, oy) {
      const hex = S.loaded.gridType === 'hex';
      if (S.drawnCell) {
        if (hex) drawHexOverlay(bufW, bufH, scale, ox, oy);   // tile the whole map with hexagons
        else if (L && L.expand) drawGrid(L.vFrac, L.vOff, L.hFrac, L.hOff, bufW, bufH);
        else { const v = view(); drawGrid(v.vFrac, v.vOff, v.hFrac, v.hOff, bufW, bufH); }
      } else { gridC.width = bufW; gridC.height = bufH; gridC.getContext('2d').clearRect(0, 0, bufW, bufH); }
      const g = gridC.getContext('2d');
      const handle = hex ? drawHexCellHandle : drawCellRect;
      if (S.cellDrag && S.cellDrag.rect) handle(g, S.cellDrag.rect, scale, ox, oy, false);   // freehand draw of a fresh cell
      else if (S.drawnCell) handle(g, S.drawnCell, scale, ox, oy, true);
      else drawDrawHint(g, bufW, bufH);
    }
    // DRAW CELL view: the SAME crop/expand base render as the normal view (so the
    // edges mode is visible while drawing) + the tiled grid + the editable cell.
    function renderDrawView() {
      const image = S.loaded.image, nW = image.naturalWidth, nH = image.naturalHeight;
      S.showDelim = false; S.trimRect = null; S.trimGeom = null;
      // No cell yet (or mid-draw of a fresh one): plain full image — there's no
      // grid to crop/expand, and this keeps a clean screen↔image mapping.
      if (!S.drawnCell) {
        const scale = Math.min(1, DISPLAY_MAX / Math.max(nW, nH));
        const dW = Math.max(1, Math.round(nW * scale)), dH = Math.max(1, Math.round(nH * scale));
        mapC.width = dW; mapC.height = dH;
        const ctx = mapC.getContext('2d');
        ctx.drawImage(image, 0, 0, dW, dH); tintCanvas(ctx, 0, 0, dW, dH);
        S.dispScale = scale; drawImgOX = 0; drawImgOY = 0; drawBufScale = scale;
        drawCellOverlay(null, dW, dH, scale, 0, 0);
        if (calcVal) calcVal.textContent = '??×??'; if (outVal) outVal.textContent = '??×?? PX';
        syncCoordInputs();
        applyZoom();
        return;
      }
      saveManual();
      if (S.loaded.gridType === 'hex') {
        // HEX draw: plain full image (clean screen↔image mapping) + the tiled hex
        // overlay + the editable hex handle. The resizable window applies in the
        // normal view, not while drawing the defining cell.
        const scale = Math.min(1, DISPLAY_MAX / Math.max(nW, nH));
        const dW = Math.max(1, Math.round(nW * scale)), dH = Math.max(1, Math.round(nH * scale));
        mapC.width = dW; mapC.height = dH;
        const ctx = mapC.getContext('2d');
        ctx.drawImage(image, 0, 0, dW, dH); tintCanvas(ctx, 0, 0, dW, dH);
        S.dispScale = scale; drawImgOX = 0; drawImgOY = 0; drawBufScale = scale;
        drawCellOverlay(null, dW, dH, scale, 0, 0);
        syncCoordInputs();
        const Lh = computeLayout();
        setReadout(Lh.cols, Lh.rows, Lh.outW, Lh.outH);
        applyZoom();
        return;
      }
      const L = computeLayout();   // respects the CROP/EXPAND edges mode (manual is false here)
      if ((S.edgeMode === 'crop' || L.hex) && L.src) {
        // CROP: full image with the cropped-away margins greyed (matches the export crop)
        const scale = Math.min(1, DISPLAY_MAX / Math.max(nW, nH));
        const dW = Math.max(1, Math.round(nW * scale)), dH = Math.max(1, Math.round(nH * scale));
        mapC.width = dW; mapC.height = dH;
        const ctx = mapC.getContext('2d');
        ctx.drawImage(image, 0, 0, dW, dH);
        const kx = L.src.x * scale, ky = L.src.y * scale, kw = L.src.w * scale, kh = L.src.h * scale;
        ctx.fillStyle = 'rgba(8,8,10,0.64)';
        ctx.fillRect(0, 0, dW, ky); ctx.fillRect(0, ky + kh, dW, dH - (ky + kh));
        ctx.fillRect(0, ky, kx, kh); ctx.fillRect(kx + kw, ky, dW - (kx + kw), kh);
        tintCanvas(ctx, kx, ky, kw, kh);
        S.dispScale = scale; drawImgOX = 0; drawImgOY = 0; drawBufScale = scale;
        // cyan boundary box around the kept region (no drag-grips — adjust via the cell)
        S.trimRect = { x: kx, y: ky, w: kw, h: kh }; S.showDelim = true; S.delimGrips = false;
        drawCellOverlay(L, dW, dH, scale, 0, 0);
      } else {
        // EXPAND (padded output): paint the real result; the image is inset by the pad
        const scale = Math.min(1, DISPLAY_MAX / Math.max(L.outW, L.outH));
        const { w: dW, h: dH } = paint(mapC, L, scale);
        const ox = L.expand ? Math.round(L.dx * scale) : 0, oy = L.expand ? Math.round(L.dy * scale) : 0;
        S.dispScale = scale; drawImgOX = ox; drawImgOY = oy; drawBufScale = scale;
        drawCellOverlay(L, dW, dH, scale, ox, oy);
      }
      syncCoordInputs();
      setReadout(L.cols, L.rows, L.outW, L.outH);
    }

    syncToggles();
    refreshFill();
    syncFillMode();
    syncAutoMode();
    refreshNight();
    syncEffects();
    syncScaleUI();

    // ---- HEX geometry (regular hexes, matching Roll20 / Foundry VTT) ----------
    // VTT "grid size" g = the FLAT-TO-FLAT distance of a hex (top↔bottom for a
    // flat-top hex, left↔right for a pointy-top hex). Side s = g/√3, and the
    // vertex-to-vertex span = 2s. A hex grid here is fully described by the
    // orientation, g, and an origin (hexOX,hexOY) = the top-left corner of hex
    // (col 0,row 0)'s bounding box, all in image px.
    function hexBBox(g, orient) {                 // bounding-box dims of one hex
      const vv = 2 * g / SQRT3;                   // vertex-to-vertex
      return orient === 'flat' ? { w: vv, h: g } : { w: g, h: vv };
    }
    function hexGFromBBox(cell, orient) {         // flat-to-flat g from a bbox (flat: height, pointy: width)
      return orient === 'flat' ? cell.h : cell.w;
    }
    // g (flat-to-flat) from a box drawn around 3 tightly-grouped (mutually-adjacent)
    // hexes — the "3 HEXES" seed tool. Any compact triangular triple spans exactly
    // 2·g across the flats and (7√3/6)·g ≈ 2.02·g across the staggered axis,
    // independent of which way the triangle points. We average both estimates so an
    // imprecise drag still lands close; the lattice origin is refined from the image.
    const HEX_CLUSTER3 = 7 * SQRT3 / 6;           // staggered-axis span of a 3-hex cluster, in units of g
    function hexGFromCluster(box, orient) {
      return orient === 'flat'
        ? (box.w / HEX_CLUSTER3 + box.h / 2) / 2
        : (box.w / 2 + box.h / HEX_CLUSTER3) / 2;
    }
    function hexCorners(g, orient) {              // 6 corner offsets from the hex centre (image px)
      const R = g / SQRT3, base = orient === 'flat' ? 0 : Math.PI / 6, out = [];
      for (let i = 0; i < 6; i++) { const a = base + i * Math.PI / 3; out.push({ x: R * Math.cos(a), y: R * Math.sin(a) }); }
      return out;
    }
    // Full tiling for an image: cell counts + the px bounding box of all whole
    // hexes (may extend past the image; callers clamp). The half-step offset of
    // alternate columns/rows is included in the bounds so no hex is clipped.
    function hexLayout(nW, nH, orient, g, ox, oy) {
      const { w: bw, h: bh } = hexBBox(g, orient);
      const dx = orient === 'flat' ? 0.75 * bw : bw;   // centre-to-centre, x
      const dy = orient === 'flat' ? bh : 0.75 * bh;   // centre-to-centre, y
      const cols = Math.max(1, Math.floor((nW - ox - bw) / dx + 1e-6) + 1);
      const rows = Math.max(1, Math.floor((nH - oy - bh) / dy + 1e-6) + 1);
      const offX = (orient === 'pointy' && rows > 1) ? bw / 2 : 0;   // odd rows shift +x
      const offY = (orient === 'flat' && cols > 1) ? bh / 2 : 0;     // odd cols shift +y
      const gridW = bw + (cols - 1) * dx + offX;
      const gridH = bh + (rows - 1) * dy + offY;
      return { cols, rows, g, ox, oy, dx, dy, bw, bh, orient, gridX0: ox, gridY0: oy, gridW, gridH };
    }
    // Per-orientation step geometry: cell-to-cell spacing (dx,dy) + bbox dims.
    function hexGeom(g, orient) {
      const { w: bw, h: bh } = hexBBox(g, orient);
      return { bw, bh, dx: orient === 'flat' ? 0.75 * bw : bw, dy: orient === 'flat' ? bh : 0.75 * bh };
    }
    // Centre of hex (c,r) in image px. Alternate columns (flat) / rows (pointy)
    // are shifted half a hex; `c & 1` keeps parity correct for negative indices.
    function hexCenter(orient, geom, ox, oy, c, r) {
      const { bw, bh, dx, dy } = geom;
      return {
        cx: ox + bw / 2 + c * dx + (orient === 'pointy' && (r & 1) ? bw / 2 : 0),
        cy: oy + bh / 2 + r * dy + (orient === 'flat' && (c & 1) ? bh / 2 : 0),
      };
    }
    // Image-px bbox of the hex column/row range [hC0,hC1) × [hR0,hR1) (indices may
    // be negative). The box is the UNSTAGGERED whole-cell rectangle (exactly
    // nC×nR cells: (nC-1)·dx+bw by (nR-1)·dy+bh), anchored on the even reference.
    // It deliberately does NOT add the half-step overhang of the alternate
    // columns/rows: the truncation lines snap to whole-cell grid lines, so the
    // offset cells on the trailing edge (bottom for flat, right for pointy) are
    // cut in half rather than the window dangling half a cell past them.
    // Bounds on the STAGGERED axis may be half-integers (½-hex crop steps). That's
    // exact: on that axis the step (dy for flat, dx for pointy) equals the bbox
    // dimension, so (nR-1)·dy + bh collapses to nR·dy and a .5 bound lands the edge
    // precisely on the alternate column/row's offset line.
    function hexWindowBox(orient, g, ox, oy, hC0, hC1, hR0, hR1) {
      const { bw, bh, dx, dy } = hexGeom(g, orient);
      const nC = hC1 - hC0, nR = hR1 - hR0;
      return { x: ox + hC0 * dx, y: oy + hR0 * dy, w: (nC - 1) * dx + bw, h: (nR - 1) * dy + bh };
    }
    // Set the hex window to the default extent for the current EDGES MODE — the
    // hex analogue of square's crop/expand:
    //   EXPAND → the smallest window whose box COVERS the whole image, so no image
    //            pixel is left outside the hexes; the box pokes off-image where
    //            paint() fills the margins with the chosen fill.
    //   CROP   → only hexes whose box lies fully inside the image (no fill).
    // Both stay draggable afterwards; toggling the mode re-applies this default.
    function setHexWindow() {
      const w = S.edgeMode === 'expand' ? hexCoverWindow() : hexCropWindow();
      S.winC0 = w.hC0; S.winC1 = w.hC1; S.winR0 = w.hR0; S.winR1 = w.hR1;
      // span may be fractional on the staggered axis (½-hex steps) → round the
      // whole-hex count for the readout; the raw bounds drive the box geometry.
      S.loaded.cols = Math.round(w.hC1 - w.hC0); S.loaded.rows = Math.round(w.hR1 - w.hR0);
    }
    // The hex column/row index range that the image actually contains (indices may
    // be negative). Counts a hex when its CENTRE falls inside the image — the same
    // notion the readout's NN×MM reports. Using bbox coverage instead would add the
    // phantom edge hexes whose tips/half-step overhang merely graze the image,
    // inflating the count by a row/column on each side (e.g. a tight 5×5 → 7×7).
    // Centres use the unstaggered (even) reference so the window stays rectangular;
    // the alternate-column/row half-step overhang is handled by hexWindowBox.
    //
    // The bounds are a half-open centre range [0, nW)×[0, nH): hC0/hR0 = first index
    // with centre ≥ 0, hC1/hR1 = first index with centre ≥ size (exclusive). The
    // exclusive end is ceil(span/step), NOT floor+1 — they agree for a mid-cell crop
    // but differ when the crop falls exactly on a cell boundary (e.g. the source is
    // cropped to include the offset columns' full half-step overhang): floor+1 would
    // then count an extra phantom row/col whose centre sits right on the far edge.
    function hexFullWindow() {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const { bw, bh, dx, dy } = hexGeom(S.loaded.hexG, S.hexOrient);
      const ox = S.loaded.hexOX, oy = S.loaded.hexOY;
      const cx0 = ox + bw / 2, cy0 = oy + bh / 2;   // centre of hex (col 0,row 0)
      const E = 1e-6;
      return {
        hC0: Math.ceil(-cx0 / dx - E), hC1: Math.ceil((nW - cx0) / dx - E),
        hR0: Math.ceil(-cy0 / dy - E), hR1: Math.ceil((nH - cy0) / dy - E),
      };
    }
    // CROP analogue of hexFullWindow: the hex column/row range whose UNSTAGGERED
    // whole-cell box (the same one hexWindowBox builds) lies fully inside the
    // image, so the export is pure image content with no fill. The first kept
    // index is where the box edge clears 0; the last is where it still clears the
    // far edge (box left = ox + c·dx, box right = ox + (c)·dx + bw). If the grid
    // is coarser than the image (nothing fits), fall back to the full window.
    function hexCropWindow() {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const { bw, bh, dx, dy } = hexGeom(S.loaded.hexG, S.hexOrient);
      const ox = S.loaded.hexOX, oy = S.loaded.hexOY, E = 1e-6;
      // The STAGGERED axis (rows for flat, cols for pointy) steps in ½-hex so the
      // crop line can land on the alternate column/row's half-hex offset edge — its
      // step equals that axis's bbox dimension, so the box edge is o + bound·step.
      // The other axis keeps whole-hex steps (a half there would bisect hexes).
      let hC0, hC1, hR0, hR1;
      if (S.hexOrient === 'flat') {
        hC0 = Math.ceil(-ox / dx - E); hC1 = Math.floor((nW - bw - ox) / dx + E) + 1;
        hR0 = Math.ceil((-oy / dy) * 2 - E) / 2; hR1 = Math.floor(((nH - oy) / dy) * 2 + E) / 2;
      } else {
        hC0 = Math.ceil((-ox / dx) * 2 - E) / 2; hC1 = Math.floor(((nW - ox) / dx) * 2 + E) / 2;
        hR0 = Math.ceil(-oy / dy - E); hR1 = Math.floor((nH - bh - oy) / dy + E) + 1;
      }
      if (hC1 <= hC0 || hR1 <= hR0) return hexFullWindow();
      return { hC0, hC1, hR0, hR1 };
    }
    // EXPAND analogue: the smallest hex window whose UNSTAGGERED box COVERS the
    // whole image (box.x ≤ 0 ≤ … ≤ box.right ≥ nW, likewise vertically), so every
    // image pixel sits inside the hex grid and the off-image overhang is filled.
    // It is the mirror of hexCropWindow — floor/ceil swapped so the box grows
    // outward to enclose the image instead of shrinking inward to fit within it.
    function hexCoverWindow() {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      const { bw, bh, dx, dy } = hexGeom(S.loaded.hexG, S.hexOrient);
      const ox = S.loaded.hexOX, oy = S.loaded.hexOY, E = 1e-6;
      // Mirror of hexCropWindow: the staggered axis rounds OUTWARD in ½-hex steps so
      // the box covers every offset edge hex; the other axis stays whole-hex.
      if (S.hexOrient === 'flat') {
        return {
          hC0: Math.floor(-ox / dx + E),                 hC1: Math.ceil((nW - bw - ox) / dx - E) + 1,
          hR0: Math.floor((-oy / dy) * 2 + E) / 2,       hR1: Math.ceil(((nH - oy) / dy) * 2 - E) / 2,
        };
      }
      return {
        hC0: Math.floor((-ox / dx) * 2 + E) / 2,         hC1: Math.ceil(((nW - ox) / dx) * 2 - E) / 2,
        hR0: Math.floor(-oy / dy + E),                   hR1: Math.ceil((nH - bh - oy) / dy - E) + 1,
      };
    }
    // The current image's hex tiling (from loaded's hex params + the live orient).
    function currentHexLayout() {
      if (!S.loaded || S.loaded.gridType !== 'hex' || !(S.loaded.hexG > 0)) return null;
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      return hexLayout(nW, nH, S.hexOrient, S.loaded.hexG, S.loaded.hexOX, S.loaded.hexOY);
    }
    // The effective hex window (hex column/row index bounds), defaulting to the
    // whole-image cover when the saved bounds aren't a valid hex window.
    function hexWindow() {
      if (S.winC1 > S.winC0 && S.winR1 > S.winR0) return { hC0: S.winC0, hC1: S.winC1, hR0: S.winR0, hR1: S.winR1 };
      return hexFullWindow();
    }
    // Does the live hex window's box extend past the image on any side? (Drives
    // the FILL control's enabled state — fill only matters when there's off-image
    // margin to paint.) False for non-hex / unsized grids.
    function hexWindowOffImage() {
      if (!S.loaded || S.loaded.gridType !== 'hex' || !(S.loaded.hexG > 0)) return false;
      const w = hexWindow();
      const box = hexWindowBox(S.hexOrient, S.loaded.hexG, S.loaded.hexOX, S.loaded.hexOY, w.hC0, w.hC1, w.hR0, w.hR1);
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      return box.x < -0.5 || box.y < -0.5 || box.x + box.w > nW + 0.5 || box.y + box.h > nH + 0.5;
    }
    // HEX layout: a resizable window of whole hexes (the bbox of [hC0,hC1)×[hR0,hR1)),
    // covering the image by default and extendable off-image (filled like the
    // square MANUAL window). Returns a `win` layout so paint()/renderDisplay reuse
    // the square window pipeline; the hex overlay is drawn separately.
    function hexComputeLayout() {
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      if (!(S.loaded.hexG > 0)) return { outW: nW, outH: nH, src: { x: 0, y: 0, w: nW, h: nH }, dx: 0, dy: 0, fill: null, cols: 1, rows: 1, hex: true };
      const w = hexWindow();
      const box = hexWindowBox(S.hexOrient, S.loaded.hexG, S.loaded.hexOX, S.loaded.hexOY, w.hC0, w.hC1, w.hR0, w.hR1);
      return {
        win: { x: box.x, y: box.y, w: box.w, h: box.h },
        outW: Math.max(1, Math.round(box.w)), outH: Math.max(1, Math.round(box.h)),
        cols: Math.round(w.hC1 - w.hC0), rows: Math.round(w.hR1 - w.hR0), hex: true, hexWin: w,
      };
    }

    // ---- Result layout: how the edge-fix reshapes the map. Shared by the
    // on-canvas preview AND the PNG export so they always match. Returns
    // natural-pixel geometry: output size, source crop / placement, optional
    // fill, resulting cell counts, and grid-line fractions within the result. ----
    function computeLayout() {
      if (S.loaded && S.loaded.gridType === 'hex') return hexComputeLayout();
      const image = S.loaded.image, nW = image.naturalWidth, nH = image.naturalHeight;
      if (S.manual) {
        // MANUAL: the window is grid-cell bounds [winC0,winC1) × [winR0,winR1),
        // moved/grown by the d-pad. It may sit partly/fully off the image;
        // paint() trims to the image and fills the rest with the chosen fill.
        const v = view();
        const cellW = v.vFrac * nW, cellH = v.hFrac * nH;
        const baseX = v.vOff * nW, baseY = v.hOff * nH;
        const nCols = S.winC1 - S.winC0, nRows = S.winR1 - S.winR0;
        const winW = nCols * cellW, winH = nRows * cellH;
        return {
          win: { x: baseX + S.winC0 * cellW, y: baseY + S.winR0 * cellH, w: winW, h: winH },
          outW: Math.round(winW), outH: Math.round(winH),
          cols: nCols, rows: nRows, vFrac: 1 / nCols, vOff: 0, hFrac: 1 / nRows, hOff: 0,
        };
      }
      const { vFrac, vOff, hFrac, hOff } = view();   // edge-fixing is always on → crop/expand below
      const cellW = vFrac * nW, cellH = hFrac * nH, ox = vOff * nW, oy = hOff * nH;
      const nCols = Math.max(1, Math.floor((nW - ox) / cellW + 1e-6));
      const nRows = Math.max(1, Math.floor((nH - oy) / cellH + 1e-6));
      if (S.edgeMode === 'crop') {
        const sx = Math.round(ox), sy = Math.round(oy);
        const w = Math.min(Math.round(nCols * cellW), nW - sx), h = Math.min(Math.round(nRows * cellH), nH - sy);
        return { outW: w, outH: h, src: { x: sx, y: sy, w, h }, dx: 0, dy: 0, fill: null,
                 cols: nCols, rows: nRows, vFrac: 1 / nCols, vOff: 0, hFrac: 1 / nRows, hOff: 0 };
      }
      // expand: pad partial edge cells out to whole cells
      const rPart = nW - (ox + nCols * cellW), bPart = nH - (oy + nRows * cellH);
      const leftPad = ox > 0.5 ? cellW - ox : 0, rightPad = rPart > 0.5 ? cellW - rPart : 0;
      const topPad = oy > 0.5 ? cellH - oy : 0, botPad = bPart > 0.5 ? cellH - bPart : 0;
      const eCols = nCols + (leftPad > 0 ? 1 : 0) + (rightPad > 0 ? 1 : 0);
      const eRows = nRows + (topPad > 0 ? 1 : 0) + (botPad > 0 ? 1 : 0);
      return { outW: Math.round(eCols * cellW), outH: Math.round(eRows * cellH), expand: true,
               src: null, dx: Math.round(leftPad), dy: Math.round(topPad), fill: fillValue(),
               cols: eCols, rows: eRows, vFrac: 1 / eCols, vOff: 0, hFrac: 1 / eRows, hOff: 0 };
    }

    // Paint a layout onto a canvas at the given scale (out → target px).
    // EFFECTS → NIGHT MODE: multiply the chosen tint over a region (no-op when off).
    function tintCanvas(ctx, x, y, w, h) {
      if (!S.nightMode || S.nightPotency <= 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = S.nightPotency;   // // POTENCY: blend the multiply between none (0) and full (1)
      ctx.fillStyle = S.nightColor;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
    // ---- EXPORT resampling (// SCALING:) ---------------------------------
    // The real image content is drawn through drawScaled(), which honours the
    // chosen algorithm. NEAREST/SMOOTH just toggle the canvas' built-in
    // resampler; SHARP runs a separable Lanczos-3 resize. Lanczos only kicks in
    // when actually enlarging — for 1:1 or downscale it falls back to the
    // canvas hi-q path, which is both faster and better there. The synthetic
    // fill/pad regions (solid + blurred edge-extend) are NOT routed through
    // this — they keep the smooth path so the padding still reads soft.
    const lanczos = (x, a) => {                         // windowed sinc, support ±a
      if (x === 0) return 1;
      if (x <= -a || x >= a) return 0;
      const px = Math.PI * x;
      return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
    };
    // Per-output-pixel source taps + normalised weights for a 1-D resize.
    function lanczosWeights(srcLen, dstLen, a) {
      const ratio = srcLen / dstLen;                    // <1 when enlarging
      const filtScale = Math.max(1, ratio);             // widen the window when shrinking (anti-alias)
      const support = a * filtScale;
      const rows = new Array(dstLen);
      for (let i = 0; i < dstLen; i++) {
        const center = (i + 0.5) * ratio - 0.5;
        const lo = Math.floor(center - support), hi = Math.ceil(center + support);
        const idx = [], wt = []; let sum = 0;
        for (let j = lo; j <= hi; j++) {
          const w = lanczos((center - j) / filtScale, a);
          if (w === 0) continue;
          idx.push(Math.min(srcLen - 1, Math.max(0, j)));   // clamp to edge
          wt.push(w); sum += w;
        }
        for (let k = 0; k < wt.length; k++) wt[k] /= sum;   // normalise so brightness is preserved
        rows[i] = { idx, wt };
      }
      return rows;
    }
    // Lanczos-3 resize of a source sub-rect → a new canvas at dw×dh. Separable:
    // a horizontal pass (into a float buffer) then a vertical pass.
    function lanczosResample(img, sx, sy, sw, sh, dw, dh) {
      sx = Math.round(sx); sy = Math.round(sy); sw = Math.round(sw); sh = Math.round(sh);
      const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
      const sctx = sc.getContext('2d'); sctx.imageSmoothingEnabled = false;
      sctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const src = sctx.getImageData(0, 0, sw, sh).data;
      const A = 3;
      const wx = lanczosWeights(sw, dw, A), wy = lanczosWeights(sh, dh, A);
      const horiz = new Float32Array(dw * sh * 4);       // sw×sh → dw×sh
      for (let y = 0; y < sh; y++) {
        const srow = y * sw * 4, drow = y * dw * 4;
        for (let x = 0; x < dw; x++) {
          const tap = wx[x], idx = tap.idx, wt = tap.wt, o = drow + x * 4;
          let r = 0, g = 0, b = 0, al = 0;
          for (let k = 0; k < idx.length; k++) {
            const s = srow + idx[k] * 4, w = wt[k];
            r += src[s] * w; g += src[s + 1] * w; b += src[s + 2] * w; al += src[s + 3] * w;
          }
          horiz[o] = r; horiz[o + 1] = g; horiz[o + 2] = b; horiz[o + 3] = al;
        }
      }
      const out = new Uint8ClampedArray(dw * dh * 4);     // dw×sh → dw×dh
      for (let y = 0; y < dh; y++) {
        const tap = wy[y], idx = tap.idx, wt = tap.wt, drow = y * dw * 4;
        for (let x = 0; x < dw; x++) {
          const col = x * 4, o = drow + col;
          let r = 0, g = 0, b = 0, al = 0;
          for (let k = 0; k < idx.length; k++) {
            const s = idx[k] * dw * 4 + col, w = wt[k];
            r += horiz[s] * w; g += horiz[s + 1] * w; b += horiz[s + 2] * w; al += horiz[s + 3] * w;
          }
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = al;
        }
      }
      const dc = document.createElement('canvas'); dc.width = dw; dc.height = dh;
      dc.getContext('2d').putImageData(new ImageData(out, dw, dh), 0, 0);
      return dc;
    }
    // Draw img[sx,sy,sw,sh] into ctx at [dx,dy,dw,dh] using the active algorithm.
    function drawScaled(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
      const enlarging = dw > sw + 0.5 || dh > sh + 0.5;   // only enlargement uses the chosen algorithm
      if (enlarging && S.scaleAlgo === 'sharp') {
        const px = Math.round(dx), py = Math.round(dy), pw = Math.round(dw), ph = Math.round(dh);
        const tmp = lanczosResample(img, sx, sy, sw, sh, pw, ph);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, px, py);
        return;
      }
      ctx.imageSmoothingEnabled = !(enlarging && S.scaleAlgo === 'nearest');   // smooth for downscale/1:1 regardless
      if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    }
    function paint(canvas, L, scale) {
      const image = S.loaded.image, nW = image.naturalWidth, nH = image.naturalHeight;
      const w = Math.max(1, Math.round(L.outW * scale)), h = Math.max(1, Math.round(L.outH * scale));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (L.win) {
        // window over image: fill any area beyond the image with the selected
        // fill (vibrant edge-extend, or solid), then drop the window∩image
        // overlap on top.
        const wx = L.win.x, wy = L.win.y;
        const sx = Math.max(0, wx), sy = Math.max(0, wy);
        const ex = Math.min(nW, wx + L.win.w), ey = Math.min(nH, wy + L.win.h);
        if (ex <= sx || ey <= sy) {           // window entirely off the image
          if (S.fillMode !== 'transparent') { ctx.fillStyle = toHex(fillValue()) || '#808080'; ctx.fillRect(0, 0, w, h); }
          tintCanvas(ctx, 0, 0, w, h);
          return { w, h };
        }
        const padL = Math.round((sx - wx) * scale), padT = Math.round((sy - wy) * scale);
        const ow = Math.round((ex - sx) * scale), oh = Math.round((ey - sy) * scale);
        const padR = w - (padL + ow), padB = h - (padT + oh);
        if (S.fillMode === 'vibrant') {
          // extend the overlap's edge pixels into each pad, BLURRED + overscanned
          const blur = Math.max(3, Math.round(Math.min(w, h) * 0.025)), m = blur * 2;
          ctx.filter = 'blur(' + blur + 'px)';
          if (padL > 0) ctx.drawImage(image, sx, sy, 1, ey - sy, -m, padT, padL + m, oh);                  // left
          if (padR > 0) ctx.drawImage(image, ex - 1, sy, 1, ey - sy, padL + ow, padT, padR + m, oh);       // right
          if (padT > 0) ctx.drawImage(image, sx, sy, ex - sx, 1, padL, -m, ow, padT + m);                  // top
          if (padB > 0) ctx.drawImage(image, sx, ey - 1, ex - sx, 1, padL, padT + oh, ow, padB + m);       // bottom
          if (padL > 0 && padT > 0) ctx.drawImage(image, sx, sy, 1, 1, -m, -m, padL + m, padT + m);                        // TL
          if (padR > 0 && padT > 0) ctx.drawImage(image, ex - 1, sy, 1, 1, padL + ow, -m, padR + m, padT + m);             // TR
          if (padL > 0 && padB > 0) ctx.drawImage(image, sx, ey - 1, 1, 1, -m, padT + oh, padL + m, padB + m);             // BL
          if (padR > 0 && padB > 0) ctx.drawImage(image, ex - 1, ey - 1, 1, 1, padL + ow, padT + oh, padR + m, padB + m);  // BR
          ctx.filter = 'none';
        } else if (S.fillMode !== 'transparent') {
          ctx.fillStyle = toHex(fillValue()) || '#808080'; ctx.fillRect(0, 0, w, h);
        }
        drawScaled(ctx, image, sx, sy, ex - sx, ey - sy, padL, padT, ow, oh);   // image overlap on top
        tintCanvas(ctx, 0, 0, w, h);
        return { w, h };
      }
      if (L.expand) {
        const dx = Math.round(L.dx * scale), dy = Math.round(L.dy * scale);
        const iw = Math.round(nW * scale), ih = Math.round(nH * scale);
        const rp = w - (dx + iw), bp = h - (dy + ih);
        if (S.fillMode === 'vibrant') {
          // VIBRANT: extend the nearest edge pixels into each pad region, BLURRED
          // and overscanned beyond the canvas (margin m) so the padding reads as
          // a soft continuation of the edge — no hard streaks, no transparent rim.
          const blur = Math.max(3, Math.round(Math.min(w, h) * 0.025)), m = blur * 2;
          ctx.filter = 'blur(' + blur + 'px)';
          if (dx > 0) ctx.drawImage(image, 0, 0, 1, nH, -m, dy, dx + m, ih);                  // left
          if (rp > 0) ctx.drawImage(image, nW - 1, 0, 1, nH, dx + iw, dy, rp + m, ih);        // right
          if (dy > 0) ctx.drawImage(image, 0, 0, nW, 1, dx, -m, iw, dy + m);                  // top
          if (bp > 0) ctx.drawImage(image, 0, nH - 1, nW, 1, dx, dy + ih, iw, bp + m);        // bottom
          if (dx > 0 && dy > 0) ctx.drawImage(image, 0, 0, 1, 1, -m, -m, dx + m, dy + m);                       // TL
          if (rp > 0 && dy > 0) ctx.drawImage(image, nW - 1, 0, 1, 1, dx + iw, -m, rp + m, dy + m);             // TR
          if (dx > 0 && bp > 0) ctx.drawImage(image, 0, nH - 1, 1, 1, -m, dy + ih, dx + m, bp + m);             // BL
          if (rp > 0 && bp > 0) ctx.drawImage(image, nW - 1, nH - 1, 1, 1, dx + iw, dy + ih, rp + m, bp + m);   // BR
          ctx.filter = 'none';
        } else if (S.fillMode !== 'transparent' && L.fill) {
          ctx.fillStyle = L.fill; ctx.fillRect(0, 0, w, h);
        }
        drawScaled(ctx, image, 0, 0, nW, nH, dx, dy, iw, ih);
        tintCanvas(ctx, 0, 0, w, h);
        return { w, h };
      }
      if (L.src) drawScaled(ctx, image, L.src.x, L.src.y, L.src.w, L.src.h, 0, 0, w, h);
      else drawScaled(ctx, image, 0, 0, nW, nH, Math.round(L.dx * scale), Math.round(L.dy * scale), Math.round(nW * scale), Math.round(nH * scale));
      tintCanvas(ctx, 0, 0, w, h);
      return { w, h };
    }

    // Grid overlay (hover layer) for a given line geometry, sized dW×dH.
    // Grid overlay sized dW×dH. An optional rect (canvas px) confines the lines
    // to a sub-region — used for the MANUAL window so the grid tracks it.
    // The kept-region delimiter: a cyan box with a resize-grip chevron pair at
    // the middle of each edge (< > on the left/right edges, ^ v on the top/bottom)
    // signalling the draggable snap-to-grid trimmer lines. It is drawn on the
    // #trimCanvas overlay at DISPLAY resolution (in CSS px) so the lines stay
    // crisp and a constant size on screen, whatever the map's resolution or zoom.
    function drawChevPair(ctx, x, y, horiz) {
      const A = 7, W = 6, G = 4;   // CSS px: arm half-length, chevron depth, gap from the edge line
      ctx.beginPath();
      if (horiz) {                 // < >  (drag left / right)
        ctx.moveTo(x - G, y - A); ctx.lineTo(x - G - W, y); ctx.lineTo(x - G, y + A);
        ctx.moveTo(x + G, y - A); ctx.lineTo(x + G + W, y); ctx.lineTo(x + G, y + A);
      } else {                     // ^ v  (drag up / down)
        ctx.moveTo(x - A, y - G); ctx.lineTo(x, y - G - W); ctx.lineTo(x + A, y - G);
        ctx.moveTo(x - A, y + G); ctx.lineTo(x, y + G + W); ctx.lineTo(x + A, y + G);
      }
      ctx.stroke();
    }
    function drawDelimiter(ctx, x, y, w, h) {   // x,y,w,h in CSS px on the (padded) overlay
      ctx.strokeStyle = 'rgba(0,240,255,0.95)';
      ctx.lineWidth = 3; ctx.lineJoin = 'miter';
      ctx.strokeRect(x, y, w, h);
      if (!S.delimGrips) return;   // draw mode: just the boundary box, no drag-grips
      ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // Chevrons straddle their edge line; the overlay is padded beyond the map
      // (see drawTrimOverlay) so the outward half stays on-canvas at the border.
      const cx = x + w / 2, cy = y + h / 2;
      drawChevPair(ctx, x, cy, true);          // left edge   < >
      drawChevPair(ctx, x + w, cy, true);      // right edge  < >
      drawChevPair(ctx, cx, y, false);         // top edge    ^ v
      drawChevPair(ctx, cx, y + h, false);     // bottom edge ^ v
    }
    // Repaint the delimiter overlay at the current display size (called after
    // every render and every zoom, so it tracks the map and stays sharp).
    const TRIM_PAD = 12;   // overlay overhang (CSS px) so edge grips aren't clipped at the border
    function drawTrimOverlay() {
      if (!trimC) return;
      const dispW = mapC.clientWidth, dispH = mapC.clientHeight;
      const dpr = window.devicePixelRatio || 1, P = TRIM_PAD;
      // the overlay is larger than the map and overhangs it by P on every side
      trimC.style.left = -P + 'px'; trimC.style.top = -P + 'px';
      trimC.style.width = (dispW + 2 * P) + 'px'; trimC.style.height = (dispH + 2 * P) + 'px';
      trimC.width = Math.max(1, Math.round((dispW + 2 * P) * dpr));
      trimC.height = Math.max(1, Math.round((dispH + 2 * P) * dpr));
      const g = trimC.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, P * dpr, P * dpr);   // origin at the map's top-left; draw in CSS px
      g.clearRect(-P, -P, dispW + 2 * P, dispH + 2 * P);
      if (!S.showDelim || !S.trimRect || !mapC.width || !dispW) return;
      const sx = dispW / mapC.width, sy = dispH / mapC.height;   // buffer px → CSS px
      // snap to integer CSS px so the even-width border lands on pixel boundaries (crisp)
      const x = Math.round(S.trimRect.x * sx), y = Math.round(S.trimRect.y * sy);
      drawDelimiter(g, x, y, Math.round(S.trimRect.w * sx), Math.round(S.trimRect.h * sy));
    }
    function drawGrid(vFrac, vOff, hFrac, hOff, dW, dH, rect) {
      gridC.width = dW; gridC.height = dH;
      const g = gridC.getContext('2d');
      g.clearRect(0, 0, dW, dH);
      g.lineWidth = 1;
      g.strokeStyle = view().estimated ? 'rgba(0,240,255,0.75)' : 'rgba(252,238,10,0.85)';
      const rx = rect ? rect.x : 0, ry = rect ? rect.y : 0, rw = rect ? rect.w : dW, rh = rect ? rect.h : dH;
      g.beginPath();
      for (let f = vOff % vFrac; f <= 1.0001; f += vFrac) { const x = Math.round(rx + f * rw) + 0.5; g.moveTo(x, ry); g.lineTo(x, ry + rh); }
      for (let f = hOff % hFrac; f <= 1.0001; f += hFrac) { const y = Math.round(ry + f * rh) + 0.5; g.moveTo(rx, y); g.lineTo(rx + rw, y); }
      g.stroke();
    }
    // HEX overlay: stroke every whole hexagon of the current tiling. Image-px hex
    // centres are mapped to buffer px by `scale` (+ the image's offset within the
    // buffer). Same stroke palette as drawGrid (cyan when estimated, else yellow).
    // Stroke every hexagon of a window range (defaults to the live hex window),
    // mapping image-px centres to buffer px by `scale` (+ image origin ox,oy).
    // Hexes fully outside the buffer are culled. Same palette as drawGrid.
    function drawHexOverlay(dW, dH, scale, ox, oy, range) {
      gridC.width = dW; gridC.height = dH;
      const g = gridC.getContext('2d');
      g.clearRect(0, 0, dW, dH);
      if (!S.loaded || S.loaded.gridType !== 'hex' || !(S.loaded.hexG > 0)) return;
      const orient = S.hexOrient, hg = S.loaded.hexG, geom = hexGeom(hg, orient);
      const win = range || hexWindow();
      const corners = hexCorners(hg, orient);
      const rx = (geom.bw / 2) * scale, ry = (geom.bh / 2) * scale;
      g.lineWidth = 1;
      g.strokeStyle = S.loaded.estimated ? 'rgba(0,240,255,0.75)' : 'rgba(252,238,10,0.85)';
      g.beginPath();
      // The window bounds may be half-integers on the staggered axis (½-hex crop
      // steps), but hexes live at INTEGER indices — iterate the integer range
      // spanning the (rounded-outward) window so offset edge hexes still draw.
      const c0 = Math.floor(win.hC0), c1 = Math.ceil(win.hC1);
      const r0 = Math.floor(win.hR0), r1 = Math.ceil(win.hR1);
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const { cx, cy } = hexCenter(orient, geom, S.loaded.hexOX, S.loaded.hexOY, c, r);
          const bx = ox + cx * scale, by = oy + cy * scale;
          if (bx + rx < 0 || bx - rx > dW || by + ry < 0 || by - ry > dH) continue;   // off-buffer cull
          for (let i = 0; i < 6; i++) {
            const X = ox + (cx + corners[i].x) * scale, Y = oy + (cy + corners[i].y) * scale;
            i ? g.lineTo(X, Y) : g.moveTo(X, Y);
          }
          g.closePath();
        }
      }
      g.stroke();
    }
    // EXPORT scale factor so each grid cell renders at `exportCellPx` px (0 = native).
    // Clamped so the exported canvas never exceeds MAX_EXPORT_SIDE on a side.
    const MAX_EXPORT_SIDE = 12000;
    function scaleFactorFor(cols, outW, outH) {
      if (!S.exportCellPx || !(outW > 0) || !(cols > 0)) return 1;
      // native px per cell: square = output width / cols; hex = the flat-to-flat g
      // (the VTT grid size), so "70px cell" matches Roll20/Foundry on hex maps too.
      const nativeCellPx = (S.loaded && S.loaded.gridType === 'hex' && S.loaded.hexG > 0) ? S.loaded.hexG : (outW / cols);
      let f = S.exportCellPx / nativeCellPx;            // target px ÷ native px-per-cell
      const big = Math.max(outW, outH || 0) * f;
      if (big > MAX_EXPORT_SIDE) f *= MAX_EXPORT_SIDE / big;
      return f;
    }
    function setReadout(cols, rows, outW, outH) {
      const est = view().estimated;
      if (colVal) colVal.textContent = cols;
      if (rowVal) rowVal.textContent = rows;
      // resulting size shown above SAVE PNG — what the export will be
      // (reflects manual edits and crop/expand)
      if (calcVal) calcVal.textContent = cols + '×' + rows;
      if (calcSize) calcSize.classList.toggle('estimated', est);
      // the exported PNG's pixel dimensions (native outW×outH × the export scale)
      const f = scaleFactorFor(cols, outW, outH);
      if (outVal) outVal.textContent = Math.round(outW * f) + '×' + Math.round(outH * f) + ' PX';
      // checkerboard behind transparent padding — only where padding exists (expand / manual)
      zone.classList.toggle('transp', S.fillMode === 'transparent' && (S.manual || S.edgeMode === 'expand'));
      applyZoom();           // re-fit the on-screen map to the current zoom
    }

    // Live preview. CROP mode is special: show the FULL image with the
    // cropped-away margins greyed out and a bright delimiter around the kept
    // region (the PNG export still outputs just the cropped whole-cell area).
    // EXPAND / no-fix paint the actual result.
    function renderDisplay() {
      if (!S.loaded) return;
      if (S.selecting) { renderSelectView(); return; }   // region-pick mode draws its own view
      if (S.drawMode) { renderDrawView(); return; }       // draw-cell mode draws its own view
      saveManual();   // keep the MANUAL state in localStorage in sync with the view
      const image = S.loaded.image, nW = image.naturalWidth, nH = image.naturalHeight;
      const L = computeLayout();
      if (L.win) {                              // MANUAL: window slid over the image
        const wx = L.win.x, wy = L.win.y, ww = L.win.w, wh = L.win.h;
        const ux0 = Math.min(0, wx), uy0 = Math.min(0, wy);
        const uW = Math.max(nW, wx + ww) - ux0, uH = Math.max(nH, wy + wh) - uy0;
        const scale = Math.min(1, DISPLAY_MAX / Math.max(uW, uH));
        S.dispScale = scale;
        const dW = Math.max(1, Math.round(uW * scale)), dH = Math.max(1, Math.round(uH * scale));
        mapC.width = dW; mapC.height = dH;
        const ctx = mapC.getContext('2d');
        ctx.clearRect(0, 0, dW, dH);
        const ix = Math.round((0 - ux0) * scale), iy = Math.round((0 - uy0) * scale);
        const iw = Math.round(nW * scale), ih = Math.round(nH * scale);
        ctx.drawImage(image, 0, 0, nW, nH, ix, iy, iw, ih);          // full image…
        ctx.fillStyle = 'rgba(8,8,10,0.64)';                         // …greyed (trimmed)
        ctx.fillRect(ix, iy, iw, ih);
        // render the window itself (image + selected fill in the off-image area)
        // through paint() so the preview matches the exported PNG exactly
        const off = document.createElement('canvas');
        paint(off, L, scale);
        const wX = Math.round((wx - ux0) * scale), wY = Math.round((wy - uy0) * scale);
        if (S.fillMode === 'transparent') ctx.clearRect(wX, wY, off.width, off.height);   // reveal the checkerboard through transparent padding
        ctx.drawImage(off, wX, wY);
        S.trimRect = { x: wX, y: wY, w: off.width, h: off.height }; S.showDelim = true; S.delimGrips = true;   // draggable delimiter
        if (L.hex) {
          // hex: feed trimMoveTo the hex step (dx,dy) + origin, and overlay hexes
          // mapped by the image origin (ix,iy). The delimiter snaps in WHOLE hexes
          // on the non-staggered axis and ½-hexes on the staggered one (flat → rows,
          // pointy → cols), so the offset edge cells crop cleanly.
          const geom = hexGeom(S.loaded.hexG, S.hexOrient);
          S.trimGeom = { ux0: ux0, uy0: uy0, scale: scale, cellW: geom.dx, cellH: geom.dy, baseX: S.loaded.hexOX, baseY: S.loaded.hexOY,
            snapC: S.hexOrient === 'pointy' ? 0.5 : 1, snapR: S.hexOrient === 'flat' ? 0.5 : 1 };
          drawHexOverlay(dW, dH, scale, ix, iy, L.hexWin);
        } else {
          const cellW = L.win.w / (S.winC1 - S.winC0), cellH = L.win.h / (S.winR1 - S.winR0);
          S.trimGeom = { ux0: ux0, uy0: uy0, scale: scale, cellW: cellW, cellH: cellH,
            baseX: L.win.x - S.winC0 * cellW, baseY: L.win.y - S.winR0 * cellH };
          drawGrid(L.vFrac, L.vOff, L.hFrac, L.hOff, dW, dH, { x: wX, y: wY, w: off.width, h: off.height });
        }
        setReadout(L.cols, L.rows, L.outW, L.outH);
        return;
      }
      if (fixEdges && (S.edgeMode === 'crop' || L.hex) && L.src) {
        const scale = Math.min(1, DISPLAY_MAX / Math.max(nW, nH));
        S.dispScale = scale;
        const dW = Math.max(1, Math.round(nW * scale)), dH = Math.max(1, Math.round(nH * scale));
        mapC.width = dW; mapC.height = dH;
        const ctx = mapC.getContext('2d');
        ctx.drawImage(image, 0, 0, dW, dH);
        const kx = L.src.x * scale, ky = L.src.y * scale, kw = L.src.w * scale, kh = L.src.h * scale;
        ctx.fillStyle = 'rgba(8,8,10,0.64)';      // grey out the cropped margins
        ctx.fillRect(0, 0, dW, ky);
        ctx.fillRect(0, ky + kh, dW, dH - (ky + kh));
        ctx.fillRect(0, ky, kx, kh);
        ctx.fillRect(kx + kw, ky, dW - (kx + kw), kh);
        tintCanvas(ctx, kx, ky, kw, kh);   // night tint on the kept region (matches the export)
        // hex has no draggable whole-cell window; show a static crop boundary only
        S.trimRect = { x: kx, y: ky, w: kw, h: kh }; S.trimGeom = null; S.showDelim = true; S.delimGrips = !L.hex;
        if (L.hex) drawHexOverlay(dW, dH, scale, 0, 0);
        else { const v = view(); drawGrid(v.vFrac, v.vOff, v.hFrac, v.hOff, dW, dH); }
        setReadout(L.cols, L.rows, L.outW, L.outH);
        return;
      }
      const scale = Math.min(1, DISPLAY_MAX / Math.max(L.outW, L.outH));
      S.dispScale = scale;
      const { w: dW, h: dH } = paint(mapC, L, scale);
      S.trimRect = { x: 0, y: 0, w: dW, h: dH }; S.trimGeom = null; S.showDelim = false;   // no delimiter box in this mode
      drawGrid(L.vFrac, L.vOff, L.hFrac, L.hOff, dW, dH);
      setReadout(L.cols, L.rows, L.outW, L.outH);
    }

    // PNG export = the same layout, scaled so each cell is `exportCellPx` px (native when 0).
    function exportCanvas() {
      const c = document.createElement('canvas');
      const L = computeLayout();
      paint(c, L, scaleFactorFor(L.cols, L.outW, L.outH));
      return { canvas: c, cols: L.cols, rows: L.rows };
    }

    // PNG export: re-encode (full-res) to PNG, named with the resulting size.
    if (exportBtn) exportBtn.addEventListener('click', () => {
      if (!S.loaded) return;
      const out = exportCanvas();
      out.canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const tinted = (S.nightMode && S.nightPotency > 0) ? '_tinted' : '';
        const px = S.exportCellPx ? ('_' + S.exportCellPx + 'px') : '';   // cell pixel size when scaled
        a.download = 'gridmap_' + Math.floor(Date.now() / 1000) + '_' + out.cols + 'x' + out.rows + px + tinted + '.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        const prev = exportBtn.textContent;
        exportBtn.textContent = t('saved');
        setTimeout(() => { exportBtn.textContent = prev; }, 1400);
      }, 'image/png');
    });

    // Copy the exported PNG to the clipboard. Uses a Promise<Blob> inside the
    // ClipboardItem so the write stays in the click gesture (Safari-safe).
    function flash(btn, key) {
      const prev = btn.textContent;
      btn.textContent = t(key);
      setTimeout(() => { btn.textContent = prev; }, 1400);
    }
    if (copyBtn) copyBtn.addEventListener('click', () => {
      if (!S.loaded) return;
      if (!(navigator.clipboard && window.ClipboardItem)) { flash(copyBtn, 'copyfail'); return; }
      try {
        const blobPromise = new Promise((resolve, reject) =>
          exportCanvas().canvas.toBlob((b) => b ? resolve(b) : reject(new Error('no blob')), 'image/png'));
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
          .then(() => flash(copyBtn, 'copied'))
          .catch(() => flash(copyBtn, 'copyfail'));
      } catch (e) { flash(copyBtn, 'copyfail'); }
    });

    // ---- Map-view zoom (display only — never affects detection or the export) ----
    // The SOURCE IMAGE fits the view at 100% and scales 10..300% from there;
    // click steps by 10%, press-and-hold sweeps the range; ↺ resets to 100%.
    // The scale is anchored to the (fixed) natural image size, NOT the canvas
    // buffer — so changing fill / running AUTO / recentring the window (which
    // resize the buffer) keeps a given zoom % visually constant. Padding or a
    // window that runs off the image extends past the view and is clipped.
    const zoomIn = $('zoomIn'), zoomOut = $('zoomOut'), zoomVal = $('zoomVal'), zoomReset = $('zoomReset');
    function applyZoom() {
      if (zoomVal) zoomVal.textContent = S.zoom + '%';
      if (!S.loaded || !mapC.width || !zone.clientWidth) return;
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      // 28 = ~14px breathing room each side so the delimiter's edge grips can
      // overhang past the map without being clipped at the viewport border.
      const fit = Math.min((zone.clientWidth - 28) / nW, (zone.clientHeight - 28) / nH) || 1;
      // fit is px-per-image-px; the buffer holds image px at dispScale, so divide
      // it back out to turn the buffer's pixel dimensions into on-screen size.
      const s = Math.max(0.02, (fit / S.dispScale) * S.zoom / 100);
      mapC.style.width = Math.round(mapC.width * s) + 'px';
      mapC.style.height = Math.round(mapC.height * s) + 'px';
      clampPan(); applyPan();
      drawTrimOverlay();   // repaint the crisp delimiter at the new display size
    }
    function setZoom(z) {
      S.zoom = Math.min(300, Math.max(10, Math.round(z)));
      save('gridmap:zoom', S.zoom);
      applyZoom();
    }
    // Pan: offset the (centred) canvas within the viewport, clamped so the map
    // can't be dragged off the visible area. Only meaningful when zoomed past fit.
    function clampPan() {
      const mx = Math.max(0, (mapC.offsetWidth - zone.clientWidth) / 2);
      const my = Math.max(0, (mapC.offsetHeight - zone.clientHeight) / 2);
      S.panX = Math.max(-mx, Math.min(mx, S.panX));
      S.panY = Math.max(-my, Math.min(my, S.panY));
      zone.classList.toggle('pannable', mx > 0.5 || my > 0.5);
    }
    function applyPan() {
      canvasWrap.style.transform = 'translate(calc(-50% + ' + Math.round(S.panX) + 'px), calc(-50% + ' + Math.round(S.panY) + 'px))';
    }
    // Zoom about a screen point (cursor): keep that point fixed as the map scales.
    function zoomAt(clientX, clientY, delta) {
      const next = Math.min(300, Math.max(10, Math.round(S.zoom + delta)));
      if (next === S.zoom) return;
      if (S.loaded) {
        const f = next / S.zoom, r = zone.getBoundingClientRect();
        S.panX += (1 - f) * (clientX - (r.left + r.width / 2) - S.panX);
        S.panY += (1 - f) * (clientY - (r.top + r.height / 2) - S.panY);
      }
      setZoom(next);   // applyZoom → clampPan → applyPan
    }
    function zoomCenter(delta) {
      const r = zone.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, delta);
    }
    function bindZoom(btn, delta) {
      if (!btn) return;
      btn.addEventListener('click', () => zoomCenter(delta));
      let to = null, iv = null;
      const stop = () => { clearTimeout(to); clearInterval(iv); to = iv = null; };
      btn.addEventListener('mousedown', () => { stop(); to = setTimeout(() => { iv = setInterval(() => zoomCenter(delta), 45); }, 350); });
      ['mouseup', 'mouseleave', 'blur'].forEach((ev) => btn.addEventListener(ev, stop));
    }
    bindZoom(zoomIn, 10);
    bindZoom(zoomOut, -10);
    if (zoomReset) zoomReset.addEventListener('click', () => { S.panX = S.panY = 0; setZoom(100); });
    window.addEventListener('resize', applyZoom);
    window.addEventListener('load', applyZoom);   // re-fit once CSS/layout is fully ready
    applyZoom();   // reflect the persisted zoom (sets the % label up front)

    // ---- Manual region select: pick the area(s) the detector should read ----
    // SELECT AREA enters draw mode; drag with LMB to box a clear grid patch.
    // Hold Ctrl on release to keep adding areas; release WITHOUT Ctrl runs the
    // detector on the picked area(s). All region maths is in image-natural px.
    function evToImage(e) {
      const r = mapC.getBoundingClientRect();
      const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      return { x: fx * S.loaded.image.naturalWidth, y: fy * S.loaded.image.naturalHeight };
    }
    function drawSelOverlay() {
      const dW = mapC.width, dH = mapC.height;
      gridC.width = dW; gridC.height = dH;
      const g = gridC.getContext('2d'); g.clearRect(0, 0, dW, dH);
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight;
      g.lineWidth = 2; g.strokeStyle = 'rgba(252,238,10,0.9)'; g.fillStyle = 'rgba(252,238,10,0.14)';
      (S.dragRect ? S.regions.concat([S.dragRect]) : S.regions).forEach((r) => {
        const x = r.x / nW * dW, y = r.y / nH * dH, w = r.w / nW * dW, h = r.h / nH * dH;
        g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h);
      });
    }
    function renderSelectView() {        // plain full image, so screen↔image mapping stays clean
      const image = S.loaded.image, nW = image.naturalWidth, nH = image.naturalHeight;
      const scale = Math.min(1, DISPLAY_MAX / Math.max(nW, nH));
      S.dispScale = scale;
      const dW = Math.max(1, Math.round(nW * scale)), dH = Math.max(1, Math.round(nH * scale));
      mapC.width = dW; mapC.height = dH;
      mapC.getContext('2d').drawImage(image, 0, 0, dW, dH);
      S.showDelim = false;   // no trim delimiter while picking a region
      drawSelOverlay();
      applyZoom();
    }
    function enterSelect() {
      S.selecting = true; S.cellMode = false; S.regions = []; S.dragRect = null; S.dragStart = null;
      S.drawMode = false; S.cellDrag = null; S.drawnCell = null; zone.classList.remove('drawing');   // leave draw-cell
      zone.classList.add('selecting');
      syncAutoMode(); renderDisplay();
    }
    function enterCellSelect() {                 // "4 cells": drag one box around a 2×2 block
      S.selecting = true; S.cellMode = true; S.regions = []; S.dragRect = null; S.dragStart = null;
      S.drawMode = false; S.cellDrag = null; S.drawnCell = null; zone.classList.remove('drawing');   // leave draw-cell
      zone.classList.add('selecting');
      syncAutoMode(); renderDisplay();
    }
    function exitSelect() {
      S.selecting = false; S.cellMode = false; S.regions = []; S.dragRect = null; S.dragStart = null;
      zone.classList.remove('selecting');
      syncAutoMode(); renderDisplay();
    }
    // SQUARE: box ≈ a 2×2 cell block → seed = box ÷ 2. HEX: box ≈ 3 tightly-grouped
    // hexes → g from the cluster geometry, lattice origin refined from the image.
    function runCellSeed(box) {
      S.selecting = false; S.cellMode = false; S.regions = []; S.dragRect = null; S.dragStart = null;
      zone.classList.remove('selecting');
      if (S.loaded.gridType === 'hex') {
        const g = hexGFromCluster(box, S.hexOrient);   // flat-to-flat size from the 3-hex cluster
        detectGrid(null, 0, 'hex', { g, orient: S.hexOrient });
      } else {
        const seed = (box.w / 2 + box.h / 2) / 2;   // square cell size in image px
        detectGrid(null, seed);                     // quincunx probe, period locked near `seed` ± margin
      }
      S.manual = false; S.gCols = S.loaded.cols; S.gRows = S.loaded.rows; S.offX = 0; S.offY = 0;
      applyAutoFix();
      syncAutoMode(); renderDisplay();
    }
    function runSelection() {
      const picked = S.regions.slice();
      S.selecting = false; S.cellMode = false; S.dragRect = null; S.dragStart = null; S.regions = [];
      if (selectBtn) selectBtn.classList.remove('active');
      zone.classList.remove('selecting');
      if (picked.length) {               // re-detect from the chosen area(s), back to AUTO
        detectGrid(picked);
        S.manual = false; S.gCols = S.loaded.cols; S.gRows = S.loaded.rows; S.offX = 0; S.offY = 0;
        applyAutoFix();
      }
      syncAutoMode(); renderDisplay();
    }
    if (selectBtn) selectBtn.addEventListener('click', () => { if (!S.loaded) return; (S.selecting && !S.cellMode) ? exitSelect() : enterSelect(); });
    if (cellBtn) cellBtn.addEventListener('click', () => { if (!S.loaded) return; (S.selecting && S.cellMode) ? exitSelect() : enterCellSelect(); });
    canvasWrap.addEventListener('mousedown', (e) => {
      if (!S.selecting || e.button !== 0) return;
      e.preventDefault();
      S.dragStart = evToImage(e); S.dragRect = { x: S.dragStart.x, y: S.dragStart.y, w: 0, h: 0 };
    });
    window.addEventListener('mousemove', (e) => {
      if (!S.selecting || !S.dragStart) return;
      const p = evToImage(e);
      S.dragRect = { x: Math.min(S.dragStart.x, p.x), y: Math.min(S.dragStart.y, p.y), w: Math.abs(p.x - S.dragStart.x), h: Math.abs(p.y - S.dragStart.y) };
      drawSelOverlay();
    });
    window.addEventListener('mouseup', (e) => {
      if (!S.selecting || !S.dragStart) return;
      const p = evToImage(e);
      const r = { x: Math.min(S.dragStart.x, p.x), y: Math.min(S.dragStart.y, p.y), w: Math.abs(p.x - S.dragStart.x), h: Math.abs(p.y - S.dragStart.y) };
      S.dragStart = null; S.dragRect = null;
      S.blockZoneClick = true; setTimeout(() => { S.blockZoneClick = false; }, 0);   // swallow the trailing click
      if (S.cellMode) {                                 // "4 cells": one box → seed the cell size
        if (r.w > 8 && r.h > 8) runCellSeed(r);
        else drawSelOverlay();                        // too small to measure — let them redraw
        return;
      }
      if (r.w > 4 && r.h > 4) S.regions.push(r);    // ignore stray clicks
      if (e.ctrlKey || e.metaKey) drawSelOverlay();   // keep adding areas
      else runSelection();                            // release without Ctrl → run
    });
    // ---- Edge trimmers + pan (both left-drag) -------------------------------
    // Grabbing within a few px of a kept-region edge resizes that edge, snapped
    // to whole grid cells — it drives the MANUAL window (drag inward to trim,
    // outward to extend into the fill). A drag anywhere else pans; a press that
    // doesn't move stays a click (grid toggle).
    let panStart = null, panMoved = false, trimDrag = null;
    const PAN_THRESHOLD = 4;   // px of movement before a press becomes a pan/trim
    const EDGE_GRAB = 9;       // px tolerance for grabbing an edge line
    function trimEdgesAt(cx, cy) {
      if (!S.trimRect || !mapC.width) return null;
      const r = mapC.getBoundingClientRect();
      const L = r.left + (S.trimRect.x / mapC.width) * r.width;
      const R = r.left + ((S.trimRect.x + S.trimRect.w) / mapC.width) * r.width;
      const T = r.top + (S.trimRect.y / mapC.height) * r.height;
      const B = r.top + ((S.trimRect.y + S.trimRect.h) / mapC.height) * r.height;
      const inX = cx >= L - EDGE_GRAB && cx <= R + EDGE_GRAB;
      const inY = cy >= T - EDGE_GRAB && cy <= B + EDGE_GRAB;
      const ed = { l: inY && Math.abs(cx - L) <= EDGE_GRAB, r: inY && Math.abs(cx - R) <= EDGE_GRAB,
                   t: inX && Math.abs(cy - T) <= EDGE_GRAB, b: inX && Math.abs(cy - B) <= EDGE_GRAB };
      return (ed.l || ed.r || ed.t || ed.b) ? ed : null;
    }
    function trimCursor(ed) {
      if ((ed.l && ed.t) || (ed.r && ed.b)) return 'nwse-resize';
      if ((ed.r && ed.t) || (ed.l && ed.b)) return 'nesw-resize';
      return (ed.l || ed.r) ? 'ew-resize' : 'ns-resize';
    }
    function trimMoveTo(cx, cy) {                 // snap the dragged edge(s) to the nearest grid step
      const d = trimDrag; if (!d || !d.ppi) return;
      const snapC = d.snapC || 1, snapR = d.snapR || 1;   // ½ on a hex staggered axis, else whole
      const cellX = Math.round(((cx - d.ox) / d.ppi - d.baseX) / d.cellW / snapC) * snapC;
      const cellY = Math.round(((cy - d.oy) / d.ppi - d.baseY) / d.cellH / snapR) * snapR;
      if (d.edges.l) S.winC0 = Math.min(cellX, S.winC1 - 1);
      if (d.edges.r) S.winC1 = Math.max(cellX, S.winC0 + 1);
      if (d.edges.t) S.winR0 = Math.min(cellY, S.winR1 - 1);
      if (d.edges.b) S.winR1 = Math.max(cellY, S.winR0 + 1);
      syncToggles();   // a hex extend/trim may push the window off-image → enable/disable FILL
      renderDisplay();
    }
    canvasWrap.addEventListener('mousedown', (e) => {
      if (S.selecting || S.drawMode || !S.loaded || e.button !== 0 || e.ctrlKey || e.metaKey) return;
      const ed = trimEdgesAt(e.clientX, e.clientY);
      if (ed) { trimDrag = { edges: ed, x: e.clientX, y: e.clientY, started: false }; e.preventDefault(); return; }
      panStart = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY };
      panMoved = false;
    });
    canvasWrap.addEventListener('mousemove', (e) => {   // hover affordance: resize cursor over an edge
      if (S.drawMode) {                                   // draw-cell: move/resize cursor over the cell, crosshair elsewhere
        if (S.cellDrag || !S.loaded) return;
        const hit = cellHitAt(e.clientX, e.clientY);
        canvasWrap.style.cursor = hit ? (hit.inside ? 'move' : trimCursor(hit.edges)) : 'crosshair';
        return;
      }
      if (trimDrag || panStart || S.selecting || !S.loaded) return;
      const ed = trimEdgesAt(e.clientX, e.clientY);
      canvasWrap.style.cursor = ed ? trimCursor(ed) : '';
    });
    window.addEventListener('mousemove', (e) => {
      if (trimDrag) {
        if (!trimDrag.started) {
          if (Math.hypot(e.clientX - trimDrag.x, e.clientY - trimDrag.y) < PAN_THRESHOLD) return;
          trimDrag.started = true;
          // hex is always windowed (no square MANUAL switch); square needs setManual()
          if (!S.manual && S.loaded.gridType !== 'hex') { setManual(); syncAutoMode(); renderDisplay(); }
          if (!S.trimGeom) { trimDrag = null; return; }
          // capture a FIXED image↔screen mapping for the whole drag (stable even
          // if extending the window resizes/recentres the canvas as it grows)
          const r = mapC.getBoundingClientRect();
          const ppi = r.width * S.trimGeom.scale / mapC.width;   // screen px per image px
          trimDrag.ppi = ppi;
          trimDrag.ox = r.left - S.trimGeom.ux0 * ppi;
          trimDrag.oy = r.top - S.trimGeom.uy0 * ppi;
          trimDrag.baseX = S.trimGeom.baseX; trimDrag.baseY = S.trimGeom.baseY;
          trimDrag.cellW = S.trimGeom.cellW; trimDrag.cellH = S.trimGeom.cellH;
          trimDrag.snapC = S.trimGeom.snapC; trimDrag.snapR = S.trimGeom.snapR;   // ½-hex on the staggered axis
          canvasWrap.style.cursor = trimCursor(trimDrag.edges);
        }
        e.preventDefault(); trimMoveTo(e.clientX, e.clientY);
        return;
      }
      if (!panStart) return;
      const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
      if (!panMoved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
      if (!panMoved) { panMoved = true; canvasWrap.style.cursor = 'grabbing'; }
      S.panX = panStart.px + dx; S.panY = panStart.py + dy;
      clampPan(); applyPan();
    });
    window.addEventListener('mouseup', () => {
      if (trimDrag) {
        const moved = trimDrag.started;
        trimDrag = null; canvasWrap.style.cursor = '';
        if (moved) { S.blockZoneClick = true; setTimeout(() => { S.blockZoneClick = false; }, 0); }
        return;
      }
      if (!panStart) return;
      panStart = null; canvasWrap.style.cursor = '';
      if (panMoved) { S.blockZoneClick = true; setTimeout(() => { S.blockZoneClick = false; }, 0); }   // swallow the trailing click (keep grid state)
    });

    // ---- DRAW CELL drag: draw a fresh cell on empty space, move the cell from
    // its interior, or resize it by an edge/corner. Every change re-tiles live.
    // Edges/corners snap to the image boundary (0,0)–(nW,nH) when within
    // SNAP_PX *screen* px, so the tiling lines up flush with the image. ----
    const SNAP_PX = 8;
    // SNAP_PX screen px expressed in image px (so the pull feels constant on
    // screen regardless of zoom/downscale). 0 if the mapping isn't ready.
    function drawSnapThresh() {
      const r = mapC.getBoundingClientRect();
      const screenPerImg = drawBufScale * (r.width / mapC.width);   // image px → screen px
      return screenPerImg > 0 ? SNAP_PX / screenPerImg : 0;
    }
    const snapTo = (v, target, thr) => Math.abs(v - target) <= thr ? target : v;   // pull v onto target within thr
    canvasWrap.addEventListener('mousedown', (e) => {
      if (!S.drawMode || e.button !== 0) return;
      e.preventDefault();
      if (document.activeElement && document.activeElement.classList.contains('coord-input')) document.activeElement.blur();   // let a drag write all fields live
      const p = evToDrawImage(e), hit = cellHitAt(e.clientX, e.clientY);
      if (!hit) {   // starting a fresh cell: snap the anchor corner to the image edge
        const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight, thr = drawSnapThresh();
        p.x = snapTo(snapTo(p.x, 0, thr), nW, thr);
        p.y = snapTo(snapTo(p.y, 0, thr), nH, thr);
      }
      if (hit && hit.edges) S.cellDrag = { mode: 'resize', edges: hit.edges, orig: Object.assign({}, S.drawnCell) };
      else if (hit && hit.inside) S.cellDrag = { mode: 'move', start: p, orig: Object.assign({}, S.drawnCell) };
      else S.cellDrag = { mode: 'new', start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 } };
    });
    window.addEventListener('mousemove', (e) => {
      if (!S.drawMode || !S.cellDrag) return;
      e.preventDefault();
      const p = evToDrawImage(e);
      const nW = S.loaded.image.naturalWidth, nH = S.loaded.image.naturalHeight, thr = drawSnapThresh();
      if (S.cellDrag.mode === 'new') {            // square: the side follows the larger drag delta
        p.x = snapTo(snapTo(p.x, 0, thr), nW, thr);   // snap the moving corner to the image edge
        p.y = snapTo(snapTo(p.y, 0, thr), nH, thr);
        const dx = p.x - S.cellDrag.start.x, dy = p.y - S.cellDrag.start.y, side = Math.max(Math.abs(dx), Math.abs(dy));
        S.cellDrag.rect = { x: dx < 0 ? S.cellDrag.start.x - side : S.cellDrag.start.x,
                          y: dy < 0 ? S.cellDrag.start.y - side : S.cellDrag.start.y, w: side, h: side };
      } else if (S.cellDrag.mode === 'move') {
        const o = S.cellDrag.orig;
        let nx = o.x + (p.x - S.cellDrag.start.x), ny = o.y + (p.y - S.cellDrag.start.y);
        nx = snapTo(nx, 0, thr); nx = Math.abs((nx + o.w) - nW) <= thr ? nW - o.w : nx;   // left side, then right side
        ny = snapTo(ny, 0, thr); ny = Math.abs((ny + o.h) - nH) <= thr ? nH - o.h : ny;   // top side, then bottom side
        S.drawnCell = { x: nx, y: ny, w: o.w, h: o.h, g: o.g };   // g preserved for hex; ignored for square
        applyDrawnCell();
      } else {   // resize — kept SQUARE; the fixed (opposite) edges anchor the cell
        const o = S.cellDrag.orig, ed = S.cellDrag.edges;
        p.x = snapTo(snapTo(p.x, 0, thr), nW, thr);   // snap the dragged edge/corner to the image edge
        p.y = snapTo(snapTo(p.y, 0, thr), nH, thr);
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        if (ed.l) x0 = p.x; if (ed.r) x1 = p.x; if (ed.t) y0 = p.y; if (ed.b) y1 = p.y;
        const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), horiz = ed.l || ed.r, vert = ed.t || ed.b;
        const side = (horiz && vert) ? Math.max(w, h) : (horiz ? w : h);   // corner: larger axis; edge: that axis
        const ax = ed.l ? Math.max(x0, x1) : Math.min(x0, x1);   // left moving → anchor the right edge
        const ay = ed.t ? Math.max(y0, y1) : Math.min(y0, y1);   // top moving → anchor the bottom edge
        S.drawnCell = clampDrawnCell({ x: ed.l ? ax - side : ax, y: ed.t ? ay - side : ay, w: side, h: side });
        applyDrawnCell();
      }
      renderDrawView();
    });
    window.addEventListener('mouseup', (e) => {
      if (!S.drawMode || !S.cellDrag) return;
      const cd = S.cellDrag; S.cellDrag = null;
      S.blockZoneClick = true; setTimeout(() => { S.blockZoneClick = false; }, 0);
      if (cd.mode === 'new') {
        const r = cd.rect;
        if (r.w > MIN_DRAW_CELL && r.h > MIN_DRAW_CELL) { S.drawnCell = clampDrawnCell(r); applyDrawnCell(); }
      }
      canvasWrap.style.cursor = '';
      syncAutoMode(); renderDrawView();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (S.drawMode) exitDraw(); else if (S.selecting) exitSelect();
    });

    // Restore the previously loaded map (re-runs analysis + overlay).
    IDB.get().then((blob) => { if (blob) load(blob, false); }).catch(() => {});
  })();
})(window.GM);

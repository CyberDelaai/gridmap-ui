// GRIDMAP shared namespace + tiny DOM helper. Loaded first; every other
// module attaches to window.GM.
window.GM = window.GM || {};
GM.$ = (id) => document.getElementById(id);

// Constants shared across modules (detection-only ones stay local to detect.js).
GM.const = {
  ANALYSIS_MAX: 3000,    // longest side used for the analysis pass (kept high so
                         // thin grid lines survive aggressive downscaling)
  DISPLAY_MAX: 1600,     // longest side of the on-screen canvas
  DEFAULT_CELL_PX: 70,   // fallback cell size (VTT-ish) when no grid is found
  SQRT3: Math.sqrt(3),   // hex math: flat-to-flat = √3 · side, vertex-to-vertex = 2 · side
};

// localStorage setter (silent if storage is blocked).
GM.save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// The single source of mutable working-area state. Feature modules alias this
// as `const S = GM.state;` and read/write S.<field>. Defaults below are the
// initial values; the restore pass in app.js overrides them from localStorage.
GM.state = {
  loaded: null,          // current map + detected grid geometry, for PNG export
  // GRID TYPE: 'square' (the detector pipeline) or 'hex' (manual, drawn cell).
  // hexOrient: 'flat' (hexes in columns, Foundry "Hexagonal Columns" / Roll20
  // Hex(V)) or 'pointy' (hexes in rows, "Hexagonal Rows" / Roll20 Hex(H)).
  // When loaded.gridType === 'hex', loaded carries hexG (flat-to-flat px),
  // hexOX/hexOY (origin = top-left of hex(0,0)'s bounding box, image px).
  gridType: 'square', hexOrient: 'flat',
  autoFill: '#808080',   // detected primary (border) colour of the current map
  edgeMode: 'crop', fillOverride: '', fillMode: 'vibrant',
  nightMode: false, nightColor: '#1c2c5e', nightPotency: 0.7,   // NIGHT MODE tint
  manual: false, winC0: 0, winR0: 0, winC1: 0, winR1: 0,        // MANUAL window (grid-cell indices)
  gCols: 0, gRows: 0,    // current grid cell counts (NN×MM)
  offX: 0, offY: 0,      // grid-origin nudge from the top-left (image px, sub-cell)
  zoom: 100,             // map-view scale, 10..300 (%)
  dispScale: 1,          // current canvas buffer's image-px→buffer-px downscale
  panX: 0, panY: 0,      // pan offset (px) of the zoomed map within the viewport
  trimRect: null,        // kept-region rect in canvas-buffer px (edge hit-testing)
  showDelim: false,      // whether the cyan delimiter box is shown
  delimGrips: true,      // draw chevron drag-grips on the delimiter
  trimGeom: null,        // MANUAL buffer↔image mapping for edge drags
  selecting: false, regions: [], dragStart: null, dragRect: null, blockZoneClick: false,  // region-pick
  cellMode: false,       // "4 cells" sub-mode of selecting
  drawMode: false, drawnCell: null, cellDrag: null,            // DRAW CELL (drawnCell in image px)
  exportCellPx: 0, exportCustom: false,   // EXPORT scale: target px per cell (0 = native)
  scaleAlgo: 'smooth',   // EXPORT resampling when enlarging: smooth | nearest | sharp
};

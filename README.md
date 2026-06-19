# GRIDMAP

**Cyberpunk Battle-Map Grid Detector** — a free, in-browser tool that reads the
grid off any battle-/region-map image and tells you its size (e.g. `23×54`).
Great for TTRPG game masters prepping maps for virtual tabletops.

Drop in a map and GRIDMAP analyses it locally (nothing is uploaded) and reports
the cell count. No build step, no backend — just open `index.html`.

## Features

- **Drop in a map** — drag-and-drop, paste, or click to upload an image into the
  central working area.
- **Automatic grid detection** — reports the cell count as `NN × MM`. Hover the
  map to reveal the detected grid as an overlay so you can sanity-check it.
- **Auto-estimate** — when an image has no clear grid, GRIDMAP estimates the most
  likely cell count instead (shown as `≈ NN × MM`).
- **Draw a cell** — when detection won't cooperate, draw one square cell by hand
  and GRIDMAP tiles it across the whole map. The cell stays adjustable — drag it
  to move the grid, or an edge/corner to resize.
- **Hex grids** — switch **GRID TYPE** to **HEX (H)** or **HEX (V)** for hexagonal
  maps (flat-top columns / pointy-top rows; the hex geometry and flat-to-flat grid
  size match Roll20 and Foundry's Hexagonal Columns/Rows). Draw one hex cell and GRIDMAP tiles hexagons across the
  map; the readout and PNG export use the hex column×row count, with cell-size
  scaling measured flat-to-flat (the VTT "grid size"). **EDGES** mode works for
  hex too — **CROP** keeps only whole hexes inside the image, **EXPAND** pads the
  edge hexes out and paints the chosen **FILL** into the off-image margin.
- **Export scaling** — scale the exported PNG so each cell is a chosen pixel size:
  VTT presets (Roll20 70px, Foundry 100/150px) or a custom value.

## How detection works

A square grid is a *periodic* pattern of full-length lines, so detection is a
1-D signal problem run separately on each axis:

1. **Profiles** — collapse the image into two 1-D "line-strength" signals (one
   per column, one per row) with a polarity-blind thin-line detector summed
   along the perpendicular axis. Full-length grid lines stack into evenly-spaced
   peaks; scattered map content stays background noise.
2. **Period → count** — autocorrelation finds the dominant repeat spacing; the
   cell count is `axisLength / period` (scale-invariant, so the analysis
   downscale doesn't affect the result).
3. **Subharmonic guard** — if half the period is also a strong peak, GRIDMAP
   locked onto every *other* line and steps down to the true spacing.
4. **Phase** — locates where the first line sits, so the hover overlay aligns
   with the real grid (and for the upcoming crop feature).
5. **Confidence gate** — weak periodicity falls back to estimating from a default
   cell size.

**Hex grids** are detected with a different cue: a gradient-orientation histogram
tells a square grid (edge energy at 0°/90°) from a hex grid, and flat-top (extra
energy at 60°/120°) from pointy-top (30°/150°). Once the type is known the hex
size is a 1-D problem again — a regular hex grid's flats repeat at half the hex
size, so `g = 2 × period` — and a coarse 2-D search lands the lattice origin on
the real edges. AUTO classifies square vs hex automatically; the GRID TYPE
dropdown (SQUARE / HEX (H) / HEX (V)) forces either type and orientation, falling
back to a hand-drawn hex when detection isn't confident.

## Planned / next

- **Crop to whole cells** — PNG export that trims partial outer cells so every
  exported cell is complete.
- **Sized filename** — the exported PNG named with its `NNxMM` grid size.
- **Detection controls** — sensitivity, manual grid override, origin nudge.

GRIDMAP *analyses* existing map images — there's no custom-map construction.

## Usage

Open `index.html` in any modern browser — there is no build step.

## Versioning

`X.Y.Z`, bumped with the helper script (keeps all three in-file version spots
in sync — the line-1 comment, the `#tagVersion` span, and the `VER` constant):

```
python3 bump_version.py {x|y|z}
```

## Built with

- [augmented-ui](https://augmented-ui.com/) — clipped/beveled cyberpunk panel styling
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) — UI typeface

## Support

If you find these tools useful, you can support development here: [boosty.to/cyberdelaai/donate](https://boosty.to/cyberdelaai/donate)

## License

[MIT](LICENSE) © 2026 CyberDelaai

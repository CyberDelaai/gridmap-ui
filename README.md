# GRIDMAP

**Cyberpunk Battle-Map Grid Detector** — a free, in-browser tool that reads the
grid off any battle-/region-map image and tells you its size (e.g. `23×54`).
Great for TTRPG game masters prepping maps for virtual tabletops.

> **Status: early scaffold.** The analyzer isn't wired up yet — this repo
> currently ships the shell (header, theming, SEO, icons, version tooling).

## Planned features

- **Drop in a map** — drag-and-drop (or paste / upload) an image into the
  central working area.
- **Grid detection** — find the map's grid lines and report the cell count as
  `NN × MM` at the top.
- **Auto-estimate** — when an image has no visible grid, guess the most likely
  cell count.
- **Crop to whole cells** — PNG export trims partial outer cells so every cell
  is complete.
- **Sized filename** — the exported PNG is named with its `NNxMM` grid size.

GRIDMAP *analyzes* existing map images — there's no custom-map construction.

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

## License

[MIT](LICENSE) © 2026 CyberDelaai

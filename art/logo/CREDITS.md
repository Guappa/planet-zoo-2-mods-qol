# Mike's QoL Toolbox logo (formerly PZ2QoL, then Genes & Gold): sources and licences

Everything in the logo is modelled procedurally by `build_logo.py` (the medallion, paw print,
magnifying glass, gems, ribbon, plaque and leaves). Only these third-party assets are used:

| Asset | File | Source | Licence |
| --- | --- | --- | --- |
| "Rainforest Trail" HDRI, by Dimitrios Savva (photography) and Jarod Guest (processing) | `assets/rainforest_trail_4k.hdr` | https://polyhaven.com/a/rainforest_trail | CC0 1.0 (public domain) |
| Lilita One font, by Juan Montoreano | `assets/LilitaOne-Regular.ttf` | https://fonts.google.com/specimen/Lilita+One | SIL Open Font License 1.1 (`assets/LilitaOne-OFL.txt`) |
| Barlow Condensed ExtraBold font, by Jeremy Tribby | `assets/BarlowCondensed-ExtraBold.ttf` | https://fonts.google.com/specimen/Barlow+Condensed | SIL Open Font License 1.1 (`assets/BarlowCondensed-OFL.txt`) |

Both fonts may be embedded in renders and redistributed under the OFL; the HDRI needs no credit,
but it is given here anyway.

## Rebuilding

```
blender -b --factory-startup -P art/logo/build_logo.py -- --res 2048 --samples 512 \
    --save art/logo/pz2qol_logo.blend --out art/logo/pz2qol_logo.png
blender -b --factory-startup -P art/logo/build_logo.py -- --res 2048 --samples 512 \
    --transparent --out art/logo/pz2qol_logo_transparent.png
blender -b --factory-startup -P art/logo/build_logo.py -- --res 1080 --width 1920 --samples 512 \
    --bg 0.4 --cam-dist -8.2 --out art/logo/pz2qol_header_1920x1080.png
```

Other options: `--hdri-rot`, `--hdri-tilt`, `--blur`, `--bg`, `--vignette`, `--exposure`,
`--cam-x`, `--cam-z`, `--cam-dist`, `--width`. Rendered with Blender 5.2 (Cycles, OptiX).

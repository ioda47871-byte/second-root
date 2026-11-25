# Demo display faces: provenance (DEV-303)

These are the font files `next/font/google` downloaded from Google Fonts at
build time for `components/demo/profile/fonts.ts`. They are committed so the
build needs no network. `fonts.generated.ts` loads them with `next/font/local`,
one `@font-face` per unicode-range subset, in Google's order and with Google's
descriptors (family, weight, style, stretch). A page still downloads only the
subsets of the characters it shows. The CSS variables, the fallback faces
(`../fonts-fallback.css`) and the preloads (only the latin subsets of Playfair
Display and Archivo) are the same as before.

## Fonts

The files were fetched from the Google Fonts CSS2 API with the request
`next/font/google` makes for the old options: the same URL, and its
User-Agent, which selects woff2. They are the woff2 subsets the API lists,
unmodified. `manifest.json` records each file's source URL, size and sha256.
When this was committed (2026-11-26), every file was byte-identical to the one
`next/font/google` emitted in a build of `develop`. A build from 2026-10-21 had
the same bytes too.

| Family | Request | Faces | Files | Size |
|---|---|---|---|---|
| Playfair Display | `Playfair+Display:ital,wght@0,400..900;1,400..900` | weight 400–900, normal and italic | 8 | 181 KiB |
| Archivo | `Archivo:wdth,wght@62..125,100..900` | weight 100–900, width 62–125% | 3 | 206 KiB |
| Zen Old Mincho | `Zen+Old+Mincho:wght@400;900` | 400, 900 | 244 | 5227 KiB |
| Zen Kaku Gothic New | `Zen+Kaku+Gothic+New:wght@400;900` | 400, 900 | 242 | 2739 KiB |
| M PLUS 1 | `M+PLUS+1:wght@100..900` | weight 100–900 | 119 | 2606 KiB |

Fontsource's npm packages have the same glyphs, outlines and unicode ranges,
but they are not used for the font files. Its variable-font files carry a small
hinting `prep` table that Google's files do not have, and that changes how
Chromium rasterizes Playfair Display, Archivo and M PLUS 1. A full-page pixel
comparison showed the change.

## License

All five families are licensed under the SIL Open Font License 1.1. Each
directory keeps a `LICENSE` file with the copyright notice and the full license
text. It is taken from the family's pinned Fontsource package; the package,
version, tarball sha256 and npm integrity are in `manifest.json` and in
`scripts/fonts/generate-demo-fonts.mjs`.

- Playfair Display: Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display".
- Archivo: Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)
- Zen Old Mincho: Copyright 2021 The Zen Old Mincho Project Authors (https://github.com/googlefonts/zen-oldmincho)
- Zen Kaku Gothic New: Copyright 2022 The Zen Project Authors (https://github.com/googlefonts/zen-kakugothic)
- M PLUS 1: Copyright 2021 The M+ FONTS Project Authors (https://github.com/coz-m/MPLUS_FONTS)

The same copyright notices are embedded in the font files. Do not subset or
otherwise modify these files. A modified Playfair Display could not keep its
Reserved Font Name.

## Regenerating

Regenerating needs network access to Google Fonts and the npm registry. If
Google now serves other bytes, the `--check` step and the unit test fail. In
that case, compare the new files and their rendering before accepting them.

```sh
mkdir -p /tmp/sr-font-packs && cd /tmp/sr-font-packs
npm pack @fontsource-variable/playfair-display@5.3.0 @fontsource-variable/archivo@5.3.0 \
  @fontsource/zen-old-mincho@5.3.1 @fontsource/zen-kaku-gothic-new@5.3.1 @fontsource-variable/m-plus-1@5.3.1
cd -   # back to the repository root
node scripts/fonts/generate-demo-fonts.mjs --packs /tmp/sr-font-packs
node scripts/fonts/generate-demo-fonts.mjs --check
```

The unit test `tests/unit/design-agent/demo-fonts-local.test.ts` runs the same
check offline.

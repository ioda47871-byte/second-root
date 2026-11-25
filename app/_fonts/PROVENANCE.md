# Official site faces: provenance (DEV-303)

These are the font files `next/font/google` downloaded from Google Fonts at
build time for `app/layout.tsx`. They are committed so the build needs no
network. `site-fonts.generated.ts` loads them with `next/font/local`, one
`@font-face` per unicode-range subset, in Google's order and with Google's
descriptors. A page still downloads only the subsets of the characters it
shows. Two things are copied unchanged from before:

- the CSS variables `--font-display`, `--font-body` and `--font-label`;
- the fallback faces, in `fallback.css`.

The folder name starts with `_`, which keeps it out of routing.

## Fonts

The files were fetched from the Google Fonts CSS2 API with the request
`next/font/google` makes for the old options: the same URL, and its
User-Agent, which selects woff2. They are the woff2 subsets the API lists,
unmodified. `manifest.json` records each file's source URL, size and sha256.
When this was committed (2026-11-26), every file was byte-identical to the one
`next/font/google` emitted in a build of `develop`.

| Family | Request | Faces | Files | Size |
|---|---|---|---|---|
| Shippori Mincho | `Shippori+Mincho:wght@400;600` | 400, 600 | 244 | 7303 KiB |
| Noto Sans JP | `Noto+Sans+JP:wght@400;500;600` | 400, 500, 600 | 124 | 5342 KiB |
| Zen Maru Gothic | `Zen+Maru+Gothic:wght@500;700` | 500, 700 | 244 | 4023 KiB |

For each unicode-range subset, Google lists one variable Noto Sans JP file
under 400, 500 and 600. It is committed once and declared three times, as
before.

## Preloads

`next/font/google` preloaded 243 files (about 5.6 MB) on every page: all 121
subsets of Shippori Mincho 600, 119 of Zen Maru Gothic 700, and the Latin
subsets. Google labels only the Latin, Cyrillic, … subsets in its CSS, and
`next/font` carries the last label onto the unlabelled Japanese subsets that
follow.

As the owner approved, only the Latin subsets the official pages use at first
view are now preloaded. The set was measured in Chromium on `/`, `/privacy`,
`/terms` and `/thanks`:

- Shippori Mincho 600, for headings: 28 KiB.
- Noto Sans JP, for body text: one 24 KiB file for its three weights.

Everything else loads on demand when a page uses it, as every Japanese subset
did.

## License

All three families are licensed under the SIL Open Font License 1.1. Each
directory keeps a `LICENSE` file with the license text, taken from the family's
pinned Fontsource package. The package, version, tarball sha256 and npm
integrity are in `manifest.json` and in `scripts/fonts/generate-site-fonts.mjs`.

- Shippori Mincho: Copyright 2021 The Shippori Mincho Project Authors (https://github.com/fontdasu/ShipporiMincho)
- Zen Maru Gothic: Copyright 2021 The Zen Maru Gothic Authors (https://github.com/googlefonts/zen-marugothic)
- Noto Sans JP: (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.

The Noto Sans JP package's `LICENSE` names only "Google Inc.", so
`noto-sans-jp/NOTICE` records the copyright notice embedded in the font files.

Do not subset or otherwise modify these files. A modified Noto Sans JP could
not keep the Reserved Font Name.

## Regenerating

Regenerating needs network access to Google Fonts and the npm registry. If
Google now serves other bytes, the `--check` step and the unit test fail. In
that case, compare the new files and their rendering before accepting them.

```sh
mkdir -p /tmp/sr-font-packs && cd /tmp/sr-font-packs
npm pack @fontsource/shippori-mincho@5.3.0 @fontsource-variable/noto-sans-jp@5.3.1 @fontsource/zen-maru-gothic@5.3.1
cd -   # back to the repository root
node scripts/fonts/generate-site-fonts.mjs --packs /tmp/sr-font-packs
node scripts/fonts/generate-site-fonts.mjs --check
```

The unit test `tests/unit/site-fonts-local.test.ts` runs the same check offline.

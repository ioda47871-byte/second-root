# Pages CMS: phone photos (Issue #380, PR 2)

Status: research and the current build's behaviour, 2026-11-27. LOCAL and SYNTHETIC only: no real photo, no account and
nothing uploaded. Nothing here has been tried on a real iPhone or in the real Pages CMS. Every claim names its source.
Anything not confirmed is marked **未検証 (unverified)**.

Tests: `tests/unit/experiments/pages-cms-phone-photos.test.ts`. Code: `experiments/pages-cms/photos.ts`
(`PHOTO_LIMITS`, `PHOTO_ADVICE`, `CONTENT_PHOTO_HEIC`) and `experiments/pages-cms/image-meta.ts` (`isHeif`).

## 1. What today's build does with an iPhone's photos

Limits (`PHOTO_LIMITS`): 2 MiB, longest side 4096 px, 16 MP, shortest side 320 px, ratio up to 3:1. JPEG, PNG and WebP
only. The build checks the header and the byte count; it never decodes or changes a picture.

| What the phone gives | Build result |
|---|---|
| 12 MP JPEG, 4032×3024 (or 3024×4032), 3 / 5 / 8 MB | `CONTENT_PHOTO_TOO_LARGE` (pixel size is fine: 12.2 MP; the byte limit fails) |
| the same at 2 MiB or less | passes |
| 48 MP JPEG, 8064×6048 | `CONTENT_PHOTO_DIMENSIONS` (even when the file is small) |
| 16:9 crop 4032×2268 | passes |
| panorama beyond 3:1 | `CONTENT_PHOTO_RATIO` |
| HEIC under a `.HEIC` name | `CONTENT_INVALID` on the content file (the content model accepts `.png/.jpg/.jpeg/.webp` paths only) |
| HEIC bytes under a `.jpg` name | `CONTENT_PHOTO_HEIC` (new in this PR; before, it was the generic `CONTENT_PHOTO_TYPE`) |

A stopped build writes nothing, so the last good page stays published (Cloudflare Pages keeps the last successful
deployment; Q2 is still to be confirmed on the real service).

**Conclusion.** On today's build, a full-size iPhone JPEG (the usual 2–5 MB) **stops the build**. The customer would
have to make the photo smaller themselves, which is the main problem for the 11/30 demonstration. PR 3 adds a
build-time resize in the delivery repository (§4).

## 2. Does iOS Safari turn HEIC into JPEG on upload?

Apple and WebKit have no official documentation of this. What follows is from WebKit's bug tracker (the engineers'
own descriptions of the code) and developer reports.

- Until early 2024, "on iOS, HEIC is unconditionally transcoded to JPEG" on file inputs. WebKit bug 267277,
  "[iOS] Avoid transcoding images on file inputs unless the set of image types is explicitly restricted" (fixed
  2024-03-05, 275726@main) changed iOS to match macOS: "this conversion only happens if the set of image types is
  restricted". https://bugs.webkit.org/show_bug.cgi?id=267277
- When the accepted types are restricted, "Safari will transcode the image to the first item in the list"
  (WebKit bug 292350, fixed 2026-02-18, 307797@main, which also brings drag and drop onto the same code path).
  https://bugs.webkit.org/show_bug.cgi?id=292350
- Developer reports: with `accept="image/*,image/heic"`, Safari 17 and later can do the opposite and convert JPEG or
  PNG to HEIC (Apple Developer Forums thread 743049, https://developer.apple.com/forums/thread/743049). A converted file
  can keep a `.heic` name with JPEG content (reported by other projects). The converted JPEG may lose its EXIF on iOS
  (WebKit bug 207088).

**What Pages CMS asks for.** Its upload button is an `<input type="file">` whose `accept` is the media configuration's
extensions, each with a leading dot, joined with commas. Source: `components/media/media-upload.tsx` in
https://github.com/pages-cms/pages-cms (main branch, read 2026-11-27). Our `.pages.yml` lists
`jpg, jpeg, png, webp` (and the upper-case forms), so the button sends `accept=".jpg,.jpeg,.png,.webp,..."`. That is a
restricted list without HEIC, with `.jpg` first.

**So, by WebKit's rule, Safari on a current iOS should hand Pages CMS a full-size JPEG when the customer picks a HEIC
photo.** This is **未検証**: it has not been tried on an iPhone. Which iOS release carries each WebKit fix is also
**未検証**. Before 275726, iOS converted every time anyway. In every case, the JPEG Safari produces is full resolution,
so it hits the 2 MiB limit (§1).

Other ways in, such as the Pages CMS drop zone, a desktop browser, or a file sent from the phone to a PC first, may keep
HEIC. Pages CMS then refuses it by extension (below). A HEIC renamed to `.jpg` reaches the build and stops it with
`CONTENT_PHOTO_HEIC`.

## 3. Does Pages CMS limit or resize uploads?

From the source (read 2026-11-27; it can change):

- **No size limit and no resizing, compression or conversion**, in the browser (`media-upload.tsx`) or on the server
  (`app/api/[owner]/[repo]/[branch]/files/[path]/route.ts`). The file is read as base64 and saved unchanged.
- **Extensions are checked**, in the browser (the file list is filtered by extension) and on the server ("Invalid
  extension … for media" when the media configuration lists extensions). A `.heic` file is refused.
- The file is written with GitHub's Contents API (`createOrUpdateFileContents`). GitHub's documentation states no size
  limit for creating a file. Reading a file between 1 and 100 MB works only with the raw media types.
  https://docs.github.com/en/rest/repos/contents
- The docs (https://pagescms.org/docs/configuration/media/) describe `extensions`, `categories` and `rename` and say
  nothing about size or resizing. They show an "Optimize images" button that runs a repository workflow; we do not use
  it (it would need GitHub Actions in the customer's repository).
- **未検証 risk:** the upload is one JSON request carrying base64, about 4/3 of the file's size. The hosted
  app.pagescms.org might have a request-size limit on its platform (some hosts cap a request at a few MB), which would
  refuse a large phone photo before our build sees it. Pages CMS's `next.config.mjs` sets no body limit. Where the
  hosted service runs, and its limit, are not known. Test with a 4–6 MB JPEG on the real trial.

**Related finding for PR 3 (fields a save drops).** `settings.content` defaults to "Rewrite the file from the configured
schema only". With `merge: true`, keys outside the schema are kept, but arrays from the editor replace the stored
arrays (https://pagescms.org/docs/configuration/settings/; `route.ts`: `mergeWith`, arrays replaced). So any field we
keep out of `.pages.yml` is lost the next time the customer saves that entry, for example a job photo's `imageKind`
(B, shop-provided) or a menu item's `shop_provided`. In practice, Second Root's B marking on an entry does not survive
a customer save, and the build then stops with `CONTENT_PHOTO_CLASS_MIXED`, keeping the last good page. To be handled
in PR 3: keep the B class with the picture's bytes (the B index already does) rather than with the entry.

## 4. The plan: build-time resize in the delivery repository (PR 3)

The standalone delivery repository template (PR 3, its own pinned `package.json`, nothing added to Second Root) adds a
step before the build:

- Customer pictures only: a picture whose SHA-256 is in the handover record of generated materials or in the B index
  is never touched, so the provenance checks still see the exact bytes.
- A JPEG, PNG or WebP over the limits, up to an intake ceiling, is turned upright by its EXIF orientation, resized to
  fit, and written in the same format under the same name in the build's working copy. The repository's original
  stays as uploaded. The result goes through the unchanged checks of §1.
- Metadata is dropped from every customer picture the page shows, because an iPhone JPEG can carry the GPS location of
  the shop or the owner's home.
- **HEIC is not converted.** sharp's prebuilt binaries do not read HEIC ("requires the use of a globally-installed
  libvips compiled with support for libheif, libde265 and x265", https://sharp.pixelplumbing.com/api-output/; the
  prebuilt formats listed at https://sharp.pixelplumbing.com/install do not include HEIC). The WebAssembly decoders
  (e.g. `heic-convert` 2.1.0, ISC, last published 2023-11-30) bring an HEVC decoder whose licensing we have not
  reviewed. HEIC should rarely arrive (§2, §3). When it does, the build stops with `CONTENT_PHOTO_HEIC` and the
  customer follows §5.

## 5. What the customer does (plain text: `PHOTO_ADVICE`)

- **Normal case:** choose the photo in Pages CMS from Safari on the iPhone. Safari is expected to send a JPEG
  (§2, 未検証). After PR 3 the build makes a large photo smaller by itself.
- **If a photo is refused as HEIC** (`CONTENT_PHOTO_HEIC`), or as a precaution before the trial: on the iPhone, go to
  「設定」→「カメラ」→「フォーマット」→「互換性優先」. New photos are then taken as JPEG. This is Apple's documented
  setting: Settings > Camera > Formats > Most Compatible, "Using HEIF or HEVC media on Apple devices",
  https://support.apple.com/en-us/116944. The Japanese labels are the iPhone's own (**未検証** on a device in this
  session). Photos already taken stay HEIC; send them as JPEG, for example through Safari as above.
- **Until PR 3 is live:** a photo over 2 MB is refused (`CONTENT_PHOTO_TOO_LARGE`). Today's CMS hint (`PHOTO_HINT`)
  suggests sending in 「中」 or 「大」 size. Whether Safari's photo picker offers that choice when uploading is
  **未検証**, so the hint should be reworded once the build-time resize exists.

The build only decides; this text only explains. Every refusal keeps the last good page.

## Sources (read 2026-11-27)

- WebKit bug 267277: https://bugs.webkit.org/show_bug.cgi?id=267277
- WebKit bug 292350: https://bugs.webkit.org/show_bug.cgi?id=292350
- Apple Developer Forums 743049: https://developer.apple.com/forums/thread/743049
- Pages CMS source, `components/media/media-upload.tsx`, `app/api/[owner]/[repo]/[branch]/files/[path]/route.ts`,
  `next.config.mjs`: https://github.com/pages-cms/pages-cms
- Pages CMS docs, media: https://pagescms.org/docs/configuration/media/; settings: https://pagescms.org/docs/configuration/settings/
- GitHub REST, repository contents: https://docs.github.com/en/rest/repos/contents
- Apple, "Using HEIF or HEVC media on Apple devices": https://support.apple.com/en-us/116944
- sharp, output formats: https://sharp.pixelplumbing.com/api-output/; installation: https://sharp.pixelplumbing.com/install
- Cloudflare Pages build image (for PR 3): https://developers.cloudflare.com/pages/configuration/build-image/

# Crop → Cloudinary

A web app for cropping huge images in the browser and uploading the result to Cloudinary at a width of 1280px. The frontend is static, and a single PHP file handles the upload.

- Drop (or paste, or pick) any image: JPG, PNG, WebP, AVIF, GIF, or TIFF. Files of 100 MB+ are fine. The image is decoded locally, and nothing is uploaded until you click **Upload**.
- Aspect ratio presets: **4:5**, **1:1**, **5:4**, **Free**, and **Custom** (any ratio, decimals allowed, such as `1.91:1`).
- Output is a JPEG at quality 90, **1280px wide**. Crops narrower than 1280px keep their own width and are never upscaled.
- After uploading (through the PHP backend), the Cloudinary URL is copied to your clipboard. Recent uploads are listed in the sidebar.

## 1. Backend setup (PHP)

The browser sends the cropped JPEG to `api/upload.php`. That script signs the request with your Cloudinary API secret and uploads the image, so the secret never reaches the browser.

**Requirements:** PHP 7.4 or newer with the `curl` extension. Almost every shared host meets this.

1. Copy `api/config.example.php` to `api/config.php` and fill in:
   - `cloud_name`, `api_key`, `api_secret`: from Cloudinary Console → Settings → API Keys.
   - `folder`: the Media Library folder for uploads, or `''` for the root.
   - Optionally, `rate_limit_per_hour` (default 60 uploads per IP) and `max_bytes`.
2. Upload the whole folder to your hosting, `api/config.php` included. That's it: the app needs no login or setup.

Uploaded files are named after the original file, plus a random suffix to keep them unique, for example `my-photo-1280w_ab12cd.jpg`. Existing files are never overwritten.

### Security

There is no password. `upload.php` uses layered checks instead, so the endpoint can't be abused for much beyond what the app itself does:

- **Same site only.** The request's `Origin` (or `Referer`) must be the site hosting the app. This stops other websites from using your endpoint through their visitors' browsers.
- **A custom header is required** (`X-Requested-With: imgcropper`). Browsers can't send it from another site unless the server approves, and it only does so for `allowed_origin`.
- **Per-IP rate limit:** 60 uploads an hour by default. Counters are stored in `api/.ratelimit/`, which blocks web access to itself.
- **Strict uploads:** only JPEG or PNG images at most 1280px wide and 10 MB, which is exactly what the app produces. All Cloudinary options (folder, naming, no overwriting) are fixed on the server, and the API secret never leaves it.
- **Kept out of search engines** with `noindex` (meta tag and `X-Robots-Tag` header) and a `robots.txt` that disallows everything.

Someone who finds the URL and scripts requests with `curl` can fake the first two checks. They would still be limited to small JPEGs, at the rate limit, into your folder. For a tool on an obscure host that's a reasonable trade-off. If you ever need more, put the site behind your host's password protection (HTTP basic auth); your browser then remembers the login.

Other notes:
- `api/.htaccess` blocks direct access to `config.php` on Apache. Even without it, requesting `config.php` returns an empty page, because PHP runs the file rather than displaying it.
- To be extra safe, you can move `config.php` outside your web root and change the `$configFile` path in `upload.php`.
- `api/.user.ini` raises PHP's upload limit to 16 MB, because the default 2 MB can be too small for very tall crops. Most hosts honour this file. If yours doesn't, set `upload_max_filesize` in your hosting control panel.

### Backend on a different domain

If the app and `upload.php` are on different domains, do two things:
- Set `allowed_origin` in `config.php` to the app's origin, for example `https://cropper.example.com`.
- Set `UPLOAD_ENDPOINT` near the top of `app.js` to the full URL, for example `https://myhost.com/cropper/api/upload.php`.

## 2. Run locally

```sh
cp api/config.example.php api/config.php   # then edit it
php -S localhost:8000
# open http://localhost:8000
```

PHP's built-in server serves both the app and the API. Note that the TIFF decoder doesn't work if you open `index.html` directly from disk (`file://`).

## Controls

| Action | How |
| --- | --- |
| Move crop | Drag inside the box, or use arrow keys (Shift = ×10) |
| Resize | Drag the corner or edge handles |
| New crop | Drag on the darkened area |
| Maximize crop | Double-click the box |
| Upload | Button, or ⌘/Ctrl + Enter |

## Colour management

Marketing files often carry wide-gamut or print profiles: Adobe RGB, ProPhoto, Display P3, CMYK, Gray, often at 16 bits. Shown or emailed without proper conversion, they look washed out or shift in colour. Email clients often ignore embedded profiles, so the only safe output is **pixels converted to sRGB, with the file also tagged as sRGB**. That's what the app produces:

1. `decode-worker.js` reads the embedded ICC profile from JPEG, PNG, TIFF and WebP files.
2. If the profile isn't sRGB, the worker decodes the raw pixel values itself and converts them to sRGB with **LittleCMS**, the colour engine used by GIMP, ImageMagick and Krita. It uses relative colorimetric intent with black point compensation, which is Photoshop's default for "Convert to Profile". This gives the same result in every browser instead of depending on each browser's colour handling, and it covers TIFFs, which browsers don't colour-manage at all.
3. Untagged and sRGB files skip the conversion, because every browser and email client already treats them as sRGB.
4. Every exported JPEG has a compact sRGB v2 ICC profile embedded (456 bytes), replacing whatever the browser would otherwise write.

The sidebar's **Colour** row shows what was detected, for example "Adobe RGB (1998) → sRGB". A warning appears when exact conversion isn't possible:
- **CMYK files without an embedded profile:** colours are approximate, so ask for a version with a profile, or one converted to sRGB.
- **A profile that doesn't match the image data**, such as a CMYK profile on an RGB image: the profile is ignored.
- **Rare JPEG variants** (arithmetic-coded, 12-bit, lossless): these fall back to the browser's own colour management, which is correct in Chrome, Edge and Safari.

**Accuracy test:** test images in sRGB, Adobe RGB, ProPhoto, Display P3, Generic CMYK and Gray Gamma 2.2 were used, as 8- and 16-bit JPEG, PNG and TIFF (both byte orders, with and without alpha). Each output was compared with ImageMagick/LittleCMS reference conversions, and all were within 2 levels out of 255 after cropping and resizing to 1280px. Before this change, TIFFs were off by up to 169 levels.

**Speed:** converting a 48-megapixel image takes about 2 s for Adobe RGB JPEG, about 4 s for 16-bit ProPhoto TIFF and about 7 s for CMYK JPEG. Files that need no conversion open at native browser speed.

## Notes and limits

- Downscaling is done in successive halvings on canvas for clean, alias-free results.
- EXIF orientation (and the TIFF orientation tag) is applied automatically. Transparent areas are filled with #F9F9F9 by default. A small **Background** row (swatch and hex field) appears under Dimensions only for images with transparency; your choice is remembered, and "reset" returns to #F9F9F9. The preview shows the fill live. Tick **transparent** in that row to keep the transparency instead. The output is then a PNG, tagged sRGB, because JPEG can't store transparency; PNG works in all email clients, unlike WebP, but files are larger.
- TIFF support comes from the bundled [UTIF.js](https://github.com/photopea/UTIF.js): uncompressed, LZW, Deflate, PackBits and JPEG compression; 8- and 16-bit RGB, Gray and CMYK, with or without alpha. Exotic TIFFs (32-bit float, planar CMYK) may not decode or may not be colour-converted; a warning is shown in that case.
- HEIC and AVIF open only where the browser supports them (HEIC: Safari), and use the browser's colour management.
- Very large images use a lot of memory (about 4 bytes per pixel, so a 100-megapixel image needs about 400 MB). Desktop browsers handle this fine.
- If you serve the app from Apache, the root `.htaccess` makes sure `.wasm` files get the right MIME type.

## Files

- `index.html`, `styles.css`, and `app.js`: the app
- `decode-worker.js`: reads ICC profiles, decodes files and converts them to sRGB (runs off the main thread)
- `api/upload.php`: the signed upload endpoint. `api/config.example.php` is the config template.
- `vendor/`: bundled libraries, so no CDN is needed:
  - `lcms.js` and `lcms.wasm`: LittleCMS 2.16 compiled to WebAssembly ([lcms-wasm](https://github.com/mattdesl/lcms-wasm) 1.0.5, MIT)
  - `jpeg-decoder.js`: [jpeg-js](https://github.com/jpeg-js/jpeg-js) 0.4.4 decoder (BSD-3-Clause). Patched to expose raw CMYK/RGB samples and to round instead of truncate.
  - `UTIF.js`: [UTIF.js](https://github.com/photopea/UTIF.js) 3.1.0 (MIT)
  - `UPNG.js`: [UPNG.js](https://github.com/photopea/UPNG.js) 2.1.0 (MIT). Patched to run in a worker.
  - `pako_inflate.min.js`: [pako](https://github.com/nodeca/pako) 1.0.11 inflate (MIT)
  - `sRGB-v2-micro.icc`: compact sRGB profile from [Compact-ICC-Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles) (CC0)

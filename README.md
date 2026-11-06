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
   - `access_key`: a long random string. Generate one with `php -r 'echo bin2hex(random_bytes(24));'`.
     The app must send this key, which stops anyone else from using your endpoint to upload to your account.
2. Upload the whole folder to your hosting, `api/config.php` included.
3. Open the app, click **⚙ Settings**, and paste the access key. Leave the endpoint as `api/upload.php`.
   The key is saved in that browser's localStorage.

Uploaded files are named after the original file, plus a random suffix to keep them unique, for example `my-photo-1280w_ab12cd.jpg`. Existing files are never overwritten.

### Security notes

- `api/.htaccess` blocks direct access to `config.php` on Apache. Even without it, requesting `config.php` returns an empty page, because PHP runs the file rather than displaying it.
- To be extra safe, you can move `config.php` outside your web root and change the `$configFile` path at the top of `upload.php`.
- `api/.user.ini` raises PHP's upload limit to 16 MB, because the default 2 MB can be too small for very tall crops. Most hosts honour this file. If yours doesn't, set `upload_max_filesize` in your hosting control panel.

### Backend on a different domain

If the app and `upload.php` are on different domains, do two things:
- Set `allowed_origin` in `config.php` to the app's origin, for example `https://cropper.example.com`.
- Enter the full endpoint URL in ⚙ Settings, for example `https://myhost.com/cropper/api/upload.php`.

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

## Notes and limits

- Downscaling is done in successive halvings on canvas for clean, alias-free results.
- EXIF orientation is applied automatically. Transparency is flattened onto white.
- TIFFs are decoded natively in Safari. Other browsers use the bundled [UTIF.js](https://github.com/photopea/UTIF.js) (uncompressed, LZW, Deflate, PackBits, and JPEG-compressed TIFFs, 8- and 16-bit RGB/grayscale). Exotic TIFFs (some CMYK and 32-bit float files) may not decode.
- HEIC opens only in Safari.
- Very large images use a lot of memory (about 4 bytes per pixel, so a 100-megapixel image needs about 400 MB). Desktop browsers handle this fine.

## Files

- `index.html`, `styles.css`, and `app.js`: the app
- `api/upload.php`: the signed upload endpoint. `api/config.example.php` is the config template.
- `tiff-worker.js`: decodes TIFFs off the main thread
- `vendor/`: UTIF.js 3.1.0 and pako 1.0.11 (inflate only), bundled so no CDN is needed

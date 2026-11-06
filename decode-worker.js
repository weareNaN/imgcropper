// Decode worker (ES module).
//
// Goal: colours must survive no matter which ICC profile the source file uses
// (Adobe RGB, ProPhoto, Display P3, CMYK, Gray, 16-bit…). Browsers disagree on how
// (and whether) they apply embedded profiles, and none of them do it for TIFF, so for any
// file with a non-sRGB profile we decode the *raw* samples ourselves and convert them to
// sRGB with LittleCMS. Files that are untagged or already sRGB go back to the fast native
// browser decoder (untagged = sRGB everywhere).
//
// Request:  ArrayBuffer of the file + { name, type }
// Response: { kind: 'pixels', width, height, data (RGBA ArrayBuffer), color }
//         | { kind: 'browser', color }
//         | { error }
// color = { profile: string|null, space: string|null, converted: bool, warning?: string }

import { instantiate } from './vendor/lcms.js';
import './vendor/pako_inflate.min.js';   // must load before UTIF/UPNG (they read self.pako)
import './vendor/UTIF.js';
import './vendor/UPNG.js';
import './vendor/jpeg-decoder.js';

const PT_GRAY = 3, PT_RGB = 4, PT_CMYK = 6;
const TYPE_RGB_8 = (PT_RGB << 16) | (3 << 3) | 1;
const INTENT_RELATIVE_COLORIMETRIC = 1;
const cmsFLAGS_BLACKPOINTCOMPENSATION = 0x2000;
const cmsFLAGS_NOOPTIMIZE = 0x0100;
const cmsInfoDescription = 0;
const CHUNK_PIXELS = 1 << 20; // transform in strips to keep the WASM heap small

const fmt = (pt, channels, extra, bytes, swapEndian = false) =>
  (pt << 16) | ((swapEndian ? 1 : 0) << 11) | (extra << 7) | (channels << 3) | bytes;

let lcmsPromise = null;
const getLcms = () => (lcmsPromise ||= instantiate());

// ---------------------------------------------------------------- ICC helpers

async function inspectProfile(icc) {
  const lcms = await getLcms();
  const h = lcms.cmsOpenProfileFromMem(icc, icc.length);
  if (!h) return null;
  const name = (lcms.cmsGetProfileInfoASCII(h, cmsInfoDescription, 'en', 'US') || '').trim() || 'Unnamed profile';
  const space = lcms.cmsGetColorSpaceASCII(h); // 'RGB' | 'GRAY' | 'CMYK' | …
  lcms.cmsCloseProfile(h);
  // Profiles that are sRGB in all but name/version are left to the browser (no conversion needed).
  const isSRGB = space === 'RGB' && /\bsRGB\b|IEC\s*61966-2[.-]1/i.test(name) && !/linear|scRGB|e-?sRGB/i.test(name);
  return { name, space, isSRGB };
}

/**
 * Converts raw pixel samples to sRGB RGBA8 with LittleCMS.
 * src: Uint8Array of interleaved samples, inFormat: lcms pixel format, bpp: bytes per pixel,
 * alphaAt: byte offset of the alpha sample within a pixel (or -1).
 */
async function toSRGB(icc, src, inFormat, bpp, pixelCount, alphaAt = -1, profileName = '') {
  const lcms = await getLcms();
  self.postMessage({ stage: `Converting ${profileName || 'colour profile'} → sRGB…` });
  // LittleCMS normally speeds things up with precomputed lookup grids. For 8-bit RGB/Gray it
  // uses an exact matrix-shaper path, but for 16-bit input and CMYK/LUT profiles the grid
  // interpolation drifts by up to ~20 levels on saturated colours near the sRGB gamut edge.
  // Measured against ImageMagick/LittleCMS reference conversions, NOOPTIMIZE keeps every case
  // within 1 level, at roughly 1.5× the time, so use it wherever the fast path isn't exact.
  const space = (inFormat >> 16) & 31;
  const is8bit = (inFormat & 7) === 1;
  const exactFast = is8bit && (space === PT_RGB || space === PT_GRAY);
  const flags = cmsFLAGS_BLACKPOINTCOMPENSATION | (exactFast ? 0 : cmsFLAGS_NOOPTIMIZE);
  const hIn = lcms.cmsOpenProfileFromMem(icc, icc.length);
  if (!hIn) throw new Error('Unreadable ICC profile');
  const hOut = lcms.cmsCreate_sRGBProfile();
  const xf = lcms.cmsCreateTransform(hIn, inFormat, hOut, TYPE_RGB_8, INTENT_RELATIVE_COLORIMETRIC, flags);
  lcms.cmsCloseProfile(hIn);
  lcms.cmsCloseProfile(hOut);
  if (!xf) throw new Error('LittleCMS could not build a transform for this profile');

  const out = new Uint8ClampedArray(pixelCount * 4);
  const chunk = Math.min(CHUNK_PIXELS, pixelCount);
  const inPtr = lcms._malloc(chunk * bpp);
  const outPtr = lcms._malloc(chunk * 3);
  try {
    for (let p = 0; p < pixelCount; p += chunk) {
      const n = Math.min(chunk, pixelCount - p);
      lcms.HEAPU8.set(src.subarray(p * bpp, (p + n) * bpp), inPtr);
      lcms._cmsDoTransform(xf, inPtr, outPtr, n);
      const heap = lcms.HEAPU8; // re-read: the heap view may be replaced when memory grows
      let o = p * 4, s = outPtr;
      for (let i = 0; i < n; i++) {
        out[o] = heap[s]; out[o + 1] = heap[s + 1]; out[o + 2] = heap[s + 2];
        out[o + 3] = alphaAt >= 0 ? src[(p + i) * bpp + alphaAt] : 255;
        o += 4; s += 3;
      }
    }
  } finally {
    lcms._free(inPtr);
    lcms._free(outPtr);
    lcms.cmsDeleteTransform(xf);
  }
  return out;
}

// ---------------------------------------------------------------- orientation

// Applies an EXIF/TIFF orientation (1–8) to an RGBA buffer.
function orient(rgba, w, h, o) {
  if (!o || o === 1 || o > 8) return { data: rgba, width: w, height: h };
  const src = new Uint32Array(rgba.buffer);
  const swap = o >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const dst = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx, sy;
      switch (o) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        case 8: sx = w - 1 - y; sy = x; break;
      }
      dst[y * W + x] = src[sy * w + sx];
    }
  }
  return { data: new Uint8ClampedArray(dst.buffer), width: W, height: H };
}

function exifOrientation(exif) {
  // exif: bytes starting at the TIFF header ("II*\0" / "MM\0*")
  try {
    const dv = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
    const le = dv.getUint16(0) === 0x4949;
    const ifd = dv.getUint32(4, le);
    const count = dv.getUint16(ifd, le);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le);
    }
  } catch {}
  return 1;
}

// ---------------------------------------------------------------- container parsing

const ascii = (u8, start, len) => String.fromCharCode(...u8.subarray(start, start + len));

function scanJpeg(u8) {
  const iccParts = [];
  let exif = null, components = 0, i = 2;
  while (i + 4 <= u8.length) {
    if (u8[i] !== 0xFF) { i++; continue; }
    const marker = u8[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0xFF) { i += marker === 0xFF ? 1 : 2; continue; }
    if (marker === 0xDA || marker === 0xD9) break; // start of scan / end of image
    const len = (u8[i + 2] << 8) | u8[i + 3];
    const seg = i + 4;
    if (marker === 0xE2 && ascii(u8, seg, 12) === 'ICC_PROFILE\0') {
      iccParts.push({ seq: u8[seg + 12], data: u8.subarray(seg + 14, i + 2 + len) });
    } else if (marker === 0xE1 && ascii(u8, seg, 6) === 'Exif\0\0') {
      exif = u8.subarray(seg + 6, i + 2 + len);
    } else if ((marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      components = u8[seg + 5];
    }
    i += 2 + len;
  }
  let icc = null;
  if (iccParts.length) {
    iccParts.sort((a, b) => a.seq - b.seq);
    const total = iccParts.reduce((n, p) => n + p.data.length, 0);
    icc = new Uint8Array(total);
    let o = 0;
    for (const p of iccParts) { icc.set(p.data, o); o += p.data.length; }
  }
  return { icc, orientation: exif ? exifOrientation(exif) : 1, components };
}

function scanPng(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 8, icc = null, srgbChunk = false;
  while (i + 8 <= u8.length) {
    const len = dv.getUint32(i), type = ascii(u8, i + 4, 4), data = i + 8;
    if (type === 'iCCP') {
      let z = data; while (u8[z] !== 0 && z < data + 80) z++; // profile name, NUL-terminated
      icc = self.pako.inflate(u8.subarray(z + 2, data + len)); // skip NUL + compression method
    } else if (type === 'sRGB') srgbChunk = true;
    else if (type === 'IDAT' || type === 'IEND') break;
    i = data + len + 4;
  }
  return { icc, srgbChunk };
}

function scanWebp(u8) {
  if (ascii(u8, 0, 4) !== 'RIFF' || ascii(u8, 8, 4) !== 'WEBP') return { icc: null };
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 12;
  while (i + 8 <= u8.length) {
    const type = ascii(u8, i, 4), len = dv.getUint32(i + 4, true);
    if (type === 'ICCP') return { icc: u8.slice(i + 8, i + 8 + len) };
    i += 8 + len + (len & 1);
  }
  return { icc: null };
}

function sniff(u8, name) {
  if (u8[0] === 0xFF && u8[1] === 0xD8) return 'jpeg';
  if (u8[0] === 0x89 && ascii(u8, 1, 3) === 'PNG') return 'png';
  if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42) || (u8[0] === 0x4D && u8[1] === 0x4D && u8[3] === 42)) return 'tiff';
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return 'webp';
  return /\.tiff?$/i.test(name) ? 'tiff' : 'other';
}

// ---------------------------------------------------------------- format handlers

const PT_FOR = { RGB: PT_RGB, GRAY: PT_GRAY, CMYK: PT_CMYK };
const CHANNELS_FOR = { RGB: 3, GRAY: 1, CMYK: 4 };

async function handleJpeg(u8) {
  const { icc, orientation, components } = scanJpeg(u8);
  const prof = icc ? await inspectProfile(icc) : null;
  const dataSpace = components === 1 ? 'GRAY' : components === 4 ? 'CMYK' : 'RGB';

  if (!prof) {
    return { kind: 'browser', color: {
      profile: null, space: dataSpace, converted: false,
      warning: components === 4 ? 'CMYK image without an embedded colour profile: colours are approximate. Ask for a version with an embedded profile, or one converted to sRGB.' : undefined,
    } };
  }
  if (prof.isSRGB) return { kind: 'browser', color: { profile: prof.name, space: 'RGB', converted: false } };
  if (prof.space !== dataSpace) {
    return { kind: 'browser', color: { profile: prof.name, space: dataSpace, converted: false,
      warning: `The embedded profile (${prof.name}, ${prof.space}) doesn't match the image data (${dataSpace}), so it was ignored.` } };
  }

  self.postMessage({ stage: 'Decoding JPEG…' });
  const jpg = new self.JpegImage();
  jpg.opts = { tolerantDecoding: true, maxResolutionInMP: 2000, maxMemoryUsageInMB: 8192 };
  self.JpegImage.resetMaxMemoryUsage(8192 * 1024 * 1024);
  try {
    jpg.parse(u8);
  } catch (err) {
    // Rare JPEG variants (arithmetic coding, 12-bit, lossless) — fall back to the browser,
    // which still applies the embedded profile in Chrome, Edge and Safari.
    return { kind: 'browser', color: { profile: prof.name, space: prof.space, converted: true,
      warning: `This JPEG variant couldn't be decoded for exact colour conversion (${err.message || err}); the browser's colour management was used instead.` } };
  }
  const w = jpg.width, h = jpg.height, n = jpg.components.length;
  const raw = jpg.getData(w, h); // raw samples: Gray / RGB / CMYK (ink values, Adobe inversion handled)
  const rgba = await toSRGB(icc, raw, fmt(PT_FOR[prof.space], n, 0, 1), n, w * h, -1, prof.name);
  const o = orient(rgba, w, h, orientation);
  return { kind: 'pixels', ...o, color: { profile: prof.name, space: prof.space, converted: true } };
}

async function handlePng(u8) {
  const { icc, srgbChunk } = scanPng(u8);
  const prof = icc ? await inspectProfile(icc) : null;
  if (!prof || prof.isSRGB || srgbChunk) {
    return { kind: 'browser', color: { profile: prof ? prof.name : (srgbChunk ? 'sRGB' : null), space: 'RGB', converted: false } };
  }
  if (prof.space !== 'RGB' && prof.space !== 'GRAY') {
    return { kind: 'browser', color: { profile: prof.name, space: prof.space, converted: false, warning: `Unsupported PNG profile colour space (${prof.space}); it was ignored.` } };
  }
  self.postMessage({ stage: 'Decoding PNG…' });
  const img = self.UPNG.decode(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  const w = img.width, h = img.height;

  // 16-bit Gray/GrayA/RGB/RGBA: feed the raw big-endian samples to LittleCMS (full precision).
  const CH16 = { 0: [1, 0], 4: [1, 1], 2: [3, 0], 6: [3, 1] }; // ctype -> [colour channels, alpha]
  const want = prof.space === 'RGB' ? 3 : 1;
  if (img.depth === 16 && CH16[img.ctype] && CH16[img.ctype][0] === want) {
    const [base, extra] = CH16[img.ctype];
    const raw = new Uint8Array(img.data);
    const bpp = (base + extra) * 2;
    if (raw.length >= w * h * bpp) {
      const inFmt = fmt(prof.space === 'RGB' ? PT_RGB : PT_GRAY, base, extra, 2, true);
      const rgba = await toSRGB(icc, raw, inFmt, bpp, w * h, extra ? base * 2 : -1, prof.name);
      return { kind: 'pixels', data: rgba, width: w, height: h, color: { profile: prof.name, space: prof.space, converted: true } };
    }
  }

  const rgba8 = new Uint8Array(self.UPNG.toRGBA8(img)[0]);
  // RGBA8 input: either R,G,B + 1 extra, or Gray (taken from R) + 3 extra bytes.
  const inFmt = prof.space === 'RGB' ? fmt(PT_RGB, 3, 1, 1) : fmt(PT_GRAY, 1, 3, 1);
  const rgba = await toSRGB(icc, rgba8, inFmt, 4, w * h, 3, prof.name);
  return { kind: 'pixels', data: rgba, width: w, height: h, color: { profile: prof.name, space: prof.space, converted: true } };
}

async function handleWebp(u8) {
  const { icc } = scanWebp(u8);
  const prof = icc ? await inspectProfile(icc) : null;
  return { kind: 'browser', color: { profile: prof ? prof.name : null, space: prof ? prof.space : 'RGB', converted: !!(prof && !prof.isSRGB),
    warning: prof && !prof.isSRGB ? `WebP with a ${prof.name} profile: converted to sRGB by the browser (Chrome and Safari handle this correctly).` : undefined } };
}

async function handleTiff(u8) {
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const ifds = self.UTIF.decode(buf);

  // A TIFF can hold several images (thumbnails, layers, sub-IFDs). Use the largest one.
  const all = [];
  const walk = (list) => list.forEach((ifd) => { all.push(ifd); if (ifd.subIFD) walk(ifd.subIFD); });
  walk(ifds);
  let best = null, bestArea = 0;
  for (const ifd of all) {
    const w = ifd.t256 && ifd.t256[0], h = ifd.t257 && ifd.t257[0];
    if (w && h && w * h > bestArea) { best = ifd; bestArea = w * h; }
  }
  if (!best) throw new Error('No image found in this TIFF file.');
  self.postMessage({ stage: 'Decoding TIFF…' });
  self.UTIF.decodeImage(buf, best, ifds);

  const w = best.width, h = best.height;
  const iccTag = best.t34675 || ifds[0].t34675;
  const icc = iccTag ? Uint8Array.from(iccTag) : null;
  const prof = icc ? await inspectProfile(icc) : null;
  const orientation = (best.t274 && best.t274[0]) || 1;

  const photometric = best.t262 ? best.t262[0] : 2;
  const bps = best.t258 ? best.t258[0] : 1;
  const spp = best.t277 ? best.t277[0] : (best.t258 ? best.t258.length : 1);
  const planar = best.t284 ? best.t284[0] : 1;
  const dataSpace = photometric === 5 ? 'CMYK' : (photometric === 1 || photometric === 0) ? 'GRAY' : 'RGB';
  const hasAlpha = !!best.t338;
  const base = CHANNELS_FOR[dataSpace];
  const bytes = bps / 8;
  const rawOk = planar === 1 && (bps === 8 || bps === 16) && photometric !== 0 && photometric !== 3 && photometric !== 6
    && spp >= base && best.data && best.data.length >= w * h * spp * bytes;

  const fallback = (warning, converted = false) => {
    const rgba = new Uint8ClampedArray(self.UTIF.toRGBA8(best).buffer);
    return { kind: 'pixels', ...orient(rgba, w, h, orientation), color: { profile: prof ? prof.name : null, space: dataSpace, converted, warning } };
  };

  if (!prof) {
    return fallback(dataSpace === 'CMYK'
      ? 'CMYK TIFF without an embedded colour profile: colours are approximate. Ask for a version with an embedded profile, or one converted to sRGB.'
      : undefined);
  }
  if (prof.space !== dataSpace) {
    return fallback(`The embedded profile (${prof.name}, ${prof.space}) doesn't match the image data (${dataSpace}), so it was ignored.`);
  }
  if (prof.isSRGB) return fallback(undefined);

  if (!rawOk) {
    if (dataSpace === 'CMYK') return fallback(`This CMYK TIFF layout isn't supported for colour conversion; colours are approximate.`);
    // RGB/Gray in an unusual layout: let UTIF expand to RGBA8, then convert.
    const rgba8 = new Uint8Array(self.UTIF.toRGBA8(best).buffer);
    const inFmt = dataSpace === 'RGB' ? fmt(PT_RGB, 3, 1, 1) : fmt(PT_GRAY, 1, 3, 1);
    const rgba = await toSRGB(icc, rgba8, inFmt, 4, w * h, 3, prof.name);
    return { kind: 'pixels', ...orient(rgba, w, h, orientation), color: { profile: prof.name, space: prof.space, converted: true } };
  }

  // Raw samples straight into LittleCMS (keeps 16-bit precision).
  // Note: UTIF already converts big-endian 16-bit samples to little-endian, so no byte swap here.
  const extra = spp - base;
  const inFmt = fmt(PT_FOR[dataSpace], base, extra, bytes);
  const bpp = spp * bytes;
  // Alpha (first extra sample) as 8-bit: for 16-bit (little-endian) samples take the high byte.
  const alphaAt = hasAlpha && extra > 0 ? base * bytes + (bytes === 2 ? 1 : 0) : -1;
  const rgba = await toSRGB(icc, best.data, inFmt, bpp, w * h, alphaAt, prof.name);
  return { kind: 'pixels', ...orient(rgba, w, h, orientation), color: { profile: prof.name, space: prof.space, converted: true } };
}

// ---------------------------------------------------------------- entry point

self.onmessage = async (e) => {
  try {
    const { buffer, name } = e.data;
    const u8 = new Uint8Array(buffer);
    const kind = sniff(u8, name || '');
    let res;
    if (kind === 'jpeg') res = await handleJpeg(u8);
    else if (kind === 'png') res = await handlePng(u8);
    else if (kind === 'tiff') res = await handleTiff(u8);
    else if (kind === 'webp') res = await handleWebp(u8);
    else res = { kind: 'browser', color: { profile: null, space: null, converted: false } };

    if (res.kind === 'pixels') {
      const data = res.data.buffer;
      self.postMessage({ kind: 'pixels', width: res.width, height: res.height, data, color: res.color }, [data]);
    } else {
      self.postMessage(res);
    }
  } catch (err) {
    self.postMessage({ error: (err && err.message) || String(err) });
  }
};

// Decodes TIFF files off the main thread (browsers other than Safari can't decode TIFF natively).
// pako must load first: UTIF reads `self.pako` when it initialises (needed for Deflate-compressed TIFFs).
importScripts('vendor/pako_inflate.min.js', 'vendor/UTIF.js');

self.onmessage = (e) => {
  try {
    const buf = e.data;
    const ifds = UTIF.decode(buf);

    // A TIFF can hold several images (thumbnails, layers, sub-IFDs). Use the largest one.
    const all = [];
    const walk = (list) => list.forEach((ifd) => {
      all.push(ifd);
      if (ifd.subIFD) walk(ifd.subIFD);
    });
    walk(ifds);

    let best = null;
    let bestArea = 0;
    for (const ifd of all) {
      const w = ifd.t256 && ifd.t256[0];
      const h = ifd.t257 && ifd.t257[0];
      if (w && h && w * h > bestArea) { best = ifd; bestArea = w * h; }
    }
    if (!best) throw new Error('No image found in this TIFF file.');

    UTIF.decodeImage(buf, best, ifds);
    const rgba = UTIF.toRGBA8(best);
    self.postMessage({ width: best.width, height: best.height, data: rgba.buffer }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ error: (err && err.message) || String(err) });
  }
};

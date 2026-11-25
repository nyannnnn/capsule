// Background removal, run entirely in the browser with @imgly/background-removal (AGPL-3.0).
// The first use downloads the model (~40 MB); the browser caches it after that.
const LIB = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
let libPromise;
const lib = () => (libPromise ||= import(LIB).catch(e => { libPromise = null; throw e; }));

// Returns a trimmed, centred cutout with a transparent background (WebP, or PNG where WebP encoding isn't supported).
export async function cutout(blob, onProgress) {
  const { removeBackground } = await lib();
  const png = await removeBackground(blob, {
    model: 'isnet_quint8',
    output: { format: 'image/png' },
    progress: (key, current, total) => onProgress?.(key, current, total),
  });
  return trim(png);
}

async function trim(png, maxEdge = 900) {
  const bmp = await createImageBitmap(png);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('No garment found in the photo');
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.round(w * s); out.height = Math.round(h * s);
  out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, out.width, out.height);
  const webp = await new Promise(res => out.toBlob(res, 'image/webp', 0.86));
  if (webp && webp.type === 'image/webp') return webp;
  return new Promise(res => out.toBlob(res, 'image/png'));
}

// Warm the model in the background so the first cutout feels faster.
export function preload() { lib().catch(() => {}); }

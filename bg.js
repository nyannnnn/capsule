// Background removal, run entirely in the browser with @imgly/background-removal (AGPL-3.0).
// The first use downloads the model (~40 MB); the browser caches it after that.
const LIB = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
let libPromise;
const lib = () => (libPromise ||= import(LIB).catch(e => { libPromise = null; throw e; }));

export const STUDIO = '#EEEEEC'; // must match --studio in styles.css

// Full pipeline: remove the background, keep the garment, return a light studio JPEG.
export async function cutout(blob, onProgress) {
  const { removeBackground } = await lib();
  const png = await removeBackground(blob, {
    model: 'isnet_quint8',
    output: { format: 'image/png' },
    progress: (key, current, total) => onProgress?.(key, current, total),
  });
  return finish(png);
}

// Turn a transparent cutout into the stored studio shot. Also used to upgrade older PNG cutouts
// without running the model again.
export async function finish(png, maxEdge = 900) {
  const bmp = await createImageBitmap(png);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  hardenEdges(img);
  keepMainObject(img);
  g.putImageData(img, 0, 0);

  const box = bounds(img);
  if (!box) throw new Error('No garment found in the photo');
  const { x0, y0, w, h } = box;
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const gw = Math.round(w * s), gh = Math.round(h * s);
  const pad = Math.round(Math.max(gw, gh) * 0.07);
  const out = document.createElement('canvas');
  out.width = gw + pad * 2; out.height = gh + pad * 2;
  const o = out.getContext('2d');
  o.fillStyle = STUDIO; o.fillRect(0, 0, out.width, out.height);
  // Soft contact shadow, baked in so the JPEG needs no transparency.
  o.shadowColor = 'rgba(0, 0, 0, 0.16)';
  o.shadowBlur = Math.round(Math.max(gw, gh) * 0.03);
  o.shadowOffsetY = Math.round(Math.max(gw, gh) * 0.018);
  o.drawImage(c, x0, y0, w, h, pad, pad, gw, gh);
  return new Promise(res => out.toBlob(res, 'image/jpeg', 0.86));
}

// The model leaves pixels it is unsure about semi-transparent, which reads as a sleeve fading out
// against a textured rug. Pixels it is mostly sure about become solid; faint ones drop out.
function hardenEdges({ data }) {
  const lo = 46, hi = 140; // roughly 18% and 55% confidence
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a <= lo) data[i] = 0;
    else if (a >= hi) data[i] = 255;
    else { const t = (a - lo) / (hi - lo); data[i] = Math.round(255 * t * t * (3 - 2 * t)); }
  }
}

// Keep the garment and drop small separate objects, such as a reference card lying beside it.
// Components at least a quarter the size of the largest are kept, so a pair of shoes survives.
function keepMainObject(img) {
  const { data, width, height } = img;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 256));
  const gw = Math.ceil(width / step), gh = Math.ceil(height / step);
  const solid = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const px = Math.min(width - 1, x * step + (step >> 1)), py = Math.min(height - 1, y * step + (step >> 1));
    solid[y * gw + x] = data[(py * width + px) * 4 + 3] > 32 ? 1 : 0;
  }
  const label = new Int32Array(gw * gh); const sizes = [0];
  const stack = [];
  for (let i = 0; i < solid.length; i++) {
    if (!solid[i] || label[i]) continue;
    const id = sizes.length; let size = 0;
    label[i] = id; stack.push(i);
    while (stack.length) {
      const k = stack.pop(); size++;
      const x = k % gw, y = (k / gw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (solid[n] && !label[n]) { label[n] = id; stack.push(n); }
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 2) return; // one object or none: nothing to drop
  const biggest = Math.max(...sizes);
  const keepId = new Uint8Array(sizes.length);
  sizes.forEach((sz, id) => { if (id && sz >= biggest * 0.25) keepId[id] = 1; });
  // A cell is kept if it or a neighbour belongs to a kept object, so soft edges survive.
  const keep = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    for (let dy = -1; dy <= 1 && !keep[y * gw + x]; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && keepId[label[ny * gw + nx]]) { keep[y * gw + x] = 1; break; }
    }
  }
  for (let y = 0; y < height; y++) {
    const row = ((y / step) | 0) * gw;
    for (let x = 0; x < width; x++) if (!keep[row + ((x / step) | 0)]) data[(y * width + x) * 4 + 3] = 0;
  }
}

function bounds({ data, width, height }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    if (data[(y * width + x) * 4 + 3] > 24) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  x1 = Math.min(width - 1, x1 + 1); y1 = Math.min(height - 1, y1 + 1);
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Warm the model in the background so the first cutout feels faster.
export function preload() { lib().catch(() => {}); }

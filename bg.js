// Background removal, run entirely in the browser with @imgly/background-removal (AGPL-3.0).
// The first use downloads the model (~40 MB); the browser caches it after that.
const LIB = './vendor/bg-removal-1.7.0.js'; // bundled locally; the model files still come from IMG.LY and are cached by sw.js
let libPromise;
const lib = () => (libPromise ||= import(LIB).catch(e => { libPromise = null; throw e; }));

export const STUDIO = '#EEEEEC'; // must match --studio in styles.css

// Full pipeline: remove the background, keep the garment, return a light studio JPEG.
export async function cutout(blob, onProgress) {
  const { removeBackground } = await lib();
  const png = await removeBackground(blob, {
    model: 'isnet_quint8',
    device: 'cpu',
    output: { format: 'image/png' },
    progress: (key, current, total) => onProgress?.(key, current, total),
  });
  return finish(png, blob);
}

// Turn a transparent cutout into the stored studio shot. Also used to upgrade older PNG cutouts
// without running the model again.
export async function finish(png, original = null, maxEdge = 900) {
  const bmp = await createImageBitmap(png);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  if (original) {
    // Use the untouched photo's colours to settle pixels the model was unsure about.
    const ob = await createImageBitmap(original);
    g.drawImage(ob, 0, 0, c.width, c.height);
    const orig = g.getImageData(0, 0, c.width, c.height);
    refineByColour(img, orig);
  } else {
    hardenEdges(img);
  }
  keepMainObject(img);
  g.putImageData(img, 0, 0);

  const box = bounds(img);
  if (!box) throw new Error('No garment found in the photo');
  const { x0, y0, w, h } = box;
  const fit = await fitAsset(c, box);
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
  const display = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.86));
  return { display, fit };
}

// Tightly trimmed, transparent copy for layering on the figure in the On you view.
// WebP where the browser can encode it (much smaller), PNG otherwise (Safari).
async function fitAsset(c, { x0, y0, w, h }, maxEdge = 640) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * s)); out.height = Math.max(1, Math.round(h * s));
  out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, out.width, out.height);
  const webp = await new Promise(res => out.toBlob(res, 'image/webp', 0.88));
  if (webp && webp.type === 'image/webp') return webp;
  return new Promise(res => out.toBlob(res, 'image/png'));
}

// Colour refinement. The model is confident about most of the garment and most of the rug; where it
// hesitates (a sleeve edge on textured fur), the colours usually still differ clearly. Learn a colour
// profile for each side from the confident pixels, then decide uncertain pixels near the garment by
// which profile their colour fits. Far-away pixels are never pulled in, so stray fluff stays out.
function refineByColour(img, orig) {
  const a = img.data, o = orig.data, { width: W, height: H } = img;
  const N = W * H, FG = 200, BG = 20;
  const hf = new Float32Array(4096), hb = new Float32Array(4096);
  let nf = 0, nb = 0;
  const bin = i => ((o[i] >> 4) << 8) | ((o[i + 1] >> 4) << 4) | (o[i + 2] >> 4);
  for (let p = 0; p < N; p += 2) {
    const i = p * 4, al = a[i + 3];
    if (al >= FG) { hf[bin(i)]++; nf++; } else if (al <= BG) { hb[bin(i)]++; nb++; }
  }
  if (nf < 500 || nb < 500) { hardenEdges(img); return; }
  // Smoothed colour likelihoods, then the probability a colour belongs to the garment.
  const post = new Float32Array(4096);
  const blur = h => { // spread each bin over its neighbours so near colours count too
    const out = new Float32Array(4096);
    for (let r = 0; r < 16; r++) for (let gg = 0; gg < 16; gg++) for (let b = 0; b < 16; b++) {
      let sum = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
        const R = r + dr, G = gg + dg, B = b + db;
        if (R >= 0 && G >= 0 && B >= 0 && R < 16 && G < 16 && B < 16) sum += h[(R << 8) | (G << 4) | B] * (dr || dg || db ? 0.5 : 1);
      }
      out[(r << 8) | (gg << 4) | b] = sum;
    }
    return out;
  };
  const bf = blur(hf), bb = blur(hb);
  for (let q = 0; q < 4096; q++) {
    const pf = (bf[q] + 0.01) / nf, pb = (bb[q] + 0.01) / nb;
    post[q] = pf / (pf + pb);
  }
  // Grow outward from the confident garment through neighbouring pixels whose colour clearly matches
  // the garment. Growth stops at the rug's edge because rug colours fail the match.
  const reach = Math.round(Math.max(W, H) * 0.3); // never wander more than 30% of the image away
  const dist = new Uint16Array(N).fill(65535), queue = new Int32Array(N);
  let qh = 0, qt = 0, confident = 0;
  for (let p = 0; p < N; p++) if (a[p * 4 + 3] >= FG) { dist[p] = 0; queue[qt++] = p; confident++; }
  const grown = new Uint8Array(N);
  while (qh < qt) {
    const p = queue[qh++], d = dist[p];
    if (d >= reach) continue;
    const x = p % W, y = (p / W) | 0;
    for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
      if (n < 0 || dist[n] !== 65535) continue;
      const i = n * 4, pr = post[bin(i)], al = a[i + 3];
      // Uncertain pixels need a reasonable colour match; pixels the model dropped need a strong one.
      if ((al > BG && pr >= 0.55) || pr >= 0.8) { dist[n] = d + 1; grown[n] = 1; queue[qt++] = n; }
    }
  }
  // Safety cap: if growth balloons, the garment and rug colours are too alike to trust it.
  if (qt - confident > confident * 0.4) { hardenEdges(img); return; }
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    if (a[i + 3] >= FG || grown[p]) a[i + 3] = 255;
    else a[i + 3] = a[i + 3] > BG && post[bin(i)] >= 0.45 ? Math.round(a[i + 3] * post[bin(i)]) : 0; // soft rim
  }
  // Clean single-pixel speckle: a pixel flips if most of its neighbours disagree.
  const copy = new Uint8ClampedArray(N);
  for (let p = 0; p < N; p++) copy[p] = a[p * 4 + 3];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let on = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (copy[(y + dy) * W + x + dx] > 127) on++;
    const i = (y * W + x) * 4;
    if (on <= 2) a[i + 3] = 0; else if (on >= 7 && a[i + 3] < 128) a[i + 3] = 255;
  }
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

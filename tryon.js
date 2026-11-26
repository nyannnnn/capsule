// "On you": a true-to-scale 3D turntable. Your figure is drawn from your measurements; each garment is a
// transparent cutout scaled to its measured centimetres and layered at depth in front of it. Drag to turn;
// past the side it switches to the back photos. Plain CSS 3D, so it stays light, fast and offline.
import { bodyModel, placeGarment } from './logic.js?v=202611261208';

// ---------------------------------------------------------------- garment image metrics
const metrics = (() => { try { return JSON.parse(localStorage.getItem('fitm') || '{}'); } catch { return {}; } })();
const saveMetrics = () => { try { localStorage.setItem('fitm', JSON.stringify(metrics)); } catch {} };

// Width of the garment's body (not its sleeves) across the lower torso, plus its pixel size.
export async function measure(path, getBlob) {
  if (metrics[path]) return metrics[path];
  const bmp = await createImageBitmap(await getBlob(path));
  const s = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
  const W = Math.max(1, Math.round(bmp.width * s)), H = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, W, H);
  const a = g.getImageData(0, 0, W, H).data;
  const solid = (x, y) => a[(y * W + x) * 4 + 3] > 40;
  const runs = [];
  for (let y = Math.floor(H * 0.62); y < Math.floor(H * 0.82); y++) {
    let cx = Math.floor(W / 2);
    if (!solid(cx, y)) { // centre might be a gap (an open jacket): find the nearest solid pixel
      let found = -1;
      for (let d = 1; d < W * 0.12 && found < 0; d++) { if (solid(cx + d, y)) found = cx + d; else if (solid(cx - d, y)) found = cx - d; }
      if (found < 0) continue; cx = found;
    }
    let l = cx, r = cx, gap = 0;
    while (l > 0 && gap < 3) { l--; gap = solid(l, y) ? 0 : gap + 1; }
    gap = 0;
    while (r < W - 1 && gap < 3) { r++; gap = solid(r, y) ? 0 : gap + 1; }
    runs.push(r - l - 4);
  }
  runs.sort((p, q) => p - q);
  const torso = runs.length ? runs[Math.floor(runs.length / 2)] : 0;
  const m = { w: bmp.width, h: bmp.height, torsoPx: torso ? torso / s : 0 };
  metrics[path] = m; saveMetrics();
  return m;
}

// ---------------------------------------------------------------- the figure (a croquis, in cm)
function smooth(pts, closed = true) {
  const n = pts.length, P = i => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d + (closed ? 'Z' : '');
}
const mirror = pts => pts.map(([x, y]) => [-x, y]);
const ARM = 22 * Math.PI / 180;

function figureParts(b) {
  const torsoR = [
    [b.neckHalf, b.head.cy + b.head.ry * 0.8], [b.neckHalf * 1.06, b.neckY],
    [b.shoulderHalf * 0.74, b.neckY + (b.shoulderY - b.neckY) * 0.6], [b.shoulderHalf, b.shoulderY + 1.4],
    [b.chestHalf * 1.03, b.chestY - 4], [b.chestHalf, b.chestY + 3], [b.waistHalf, b.waistY],
    [b.hipHalf, b.hipY], [b.hipHalf * 0.95, b.crotchY - 1],
  ];
  const torso = [...torsoR, [0, b.crotchY + 1.2], ...mirror(torsoR).reverse()];
  const legC = b.hipHalf * 0.46;
  const legR = [
    [0.9, b.crotchY - 3], [b.hipHalf * 0.97, b.hipY + 2], [b.hipHalf * 0.9, b.crotchY + 2],
    [b.hipHalf * 0.64, b.kneeY], [legC + 3.4, b.ankleY], [legC + 4.6, b.floor - 1.6], [legC + 2.4, b.floor],
    [legC - 3.4, b.floor - 0.4], [legC - 2.8, b.ankleY], [Math.max(1.4, legC - 4.6), b.kneeY], [0.8, b.crotchY + 1.2],
  ];
  const S = [b.shoulderHalf - 1.4, b.shoulderY + 1.6], dir = [Math.sin(ARM), Math.cos(ARM)], nrm = [Math.cos(ARM), -Math.sin(ARM)];
  const L1 = b.sleeve * 0.5, L2 = b.sleeve * 0.5;
  const stations = [[0, 5.2], [L1 * 0.5, 4.6], [L1, 3.9], [L1 + L2, 2.6], [L1 + L2 + 8, 3.3], [L1 + L2 + 16, 1.3]];
  const P = (t, w, sgn) => [S[0] + dir[0] * t + nrm[0] * w * sgn, S[1] + dir[1] * t + nrm[1] * w * sgn];
  const armR = [...stations.map(([t, w]) => P(t, w, 1)), P(L1 + L2 + 17.5, 0, 1), ...stations.slice().reverse().map(([t, w]) => P(t, w, -1))];
  return { torso, legR, armR, reach: S[0] + dir[0] * (L1 + L2 + 18) + 3 };
}

function figureSvg(b, vb, withRuler) {
  const f = figureParts(b);
  const line = 'fill="#F6F6F3" stroke="#8C8C88" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round"';
  let ruler = '';
  if (withRuler) {
    const x = vb.x + 3.2;
    ruler = `<g stroke="#A4A4A0" stroke-width="1" vector-effect="non-scaling-stroke" fill="#9A9A96" font-family="Inter Tight, Arial, sans-serif" font-size="2.6">
      <line x1="${x}" y1="0" x2="${x}" y2="${b.floor}" vector-effect="non-scaling-stroke"/>
      ${Array.from({ length: Math.floor(b.floor / 10) + 1 }, (_, i) => {
        const y = b.floor - i * 10, big = i % 5 === 0;
        return `<line x1="${x}" y1="${y}" x2="${x + (big ? 2.4 : 1.2)}" y2="${y}" vector-effect="non-scaling-stroke"/>${big && i ? `<text x="${x + 3.2}" y="${y + 0.9}" stroke="none">${i * 10}</text>` : ''}`;
      }).join('')}</g>`;
  }
  return `<svg viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    ${ruler}
    <path d="${smooth(f.armR)}" ${line}/><path d="${smooth(mirror(f.armR))}" ${line}/>
    <path d="${smooth(f.legR)}" ${line}/><path d="${smooth(mirror(f.legR))}" ${line}/>
    <path d="${smooth(f.torso)}" ${line}/>
    <ellipse cx="0" cy="${b.head.cy}" rx="${b.head.rx}" ry="${b.head.ry}" ${line}/>
  </svg>`;
}

// ---------------------------------------------------------------- the stage
const DEPTH = { shoes: 0.6, bottom: 1.3, top: 2.2, sport: 2.2, outer: 3.3 }; // cm in front of the body
const angles = {}; // each turntable remembers its own angle
let spinning = null;

// layers: [{ item, place, front: url, back: url, backPlace, shadeBack }]
export function renderStage(el, body, layers, { maxH = 0.72, key = 'look' } = {}) {
  const f = figureParts(body);
  let half = f.reach + 4;
  for (const L of layers) half = Math.max(half, Math.min(Math.abs(L.place.x), f.reach * 1.5));
  const vb = { x: -half, y: -4, w: half * 2, h: body.floor + 8 };
  const pct = (v, o, len) => ((v - o) / len * 100).toFixed(3) + '%';
  const plane = (L, back) => {
    const p = back ? (L.backPlace || L.place) : L.place, src = back ? L.back : L.front;
    if (!src) return '';
    return `<img class="plane g ${back ? 'back' : 'front'} ${back && L.shadeBack ? 'shade' : ''}" src="${src}" alt="" draggable="false"
      style="left:${pct(p.x, vb.x, vb.w)};top:${pct(p.y, vb.y, vb.h)};width:${(p.w / vb.w * 100).toFixed(3)}%;height:${(p.h / vb.h * 100).toFixed(3)}%;--z:${(DEPTH[p.slot] || 1) + (L.extra || 0)}">`;
  };
  const sorted = layers.slice().sort((a, b) => a.place.layer - b.place.layer);
  el.innerHTML = `
    <div class="stage3d">
      <div class="floorshadow"></div>
      <div class="rig">
        <div class="sway">
          <div class="plane fig front">${figureSvg(body, vb, true)}</div>
          <div class="plane fig back">${figureSvg(body, vb, false)}</div>
          ${sorted.map(L => plane(L, false)).join('')}
          ${sorted.map(L => plane(L, true)).join('')}
        </div>
      </div>
    </div>`;
  const stage = el.querySelector('.stage3d');
  // Fit the stage to the space available, keeping the figure's true proportions.
  const size = () => {
    const k = Math.min(el.clientWidth / vb.w, (innerHeight * maxH) / vb.h);
    if (!k || !isFinite(k)) return;
    stage.style.width = (vb.w * k).toFixed(1) + 'px';
    stage.style.height = (vb.h * k).toFixed(1) + 'px';
    stage.style.setProperty('--cm', k.toFixed(3) + 'px');
  };
  size();
  new ResizeObserver(size).observe(el);
  stage._key = key;
  setAngle(stage, angles[key] || 0);
  bindDrag(stage);
  return stage;
}

const angleOf = stage => angles[stage._key] || 0;
function setAngle(stage, a) {
  angles[stage._key] = a;
  const n = ((a % 360) + 360) % 360;
  stage.style.setProperty('--ry', a + 'deg');
  stage.dataset.side = n > 90 && n < 270 ? 'back' : 'front';
  stage.style.setProperty('--turn', Math.abs(Math.sin(a * Math.PI / 180)).toFixed(3)); // 0 front-on, 1 side-on
  stage.closest('.onyou')?.querySelectorAll('[data-action="spin"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.to === stage.dataset.side));
}

export function spinTo(stage, side) {
  const target = side === 'back' ? 180 : 0;
  const cur = angleOf(stage), n = ((cur % 360) + 360) % 360;
  let delta = target - n; if (delta > 180) delta -= 360; if (delta < -180) delta += 360;
  animate(stage, cur, cur + delta);
}

function animate(stage, from, to, ms = 700) {
  cancelAnimationFrame(spinning);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { setAngle(stage, to); return; }
  const t0 = performance.now(), ease = t => 1 - Math.pow(1 - t, 3);
  const step = now => {
    const t = Math.min(1, (now - t0) / ms);
    setAngle(stage, from + (to - from) * ease(t));
    if (t < 1) spinning = requestAnimationFrame(step);
  };
  spinning = requestAnimationFrame(step);
}

function bindDrag(stage) {
  let start = null;
  stage.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    cancelAnimationFrame(spinning);
    start = { x: e.clientX, y: e.clientY, a: angleOf(stage), active: false, id: e.pointerId, lastX: e.clientX, v: 0, t: performance.now() };
  });
  stage.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.active) {
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { start.active = true; stage.setPointerCapture(e.pointerId); stage.classList.add('turning'); }
      else if (Math.abs(dy) > 10) { start = null; return; } else return;
    }
    const now = performance.now();
    start.v = (e.clientX - start.lastX) / Math.max(1, now - start.t); start.lastX = e.clientX; start.t = now;
    setAngle(stage, start.a + dx * 0.6);
  });
  const end = () => {
    if (!start) return;
    const s = start; start = null;
    stage.classList.remove('turning');
    if (!s.active) return;
    // A real flick keeps turning a little; a slow drag just settles to the nearest side.
    const cur = angleOf(stage);
    const v = Math.abs(s.v) > 0.8 ? Math.max(-2, Math.min(2, s.v)) : 0;
    const coast = cur + v * 90;
    const n = ((coast % 360) + 360) % 360;
    const snap = coast - n + (n > 90 && n < 270 ? 180 : n >= 270 ? 360 : 0);
    animate(stage, cur, snap, 650);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

export { bodyModel, placeGarment };

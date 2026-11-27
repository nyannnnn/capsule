// On you in real 3D. A mannequin is generated from your measurements; each garment is a 3D shell around
// it (torso and sleeves, or pelvis and legs) sized from the piece's measurements. The front photo is
// projected onto the shell's front and the back photo onto its back; anything outside the photo's outline
// is cut away, so a cropped or oversized cut keeps its real silhouette. three.js is bundled locally.
// Units are centimetres. Landmarks come in y-down (from the top of the head); the scene is y-up.

const THREE_URL = './vendor/three-0.186.1.js';
let T = null;
const three = async () => (T ||= await import(THREE_URL));

export function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

// ---------------------------------------------------------------- geometry helpers
// A loft through elliptical rings. Each ring: { c: [x, y, z], a: [ax, ay, az], b: [bx, by, bz], rx, rz }
// where a and b are unit vectors spanning the ring's plane.
function loft(rings, N = 36, { capStart = false, capEnd = false } = {}) {
  const pos = [], idx = [];
  for (const r of rings) {
    for (let j = 0; j < N; j++) {
      const t = (j / N) * Math.PI * 2, ca = Math.cos(t) * r.rx, sb = Math.sin(t) * r.rz;
      pos.push(r.c[0] + r.a[0] * ca + r.b[0] * sb, r.c[1] + r.a[1] * ca + r.b[1] * sb, r.c[2] + r.a[2] * ca + r.b[2] * sb);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < N; j++) {
    const a = i * N + j, b = i * N + (j + 1) % N, c = (i + 1) * N + (j + 1) % N, d = (i + 1) * N + j;
    idx.push(a, d, b, b, d, c);
  }
  const cap = (ri, flip) => {
    const r = rings[ri], center = pos.length / 3; pos.push(...r.c);
    for (let j = 0; j < N; j++) {
      const a = ri * N + j, b = ri * N + (j + 1) % N;
      flip ? idx.push(center, b, a) : idx.push(center, a, b);
    }
  };
  if (capStart) cap(0, false);
  if (capEnd) cap(rings.length - 1, true);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const H = (cx, y, cz, rx, rz) => ({ c: [cx, y, cz], a: [1, 0, 0], b: [0, 0, 1], rx, rz }); // horizontal ring
// A ring perpendicular to a direction lying in the XY plane (arms).
function along(p0, dir, s, rx, rz) {
  const c = [p0[0] + dir[0] * s, p0[1] + dir[1] * s, p0[2]];
  return { c, a: [dir[1], -dir[0], 0], b: [0, 0, 1], rx, rz };
}

// ---------------------------------------------------------------- body
const ARM_DEG = 38; // A-pose, close to how sleeves lie in a flat-lay photo
function frame(b) {
  const Y = yd => b.floor - yd; // y-down landmark → scene height
  const depth = { chest: b.chest * 0.122, waist: b.waist * 0.118, hips: b.hips * 0.125 };
  const ang = ARM_DEG * Math.PI / 180;
  const dirR = [Math.sin(ang), -Math.cos(ang)], dirL = [-Math.sin(ang), -Math.cos(ang)];
  const shoulderR = [b.shoulderHalf - 2.2, Y(b.shoulderY + 2.4), 0], shoulderL = [-(b.shoulderHalf - 2.2), Y(b.shoulderY + 2.4), 0];
  const legX = b.hipHalf * 0.47;
  return { Y, depth, dirR, dirL, shoulderR, shoulderL, legX };
}
function torsoRings(b, f, d = 0, ease = 0, hemYd = null) {
  const r = [
    H(0, f.Y(b.head.cy + b.head.ry * 0.78), 0, b.neckHalf + d * 0.5, b.neckHalf * 0.95 + d * 0.5),
    H(0, f.Y(b.neckY), 0, b.neckHalf * 1.12 + d, b.neckHalf + d),
    H(0, f.Y(b.neckY + (b.shoulderY - b.neckY) * 0.55), 0, b.shoulderHalf * 0.78 + d, f.depth.chest * 0.82 + d),
    H(0, f.Y(b.shoulderY + 1.5), 0, b.shoulderHalf * 0.97 + d + ease * 0.6, f.depth.chest * 0.9 + d + ease * 0.4),
    H(0, f.Y(b.chestY), 0, b.chestHalf + d + ease, f.depth.chest + d + ease * 0.6),
    H(0, f.Y(b.waistY), 0, Math.max(b.waistHalf + d, b.chestHalf * 0.86 + d + ease * 0.9), f.depth.waist + d + ease * 0.6),
    H(0, f.Y(b.hipY), 0, b.hipHalf + d + ease * 0.85, f.depth.hips + d + ease * 0.55),
  ];
  if (hemYd == null) { // the mannequin: close at the crotch
    r.push(H(0, f.Y(b.crotchY - 2), 0, b.hipHalf * 0.94, f.depth.hips * 0.9), H(0, f.Y(b.crotchY + 0.6), 0, b.hipHalf * 0.5, f.depth.hips * 0.5));
  } else { // a garment shell continues past the hips as a straight drop to its hem
    const last = r[r.length - 1];
    for (const yd of [b.crotchY, (b.crotchY + hemYd) / 2, hemYd + 2]) if (yd > b.hipY + 1) r.push(H(0, f.Y(yd), 0, last.rx * 1.02, last.rz * 1.04));
  }
  return r;
}
function armRings(b, f, side, d = 0, ease = 0, length = null) {
  const p0 = side > 0 ? f.shoulderR : f.shoulderL, dir = side > 0 ? f.dirR : f.dirL;
  const L = length ?? b.sleeve;
  const stations = [[0, 5.4], [b.sleeve * 0.25, 4.9], [b.sleeve * 0.5, 4.2], [b.sleeve * 0.75, 3.5], [b.sleeve, 2.9]].filter(([s]) => s <= L + 0.01);
  if (stations[stations.length - 1][0] < L) {
    const s0 = stations[stations.length - 1], s1 = [b.sleeve, 2.9];
    stations.push([L, s0[1] + (s1[1] - s0[1]) * ((L - s0[0]) / Math.max(1, s1[0] - s0[0]))]);
  }
  // A garment sleeve's root tucks into the shell's shoulder, so it doesn't stand up like a pad.
  return stations.map(([s, r], i) => {
    const k = d && i === 0 ? 0.45 : 1, rr = (d && i === 0 ? r * 0.8 : r);
    return along(p0, dir, s - (d ? 2.5 : 0), rr + (d + ease) * k, rr * 0.92 + (d + ease * 0.8) * k);
  });
}
function legRings(b, f, side, d = 0, ease = 0, fromYd = null, toYd = null) {
  const x = side * f.legX;
  const pts = [
    [b.hipY + 3, side * b.hipHalf * 0.5, b.hipHalf * 0.56], [b.crotchY, x * 1.02, b.hipHalf * 0.5],
    [b.kneeY, x * 0.9, 5.6], [b.ankleY, x * 0.86, 3.7], [b.floor - 2, x * 0.86, 3.4],
  ];
  const lerp = yd => { // interpolate the leg's centre and radius at a given height
    for (let i = 0; i < pts.length - 1; i++) if (yd <= pts[i + 1][0]) {
      const [y0, x0, r0] = pts[i], [y1, x1, r1] = pts[i + 1], t = (yd - y0) / (y1 - y0);
      return [x0 + (x1 - x0) * t, r0 + (r1 - r0) * t];
    }
    const p = pts[pts.length - 1]; return [p[1], p[2]];
  };
  const from = fromYd ?? pts[0][0], to = Math.min(toYd ?? pts[pts.length - 1][0], b.floor - 1);
  const out = [];
  for (let k = 0; k <= 6; k++) {
    const yd = from + (to - from) * (k / 6), [cx, r] = lerp(yd);
    const loose = ease * (0.6 + 0.4 * (k / 6)); // trousers fall straighter than the leg tapers
    out.push(H(cx, f.Y(yd), 0, r + d + loose, r * 0.95 + d + loose));
  }
  return out;
}

function mannequin(b, f) {
  const mat = new T.MeshStandardMaterial({ color: 0xF1F0EC, roughness: 0.62, metalness: 0 });
  const g = new T.Group();
  const add = geo => { const m = new T.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  add(loft(torsoRings(b, f), 40, { capStart: true, capEnd: true }));
  for (const s of [1, -1]) {
    add(loft(legRings(b, f, s), 28, { capStart: true, capEnd: true }));
    add(loft(armRings(b, f, s), 24, { capStart: true, capEnd: true }));
    const dir = s > 0 ? f.dirR : f.dirL, p0 = s > 0 ? f.shoulderR : f.shoulderL;
    const hand = add(new T.SphereGeometry(1, 20, 14));
    hand.scale.set(3.4, 8.5, 1.9); hand.rotation.z = s * ARM_DEG * Math.PI / 180;
    hand.position.set(p0[0] + dir[0] * (b.sleeve + 8), p0[1] + dir[1] * (b.sleeve + 8), 0);
    const foot = add(new T.BoxGeometry(8, 6, 25, 2, 2, 4));
    foot.position.set(s * f.legX * 0.9, 3, 6);
  }
  const head = add(new T.SphereGeometry(1, 40, 28));
  head.scale.set(b.head.rx, b.head.ry, b.head.rx * 1.12);
  head.position.set(0, f.Y(b.head.cy), 0.5);
  return g;
}

// ---------------------------------------------------------------- garments
const SHORT = ['tshirt', 'polo', 'gym'], SLEEVELESS = ['tank'];
const LAYER_D = { bottom: 0.9, top: 1.8, sport: 1.8, outer: 3.0 };

// Project the photos onto a garment shell. Front-facing triangles take the front photo, back-facing the back.
// uvFront / uvBack map a scene point (x, y) to texture coordinates in that photo.
function projectPhotos(geoIndexed, uvFront, uvBack, hasBack) {
  const g = geoIndexed.toNonIndexed(); // keeps the smooth normals computed on the indexed shell
  const p = g.attributes.position, nrm = g.attributes.normal, n = p.count, uv = new Float32Array(n * 2);
  g.clearGroups();
  const tris = n / 3, front = [], back = [];
  const v = new T.Vector3(), a = new T.Vector3(), c = new T.Vector3();
  for (let t = 0; t < tris; t++) {
    const i0 = t * 3;
    v.fromBufferAttribute(p, i0); a.fromBufferAttribute(p, i0 + 1); c.fromBufferAttribute(p, i0 + 2);
    const nz = v.z + a.z + c.z; // which side of the body this face is on (shells are centred on z = 0)
    (nz >= 0 ? front : back).push(t);
    for (let k = 0; k < 3; k++) {
      const i = i0 + k, [u, w] = (nz < 0 && hasBack ? uvBack : uvFront)(p.getX(i), p.getY(i));
      uv[i * 2] = u; uv[i * 2 + 1] = w;
    }
  }
  // Reorder triangles so each photo is one draw group.
  const pos2 = new Float32Array(n * 3), nrm2 = new Float32Array(n * 3), uv2 = new Float32Array(n * 2);
  let w = 0;
  for (const list of [front, back]) for (const t of list) for (let k = 0; k < 3; k++) {
    const i = t * 3 + k;
    pos2.set([p.getX(i), p.getY(i), p.getZ(i)], w * 3);
    nrm2.set([nrm.getX(i), nrm.getY(i), nrm.getZ(i)], w * 3);
    uv2.set([uv[i * 2], uv[i * 2 + 1]], w * 2); w++;
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.Float32BufferAttribute(pos2, 3));
  out.setAttribute('normal', new T.Float32BufferAttribute(nrm2, 3));
  out.setAttribute('uv', new T.Float32BufferAttribute(uv2, 2));
  out.addGroup(0, front.length * 3, 0);
  out.addGroup(front.length * 3, back.length * 3, 1);
  return out;
}

// A sleeve's photo runs along its own axis (it may hang straight down or reach out sideways), while the
// 3D arm has a fixed angle. Map along the arm and across it, so the whole sleeve lands on the arm.
function sleeveUV(b, f, side, sl, pl, ringR) {
  const p0 = side > 0 ? f.shoulderR : f.shoulderL, dir = side > 0 ? f.dirR : f.dirL;
  const dD = [dir[0], -dir[1]], nD = [-dD[1], dD[0]];        // arm axis and its normal, y-down
  const dP = [sl.dx, sl.dy], nP = [-sl.dy, sl.dx];             // the same in the photo
  const s = pl.scale, k = Math.max(0.8, Math.min(2.2, (sl.halfW * s) / ringR)); // flat width → round arm
  const iw = pl.w / s, ih = pl.h / s;
  return (x, y) => {
    const rx = x - p0[0], ry = -(y - p0[1]);
    // Stay inside the sleeve's own pixels: the arm's length already comes from the photo, and sampling past
    // the sleeve's edge (around the shoulder cap) would cut holes where the background is.
    const lim = sl.halfW * s * 0.55, a = Math.max(sl.len * s * 0.04, Math.min(sl.len * s * 0.97, rx * dD[0] + ry * dD[1]));
    const c = Math.max(-lim, Math.min(lim, (rx * nD[0] + ry * nD[1]) * k));
    const px = sl.x + (dP[0] * a + nP[0] * c) / s, py = sl.y + (dP[1] * a + nP[1] * c) / s;
    return [px / iw, 1 - py / ih];
  };
}

// fit: what the layers underneath already take up, so a coat always clears the tee inside it.
function garmentMesh(b, f, L, texFront, texBack, fit = { ease: 0, sEase: 0 }) {
  const it = L.item, slot = L.place.slot, d = LAYER_D[slot] || 1.8;
  const W = L.place.torsoCm || null; // the photo's flat torso width, in cm
  const geos = []; // { geo, side } — side 0 for the body, ±1 for a sleeve
  let toFlat, sleeveRing = 0;
  if (slot === 'bottom') {
    const top = b.waistY + (b.hipY - b.waistY) * 0.25, hem = L.place.hemY;
    const flatW = Number(it.width_cm) || null, k = b.hips * 0.125 / b.hipHalf;
    const easeHip = flatW ? Math.max(0, 2 * flatW / (Math.PI * (1 + k)) - b.hipHalf) : 2;
    geos.push({ side: 0, geo: loft([H(0, f.Y(top), 0, b.waistHalf + d + easeHip * 0.5, f.depth.waist + d + easeHip * 0.3),
      H(0, f.Y(b.hipY), 0, b.hipHalf + d + easeHip, f.depth.hips + d + easeHip * 0.6),
      H(0, f.Y(b.crotchY - 1), 0, b.hipHalf * 0.98 + d + easeHip, f.depth.hips * 0.95 + d + easeHip * 0.6)], 40) });
    for (const s of [1, -1]) geos.push({ side: 0, geo: loft(legRings(b, f, s, d, 2.2 + easeHip * 0.4, b.crotchY - 3, hem), 28) });
    const ref = b.hipHalf + d + easeHip, photoHalf = (L.place.w * 0.92) / 2;
    const kx = Math.max(0.8, Math.min(1.8, photoHalf / ref));
    toFlat = (x, y) => [x * kx, b.floor - y];
  } else {
    const chestK = (b.chest * 0.122) / b.chestHalf;
    const half = W ? 2 * W / (Math.PI * (1 + chestK)) : b.chestHalf + 4; // shell half-width from the flat width
    const ease = Math.max(0, half - b.chestHalf - d, fit.ease + 0.8);
    fit.ease = ease;
    geos.push({ side: 0, geo: loft(torsoRings(b, f, d, ease, L.place.hemY), 44) });
    // Sleeve length from the photo when both sleeves read clearly, else from the category.
    const sl = L.m?.sleeves, lens = sl ? [sl.R, sl.L].filter(Boolean).map(x => x.len * L.place.scale) : [];
    let sleeveLen = SLEEVELESS.includes(it.category) ? 0 : SHORT.includes(it.category) ? 21 : b.sleeve + 2;
    if (sleeveLen && lens.length) sleeveLen = Math.max(8, Math.min(b.sleeve + 6, lens.reduce((p, q) => p + q, 0) / lens.length));
    const sEase = Math.max(Math.min(ease * 0.15 + 0.8, 3), fit.sEase + 0.3); // each layer's depth already adds a gap fit.sEase = sEase; sleeveRing = 4.2 + d + sEase;
    if (sleeveLen) for (const s of [1, -1]) geos.push({ side: s, geo: loft(armRings(b, f, s, d, sEase, sleeveLen), 24) });
    // Torso: the shell's sides map to the photo's side seams. Sleeves continue outward from the shoulder.
    const shellHalf = b.chestHalf + d + ease, photoHalf = (W || shellHalf * 2) / 2;
    const kx = Math.max(0.8, Math.min(1.9, photoHalf / shellHalf));
    const shoulderX = b.shoulderHalf * 0.97 + d;
    toFlat = (x, y) => {
      const ax = Math.abs(x);
      const fx = ax <= shoulderX ? x * kx : Math.sign(x) * (shoulderX * kx + (ax - shoulderX));
      return [fx, b.floor - y];
    };
  }
  const pl = L.place, bp = L.backPlace || L.place;
  const flatUV = (P, mirror) => (x, y) => { const [fx, fy] = toFlat(x, y), X = mirror ? -fx : fx; return [(X - P.x) / P.w, 1 - (fy - P.y) / P.h]; };
  const bodyFront = flatUV(pl, false), bodyBack = flatUV(bp, true); // seen from behind, left and right swap
  const uvFor = side => {
    if (!side) return [bodyFront, bodyBack];
    const fs = L.m?.sleeves?.[side > 0 ? 'R' : 'L'];
    const bs = (L.backM || L.m)?.sleeves?.[side > 0 ? 'L' : 'R']; // the back photo shows this arm on the other side
    const front = fs ? sleeveUV(b, f, side, fs, pl, sleeveRing) : bodyFront;
    let back = bodyBack;
    if (bs && texBack) { const g = sleeveUV(b, f, -side, bs, bp, sleeveRing); back = (x, y) => g(-x, y); }
    return [front, back];
  };
  const group = new T.Group();
  const mats = [
    new T.MeshStandardMaterial({ map: texFront.cut, alphaTest: 0.5, side: T.DoubleSide, roughness: 0.9, metalness: 0 }),
    new T.MeshStandardMaterial({ map: (texBack || texFront).cut, alphaTest: 0.5, side: T.DoubleSide, roughness: 0.9, metalness: 0,
      color: texBack ? 0xffffff : 0xd9d9d9 }), // no back photo: the front, slightly shaded
  ];
  // A sleeve mapped along its axis samples only inside the sleeve, so it needs no outline cut (which would
  // otherwise nibble holes where the sleeve tapers).
  const solid = [new T.MeshStandardMaterial({ map: texFront.padded, side: T.DoubleSide, roughness: 0.9, metalness: 0 }),
    new T.MeshStandardMaterial({ map: (texBack || texFront).padded, side: T.DoubleSide, roughness: 0.9, metalness: 0, color: texBack ? 0xffffff : 0xd9d9d9 })];
  for (const { geo, side } of geos) {
    const [uf, ub] = uvFor(side);
    const along = side && L.m?.sleeves?.[side > 0 ? 'R' : 'L'];
    const m = new T.Mesh(projectPhotos(geo, uf, ub, !!texBack), along ? solid : mats);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

function shoes(b, f, colour) {
  const c = colour ? new T.Color(`rgb(${colour.join(',')})`) : new T.Color(0x222222);
  const mat = new T.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0 });
  const g = new T.Group();
  for (const s of [1, -1]) {
    const m = new T.Mesh(new T.BoxGeometry(10.2, 7.2, 28.5, 3, 3, 6), mat);
    const p = m.geometry.attributes.position; // round the toe and heel a little
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i), y = p.getY(i), k = Math.min(1, Math.abs(z) / 14.25) ** 3;
      p.setX(i, p.getX(i) * (1 - 0.32 * k)); p.setY(i, y - (y > 0 ? 2.2 * k : 0));
    }
    m.geometry.computeVertexNormals();
    m.position.set(s * f.legX * 0.9, 3.6, 6.5); m.castShadow = true;
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------- stage
const stages = {}; // one renderer per stage key, reused across redraws (phones limit WebGL contexts)
const textures = new Map();
// Two textures per photo: the cutout as is (its outline cuts the shell), and a padded copy whose see-through
// pixels carry the nearest garment colour, for solid parts that may sample just past the outline.
async function texture(path, getBlob) {
  if (textures.has(path)) return textures.get(path);
  const bmp = await createImageBitmap(await getBlob(path));
  const c0 = document.createElement('canvas'); c0.width = bmp.width; c0.height = bmp.height;
  c0.getContext('2d').drawImage(bmp, 0, 0); // a canvas, not the bitmap: WebGL ignores flipY for bitmaps
  const cut = new T.Texture(c0);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  // Pull-push fill: ever smaller copies drawn underneath spread the edge colours outward.
  for (let k = 6; k >= 1; k--) {
    const w = Math.max(1, bmp.width >> k), h = Math.max(1, bmp.height >> k);
    const sm = document.createElement('canvas'); sm.width = w; sm.height = h;
    sm.getContext('2d').drawImage(bmp, 0, 0, w, h);
    for (let i = 0; i < 2; i++) sm.getContext('2d').drawImage(sm, 0, 0); // thicken its alpha
    g.drawImage(sm, 0, 0, bmp.width, bmp.height);
  }
  g.drawImage(bmp, 0, 0);
  const padded = new T.Texture(c);
  for (const t of [cut, padded]) { t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; t.flipY = true; t.needsUpdate = true; }
  const out = { cut, padded };
  textures.set(path, out);
  return out;
}

// layers: [{ item, place, backPlace, frontPath, backPath, colour }]
export async function renderStage3D(el, body, layers, { key = 'look', maxH = 0.72, getBlob, reset = false }) {
  await three();
  let st = stages[key];
  if (!st) {
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.NoToneMapping;
    const scene = new T.Scene(); scene.background = new T.Color(0xEEEEEC);
    const camera = new T.PerspectiveCamera(26, 1, 10, 3000);
    scene.add(new T.HemisphereLight(0xffffff, 0xcfcfc9, 1.35));
    const sun = new T.DirectionalLight(0xffffff, 1.6);
    sun.position.set(90, 260, 170); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 220, bottom: -20, near: 50, far: 600 });
    sun.shadow.radius = 6; sun.shadow.bias = -0.0008;
    scene.add(sun);
    const fill = new T.DirectionalLight(0xffffff, 0.45); fill.position.set(-160, 120, -120); scene.add(fill);
    const ground = new T.Mesh(new T.PlaneGeometry(800, 800), new T.ShadowMaterial({ opacity: 0.16 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const controls = new T.OrbitControls(camera, renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, enableZoom: false, rotateSpeed: 0.75,
      minPolarAngle: 1.12, maxPolarAngle: 1.72 });
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotate = !reduce; controls.autoRotateSpeed = 0.55;
    let idle;
    controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(idle); });
    controls.addEventListener('end', () => { clearTimeout(idle); if (!reduce) idle = setTimeout(() => { controls.autoRotate = true; }, 6000); });
    st = stages[key] = { renderer, scene, camera, controls, sun, root: null, tween: null, el: null };
    const loop = () => {
      requestAnimationFrame(loop);
      if (!st.el || !st.el.isConnected || document.hidden) return;
      if (st.tween) st.tween();
      controls.update();
      renderer.render(scene, camera);
      const az = controls.getAzimuthalAngle(), side = Math.abs(az) > Math.PI / 2 ? 'back' : 'front';
      if (st.side !== side) { st.side = side; st.el.closest('.onyou')?.querySelectorAll('[data-action="spin"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.to === side)); }
    };
    loop();
  }
  // Rebuild the figure and garments for this outfit.
  if (st.root) { st.scene.remove(st.root); st.root.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
  const f = frame(body);
  const root = new T.Group();
  root.add(mannequin(body, f));
  const fit = { ease: 0, sEase: 0 };
  for (const L of [...layers].sort((p, q) => (p.place.layer || 0) - (q.place.layer || 0))) {
    if (L.place.slot === 'shoes') { root.add(shoes(body, f, L.colour)); continue; }
    try {
      const front = await texture(L.frontPath, getBlob);
      const back = L.backPath ? await texture(L.backPath, getBlob) : null;
      root.add(garmentMesh(body, f, L, front, back, L.place.slot === 'bottom' ? undefined : fit));
    } catch (e) { console.warn('3D: skipped a piece', e); }
  }
  st.scene.add(root); st.root = root;
  // Mount the canvas and frame the camera around the figure.
  st.el = el;
  el.innerHTML = '';
  el.appendChild(st.renderer.domElement);
  st.renderer.domElement.classList.add('stage3d-gl');
  st.renderer.domElement.style.touchAction = 'pan-y'; // vertical swipes still scroll the page
  const size = () => {
    const w = el.clientWidth || 360, h = Math.round(Math.min(innerHeight * maxH, w * 1.45));
    st.renderer.setSize(w, h, true);
    st.camera.aspect = w / h;
    const fov = st.camera.fov * Math.PI / 180, need = body.h * 0.56;
    const dist = Math.max(need / Math.tan(fov / 2), (need * st.camera.aspect ** -1) / Math.tan(fov / 2) * 0.55);
    st.camera.updateProjectionMatrix();
    if (reset || !st.framed || st.framedFor !== body.h) {
      st.controls.target.set(0, body.h * 0.5, 0);
      st.camera.position.set(0, body.h * 0.55, dist);
      st.framed = true; st.framedFor = body.h;
    }
  };
  size();
  if (!st.ro) { st.ro = new ResizeObserver(() => st.el && size()); }
  st.ro.disconnect(); st.ro.observe(el);
  return st.renderer.domElement;
}

// Turn to face front or back, smoothly.
export function spinTo3D(key, side) {
  const st = stages[key]; if (!st) return;
  const c = st.controls, start = c.getAzimuthalAngle();
  let target = side === 'back' ? Math.PI : 0, delta = target - start;
  if (delta > Math.PI) delta -= Math.PI * 2; if (delta < -Math.PI) delta += Math.PI * 2;
  const t0 = performance.now(), ms = 700;
  c.autoRotate = false;
  st.tween = () => {
    const t = Math.min(1, (performance.now() - t0) / ms), e = 1 - Math.pow(1 - t, 3);
    const az = start + delta * e, r = st.camera.position.clone().sub(c.target), rad = Math.hypot(r.x, r.z);
    st.camera.position.set(c.target.x + Math.sin(az) * rad, st.camera.position.y, c.target.z + Math.cos(az) * rad);
    if (t >= 1) st.tween = null;
  };
}

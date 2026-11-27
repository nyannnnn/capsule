// Pure logic: no DOM, no storage. Testable in Node.

export const CATEGORIES = {
  tshirt:   { label: 'T-shirt',      slot: 'top',       grams: 180 },
  longsleeve:{ label: 'Long sleeve', slot: 'top',       grams: 250 },
  shirt:    { label: 'Shirt',        slot: 'top',       grams: 250 },
  polo:     { label: 'Polo',         slot: 'top',       grams: 220 },
  tank:     { label: 'Tank top',     slot: 'top',       grams: 120 },
  sweater:  { label: 'Sweater',      slot: 'top',       grams: 450, warm: true },
  hoodie:   { label: 'Hoodie',       slot: 'top',       grams: 600, warm: true },
  jacket:   { label: 'Jacket',       slot: 'outer',     grams: 800 },
  coat:     { label: 'Coat',         slot: 'outer',     grams: 1500, warm: true },
  jeans:    { label: 'Jeans',        slot: 'bottom',    grams: 650 },
  trousers: { label: 'Trousers',     slot: 'bottom',    grams: 450 },
  shorts:   { label: 'Shorts',       slot: 'bottom',    grams: 250, hot: true },
  sweatpants:{ label: 'Sweatpants',  slot: 'bottom',    grams: 500 },
  shoes:    { label: 'Shoes',        slot: 'shoes',     grams: 900 },
  boots:    { label: 'Boots',        slot: 'shoes',     grams: 1500, warm: true },
  sandals:  { label: 'Sandals',      slot: 'shoes',     grams: 400, hot: true },
  hat:      { label: 'Hat',          slot: 'accessory', grams: 120 },
  belt:     { label: 'Belt',         slot: 'accessory', grams: 150 },
  bag:      { label: 'Bag',          slot: 'accessory', grams: 600 },
  scarf:    { label: 'Scarf',        slot: 'accessory', grams: 150, warm: true },
  underwear:{ label: 'Underwear',    slot: 'basics',    grams: 60 },
  socks:    { label: 'Socks',        slot: 'basics',    grams: 50 },
  gym:      { label: 'Gym / boxing', slot: 'sport',     grams: 250 },
  other:    { label: 'Other',        slot: 'other',     grams: 300 },
};

export const FATES = {
  undecided: { label: 'Undecided' },
  carry:     { label: 'Carry to China' },
  ship:      { label: 'Ship to Canada' },
  toss:      { label: 'Toss' },
};

export const STYLES = ['casual', 'work', 'smart', 'street', 'sport', 'outdoor'];
export const SEASONS = ['spring', 'summer', 'fall', 'winter'];

const NEUTRALS = ['black', 'white', 'grey', 'gray', 'navy', 'beige', 'khaki', 'denim',
  'brown', 'olive', 'cream', 'charcoal', 'tan', 'stone', 'indigo'];

export function isNeutral(colour) {
  const c = (colour || '').toLowerCase();
  if (!c) return true;
  return NEUTRALS.some(n => c.includes(n));
}

// Weight in grams: what you entered, else a category estimate.
export function itemWeight(item) {
  const w = Number(item.weight_g);
  if (w > 0) return { grams: w, estimated: false };
  const cat = CATEGORIES[item.category] || CATEGORIES.other;
  return { grams: cat.grams, estimated: true };
}

// ---- Japan Post International Parcel Post, Zone 3 (Canada). Checked Nov 2026. ----
// Index i = price for "up to (i+1) kg". 30 kg max per parcel.
export const JP_RATES = {
  surface: [2500,3100,3700,4300,4900,5500,6100,6700,7300,7900,8300,8700,9100,9500,9900,
            10300,10700,11100,11500,11900,12300,12700,13100,13500,13900,14300,14700,15100,15500,15900],
  sal:     [2800,4000,5200,6400,7600,8600,9600,10600,11600,12600,13600,14600,15600,16600,17600,
            18600,19600,20600,21600,22600,23600,24600,25600,26600,27600,28600,29600,30600,31600,32600],
  air:     [3850,6000,8150,10300,12450,14600,16750,18900,21050,23200,24800,26400,28000,29600,31200,
            32800,34400,36000,37600,39200,40800,42400,44000,45600,47200,48800,50400,52000,53600,55200],
};
export const MODE_LABELS = { surface: 'Sea (≈2 months)', sal: 'SAL economy air', air: 'Airmail' };
export const MAX_PARCEL_KG = 30;

export function parcelPrice(kg, mode = 'surface') {
  if (kg <= 0) return 0;
  const steps = Math.ceil(kg - 1e-9);
  if (steps > MAX_PARCEL_KG) return null;
  return JP_RATES[mode][steps - 1];
}

// Split items' total weight into the fewest boxes (≤30 kg incl. box), even split.
export function shipPlan(totalItemGrams, boxTareKg = 1, mode = 'surface') {
  const itemsKg = totalItemGrams / 1000;
  if (itemsKg <= 0) return { boxes: [], total: 0, itemsKg: 0 };
  const capacity = MAX_PARCEL_KG - boxTareKg;
  const n = Math.max(1, Math.ceil(itemsKg / capacity));
  const per = itemsKg / n + boxTareKg;
  const price = parcelPrice(per, mode);
  const boxes = Array.from({ length: n }, () => ({ kg: per, price }));
  return { boxes, total: price * n, itemsKg };
}

// Marginal yen per extra kg at the current shipping weight (sea by default).
export function marginalYenPerKg(totalItemGrams, boxTareKg = 1, mode = 'surface') {
  const base = shipPlan(totalItemGrams, boxTareKg, mode).total;
  const plus = shipPlan(totalItemGrams + 1000, boxTareKg, mode).total;
  return Math.max(0, plus - base);
}

// ---- Measuring from a photo with a reference object ----
export const REFERENCES = {
  card:   { label: 'Credit / IC card (long edge)', cm: 8.56 },
  a4:     { label: 'A4 paper (long edge)', cm: 29.7 },
  yen1000:{ label: '¥1000 bill (long edge)', cm: 15.0 },
  iphone: { label: 'Phone (enter length)', cm: null },
};

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function measureCm(refA, refB, refCm, p, q) {
  const refPx = dist(refA, refB);
  if (!refPx || !refCm) return null;
  return Math.round((dist(p, q) / refPx) * refCm * 10) / 10;
}

// ---- Fit from flat garment width vs body circumference ----
// tops: width = pit-to-pit flat; bottoms: width = waist flat.
export function fitEstimate(item, profile) {
  const cat = CATEGORIES[item.category];
  const w = Number(item.width_cm);
  if (!cat || !w || !profile) return null;
  let body, part;
  if (cat.slot === 'top' || cat.slot === 'outer') { body = Number(profile.chest_cm); part = 'chest'; }
  else if (cat.slot === 'bottom') { body = Number(profile.waist_cm); part = 'waist'; }
  else return null;
  if (!body) return null;
  const ease = Math.round((w * 2 - body) * 10) / 10;
  let verdict;
  if (cat.slot === 'bottom') {
    verdict = ease < -2 ? 'Too small' : ease <= 3 ? 'Fits' : ease <= 8 ? 'Loose (belt)' : 'Too big';
  } else {
    verdict = ease < 2 ? 'Too tight' : ease < 8 ? 'Slim' : ease < 16 ? 'Regular' : ease < 26 ? 'Relaxed' : 'Oversized';
  }
  return { ease, part, verdict };
}

// ---- Similarity: same category + same colour family ----
export function colourFamily(colour) {
  const c = (colour || '').toLowerCase().trim();
  const map = [['black','black'],['charcoal','grey'],['grey','grey'],['gray','grey'],['white','white'],
    ['cream','white'],['navy','navy'],['indigo','navy'],['denim','denim'],['blue','blue'],['beige','beige'],
    ['khaki','beige'],['tan','beige'],['stone','beige'],['brown','brown'],['olive','green'],['green','green'],
    ['red','red'],['burgundy','red'],['pink','pink'],['purple','purple'],['yellow','yellow'],['orange','orange']];
  for (const [k, v] of map) if (c.includes(k)) return v;
  return c || 'unknown';
}

export function similarGroups(items) {
  const groups = {};
  for (const it of items) {
    if (it.fate === 'toss') continue;
    const key = `${it.category}|${colourFamily(it.colour)}`;
    (groups[key] ||= []).push(it);
  }
  return groups;
}

export function similarTo(item, items) {
  const key = `${item.category}|${colourFamily(item.colour)}`;
  return items.filter(i => i.id !== item.id && i.fate !== 'toss' &&
    `${i.category}|${colourFamily(i.colour)}` === key);
}

// ---- Outfit suggestion ----
function daysSince(dateStr, today) {
  if (!dateStr) return 60;
  const d = (new Date(today) - new Date(dateStr)) / 86400000;
  return Math.max(0, Math.min(60, d));
}

function seasonFor(tempC) {
  if (tempC == null) return null;
  if (tempC >= 24) return 'summer';
  if (tempC <= 8) return 'winter';
  return null; // shoulder seasons: anything goes
}

export function wearable(item) {
  return item.fate !== 'toss' && !item.away;
}

function scoreItem(item, ctx) {
  const cat = CATEGORIES[item.category] || CATEGORIES.other;
  let s = 1 + daysSince(item.last_worn, ctx.today) / 10;           // freshness
  if (ctx.style && item.styles?.length) s *= item.styles.includes(ctx.style) ? 2 : 0.3;
  const season = seasonFor(ctx.tempC);
  if (season && item.seasons?.length && !item.seasons.includes(season)) s *= 0.2;
  if (ctx.tempC != null) {
    if (cat.warm && ctx.tempC >= 22) s *= 0.1;
    if (cat.hot && ctx.tempC < 20) s *= 0.05;
  }
  return s;
}

function weightedPick(items, ctx, rand) {
  const scored = items.map(i => [i, scoreItem(i, ctx)]).filter(([, s]) => s > 0);
  const total = scored.reduce((a, [, s]) => a + s, 0);
  if (!total) return null;
  let r = rand() * total;
  for (const [i, s] of scored) { r -= s; if (r <= 0) return i; }
  return scored[scored.length - 1][0];
}

function colourOk(picked, candidate) {
  const loud = picked.filter(p => p && !isNeutral(p.colour)).length;
  return isNeutral(candidate.colour) || loud === 0;
}

export function suggestOutfit(items, ctx, rand = Math.random, locked = {}) {
  const pool = items.filter(wearable);
  const bySlot = s => pool.filter(i => (CATEGORIES[i.category] || CATEGORIES.other).slot === s);
  const t = ctx.tempC;
  const needOuter = t != null && t < 18;
  const slots = ctx.style === 'sport' ? ['sport', 'bottom', 'shoes'] : ['top', 'bottom', 'shoes'];
  if (needOuter) slots.splice(1, 0, 'outer');
  const out = {};
  for (const slot of slots) {
    if (locked[slot]) { out[slot] = locked[slot]; continue; }
    let candidates = bySlot(slot);
    if (slot === 'sport' && !candidates.length) candidates = bySlot('top');
    if (slot === 'outer' && t != null && t < 8) {
      const warm = candidates.filter(i => CATEGORIES[i.category]?.warm);
      if (warm.length) candidates = warm;
    }
    const picked = Object.values(out);
    const harmonious = candidates.filter(c => colourOk(picked, c));
    out[slot] = weightedPick(harmonious.length ? harmonious : candidates, ctx, rand);
  }
  return out;
}

export function outfitTip(tempC) {
  if (tempC == null) return '';
  if (tempC < 8) return 'Cold. Warm outer layer picked.';
  if (tempC < 14) return 'Cool. Layer up, a sweater under the jacket works.';
  if (tempC < 18) return 'Mild. A light jacket is enough.';
  if (tempC < 24) return 'Comfortable. No outer layer needed.';
  return 'Hot. Keep it light.';
}

// ---- Bulk decisions pasted back from Claude: "12 ship", "#13: toss", or JSON {"12":"ship"} ----
export function parseDecisions(text) {
  const out = {};
  const t = (text || '').trim();
  if (!t) return out;
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t);
      for (const [k, v] of Object.entries(obj)) {
        const f = normFate(v);
        if (f && /^\d+$/.test(k.replace('#', ''))) out[Number(k.replace('#', ''))] = f;
      }
      return out;
    } catch { /* fall through to line parsing */ }
  }
  for (const line of t.split(/\n|,|;/)) {
    const m = line.match(/#?\s*(\d+)\s*[:\-=→>\s]+\s*([a-z ]+)/i);
    if (m) { const f = normFate(m[2]); if (f) out[Number(m[1])] = f; }
  }
  return out;
}

function normFate(v) {
  const s = String(v).toLowerCase().trim();
  if (s.startsWith('ship') || s.includes('canada')) return 'ship';
  if (s.startsWith('carry') || s.includes('china') || s.startsWith('bring')) return 'carry';
  if (s.startsWith('toss') || s.startsWith('throw') || s.startsWith('donate') || s.startsWith('bin')) return 'toss';
  if (s.startsWith('undecided') || s.startsWith('unsure')) return 'undecided';
  return null;
}

// ---- Text export for Claude ----
export function claudeSummary(items, profile, settings) {
  const lines = [];
  lines.push('# My wardrobe (from my wardrobe app)');
  lines.push('');
  const p = profile || {};
  const body = [
    p.height_cm && `height ${p.height_cm} cm`, p.weight_kg && `weight ${p.weight_kg} kg`,
    p.chest_cm && `chest ${p.chest_cm}`, p.waist_cm && `waist ${p.waist_cm}`, p.hips_cm && `hips ${p.hips_cm}`,
    p.shoulder_cm && `shoulder ${p.shoulder_cm}`, p.sleeve_cm && `sleeve ${p.sleeve_cm}`,
    p.inseam_cm && `inseam ${p.inseam_cm}`, p.shoe_us && `shoe US ${p.shoe_us}`,
    p.usual_top && `usual top size ${p.usual_top}`, p.usual_bottom && `usual bottom size ${p.usual_bottom}`,
  ].filter(Boolean);
  if (body.length) { lines.push('Body (cm): ' + body.join(', ')); }
  if (p.notes) lines.push('Fit notes: ' + p.notes);
  if (settings) lines.push(`Box tare ${settings.boxTareKg} kg, carry allowance ${settings.carryLimitKg} kg.`);
  lines.push('');
  lines.push('No | Name | Category | Colour | Brand | Size | L×W cm | Weight g | Fit | Styles | Seasons | Worn | Last worn | Fate | Notes');
  for (const it of [...items].sort((a, b) => a.no - b.no)) {
    const w = itemWeight(it);
    const f = fitEstimate(it, profile);
    lines.push([
      `#${it.no}`, it.name || '', CATEGORIES[it.category]?.label || it.category || '', it.colour || '',
      it.brand || '', it.size || '',
      (it.length_cm || it.width_cm) ? `${it.length_cm || '?'}×${it.width_cm || '?'}` : '',
      `${w.grams}${w.estimated ? ' (est)' : ''}`,
      [it.fit, f && `${f.verdict}, ease ${f.ease}`].filter(Boolean).join('; '),
      (it.styles || []).join('/'), (it.seasons || []).join('/'),
      it.wear_count || 0, it.last_worn || '', it.fate || 'undecided', (it.notes || '').replace(/\n/g, ' '),
    ].join(' | '));
  }
  lines.push('');
  lines.push('Reply with decisions as lines like "12 ship", "13 toss", "14 carry" and I can paste them back into the app.');
  return lines.join('\n');
}

// ======================================================================
// Phase 2: true-to-scale "On you". Every value is in centimetres; y runs down from the top of the head.
// ======================================================================
const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

// Body landmarks from your measurements. Anything missing is estimated from height and weight,
// and listed in `estimated` so the app can say so.
export function bodyModel(profile = {}) {
  const estimated = [];
  const pick = (key, fallback) => { const v = num(profile[key]); if (v) return v; estimated.push(key); return fallback; };
  const h = pick('height_cm', 175);
  const kg = pick('weight_kg', 22 * (h / 100) ** 2);
  const g = Math.sqrt((kg / (h / 100) ** 2) / 22); // build relative to an average frame
  const r = Math.sqrt(h / 178);
  const chest = pick('chest_cm', 96 * g * r);
  const waist = pick('waist_cm', 80 * g ** 1.3 * r);
  const hips = pick('hips_cm', 95 * g * r);
  const shoulder = pick('shoulder_cm', 46 * (h / 178) * Math.sqrt(g));
  const inseam = pick('inseam_cm', 0.455 * h);
  const sleeve = pick('sleeve_cm', 0.345 * h);
  const hh = h / 7.6; // head height: real proportions, not a stretched fashion croquis
  return {
    h, chest, waist, hips, shoulder, inseam, sleeve, estimated: estimated.filter(k => k !== 'weight_kg'),
    head: { cy: hh * 0.5, rx: hh * 0.37, ry: hh * 0.5 },
    neckY: hh * 1.2,            // base of the neck: where a garment's length is measured from
    shoulderY: hh * 1.4,
    chestY: hh * 1.95,
    waistY: h * 0.385,
    hipY: h * 0.48,
    crotchY: h - inseam,
    kneeY: h - inseam * 0.5,
    ankleY: h - 7,
    floor: h,
    neckHalf: h * 0.034,
    shoulderHalf: shoulder / 2,
    chestHalf: chest * 0.165,
    waistHalf: waist * 0.16,
    hipHalf: hips * 0.17,
  };
}

// Typical garment lengths, used only when a piece has no length yet.
const TYPICAL_LENGTH = { tshirt: 70, longsleeve: 70, shirt: 76, polo: 70, tank: 68, sweater: 66, hoodie: 68,
  jacket: 70, coat: 100, gym: 66, jeans: 102, trousers: 102, sweatpants: 100, shorts: 50 };

// Where a garment image goes on the body. `m` describes its transparent cutout:
// { w, h } in pixels, plus `torsoPx`, the body width measured across the lower torso.
export function placeGarment(item, m, body) {
  const slot = (CATEGORIES[item.category] || CATEGORIES.other).slot;
  if (!m || !m.w || !m.h) return null;
  if (slot === 'top' || slot === 'outer' || slot === 'sport') {
    const length = num(item.length_cm) || TYPICAL_LENGTH[item.category] || 70;
    const width = num(item.width_cm);
    let s; // centimetres per pixel
    if (width && m.torsoPx) s = width / m.torsoPx;
    else s = length / (m.h * (item.category === 'hoodie' ? 0.75 : 0.95));
    // Guard against a bad torso reading: the scaled image must be about as tall as the garment's length
    // (a hood or collar can add up to ~60% on top). Otherwise scale by length instead.
    const tall = m.h * s;
    const maxTall = item.category === 'hoodie' ? 1.65 : 1.25; // only hoods add much height above the neck
    if (tall < length * 0.85 || tall > length * maxTall) s = length / (m.h * (item.category === 'hoodie' ? 0.75 : 0.95));
    const W = m.w * s, H = m.h * s;
    const hemY = body.neckY + length;
    return { slot, x: -W / 2, y: hemY - H, w: W, h: H, hemY, scale: s, layer: slot === 'outer' ? 3 : 2, torsoCm: (m.torsoPx || 0) * s || null };
  }
  if (slot === 'bottom') {
    const topY = body.waistY + (body.hipY - body.waistY) * 0.25; // trousers sit just below the natural waist
    const length = num(item.length_cm) || Math.min(TYPICAL_LENGTH[item.category] || 100, body.floor - topY - 1);
    const s = length / m.h;
    const W = m.w * s;
    return { slot, x: -W / 2, y: topY, w: W, h: length, hemY: topY + length, scale: s, layer: 1 };
  }
  if (slot === 'shoes') {
    const s = 30 / Math.max(m.w, m.h);
    const W = m.w * s, H = m.h * s;
    return { slot, x: -W / 2, y: body.floor - H + 2, w: W, h: H, hemY: body.floor, scale: s, layer: 0 };
  }
  return null; // accessories and basics are not drawn
}

// Plain-language notes on how a piece sits, from the numbers.
export function fitHints(item, place, body, profile) {
  if (!place) return [];
  const out = [];
  const f = fitEstimate(item, profile);
  if (place.slot === 'bottom') {
    const y = place.hemY;
    out.push(y < body.ankleY - 6 ? 'Cropped, hem above the ankle'
      : y < body.ankleY - 1 ? 'Ankle length'
      : y < body.floor - 1.5 ? 'Slight break at the shoe'
      : 'Full break, will stack at the shoe');
    if (f) out.push(`${f.verdict} at the waist${f.ease ? `, ${f.ease > 0 ? '+' : ''}${f.ease} cm` : ''}`);
  } else if (place.slot !== 'shoes') {
    const y = place.hemY;
    out.push(y < body.waistY + 3 ? 'Cropped, hem at the waist'
      : y < body.hipY - 2 ? 'Hem at the high hip'
      : y < body.crotchY - 2 ? 'Hem at mid-hip'
      : y < body.crotchY + 7 ? 'Hem at the seat'
      : 'Long, hem on the thigh');
    if (f) out.push(`${f.verdict} through the chest, ${f.ease > 0 ? '+' : ''}${f.ease} cm of room`);
  }
  return out;
}

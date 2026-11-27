import {
  CATEGORIES, FATES, STYLES, SEASONS, REFERENCES, MODE_LABELS, itemWeight, shipPlan, marginalYenPerKg,
  measureCm, fitEstimate, similarTo, colourFamily, suggestOutfit, outfitTip, parseDecisions, claudeSummary,
  bodyModel, placeGarment, fitHints,
} from './logic.js?v=202611271136';
import { createStore, uuid, compressPhoto, blobToDataUrl, dataUrlToBlob } from './store.js?v=202611271136';
import { cutout, preload as preloadCutouts } from './bg.js?v=202611271136';
import { renderStage3D, spinTo3D, webglAvailable } from './tryon3d.js?v=202611271136';
import { measure, renderStage, spinTo } from './tryon.js?v=202611271136';

// ------------------------------------------------------------------ state
const DEFAULT_SETTINGS = { boxTareKg: 1, carryLimitKg: 30, house: 'Max Luo', departure: '2026-12-17' };
const VIEWS = { archive: 'Archive', look: 'Look', travel: 'Travel', fitting: 'Fitting' };
const SLOT_FILTERS = [['', 'All'], ['top', 'Tops'], ['bottom', 'Bottoms'], ['outer', 'Outerwear'], ['shoes', 'Shoes'],
  ['accessory', 'Accessories'], ['basics', 'Basics'], ['sport', 'Training']];
const FATE_NAMES = { undecided: 'Unsorted', carry: 'Carry', ship: 'Ship', toss: 'Toss' };

const stored = (() => { try { return localStorage.getItem('view'); } catch { return null; } })();
const S = {
  store: createStore(),
  items: [], profile: {}, wears: [], urls: {},
  view: VIEWS[stored] ? stored : 'archive',
  filter: { q: '', slot: '', fate: '', sort: 'no' },
  today: { tempC: null, feels: null, hi: null, lo: null, style: '', locked: {}, outfit: null, place: '', fresh: true },
  pack: { tab: 'undecided' },
  draft: null, draftBlobs: null, decisions: null, introDone: false,
  lookMode: (() => { try { return localStorage.getItem('lookMode') || 'flat'; } catch { return 'flat'; } })(),
};
const settings = () => ({ ...DEFAULT_SETTINGS, ...(S.profile.settings || {}) });

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => '¥' + Math.round(n).toLocaleString('en-US');
const kg = g => (g / 1000).toFixed(1);
const todayStr = () => new Date().toLocaleDateString('en-CA');
const catLabel = c => CATEGORIES[c]?.label || 'Other';
const pad = n => String(n).padStart(3, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const nextNo = () => S.items.reduce((m, i) => Math.max(m, i.no || 0), 0) + 1;
const byId = id => S.items.find(i => i.id === id);
// Display prefers the background-removed cutout; originals stay for measuring.
const thumb = it => S.urls[it.cut_path] || S.urls[it.thumb_path] || S.urls[it.photo_path] || '';
const full = it => S.urls[it.cut_path] || S.urls[it.photo_path] || S.urls[it.thumb_path] || '';
const backThumb = it => S.urls[it.back_cut_path] || S.urls[it.back_thumb_path] || S.urls[it.back_path] || '';
const backFull = it => S.urls[it.back_cut_path] || S.urls[it.back_path] || S.urls[it.back_thumb_path] || '';
const original = (it, side) => side === 'back' ? (S.urls[it.back_path] || S.urls[it.back_thumb_path] || '') : (S.urls[it.photo_path] || S.urls[it.thumb_path] || '');
const cutCls = it => (it && S.urls[it.cut_path] ? 'cut' : '');
const PHOTO_KEYS = { photo_path: 'full', thumb_path: 'thumb', back_path: 'back', back_thumb_path: 'backthumb', cut_path: 'cut', back_cut_path: 'backcut', fit_path: 'fit', back_fit_path: 'backfit' };
const cleanMode = () => { try { return localStorage.getItem('clean') !== '0'; } catch { return true; } };

// Cut the garment out of its background and store two copies: the studio shot for display and a
// transparent one for the On you view. Sets the row's fields; returns false if it fails.
let cutCount = 0;
async function applyCutout(row, id, blob, side = 'front', label = '') {
  const back = side === 'back';
  try {
    const out = await cutout(blob, (key, cur, total) => {
      if (/fetch/.test(key) && total && cutCount === 0) toast(`Downloading the cutout model, ${Math.round(cur / total * 100)}%`);
    });
    cutCount++;
    row[back ? 'back_cut_path' : 'cut_path'] = await S.store.uploadPhoto(S.store.photoPath(id, back ? 'backcut' : 'cut', out.display.type), out.display);
    row[back ? 'back_fit_path' : 'fit_path'] = await S.store.uploadPhoto(S.store.photoPath(id, back ? 'backfit' : 'fit', out.fit.type), out.fit);
    return true;
  } catch (e) {
    console.warn('cutout failed', e);
    toast(`Background cleanup failed${label ? ' for ' + label : ''}. The original photo is kept`);
    return false;
  }
}
const pairMode = () => { try { return localStorage.getItem('pairs') === '1'; } catch { return false; } };
const slotOf = it => (CATEGORIES[it.category] || CATEGORIES.other).slot;

let toastTimer, undoFn = null;
// A toast can carry an Undo action; it then stays a little longer and accepts taps.
function toast(msg, undo = null) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (undo ? '<button type="button" class="undo">Undo</button>' : '');
  undoFn = undo;
  t.classList.toggle('actionable', !!undo);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show', 'actionable'); undoFn = null; }, undo ? 5000 : 2600);
}

// Fate changes with Undo.
async function changeFates(changes, msg) {
  const before = changes.map(({ id }) => ({ id, fate: byId(id)?.fate || 'undecided' }));
  const ok = await setFates(changes);
  render();
  if (ok) toast(msg, async () => { await setFates(before); render(); toast('Undone'); }); // a failed save keeps its error toast
}

// Deletes wait five seconds so they can be undone; leaving the app finishes them straight away.
const pendingDeletes = new Map();
function deleteLater(items, msg) {
  const ids = new Set(items.map(i => i.id));
  S.items = S.items.filter(i => !ids.has(i.id));
  render();
  const timer = setTimeout(() => flushDeletes(), 5200);
  items.forEach(it => pendingDeletes.set(it.id, { it, timer }));
  toast(msg, () => {
    clearTimeout(timer);
    items.forEach(it => pendingDeletes.delete(it.id));
    S.items.push(...items); S.items.sort((a, b) => a.no - b.no);
    render(); toast('Restored');
  });
}
async function flushDeletes() {
  const all = [...pendingDeletes.values()];
  pendingDeletes.clear();
  for (const { it, timer } of all) { clearTimeout(timer); await guard(() => S.store.deleteItem(it), 'Couldn’t delete'); }
}
async function guard(fn, failMsg = 'Didn’t save') {
  try { return await fn(); } catch (e) {
    console.error(e);
    const offline = !navigator.onLine || /fetch|network|load failed/i.test(e.message || '');
    toast(offline ? 'No connection. That change didn’t save' : `${failMsg}: ${e.message || e}`);
  }
}

// Replacing a focused input fires blur/change mid-swap; ignore re-entrant paints.
let painting = false;
function paint(el, html) {
  if (painting) return;
  painting = true;
  try { el.innerHTML = html; } finally { painting = false; }
  revealImages(el);
}
// Soft fade-in for photos as they arrive.
function revealImages(root) {
  root.querySelectorAll('img.fade').forEach(img => { if (img.complete && img.naturalWidth) img.classList.add('in'); });
}
document.addEventListener('load', e => { if (e.target.tagName === 'IMG') e.target.classList.add('in'); }, true);

// Smooth transitions where the browser supports them.
function transition(fn) {
  if (!document.startViewTransition || reduced()) { fn(); return Promise.resolve(); }
  return document.startViewTransition(fn).finished.catch(() => {});
}

// In-page confirmation, since the browser's own confirm dialog is blocked in some frames.
function ask(message, okLabel = 'Confirm', danger = false) {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'scrim';
    root.style.alignItems = 'center'; root.style.justifyContent = 'center';
    root.innerHTML = `<div class="sheet dialog" role="alertdialog" aria-modal="true">
      <p style="font-size:16px">${esc(message)}</p>
      <div class="row" style="margin-top:22px"><button class="btn quiet grow" data-r="0">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'solid'} grow" data-r="1">${esc(okLabel)}</button></div></div>`;
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-r]');
      if (b || e.target === root) { root.remove(); resolve(b?.dataset.r === '1'); }
    });
    document.body.appendChild(root);
    root.querySelector('[data-r="1"]').focus();
  });
}

async function refreshUrls(items = S.items) {
  const paths = items.flatMap(i => Object.keys(PHOTO_KEYS).map(k => i[k])).filter(Boolean);
  Object.assign(S.urls, await S.store.photoUrls(paths));
}
// Last good copy of the archive, shown when the database can't be reached (no signal, or blocked).
function saveSnapshot() {
  if (S.store.mode !== 'cloud') return;
  try { localStorage.setItem('snapshot', JSON.stringify({ at: Date.now(), items: S.items, profile: S.profile, wears: S.wears, urls: S.urls })); } catch {}
}
function loadSnapshot() {
  try {
    const snap = JSON.parse(localStorage.getItem('snapshot') || 'null');
    if (!snap?.items) return false;
    Object.assign(S, { items: snap.items, profile: snap.profile || {}, wears: snap.wears || [], urls: { ...snap.urls, ...S.urls }, offline: snap.at });
    return true;
  } catch { return false; }
}
const offlineNote = () => S.offline
  ? `<div class="offlinebar" role="status">Offline. Showing your archive as of ${esc(new Date(S.offline).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}. Changes won’t save until you’re back online.</div>` : '';

async function loadAll() {
  const [items, profile, wears] = await Promise.all([S.store.listItems(), S.store.getProfile(), S.store.listWears()]);
  S.items = items.filter(i => !pendingDeletes.has(i.id)); S.profile = profile || {}; S.wears = wears || [];
  await refreshUrls();
  S.offline = false;
  saveSnapshot();
}

function photo(it, kind = 'thumb') {
  const src = kind === 'full' ? full(it) : thumb(it);
  return src
    ? `<img class="fade" src="${esc(src)}" alt="${esc(it.name || catLabel(it.category))}" loading="lazy">`
    : '<span class="none">No photo</span>';
}

// ------------------------------------------------------------------ shell
function wordmark() {
  const name = settings().house || 'Closet';
  if (S.introDone || reduced()) return esc(name);
  return [...name].map((ch, i) => `<span style="--i:${i}">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join('');
}

function render() {
  const app = $('#app');
  if (S.needSignIn) { paint(app, signInView()); return; }
  if (S.view === 'look' && !S.today.outfit) shuffle();
  const views = S.loading ? { archive: skeletonView, look: skeletonView, travel: skeletonView, fitting: skeletonView }
    : { archive: archiveView, look: lookView, travel: travelView, fitting: fittingView };
  const navs = () => Object.entries(VIEWS).map(([v, l]) =>
    `<button class="navlink" data-action="go" data-view="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${l}</button>`).join('');
  const tabs = () => Object.entries(VIEWS).map(([v, l]) =>
    `<button class="tab" data-action="go" data-view="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${TAB_ICONS[v]}<span>${l}</span></button>`).join('');
  paint(app, `
    <header class="mast">
      <nav aria-label="Sections">${navs()}</nav>
      <h1 class="wordmark ${S.introDone ? '' : 'intro'}">${wordmark()}</h1>
      <div class="right">
        <button class="textbtn add" data-action="add">Add pieces</button>
        <button class="textbtn themebtn" data-action="theme" aria-label="Switch between light and dark">${themeLabel()}</button>
        <button class="iconbtn addicon" data-action="add" aria-label="Add pieces"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
    </header>
    <main>${offlineNote()}<div class="view" data-view="${S.view}">${views[S.view]()}</div></main>
    <nav class="tabbar" aria-label="Sections">${tabs()}</nav>
    ${installTip()}
    <input type="file" id="pick" accept="image/*" multiple hidden>
    <input type="file" id="camera" accept="image/*" capture="environment" hidden>
    <input type="file" id="importfile" accept="application/json" hidden>`);
  S.introDone = true;
  S.today.fresh = false;
  if (S.view === 'look' && S.lookMode === 'body' && !S.loading) fillLookOnYou();
}

const TAB_ICONS = {
  archive: '<svg viewBox="0 0 24 24"><path d="M12 7.2a2.1 2.1 0 1 1 2.1 2.1c-1 .2-2.1.8-2.1 2.1m0 0L3.4 17c-.8.5-.5 1.6.5 1.6h16.2c1 0 1.3-1.1.5-1.6L12 11.4"/></svg>',
  look: '<svg viewBox="0 0 24 24"><path d="M9 3.8 4.2 6.4l1.6 4.2 1.9-.7V20.2h8.6V9.9l1.9.7 1.6-4.2L15 3.8c-.5 1.4-1.6 2.3-3 2.3S9.5 5.2 9 3.8z"/></svg>',
  travel: '<svg viewBox="0 0 24 24"><rect x="4" y="7.5" width="16" height="12.5" rx="1"/><path d="M9 7.5V5h6v2.5M8 11v6M16 11v6"/></svg>',
  fitting: '<svg viewBox="0 0 24 24"><path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="M7.5 12.5l1.8 1.8M10.5 9.5l1.8 1.8M13.5 6.5l1.8 1.8"/></svg>',
};

// One-time tip on iPhone Safari: opened from the Home Screen, Capsule runs full screen like an app.
function installTip() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let dismissed = false; try { dismissed = localStorage.getItem('installTip') === 'done'; } catch {}
  if (!ios || navigator.standalone || dismissed) return '';
  return `<div class="installtip" role="note"><span>For the full-screen app: tap <b>Share</b>, then <b>Add to Home Screen</b>.</span>
    <button class="textbtn" data-action="dismiss-tip">Got it</button></div>`;
}

function themeLabel() {
  const t = document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? 'Light' : 'Dark';
}

function go(view) {
  if (view === S.view) return;
  S.view = view;
  try { localStorage.setItem('view', view); } catch {}
  if (view === 'look') S.today.fresh = true;
  transition(() => { render(); scrollTo(0, 0); });
}

// Calm placeholder while the archive loads: the page keeps its shape instead of jumping.
function skeletonView() {
  return `<div class="pagehead skel"><div><span class="bar w30"></span><span class="bar big w50"></span></div></div>
    <div class="grid skel" aria-hidden="true">${Array.from({ length: 8 }, () =>
      '<div class="piece"><div class="frame"></div><div class="caption"><span class="bar w70"></span><span class="bar w40"></span></div></div>').join('')}</div>`;
}

// ------------------------------------------------------------------ sign in
function signInView() {
  return `<form class="signin" data-form="signin">
    <h1 class="wordmark">${esc(settings().house)}</h1>
    <label class="field"><span class="label">Email</span><input type="email" id="si-email" name="email" autocomplete="username" required></label>
    <label class="field"><span class="label">Password</span><input type="password" id="si-pass" name="password" autocomplete="current-password" required></label>
    <button class="btn solid block">Sign in</button>
    <p class="err" id="signin-err"></p>
  </form>`;
}

// ------------------------------------------------------------------ archive
function filtered() {
  const { q, slot, fate, sort } = S.filter;
  const qq = q.trim().toLowerCase();
  const list = S.items.filter(i =>
    (!slot || slotOf(i) === slot) && (!fate || (i.fate || 'undecided') === fate) &&
    (!qq || [i.name, i.colour, i.brand, i.notes, catLabel(i.category), 'no ' + i.no, '#' + i.no].join(' ').toLowerCase().includes(qq)));
  const sorters = {
    no: (a, b) => a.no - b.no,
    newest: (a, b) => b.no - a.no,
    least: (a, b) => (a.wear_count || 0) - (b.wear_count || 0) || a.no - b.no,
    most: (a, b) => (b.wear_count || 0) - (a.wear_count || 0) || a.no - b.no,
  };
  return list.sort(sorters[sort]);
}

function pieceHtml(it) {
  const fate = it.fate || 'undecided';
  return `<button class="piece" data-action="open" data-id="${it.id}" data-away="${!!it.away}">
    <div class="frame ${cutCls(it)}">${photo(it)}${backThumb(it) ? `<img class="back" src="${esc(backThumb(it))}" alt="" loading="lazy">` : ''}${fate !== 'undecided' ? `<span class="fate-tag ${fate}">${FATE_NAMES[fate]}</span>` : ''}</div>
    <div class="caption">
      <span class="name">${esc(it.name || catLabel(it.category))}</span><span class="no">No. ${pad(it.no)}</span>
      <span class="sub">${esc([it.brand, it.colour, it.size && 'Size ' + it.size].filter(Boolean).join(' · ') || 'Add details')}</span>
    </div>
  </button>`;
}

function archiveView() {
  if (!S.items.length) return `<section class="empty">
      <span class="label">The archive</span>
      <h2 class="display">Nothing here yet.</h2>
      <p class="muted">Lay each piece flat with a credit card beside it and shoot from straight above. You can add a whole batch at once.</p>
      <div class="row"><button class="btn solid" data-action="add">Add pieces</button></div>
    </section>`;
  const list = filtered(), f = S.filter;
  const worn = S.items.reduce((a, i) => a + (i.wear_count || 0), 0);
  return `
    <div class="pagehead">
      <div><span class="label">The archive</span><h2 class="display page-title">${plural(S.items.length, 'piece')}</h2></div>
      <div class="meta"><span class="label">${plural(worn, 'wear')} logged</span></div>
    </div>
    <div class="palette" id="palette" aria-label="Colours across your wardrobe">${paletteHtml()}</div>
    <div class="toolbar">
      <div class="tabs scroll" role="tablist">${SLOT_FILTERS.map(([k, l]) =>
        `<button class="textbtn" data-action="slot" data-slot="${k}" aria-pressed="${f.slot === k}">${l}</button>`).join('')}</div>
      <div class="row spread" style="margin-bottom:28px">
        <input type="search" id="search" class="search grow" placeholder="Search name, brand, colour or number" value="${esc(f.q)}" data-bind="filter.q" aria-label="Search the archive">
        <button class="iconbtn filterbtn" data-action="filters" aria-label="Sort and filter">
          <svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>${f.fate || f.sort !== 'no' ? '<i class="dot"></i>' : ''}
        </button>
        <div class="row selects">
          <select id="fate-filter" data-bind="filter.fate" aria-label="Filter by fate"><option value="">Any fate</option>
            ${Object.keys(FATES).map(k => `<option value="${k}" ${f.fate === k ? 'selected' : ''}>${FATE_NAMES[k]}</option>`).join('')}</select>
          <select id="sort" data-bind="filter.sort" aria-label="Sort">
            ${[['no', 'Archive order'], ['newest', 'Newest'], ['least', 'Least worn'], ['most', 'Most worn']]
              .map(([k, l]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
    </div>
    <div class="grid">${list.map(pieceHtml).join('') || '<p class="muted">Nothing matches.</p>'}</div>
    <button class="btn solid block" data-action="add" style="margin-top:48px;max-width:420px">Add pieces</button>`;
}

// Wardrobe palette: one swatch per piece, sampled from its cutout, ordered from dark to light by hue.
const swatches = (() => { try { return JSON.parse(localStorage.getItem('swatches') || '{}'); } catch { return {}; } })();
const swatchKey = it => it.cut_path || it.thumb_path || it.photo_path;
function paletteHtml() {
  const list = S.items.filter(i => i.fate !== 'toss' && swatches[swatchKey(i)]).map(i => ({ it: i, c: swatches[swatchKey(i)] }));
  queueMicrotask(fillSwatches);
  if (!list.length) return '';
  const hsl = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, sat, l];
  };
  // Neutrals first, dark to light; then colours around the hue wheel.
  list.sort((a, b) => {
    const [ha, sa, la] = hsl(a.c), [hb, sb, lb] = hsl(b.c);
    const na = sa < 0.18 || la < 0.12, nb = sb < 0.18 || lb < 0.12;
    if (na !== nb) return na ? -1 : 1;
    return na ? la - lb : ha - hb || la - lb;
  });
  return list.map(({ it, c }) => `<span style="background:rgb(${c.join(',')})" title="${esc(it.name || catLabel(it.category))}"></span>`).join('');
}
let filling = false;
async function fillSwatches() {
  if (filling) return;
  const todo = S.items.filter(i => swatchKey(i) && !swatches[swatchKey(i)]);
  if (!todo.length) return;
  filling = true;
  try {
    for (const it of todo) {
      try { swatches[swatchKey(it)] = await sampleColour(await S.store.getBlob(swatchKey(it)), !!it.cut_path); } catch {}
    }
    try { localStorage.setItem('swatches', JSON.stringify(swatches)); } catch {}
    const el = $('#palette'); if (el) el.innerHTML = paletteHtml();
  } finally { filling = false; }
}
// Average the garment's pixels: skip the studio backdrop on cutouts, or use the centre of a raw photo.
async function sampleColour(blob, isCut) {
  const bmp = await createImageBitmap(blob);
  const n = 48, c = document.createElement('canvas'); c.width = n; c.height = n;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (isCut) g.drawImage(bmp, 0, 0, n, n);
  else g.drawImage(bmp, bmp.width * 0.3, bmp.height * 0.3, bmp.width * 0.4, bmp.height * 0.4, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  let r = 0, gg = 0, b = 0, k = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (isCut && Math.abs(d[i] - 238) < 12 && Math.abs(d[i + 1] - 238) < 12 && Math.abs(d[i + 2] - 236) < 12) continue;
    r += d[i]; gg += d[i + 1]; b += d[i + 2]; k++;
  }
  if (!k) throw new Error('empty');
  return [Math.round(r / k), Math.round(gg / k), Math.round(b / k)];
}

// ------------------------------------------------------------------ add photos
async function addFiles(files) {
  files = [...files].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  const base = { name: '', category: 'other', fate: 'undecided', styles: [], seasons: [], wear_count: 0 };
  // In pair mode, photos are shot front then back for each piece: order by capture time, then name.
  const groups = pairMode() && files.length > 1
    ? (() => { const f = files.slice().sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name));
        const g = []; for (let i = 0; i < f.length; i += 2) g.push(f.slice(i, i + 2)); return g; })()
    : files.map(f => [f]);
  if (groups.length === 1) {
    const [front, back] = groups[0];
    openEditor({ ...base, id: uuid(), no: nextNo(), _new: true }, await compressPhoto(front), back ? await compressPhoto(back) : null);
    return;
  }
  let done = 0;
  for (const [front, back] of groups) {
    toast(`Adding ${++done} of ${groups.length}`);
    await guard(async () => {
      const id = uuid(), row = { ...base, id, no: nextNo() };
      const f = await compressPhoto(front);
      row.photo_path = await S.store.uploadPhoto(S.store.photoPath(id, 'full'), f.full);
      row.thumb_path = await S.store.uploadPhoto(S.store.photoPath(id, 'thumb'), f.thumb);
      if (back) {
        const b = await compressPhoto(back);
        row.back_path = await S.store.uploadPhoto(S.store.photoPath(id, 'back'), b.full);
        row.back_thumb_path = await S.store.uploadPhoto(S.store.photoPath(id, 'backthumb'), b.thumb);
        if (cleanMode()) { toast(`Cleaning up ${done} of ${groups.length}`); await applyCutout(row, id, b.full, 'back'); }
      }
      if (cleanMode()) { toast(`Cleaning up ${done} of ${groups.length}`); await applyCutout(row, id, f.full, 'front'); }
      S.items.push(await S.store.saveItem(row));
    }, 'Couldn’t add a photo');
  }
  await refreshUrls();
  toast(`Added ${plural(groups.length, 'piece')}`);
  render();
}

// ------------------------------------------------------------------ product page (item editor)
const EDIT_KEYS = ['name', 'category', 'colour', 'brand', 'size', 'length_cm', 'width_cm', 'weight_g', 'condition', 'styles', 'seasons', 'fit', 'notes', 'away', 'fate'];
const editSig = d => JSON.stringify(EDIT_KEYS.map(k => (d[k] === '' || d[k] == null) ? null : Array.isArray(d[k]) ? d[k] : String(d[k])));
const isDirty = () => S.draft && (S.draftBlobs || S.draftBack || editSig(S.draft) !== S.draftSig);

function openEditor(item, blobs = null, backBlobs = null, fromEl = null, slide = 0) {
  S.draft = { ...item, styles: [...(item.styles || [])], seasons: [...(item.seasons || [])] };
  S.draftSig = editSig(S.draft);
  if (slide) { S.draftBlobs = null; S.draftBack = null; S.side = 'front'; S.showOriginal = false; renderEditor(false, slide); return; }
  S.draftBlobs = blobs; S.draftBack = backBlobs; S.side = 'front'; S.showOriginal = false;
  if (blobs) S.draftUrl = URL.createObjectURL(blobs.full);
  if (backBlobs) S.draftBackUrl = URL.createObjectURL(backBlobs.full);
  const img = fromEl?.querySelector('img');
  if (img && document.startViewTransition && !reduced()) {
    img.style.viewTransitionName = 'piece';
    document.startViewTransition(() => { img.style.viewTransitionName = ''; renderEditor(true); });
  } else renderEditor();
}

function closeSheet(animate = true) {
  const root = $('#sheet-root');
  const finish = () => {
    root.innerHTML = '';
    if (S.draftUrl) { URL.revokeObjectURL(S.draftUrl); S.draftUrl = null; }
    if (S.draftBackUrl) { URL.revokeObjectURL(S.draftBackUrl); S.draftBackUrl = null; }
    S.draft = null; S.draftBlobs = null; S.draftBack = null; S.decisions = null;
    document.body.style.overflow = '';
  };
  const scrim = root.querySelector('.scrim');
  if (!animate || !scrim || reduced()) return finish();
  scrim.classList.add('closing'); scrim.querySelector('.sheet')?.classList.add('closing');
  setTimeout(finish, 240);
}

function sheet(html, variant = '') {
  paint($('#sheet-root'), `<div class="scrim ${variant}" data-action="scrim"><div class="sheet ${variant}" role="dialog" aria-modal="true">${html}</div></div>`);
  document.body.style.overflow = 'hidden';
}

function shipCostFor(item) {
  const st = settings();
  const others = S.items.filter(i => i.fate === 'ship' && i.id !== item.id).reduce((a, i) => a + itemWeight(i).grams, 0);
  return Math.round((itemWeight(item).grams / 1000) * marginalYenPerKg(others, st.boxTareKg, 'surface') / 10) * 10;
}

function editorFacts(d) {
  const w = itemWeight(d), fit = fitEstimate(d, S.profile), sims = similarTo(d, S.items);
  return `<div class="fact"><span>Weight</span><span>${w.grams} g${w.estimated ? ', typical' : ''}</span></div>
    ${fit ? `<div class="fact"><span>Fit on your ${fit.part}</span><span>${fit.verdict}, ${fit.ease > 0 ? '+' : ''}${fit.ease} cm</span></div>` : ''}
    <div class="fact"><span>Worn</span><span>${plural(d.wear_count || 0, 'time')}${d.last_worn ? ', last ' + esc(d.last_worn) : ''}</span></div>
    <div class="fact"><span>Similar pieces</span><span>${sims.length ? sims.map(x => 'No. ' + pad(x.no)).join(', ') : 'None'}</span></div>
    ${d.fate === 'ship' ? `<div class="fact"><span>Adds to sea freight</span><span>≈ ${yen(shipCostFor(d))}</span></div>` : ''}`;
}

// Previous / next within the list the piece was opened from.
function navPos(id) { const ids = S.navIds || []; return { ids, i: ids.indexOf(id) }; }
function navBar(d) {
  const { ids, i } = navPos(d.id);
  if (d._new || i < 0) return `<span class="label">No. ${pad(d.no)}</span>`;
  return `<div class="pager">
    <button class="textbtn" data-action="nav" data-dir="-1" ${i > 0 ? '' : 'disabled'} aria-label="Previous piece">Prev</button>
    <span class="label">No. ${pad(d.no)}<span class="of"> · ${i + 1} of ${ids.length}</span></span>
    <button class="textbtn" data-action="nav" data-dir="1" ${i < ids.length - 1 ? '' : 'disabled'} aria-label="Next piece">Next</button></div>`;
}
let navigating = false;
async function navigate(dir) {
  if (navigating || !S.draft || S.draft._new) return;
  const { ids, i } = navPos(S.draft.id);
  const next = byId(ids[i + dir]);
  if (!next) return;
  navigating = true;
  try {
    if (isDirty()) await saveDraft(false); // keep what you typed, then move on
    if (S.draftUrl) { URL.revokeObjectURL(S.draftUrl); S.draftUrl = null; }
    if (S.draftBackUrl) { URL.revokeObjectURL(S.draftBackUrl); S.draftBackUrl = null; }
    await refreshUrls([next]);
    openEditor(next, null, null, null, dir);
    $('.sheet').scrollTop = 0;
  } finally { navigating = false; }
}

// Update the computed parts of the piece page without redrawing inputs (keeps focus and typing intact).
function refreshEditorBits() {
  const d = S.draft; if (!d) return;
  const t = $('#d-title'); if (t) t.textContent = d.name || 'Untitled piece';
  const k = $('#d-kicker'); if (k) k.textContent = catLabel(d.category) + (d.brand ? ' · ' + d.brand : '');
  const f = $('#d-facts'); if (f) f.innerHTML = editorFacts(d);
}

function renderEditor(morph = false, slide = 0) {
  const d = S.draft;
  const showOrig = S.showOriginal;
  const front = S.draftUrl || (showOrig ? original(d, 'front') : full(d));
  const back = S.draftBackUrl || (showOrig ? original(d, 'back') : backFull(d));
  const src = S.side === 'back' ? back : front;
  const hasCut = S.side === 'back' ? (d.back_cut_path && !S.draftBackUrl) : (d.cut_path && !S.draftUrl);
  const isCut = hasCut && !showOrig;
  const chips = (list, key) => `<div class="row" style="gap:18px">${list.map(v =>
    `<button type="button" class="textbtn" data-action="toggle-chip" data-key="${key}" data-val="${v}" aria-pressed="${d[key].includes(v)}">${v}</button>`).join('')}</div>`;
  const slot = CATEGORIES[d.category]?.slot;
  const widthHint = slot === 'bottom' ? 'Waist, laid flat' : slot === 'top' || slot === 'outer' ? 'Armpit to armpit, laid flat' : 'Widest point';
  const field = (k, label, type = 'text', extra = '') => `<label class="field"><span class="label">${label}</span>
    <input type="${type}" id="d-${k}" data-draft="${k}" value="${esc(d[k])}" ${type === 'number' ? 'inputmode="decimal" step="0.1"' : ''} ${extra}></label>`;
  sheet(`
    <div class="grabber" aria-hidden="true"></div>
    <div class="sheetbar">${navBar(d)}<button class="textbtn" data-action="close">Close</button></div>
    <div class="product ${slide > 0 ? 'slide-next' : slide < 0 ? 'slide-prev' : ''}">
      <div class="media">
        <div class="frame contain ${isCut ? 'cut' : ''}">${src ? `<img class="fade in ${S.flipping ? 'flip' : ''}" src="${esc(src)}" alt="${S.side === 'back' ? 'Back' : 'Front'} of No. ${d.no}" ${morph ? 'style="view-transition-name:piece"' : ''}>`
          : `<span class="none">${S.side === 'back' ? 'No back photo yet' : 'No photo yet'}</span>`}</div>
        <div class="mediabar">
          <div class="sides seg" role="group" aria-label="Side">
            <button type="button" data-action="side" data-side="front" aria-pressed="${S.side !== 'back'}">Front</button>
            <button type="button" data-action="side" data-side="back" aria-pressed="${S.side === 'back'}">Back</button>
          </div>
          <div class="tools">
            ${src ? '<button class="btn" data-action="measure">Measure</button>' : ''}
            <button class="btn more" data-action="more-tools" aria-expanded="false" aria-label="More photo options">•••</button>
            <div class="secondary">
              ${hasCut ? `<button class="btn" data-action="toggle-original">${showOrig ? 'Cutout' : 'Original'}</button>` : ''}
              ${!d._new && (S.side === 'back' ? d.back_path && !S.draftBackUrl : d.photo_path && !S.draftUrl) ? `<button class="btn" data-action="redo-cut">${hasCut ? 'Redo cutout' : 'Make cutout'}</button>` : ''}
              <button class="btn" data-action="replace-photo" data-side="${S.side}">${src ? 'Replace' : 'Add'} ${S.side === 'back' ? 'back' : 'photo'}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="info">
        <div style="display:grid;gap:8px">
          <span class="label" id="d-kicker">${esc(catLabel(d.category))}${d.brand ? ' · ' + esc(d.brand) : ''}</span>
          <h2 class="display title" id="d-title">${esc(d.name || 'Untitled piece')}</h2>
        </div>
        <div class="seg" role="group" aria-label="Fate">
          ${Object.keys(FATES).map(k => `<button type="button" data-action="set-fate" data-fate="${k}" aria-pressed="${(d.fate || 'undecided') === k}">${FATE_NAMES[k]}</button>`).join('')}
        </div>
        <div class="specs">
          <div class="full">${field('name', 'Name', 'text', 'placeholder="Uniqlo U crew tee"')}</div>
          <label class="field"><span class="label">Type</span><select id="d-category" data-draft="category">
            ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${d.category === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
          ${field('colour', 'Colour', 'text', 'placeholder="Black"')}
          ${field('brand', 'Brand')}
          ${field('size', 'Size on label', 'text', 'placeholder="M, 32, US 10"')}
          <div>${field('length_cm', 'Length, cm', 'number')}<span class="hint">Collar or waistband to hem</span></div>
          <div>${field('width_cm', 'Width, cm', 'number')}<span class="hint">${widthHint}</span></div>
          <div>${field('weight_g', 'Weight, g', 'number', `placeholder="≈ ${CATEGORIES[d.category]?.grams || 300}"`)}<span class="hint">Blank uses a typical weight</span></div>
          <label class="field"><span class="label">Condition</span><select id="d-condition" data-draft="condition">
            ${['', 'New', 'Good', 'Worn', 'Damaged'].map(c => `<option ${d.condition === c ? 'selected' : ''} value="${c}">${c || 'Not set'}</option>`).join('')}</select></label>
          <div class="full"><span class="label">Style</span>${chips(STYLES, 'styles')}</div>
          <div class="full"><span class="label">Season</span>${chips(SEASONS, 'seasons')}</div>
          <div class="full">${field('fit', 'How it fits', 'text', 'placeholder="Boxy, shoulders a touch tight"')}</div>
          <label class="field full"><span class="label">Notes</span><textarea id="d-notes" data-draft="notes">${esc(d.notes)}</textarea></label>
          <label class="check full"><input type="checkbox" id="d-away" data-draft="away" ${d.away ? 'checked' : ''}>Not with me right now</label>
        </div>
        <div class="facts" id="d-facts">${editorFacts(d)}</div>
        ${!d._new && DRAWN.includes(slotOf(d)) ? `<div class="onyou piece" id="piece-onyou">
          <span class="label">On you</span>
          <div class="stagewrap"><div class="stage-loading"></div></div>
          ${sideToggle()}
          <div class="hints inline" id="piece-hints"></div><div id="piece-notes"></div>
        </div>` : ''}
        ${d._new ? '' : '<button class="textbtn deletelink" data-action="delete">Delete this piece</button>'}
        <div class="actionbar">
          <button class="btn solid" data-action="save">Save</button>
          ${d._new ? '' : '<button class="btn" data-action="wear-one">Wore it today</button>'}
        </div>
      </div>
    </div>`);
  fillPieceOnYou();
}

async function saveDraft(close = true) {
  const d = S.draft;
  await guard(async () => {
    if (S.draftBlobs) {
      d.photo_path = await S.store.uploadPhoto(S.store.photoPath(d.id, 'full'), S.draftBlobs.full);
      d.thumb_path = await S.store.uploadPhoto(S.store.photoPath(d.id, 'thumb'), S.draftBlobs.thumb);
      d.cut_path = null; d.fit_path = null;
      if (cleanMode()) { toast('Cleaning up the background'); await applyCutout(d, d.id, S.draftBlobs.full, 'front'); }
    }
    if (S.draftBack) {
      d.back_path = await S.store.uploadPhoto(S.store.photoPath(d.id, 'back'), S.draftBack.full);
      d.back_thumb_path = await S.store.uploadPhoto(S.store.photoPath(d.id, 'backthumb'), S.draftBack.thumb);
      d.back_cut_path = null; d.back_fit_path = null;
      if (cleanMode()) { toast('Cleaning up the back'); await applyCutout(d, d.id, S.draftBack.full, 'back'); }
    }
    for (const k of ['length_cm', 'width_cm', 'weight_g']) d[k] = d[k] === '' || d[k] == null ? null : Number(d[k]);
    const saved = await S.store.saveItem(d);
    const idx = S.items.findIndex(i => i.id === saved.id);
    if (idx >= 0) S.items[idx] = saved; else S.items.push(saved);
    await refreshUrls([saved]);
    if (close) { closeSheet(); render(); }
    else { S.draftBlobs = null; S.draftBack = null; S.draftSig = editSig(saved); }
    toast(`Saved No. ${pad(saved.no)}`);
  });
}

// ------------------------------------------------------------------ measure overlay
function openMeasure() {
  const src = S.side === 'back' ? (S.draftBackUrl || original(S.draft, 'back')) : (S.draftUrl || original(S.draft, 'front'));
  const root = document.createElement('div');
  root.className = 'measure';
  root.innerHTML = `
    <div class="mhead">
      <div class="row"><select id="mref" class="grow" aria-label="Reference object">
        ${Object.entries(REFERENCES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <input id="mcustom" type="number" step="0.1" inputmode="decimal" placeholder="cm" style="width:90px" hidden aria-label="Reference length in cm"></div>
      <div class="step" id="mstep"></div>
    </div>
    <div class="stage"><canvas></canvas></div>
    <div class="mfoot">
      <div id="mread"></div>
      <div class="row"><button class="btn" id="mundo">Undo</button><button class="btn" id="mcancel">Cancel</button>
        <button class="btn solid grow" id="mdone" disabled>Use measurements</button></div>
    </div>`;
  document.body.appendChild(root);
  const canvas = root.querySelector('canvas'), stage = root.querySelector('.stage'), ctx = canvas.getContext('2d');
  const img = new Image(); img.src = src;
  const pts = []; let view = { s: 1, ox: 0, oy: 0, dpr: 1 }, drag = -1;
  const labels = ['Tap one end of the card’s long edge', 'Tap the other end', 'Tap the top: collar or waistband',
    'Tap the bottom hem', 'Tap one side of the width', 'Tap the other side', 'Drag a point to fine-tune'];
  const colours = ['#FFFFFF', '#FFFFFF', '#9AD0FF', '#9AD0FF', '#FFB38A', '#FFB38A'];
  const refCm = () => REFERENCES[$('#mref', root).value].cm ?? Number($('#mcustom', root).value);
  function layout() {
    const r = stage.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    view = { s, ox: (r.width - img.naturalWidth * s) / 2, oy: (r.height - img.naturalHeight * s) / 2, dpr };
    draw();
  }
  const toScreen = p => ({ x: p.x * view.s + view.ox, y: p.y * view.s + view.oy });
  const toImg = (x, y) => ({ x: (x - view.ox) / view.s, y: (y - view.oy) / view.s });
  function draw() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, view.ox, view.oy, img.naturalWidth * view.s, img.naturalHeight * view.s);
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const a = toScreen(pts[i]), b = toScreen(pts[i + 1]);
      ctx.strokeStyle = colours[i]; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    pts.forEach((p, i) => {
      const a = toScreen(p);
      ctx.fillStyle = colours[i]; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(a.x, a.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    $('#mstep', root).textContent = labels[Math.min(pts.length, 6)];
    const cm = refCm();
    const L = pts.length >= 4 ? measureCm(pts[0], pts[1], cm, pts[2], pts[3]) : null;
    const W = pts.length >= 6 ? measureCm(pts[0], pts[1], cm, pts[4], pts[5]) : null;
    $('#mread', root).textContent = [L && `Length ${L} cm`, W && `Width ${W} cm`].filter(Boolean).join('   ·   ') ||
      'Keep the card flat on the same surface as the garment, and shoot from straight above.';
    $('#mdone', root).disabled = !L;
    root._result = { L, W };
  }
  stage.addEventListener('pointerdown', e => {
    const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    drag = pts.findIndex(p => { const s = toScreen(p); return Math.hypot(s.x - x, s.y - y) < 26; });
    if (drag < 0 && pts.length < 6) { pts.push(toImg(x, y)); drag = pts.length - 1; }
    stage.setPointerCapture(e.pointerId); draw();
  });
  stage.addEventListener('pointermove', e => {
    if (drag < 0) return;
    const r = stage.getBoundingClientRect(); pts[drag] = toImg(e.clientX - r.left, e.clientY - r.top); draw();
  });
  stage.addEventListener('pointerup', () => { drag = -1; });
  $('#mref', root).addEventListener('change', e => { $('#mcustom', root).hidden = Boolean(REFERENCES[e.target.value].cm); draw(); });
  $('#mcustom', root).addEventListener('input', draw);
  const close = () => { root.remove(); removeEventListener('resize', layout); };
  $('#mundo', root).onclick = () => { pts.pop(); draw(); };
  $('#mcancel', root).onclick = close;
  $('#mdone', root).onclick = () => {
    const { L, W } = root._result;
    if (L) S.draft.length_cm = L;
    if (W) S.draft.width_cm = W;
    close(); renderEditor();
    toast(`Measured ${L}${W ? ` × ${W}` : ''} cm`);
  };
  img.onload = layout;
  addEventListener('resize', layout);
}

// ------------------------------------------------------------------ On you (3D turntable)
const DRAWN = ['top', 'outer', 'sport', 'bottom', 'shoes'];
const ESTIMATE_NAMES = { height_cm: 'height', chest_cm: 'chest', waist_cm: 'waist', hips_cm: 'hips', shoulder_cm: 'shoulders', inseam_cm: 'inseam', sleeve_cm: 'sleeve' };
const mirrors = new Map();
// A piece without a back photo shows its front, mirrored, from behind.
async function mirroredUrl(path) {
  if (mirrors.has(path)) return mirrors.get(path);
  const bmp = await createImageBitmap(await S.store.getBlob(path));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d'); g.translate(c.width, 0); g.scale(-1, 1); g.drawImage(bmp, 0, 0);
  const url = URL.createObjectURL(await new Promise(r => c.toBlob(r, 'image/webp', 0.88)));
  mirrors.set(path, url);
  return url;
}
async function onYouLayers(pieces) {
  const body = bodyModel(S.profile);
  const layers = []; let missing = 0;
  for (const it of pieces) {
    if (!it || !DRAWN.includes(slotOf(it))) continue;
    if (!it.fit_path) { missing++; continue; }
    try {
      const get = p => S.store.getBlob(p);
      const m = await measure(it.fit_path, get), place = placeGarment(it, m, body);
      if (!place) continue;
      const L = { item: it, place, m, front: S.urls[it.fit_path], frontPath: it.fit_path, backPath: it.back_fit_path || null };
      if (place.slot === 'shoes') L.colour = swatches[swatchKey(it)] || await sampleColour(await get(swatchKey(it)), !!it.cut_path).catch(() => null);
      if (it.back_fit_path) { L.back = S.urls[it.back_fit_path]; L.backM = await measure(it.back_fit_path, get); L.backPlace = placeGarment(it, L.backM, body) || place; }
      else { L.back = await mirroredUrl(it.fit_path); L.backPlace = place; L.shadeBack = true; }
      if (L.front) layers.push(L);
    } catch (e) { console.warn('On you: skipped', it.no, e); missing++; }
  }
  return { body, layers, missing };
}
function onYouNotes(body, missing) {
  const est = body.estimated.map(k => ESTIMATE_NAMES[k]).filter(Boolean);
  return [
    est.length ? `<p class="note">Your ${est.length > 3 ? est.slice(0, 3).join(', ') + ' and more' : est.join(', ')} ${est.length === 1 ? 'is' : 'are'} estimated from your height and weight. <button class="link" data-action="go" data-view="fitting">Add measurements</button> for a true fit.</p>` : '',
    missing ? `<p class="note">${plural(missing, 'piece')} ${missing === 1 ? 'needs' : 'need'} a quick photo prep before ${missing === 1 ? 'it shows' : 'they show'} here. <button class="link" data-action="clean-all">Prepare now</button></p>` : '',
  ].join('');
}
const sideToggle = () => `<div class="seg sidetoggle" role="group" aria-label="Turn">
  <button type="button" data-action="spin" data-to="front" aria-pressed="true">Front</button>
  <button type="button" data-action="spin" data-to="back" aria-pressed="false">Back</button></div>`;

let lookFill = 0;
// Real 3D where the device supports it; the CSS turntable otherwise (or if 3D fails to start).
const use3D = webglAvailable();
let pieceKeyShown = null;
async function showStage(wrap, body, layers, opts) {
  if (use3D) {
    try { await renderStage3D(wrap, body, layers, { ...opts, getBlob: p => S.store.getBlob(p) }); wrap.dataset.mode = '3d'; return; }
    catch (e) { console.warn('3D unavailable, using the 2D turntable', e); }
  }
  wrap.dataset.mode = '2d';
  renderStage(wrap, body, layers, opts);
}

async function fillLookOnYou() {
  const ticket = ++lookFill;
  const wrap = $('#look-onyou .stagewrap'); if (!wrap) return;
  const slotNames = { top: 'Top', outer: 'Outerwear', bottom: 'Bottom', shoes: 'Shoes', sport: 'Training' };
  const { body, layers, missing } = await onYouLayers(Object.values(S.today.outfit || {}));
  if (ticket !== lookFill || !wrap.isConnected) return;
  await showStage(wrap, body, layers, { key: 'look', maxH: innerWidth < 900 ? 0.62 : 0.74 });
  if (ticket !== lookFill) return;
  $('#look-hints').innerHTML = layers.filter(L => L.place.slot !== 'shoes').map(L => {
    const h = fitHints(L.item, L.place, body, S.profile);
    return `<div class="hint"><span class="label">${slotNames[L.place.slot] || ''}</span><b>${esc(L.item.name || catLabel(L.item.category))}</b>${h.map(x => `<span>${esc(x)}</span>`).join('')}</div>`;
  }).join('') || '<p class="muted">Pick a look to see it on you.</p>';
  $('#look-notes').innerHTML = onYouNotes(body, missing);
}

let pieceFill = 0;
async function fillPieceOnYou() {
  const ticket = ++pieceFill;
  const wrap = $('#piece-onyou .stagewrap'); if (!wrap || !S.draft) return;
  const it = { ...(byId(S.draft.id) || {}), ...S.draft };
  const { body, layers, missing } = await onYouLayers([it]);
  if (ticket !== pieceFill || !wrap.isConnected) return;
  if (!layers.length) { $('#piece-onyou').innerHTML = `<span class="label">On you</span>${onYouNotes(body, missing) || ''}`; return; }
  const reset = pieceKeyShown !== it.id; pieceKeyShown = it.id;
  await showStage(wrap, body, layers, { maxH: 0.6, key: use3D ? 'piece' : 'piece:' + it.id, reset });
  if (ticket !== pieceFill) return;
  $('#piece-hints').innerHTML = fitHints(it, layers[0].place, body, S.profile).map(x => `<span>${esc(x)}</span>`).join('');
  $('#piece-notes').innerHTML = onYouNotes(body, 0);
}

// ------------------------------------------------------------------ look (today)
function shuffle() {
  S.today.outfit = suggestOutfit(S.items, { tempC: S.today.feels ?? S.today.tempC, style: S.today.style, today: todayStr() }, Math.random, S.today.locked);
  S.today.fresh = true;
}

function lookView() {
  const t = S.today, temp = t.feels ?? t.tempC, o = t.outfit || {};
  const slotNames = { top: 'Top', outer: 'Outerwear', bottom: 'Bottom', shoes: 'Shoes', sport: 'Training' };
  const recent = S.wears.slice().sort((a, b) => (b.worn_on || '').localeCompare(a.worn_on || '')).slice(0, 6);
  const wearable = S.items.filter(i => i.fate !== 'toss' && !i.away).length;
  const lookNo = S.wears.length + 1;
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return `
    <section class="lookhead ${S.lookMode === 'body' ? 'compact' : ''}">
      <span class="label">${esc(date)}</span>
      <h2 class="display hero-title">Look ${lookNo}</h2>
      <div class="weather">
        <span class="temp">${temp != null ? Math.round(temp) + '°' : '—'}</span>
        <span class="muted">${esc(t.place ? `${t.place}${t.hi != null ? `, high ${Math.round(t.hi)}°, low ${Math.round(t.lo)}°` : ''}. ` : '')}${esc(outfitTip(temp)) || 'Add today’s temperature for a look that suits the weather.'}</span>
      </div>
    </section>
    <div class="controls">
      <div class="row">
        <button class="textbtn" data-action="locate">Use my location</button>
        <input type="number" id="manual-temp" inputmode="decimal" placeholder="Or type °C" data-bind="today.manual" aria-label="Temperature in Celsius">
      </div>
      <div class="row">${['', ...STYLES].map(s => `<button class="textbtn" data-action="style" data-style="${s}" aria-pressed="${t.style === s}">${s || 'Any style'}</button>`).join('')}</div>
    </div>
    ${wearable < 3 ? '<p class="muted">Add a few tops, bottoms and shoes to the archive and looks will appear here.</p>' : ''}
    <div class="seg viewmode" role="group" aria-label="View">
      <button type="button" data-action="look-mode" data-mode="flat" aria-pressed="${S.lookMode !== 'body'}">Flat-lay</button>
      <button type="button" data-action="look-mode" data-mode="body" aria-pressed="${S.lookMode === 'body'}">On you</button>
    </div>
    ${S.lookMode === 'body' ? `<div class="onyou" id="look-onyou">
      <div class="stagewrap"><div class="stage-loading"></div></div>
      <div class="onyou-side">${sideToggle()}<div class="hints" id="look-hints"></div><div id="look-notes"></div>
        <p class="hint-drag">Drag the figure to turn it.</p></div>
    </div>` : boardHtml(o, t.fresh)}
    <div class="lookpieces">
      ${Object.entries(o).map(([slot, it]) => `
        <div class="lp">
          <span class="label">${slotNames[slot]}</span>
          <button class="lp-name" ${it ? `data-action="open" data-id="${it.id}"` : 'disabled'}>${it ? `${esc(it.name || catLabel(it.category))} <span class="muted">No. ${pad(it.no)}</span>` : 'Nothing suitable'}</button>
          <span class="lp-act">
            <button class="textbtn" data-action="lock" data-slot="${slot}" aria-pressed="${!!t.locked[slot]}" ${it ? '' : 'disabled'}>${t.locked[slot] ? 'Kept' : 'Keep'}</button>
            <button class="textbtn" data-action="swap" data-slot="${slot}">Swap</button>
          </span>
        </div>`).join('')}
    </div>
    <div class="lookactions">
      <button class="btn" data-action="shuffle">New look</button>
      <button class="btn solid" data-action="wear-outfit">Wear this look</button>
      <button class="btn quiet span2" data-action="save-look">Save as image</button>
    </div>
    ${recent.length ? `<h2 class="section">Recently worn</h2><div class="history">${recent.map(w => `
      <div class="h"><span class="muted">${esc(w.worn_on)}</span>
      <span>${w.item_ids.map(byId).filter(Boolean).map(i => esc(i.name || catLabel(i.category))).join(', ')}</span></div>`).join('')}</div>` : ''}`;
}

// Flat-lay board: pieces laid out like an editorial spread on the studio colour.
function boardLayout(o) {
  const has = k => o[k];
  const top = has('top') ? 'top' : has('sport') ? 'sport' : null;
  if (has('outer')) return { cls: 'with-outer', areas: { outer: 'outer', [top]: 'top', bottom: 'bottom', shoes: 'shoes' } };
  return { cls: 'no-outer', areas: { [top]: 'top', bottom: 'bottom', shoes: 'shoes' } };
}
function boardHtml(o, fresh) {
  const { cls, areas } = boardLayout(o);
  const cells = Object.entries(areas).filter(([slot]) => slot && slot !== 'null' && o[slot]);
  if (!cells.length) return '<div class="board empty"><span class="label">Your look appears here</span></div>';
  return `<div class="board ${cls} ${fresh ? 'enter' : ''}">${cells.map(([slot, area], i) => {
    const it = o[slot], src = full(it);
    return `<button class="cell" style="grid-area:${area};--i:${i}" data-action="open" data-id="${it.id}" aria-label="${esc(it.name || catLabel(it.category))}">
      ${src ? `<img class="fade" src="${esc(src)}" alt="">` : ''}</button>`;
  }).join('')}</div>`;
}

// Save the look as a portrait image (4:5), ready to share or post.
async function saveLookImage() {
  const o = S.today.outfit || {};
  const { areas } = boardLayout(o);
  const cells = Object.entries(areas).filter(([slot]) => slot && slot !== 'null' && o[slot]);
  if (!cells.length) return toast('No look to save yet');
  toast('Making the image');
  await document.fonts?.ready;
  const W = 1080, H = 1350, M = 64, top = 150, foot = 170;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#EEEEEC'; g.fillRect(0, 0, W, H);
  const cw = (W - M * 2) / 2, ch = (H - top - foot) / 2;
  const withOuter = !!o.outer;
  const rect = {
    outer: [M, top, cw, ch], top: withOuter ? [M + cw, top, cw, ch] : [M, top, cw, ch * 2],
    bottom: withOuter ? [M, top + ch, cw, ch] : [M + cw, top, cw, ch * 1.35], shoes: withOuter ? [M + cw, top + ch, cw, ch] : [M + cw, top + ch * 1.35, cw, ch * 0.65],
  };
  for (const [slot, area] of cells) {
    const it = o[slot], path = it.cut_path || it.photo_path || it.thumb_path;
    if (!path) continue;
    try {
      const bmp = await createImageBitmap(await S.store.getBlob(path));
      const [x, y, w, h] = rect[area], pad = 18;
      const sc = Math.min((w - pad * 2) / bmp.width, (h - pad * 2) / bmp.height);
      g.drawImage(bmp, x + (w - bmp.width * sc) / 2, y + (h - bmp.height * sc) / 2, bmp.width * sc, bmp.height * sc);
    } catch (e) { console.warn(e); }
  }
  const house = (settings().house || 'Capsule').toUpperCase();
  g.fillStyle = '#000'; g.textAlign = 'center';
  g.font = '600 30px "Inter Tight", Arial, sans-serif';
  g.letterSpacing = '10px';
  g.fillText(house, W / 2, 92);
  g.letterSpacing = '0px';
  const lookNo = S.wears.length + 1, temp = S.today.feels ?? S.today.tempC;
  g.font = '500 64px "Bodoni Moda", Didot, Georgia, serif';
  g.fillText(`Look ${lookNo}`, W / 2, H - 92);
  g.font = '500 20px "Inter Tight", Arial, sans-serif';
  g.letterSpacing = '4px'; g.fillStyle = '#6E6E6E';
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }).toUpperCase();
  g.fillText([date, temp != null ? Math.round(temp) + '°C' : ''].filter(Boolean).join('   ·   '), W / 2, H - 46);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  const file = new File([blob], `look-${lookNo}.jpg`, { type: 'image/jpeg' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  download(blob, file.name);
  toast('Look saved');
}

async function locate() {
  const fetchWeather = async (lat, lon, place) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
    const r = await (await fetch(url)).json();
    Object.assign(S.today, { tempC: r.current.temperature_2m, feels: r.current.apparent_temperature,
      hi: r.daily.temperature_2m_max[0], lo: r.daily.temperature_2m_min[0], place, outfit: null, locked: {} });
    S.profile.weather = { lat, lon };
    guard(() => S.store.saveProfile(S.profile));
    render();
  };
  if (!navigator.geolocation) return toast('Location unavailable. Type a temperature instead');
  toast('Checking the weather');
  navigator.geolocation.getCurrentPosition(
    p => guard(() => fetchWeather(p.coords.latitude.toFixed(3), p.coords.longitude.toFixed(3), 'Feels like, here'), 'Weather failed'),
    () => {
      const w = S.profile.weather;
      if (w) guard(() => fetchWeather(w.lat, w.lon, 'Feels like, last location'), 'Weather failed');
      else toast('Location is off. Type a temperature instead');
    }, { timeout: 8000, maximumAge: 30 * 60 * 1000 });
}

async function wearItems(ids) {
  const day = todayStr();
  await guard(async () => {
    const w = await S.store.addWear({ worn_on: day, item_ids: ids });
    S.wears.push(w);
    const rows = ids.map(byId).filter(Boolean).map(it =>
      ({ ...it, wear_count: (it.wear_count || 0) + (it.last_worn === day ? 0 : 1), last_worn: day }));
    await S.store.updateMany(rows);
    rows.forEach(r => { S.items[S.items.findIndex(i => i.id === r.id)] = r; });
    toast(ids.length === 1 ? `Logged No. ${pad(rows[0].no)}` : 'Look logged');
  });
}

// ------------------------------------------------------------------ travel (pack)
function packStats() {
  const st = settings();
  const sum = f => S.items.filter(i => (i.fate || 'undecided') === f && !(f === 'ship' && i.away)).reduce((a, i) => a + itemWeight(i).grams, 0);
  const count = f => S.items.filter(i => (i.fate || 'undecided') === f).length;
  const shipG = sum('ship');
  return {
    st, carryG: sum('carry'), shipG, counts: Object.fromEntries(Object.keys(FATES).map(f => [f, count(f)])),
    plans: Object.fromEntries(['surface', 'sal', 'air'].map(m => [m, shipPlan(shipG, st.boxTareKg, m)])),
    estimated: S.items.filter(i => ['ship', 'carry'].includes(i.fate) && itemWeight(i).estimated).length,
  };
}

function travelView() {
  const p = packStats(), st = p.st;
  const limitG = st.carryLimitKg * 1000;
  const carry = S.items.filter(i => i.fate === 'carry').sort((a, b) => itemWeight(b).grams - itemWeight(a).grams);
  const over = p.carryG > limitG;
  const scaleG = Math.max(limitG, p.carryG);
  const daysLeft = Math.ceil((new Date(st.departure + 'T08:00:00+09:00') - new Date()) / 86400000);
  const depDate = new Date(st.departure + 'T12:00:00');
  const departure = isNaN(depDate) ? st.departure : depDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  const tab = S.pack.tab;
  const list = S.items.filter(i => (i.fate || 'undecided') === tab).sort((a, b) => a.no - b.no);
  return `
    <section class="travelhead">
      <span class="label">Departure, ${esc(departure)}</span>
      <h2 class="display hero-title">${isNaN(daysLeft) ? 'Set a date' : daysLeft > 0 ? plural(daysLeft, 'day') : 'Departed'}</h2>
    </section>
    <div class="bag">
      <div class="row spread"><span class="label">Your bags</span>
        <span class="small ${over ? '' : 'muted'}" style="${over ? 'color:var(--toss)' : ''}">${kg(p.carryG)} of ${st.carryLimitKg} kg${over ? `, ${kg(p.carryG - limitG)} kg over` : ''}</span></div>
      <div class="bar ${over ? 'over' : ''}" role="img" aria-label="${kg(p.carryG)} of ${st.carryLimitKg} kilograms packed">
        ${carry.map((it, i) => `<span class="seg-item" style="--i:${i};width:${itemWeight(it).grams / scaleG * 100}%" title="No. ${pad(it.no)} ${esc(it.name || '')}, ${itemWeight(it).grams} g"></span>`).join('')}
      </div>
      <div class="scale"><span>0</span><span>${Math.round(scaleG / 2000)} kg</span><span>${Math.round(scaleG / 1000)} kg</span></div>
    </div>
    <div class="stats">
      ${['carry', 'undecided', 'toss', 'ship'].map(f => `<div class="stat"><span class="label">${f === 'undecided' ? 'Still to sort' : FATE_NAMES[f]}</span><span class="n">${p.counts[f]}</span></div>`).join('')}
    </div>
    ${p.estimated ? `<p class="note" style="margin-top:16px">${plural(p.estimated, 'packed piece')} ${p.estimated === 1 ? 'uses' : 'use'} a typical weight. A kitchen scale makes the bag total exact.</p>` : ''}
    ${p.shipG ? `<div class="costs">
      ${['surface', 'sal', 'air'].map(m => `<div class="fact"><span>Ship by ${MODE_LABELS[m].toLowerCase()}</span><span>${yen(p.plans[m].total)}</span></div>`).join('')}
    </div>` : ''}
    <h2 class="section">Sort the archive</h2>
    <div class="tabs">
      ${Object.keys(FATES).map(f => `<button class="textbtn" data-action="pack-tab" data-tab="${f}" aria-pressed="${f === tab}">${FATE_NAMES[f]} ${p.counts[f]}</button>`).join('')}
    </div>
    ${tab === 'undecided' ? sorterHtml(list) : pileHtml(list, tab)}`;
}

function sorterHtml(list) {
  if (!S.items.length) return '<p class="muted">Add pieces to the archive first.</p>';
  if (!list.length) return '<p class="muted">Every piece has a place. Check the other piles.</p>';
  const it = list[0];
  const w = itemWeight(it), fit = fitEstimate(it, S.profile), sims = similarTo(it, S.items);
  return `<div class="sorter" id="sorter">
    <div class="frame contain arrive ${cutCls(it)}">${photo(it, 'full')}</div>
    <div style="display:grid;gap:22px;align-content:start">
      <div style="display:grid;gap:6px"><span class="label">No. ${pad(it.no)} · ${list.length - 1} more after this</span>
        <h3 class="display page-title">${esc(it.name || catLabel(it.category))}</h3></div>
      <div class="facts">
        <div class="fact"><span>Weight</span><span>${w.grams} g${w.estimated ? ', typical' : ''}</span></div>
        <div class="fact"><span>Worn</span><span>${plural(it.wear_count || 0, 'time')}</span></div>
        ${fit ? `<div class="fact"><span>Fit</span><span>${fit.verdict}</span></div>` : ''}
        <div class="fact"><span>You also own</span><span>${sims.length ? `${sims.length} similar` : 'Nothing similar'}</span></div>
        ${it.condition ? `<div class="fact"><span>Condition</span><span>${esc(it.condition)}</span></div>` : ''}
      </div>
      <div class="decide">
        <button class="btn solid" data-action="decide" data-id="${it.id}" data-fate="carry">Carry <span class="kbd">C</span></button>
        <button class="btn" data-action="decide" data-id="${it.id}" data-fate="ship">Ship <span class="kbd">S</span></button>
        <button class="btn toss" data-action="decide" data-id="${it.id}" data-fate="toss">Toss <span class="kbd">T</span></button>
      </div>
      <p class="swipehint">Or swipe the photo: right to carry, left to toss.</p>
      <button class="textbtn" data-action="open" data-id="${it.id}" style="justify-self:start">Edit details</button>
    </div></div>`;
}

function pileHtml(list, fate) {
  if (!list.length) return '<p class="muted">Nothing in this pile yet.</p>';
  const extra = fate === 'ship'
    ? '<button class="btn" data-action="mark-shipped" style="margin-bottom:20px">Mark pile as posted</button>'
    : fate === 'toss' ? '<button class="btn danger" data-action="delete-tossed" style="margin-bottom:20px">Remove tossed pieces</button>' : '';
  return extra + `<div class="pile">${list.map(it => {
    const w = itemWeight(it);
    return `<div class="li">
      <div class="frame ${cutCls(it)}">${photo(it)}</div>
      <button class="open" data-action="open" data-id="${it.id}">
        <div class="t">${esc(it.name || catLabel(it.category))}</div>
        <div class="small muted">No. ${pad(it.no)} · ${w.grams} g${w.estimated ? ', typical' : ''}${it.away ? ' · posted' : ''}</div></button>
      <select id="refate-${it.id}" data-action="refate" data-id="${it.id}" aria-label="Move No. ${it.no}">
        ${Object.keys(FATES).map(k => `<option value="${k}" ${k === fate ? 'selected' : ''}>${FATE_NAMES[k]}</option>`).join('')}
      </select></div>`;
  }).join('')}</div>`;
}

async function setFates(changes) {
  const rows = changes.map(({ id, fate }) => ({ ...byId(id), fate })).filter(r => r.id);
  return guard(async () => {
    await S.store.updateMany(rows);
    rows.forEach(r => { S.items[S.items.findIndex(i => i.id === r.id)] = r; });
    saveSnapshot();
    return true;
  });
}

let deciding = false;
async function decideNow(id, fate) {
  const it = byId(id); if (!it) return;
  await changeFates([{ id, fate }], `No. ${pad(it.no)} → ${FATE_NAMES[fate]}`);
}
async function decide(id, fate) {
  if (deciding) return;
  deciding = true;
  try {
    const el = $('#sorter');
    if (el && !reduced()) { el.classList.add('leave-' + fate); await new Promise(r => setTimeout(r, 300)); }
    const it = byId(id);
    await changeFates([{ id, fate }], `No. ${pad(it.no)} → ${FATE_NAMES[fate]}`);
  } finally { deciding = false; }
}

// ------------------------------------------------------------------ fitting (you)
function fittingView() {
  const p = S.profile, st = settings();
  const num = (k, label, hint = '') => `<label class="field"><span class="label">${label}</span>
    <input type="number" id="p-${k}" inputmode="decimal" step="0.1" data-profile="${k}" value="${esc(p[k])}">${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  return `<div class="fitting">
    <div class="pagehead"><div><span class="label">Your measurements</span><h2 class="display page-title">Fitting</h2></div></div>
    <section class="panel">
      <div class="specs">
        ${num('height_cm', 'Height, cm')}${num('weight_kg', 'Weight, kg')}
        ${num('chest_cm', 'Chest, cm', 'Around, under the arms')}${num('waist_cm', 'Waist, cm', 'Where your trousers sit')}
        ${num('hips_cm', 'Hips, cm')}${num('shoulder_cm', 'Shoulders, cm', 'Seam to seam')}
        ${num('sleeve_cm', 'Sleeve, cm', 'Shoulder to wrist')}${num('inseam_cm', 'Inseam, cm')}
        ${num('shoe_us', 'Shoe, US')}
        <label class="field"><span class="label">Usual top size</span><input type="text" id="p-usual_top" data-profile="usual_top" value="${esc(p.usual_top)}" placeholder="M"></label>
        <label class="field"><span class="label">Usual bottom size</span><input type="text" id="p-usual_bottom" data-profile="usual_bottom" value="${esc(p.usual_bottom)}" placeholder="32 × 32"></label>
        <label class="field full"><span class="label">Fit preferences</span><textarea id="p-notes" data-profile="notes" placeholder="Room through the chest and shoulders, tapered leg">${esc(p.notes)}</textarea></label>
      </div>
      <p class="hint">Every piece’s fit check updates as you type.</p>
    </section>

    <h2 class="section">Ask Claude</h2>
    <section class="panel">
      <p>Send the archive to Claude for looks or carry and toss calls. Paste the summary into a chat and attach the contact sheet so each piece can be seen by number.</p>
      <div class="row">
        <button class="btn solid" data-action="copy-summary">Copy summary</button>
        <button class="btn" data-action="contact-sheet" data-scope="all">Contact sheet</button>
        <button class="btn quiet" data-action="contact-sheet" data-scope="undecided">Unsorted only</button>
      </div>
      <label class="field"><span class="label">Paste Claude’s decisions</span><textarea id="decisions" placeholder="12 carry&#10;13 toss"></textarea></label>
      <div id="decision-preview"></div>
      <button class="btn" data-action="preview-decisions" style="justify-self:start">Check decisions</button>
    </section>

    <h2 class="section">Before you buy</h2>
    <section class="panel">
      <div class="specs">
        <label class="field"><span class="label">Type</span><select id="buy-cat">${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
        <label class="field"><span class="label">Colour</span><input type="text" id="buy-colour" placeholder="Black"></label>
      </div>
      <button class="btn" data-action="buy-check" style="justify-self:start">Check the archive</button>
      <div id="buy-result"></div>
    </section>

    <h2 class="section">Appearance</h2>
    <section class="panel">
      <div class="seg" role="group" aria-label="Appearance" style="max-width:420px">
        ${[['', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
          `<button type="button" data-action="theme-set" data-theme="${v}" aria-pressed="${(document.documentElement.dataset.theme || '') === v}">${l}</button>`).join('')}
      </div>
    </section>

    <h2 class="section">House</h2>
    <section class="panel">
      <div class="specs">
        <label class="field full"><span class="label">House name</span><input type="text" id="s-house" data-setting="house" data-kind="text" value="${esc(st.house)}"><span class="hint">Shown as the wordmark</span></label>
        <label class="field"><span class="label">Bag allowance, kg</span><input type="number" id="s-limit" step="0.5" data-setting="carryLimitKg" value="${st.carryLimitKg}"><span class="hint">Checked bag plus carry-on</span></label>
        <label class="field"><span class="label">Departure date</span><input type="text" id="s-dep" data-setting="departure" data-kind="text" value="${esc(st.departure)}" placeholder="2026-12-17"></label>
      </div>
      <p class="hint">${S.store.mode === 'local' ? 'Saved in this browser only. Download a backup now and then.' : 'Synced to your account.'}</p>
      <div class="row">
        <button class="btn" data-action="backup">Download backup</button>
        <button class="btn quiet" data-action="restore">Restore backup</button>
        ${needsCleanup().length ? `<button class="btn" data-action="clean-all">Prepare photos (${needsCleanup().length})</button>` : ''}
        ${S.store.mode === 'cloud' ? '<button class="btn danger" data-action="signout">Sign out</button>' : ''}
      </div>
    </section></div>`;
}

let profileTimer;
function saveProfileSoon() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => guard(() => S.store.saveProfile(S.profile)), 600);
}

async function copySummary() {
  const text = claudeSummary(S.items, S.profile, settings());
  try { await navigator.clipboard.writeText(text); toast('Summary copied'); }
  catch {
    sheet(`<div class="sheetbar"><span class="label">Copy this</span><button class="textbtn" data-action="close">Close</button></div>
      <div style="padding:20px var(--gutter)"><textarea id="summary-text" style="min-height:70dvh">${esc(text)}</textarea></div>`);
    $('#summary-text').select();
  }
}

async function contactSheets(scope) {
  const items = S.items.filter(i => scope === 'all' || (i.fate || 'undecided') === 'undecided').sort((a, b) => a.no - b.no);
  if (!items.length) return toast('No pieces for a sheet');
  toast('Making contact sheet');
  const cols = 5, rows = 6, cell = 300, labelH = 56, per = cols * rows;
  for (let page = 0; page * per < items.length; page++) {
    const chunk = items.slice(page * per, page * per + per);
    const c = document.createElement('canvas');
    c.width = cols * cell; c.height = Math.ceil(chunk.length / cols) * (cell + labelH);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < chunk.length; i++) {
      const it = chunk[i], x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + labelH);
      const path = it.thumb_path || it.photo_path;
      if (path) {
        try {
          const bmp = await createImageBitmap(await S.store.getBlob(path));
          const s = Math.min((cell - 12) / bmp.width, (cell - 12) / bmp.height);
          g.drawImage(bmp, x + (cell - bmp.width * s) / 2, y + (cell - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
        } catch (e) { console.warn(e); }
      }
      g.fillStyle = '#000'; g.font = '600 28px "Inter Tight", Arial, sans-serif'; g.fillText('#' + it.no, x + 8, y + cell + 30);
      g.font = '400 17px "Inter Tight", Arial, sans-serif'; g.fillStyle = '#6E6E6E';
      g.fillText(String(it.name || catLabel(it.category)).slice(0, 26), x + 8, y + cell + 50);
      g.strokeStyle = '#E4E4E2'; g.strokeRect(x + .5, y + .5, cell - 1, cell + labelH - 1);
    }
    download(await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85)), `archive-sheet-${scope}-${page + 1}.jpg`);
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function previewDecisions() {
  const parsed = parseDecisions($('#decisions').value);
  const changes = Object.entries(parsed).map(([no, fate]) => ({ it: S.items.find(i => i.no === Number(no)), fate, no }));
  const ok = changes.filter(c => c.it && (c.it.fate || 'undecided') !== c.fate);
  const missing = changes.filter(c => !c.it).map(c => 'No. ' + c.no);
  S.decisions = ok.map(c => ({ id: c.it.id, fate: c.fate }));
  $('#decision-preview').innerHTML = !changes.length ? '<p class="err">No decisions found. Use lines like “12 carry”.</p>' : `
    <div class="list">${ok.map(c => `<div class="li"><span>No. ${pad(c.it.no)} ${esc(c.it.name || catLabel(c.it.category))}</span>
      <span class="fate-tag ${c.fate}">${FATE_NAMES[c.it.fate || 'undecided']} → ${FATE_NAMES[c.fate]}</span></div>`).join('')}</div>
    ${missing.length ? `<p class="hint">Not in the archive: ${missing.join(', ')}</p>` : ''}
    ${ok.length ? `<button class="btn solid" data-action="apply-decisions" style="margin-top:12px">Apply ${plural(ok.length, 'change')}</button>` : '<p class="hint">Nothing would change.</p>'}`;
}

function buyCheck() {
  const cat = $('#buy-cat').value, colour = $('#buy-colour').value;
  const sims = similarTo({ id: '_', category: cat, colour }, S.items);
  const sameType = S.items.filter(i => i.category === cat && i.fate !== 'toss');
  const avg = sameType.length ? sameType.reduce((a, i) => a + (i.wear_count || 0), 0) / sameType.length : 0;
  const neverWorn = sameType.filter(i => !i.wear_count).length;
  const name = catLabel(cat).toLowerCase();
  let verdict;
  if (sims.length >= 2) verdict = `You already own ${sims.length} ${colourFamily(colour)} ${name}s. Probably skip it.`;
  else if (neverWorn >= 2) verdict = `${neverWorn} of your ${name}s have never been worn. Wear those first.`;
  else if (sims.length === 1) verdict = 'You own one like it. Buy only if it replaces that one.';
  else verdict = 'Nothing like it in the archive. It fills a gap.';
  $('#buy-result').innerHTML = `<p style="font-family:var(--display);font-size:24px;line-height:1.2">${esc(verdict)}</p>
    <p class="hint">${plural(sameType.length, name)} owned, worn ${avg.toFixed(1)} times on average.${sims.length ? ' Similar: ' + sims.map(s => 'No. ' + pad(s.no)).join(', ') : ''}</p>`;
}

async function backup() {
  toast('Building backup');
  await guard(async () => {
    const items = [];
    for (const it of S.items) {
      const row = { ...it };
      for (const k of Object.keys(PHOTO_KEYS)) {
        if (it[k]) { try { row[k + '_data'] = await blobToDataUrl(await S.store.getBlob(it[k])); } catch {} }
      }
      items.push(row);
    }
    const data = { app: 'closet', version: 1, exported_at: new Date().toISOString(), items, profile: S.profile, wears: S.wears };
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `archive-backup-${todayStr()}.json`);
  }, 'Backup failed');
}

async function restore(file) {
  await guard(async () => {
    const data = JSON.parse(await file.text());
    if (data.app !== 'closet') throw new Error('Not an archive backup file');
    if (!(await ask(`Add ${plural(data.items.length, 'piece')} from this backup to the archive?`, 'Restore'))) return;
    const idMap = {};
    let n = 0;
    for (const old of data.items) {
      toast(`Restoring ${++n} of ${data.items.length}`);
      const id = uuid(); idMap[old.id] = id;
      const row = { ...old, id };
      for (const [k, kind] of Object.entries(PHOTO_KEYS)) {
        row[k] = old[k + '_data']
          ? await S.store.uploadPhoto(S.store.photoPath(id, kind), await dataUrlToBlob(old[k + '_data']))
          : null;
        delete row[k + '_data'];
      }
      if (S.items.some(i => i.no === row.no)) row.no = nextNo();
      S.items.push(await S.store.saveItem(row));
    }
    if (data.profile && !Object.keys(S.profile).length) { S.profile = data.profile; await S.store.saveProfile(S.profile); }
    for (const w of data.wears || []) S.wears.push(await S.store.addWear({ worn_on: w.worn_on, item_ids: w.item_ids.map(i => idMap[i]).filter(Boolean) }));
    await refreshUrls(); render(); toast('Backup restored');
  }, 'Restore failed');
}

// ------------------------------------------------------------------ background cleanup for existing pieces
const isOldCut = p => /\.png$/.test(p || '');
const needsFront = i => i.photo_path && (!i.cut_path || !i.fit_path || isOldCut(i.cut_path));
const needsBack = i => i.back_path && (!i.back_cut_path || !i.back_fit_path || isOldCut(i.back_cut_path));
function needsCleanup() { return S.items.filter(i => needsFront(i) || needsBack(i)); }

let cleaning = false;
async function cleanAll() {
  if (cleaning) return;
  const todo = needsCleanup();
  if (!todo.length) return toast('Every photo is already cleaned up');
  cleaning = true;
  let n = 0, ok = 0;
  try {
    for (const it of todo) {
      n++;
      const row = { ...it }, label = 'No. ' + pad(it.no);
      toast(`Preparing photos, ${n} of ${todo.length}`);
      let changed = false;
      if (needsFront(it)) changed = await applyCutout(row, it.id, await S.store.getBlob(it.photo_path), 'front', label) || changed;
      if (needsBack(it)) changed = await applyCutout(row, it.id, await S.store.getBlob(it.back_path), 'back', label) || changed;
      if (changed) {
        await guard(async () => {
          await S.store.updateMany([row]);
          S.items[S.items.findIndex(i => i.id === row.id)] = row; ok++;
          await refreshUrls([row]);
          saveSnapshot();
          if ((S.view === 'archive' || S.view === 'look') && !$('#sheet-root').innerHTML) render(); // show each piece as it finishes
        });
      }
    }
    toast(`Prepared ${plural(ok, 'piece')}`);
    render();
  } finally { cleaning = false; }
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async e => {
  if (e.target.closest('#toast .undo')) {
    const f = undoFn; undoFn = null; clearTimeout(toastTimer);
    $('#toast').classList.remove('show', 'actionable');
    if (f) await f();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'scrim') { if (e.target === el) closeSheet(); return; }
  switch (a) {
    case 'go': go(el.dataset.view); break;
    case 'filters': {
      const f = S.filter;
      const opt = (key, v, l) => `<button class="opt" data-action="pick-filter" data-key="${key}" data-val="${v}" aria-pressed="${f[key] === v}">${l}</button>`;
      sheet(`<div class="grabber" aria-hidden="true"></div>
        <div class="sheetbar"><span class="label">Sort &amp; filter</span><button class="textbtn" data-action="close">Done</button></div>
        <div class="optgroup"><span class="label">Fate</span>${opt('fate', '', 'Any fate')}${Object.keys(FATES).map(k => opt('fate', k, FATE_NAMES[k])).join('')}</div>
        <div class="optgroup"><span class="label">Sort</span>${[['no', 'Archive order'], ['newest', 'Newest'], ['least', 'Least worn'], ['most', 'Most worn']].map(([k, l]) => opt('sort', k, l)).join('')}</div>`, 'bottom');
      break;
    }
    case 'pick-filter': S.filter[el.dataset.key] = el.dataset.val; closeSheet(); transition(render); break;
    case 'more-tools': el.closest('.mediabar')?.classList.toggle('open'); el.setAttribute('aria-expanded', el.closest('.mediabar')?.classList.contains('open')); break;
    case 'dismiss-tip': try { localStorage.setItem('installTip', 'done'); } catch {} el.closest('.installtip')?.remove(); break;
    case 'theme-set': {
      const r = document.documentElement, v = el.dataset.theme;
      if (v) r.dataset.theme = v; else delete r.dataset.theme;
      try { v ? localStorage.setItem('theme', v) : localStorage.removeItem('theme'); } catch {}
      transition(render); break;
    }
    case 'theme': {
      const r = document.documentElement;
      r.dataset.theme = themeLabel() === 'Light' ? 'light' : 'dark';
      try { localStorage.setItem('theme', r.dataset.theme); } catch {}
      transition(render); break;
    }
    case 'add': sheet(`<div class="sheetbar"><span class="label">Add pieces</span><button class="textbtn" data-action="close">Close</button></div>
        <div style="padding:40px var(--gutter);display:grid;gap:18px;max-width:560px">
          <h2 class="display page-title">New to the archive</h2>
          <p class="muted">Lay the piece flat with a credit card beside it and shoot from straight above. The card lets you measure it later.</p>
          <label class="check"><input type="checkbox" id="pairs" data-action="pairs" ${pairMode() ? 'checked' : ''}>My photos come in pairs: front, then back</label>
          <label class="check"><input type="checkbox" id="clean" data-action="clean" ${cleanMode() ? 'checked' : ''}>Remove backgrounds automatically</label>
          <p class="hint" style="margin-top:-10px">Shoot each piece front then back, then choose all the photos at once. They’re paired in the order they were taken.</p>
          <button class="btn solid block" data-action="pick">Choose photos</button>
          <button class="btn block" data-action="camera">Take a photo</button></div>`); break;
    case 'camera': closeSheet(false); $('#camera').click(); break;
    case 'pick': closeSheet(false); $('#pick').click(); break;
    case 'slot': S.filter.slot = el.dataset.slot; transition(render); break;
    case 'open': {
      S.navIds = (S.view === 'archive' ? filtered() : S.view === 'travel'
        ? S.items.filter(i => (i.fate || 'undecided') === S.pack.tab).sort((a, b) => a.no - b.no)
        : S.items.slice().sort((a, b) => a.no - b.no)).map(i => i.id);
      const it = byId(el.dataset.id);
      if (it) { await refreshUrls([it]); openEditor(it, null, null, el.classList.contains('piece') ? el : null); }
      break;
    }
    case 'close':
      if (isDirty() && S.draft && !S.draft._new) await saveDraft(true); // closing keeps your edits
      else closeSheet();
      break;
    case 'nav': navigate(Number(el.dataset.dir)); break;
    case 'toggle-chip': {
      const list = S.draft[el.dataset.key], v = el.dataset.val;
      const i = list.indexOf(v); i >= 0 ? list.splice(i, 1) : list.push(v);
      el.setAttribute('aria-pressed', i < 0); break;
    }
    case 'set-fate': S.draft.fate = el.dataset.fate;
      el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === el)); refreshEditorBits(); break;
    case 'measure': openMeasure(); break;
    case 'replace-photo': {
      const side = el.dataset.side;
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        if (!inp.files[0]) return;
        const blobs = await compressPhoto(inp.files[0]);
        if (side === 'back') {
          S.draftBack = blobs; if (S.draftBackUrl) URL.revokeObjectURL(S.draftBackUrl);
          S.draftBackUrl = URL.createObjectURL(blobs.full);
        } else {
          S.draftBlobs = blobs; if (S.draftUrl) URL.revokeObjectURL(S.draftUrl);
          S.draftUrl = URL.createObjectURL(blobs.full);
        }
        renderEditor();
      };
      inp.click(); break;
    }
    case 'side': {
      if (S.side === el.dataset.side) break;
      S.side = el.dataset.side; S.flipping = !reduced();
      const y = $('.sheet').scrollTop; renderEditor(); $('.sheet').scrollTop = y; S.flipping = false; break;
    }
    case 'clean': { try { localStorage.setItem('clean', el.checked ? '1' : '0'); } catch {} if (el.checked) preloadCutouts(); break; }
    case 'toggle-original': { S.showOriginal = !S.showOriginal; const y = $('.sheet').scrollTop; renderEditor(); $('.sheet').scrollTop = y; break; }
    case 'clean-all': await cleanAll(); break;
    case 'redo-cut': {
      const d = S.draft, back = S.side === 'back';
      const it = byId(d.id); if (!it) break;
      el.disabled = true; el.textContent = 'Working…';
      toast(back ? 'Redoing the back cutout' : 'Redoing the cutout');
      const row = { ...it };
      if (await applyCutout(row, it.id, await S.store.getBlob(back ? it.back_path : it.photo_path), back ? 'back' : 'front', 'No. ' + pad(it.no))) {
        await guard(async () => {
          await S.store.updateMany([row]);
          S.items[S.items.findIndex(i => i.id === row.id)] = row;
          for (const k of ['cut_path', 'fit_path', 'back_cut_path', 'back_fit_path']) S.draft[k] = row[k];
          await refreshUrls([row]);
          saveSnapshot();
        });
        toast('Cutout redone');
      }
      S.showOriginal = false;
      if (S.draft) { const y = $('.sheet').scrollTop; renderEditor(); $('.sheet').scrollTop = y; }
      break;
    }
    case 'pairs': {
      try { localStorage.setItem('pairs', el.checked ? '1' : '0'); } catch {}
      break;
    }
    case 'save': await saveDraft(); break;
    case 'delete': {
      const it = byId(S.draft.id) || S.draft;
      closeSheet();
      deleteLater([it], `Deleted No. ${pad(it.no)}`);
      break;
    }
    case 'wear-one': await wearItems([S.draft.id]); S.draft = { ...byId(S.draft.id), styles: S.draft.styles, seasons: S.draft.seasons }; renderEditor(); break;
    case 'locate': locate(); break;
    case 'style': S.today.style = el.dataset.style; S.today.locked = {}; shuffle(); render(); break;
    case 'shuffle': shuffle(); render(); break;
    case 'save-look': saveLookImage(); break;
    case 'look-mode': S.lookMode = el.dataset.mode; try { localStorage.setItem('lookMode', S.lookMode); } catch {} transition(render); break;
    case 'spin': {
      const box = el.closest('.onyou'), wrap = box?.querySelector('.stagewrap');
      if (wrap?.dataset.mode === '3d') spinTo3D(box.id === 'look-onyou' ? 'look' : 'piece', el.dataset.to);
      else { const st = box?.querySelector('.stage3d'); if (st) spinTo(st, el.dataset.to); }
      break;
    }
    case 'lock': { const slot = el.dataset.slot; S.today.locked[slot] ? delete S.today.locked[slot] : (S.today.locked[slot] = S.today.outfit[slot]); render(); break; }
    case 'swap': {
      const slot = el.dataset.slot, cur = S.today.outfit[slot];
      delete S.today.locked[slot];
      const next = suggestOutfit(S.items.filter(i => i.id !== cur?.id), { tempC: S.today.feels ?? S.today.tempC, style: S.today.style, today: todayStr() }, Math.random,
        Object.fromEntries(Object.entries(S.today.outfit).filter(([k, v]) => k !== slot && v)));
      S.today.outfit[slot] = next[slot] || cur;
      transition(render); break;
    }
    case 'wear-outfit': {
      const ids = Object.values(S.today.outfit || {}).filter(Boolean).map(i => i.id);
      if (!ids.length) return toast('No look to log yet');
      await wearItems(ids); render(); break;
    }
    case 'pack-tab': S.pack.tab = el.dataset.tab; transition(render); break;
    case 'decide': await decide(el.dataset.id, el.dataset.fate); break;
    case 'mark-shipped': {
      const pile = S.items.filter(i => i.fate === 'ship' && !i.away);
      if (!pile.length) return toast('Already marked as posted');
      if (!(await ask(`Mark ${plural(pile.length, 'piece')} as posted? They’ll leave your daily looks.`, 'Mark as posted'))) return;
      const ok = await guard(async () => { const rows = pile.map(i => ({ ...i, away: true })); await S.store.updateMany(rows); rows.forEach(r => { S.items[S.items.findIndex(i => i.id === r.id)] = r; }); return true; });
      render(); if (ok) toast('Marked as posted'); break;
    }
    case 'delete-tossed': {
      const pile = S.items.filter(i => i.fate === 'toss');
      if (!pile.length) break;
      deleteLater(pile, `Removed ${plural(pile.length, 'tossed piece')}`); break;
    }
    case 'copy-summary': copySummary(); break;
    case 'contact-sheet': contactSheets(el.dataset.scope); break;
    case 'preview-decisions': previewDecisions(); break;
    case 'apply-decisions': { const ch = S.decisions || []; S.decisions = null; await changeFates(ch, `Applied ${plural(ch.length, 'decision')}`); break; }
    case 'buy-check': buyCheck(); break;
    case 'backup': backup(); break;
    case 'restore': $('#importfile').click(); break;
    case 'signout': await S.store.signOut(); S.needSignIn = true; render(); break;
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'pick' || t.id === 'camera') { await addFiles(t.files); t.value = ''; return; }
  if (t.id === 'importfile') { if (t.files[0]) await restore(t.files[0]); t.value = ''; return; }
  if (t.dataset.action === 'refate') { const it = byId(t.dataset.id); await changeFates([{ id: t.dataset.id, fate: t.value }], `No. ${pad(it.no)} moved to ${FATE_NAMES[t.value]}`); return; }
  if (t.dataset.bind === 'filter.fate' || t.dataset.bind === 'filter.sort') { S.filter[t.dataset.bind.slice(7)] = t.value; transition(render); return; }
  if (t.dataset.bind === 'today.manual') {
    const v = parseFloat(t.value);
    if (!isNaN(v)) { Object.assign(S.today, { tempC: v, feels: v, hi: null, lo: null, place: 'You typed', locked: {} }); shuffle(); render(); }
    return;
  }
  if (t.dataset.setting === 'house') { render(); return; }
  if (t.dataset.draft) {
    const k = t.dataset.draft;
    S.draft[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'category') { const y = $('.sheet').scrollTop; renderEditor(); $('.sheet').scrollTop = y; }
    else { refreshEditorBits(); if (k === 'length_cm' || k === 'width_cm') fillPieceOnYou(); }
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.bind === 'filter.q') {
    S.filter.q = t.value;
    const pos = t.selectionStart; render();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
  if (t.dataset.profile) { S.profile[t.dataset.profile] = t.value; saveProfileSoon(); }
  if (t.dataset.setting) {
    const v = t.dataset.kind === 'text' ? t.value : parseFloat(t.value);
    if (t.dataset.kind === 'text' || !isNaN(v)) { S.profile.settings = { ...settings(), [t.dataset.setting]: v }; saveProfileSoon(); }
  }
  if (t.dataset.draft && t.type !== 'checkbox') { S.draft[t.dataset.draft] = t.value; refreshEditorBits(); }
});

document.addEventListener('submit', async e => {
  if (e.target.dataset.form !== 'signin') return;
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await S.store.signIn(f.get('email'), f.get('password'));
    S.needSignIn = false; await loadAll(); render();
  } catch (err) { $('#signin-err').textContent = err.message === 'Invalid login credentials' ? 'Email or password is wrong.' : err.message; }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#sheet-root').innerHTML) { closeSheet(); return; }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.draft && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    e.preventDefault(); navigate(e.key === 'ArrowRight' ? 1 : -1); return;
  }
  // Sorting shortcuts on a laptop: C carry, S ship, T toss.
  if (S.view !== 'travel' || S.pack.tab !== 'undecided' || $('#sheet-root').innerHTML) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  const fate = { c: 'carry', s: 'ship', t: 'toss' }[e.key.toLowerCase()];
  const btn = fate && document.querySelector(`[data-action="decide"][data-fate="${fate}"]`);
  if (btn) { e.preventDefault(); decide(btn.dataset.id, fate); }
});

// ------------------------------------------------------------------ gestures
// Sorter: drag the card right to carry, left to toss. Piece page: swipe the photo for next / previous.
let drag = null;
document.addEventListener('pointerdown', e => {
  if (e.button > 0) return;
  const handle = e.target.closest('.grabber, .sheetbar');
  if (handle && !e.target.closest('button')) {
    const sh = handle.closest('.sheet');
    if (sh && sh.scrollTop <= 0) { drag = { el: sh, kind: 'sheet', x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, active: false, pid: e.pointerId }; }
    return;
  }
  const card = e.target.closest('#sorter .frame');
  const photoEl = !card && e.target.closest('.product .media .frame');
  if (!card && !photoEl) return;
  drag = { el: card || photoEl, kind: card ? 'sort' : 'page', x0: e.clientX, y0: e.clientY, dx: 0, active: false, pid: e.pointerId };
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (drag.kind === 'sheet') {
    if (!drag.active) { if (dy > 8 && dy > Math.abs(dx)) { drag.active = true; try { drag.el.setPointerCapture(e.pointerId); } catch {} drag.el.classList.add('dragging'); } else return; }
    drag.dy = Math.max(0, dy);
    drag.el.style.transform = `translateY(${drag.dy}px)`;
    return;
  }
  if (!drag.active) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      drag.active = true;
      try { drag.el.setPointerCapture(e.pointerId); } catch {}
      drag.el.classList.remove('arrive'); drag.el.classList.add('dragging');
    } else if (Math.abs(dy) > 12) { drag = null; return; } // a vertical swipe is a scroll
    else return;
  }
  drag.dx = dx;
  if (drag.kind === 'sort') {
    drag.el.style.transform = `translateX(${dx}px) rotate(${dx / 28}deg)`;
    drag.el.dataset.hint = dx > 70 ? 'carry' : dx < -70 ? 'toss' : '';
  } else {
    drag.el.style.transform = `translateX(${dx * 0.35}px)`;
  }
});
function endDrag(cancel) {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.active) return;
  d.el.classList.remove('dragging');
  if (d.kind === 'sheet') {
    if (!cancel && d.dy > 110) {
      d.el.style.transition = 'transform 220ms var(--ease)'; d.el.style.transform = 'translateY(100%)';
      setTimeout(async () => {
        if (isDirty() && S.draft && !S.draft._new) await saveDraft(true); else closeSheet(false);
      }, 200);
    } else {
      d.el.style.transition = 'transform 240ms var(--ease)'; d.el.style.transform = '';
      setTimeout(() => { d.el.style.transition = ''; }, 260);
    }
    return;
  }
  const go = !cancel && Math.abs(d.dx) > 90;
  if (d.kind === 'sort' && go) {
    const fate = d.dx > 0 ? 'carry' : 'toss';
    const id = $('#sorter [data-action="decide"]')?.dataset.id;
    d.el.style.transition = 'transform 260ms var(--ease), opacity 260ms var(--ease)';
    d.el.style.transform = `translateX(${d.dx > 0 ? 140 : -140}%) rotate(${d.dx > 0 ? 14 : -14}deg)`;
    d.el.style.opacity = '0';
    setTimeout(() => { if (id) { deciding = false; decideNow(id, fate); } }, 240);
    return;
  }
  d.el.style.transition = 'transform 260ms var(--ease)';
  d.el.style.transform = ''; d.el.dataset.hint = '';
  setTimeout(() => { d.el.style.transition = ''; }, 280);
  if (d.kind === 'page' && go) navigate(d.dx < 0 ? 1 : -1);
}
document.addEventListener('dragstart', e => { if (e.target.tagName === 'IMG') e.preventDefault(); }); // no ghost-image drags
document.addEventListener('pointerup', () => endDrag(false));
document.addEventListener('pointercancel', () => endDrag(true));
// Suppress the click that follows a drag, so a swipe never opens or toggles anything.
document.addEventListener('click', e => { if (e.target.closest('.dragging')) { e.stopPropagation(); e.preventDefault(); } }, true);

// ------------------------------------------------------------------ phone header: hide on scroll down
let lastY = 0;
addEventListener('scroll', () => {
  const y = scrollY;
  if (Math.abs(y - lastY) < 8) return;
  document.body.classList.toggle('hide-mast', y > lastY && y > 90);
  lastY = y;
}, { passive: true });

// ------------------------------------------------------------------ keep devices in sync
let lastSync = Date.now(), syncing = false;
const signature = () => JSON.stringify([S.items, S.wears.length, S.profile]);
async function syncNow(force = false) {
  if (syncing || S.needSignIn || S.loading || S.store.mode !== 'cloud') return;
  if (!force && !S.offline && Date.now() - lastSync < 15000) return;
  if ($('#sheet-root').innerHTML || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return; // never yank a screen you're editing
  syncing = true;
  try {
    const before = signature();
    await loadAll();
    lastSync = Date.now();
    if (signature() !== before) {
      if (S.today.outfit) for (const k of Object.keys(S.today.outfit)) S.today.outfit[k] = S.today.outfit[k] && byId(S.today.outfit[k].id) || null;
      const y = scrollY; render(); scrollTo(0, y);
    } else if (!S.offline && $('.offlinebar')) render();
  } catch (e) { console.warn('sync failed', e); } finally { syncing = false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncNow();
  else flushDeletes();
});
addEventListener('focus', () => syncNow());
addEventListener('online', () => syncNow(true));
addEventListener('pagehide', () => { flushDeletes(); });

// ------------------------------------------------------------------ boot
(async () => {
  try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
    navigator.serviceWorker?.register('sw.js').catch(e => console.warn('offline cache unavailable', e));
  }
  try {
    const { signedIn } = await S.store.init();
    if (!signedIn) { S.needSignIn = true; render(); return; }
    S.loading = true; render();
    try { await loadAll(); }
    catch (e) {
      if (!loadSnapshot()) throw e; // nothing saved yet: show the real error
      console.warn('database unreachable, showing saved archive', e);
    }
    S.loading = false; lastSync = Date.now();
    render();
  } catch (e) {
    if (loadSnapshot()) { S.loading = false; render(); return; } // the library or database couldn't load at all
    console.error(e);
    $('#app').innerHTML = `<section class="empty" style="padding:20vh var(--gutter)"><h2 class="display page-title">The archive didn’t open.</h2>
      <p class="muted">${esc(e.message)}. Check config.js and your connection, then reload.</p></section>`;
  }
})();

window.__closet = S;

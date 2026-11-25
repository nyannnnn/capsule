// Storage: Supabase when config.js has keys, otherwise this device only (IndexedDB).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=202611252019';

export const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const BUCKET = 'closet';
const SUFFIX = { full: '', thumb: '_t', back: '_b', backthumb: '_bt', cut: '_c', backcut: '_bc' };
export const PHOTO_FIELDS = ['photo_path', 'thumb_path', 'back_path', 'back_thumb_path', 'cut_path', 'back_cut_path'];
const ext = type => (type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg');
const ITEM_FIELDS = ['no', 'name', 'category', 'colour', 'brand', 'size', 'styles', 'seasons', 'fit',
  'condition', 'length_cm', 'width_cm', 'weight_g', 'fate', 'away', 'notes', 'photo_path', 'thumb_path', 'back_path', 'back_thumb_path', 'cut_path', 'back_cut_path',
  'wear_count', 'last_worn'];

function pick(item) {
  const o = {};
  for (const k of ITEM_FIELDS) if (k in item) o[k] = item[k] === '' ? null : item[k];
  return o;
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

// ---------------------------------------------------------------- local
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wardrobe', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('items', { keyPath: 'id' });
      db.createObjectStore('blobs');
      db.createObjectStore('kv');
      db.createObjectStore('wears', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

class LocalStore {
  constructor() { this.urls = new Map(); this.mode = 'local'; }
  async init() { this.db = await idb(); return { signedIn: true }; }
  async signIn() {} async signOut() {}
  async listItems() { return (await tx(this.db, 'items', 'readonly', s => s.getAll())) || []; }
  async saveItem(item) {
    const row = { id: item.id || uuid(), created_at: item.created_at || new Date().toISOString(), ...pick(item) };
    await tx(this.db, 'items', 'readwrite', s => s.put(row));
    return row;
  }
  async updateMany(rows) {
    await tx(this.db, 'items', 'readwrite', s => { for (const r of rows) s.put(r); });
  }
  async deleteItem(item) {
    await tx(this.db, 'items', 'readwrite', s => s.delete(item.id));
    await tx(this.db, 'blobs', 'readwrite', s => { for (const k of PHOTO_FIELDS) if (item[k]) s.delete(item[k]); });
  }
  async uploadPhoto(path, blob) {
    await tx(this.db, 'blobs', 'readwrite', s => s.put(blob, path));
    if (this.urls.has(path)) { URL.revokeObjectURL(this.urls.get(path)); this.urls.delete(path); }
    return path;
  }
  async photoUrls(paths) {
    const out = {};
    for (const p of paths) {
      if (!p) continue;
      if (!this.urls.has(p)) {
        const blob = await tx(this.db, 'blobs', 'readonly', s => s.get(p));
        if (blob) this.urls.set(p, URL.createObjectURL(blob));
      }
      if (this.urls.has(p)) out[p] = this.urls.get(p);
    }
    return out;
  }
  async getBlob(path) { return tx(this.db, 'blobs', 'readonly', s => s.get(path)); }
  async removePhoto(path) { await tx(this.db, 'blobs', 'readwrite', s => s.delete(path)); }
  async getProfile() { return (await tx(this.db, 'kv', 'readonly', s => s.get('profile'))) || {}; }
  async saveProfile(data) { await tx(this.db, 'kv', 'readwrite', s => s.put(data, 'profile')); }
  async listWears() { return (await tx(this.db, 'wears', 'readonly', s => s.getAll())) || []; }
  async addWear(w) { const row = { id: uuid(), ...w }; await tx(this.db, 'wears', 'readwrite', s => s.put(row)); return row; }
  photoPath(id, kind, type = 'image/jpeg') { return `local/${id}${SUFFIX[kind] || ''}.${ext(type)}`; }
}

// ---------------------------------------------------------------- cloud
class CloudStore {
  constructor() { this.mode = 'cloud'; this.urlCache = new Map(); }
  async init() {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await this.sb.auth.getSession();
    this.user = data.session?.user || null;
    return { signedIn: Boolean(this.user) };
  }
  async signIn(email, password) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
  }
  async signOut() { await this.sb.auth.signOut(); this.user = null; }
  check({ data, error }) { if (error) throw error; return data; }
  async listItems() {
    return this.check(await this.sb.from('items').select('*').order('no'));
  }
  async saveItem(item) {
    const row = { ...pick(item) };
    if (item.id) row.id = item.id;
    return this.check(await this.sb.from('items').upsert(row).select().single());
  }
  async updateMany(rows) {
    if (!rows.length) return;
    this.check(await this.sb.from('items').upsert(rows.map(r => ({ id: r.id, ...pick(r) }))));
  }
  async deleteItem(item) {
    const paths = PHOTO_FIELDS.map(k => item[k]).filter(Boolean);
    if (paths.length) await this.sb.storage.from(BUCKET).remove(paths);
    this.check(await this.sb.from('items').delete().eq('id', item.id));
  }
  async uploadPhoto(path, blob) {
    this.check(await this.sb.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' }));
    this.urlCache.delete(path);
    return path;
  }
  async photoUrls(paths) {
    const now = Date.now();
    const need = [...new Set(paths.filter(p => p && !(this.urlCache.get(p)?.exp > now)))];
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const data = this.check(await this.sb.storage.from(BUCKET).createSignedUrls(chunk, 3600 * 6));
      for (const d of data) if (d.signedUrl) this.urlCache.set(d.path, { url: d.signedUrl, exp: now + 3600 * 5 * 1000 });
    }
    const out = {};
    for (const p of paths) if (p && this.urlCache.has(p)) out[p] = this.urlCache.get(p).url;
    return out;
  }
  async removePhoto(path) { await this.sb.storage.from(BUCKET).remove([path]); this.urlCache.delete(path); }
  async getBlob(path) {
    const data = this.check(await this.sb.storage.from(BUCKET).download(path));
    return data;
  }
  async getProfile() {
    const data = this.check(await this.sb.from('profile').select('data').maybeSingle());
    return data?.data || {};
  }
  async saveProfile(d) {
    this.check(await this.sb.from('profile').upsert({ user_id: this.user.id, data: d, updated_at: new Date().toISOString() }));
  }
  async listWears() { return this.check(await this.sb.from('wears').select('*').order('worn_on', { ascending: false })); }
  async addWear(w) { return this.check(await this.sb.from('wears').insert(w).select().single()); }
  photoPath(id, kind, type = 'image/jpeg') { return `${this.user.id}/${id}${SUFFIX[kind] || ''}.${ext(type)}`; }
}

export function createStore() { return cloudEnabled ? new CloudStore() : new LocalStore(); }

// ---------------------------------------------------------------- images
export async function loadImage(fileOrBlob) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export async function resize(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}

// Full photo ~1280px (~150–300 KB) and thumbnail ~400px (~25 KB).
export async function compressPhoto(file) {
  const img = await loadImage(file);
  const [full, thumb] = await Promise.all([resize(img, 1280, 0.8), resize(img, 400, 0.72)]);
  return { full, thumb };
}

export function blobToDataUrl(blob) {
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

export async function dataUrlToBlob(dataUrl) { return (await fetch(dataUrl)).blob(); }

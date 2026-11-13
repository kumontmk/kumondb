// ============================================================
// booth-shared.js — shared constants & helpers
// Used by booth-games.js (admin) and booth-register.js (public)
// ============================================================

export const GRADES = ['K0','K1','K2','K3','P1','P2','P3','P4','P5','P6','F1','F2','F3','F4','F5','F6'];

export const GRADE_CN = {
  K0:'幼幼班', K1:'小班', K2:'中班', K3:'大班',
  P1:'小一', P2:'小二', P3:'小三', P4:'小四', P5:'小五', P6:'小六',
  F1:'初一', F2:'初二', F3:'初三', F4:'高一', F5:'高二', F6:'高三'
};

export const gradeIdx = g => GRADES.indexOf(String(g || '').toUpperCase());
export const gradeBand = g => String(g || '').charAt(0).toUpperCase();
export const gradeLabel = g => GRADE_CN[g] ? `${g} ${GRADE_CN[g]}` : String(g || '');
export const gradeInRange = (g, min, max) => {
  const i = gradeIdx(g);
  return i >= 0 && i >= gradeIdx(min) && i <= gradeIdx(max);
};
export const rangeLabel = (min, max) => min === max ? gradeLabel(min) : `${gradeLabel(min)} – ${gradeLabel(max)}`;

export const INTERESTS = [
  { id:'math',    cn:'數學', en:'Math' },
  { id:'erp',     cn:'英文（ERP）', en:'English (ERP) · English Reading Programme' },
  { id:'efl',     cn:'英文（EFL）', en:'English (EFL) · English as a Foreign Language' },
  { id:'chinese', cn:'中文', en:'Chinese' },
  { id:'kindies', cn:'幼兒學習啟蒙班', en:'Kumon Kindies Programme' },
  { id:'connect', cn:'Kumon Connect 公文式平板學習體驗', en:'Kumon Connect · Tablet Study Experience' },
  { id:'none',    cn:'沒有，我的孩子目前是公文式學生', en:'None. My child is a current Kumon student', exclusive:true },
  { id:'noneNow', cn:'暫時沒有', en:'None at the moment', exclusive:true }
];
export const interestLabel = id => {
  const o = INTERESTS.find(x => x.id === id);
  return o ? `${o.cn} / ${o.en}` : String(id || '');
};

export const GAME_EMOJIS = ['🎯','','🧩','','🎪','','🎳','','🎣','','🧠','','🎈','','🤹','🥽','️',''];

export const PALETTE = ['#2f6fb2','#e5484d','#f2b100','#12a594','#d6409f','#7c5cd6','#f97316','#0ea5e9'];

export const BANNERS = [
  { id:'fiesta', label:'Fiesta 嘉年華', stops:[[0,'#ff5f6d'],[0.48,'#ffc371'],[1,'#d6409f']] },
  { id:'ocean',  label:'Ocean 海洋',   stops:[[0,'#2f6fb2'],[0.55,'#7cc4e8'],[1,'#12a594']] },
  { id:'candy',  label:'Candy 糖果',   stops:[[0,'#d6409f'],[0.55,'#7c5cd6'],[1,'#0ea5e9']] },
  { id:'meadow', label:'Meadow 草原',  stops:[[0,'#12a594'],[0.55,'#a3e635'],[1,'#f2b100']] },
  { id:'night',  label:'Night 星夜',   stops:[[0,'#1b2a52'],[0.6,'#7c5cd6'],[1,'#d6409f']] }
];
export const bannerStops = id => (BANNERS.find(b => b.id === id) || BANNERS[0]).stops;
export const bannerCss = id =>
  `linear-gradient(115deg, ${bannerStops(id).map(([p, c]) => `${c} ${Math.round(p * 100)}%`).join(', ')})`;

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyB1VhQwGotEI8BHt8wp8FvtPpUY5FsI0qA",
  authDomain: "kumondb-f4377.firebaseapp.com",
  databaseURL: "https://kumondb-f4377-default-rtdb.firebaseio.com",
  projectId: "kumondb-f4377",
  storageBucket: "kumondb-f4377.firebasestorage.app",
  messagingSenderId: "838725994916",
  appId: "1:838725994916:web:87326ba7bec87a0e6b5931"
};

// ---------- generic helpers ----------
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

export function randomCode(len = 6, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map(x => alphabet[x % alphabet.length]).join('');
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${randomCode(4)}`;
}

export function localDateStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function calcAge(birth, ref = new Date()) {
  if (!birth) return null;
  const b = new Date(String(birth) + 'T00:00:00');
  if (isNaN(b.valueOf())) return null;
  let y = ref.getFullYear() - b.getFullYear();
  let m = ref.getMonth() - b.getMonth();
  if (ref.getDate() < b.getDate()) m--;
  if (m < 0) { y--; m += 12; }
  if (y < 0) return null;
  return { years: y, months: m };
}

export function ageText(birth, ref) {
  const a = calcAge(birth, ref);
  if (!a) return '';
  return `${a.years}y ${a.months}m · ${a.years}歲${a.months}個月`;
}

export function fmtDate(v, withDay = true) {
  if (!v) return '—';
  const d = new Date(String(v) + 'T00:00:00');
  if (isNaN(d.valueOf())) return String(v);
  const opts = { day:'numeric', month:'short', year:'numeric' };
  if (withDay) opts.weekday = 'short';
  return d.toLocaleDateString('en-GB', opts);
}

export function fmtDateShort(v) {
  return fmtDate(v, false).replace(/ \d{4}$/, '');
}

export function daysBetween(dateStr) {
  const a = new Date(String(dateStr) + 'T00:00:00');
  const b = new Date(localDateStr() + 'T00:00:00');
  return Math.round((a - b) / 86400000);
}

// ---------- event dates & venue (multi-day + bilingual) ----------
// Legacy records (single eventDate / single venue) are normalised on load.
export function normalizeEventConfig(cfg) {
  const c = { ...(cfg || {}) };
  if (!c.eventStart && c.eventDate) c.eventStart = c.eventDate;
  if (!c.eventEnd) c.eventEnd = c.eventStart || c.eventDate || '';
  if (!c.eventStart) c.eventStart = c.eventEnd || '';
  if (c.venue && !c.venueEn && !c.venueCn) c.venueEn = c.venue;
  return c;
}

export function normalizeGames(games, cfg) {
  const def = (cfg && (cfg.eventStart || cfg.eventDate)) || '';
  const out = {};
  Object.entries(games || {}).forEach(([gid, g]) => {
    const slots = {};
    Object.entries((g && g.slots) || {}).forEach(([sid, s]) => {
      slots[sid] = { ...(s || {}), date: (s && s.date) || def };
    });
    out[gid] = { ...(g || {}), slots };
  });
  return out;
}

export function eventRangeLabel(cfg) {
  const c = normalizeEventConfig(cfg);
  const s = c.eventStart || '', e = c.eventEnd || '';
  if (!s && !e) return '';
  if (!e || s === e) return fmtDate(s);
  return `${fmtDate(s, false)} → ${fmtDate(e, false)}`;
}

export function venueLines(cfg) {
  const c = normalizeEventConfig(cfg);
  return [c.venueEn || '', c.venueCn || ''].filter(Boolean);
}

// Registration window state: open | before | after | paused
export function windowState(cfg) {
  if (!cfg || !cfg.regStart) return { state: 'invalid' };
  if (cfg.isActive === false) return { state: 'paused' };
  const today = localDateStr();
  if (cfg.regStart && today < cfg.regStart) return { state: 'before', days: daysBetween(cfg.regStart) };
  if (cfg.regEnd && today > cfg.regEnd) return { state: 'after' };
  return { state: 'open', daysLeft: cfg.regEnd ? daysBetween(cfg.regEnd) : null };
}

export function slotLabel(s) { return s ? `${s.start || '--:--'} – ${s.end || '--:--'}` : '—'; }
export function slotFullLabel(s) {
  if (!s) return '—';
  return (s.date ? fmtDate(s.date, false) + ' · ' : '') + slotLabel(s);
}
// Date-aware: slots on different days never overlap.
export function slotsOverlap(a, b) {
  if (!a || !b) return false;
  if ((a.date || '') !== (b.date || '')) return false;
  return a.start < b.end && b.start < a.end;
}

export function validPhone(s) {
  const digits = String(s || '').replace(/[\s-]/g, '');
  return /^\+?\d{6,15}$/.test(digits);
}
export function normalizePhone(s) { return String(s || '').replace(/[\s-]/g, ''); }

export function timeAgo(ts) {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function slugify(s) {
  return String(s || 'event').trim().replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40) || 'event';
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
    return true;
  }
}

export function downloadDataUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

export function loadImg(src) {
  return new Promise((res, rej) => {
    if (!src) return rej(new Error('Empty image source'));
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Image failed to load'));
    i.src = src;
  });
}

// ---------- QR (qrcode-generator global) ----------
export function renderQrCanvas(text, px = 280, dark = '#16233b', light = '#ffffff') {
  if (typeof qrcode !== 'function' || !text) return null;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount(), m = 4;
    const scale = Math.max(2, Math.floor(px / (n + m * 2)));
    const size = (n + m * 2) * scale;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = light; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = dark;
    for (let r = 0; r < n; r++)
      for (let col = 0; col < n; col++)
        if (qr.isDark(r, col)) ctx.fillRect((col + m) * scale, (r + m) * scale, scale, scale);
    return c;
  } catch (err) { console.error('QR render error:', err); return null; }
}

// ---------- canvas text helpers (poster export) ----------
export function wrapLines(ctx, text, maxWidth) {
  const raw = String(text ?? '').trim();
  if (!raw) return ['—'];
  const isCJK = ch => /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch);
  const tokens = [];
  raw.split(/\s+/).forEach(word => {
    if (ctx.measureText(word).width <= maxWidth) { tokens.push(word); return; }
    let cur = '';
    for (const ch of word) {
      if (cur && ctx.measureText(cur + ch).width > maxWidth) { tokens.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) tokens.push(cur);
  });
  const lines = [];
  let line = '';
  tokens.forEach(tok => {
    const sep = line && (isCJK(line[line.length - 1]) || isCJK(tok[0])) ? '' : ' ';
    const test = line ? line + sep + tok : tok;
    if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = tok; }
    else line = test;
  });
  if (line) lines.push(line);
  return lines.length ? lines : ['—'];
}

export function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
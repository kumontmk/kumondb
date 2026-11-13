// ============================================================
// leave.js — Leave Module (Application + Overview + Entitlements
//            + Weekly Reports + Cancel Requests + Extra Credits)
// ============================================================
import { db, logout } from './auth.js';
import { ref, get, update, onValue, push, runTransaction, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t, applyI18n, currentLanguage } from './leave-i18n.js';

const auth = getAuth();
const AUTHORIZED_EMAIL = 'kumonchamps@gmail.com';
const MAX_ATTACHMENT_BYTES = 100 * 1024;

await i18nReady.catch(() => {});
document.documentElement.lang = currentLanguage;
applyI18n();

let i18nTimer = null;
const i18nObserver = new MutationObserver(() => {
  clearTimeout(i18nTimer);
  i18nTimer = setTimeout(() => {
    i18nObserver.disconnect();
    document.documentElement.lang = currentLanguage;
    applyI18n();
    i18nObserver.takeRecords();
    i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, 50);
});
if (document.body) i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
else document.addEventListener('DOMContentLoaded', () => i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true }));

let DOW = t('dowShort', { returnObjects: true }) || ['S','M','T','W','T','F','S'];
let DOW_NAMES = t('dowNames', { returnObjects: true }) || ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
let MONTH_NAMES = t('months', { returnObjects: true }) || ['January','February','March','April','May','June','July','August','September','October','November','December'];

const EMAILJS_SERVICE_ID = 'service_xiorqac';
const EMAILJS_TEMPLATE_ID = 'template_leave';
const EMAILJS_PUBLIC_KEY = 'h6ZUxpNW1GViOnq32';
const EMAIL_NOTIFICATIONS_ENABLED = true;

const TYPE_META = {
  annual: { label: t('typeAnnual'), cls: 'lv-annual', ledger: 'annualUsed' },
  sick:   { label: t('typeSick'),   cls: 'lv-sick',   ledger: 'sickUsed' },
  unpaid: { label: t('typeUnpaid'), cls: 'lv-unpaid', ledger: null },
  pt:     { label: t('typePT'),     cls: 'lv-pt',     ledger: 'timeOffUsed' },
  extra:  { label: t('typeExtra'),  cls: 'lv-extra',  ledger: 'extraUsed' }
};
const ENTITLEMENT_FIELDS = { annualUsed: 'annual', sickUsed: 'sick', timeOffUsed: 'timeOff' };
const LV_COLORS = {
  'lv-annual': { solid: '#4682B4', faint: '#dbeafe' },
  'lv-sick':   { solid: '#eab308', faint: '#fef9c3' },
  'lv-unpaid': { solid: '#f97316', faint: '#ffedd5' },
  'lv-pt':     { solid: '#ec4899', faint: '#fce7f3' },
  'lv-extra':  { solid: '#10b981', faint: '#d1fae5' }
};
const LV_ABBR = { annual: 'AL', sick: 'SL', unpaid: 'UL', pt: 'PT', extra: 'EL' };
const LV_OVERLAY = {
  annual: 'rgba(70,130,180,0.28)', sick: 'rgba(234,179,8,0.30)',
  unpaid: 'rgba(249,115,22,0.30)', pt: 'rgba(236,72,153,0.28)',
  extra: 'rgba(16,185,129,0.28)'
};

let employees = {}, leaves = {}, currentUser = null;
let statusFilter = 'pending', monthFilter = 'all';
let currentYear = new Date().getFullYear();
let entYear = new Date().getFullYear();
let pickerYear = currentYear;
let viewDate = new Date();
let pendingAttachment = null, currentAttLeaveId = null;
let applyExcessAsUnpaid = false;
let scheduleTemplates = {}, offDatesCache = {};
let allCenterIds = [], allCenters = [], centerCalendars = {};
let allSchedulesCache = null, employeeScheduleByCenter = {}, employeeScheduleLoadedCenters = new Set();
let scheduleUnsubscribers = [];
let initializedForUid = null, refreshTimer = null, searchTimer = null;
let currentApproveLeave = null, empASchedulesCache = {}, lastTypeOptionsYear = null;

const $ = id => document.getElementById(id);
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
const pad = n => String(n).padStart(2, '0');
const round2 = n => Math.round(n * 100) / 100;
const round1 = n => Math.round(n * 10) / 10;
const fmtISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtISO(new Date());
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const isPartTime = emp => (emp?.terms || '').toLowerCase().includes('part');

function L(key, vars = {}, fallback = key) {
  let v = null;
  try { v = t(key, vars); } catch (e) {}
  if (typeof v === 'string' && v && v !== key) return v;
  return String(fallback).replace(/{{(\w+)}}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
}

// ============================================================
// 🔔 TOASTS
// ============================================================
function ensureToastStack() {
  let stack = $('toastStack');
  if (!stack) { stack = document.createElement('div'); stack.id = 'toastStack'; stack.className = 'toast-stack'; stack.setAttribute('aria-live', 'polite'); document.body.appendChild(stack); }
  return stack;
}
function dismissToast(el) { if (!el || el.dataset.leaving) return; el.dataset.leaving = '1'; el.classList.add('toast-out'); setTimeout(() => el.remove(), 280); }
function toast(message, type = 'info', opts = {}) {
  const stack = ensureToastStack();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const icons = { success: '✓', error: '✕', warning: '!', info: 'i' };
  const titles = { success: L('toastSuccess', {}, 'Success'), error: L('toastError', {}, 'Something went wrong'), warning: L('toastWarning', {}, 'Heads up'), info: L('toastInfo', {}, 'Notice') };
  const durations = { success: 3800, info: 4200, warning: 5600, error: 8000 };
  const duration = opts.duration ?? durations[type] ?? 4500;
  el.innerHTML = `<div class="toast-icon">${icons[type] || 'i'}</div><div class="toast-body"><div class="toast-title">${escapeHtml(opts.title || titles[type])}</div><div class="toast-msg">${escapeHtml(message)}</div></div><button class="toast-close" type="button" aria-label="Close">×</button><div class="toast-progress" style="animation-duration:${duration}ms"></div>`;
  stack.appendChild(el);
  while (stack.children.length > 5) dismissToast(stack.firstElementChild);
  let remaining = duration, start = Date.now();
  let timer = setTimeout(() => dismissToast(el), duration);
  el.addEventListener('mouseenter', () => { clearTimeout(timer); remaining -= Date.now() - start; el.classList.add('paused'); });
  el.addEventListener('mouseleave', () => { start = Date.now(); timer = setTimeout(() => dismissToast(el), Math.max(600, remaining)); el.classList.remove('paused'); });
  el.querySelector('.toast-close').addEventListener('click', () => { clearTimeout(timer); dismissToast(el); });
  return el;
}
function notify(message, opts = {}) {
  const msg = String(message ?? '');
  let type = opts.type;
  if (!type) {
    if (/^(✅|🎉)/.test(msg)) type = 'success';
    else if (/^(❌|⛔)/.test(msg)) type = 'error';
    else if (/^(⚠️|🔶)/.test(msg)) type = 'warning';
    else type = 'info';
  }
  const clean = msg.replace(/^(?:✅|❌|⚠️|🎉|ℹ️|🔄|⏳|🎁|🚫|↩️|🛠️|⛔)\s*/u, '').trim();
  return toast(clean || msg, type, opts);
}

// ============================================================
// 🪟 CONFIRM DIALOG
// ============================================================
let confirmState = null;
function ensureConfirmModal() {
  if ($('confirmModal')) return;
  const el = document.createElement('div');
  el.id = 'confirmModal'; el.className = 'modal confirm-modal';
  el.innerHTML = `<div class="modal-content confirm-content" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle"><div class="confirm-icon" id="confirmIcon">?</div><h3 id="confirmTitle"></h3><p id="confirmMessage"></p><div class="modal-actions confirm-actions"><button class="secondary" id="confirmCancelBtn" type="button"></button><button class="primary" id="confirmOkBtn" type="button"></button></div></div>`;
  document.body.appendChild(el);
  closeModal('confirmModal');
  $('confirmCancelBtn').addEventListener('click', () => resolveConfirm(false));
  $('confirmOkBtn').addEventListener('click', () => resolveConfirm(true));
  el.addEventListener('click', e => { if (e.target === el) resolveConfirm(false); });
}
function resolveConfirm(val) { const st = confirmState; confirmState = null; closeModal('confirmModal'); if (st) st(val); }
function askConfirm({ title, message, confirmText, cancelText, danger = false } = {}) {
  ensureConfirmModal();
  return new Promise(res => {
    if (confirmState) resolveConfirm(false);
    confirmState = res;
    const modal = $('confirmModal');
    modal.classList.toggle('danger', !!danger);
    $('confirmIcon').textContent = danger ? '!' : '?';
    $('confirmTitle').textContent = title || L('confirmTitle', {}, 'Are you sure?');
    $('confirmMessage').textContent = message || '';
    const ok = $('confirmOkBtn');
    ok.textContent = confirmText || L('confirmOk', {}, 'Confirm');
    ok.className = danger ? 'danger' : 'primary';
    $('confirmCancelBtn').textContent = cancelText || t('cancel');
    openModal('confirmModal');
    setTimeout(() => (danger ? $('confirmCancelBtn') : ok).focus(), 40);
  });
}

// ============================================================
// HELPERS
// ============================================================
function isValidTimeString(v) {
  if (!v) return false;
  if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(v)) return false;
  const [h, m] = v.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}
function timeToMinutes(v) { if (!isValidTimeString(v)) return null; const [h, m] = v.split(':').map(Number); return h * 60 + m; }
function timeRangesOverlap(aS, aE, bS, bE) {
  const a1 = timeToMinutes(aS), a2 = timeToMinutes(aE), b1 = timeToMinutes(bS), b2 = timeToMinutes(bE);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return true;
  return a1 < b2 && b1 < a2;
}
function trimShiftAround(existing, added) {
  const es = timeToMinutes(existing.start), ee = timeToMinutes(existing.end);
  const as = timeToMinutes(added.start), ae = timeToMinutes(added.end);
  if (es == null || ee == null || as == null || ae == null) return [{ ...existing }];
  if (es >= ae || ee <= as) return [{ ...existing }];
  const parts = [];
  if (es < as) parts.push({ ...existing, end: added.start });
  if (ee > ae) parts.push({ ...existing, start: added.end });
  return parts;
}
async function computeRelieverAdjustments(relieverId, dateStr, newShift) {
  const sched = await getEmpScheduleForDate(relieverId, dateStr);
  const adjustments = [];
  (sched.shifts || []).forEach(s => {
    if ((s.type || 'work') !== 'work') return;
    const parts = trimShiftAround(s, newShift);
    if (parts.length === 1 && parts[0].start === s.start && parts[0].end === s.end) return;
    const center = s._center || s.center || newShift.center;
    adjustments.push({ center, before: { type: 'work', start: s.start, end: s.end, center: s.center || center, otherDesc: s.otherDesc || '' }, after: parts.map(p => ({ type: 'work', start: p.start, end: p.end, center: s.center || center, otherDesc: s.otherDesc || '' })) });
  });
  return adjustments;
}
function leaveDateRangeOverlaps(existing, dateFrom, dateTo, durationType, timeFrom, timeTo) {
  if (!existing?.dateFrom || !existing?.dateTo) return false;
  const dateOverlap = existing.dateFrom <= dateTo && existing.dateTo >= dateFrom;
  if (!dateOverlap) return false;
  if (durationType === 'hours' && existing.durationType === 'hours') return timeRangesOverlap(timeFrom, timeTo, existing.timeFrom, existing.timeTo);
  return true;
}
function daysBetweenInclusive(a, b) {
  if (!a || !b) return 0;
  const s = new Date(a + 'T00:00:00'), e = new Date(b + 'T00:00:00');
  return Math.round((e - s) / 86400000) + 1;
}
function eachDate(from, to, cb) { const d = new Date(from + 'T00:00:00'); const e = new Date(to + 'T00:00:00'); while (d <= e) { cb(d); d.setDate(d.getDate() + 1); } }
const uiLocale = () => (currentLanguage === 'zh-TW' ? 'zh-TW' : 'en-US');
function fmtDate(s) { if (!s) return '-'; return new Date(s + 'T00:00:00').toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric' }); }
function fmtDateShort(s) { if (!s) return '-'; return new Date(s + 'T00:00:00').toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' }); }
function getDowAbbr(date) {
  if (currentLanguage === 'zh-TW') return date.toLocaleDateString('zh-TW', { weekday: 'short' });
  return ['Sun', 'Mon', 'Tues', 'Wed', 'Thurs', 'Fri', 'Sat'][date.getDay()];
}
function fmtDateWithDow(s) {
  if (!s) return '-';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return `${d.toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric' })} (${getDowAbbr(d)})`;
}
function getEmpPositions(emp) { if (Array.isArray(emp?.positions)) return emp.positions; if (emp?.position) return [emp.position]; return []; }
function base64Bytes(dataUrl) { const b64 = (dataUrl || '').split(',')[1] || ''; return Math.ceil(b64.length * 3 / 4); }
function openModal(id) { const el = $(id); if (el) { el.classList.remove('hidden'); el.style.display = 'flex'; } }
function closeModal(id) { const el = $(id); if (el) { el.classList.add('hidden'); el.style.display = 'none'; } }
function getCenterAbbr(centerId) {
  if (!centerId) return '?';
  const c = allCenters.find(x => x.id === centerId);
  const n = (c ? c.name : centerId).toLowerCase();
  if (n.includes('mei keng')) return 'MK'; if (n.includes('pac tat')) return 'PT';
  if (n.includes('tap siac')) return 'TS'; if (n.includes('champs')) return 'C';
  if (n.includes('t11')) return 'T11'; if (n.includes('ao')) return 'AO'; if (n.includes('am')) return 'AM';
  return centerId.substring(0, 4).toUpperCase();
}
function statusLabel(status) {
  const map = { pending: t('statusPending'), approved: t('statusApproved'), rejected: t('statusRejected'), cancelled: t('statusCancelled') };
  return map[status] || (status || '').toUpperCase();
}

// ============ ACCESS CONTROL ============
function grantAccess() { $('accessDenied')?.classList.add('hidden'); $('mainContent')?.classList.remove('hidden'); }
function showAccessDenied(title, msg) {
  $('mainContent')?.classList.add('hidden');
  const ad = $('accessDenied'); if (!ad) return;
  ad.classList.remove('hidden');
  const c = ad.querySelector('.access-denied-content');
  if (c) c.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(msg)}</p><button class="primary" type="button" onclick="location.href='centers.html'">${escapeHtml(t('backToCenters'))}</button>`;
}
async function resolveUser(user) {
  const email = user.email?.toLowerCase() || '';
  let isMaster = email === AUTHORIZED_EMAIL.toLowerCase();
  let empId = null, positions = [];
  try {
    const snap = await get(ref(db, `employees/${user.uid}`));
    if (snap.exists()) { empId = user.uid; positions = getEmpPositions(snap.val()); }
    else {
      const all = await get(ref(db, 'employees'));
      const match = Object.entries(all.val() || {}).find(([_, e]) => e.email?.toLowerCase() === email);
      if (match) { empId = match[0]; positions = getEmpPositions(match[1]); }
    }
    if (!positions.length) { const uSnap = await get(ref(db, `users/${user.uid}`)); positions = getEmpPositions(uSnap.val() || {}); }
  } catch (err) { console.error('resolveUser error:', err); }
  const pos = positions.map(p => String(p || '').trim().toLowerCase());
  if (pos.includes('master admin')) isMaster = true;
  const isAdmin = isMaster || pos.includes('manager') || pos.includes('master admin');
  if (!empId && !isAdmin) return null;
  return { uid: user.uid, email, isMaster, isAdmin, empId };
}
onAuthStateChanged(auth, async (user) => {
  if (!user) { showAccessDenied(t('loginFirst'), t('noSession')); return; }
  currentUser = await resolveUser(user);
  if (!currentUser) { showAccessDenied(t('noProfile'), t('noProfileMsg', { email: user.email })); return; }
  grantAccess();
  initApp();
});

// ============ INIT + REALTIME ============
function initApp() {
  if (initializedForUid && initializedForUid !== currentUser.uid) { location.reload(); return; }
  if (initializedForUid === currentUser.uid) { refreshAll(); return; }
  initializedForUid = currentUser.uid;
  if (!currentUser.isAdmin) { const entTab = $('tabEntitlements'); if (entTab) entTab.style.display = 'none'; }
  if (!currentUser.isMaster) { const wrTab = $('tabWeeklyReports'); if (wrTab) wrTab.style.display = 'none'; }
  setText('entYearLabel', entYear);
  $('leaveTable').innerHTML = `<tbody><tr><td class="empty-state">${escapeHtml(t('loadingRecords'))}</td></tr></tbody>`;
  injectAdminControls();
  wireEvents();
  renderMonthPickerLabel();
  loadScheduleData();
  onValue(ref(db, 'employees'), s => { employees = s.val() || {}; refreshAllSoon(); });
  onValue(ref(db, 'leaves'), s => { leaves = s.val() || {}; refreshAllSoon(); scheduleAutoSync(); });
}
function refreshAllSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshAll, 80); }
function refreshAll() {
  if (!currentUser) return;
  populateEmpFilter();
  renderBalanceStrip();
  renderLeaveTable();
  if ($('main-tab-overview')?.classList.contains('active')) renderOverview();
  if ($('main-tab-entitlements')?.classList.contains('active')) renderEntitlementsTab();
  if ($('main-tab-weeklyreports')?.classList.contains('active')) renderWeeklyReports();
  cxMaybeRender();
  if (xcCurrentEmpId && $('extraCreditModal') && !$('extraCreditModal').classList.contains('hidden')) { renderXcSummary(); renderXcHistory(); }
  // If the apply modal is open, re-validate the type list against fresh data
  if ($('applyModal') && !$('applyModal').classList.contains('hidden')) populateTypeSelect();
}

// ============ SCHEDULE + CALENDAR DATA ============
async function loadCenterIds() {
  try {
    const cSnap = await get(ref(db, 'centers'));
    const data = cSnap.val() || {};
    allCenters = Object.entries(data).map(([id, d]) => ({ id, name: d.name || id }));
    allCenterIds = allCenters.map(c => c.id);
    ['t11', 'ao', 'am'].forEach(id => { if (!allCenterIds.includes(id)) { allCenterIds.push(id); allCenters.push({ id, name: id.toUpperCase() }); } });
  } catch (e) { console.warn('loadCenterIds', e); }
}
async function loadCenterCalendars() {
  try {
    if (!allCenterIds.length) await loadCenterIds();
    await Promise.allSettled(allCenterIds.map(async cid => { const snap = await get(ref(db, `centers/${cid}/calendar`)); centerCalendars[cid] = snap.val() || {}; }));
  } catch (e) { console.warn('loadCenterCalendars', e); }
}
function clearScheduleListeners() { scheduleUnsubscribers.forEach(u => { try { u(); } catch (e) {} }); scheduleUnsubscribers = []; }
function subscribeScheduleChanges() {
  clearScheduleListeners(); if (!allCenterIds.length) return;
  if (currentUser.isAdmin) {
    scheduleUnsubscribers.push(onValue(ref(db, 'schedules'), s => { allSchedulesCache = s.val() || {}; offDatesCache = {}; refreshAllSoon(); }));
  } else if (currentUser.empId) {
    employeeScheduleByCenter = {}; employeeScheduleLoadedCenters = new Set();
    allCenterIds.forEach(cid => {
      scheduleUnsubscribers.push(onValue(ref(db, `schedules/${cid}/${currentUser.empId}`), s => {
        employeeScheduleByCenter[cid] = s.val() || {}; employeeScheduleLoadedCenters.add(cid); delete offDatesCache[currentUser.empId]; refreshAllSoon();
      }));
    });
  }
}
async function loadScheduleData() {
  await loadCenterIds(); await loadCenterCalendars(); subscribeScheduleChanges();
  if (currentUser.isAdmin) onValue(ref(db, 'scheduleTemplates'), s => { scheduleTemplates = s.val() || {}; refreshAllSoon(); });
  else if (currentUser.empId) onValue(ref(db, `scheduleTemplates/${currentUser.empId}`), s => { scheduleTemplates[currentUser.empId] = s.val() || {}; refreshAllSoon(); });
}
function getWeeklyOffDays(empId) {
  const offs = new Set(); const tmpl = scheduleTemplates[empId] || {};
  for (const [dow, t2] of Object.entries(tmpl)) { if ((t2?.status || 'scheduled') === 'off') { const n = Number(dow); if (Number.isInteger(n) && n >= 0 && n <= 6) offs.add(n); } }
  if (!offs.size) offs.add(0); return offs;
}
async function getOffDates(empId) {
  if (offDatesCache[empId]) return offDatesCache[empId];
  const set = new Set();
  try {
    if (!allCenterIds.length) await loadCenterIds();
    if (currentUser?.isAdmin && allSchedulesCache) {
      allCenterIds.forEach(cid => { Object.entries(allSchedulesCache?.[cid]?.[empId] || {}).forEach(([ds, rec]) => { if ((rec?.status || 'scheduled') === 'off') set.add(ds); }); });
    } else if (!currentUser?.isAdmin && currentUser?.empId === empId && employeeScheduleLoadedCenters.size === allCenterIds.length) {
      allCenterIds.forEach(cid => { Object.entries(employeeScheduleByCenter?.[cid]?.[empId] || {}).forEach(([ds, rec]) => { if ((rec?.status || 'scheduled') === 'off') set.add(ds); }); });
    } else {
      await Promise.allSettled(allCenterIds.map(async cid => { const snap = await get(ref(db, `schedules/${cid}/${empId}`)); Object.entries(snap.val() || {}).forEach(([ds, rec]) => { if ((rec?.status || 'scheduled') === 'off') set.add(ds); }); }));
    }
  } catch (e) { console.warn('getOffDates', e); }
  offDatesCache[empId] = set; return set;
}
function getEmpCenterIds(empId) { const perms = employees[empId]?.permissions?.centers || {}; const ids = Object.keys(perms).filter(k => perms[k] === true); return ids.length ? ids : [...allCenterIds]; }
function isHoliday(empId, dateStr) { return getEmpCenterIds(empId).some(cid => { const ev = centerCalendars[cid]?.[dateStr]; return !!(ev && ev.type === 'public' && !ev.muc); }); }
function getPublicHolidayForEmp(empId, dateStr) { for (const cid of getEmpCenterIds(empId)) { const ev = centerCalendars[cid]?.[dateStr]; if (ev && ev.type === 'public' && !ev.muc) return ev; } return null; }
async function isDayOff(empId, dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  if (getWeeklyOffDays(empId).has(dow)) return true;
  if ((await getOffDates(empId)).has(dateStr)) return true;
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  return isHoliday(empId, dateStr);
}
async function countLeaveDays(empId, from, to) {
  const weeklyOffDays = getWeeklyOffDays(empId); const offDates = await getOffDates(empId);
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  let days = 0; const skipped = []; const daysPerYear = {};
  eachDate(from, to, d => {
    const ds = fmtISO(d);
    if (weeklyOffDays.has(d.getDay()) || offDates.has(ds) || isHoliday(empId, ds)) { skipped.push(ds); return; }
    days++; const yr = d.getFullYear(); daysPerYear[yr] = (daysPerYear[yr] || 0) + 1;
  });
  return { days, skipped, weeklyOffDays, daysPerYear };
}
async function getSplitLeaveRanges(empId, from, to, availableDays, baseLeaveData, type) {
  const weeklyOffDays = getWeeklyOffDays(empId); const offDates = await getOffDates(empId);
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  const working = [], skipped = [];
  eachDate(from, to, d => { const ds = fmtISO(d); if (weeklyOffDays.has(d.getDay()) || offDates.has(ds) || isHoliday(empId, ds)) skipped.push(ds); else working.push(ds); });
  const daysPerYearOf = dates => { const o = {}; dates.forEach(ds => { const y = parseInt(ds.slice(0, 4), 10); o[y] = (o[y] || 0) + 1; }); return o; };
  const skippedWithin = (a, b) => skipped.filter(ds => ds >= a && ds <= b).join(', ');
  const toHM = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  const records = [];
  const wholePaid = Math.floor(availableDays + 0.0001);
  const fraction = round2(availableDays - wholePaid);
  const paidFullDays = working.slice(0, wholePaid);
  const fracDay = fraction > 0 ? working[wholePaid] : null;
  const unpaidFullDays = working.slice(fraction > 0 ? wholePaid + 1 : wholePaid);
  if (paidFullDays.length) {
    const dFrom = paidFullDays[0], dTo = paidFullDays[paidFullDays.length - 1];
    records.push({ ...baseLeaveData, type, typeLabel: TYPE_META[type].label, dateFrom: dFrom, dateTo: dTo, amount: paidFullDays.length, deductDays: paidFullDays.length, restDaysExcluded: skippedWithin(dFrom, dTo), daysPerYear: daysPerYearOf(paidFullDays), year: parseInt(dFrom.slice(0, 4), 10) });
  }
  if (fracDay) {
    const sched = await getEmpScheduleForDate(empId, fracDay);
    const workShifts = (sched.shifts || []).filter(s => (s.type || 'work') === 'work' && isValidTimeString(s.start) && isValidTimeString(s.end) && timeToMinutes(s.end) > timeToMinutes(s.start)).sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
    if (!workShifts.length) throw new Error(t('splitNoShiftAlert', { name: baseLeaveData.empName || '', date: fmtDate(fracDay) }));
    const totalWorkHours = round1(workShifts.reduce((sum, s) => sum + (timeToMinutes(s.end) - timeToMinutes(s.start)), 0) / 60);
    const paidHours = Math.min(round1(fraction * 8), totalWorkHours);
    const startMin = timeToMinutes(workShifts[0].start);
    const paidFromTime = toHM(startMin), paidToTime = toHM(startMin + Math.round(paidHours * 60));
    const yearNum = parseInt(fracDay.slice(0, 4), 10);
    records.push({ ...baseLeaveData, type, typeLabel: TYPE_META[type].label, durationType: 'hours', dateFrom: fracDay, dateTo: fracDay, timeFrom: paidFromTime, timeTo: paidToTime, amount: paidHours, deductDays: round2(paidHours / 8), restDaysExcluded: '', daysPerYear: { [yearNum]: round2(paidHours / 8) }, year: yearNum });
    const unpaidHours = round1(totalWorkHours - paidHours);
    if (unpaidHours > 0) {
      const dayEndMin = Math.max(...workShifts.map(s => timeToMinutes(s.end)));
      records.push({ ...baseLeaveData, type: 'unpaid', typeLabel: TYPE_META.unpaid.label, durationType: 'hours', dateFrom: fracDay, dateTo: fracDay, timeFrom: paidToTime, timeTo: toHM(dayEndMin), amount: unpaidHours, deductDays: round2(unpaidHours / 8), restDaysExcluded: '', daysPerYear: { [yearNum]: round2(unpaidHours / 8) }, year: yearNum });
    }
  }
  if (unpaidFullDays.length) {
    const dFrom = unpaidFullDays[0], dTo = unpaidFullDays[unpaidFullDays.length - 1];
    records.push({ ...baseLeaveData, type: 'unpaid', typeLabel: TYPE_META.unpaid.label, dateFrom: dFrom, dateTo: dTo, amount: unpaidFullDays.length, deductDays: unpaidFullDays.length, restDaysExcluded: skippedWithin(dFrom, dTo), daysPerYear: daysPerYearOf(unpaidFullDays), year: parseInt(dFrom.slice(0, 4), 10) });
  }
  return records;
}
async function getEmpScheduleForDate(empId, dateStr) {
  if (!allCenterIds.length) await loadCenterIds();
  let mergedShifts = [], originalStatus = 'scheduled', originalNotes = '';
  const adminCache = currentUser?.isAdmin && allSchedulesCache;
  const ownCache = !currentUser?.isAdmin && currentUser?.empId === empId && employeeScheduleLoadedCenters.size === allCenterIds.length;
  for (const cid of allCenterIds) {
    let data = null, exists = false;
    if (adminCache) { data = allSchedulesCache?.[cid]?.[empId]?.[dateStr] || null; exists = !!data; }
    else if (ownCache) { data = employeeScheduleByCenter?.[cid]?.[empId]?.[dateStr] || null; exists = !!data; }
    else { try { const snap = await get(ref(db, `schedules/${cid}/${empId}/${dateStr}`)); exists = snap.exists(); data = snap.val(); } catch (e) { console.warn(`schedule load failed ${empId} ${cid} ${dateStr}`, e); } }
    if (exists && data) {
      if (data.status && data.status !== 'scheduled') originalStatus = data.status;
      if (data.notes) originalNotes = data.notes;
      if (data.shifts && Array.isArray(data.shifts)) data.shifts.forEach(s => mergedShifts.push({ ...s, _center: s.center || cid }));
    }
  }
  if (mergedShifts.length === 0 && originalStatus === 'scheduled') {
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    const tmpl = scheduleTemplates[empId]?.[dow];
    if (tmpl) {
      if (tmpl.status && tmpl.status !== 'scheduled') originalStatus = tmpl.status;
      if (tmpl.notes) originalNotes = tmpl.notes;
      if (tmpl.shifts && Array.isArray(tmpl.shifts)) {
        const empCenters = getEmpCenterIds(empId);
        tmpl.shifts.forEach(s => mergedShifts.push({ ...s, _center: s.center || empCenters[0] || allCenterIds[0] }));
      }
    }
  }
  return { status: originalStatus, notes: originalNotes, shifts: mergedShifts };
}

// ============ ADMIN CONTROLS ============
function injectAdminControls() {
  const slot = $('adminFilters'), empGroup = $('applyEmpGroup');
  if (!currentUser.isAdmin) { if (slot) slot.innerHTML = ''; if (empGroup) empGroup.innerHTML = ''; return; }
  if (slot) {
    slot.innerHTML = `<button class="secondary" id="exportLeavesBtn" type="button" title="${escapeHtml(t('exportExcelTitle'))}">${escapeHtml(t('exportExcel'))}</button> <div class="filter-group"><label for="empFilter">${escapeHtml(t('employee'))}</label><select id="empFilter"></select></div> <input type="text" id="searchLeave" placeholder="${escapeHtml(t('searchLeave'))}" />`;
    $('exportLeavesBtn').addEventListener('click', exportLeaves);
    $('empFilter').addEventListener('change', renderLeaveTable);
    $('searchLeave').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderLeaveTable, 200); });
  }
  if (empGroup) {
    empGroup.innerHTML = `<label for="applyEmp">${escapeHtml(t('employee'))} *</label><select id="applyEmp"></select>`;
    $('applyEmp').addEventListener('change', () => { offDatesCache = {}; populateTypeSelect(); });
  }
}

// ============ ENTITLEMENTS ============
function leaveRecordYear(l) { return Number(l?.year) || parseInt((l?.dateFrom || '').slice(0, 4), 10) || new Date().getFullYear(); }
function getApprovedUsedForYear(empId, year, typeKey) {
  let used = 0;
  Object.values(leaves).forEach(l => {
    if (l.empId !== empId || l.status !== 'approved' || l.type !== typeKey) return;
    let d = 0;
    if (l.daysPerYear && l.daysPerYear[year] !== undefined) d = Number(l.daysPerYear[year] || 0);
    else if (leaveRecordYear(l) === year) d = Number(l.deductDays || 0);
    used += d;
  });
  return round2(used);
}
function getUnpaidTotalsForYear(empId, year) {
  let days = 0, hours = 0;
  Object.values(leaves).forEach(l => {
    if (l.empId !== empId || l.type !== 'unpaid' || l.status !== 'approved') return;
    if (l.durationType === 'hours') { if (leaveRecordYear(l) === year) hours = round2(hours + Number(l.amount || 0)); }
    else {
      let d = 0;
      if (l.daysPerYear && l.daysPerYear[year] !== undefined) d = Number(l.daysPerYear[year] || 0);
      else if (leaveRecordYear(l) === year) d = Number(l.deductDays || l.amount || 0);
      days = round2(days + d);
    }
  });
  return { days, hours };
}
function formatUnpaidTotal(totals) { const parts = []; if (totals.days) parts.push(`${totals.days}d`); if (totals.hours) parts.push(`${totals.hours}h`); return parts.length ? parts.join(' ') : '0'; }
function getBalancesForYear(emp, empId, year) {
  const le = emp?.leaveEntitlement || {};
  const annual = Number(le.annual || 0), sick = Number(le.sick || 0), timeOff = Number(le.timeOff || 0);
  const annualUsed = empId ? getApprovedUsedForYear(empId, year, 'annual') : Number(le.annualUsed || 0);
  const sickUsed = empId ? getApprovedUsedForYear(empId, year, 'sick') : Number(le.sickUsed || 0);
  const timeOffUsed = empId ? getApprovedUsedForYear(empId, year, 'pt') : Number(le.timeOffUsed || 0);
  return {
    year,
    annual: { entitled: annual, used: annualUsed, balance: round2(annual - annualUsed) },
    sick: { entitled: sick, used: sickUsed, balance: round2(sick - sickUsed) },
    timeOff: { entitled: timeOff, used: timeOffUsed, balance: round2(timeOff - timeOffUsed) },
    extra: getExtraBalance(emp, empId)
  };
}
function getBalances(emp, empId = null) { return getBalancesForYear(emp, empId, new Date().getFullYear()); }
function selectedLeaveYear() { const d = $('dateFrom')?.value; const y = d ? parseInt(d.slice(0, 4), 10) : NaN; return Number.isInteger(y) ? y : new Date().getFullYear(); }
function buildTypeOptions(emp, empId, year) {
  const b = getBalancesForYear(emp, empId, year);
  const tag = year !== new Date().getFullYear() ? `${t('quotaTag', { year })}` : '';
  const opts = [];
  if (!isPartTime(emp)) {
    opts.push({ key: 'annual', text: t('optAnnual', { balance: b.annual.balance, tag }), disabled: b.annual.balance <= 0 });
    opts.push({ key: 'sick', text: t('optSick', { balance: b.sick.balance, tag }), disabled: b.sick.balance <= 0 });
  } else {
    opts.push({ key: 'pt', text: t('optPT', { balance: b.timeOff.balance, tag }), disabled: false });
  }
  opts.push({ key: 'extra', text: t('optExtra', { balance: b.extra.balance }), disabled: b.extra.balance <= 0 });
  const annualLeft = Math.max(0, b.annual.balance);
  const isMaster = currentUser?.isMaster;
  const disableUnpaid = annualLeft > 0 && !isMaster;
  opts.push({ key: 'unpaid', text: annualLeft > 0 ? t('optUnpaidAvailable', { left: annualLeft, tag }) : t('optUnpaid', { tag }), disabled: disableUnpaid, showHint: annualLeft > 0 && !isMaster });
  return opts;
}
function enabledTypeKeys(emp, empId, year) { return buildTypeOptions(emp, empId, year).filter(o => !o.disabled).map(o => o.key); }

// 🔒 Force the select to a genuinely-enabled option. A disabled <option> can
// still become the value via browser fallback / stale state, so never trust it.
function ensureValidTypeSelection() {
  const sel = $('leaveType'); if (!sel) return;
  const empId = selectedApplyEmpId(); const emp = employees[empId];
  if (!emp) { sel.value = ''; return; }
  const enabled = enabledTypeKeys(emp, empId, selectedLeaveYear());
  const chosen = sel.options[sel.selectedIndex];
  if (!enabled.includes(sel.value) || (chosen && chosen.disabled)) sel.value = enabled[0] || '';
}

// 🔒 Keep Submit disabled whenever the chosen type isn't allowed, with a reason.
function refreshSubmitGuard() {
  const btn = $('submitLeaveBtn'); if (!btn) return;
  const empId = selectedApplyEmpId(); const emp = employees[empId];
  const type = $('leaveType')?.value;
  let block = false, msg = '';
  if (!emp || !type || !TYPE_META[type]) block = true;
  else {
    const enabled = enabledTypeKeys(emp, empId, selectedLeaveYear());
    if (!enabled.includes(type)) { block = true; msg = L('typeNotAvailableAlert', {}, '⚠️ That leave type is not available for this employee.'); }
    else if (type === 'extra' && getExtraBalance(emp, empId).balance <= 0) { block = true; msg = L('extraNoCreditsAlert', {}, '⚠️ No extra / comp-off credits are available. Ask an admin to grant credits first.'); }
  }
  btn.disabled = block;
  const box = $('balanceBox');
  if (box) {
    let hint = $('submitBlockHint');
    if (!hint) { hint = document.createElement('div'); hint.id = 'submitBlockHint'; hint.className = 'hint submit-block-hint'; box.appendChild(hint); }
    if (block && msg) { hint.textContent = msg; hint.classList.remove('hidden'); }
    else hint.classList.add('hidden');
  }
}

async function adjustEntitlementAtomic(leave, delta, { enforceBalance = true } = {}) {
  const ledgerField = TYPE_META[leave?.type]?.ledger;
  if (!ledgerField || !delta || !leave?.empId) return;
  const entitlementRef = ref(db, `employees/${leave.empId}/leaveEntitlement`);
  const result = await runTransaction(entitlementRef, le => {
    le = le || {};
    const entitled = Number(le[ENTITLEMENT_FIELDS[ledgerField]] || 0);
    const nextUsed = round2(Number(le[ledgerField] || 0) + delta);
    const requiresBalanceCheck = ledgerField === 'annualUsed' || ledgerField === 'sickUsed';
    if (enforceBalance && delta > 0 && requiresBalanceCheck && nextUsed > entitled + 0.001) return;
    le[ledgerField] = Math.max(0, nextUsed);
    return le;
  });
  if (!result.committed) throw new Error(L('insufficientBalance', { label: TYPE_META[leave?.type]?.label, year: leave.year }, 'Insufficient {{label}} balance for {{year}}.'));
}
async function recalcEntitlementUsed(empId) {
  const emp = employees[empId]; if (!emp) return false;
  const le = emp.leaveEntitlement || {};
  const nowYear = new Date().getFullYear();
  let entYearLocal = Number(le.lastResetYear) || nowYear;
  const extraUpdates = {};
  if (nowYear > entYearLocal) { entYearLocal = nowYear; extraUpdates.lastResetYear = nowYear; }
  let annual = 0, sick = 0, timeOff = 0;
  Object.values(leaves).forEach(l => {
    if (l.empId !== empId || l.status !== 'approved') return;
    let d = 0;
    if (l.daysPerYear && l.daysPerYear[entYearLocal] !== undefined) d = Number(l.daysPerYear[entYearLocal] || 0);
    else if (leaveRecordYear(l) === entYearLocal) d = Number(l.deductDays || 0);
    if (d > 0) { if (l.type === 'annual') annual += d; else if (l.type === 'sick') sick += d; else if (l.type === 'pt') timeOff += d; }
  });
  annual = round2(annual); sick = round2(sick); timeOff = round2(timeOff);
  const unchanged = !extraUpdates.lastResetYear && (le.annualUsed || 0) === annual && (le.sickUsed || 0) === sick && (le.timeOffUsed || 0) === timeOff;
  if (unchanged) return false;
  await update(ref(db, `employees/${empId}/leaveEntitlement`), { annualUsed: annual, sickUsed: sick, timeOffUsed: timeOff, ...extraUpdates });
  return true;
}

// ============ AUTO-SYNC ============
let autoSyncTimer = null, autoSyncRunning = false, autoSyncQueued = false, syncToastTimer = null;
function showSyncStatus(msg, done) {
  let el = $('syncToast');
  if (!el) { el = document.createElement('div'); el.id = 'syncToast'; el.className = 'sync-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('visible'); el.classList.toggle('done', !!done);
  clearTimeout(syncToastTimer); if (done) syncToastTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}
function scheduleAutoSync() { if (!currentUser?.isAdmin) return; clearTimeout(autoSyncTimer); autoSyncTimer = setTimeout(runAutoSync, 500); }
async function runAutoSync() {
  if (autoSyncRunning) { autoSyncQueued = true; return; }
  autoSyncRunning = true; showSyncStatus(t('syncing'), false);
  try {
    do { autoSyncQueued = false; let changed = 0; for (const empId of Object.keys(employees)) { if (await recalcEntitlementUsed(empId)) changed++; } showSyncStatus(changed ? t('syncedCorrected', { count: changed }) : t('synced'), true); } while (autoSyncQueued);
  } catch (e) { console.warn('Auto-sync failed:', e); showSyncStatus(t('syncFailed'), true); }
  finally { autoSyncRunning = false; }
}

// ============ BALANCE STRIP ============
function renderBalanceStrip() {
  const strip = $('balanceStrip'); if (!strip) return;
  let html = '';
  if (currentUser.isAdmin) {
    const pending = Object.values(leaves).filter(l => l.status === 'pending').length;
    if (pending > 0) html += `<button class="pending-chip" id="pendingChip" type="button">${escapeHtml(t('pendingChip', { count: pending, s: pending > 1 ? 's' : '' }))}</button>`;
  }
  const emp = (!currentUser.isMaster && currentUser.empId) ? employees[currentUser.empId] : null;
  if (emp) {
    const b = getBalancesForYear(emp, currentUser.empId, new Date().getFullYear());
    const cards = !isPartTime(emp)
      ? [{ cls: 'bc-annual', icon: '📅', title: t('annual'), d: b.annual }, { cls: 'bc-sick', icon: '🏥', title: t('sick'), d: b.sick }]
      : [{ cls: 'bc-pt', icon: '⏱️', title: t('ptTimeOff'), d: b.timeOff }];
    if (b.extra.entitled > 0 || b.extra.used > 0) cards.push({ cls: 'bc-extra', icon: '🎁', title: t('typeExtra'), d: b.extra });
    html += cards.map(c => `<div class="balance-card ${c.cls}"><div class="bc-title">${c.icon} ${escapeHtml(c.title)}</div><div class="bc-nums"><span>${round2(c.d.entitled)}<label>${escapeHtml(t('entitled'))}</label></span><span>${round2(c.d.used)}<label>${escapeHtml(t('used'))}</label></span><span class="bc-bal">${round2(c.d.balance)}<label>${escapeHtml(t('balance'))}</label></span></div></div>`).join('');
  }
  strip.innerHTML = html; strip.classList.toggle('hidden', !html);
  $('pendingChip')?.addEventListener('click', () => { statusFilter = 'pending'; document.querySelectorAll('.status-pills .pill').forEach(p => p.classList.toggle('active', p.dataset.status === 'pending')); renderLeaveTable(); });
}

// ============ APPLICATION TAB ============
function scopedLeaves() { let list = Object.entries(leaves).map(([id, l]) => ({ id, ...l })); if (!currentUser.isAdmin) list = list.filter(l => l.empId === currentUser.empId); return list; }
function populateEmpFilter() {
  const sel = $('empFilter'); if (!sel || !currentUser?.isAdmin) return;
  const prev = sel.value || 'all';
  const sorted = Object.entries(employees).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  sel.innerHTML = `<option value="all">${escapeHtml(t('allEmployees'))}</option>` + sorted.map(([id, e]) => `<option value="${escapeHtml(id)}">${escapeHtml(e.englishName || id)}</option>`).join('');
  sel.value = prev;
}
function monthRangeForFilter() {
  if (monthFilter === 'all') return null;
  const m = parseInt(monthFilter, 10); if (!m || m < 1 || m > 12) return null;
  const lastDay = new Date(currentYear, m, 0).getDate();
  return { start: `${currentYear}-${pad(m)}-01`, end: `${currentYear}-${pad(m)}-${pad(lastDay)}` };
}
function getFilteredLeaves() {
  let list = scopedLeaves();
  if ($('hidePastYearsToggle')?.checked) { const thisYear = new Date().getFullYear(); list = list.filter(l => parseInt(String(l.year || (l.dateFrom || '').slice(0, 4)), 10) >= thisYear); }
  if (monthFilter !== 'all') {
    list = list.filter(l => String(l.year || (l.dateFrom || '').slice(0, 4)) === String(currentYear));
    const range = monthRangeForFilter();
    if (range) list = list.filter(l => l.dateFrom <= range.end && l.dateTo >= range.start);
  }
  const empF = $('empFilter')?.value;
  if (currentUser.isAdmin && empF && empF !== 'all') list = list.filter(l => l.empId === empF);
  const q = $('searchLeave')?.value.trim().toLowerCase();
  if (q) list = list.filter(l => (l.reason || '').toLowerCase().includes(q) || (l.typeLabel || '').toLowerCase().includes(q) || (l.empName || '').toLowerCase().includes(q));
  list.sort((a, b) => (b.appliedAt || '').localeCompare(a.appliedAt || ''));
  return list;
}
function updatePillCounts() {
  let base = scopedLeaves();
  if ($('hidePastYearsToggle')?.checked) { const thisYear = new Date().getFullYear(); base = base.filter(l => parseInt(String(l.year || (l.dateFrom || '').slice(0, 4)), 10) >= thisYear); }
  const count = s => base.filter(l => l.status === s).length;
  setText('countAll', base.length); setText('countPending', count('pending')); setText('countApproved', count('approved')); setText('countRejected', count('rejected')); setText('countCancelled', count('cancelled'));
}
function durationText(l) { return l.durationType === 'hours' ? `${l.amount} ${t('hrUnit')}` : `${l.amount} ${t('dayUnit')}`; }
function renderLeaveTable() {
  updatePillCounts();
  const table = $('leaveTable'); if (!table) return;
  let list = getFilteredLeaves();
  if (statusFilter !== 'all') list = list.filter(l => l.status === statusFilter);
  const admin = currentUser.isAdmin;
  const cols = admin ? 9 : 8;
  const thead = `<thead><tr>${admin ? `<th>${escapeHtml(t('thEmployee'))}</th>` : ''}<th>${escapeHtml(t('thLeaveType'))}</th><th>${escapeHtml(t('thDuration'))}</th><th>${escapeHtml(t('thFrom'))}</th><th>${escapeHtml(t('thTo'))}</th><th>${escapeHtml(t('thReason'))}</th><th>📎</th><th>${escapeHtml(t('thStatus'))}</th><th>${escapeHtml(t('thActions'))}</th></tr></thead>`;
  if (list.length === 0) { table.innerHTML = thead + `<tbody><tr><td colspan="${cols}" class="empty-state">${escapeHtml(t('noLeaveRecords', { year: monthFilter !== 'all' ? currentYear : 'selected filters' }))}</td></tr></tbody>`; return; }
  const groups = new Map();
  list.forEach(l => { const y = String(l.year || (l.dateFrom || '').slice(0, 4)); if (!groups.has(y)) groups.set(y, []); groups.get(y).push(l); });
  const sortedYears = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  let rows = '';
  sortedYears.forEach(year => {
    rows += `<tr class="year-group-header"><td colspan="${cols}">📆 ${year} (${groups.get(year).length})</td></tr>`;
    groups.get(year).forEach(l => {
      const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
      const fromCell = l.durationType === 'hours' ? `${fmtDateWithDow(l.dateFrom)}${l.timeFrom ? ' · ' + l.timeFrom : ''}` : fmtDateWithDow(l.dateFrom);
      const toCell = l.durationType === 'hours' ? `${fmtDateWithDow(l.dateTo)}${l.timeTo ? ' · ' + l.timeTo : ''}` : fmtDateWithDow(l.dateTo);
      let actions = '';
      if (admin && l.status === 'pending') actions += `<button class="primary" data-action="approve" data-id="${escapeHtml(l.id)}" type="button">✅</button><button class="danger" data-action="reject" data-id="${escapeHtml(l.id)}" type="button">❌</button>`;
      const canCancel = (l.status === 'pending' && (admin || l.empId === currentUser.empId)) || (l.status === 'approved' && admin);
      if (canCancel) actions += `<button class="secondary" data-action="cancel" data-id="${escapeHtml(l.id)}" type="button">🚫</button>`;
      if (!actions) actions = `<span style="color:#cbd5e1;">—</span>`;
      const canDelAtt = l.attachment && (admin || (l.empId === currentUser.empId && l.status === 'pending'));
      const safeId = escapeHtml(l.id);
      rows += `<tr> ${admin ? `<td data-label="${escapeHtml(t('thEmployee'))}">${escapeHtml(l.empName || '-')}${l.empChinese ? `<small>(${escapeHtml(l.empChinese)})</small>` : ''}</td>` : ''} <td data-label="${escapeHtml(t('thLeaveType'))}"><span class="type-dot lv ${meta.cls} approved"></span>${escapeHtml(meta.label)}</td> <td data-label="${escapeHtml(t('thDuration'))}">${durationText(l)}${l.restDaysExcluded ? ` <small style="color:#94a3b8;">${escapeHtml(t('restExcluded'))}</small>` : ''}</td> <td data-label="${escapeHtml(t('thFrom'))}">${fromCell}</td><td data-label="${escapeHtml(t('thTo'))}">${toCell}</td> <td data-label="${escapeHtml(t('thReason'))}" class="reason-cell" title="${escapeHtml(l.reason)}">${escapeHtml(l.reason)}</td> <td data-label="File">${l.attachment ? `<button class="icon-btn" data-action="view-att" data-id="${safeId}" type="button">📎</button>` : '-'}${canDelAtt ? `<button class="icon-btn danger-ico" data-action="del-att" data-id="${safeId}" type="button">🗑</button>` : ''}</td> <td data-label="${escapeHtml(t('thStatus'))}"><span class="status-badge ${l.status}">${escapeHtml(statusLabel(l.status))}</span></td> <td data-label="${escapeHtml(t('thActions'))}"><div class="leave-table-actions">${actions}</div></td> </tr>`;
    });
  });
  table.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

// ============ APPROVE MODAL & RELIEF ============
function renderApproveBalanceInfo(l) {
  let box = $('approveBalanceInfo');
  if (!box) { box = document.createElement('div'); box.id = 'approveBalanceInfo'; const details = $('approveLeaveDetails'); details?.parentNode?.insertBefore(box, details.nextSibling); }
  const emp = employees[l.empId];
  if (!emp) { box.innerHTML = ''; return; }
  const deduct = Number(l.deductDays || 0);
  if (l.type === 'extra') {
    const led = getExtraLedger(emp, l.empId);
    const after = round2(led.balance - deduct);
    const rows = led.credits.filter(c => c.active).map(c => {
      const exp = c.expiresAt ? ` · ${L('xcExpires', { date: fmtDate(c.expiresAt) }, 'Expires {{date}}')}` : '';
      const pct = c.value > 0 ? Math.max(0, Math.min(100, (c.remaining / c.value) * 100)) : 0;
      return `<div class="ab-credit"><span>${escapeHtml(extraReasonLabel(c.reason))}${exp}</span><span class="ab-credit-val">${c.remaining} / ${c.value} ${escapeHtml(t('dayUnit'))}</span><span class="ab-bar"><span style="width:${pct}%"></span></span></div>`;
    }).join('');
    box.className = 'approve-balance' + (after < 0 ? ' low' : '');
    box.innerHTML = `<div class="ab-head">🎁 ${escapeHtml(t('typeExtra'))}</div><div class="ab-stats"><span>${escapeHtml(L('extraEntitledLabel', {}, 'Active credits'))}: <strong>${led.entitled}</strong></span><span>${escapeHtml(L('extraUsedLabel', {}, 'Used'))}: <strong>${led.used}</strong></span><span>${escapeHtml(t('balanceLabel'))}: <strong>${led.balance}</strong></span><span>${escapeHtml(L('abAfter', {}, 'After approval'))}: <strong class="${after < 0 ? 'neg' : ''}">${after}</strong></span></div>${rows || `<div class="ab-empty">${escapeHtml(t('xcNoCredits'))}</div>`}${after < 0 ? `<div class="ab-warn">⚠️ ${escapeHtml(L('extraInsufficientApprove', { balance: led.balance }, 'Extra credit balance is no longer sufficient ({{balance}} day(s) left). The credit may have expired.'))}</div>` : ''}`;
  } else if (l.type === 'annual' || l.type === 'sick' || l.type === 'pt') {
    const year = leaveRecordYear(l);
    const b = getBalancesForYear(emp, l.empId, year);
    const d = l.type === 'annual' ? b.annual : l.type === 'sick' ? b.sick : b.timeOff;
    const after = round2(d.balance - deduct);
    box.className = 'approve-balance' + (after < 0 && l.type !== 'pt' ? ' low' : '');
    box.innerHTML = `<div class="ab-head">${escapeHtml(TYPE_META[l.type].label)} · ${year}</div><div class="ab-stats"><span>${escapeHtml(t('entitledLabel'))}: <strong>${d.entitled}</strong></span><span>${escapeHtml(t('usedInYear', { year }))}: <strong>${d.used}</strong></span><span>${escapeHtml(t('balanceLabel'))}: <strong>${d.balance}</strong></span><span>${escapeHtml(L('abAfter', {}, 'After approval'))}: <strong class="${after < 0 ? 'neg' : ''}">${after}</strong></span></div>`;
  } else {
    box.className = 'approve-balance';
    box.innerHTML = `<div class="ab-head">${escapeHtml(t('typeUnpaid'))}</div><div class="ab-stats"><span>${escapeHtml(t('unpaidNotDeducted'))}</span></div>`;
  }
}
async function openApproveModal(id) {
  const l = leaves[id]; if (!l || l.status !== 'pending') return;
  currentApproveLeave = { id, ...l }; empASchedulesCache = {};
  $('approveLeaveDetails').innerHTML = `<strong>${escapeHtml(l.empName)}</strong> · ${escapeHtml(TYPE_META[l.type]?.label || l.type)}<br> ${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}<br> <em>${escapeHtml(t('thReason'))}: ${escapeHtml(l.reason)}</em>`;
  renderApproveBalanceInfo(l);
  $('confirmApproveBtn').disabled = true; $('confirmApproveBtn').textContent = t('loadingSchedules');
  openModal('approveModal');
  const dates = [];
  if (l.durationType === 'hours') dates.push(l.dateFrom);
  else { let d = new Date(l.dateFrom + 'T00:00:00'); const end = new Date(l.dateTo + 'T00:00:00'); while (d <= end) { dates.push(fmtISO(d)); d.setDate(d.getDate() + 1); } }
  for (const dateStr of dates) {
    const isOff = await isDayOff(l.empId, dateStr);
    empASchedulesCache[dateStr] = isOff ? { isDayOff: true, shifts: [], status: 'scheduled', notes: '' } : await getEmpScheduleForDate(l.empId, dateStr);
  }
  renderApproveTable(l, empASchedulesCache);
  $('confirmApproveBtn').disabled = false; $('confirmApproveBtn').textContent = t('confirmApproval');
}
function renderApproveTable(leave, schedulesByDate) {
  const tbody = $('approveReliefBody'); tbody.innerHTML = '';
  Object.keys(schedulesByDate).sort().forEach(dateStr => {
    const sched = schedulesByDate[dateStr];
    if (sched.isDayOff) { const tr = document.createElement('tr'); tr.innerHTML = `<td>${fmtDateWithDow(dateStr)}</td><td colspan="3" class="no-shift-msg">${escapeHtml(t('dayOffNoRelief'))}</td>`; tbody.appendChild(tr); return; }
    if (!sched.shifts || sched.shifts.length === 0) { const tr = document.createElement('tr'); tr.innerHTML = `<td>${fmtDateWithDow(dateStr)}</td><td colspan="3" class="no-shift-msg">${escapeHtml(t('noShiftNoRelief'))}</td>`; tbody.appendChild(tr); return; }
    sched.shifts.forEach((shift, shiftIdx) => {
      const tr = document.createElement('tr'); tr.dataset.date = dateStr; tr.dataset.shiftIdx = shiftIdx;
      tr.innerHTML = `<td>${fmtDateWithDow(dateStr)}</td><td><strong>${getCenterAbbr(shift._center)}</strong></td><td>${shift.start} - ${shift.end}</td><td class="relievers-cell" data-date="${dateStr}" data-center="${shift._center}" data-start="${shift.start}" data-end="${shift.end}"><div class="no-reliever-toggle"><label><input type="checkbox" class="no-reliever-cb"><span>${escapeHtml(t('noRelieverNeeded'))}</span></label></div><div class="relievers-container"></div><button type="button" class="add-reliever-btn">${escapeHtml(t('addReliever'))}</button></td>`;
      tbody.appendChild(tr);
      const addBtn = tr.querySelector('.add-reliever-btn'), noRelieverCb = tr.querySelector('.no-reliever-cb'), relieversContainer = tr.querySelector('.relievers-container');
      noRelieverCb.addEventListener('change', () => { const isNo = noRelieverCb.checked; addBtn.style.display = isNo ? 'none' : ''; relieversContainer.style.display = isNo ? 'none' : ''; if (isNo) relieversContainer.innerHTML = ''; });
      addBtn.addEventListener('click', () => addRelieverRow(relieversContainer, dateStr, shift._center, shift.start, shift.end));
    });
  });
}
function addRelieverRow(container, dateStr, empACenter, empAStart, empAEnd) {
  const rowId = `rel_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const relieverDiv = document.createElement('div'); relieverDiv.className = 'reliever-row'; relieverDiv.dataset.rowId = rowId;
  let empOptions = `<option value="">${escapeHtml(t('selectReliever'))}</option>`;
  Object.entries(employees).forEach(([uid, e]) => { if (e.isDisabled || uid === currentApproveLeave.empId) return; empOptions += `<option value="${uid}">${escapeHtml(e.englishName || uid)}</option>`; });
  let centerOptions = `<option value="">${escapeHtml(t('none'))}</option>`;
  allCenters.forEach(c => { centerOptions += `<option value="${c.id}" ${c.id === empACenter ? 'selected' : ''}>${escapeHtml(c.name)}</option>`; });
  relieverDiv.innerHTML = `<div class="reliever-controls"><select class="reliever-select">${empOptions}</select><span class="orig-shift-display">${escapeHtml(t('origNone'))}</span><span class="arrow-indicator">→</span><select class="new-center-select">${centerOptions}</select><input type="time" class="new-start-time" value="${empAStart}"><input type="time" class="new-end-time" value="${empAEnd}"><button type="button" class="remove-reliever-btn">🗑</button></div><div class="reliever-overlap-note"></div>`;
  container.insertBefore(relieverDiv, container.querySelector('.add-reliever-btn'));
  const select = relieverDiv.querySelector('.reliever-select'), origDisplay = relieverDiv.querySelector('.orig-shift-display');
  select.addEventListener('change', async () => {
    const rid = select.value;
    if (!rid) { origDisplay.textContent = t('origNone'); refreshRelieverOverlapNote(relieverDiv); return; }
    origDisplay.textContent = t('origLoading');
    const sched = await getEmpScheduleForDate(rid, dateStr);
    if (sched.shifts.length === 0 && sched.status === 'scheduled') origDisplay.textContent = t('origNoShift');
    else if (sched.status !== 'scheduled') origDisplay.textContent = sched.status.toUpperCase();
    else origDisplay.textContent = sched.shifts.map(s => `${getCenterAbbr(s._center || s.center)} ${s.start}-${s.end}`).join(', ') || t('origNoShift');
    refreshRelieverOverlapNote(relieverDiv);
  });
  relieverDiv.querySelector('.remove-reliever-btn').addEventListener('click', () => relieverDiv.remove());
  relieverDiv.querySelector('.new-start-time').addEventListener('change', () => refreshRelieverOverlapNote(relieverDiv));
  relieverDiv.querySelector('.new-end-time').addEventListener('change', () => refreshRelieverOverlapNote(relieverDiv));
}
async function refreshRelieverOverlapNote(relieverDiv) {
  const note = relieverDiv.querySelector('.reliever-overlap-note'); if (!note) return;
  const rid = relieverDiv.querySelector('.reliever-select').value;
  const start = relieverDiv.querySelector('.new-start-time').value, end = relieverDiv.querySelector('.new-end-time').value;
  if (!rid || !isValidTimeString(start) || !isValidTimeString(end) || timeToMinutes(end) <= timeToMinutes(start)) { note.innerHTML = ''; return; }
  const sched = await getEmpScheduleForDate(rid, relieverDiv.closest('tr')?.dataset.date);
  const hits = (sched.shifts || []).filter(s => (s.type || 'work') === 'work' && timeRangesOverlap(start, end, s.start, s.end));
  note.innerHTML = hits.length ? '⚠️ ' + hits.map(s => { const parts = trimShiftAround(s, { start, end }); return `${getCenterAbbr(s._center || s.center)} ${s.start}–${s.end} → ${parts.length ? parts.map(p => `${p.start}–${p.end}`).join(' + ') : 'removed'}`; }).join('<br>⚠️ ') : '';
}
async function confirmApproval() {
  const l = currentApproveLeave;
  if (!l || !l.id) { notify(t('missingRecord'), { type: 'error' }); return; }
  const btn = $('confirmApproveBtn'); btn.disabled = true; btn.textContent = t('processing');
  try {
    const reliefPlan = []; const dates = Object.keys(empASchedulesCache).sort();
    for (const dateStr of dates) {
      const sched = empASchedulesCache[dateStr];
      if (!sched || sched.isDayOff) continue;
      const dayPlan = { date: dateStr, empAOrigSchedule: { status: sched.status, shifts: sched.shifts, notes: sched.notes }, relievers: [] };
      document.querySelectorAll(`#approveReliefBody tr[data-date="${dateStr}"]`).forEach(tr => {
        const noRelieverCb = tr.querySelector('.no-reliever-cb'); if (noRelieverCb && noRelieverCb.checked) return;
        tr.querySelectorAll('.reliever-row').forEach(rr => {
          const rid = rr.querySelector('.reliever-select').value, newCenter = rr.querySelector('.new-center-select').value, newStart = rr.querySelector('.new-start-time').value, newEnd = rr.querySelector('.new-end-time').value;
          if (rid && newCenter && newStart && newEnd) dayPlan.relievers.push({ relieverId: rid, relieverName: employees[rid]?.englishName || '', newShift: { type: 'work', start: newStart, end: newEnd, center: newCenter } });
        });
      });
      reliefPlan.push(dayPlan);
    }
    let deduct = +(l.deductDays || 0), amount = l.amount, skippedStr = l.restDaysExcluded || '', daysPerYear = l.daysPerYear || null;
    for (const dayPlan of reliefPlan) for (const rel of dayPlan.relievers) if (rel.relieverId && rel.newShift) rel.adjustments = await computeRelieverAdjustments(rel.relieverId, dayPlan.date, rel.newShift);
    if (l.durationType !== 'hours') { const c = await countLeaveDays(l.empId, l.dateFrom, l.dateTo); deduct = c.days; amount = c.days; skippedStr = c.skipped.join(', ') || ''; daysPerYear = c.daysPerYear; }
    else if (!daysPerYear) daysPerYear = { [parseInt(l.dateFrom.slice(0, 4), 10)]: deduct };
    const ledgerField = TYPE_META[l.type]?.ledger;
    if (ledgerField === 'annualUsed' || ledgerField === 'sickUsed') {
      for (const [yr, daysInYr] of Object.entries(daysPerYear || {})) {
        const yearNum = parseInt(yr, 10);
        const b = getBalancesForYear(employees[l.empId], l.empId, yearNum);
        const bal = ledgerField === 'annualUsed' ? b.annual : b.sick;
        if (daysInYr > bal.balance + 0.001) throw new Error(t('insufficientBalanceYear', { label: TYPE_META[l.type].label, year: yearNum }));
      }
    }
    if (l.type === 'extra') {
      const led = getExtraLedger(employees[l.empId], l.empId);
      if (led.balance <= 0) throw new Error(L('extraNoCreditsAlert', {}, '⚠️ No extra / comp-off credits are available. Ask an admin to grant credits first.'));
      if (deduct > led.balance + 0.001) throw new Error(L('extraInsufficientApprove', { balance: led.balance }, 'Extra credit balance is no longer sufficient ({{balance}} day(s) left). The credit may have expired.'));
    }
    await update(ref(db, `leaves/${l.id}`), { status: 'approved', reviewedBy: currentUser.uid, reviewedAt: new Date().toISOString(), deductDays: deduct, amount, restDaysExcluded: skippedStr, reliefPlan: reliefPlan, daysPerYear: daysPerYear });
    leaves[l.id] = { ...l, status: 'approved', deductDays: deduct, amount, year: parseInt(l.dateFrom.slice(0, 4), 10), daysPerYear: daysPerYear };
    await recalcEntitlementUsed(l.empId);
    for (const dayPlan of reliefPlan) {
      const dateStr = dayPlan.date; const centersToUpdate = new Set();
      const origShifts = Array.isArray(dayPlan.empAOrigSchedule.shifts) ? dayPlan.empAOrigSchedule.shifts : Object.values(dayPlan.empAOrigSchedule.shifts || {});
      origShifts.forEach(s => centersToUpdate.add(s._center || s.center));
      if (centersToUpdate.size === 0) getEmpCenterIds(l.empId).forEach(c => centersToUpdate.add(c));
      for (const cid of centersToUpdate) {
        await update(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`), { status: l.durationType === 'hours' ? 'scheduled' : 'leave', shifts: origShifts, notes: dayPlan.empAOrigSchedule.notes || '', updatedBy: currentUser.uid, updatedAt: new Date().toISOString() });
      }
      for (const rel of (Array.isArray(dayPlan.relievers) ? dayPlan.relievers : [])) {
        if (!rel.relieverId || !rel.newShift) continue;
        const changesByCenter = {};
        (rel.adjustments || []).forEach(a => { (changesByCenter[a.center] = changesByCenter[a.center] || []).push(a); });
        const touchedCenters = new Set(Object.keys(changesByCenter)); touchedCenters.add(rel.newShift.center);
        for (const center of touchedCenters) {
          const snap = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dateStr}`));
          const rec = snap.val() || { status: 'scheduled', shifts: [], notes: '' };
          let arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});
          if (!snap.exists()) {
            const dow = new Date(dateStr + 'T00:00:00').getDay();
            const tmpl = scheduleTemplates[rel.relieverId]?.[dow];
            const tShifts = (tmpl && Array.isArray(tmpl.shifts)) ? tmpl.shifts : [];
            const empCenters = getEmpCenterIds(rel.relieverId);
            arr = tShifts.map(sh => ({ ...sh, center: sh.center || empCenters[0] || allCenterIds[0] })).filter(sh => sh.center === center);
          }
          (changesByCenter[center] || []).forEach(a => { arr = arr.filter(sh => !((sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end)); arr = arr.concat(a.after); });
          if (center === rel.newShift.center) arr = [...arr, rel.newShift];
          await update(ref(db, `schedules/${center}/${rel.relieverId}/${dateStr}`), { status: rec.status || 'scheduled', shifts: arr, notes: rec.notes || '', updatedBy: currentUser.uid, updatedAt: new Date().toISOString() });
        }
      }
    }
    notifyLeaveEvent({ ...l, amount, deductDays: deduct }, 'approved');
    closeModal('approveModal');
    notify(t('approved'));
  } catch (err) { console.error(err); notify(t('approveFailed', { message: err.message }), { type: 'error' }); }
  finally { btn.disabled = false; btn.textContent = t('confirmApproval'); }
}

// ============ REJECT / CANCEL ============
async function rejectLeave(id) {
  const l = leaves[id]; if (!l || l.status !== 'pending') return;
  const ok = await askConfirm({ title: L('rejectConfirmTitle', {}, 'Reject leave application?'), message: t('rejectConfirm', { name: l.empName }), confirmText: L('rejectBtn', {}, 'Reject'), danger: true });
  if (!ok) return;
  try { await update(ref(db, `leaves/${id}`), { status: 'rejected', reviewedBy: currentUser.uid, reviewedAt: new Date().toISOString() }); notifyLeaveEvent(l, 'rejected'); }
  catch (err) { console.error(err); notify(t('rejectFailed'), { type: 'error' }); }
}
async function cancelLeave(id) {
  const l = leaves[id]; if (!l) return;
  const wasApproved = l.status === 'approved';
  const ok = await askConfirm({ title: L('cancelLeaveTitle', {}, 'Cancel this leave?'), message: wasApproved ? t('cancelApprovedConfirm') : t('cancelConfirm'), confirmText: L('cancelLeaveBtn', {}, 'Cancel leave'), danger: true });
  if (!ok) return;
  if (wasApproved) { try { await restoreSchedulesForLeave(l); } catch (e) { console.error('Schedule restore failed:', e); notify(t('cancelScheduleWarn'), { type: 'warning' }); } }
  if (wasApproved) { try { leaves[id] = { ...l, status: 'cancelled' }; await recalcEntitlementUsed(l.empId); } catch (e) { console.warn('entitlement recalc failed:', e); } }
  try { await update(ref(db, `leaves/${id}`), { status: 'cancelled', cancelledBy: currentUser.uid, cancelledAt: new Date().toISOString() }); }
  catch (err) { console.error(err); notify(t('cancelFailed', { message: err.message }), { type: 'error' }); }
}
async function restoreSchedulesForLeave(l) {
  if (!allCenterIds.length) await loadCenterIds();
  const dates = []; if (l.durationType === 'hours') dates.push(l.dateFrom); else eachDate(l.dateFrom, l.dateTo, d => dates.push(fmtISO(d)));
  for (const dateStr of dates) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        for (const cid of allCenterIds) {
          const snap = await get(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`)); if (!snap.exists()) continue;
          const rec = snap.val() || {}; if (rec.status !== 'leave') continue;
          const shiftsArr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});
          if (shiftsArr.some(s => s.start && s.end)) await update(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`), { status: 'scheduled', updatedBy: currentUser.uid, updatedAt: new Date().toISOString() });
          else await remove(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`));
        }
        break;
      } catch (e) { if (attempt === 2) throw e; }
    }
  }
  if (l.reliefPlan) {
    const planArray = Array.isArray(l.reliefPlan) ? l.reliefPlan : Object.values(l.reliefPlan);
    for (const dayPlan of planArray) {
      try {
        const relievers = dayPlan?.relievers ? (Array.isArray(dayPlan.relievers) ? dayPlan.relievers : Object.values(dayPlan.relievers)) : [];
        for (const rel of relievers) {
          if (!rel?.relieverId || !rel?.newShift) continue;
          const snap = await get(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`));
          const rec = snap.val();
          if (rec?.shifts) {
            const arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts);
            const filtered = arr.filter(s => !(s.start === rel.newShift.start && s.end === rel.newShift.end && (s.center || rel.newShift.center) === rel.newShift.center));
            await update(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`), { ...rec, shifts: filtered });
          }
          const adjustments = Array.isArray(rel.adjustments) ? rel.adjustments : [];
          if (!adjustments.length) continue;
          const adjByCenter = {}; adjustments.forEach(a => { (adjByCenter[a.center] = adjByCenter[a.center] || []).push(a); });
          for (const [center, list] of Object.entries(adjByCenter)) {
            const s2 = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`)); if (!s2.exists()) continue;
            const r2 = s2.val() || {};
            let arr2 = Array.isArray(r2.shifts) ? r2.shifts : Object.values(r2.shifts || {});
            list.forEach(a => {
              (a.after || []).forEach(p => { arr2 = arr2.filter(sh => !((sh.type || 'work') === 'work' && sh.start === p.start && sh.end === p.end)); });
              if (!arr2.some(sh => (sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end)) arr2 = [...arr2, { ...a.before }];
            });
            await update(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`), { ...r2, shifts: arr2, updatedBy: currentUser.uid, updatedAt: new Date().toISOString() });
          }
        }
      } catch (e) { console.warn('reliever restore failed:', e); }
    }
  }
}
async function deleteAttachment(id) {
  const l = leaves[id]; if (!l?.attachment) return;
  const ok = await askConfirm({ title: L('deleteAttTitle', {}, 'Delete attachment?'), message: t('deleteAttConfirm'), confirmText: L('deleteBtn', {}, 'Delete'), danger: true });
  if (!ok) return;
  try { await update(ref(db, `leaves/${id}`), { attachment: null }); closeModal('attachmentModal'); }
  catch (err) { console.error(err); notify(t('deleteAttFailed'), { type: 'error' }); }
}
function openAttachmentViewer(id) {
  const l = leaves[id]; if (!l?.attachment?.dataUrl) return;
  if (!String(l.attachment.dataUrl).startsWith('data:image/')) { notify(t('attNotSupported'), { type: 'warning' }); return; }
  currentAttLeaveId = id; $('attachmentImg').src = l.attachment.dataUrl;
  setText('attachmentCaption', `${l.empName || ''} · ${fmtDate(l.dateFrom)} · ${l.attachment.sizeKB || '?'} KB`);
  const canDelete = currentUser.isAdmin || (l.empId === currentUser.empId && l.status === 'pending');
  $('deleteAttBtn').classList.toggle('hidden', !canDelete);
  openModal('attachmentModal');
}

// ============ EXCEL EXPORT ============
function exportLeaves() {
  if (typeof XLSX === 'undefined') return notify(t('excelNotLoaded'), { type: 'error' });
  let list = getFilteredLeaves(); if (statusFilter !== 'all') list = list.filter(l => l.status === statusFilter);
  if (!list.length) return notify(t('noExportRecords'), { type: 'warning' });
  const rows = list.map(l => ({
    [t('exEmployee')]: l.empName || '', [t('exChineseName')]: l.empChinese || '',
    [t('exLeaveType')]: TYPE_META[l.type]?.label || l.type || '', [t('exDuration')]: durationText(l),
    [t('exFrom')]: l.dateFrom + (l.timeFrom ? ' ' + l.timeFrom : ''), [t('exTo')]: l.dateTo + (l.timeTo ? ' ' + l.timeTo : ''),
    [t('exRestExcluded')]: l.restDaysExcluded || '', [t('exReason')]: l.reason || '',
    [t('exStatus')]: statusLabel(l.status), [t('exAppliedBy')]: l.appliedByName || '',
    [t('exAppliedAt')]: l.appliedAt ? new Date(l.appliedAt).toLocaleString() : ''
  }));
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 40 }, { wch: 11 }, { wch: 22 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws, `Leaves ${currentYear}`);
  XLSX.writeFile(wb, `Kumon_Leaves_${currentYear}.xlsx`);
}

// ============ OVERVIEW TAB ============
async function renderOverview() {
  const table = $('overviewTable'), listEl = $('overviewList'); if (!table) return;
  const y = viewDate.getFullYear(), m = viewDate.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate(); const tStr = todayStr();
  const monthLabel = viewDate.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' });
  setText('monthLabel', monthLabel);
  const monthStart = `${y}-${pad(m + 1)}-01`, monthEnd = `${y}-${pad(m + 1)}-${pad(daysInMonth)}`;
  const visible = Object.values(leaves).filter(l => (l.status === 'approved' || l.status === 'pending') && l.dateFrom <= monthEnd && l.dateTo >= monthStart);
  const activeEmpIds = new Set(visible.map(l => l.empId));
  const empRows = Object.entries(employees).filter(([id, e]) => !e.isDisabled && activeEmpIds.has(id)).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  const offDatesByEmp = {}; await Promise.all(empRows.map(async ([empId]) => { offDatesByEmp[empId] = await getOffDates(empId); }));
  let html = `<thead><tr><th class="name-col">${escapeHtml(t('thEmployee'))}</th>`;
  for (let d = 1; d <= daysInMonth; d++) { const dow = new Date(y, m, d).getDay(); const cls = [(dow === 0 || dow === 6) ? 'weekend' : '', `${y}-${pad(m + 1)}-${pad(d)}` === tStr ? 'today-col' : ''].join(' '); html += `<th class="${cls}">${d}<small>${DOW[dow]}</small></th>`; }
  html += `</tr></thead><tbody>`;
  if (empRows.length === 0) html += `<tr><td colspan="${daysInMonth + 1}" class="empty-state">${escapeHtml(t('noOneOnLeave', { month: monthLabel }))}</td></tr>`;
  for (const [empId, emp] of empRows) {
    const weeklyOffDays = getWeeklyOffDays(empId); const offDates = offDatesByEmp[empId] || new Set();
    html += `<tr data-emp-id="${empId}"><td class="name-col">${escapeHtml(emp.englishName || '-')}</td>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${pad(m + 1)}-${pad(d)}`; const dow = new Date(y, m, d).getDay();
      const extraCls = [(dow === 0 || dow === 6) ? 'weekend-col' : '', ds === tStr ? 'today-col' : ''].join(' ');
      const pub = getPublicHolidayForEmp(empId, ds); const isOff = weeklyOffDays.has(dow) || offDates.has(ds);
      const covering = visible.filter(l => l.empId === empId && l.dateFrom <= ds && l.dateTo >= ds).sort((a, b) => (a.status === 'approved' ? -1 : 1) - (b.status === 'approved' ? -1 : 1));
      const lv = covering[0];
      if (pub) html += `<td class="od-holiday ${extraCls}" title="🎌 ${escapeHtml(pub.name || L('publicHoliday', {}, 'Public holiday'))}">🎌</td>`;
      else if (isOff) html += `<td class="od-off ${extraCls}" title="${escapeHtml(DOW_NAMES[dow])}">${escapeHtml(t('off'))}</td>`;
      else if (lv) {
        const meta = TYPE_META[lv.type] || { cls: '' };
        const titleText = covering.map(l => {
          const mm = TYPE_META[l.type] || { label: l.typeLabel || l.type };
          const timePart = l.durationType === 'hours' && l.timeFrom && l.timeTo ? ` (${l.timeFrom}–${l.timeTo})` : '';
          return `${mm.label || ''} (${statusLabel(l.status)}) ${fmtDate(l.dateFrom)} → ${fmtDate(l.dateTo)} · ${durationText(l)}${timePart}\n${t('thReason')}: ${l.reason || ''}`;
        }).join('\n──────────\n');
        const fullName = `${emp.englishName || ''}\n`;
        if (covering.length === 1) html += `<td class="lv ${meta.cls} ${lv.status} ${extraCls}" title="${escapeHtml(fullName + titleText)}">${lv.durationType === 'hours' ? `${lv.amount}h` : ''}</td>`;
        else {
          const a = covering[0], b = covering[1];
          const ca = LV_COLORS[(TYPE_META[a.type] || {}).cls] || LV_COLORS['lv-annual'];
          const cb = LV_COLORS[(TYPE_META[b.type] || {}).cls] || LV_COLORS['lv-annual'];
          const bgA = a.status === 'approved' ? ca.solid : ca.faint, bgB = b.status === 'approved' ? cb.solid : cb.faint;
          const token = l => l.durationType === 'hours' ? `${l.amount}h` : (LV_ABBR[l.type] || (l.type || '').toUpperCase());
          const mixed = a.status !== b.status;
          const style = `background-image:linear-gradient(135deg, ${bgA} 0%, ${bgA} 49.5%, #ffffff 49.5%, #ffffff 50.5%, ${bgB} 50.5%, ${bgB} 100%);` + (mixed ? `color:#1f2937;text-shadow:0 1px 2px rgba(255,255,255,0.7);` : '');
          html += `<td class="lv lv-split ${extraCls}" style="${style}" title="${escapeHtml(fullName + titleText)}">${escapeHtml(covering.map(token).join('+'))}</td>`;
        }
      } else html += `<td class="${extraCls}"></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody>`;
  table.innerHTML = html;
  table.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', () => tr.classList.toggle('row-highlighted'));
    tr.addEventListener('dblclick', () => { const empId = tr.dataset.empId; if (empId) openEmpScheduleModal(empId); });
  });
  if (listEl) {
    if (visible.length === 0) listEl.innerHTML = `<div class="ov-item" style="justify-content:center;color:var(--text-light);">${escapeHtml(t('noOneOnLeave', { month: monthLabel }))}</div>`;
    else {
      const sorted = [...visible].sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || (a.empName || '').localeCompare(b.empName || ''));
      listEl.innerHTML = sorted.map(l => {
        const meta = TYPE_META[l.type] || { cls: '', label: l.typeLabel || l.type };
        const range = l.dateFrom === l.dateTo ? fmtDateShort(l.dateFrom) : `${fmtDateShort(l.dateFrom)} – ${fmtDateShort(l.dateTo)}`;
        const timeNote = l.durationType === 'hours' && l.timeFrom && l.timeTo ? `(${l.timeFrom}–${l.timeTo})` : '';
        return `<div class="ov-item ${l.status}"><span class="ov-dot lv ${meta.cls} ${l.status}"></span><div class="ov-info"><strong>${escapeHtml(l.empName || '-')}</strong><small>${escapeHtml(meta.label)} · ${durationText(l)}${timeNote}</small></div><div class="ov-when"><span>${range}</span><span class="status-badge ${l.status}">${escapeHtml(statusLabel(l.status))}</span></div></div>`;
      }).join('');
    }
  }
}

// ============ EMPLOYEE SCHEDULE MODAL ============
async function openEmpScheduleModal(empId) {
  const emp = employees[empId]; if (!emp) return;
  const y = viewDate.getFullYear(), m = viewDate.getMonth();
  const monthLabel = viewDate.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' });
  setText('empScheduleModalTitle', `${emp.englishName || emp.chineseName || 'Employee'} — ${monthLabel}`);
  const grid = $('empScheduleCalGrid');
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--text-light);">${escapeHtml(t('loadingSchedules'))}</div>`;
  openModal('empScheduleModal');
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < 7; i++) html += `<div class="emp-schedule-cal-header ${i === 0 || i === 6 ? 'weekend' : ''}">${DOW[i]}</div>`;
  const firstDay = new Date(y, m, 1).getDay();
  for (let i = 0; i < firstDay; i++) html += `<div class="emp-schedule-cal-cell empty-slot"></div>`;
  const todayS = fmtISO(new Date());
  const schedulesByDate = {};
  await Promise.all(Array.from({ length: daysInMonth }, (_, i) => { const ds = `${y}-${pad(m + 1)}-${pad(i + 1)}`; return getEmpScheduleForDate(empId, ds).then(s => { schedulesByDate[ds] = s; }); }));
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  const monthStart = `${y}-${pad(m + 1)}-01`, monthEnd = `${y}-${pad(m + 1)}-${pad(daysInMonth)}`;
  const empLeaves = Object.values(leaves).filter(l => l.empId === empId && (l.status === 'approved' || l.status === 'pending') && l.dateFrom <= monthEnd && l.dateTo >= monthStart);
  const typeAbbr = { annual: 'AL', sick: 'SL', unpaid: 'UL', pt: 'PT', extra: 'EL' };
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(y, m, d), ds = fmtISO(dt), dow = dt.getDay();
    const holiday = getPublicHolidayForEmp(empId, ds);
    let cellClasses = 'emp-schedule-cal-cell';
    if (dow === 0 || dow === 6) cellClasses += ' weekend';
    if (ds === todayS) cellClasses += ' today';
    if (holiday) cellClasses += ' holiday';
    html += `<div class="${cellClasses}"><div class="emp-schedule-day-num">${d}</div><div class="emp-schedule-cell-body">`;
    const sched = schedulesByDate[ds];
    if (sched && sched.shifts && sched.shifts.length > 0) {
      [...sched.shifts].sort((a, b) => (a.start || '').localeCompare(b.start || '')).forEach(shift => {
        if (shift.type === 'break') html += `<div class="emp-schedule-shift" style="color:#999;font-style:italic;">☕ ${shift.start}-${shift.end}</div>`;
        else { const abbr = getCenterAbbr(shift._center || shift.center); html += `<div class="emp-schedule-shift">${shift.start}-${shift.end} <span class="emp-schedule-center c-${abbr}">${abbr}</span></div>`; }
      });
    } else if (sched && sched.status === 'off') html += `<div style="color:#999;font-weight:600;font-size:0.75rem;">OFF</div>`;
    else html += `<div style="color:#ccc;">—</div>`;
    if (holiday) html += `<div class="emp-schedule-holiday">🎌 ${escapeHtml(holiday.name || L('publicHoliday', {}, 'Public holiday'))}</div>`;
    html += `</div>`;
    const dayLeaves = empLeaves.filter(l => l.dateFrom <= ds && l.dateTo >= ds);
    if (dayLeaves.length > 0) {
      dayLeaves.sort((a, b) => (a.status === 'approved' ? -1 : 1) - (b.status === 'approved' ? -1 : 1));
      const lv = dayLeaves[0];
      let overlayClass = 'leave-overlay ' + lv.status;
      let overlayText = typeAbbr[lv.type] || (lv.type || '').toUpperCase();
      let overlayStyle = '';
      if (dayLeaves.length > 1) {
        const tok = l => `${l.durationType === 'hours' ? l.amount + 'h ' : ''}${typeAbbr[l.type] || (l.type || '').toUpperCase()}`;
        const cA = LV_OVERLAY[dayLeaves[0].type] || 'rgba(70,130,180,0.25)', cB = LV_OVERLAY[dayLeaves[1].type] || 'rgba(70,130,180,0.25)';
        const stripes = lv.status === 'pending' ? 'repeating-linear-gradient(45deg, rgba(180,83,9,0.15) 0 4px, transparent 4px 8px), ' : '';
        overlayStyle = ` style="background:${stripes}linear-gradient(135deg, ${cA} 0 50%, ${cB} 50% 100%);font-size:0.72rem;"`;
        overlayText = dayLeaves.map(tok).join(' + ');
      } else if (lv.durationType === 'hours') { overlayClass += ' hourly'; overlayText = `${lv.amount}h ${overlayText}`; }
      html += `<div class="${overlayClass}"${overlayStyle}>${overlayText}</div>`;
    }
    html += `</div>`;
  }
  grid.innerHTML = html;
}

// ============ APPLY MODAL ============
function selectedApplyEmpId() { return currentUser.isAdmin ? $('applyEmp')?.value : currentUser.empId; }
function populateApplyEmployees() {
  const sel = $('applyEmp'); if (!sel || !currentUser.isAdmin) return;
  const sorted = Object.entries(employees).filter(([_, e]) => !e.isDisabled).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  sel.innerHTML = `<option value="">${escapeHtml(t('selectEmployeeFirst'))}</option>` + sorted.map(([id, e]) => `<option value="${escapeHtml(id)}">${escapeHtml(e.englishName || id)} (${escapeHtml(getEmpPositions(e).join(', ') || '-')})</option>`).join('');
}
function populateTypeSelect() {
  const empId = selectedApplyEmpId(); const sel = $('leaveType'), hint = $('unpaidHint'); if (!sel) return;
  if (hint) hint.classList.add('hidden');
  const year = selectedLeaveYear(); lastTypeOptionsYear = year;
  if (!empId || !employees[empId]) { sel.innerHTML = `<option value="">${currentUser.isAdmin ? escapeHtml(t('selectEmployeeFirst')) : '—'}</option>`; updateBalancePanel(); refreshSubmitGuard(); return; }
  const prevSelected = sel.value; const opts = buildTypeOptions(employees[empId], empId, year);
  sel.innerHTML = opts.map(o => `<option value="${o.key}" ${o.disabled ? 'disabled' : ''}>${escapeHtml(o.text)}</option>`).join('');
  const prevStillValid = prevSelected && opts.some(o => o.key === prevSelected && !o.disabled);
  const first = opts.find(o => !o.disabled);
  sel.value = prevStillValid ? prevSelected : (first ? first.key : '');
  ensureValidTypeSelection(); // 🔒 never leave a disabled option selected
  if (opts.some(o => o.showHint) && hint) { hint.textContent = t('unpaidHint', { year }); hint.classList.remove('hidden'); }
  updateBalancePanel();
  refreshSubmitGuard();
}
async function computeRequestDraft() {
  const empId = selectedApplyEmpId();
  const durationType = document.querySelector('input[name="durationType"]:checked')?.value || 'days';
  if (durationType === 'hours') {
    const f = timeToMinutes($('timeFrom')?.value), tv = timeToMinutes($('timeTo')?.value);
    if (f == null || tv == null || tv <= f) return null;
    const deductDays = round2((tv - f) / 60 / 8);
    return { durationType, amount: round1((tv - f) / 60), deductDays, skipped: [], daysPerYear: { [parseInt(($('dateFrom')?.value || '').slice(0, 4), 10)]: deductDays } };
  }
  const from = $('dateFrom')?.value; if (!from) return null;
  const to = $('dateTo')?.value || from; if (to < from) return null;
  if (empId && employees[empId]) { const { days, skipped, daysPerYear } = await countLeaveDays(empId, from, to); return { durationType, amount: days, deductDays: days, skipped, daysPerYear }; }
  const days = daysBetweenInclusive(from, to); return { durationType, amount: days, deductDays: days, skipped: [] };
}
async function updateBalancePanel() {
  const box = $('balanceBox'); if (!box) return;
  const typeKey = $('leaveType')?.value; const empId = selectedApplyEmpId(); const emp = employees[empId]; const year = selectedLeaveYear();
  if (!typeKey || !emp || !TYPE_META[typeKey]) { box.classList.add('hidden'); refreshSubmitGuard(); return; }
  if (typeKey === 'unpaid') { box.innerHTML = `<div class="balance-title">${escapeHtml(t('typeUnpaid'))}</div><div style="font-size:0.85rem;color:var(--text-light);">${escapeHtml(t('unpaidNotDeducted'))}</div>`; box.classList.remove('hidden'); refreshSubmitGuard(); return; }
  const b = getBalancesForYear(emp, empId, year); const map = { annual: b.annual, sick: b.sick, pt: b.timeOff, extra: b.extra }; const d = map[typeKey]; if (!d) { box.classList.add('hidden'); refreshSubmitGuard(); return; }
  const noBalanceNeeded = typeKey === 'pt';
  const isExtraType = typeKey === 'extra';
  const entLbl = isExtraType ? t('extraEntitledLabel') : t('entitledLabel');
  const usedLbl = isExtraType ? L('extraUsedLabel', {}, 'Used') : t('usedInYear', { year });
  const panelTitle = isExtraType ? TYPE_META[typeKey].label : t('entitlementTitle', { label: TYPE_META[typeKey].label, year });
  let afterHtml = '';
  const draft = await computeRequestDraft();
  if (draft) {
    const deductInYear = isExtraType ? draft.deductDays : ((draft.daysPerYear && draft.daysPerYear[year] !== undefined) ? draft.daysPerYear[year] : draft.deductDays);
    const after = round2(d.balance - deductInYear);
    const skippedNote = draft.skipped?.length ? ` ${t('restDaysNote', { count: draft.skipped.length })}` : '';
    const splitNote = (draft.daysPerYear && Object.keys(draft.daysPerYear).length > 1) ? ` ${t('spansYearsNote')}` : '';
    const amountStr = draft.durationType === 'hours' ? `${draft.amount} ${t('hrUnit')}` : `${deductInYear} ${t('dayUnit')}`;
    afterHtml = `<div class="balance-after ${(after < 0 && !noBalanceNeeded) ? 'low' : ''}">${escapeHtml(t('balanceAfter', { year, amount: amountStr, skipped: skippedNote, split: splitNote }))}<strong>${after}</strong>${noBalanceNeeded ? ` <small>${escapeHtml(t('noBalanceNeededPT'))}</small>` : (after < 0 ? escapeHtml(t('exceedsBalance')) : '')}</div>`;
    let excessToggleHtml = '';
    if (after < 0 && !isPartTime(emp) && draft.durationType === 'days' && (typeKey === 'annual' || typeKey === 'sick')) {
      const excessDays = round2(Math.abs(after));
      excessToggleHtml = `<div class="unpaid-excess-toggle"><label><input type="checkbox" id="applyExcessUnpaidCb" ${applyExcessAsUnpaid ? 'checked' : ''}> ${escapeHtml(t('applyExcessUnpaid', { days: excessDays }))}</label></div>`;
    } else applyExcessAsUnpaid = false;
    const yearNote = (!isExtraType && year !== new Date().getFullYear()) ? `<div class="hint">${escapeHtml(t('yearNote', { year }))}</div>` : '';
    box.innerHTML = `<div class="balance-title">${escapeHtml(panelTitle)}</div><div class="balance-grid"><div><label>${escapeHtml(entLbl)}</label><span>${round2(d.entitled)}</span></div><div><label>${escapeHtml(usedLbl)}</label><span>${round2(d.used)}</span></div><div><label>${escapeHtml(t('balanceLabel'))}</label><span class="bal">${round2(d.balance)}</span></div></div>${yearNote}${afterHtml}${excessToggleHtml}`;
    box.classList.remove('hidden');
    $('applyExcessUnpaidCb')?.addEventListener('change', e => { applyExcessAsUnpaid = e.target.checked; updateBalancePanel(); });
    refreshSubmitGuard();
    // 🔒 draft-aware blocking (extra over-balance, annual/sick over-balance without the unpaid toggle)
    const btn = $('submitLeaveBtn');
    if (btn && !btn.disabled) {
      if (isExtraType && draft.deductDays > d.balance + 0.001) { btn.disabled = true; appendBlockHint(L('extraInsufficientAlert', { balance: d.balance, days: draft.deductDays }, '⚠️ Insufficient extra credit balance. Balance is {{balance}} day(s) but this request needs {{days}} day(s).')); }
      else if ((typeKey === 'annual' || typeKey === 'sick') && after < 0 && !applyExcessAsUnpaid) { btn.disabled = true; appendBlockHint(t('insufficientBalanceAlert', { label: TYPE_META[typeKey].label, year, balance: d.balance, days: deductInYear })); }
    }
  } else {
    const yearNote = (!isExtraType && year !== new Date().getFullYear()) ? `<div class="hint">${escapeHtml(t('yearNote', { year }))}</div>` : '';
    box.innerHTML = `<div class="balance-title">${escapeHtml(panelTitle)}</div><div class="balance-grid"><div><label>${escapeHtml(entLbl)}</label><span>${round2(d.entitled)}</span></div><div><label>${escapeHtml(usedLbl)}</label><span>${round2(d.used)}</span></div><div><label>${escapeHtml(t('balanceLabel'))}</label><span class="bal">${round2(d.balance)}</span></div></div>${yearNote}`;
    box.classList.remove('hidden');
    refreshSubmitGuard();
  }
}
function appendBlockHint(msg) {
  const box = $('balanceBox'); if (!box) return;
  let hint = $('submitBlockHint');
  if (!hint) { hint = document.createElement('div'); hint.id = 'submitBlockHint'; hint.className = 'hint submit-block-hint'; box.appendChild(hint); }
  hint.textContent = msg; hint.classList.remove('hidden');
}
function toggleHoursFields() {
  const isHours = document.querySelector('input[name="durationType"]:checked')?.value === 'hours';
  document.querySelectorAll('.hours-fields').forEach(el => el.classList.toggle('hidden', !isHours));
  const dateTo = $('dateTo'), dateFrom = $('dateFrom'); if (!dateTo || !dateFrom) return;
  if (isHours) { dateTo.value = dateFrom.value; dateTo.disabled = true; } else dateTo.disabled = false;
}
function openApplyModal() {
  offDatesCache = {}; loadCenterCalendars();
  setText('applyModalTitle', t('applyModalTitle'));
  if (currentUser.isAdmin) { populateApplyEmployees(); if ($('applyEmp')) $('applyEmp').value = ''; setText('applyEmpInfo', t('adminOnBehalf')); }
  else { const emp = employees[currentUser.empId]; setText('applyEmpInfo', emp ? `${emp.englishName || ''} · ${getEmpPositions(emp).join(', ') || '-'} · ${emp.terms || ''}` : ''); }
  const daysRadio = document.querySelector('input[name="durationType"][value="days"]'); if (daysRadio) daysRadio.checked = true;
  toggleHoursFields();
  if ($('dateFrom')) $('dateFrom').value = todayStr(); if ($('dateTo')) $('dateTo').value = todayStr();
  if ($('timeFrom')) $('timeFrom').value = ''; if ($('timeTo')) $('timeTo').value = '';
  if ($('reason')) $('reason').value = ''; if ($('attachment')) $('attachment').value = '';
  pendingAttachment = null;
  $('attachmentPreview')?.classList.add('hidden');
  applyExcessAsUnpaid = false;
  const leaveType = $('leaveType'); if (leaveType) leaveType.innerHTML = '';
  populateTypeSelect(); openModal('applyModal');
}
function readFileAsDataURL(file) { return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); }); }
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function compressImage(file) {
  const dataUrl = await readFileAsDataURL(file); const img = await loadImage(dataUrl);
  let scale = 1, quality = 0.85, out = dataUrl;
  for (let i = 0; i < 10; i++) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); out = c.toDataURL('image/jpeg', quality);
    if (base64Bytes(out) <= MAX_ATTACHMENT_BYTES) break;
    if (quality > 0.45) quality -= 0.15; else scale *= 0.7;
  }
  if (base64Bytes(out) > MAX_ATTACHMENT_BYTES) throw new Error(t('imageTooBig'));
  return { name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', dataUrl: out, sizeKB: Math.max(1, Math.round(base64Bytes(out) / 1024)) };
}
async function onAttachmentChange(e) {
  const file = e.target.files[0]; const preview = $('attachmentPreview');
  if (!file) { pendingAttachment = null; preview?.classList.add('hidden'); return; }
  if (!file.type.startsWith('image/')) { notify(t('attachImage'), { type: 'warning' }); e.target.value = ''; return; }
  try {
    preview?.classList.remove('hidden'); if (preview) preview.innerHTML = `<span class="attachment-meta">${escapeHtml(t('compressing'))}</span>`;
    pendingAttachment = await compressImage(file);
    if (preview) preview.innerHTML = `<img src="${pendingAttachment.dataUrl}" alt="attachment preview"><div class="attachment-meta">${escapeHtml(pendingAttachment.name)}<br>≈ ${pendingAttachment.sizeKB} KB</div><button class="secondary" type="button" id="removeAttBtn">${escapeHtml(t('remove'))}</button>`;
    $('removeAttBtn')?.addEventListener('click', () => { pendingAttachment = null; if ($('attachment')) $('attachment').value = ''; preview?.classList.add('hidden'); });
  } catch (err) { console.error(err); pendingAttachment = null; preview?.classList.add('hidden'); notify(t('imageFailed'), { type: 'error' }); }
}

// ============ EMAILJS ============
function getManagerEmails() {
  const tos = new Set([AUTHORIZED_EMAIL.toLowerCase()]);
  Object.values(employees).forEach(e => {
    if (e.isDisabled) return;
    const email = String(e.email || '').trim().toLowerCase(); if (!email) return;
    const pos = getEmpPositions(e).map(p => String(p || '').trim().toLowerCase());
    if (pos.includes('manager') || pos.includes('master admin')) tos.add(email);
  });
  return [...tos];
}
function emailjsConfigured() { return typeof emailjs !== 'undefined' && !EMAILJS_SERVICE_ID.startsWith('YOUR_') && !EMAILJS_TEMPLATE_ID.startsWith('YOUR_') && !EMAILJS_PUBLIC_KEY.startsWith('YOUR_'); }
async function notifyLeaveEvent(leave, eventType) {
  if (!EMAIL_NOTIFICATIONS_ENABLED || !emailjsConfigured()) return;
  try {
    const tos = new Set(getManagerEmails());
    const empEmail = employees[leave.empId]?.email?.trim().toLowerCase(); if (empEmail) tos.add(empEmail);
    const uniqueTos = [...tos]; if (!uniqueTos.length) return;
    const subjects = { new: `🏖️ New Leave Request — ${leave.empName} (${leave.typeLabel})`, approved: `✅ Leave APPROVED — ${leave.empName} (${leave.typeLabel})`, rejected: `❌ Leave REJECTED — ${leave.empName} (${leave.typeLabel})` };
    const actionLabel = { new: 'New application (PENDING)', approved: 'APPROVED', rejected: 'REJECTED' }[eventType] || eventType;
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: uniqueTos.join(','), subject: subjects[eventType] || subjects.new, action: actionLabel,
      acted_by: eventType === 'new' ? (leave.appliedByName || '-') : (currentUser?.email || '-'),
      employee_name: leave.empName || '-', leave_type: leave.typeLabel || leave.type || '-',
      dates: `${leave.dateFrom} → ${leave.dateTo}`,
      duration: leave.durationType === 'hours' ? `${leave.amount} hr(s) (${leave.timeFrom}–${leave.timeTo})` : `${leave.amount} day(s)`,
      reason: leave.reason || '-', applied_by: leave.appliedByName || '-'
    }, { publicKey: EMAILJS_PUBLIC_KEY });
  } catch (err) { console.warn('Leave notification failed:', err?.text || err); }
}

// ============ SUBMIT LEAVE ============
async function submitLeave() {
  const empId = selectedApplyEmpId(); if (!empId || !employees[empId]) return notify(t('selectEmployeeAlert'), { type: 'warning' });
  const emp = employees[empId]; const type = $('leaveType')?.value; if (!type || !TYPE_META[type]) return notify(t('selectTypeAlert'), { type: 'warning' });

  // 🔒 HARD GATE 1 — the chosen type must be currently enabled for this employee/year.
  if (!enabledTypeKeys(emp, empId, selectedLeaveYear()).includes(type)) {
    ensureValidTypeSelection(); refreshSubmitGuard();
    return notify(L('typeNotAvailableAlert', {}, '⚠️ That leave type is not available for this employee.'), { type: 'warning' });
  }

  const dateFrom = $('dateFrom')?.value; let dateTo = $('dateTo')?.value || dateFrom; if (!dateFrom) return notify(t('selectDateFromAlert'), { type: 'warning' });
  const durationType = document.querySelector('input[name="durationType"]:checked')?.value || 'days';
  let amount, deductDays, timeFrom = '', timeTo = '', skipped = []; let daysPerYear = null;
  if (durationType === 'hours') {
    dateTo = dateFrom; timeFrom = $('timeFrom')?.value || ''; timeTo = $('timeTo')?.value || '';
    if (!isValidTimeString(timeFrom) || !isValidTimeString(timeTo)) return notify(t('invalidTimesAlert'), { type: 'warning' });
    const f = timeToMinutes(timeFrom), tv = timeToMinutes(timeTo);
    if (f === null || tv === null) return notify(t('enterTimesAlert'), { type: 'warning' }); if (tv <= f) return notify(t('toAfterFromAlert'), { type: 'warning' });
    if (await isDayOff(empId, dateFrom)) return notify(t('restDayNotRequired', { date: fmtDate(dateFrom), name: emp.englishName }), { type: 'warning' });
    amount = round1((tv - f) / 60); deductDays = round2(amount / 8); if (amount <= 0) return notify(t('hourZeroAlert'), { type: 'warning' });
    daysPerYear = { [parseInt(dateFrom.slice(0, 4), 10)]: deductDays };
  } else {
    const count = await countLeaveDays(empId, dateFrom, dateTo); skipped = count.skipped;
    if (count.days <= 0) { const offDayNames = [...count.weeklyOffDays].sort().map(i => DOW_NAMES[i]).join(' / '); return notify(t('allRestDays', { name: emp.englishName, days: offDayNames }), { type: 'warning' }); }
    amount = count.days; deductDays = count.days; daysPerYear = count.daysPerYear;
  }
  const reason = $('reason')?.value.trim(); if (!reason) return notify(t('reasonRequired'), { type: 'warning' });
  if (dateTo < dateFrom) return notify(t('dateToBeforeFromAlert'), { type: 'warning' });
  const conflict = Object.values(leaves).find(l => l.empId === empId && (l.status === 'pending' || l.status === 'approved') && leaveDateRangeOverlaps(l, dateFrom, dateTo, durationType, timeFrom, timeTo));
  if (conflict) return notify(t('duplicateAlert', { name: emp.englishName, type: TYPE_META[conflict.type]?.label || conflict.type, status: statusLabel(conflict.status), from: fmtDate(conflict.dateFrom), to: fmtDate(conflict.dateTo) }), { type: 'warning' });

  const ledgerField = TYPE_META[type].ledger;
  const canSkipBalanceCheck = applyExcessAsUnpaid && !isPartTime(emp) && durationType === 'days';
  if (!canSkipBalanceCheck && (ledgerField === 'annualUsed' || ledgerField === 'sickUsed')) {
    for (const [yr, daysInYr] of Object.entries(daysPerYear || {})) {
      const yearNum = parseInt(yr, 10);
      const b = getBalancesForYear(emp, empId, yearNum);
      const bal = ledgerField === 'annualUsed' ? b.annual : b.sick;
      if (daysInYr > bal.balance + 0.001) return notify(t('insufficientBalanceAlert', { label: TYPE_META[type].label, year: yearNum, balance: bal.balance, days: daysInYr }), { type: 'warning' });
    }
  }

  // 🔒 HARD GATE 2 — Extra requires a positive LIVE balance (re-read from Firebase
  // so a stale local cache can never let a zero-credit request through).
  if (type === 'extra') {
    let liveEmp = emp;
    try { const snap = await get(ref(db, `employees/${empId}/leaveEntitlement`)); liveEmp = { ...emp, leaveEntitlement: snap.val() || {} }; } catch (e) { console.warn('live entitlement read failed, using cache', e); }
    const extraBal = getExtraBalance(liveEmp, empId).balance;
    if (extraBal <= 0) { refreshSubmitGuard(); return notify(L('extraNoCreditsAlert', {}, '⚠️ No extra / comp-off credits are available. Ask an admin to grant credits first.'), { type: 'warning' }); }
    if (deductDays > extraBal + 0.001) return notify(t('extraInsufficientAlert', { balance: extraBal, days: deductDays }), { type: 'warning' });
  }

  const applicantName = currentUser.isAdmin ? `${employees[currentUser.empId]?.englishName || currentUser.email || 'Admin'} ${t('onBehalf')}` : (emp.englishName || '');
  const baseLeaveData = { empId, empName: emp.englishName || '', empChinese: emp.chineseName || '', durationType, reason, attachment: pendingAttachment || null, status: 'pending', appliedBy: currentUser.uid, appliedByName: applicantName, appliedAt: new Date().toISOString() };
  let leaveRecordsToPush = [];
  if (applyExcessAsUnpaid && !isPartTime(emp) && durationType === 'days' && (type === 'annual' || type === 'sick')) {
    let totalAvailableBalance = 0;
    for (const yr of Object.keys(daysPerYear || {})) { const yBal = getBalancesForYear(emp, empId, parseInt(yr, 10)); totalAvailableBalance += (ledgerField === 'annualUsed' ? yBal.annual : yBal.sick).balance; }
    const paidDays = Math.max(0, round2(totalAvailableBalance));
    const unpaidDays = round2(amount - paidDays);
    if (unpaidDays > 0 && paidDays > 0) {
      try { leaveRecordsToPush = await getSplitLeaveRanges(empId, dateFrom, dateTo, paidDays, baseLeaveData, type); }
      catch (err) { return notify(err.message, { type: 'error' }); }
    } else if (unpaidDays > 0 && paidDays === 0) {
      leaveRecordsToPush.push({ ...baseLeaveData, type: 'unpaid', typeLabel: TYPE_META.unpaid.label, dateFrom, dateTo, amount, deductDays, restDaysExcluded: skipped.join(', ') || '', daysPerYear, year: parseInt(dateFrom.slice(0, 4), 10) });
    } else {
      leaveRecordsToPush.push({ ...baseLeaveData, type, typeLabel: TYPE_META[type].label, dateFrom, dateTo, amount, deductDays, restDaysExcluded: skipped.join(', ') || '', daysPerYear, year: parseInt(dateFrom.slice(0, 4), 10) });
    }
  } else {
    leaveRecordsToPush.push({ ...baseLeaveData, type, typeLabel: TYPE_META[type].label, dateFrom, dateTo, timeFrom: timeFrom || '', timeTo: timeTo || '', amount, deductDays, restDaysExcluded: skipped.join(', ') || '', daysPerYear, year: parseInt(dateFrom.slice(0, 4), 10) });
  }
  const btn = $('submitLeaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('submitting'); }
  try {
    for (const data of leaveRecordsToPush) { await push(ref(db, 'leaves'), data); notifyLeaveEvent(data, 'new'); }
    closeModal('applyModal');
    if (leaveRecordsToPush.length > 1) notify(t('splitLeaveSuccessParts', { parts: leaveRecordsToPush.map(r => `${r.amount} ${r.durationType === 'hours' ? t('hrUnit') : t('dayUnit')} ${r.typeLabel}`).join(' + ') }));
    else notify(t('submitted'));
  } catch (err) { console.error(err); notify(t('submitFailed', { message: err.message }), { type: 'error' }); }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('submit'); } refreshSubmitGuard(); }
}

// ============ ENTITLEMENTS TAB ============
function populateEntEmpFilter() {
  const sel = $('entEmpFilter'); if (!sel) return;
  const sorted = Object.entries(employees).filter(([_, e]) => !e.isDisabled).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  sel.innerHTML = `<option value="all">${escapeHtml(t('allEmployees'))}</option>` + sorted.map(([id, e]) => `<option value="${id}">${escapeHtml(e.englishName || id)}</option>`).join('');
}
function renderEntitlementsTab() {
  const table = $('entitlementsTable'); if (!table) return;
  const query = $('entEmpSearch')?.value.trim().toLowerCase() || '';
  let empList = Object.entries(employees).filter(([id, e]) => !e.isDisabled);
  if (query) empList = empList.filter(([id, e]) => (e.englishName || '').toLowerCase().includes(query) || (e.chineseName || '').toLowerCase().includes(query) || id.toLowerCase().includes(query));
  empList.sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  const subHead = `<th>${escapeHtml(t('thEnt'))}</th><th>${escapeHtml(t('thUsed'))}</th><th>${escapeHtml(t('thBal'))}</th>`;
  const thead = `<thead><tr><th rowspan="2">${escapeHtml(t('thEmployee'))}</th><th colspan="3">${escapeHtml(t('thAnnual'))}</th><th colspan="3">${escapeHtml(t('thSick'))}</th><th colspan="3">${escapeHtml(t('thPT'))}</th><th colspan="3">${escapeHtml(t('thEntExtraCol'))}</th><th rowspan="2">${escapeHtml(t('thEntUnpaid'))}</th><th rowspan="2">${escapeHtml(t('thActions'))}</th></tr><tr>${subHead}${subHead}${subHead}${subHead}</tr></thead>`;
  if (empList.length === 0) { table.innerHTML = thead + `<tbody><tr><td colspan="15" class="empty-state">${escapeHtml(query ? L('noEmpMatch', {}, 'No employees match your search.') : t('noEmployeesFound'))}</td></tr></tbody>`; return; }
  const year = entYear;
  let html = '';
  for (const [empId, emp] of empList) {
    const b = getBalancesForYear(emp, empId, year);
    const unpaidTotal = formatUnpaidTotal(getUnpaidTotalsForYear(empId, year));
    let extraWarn = '';
    if (b.extra.expiringSoon.length) { const tip = b.extra.expiringSoon.map(x => `${fmtDate(x.expiresAt)} · ${x.amount} ${t('dayUnit')}`).join('\n'); extraWarn = ` <span class="xc-warn" title="${escapeHtml(tip)}">⚠️</span>`; }
    html += `<tr><td data-label="${escapeHtml(t('thEmployee'))}">${escapeHtml(emp.englishName || '-')} ${emp.chineseName ? `<small>(${escapeHtml(emp.chineseName)})</small>` : ''}</td><td data-label="Annual Ent">${b.annual.entitled}</td><td data-label="Annual Used">${b.annual.used}</td><td data-label="Annual Bal"><strong>${b.annual.balance}</strong></td><td data-label="Sick Ent">${b.sick.entitled}</td><td data-label="Sick Used">${b.sick.used}</td><td data-label="Sick Bal"><strong>${b.sick.balance}</strong></td><td data-label="PT Ent">${b.timeOff.entitled}</td><td data-label="PT Used">${b.timeOff.used}</td><td data-label="PT Bal"><strong>${b.timeOff.balance}</strong></td><td data-label="Extra Ent">${b.extra.entitled}</td><td data-label="Extra Used">${b.extra.used}</td><td data-label="Extra Bal"><strong>${b.extra.balance}</strong>${extraWarn}</td><td data-label="${escapeHtml(t('thEntUnpaid'))}">${unpaidTotal}</td><td data-label="${escapeHtml(t('thActions'))}"><button class="icon-btn" data-action="edit-ent" data-id="${empId}" type="button">✏️ ${escapeHtml(t('editEntitlement'))}</button> <button class="icon-btn" data-action="manage-credits" data-id="${empId}" type="button">🎁 ${escapeHtml(t('btnCredits'))}</button></td></tr>`;
  }
  table.innerHTML = thead + `<tbody>${html}</tbody>`;
}
function openEditEntitlementModal(empId) {
  const emp = employees[empId]; if (!emp) return;
  const le = emp.leaveEntitlement || {};
  $('editEntEmpName').textContent = `${emp.englishName || ''} ${emp.chineseName ? '(' + emp.chineseName + ')' : ''}`;
  $('entAnnual').value = le.annual || 0; $('entSick').value = le.sick || 0; $('entTimeOff').value = le.timeOff || 0;
  $('editEntitlementForm').dataset.empId = empId;
  openModal('editEntitlementModal');
}
async function saveEntitlement(e) {
  e.preventDefault();
  const empId = e.target.dataset.empId; if (!empId) return;
  const annual = parseFloat($('entAnnual').value) || 0, sick = parseFloat($('entSick').value) || 0, timeOff = parseFloat($('entTimeOff').value) || 0;
  try {
    await update(ref(db, `employees/${empId}/leaveEntitlement`), { annual, sick, timeOff, lastResetYear: new Date().getFullYear() });
    closeModal('editEntitlementModal'); notify(t('entitlementUpdated')); renderEntitlementsTab(); renderBalanceStrip();
  } catch (err) { console.error(err); notify(t('entitlementUpdateFailed'), { type: 'error' }); }
}
function exportEntitlements() {
  if (typeof XLSX === 'undefined') return notify(t('excelNotLoaded'), { type: 'error' });
  const year = entYear;
  const empList = Object.entries(employees).filter(([_, e]) => !e.isDisabled).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  const rows = empList.map(([empId, emp]) => {
    const b = getBalancesForYear(emp, empId, year); const unpaid = getUnpaidTotalsForYear(empId, year);
    return { 'Employee': emp.englishName || '', 'Chinese Name': emp.chineseName || '', 'Annual Entitled': b.annual.entitled, 'Annual Used': b.annual.used, 'Annual Balance': b.annual.balance, 'Sick Entitled': b.sick.entitled, 'Sick Used': b.sick.used, 'Sick Balance': b.sick.balance, 'PT Entitled': b.timeOff.entitled, 'PT Used': b.timeOff.used, 'PT Balance': b.timeOff.balance, 'Unpaid Leaves (Approved)': formatUnpaidTotal(unpaid), 'Extra Credit Entitled': b.extra.entitled, 'Extra Credit Used': b.extra.used, 'Extra Credit Balance': b.extra.balance };
  });
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, `Entitlements ${year}`);
  XLSX.writeFile(wb, `Kumon_Entitlements_${year}.xlsx`);
}

// ============ WEEKLY REPORTS ============
function getMondayOfWeek(d) { const dt = new Date(d); dt.setHours(0, 0, 0, 0); const dow = dt.getDay(); dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow)); return dt; }
let wrViewMonday = getMondayOfWeek(new Date());
function wrAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function wrFmtShort(d) { return d.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' }); }
function wrCenterCodes(empId) { const perms = employees[empId]?.permissions?.centers || {}; return Object.keys(perms).filter(k => perms[k] === true).map(getCenterAbbr).join('/'); }
function wrCentersForDate(empId, dateStr) {
  const centers = new Set();
  if (allSchedulesCache) for (const cid of allCenterIds) { const rec = allSchedulesCache[cid]?.[empId]?.[dateStr]; if (!rec) continue; const shifts = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {}); shifts.forEach(s => { if ((s.type || 'work') === 'work' && s.center && s.center !== 'other') centers.add(s.center); }); }
  if (!centers.size) { const dow = new Date(dateStr + 'T00:00:00').getDay(); const tmpl = scheduleTemplates[empId]?.[dow]; if (tmpl) { const shifts = Array.isArray(tmpl.shifts) ? tmpl.shifts : Object.values(tmpl.shifts || {}); shifts.forEach(s => { if ((s.type || 'work') === 'work' && s.center && s.center !== 'other') centers.add(s.center); }); } }
  return [...centers];
}
const WR_DOW_REF = new Date(2024, 0, 1);
function wrDowLabel(dow) { const d = new Date(WR_DOW_REF); d.setDate(d.getDate() + ((dow + 6) % 7)); return getDowAbbr(d); }
function wrCompressDows(dows) {
  const ord = [...new Set(dows)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const runs = []; let start = ord[0], prev = ord[0];
  for (let i = 1; i < ord.length; i++) { if (((ord[i] + 6) % 7) === ((prev + 6) % 7) + 1) prev = ord[i]; else { runs.push([start, prev]); start = prev = ord[i]; } }
  runs.push([start, prev]);
  return runs.map(([a, b]) => a === b ? wrDowLabel(a) : `${wrDowLabel(a)}-${wrDowLabel(b)}`).join(', ');
}
function wrScheduleLabel(l) {
  const dates = []; if (l.durationType === 'hours') dates.push(l.dateFrom); else eachDate(l.dateFrom, l.dateTo, d => dates.push(fmtISO(d)));
  const dayCenters = {}; dates.forEach(ds => { const cs = wrCentersForDate(l.empId, ds); if (cs.length) dayCenters[ds] = cs; });
  const covered = Object.keys(dayCenters);
  if (!covered.length) return wrCenterCodes(l.empId);
  if (covered.length === 1) return '[' + dayCenters[covered[0]].map(getCenterAbbr).join('/') + ']';
  const byCenter = {}; covered.forEach(ds => dayCenters[ds].forEach(c => (byCenter[c] = byCenter[c] || []).push(ds)));
  return '[' + Object.entries(byCenter).sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([cid, ds]) => `${getCenterAbbr(cid)}(${wrCompressDows(ds.map(d => new Date(d + 'T00:00:00').getDay()))})`).join(' ') + ']';
}
function wrEmpLabel(l) { const name = [l.empChinese, l.empName].filter(Boolean).join(' '); const c = wrScheduleLabel(l); return c ? `${name} ${c}` : name; }
function wrDatesText(l) {
  const dowA = getDowAbbr(new Date(l.dateFrom + 'T00:00:00'));
  if (l.durationType === 'hours') { const times = (l.timeFrom && l.timeTo) ? `${l.timeFrom}–${l.timeTo}` : ''; return `${l.dateFrom} (${dowA})${times} · ${l.amount}h`; }
  if (l.dateFrom === l.dateTo) return `${l.dateFrom} (${dowA})`;
  return `${l.dateFrom} (${dowA}) to ${l.dateTo} (${getDowAbbr(new Date(l.dateTo + 'T00:00:00'))})`;
}
function getWeekLeaves(monday) {
  const ws = fmtISO(monday), we = fmtISO(wrAddDays(monday, 6));
  return Object.values(leaves).filter(l => (l.status === 'approved' || l.status === 'pending') && l.dateFrom <= we && l.dateTo >= ws).sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || (a.empName || '').localeCompare(b.empName || ''));
}
function wrTitles(monday) { return { this: t('wrThisWeekTitle', { start: wrFmtShort(monday), end: wrFmtShort(wrAddDays(monday, 6)) }), next: t('wrNextWeekTitle', { start: wrFmtShort(wrAddDays(monday, 7)), end: wrFmtShort(wrAddDays(monday, 13)) }) }; }
function wrSectionText(title, monday) {
  const lines = getWeekLeaves(monday);
  return title + '\n' + (lines.length ? lines.map((l, i) => `${i + 1}. ${wrEmpLabel(l)} ${wrDatesText(l)}${l.status === 'pending' ? ' ' + t('wrPendingTag') : ''}`).join('\n') : t('wrNoLeaves'));
}
function renderWeeklyReports() {
  if (!currentUser?.isMaster) return;
  const monday = wrViewMonday; const titles = wrTitles(monday);
  setText('wrWeekLabel', `${wrFmtShort(monday)} – ${wrFmtShort(wrAddDays(monday, 6))}, ${monday.getFullYear()}`);
  setText('wrThisWeekTitle', titles.this); setText('wrNextWeekTitle', titles.next);
  renderWrList('wrThisWeekList', getWeekLeaves(monday)); renderWrList('wrNextWeekList', getWeekLeaves(wrAddDays(monday, 7)));
}
function renderWrList(elId, list) {
  const el = $(elId); if (!el) return;
  if (!list.length) { el.innerHTML = `<div class="wr-empty">${escapeHtml(t('wrNoLeaves'))}</div>`; return; }
  el.innerHTML = list.map((l, i) => `<div class="wr-line${l.status === 'pending' ? ' pending' : ''}"><span class="wr-num">${i + 1}.</span><span class="wr-text"><strong>${escapeHtml(wrEmpLabel(l))}</strong> · ${escapeHtml(wrDatesText(l))}</span>${l.status === 'pending' ? `<span class="status-badge pending">${escapeHtml(statusLabel('pending'))}</span>` : ''}</div>`).join('');
}
async function copyToClipboard(text, btn) {
  let ok = false;
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) {}
  if (!ok) { try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e) { ok = false; } }
  if (!ok) { notify(t('wrCopyFailed'), { type: 'error' }); return; }
  if (btn) { const orig = btn.textContent; btn.textContent = t('wrCopied'); btn.disabled = true; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); }
}

// ============ EVENTS ============
function wireEvents() {
  document.querySelectorAll('[data-main-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-main-tab]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('[id^="main-tab-"]').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      $(`main-tab-${btn.dataset.mainTab}`)?.classList.add('active');
      if (btn.dataset.mainTab === 'overview') renderOverview();
      if (btn.dataset.mainTab === 'entitlements') renderEntitlementsTab();
      if (btn.dataset.mainTab === 'weeklyreports') renderWeeklyReports();
      if (btn.dataset.mainTab === 'cancelrequests') renderCancelTab();
    });
  });
  $('applyBtn')?.addEventListener('click', openApplyModal);
  $('monthPickerBtn')?.addEventListener('click', e => { e.stopPropagation(); const pop = $('monthPickerPop'); const willOpen = pop.classList.contains('hidden'); pop.classList.toggle('hidden', !willOpen); $('monthPickerBtn').setAttribute('aria-expanded', String(willOpen)); if (willOpen) { pickerYear = currentYear; renderMonthGrid(); } });
  $('mpYearPrev')?.addEventListener('click', e => { e.stopPropagation(); pickerYear--; renderMonthGrid(); });
  $('mpYearNext')?.addEventListener('click', e => { e.stopPropagation(); pickerYear++; renderMonthGrid(); });
  $('mpGrid')?.addEventListener('click', e => { const btn = e.target.closest('button[data-month]'); if (!btn) return; applyMonthPick(parseInt(btn.dataset.month, 10)); });
  $('mpAllBtn')?.addEventListener('click', () => applyMonthPick('all'));
  $('mpCloseBtn')?.addEventListener('click', closeMonthPicker);
  document.addEventListener('click', e => { const wrap = $('monthPicker'); if (wrap && !wrap.contains(e.target)) closeMonthPicker(); });
  document.querySelectorAll('.status-pills .pill').forEach(p => { p.addEventListener('click', () => { document.querySelectorAll('.status-pills .pill').forEach(x => x.classList.remove('active')); p.classList.add('active'); statusFilter = p.dataset.status; renderLeaveTable(); }); });
  $('leaveTable')?.addEventListener('click', e => { const btn = e.target.closest('button[data-action]'); if (!btn) return; const { action, id } = btn.dataset; if (action === 'approve') openApproveModal(id); else if (action === 'reject') rejectLeave(id); else if (action === 'cancel') cancelLeave(id); else if (action === 'view-att') openAttachmentViewer(id); else if (action === 'del-att') deleteAttachment(id); });
  $('prevMonth')?.addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1); renderOverview(); });
  $('nextMonth')?.addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1); renderOverview(); });
  $('todayBtn')?.addEventListener('click', () => { viewDate = new Date(); renderOverview(); });
  $('leaveType')?.addEventListener('change', () => { ensureValidTypeSelection(); updateBalancePanel(); refreshSubmitGuard(); });
  document.querySelectorAll('input[name="durationType"]').forEach(r => r.addEventListener('change', () => { toggleHoursFields(); updateBalancePanel(); }));
  $('dateFrom')?.addEventListener('change', () => {
    const isHours = document.querySelector('input[name="durationType"]:checked')?.value === 'hours';
    const dateTo = $('dateTo'), dateFrom = $('dateFrom'); if (!dateTo || !dateFrom) return;
    if (isHours) dateTo.value = dateFrom.value; else if (!dateTo.value || dateTo.value < dateFrom.value) dateTo.value = dateFrom.value;
    if (selectedLeaveYear() !== lastTypeOptionsYear) populateTypeSelect(); else updateBalancePanel();
  });
  ['dateTo', 'timeFrom', 'timeTo'].forEach(id => $(id)?.addEventListener('change', updateBalancePanel));
  ['timeFrom', 'timeTo'].forEach(id => $(id)?.addEventListener('input', updateBalancePanel));
  $('attachment')?.addEventListener('change', onAttachmentChange);
  $('submitLeaveBtn')?.addEventListener('click', submitLeave);
  $('cancelApplyBtn')?.addEventListener('click', () => closeModal('applyModal'));
  $('closeApplyBtn')?.addEventListener('click', () => closeModal('applyModal'));
  $('closeAttachmentBtn')?.addEventListener('click', () => closeModal('attachmentModal'));
  $('closeEmpScheduleModal')?.addEventListener('click', () => closeModal('empScheduleModal'));
  $('cancelApproveBtn')?.addEventListener('click', () => closeModal('approveModal'));
  $('closeApproveBtn')?.addEventListener('click', () => closeModal('approveModal'));
  $('confirmApproveBtn')?.addEventListener('click', confirmApproval);
  $('downloadAttBtn')?.addEventListener('click', () => { const l = leaves[currentAttLeaveId]; if (!l?.attachment?.dataUrl) return; const a = document.createElement('a'); a.href = l.attachment.dataUrl; a.download = l.attachment.name || 'attachment.jpg'; a.click(); });
  $('deleteAttBtn')?.addEventListener('click', () => deleteAttachment(currentAttLeaveId));
  let entSearchTimer = null;
  $('entEmpSearch')?.addEventListener('input', () => { clearTimeout(entSearchTimer); entSearchTimer = setTimeout(renderEntitlementsTab, 150); });
  $('entYearPrev')?.addEventListener('click', () => { entYear--; setText('entYearLabel', entYear); renderEntitlementsTab(); });
  $('entYearNext')?.addEventListener('click', () => { entYear++; setText('entYearLabel', entYear); renderEntitlementsTab(); });
  $('exportEntitlementsBtn')?.addEventListener('click', exportEntitlements);
  $('entitlementsTable')?.addEventListener('click', e => { const btn = e.target.closest('button[data-action="edit-ent"]'); if (btn) openEditEntitlementModal(btn.dataset.id); });
  $('wrPrev')?.addEventListener('click', () => { wrViewMonday = wrAddDays(wrViewMonday, -7); renderWeeklyReports(); });
  $('wrNext')?.addEventListener('click', () => { wrViewMonday = wrAddDays(wrViewMonday, 7); renderWeeklyReports(); });
  $('wrThisWeekBtn')?.addEventListener('click', () => { wrViewMonday = getMondayOfWeek(new Date()); renderWeeklyReports(); });
  $('wrCopyThis')?.addEventListener('click', e => { const titles = wrTitles(wrViewMonday); copyToClipboard(wrSectionText(titles.this, wrViewMonday), e.currentTarget); });
  $('wrCopyNext')?.addEventListener('click', e => { const titles = wrTitles(wrViewMonday); copyToClipboard(wrSectionText(titles.next, wrAddDays(wrViewMonday, 7)), e.currentTarget); });
  $('wrCopyAll')?.addEventListener('click', e => { const titles = wrTitles(wrViewMonday); copyToClipboard(wrSectionText(titles.this, wrViewMonday) + '\n\n' + wrSectionText(titles.next, wrAddDays(wrViewMonday, 7)), e.currentTarget); });
  $('editEntitlementForm')?.addEventListener('submit', saveEntitlement);
  $('closeEditEntModal')?.addEventListener('click', () => closeModal('editEntitlementModal'));
  $('cancelEditEntBtn')?.addEventListener('click', () => closeModal('editEntitlementModal'));
  $('hidePastYearsToggle')?.addEventListener('change', renderLeaveTable);
  document.addEventListener('click', e => { const m = e.target; if (m && m.classList && m.classList.contains('modal') && m.id && m.id !== 'confirmModal') closeModal(m.id); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const cm = $('confirmModal');
    if (cm && !cm.classList.contains('hidden')) { resolveConfirm(false); return; }
    ['applyModal', 'attachmentModal', 'approveModal', 'editEntitlementModal', 'empScheduleModal', 'extraCreditModal', 'cxRequestModal', 'cxReviewModal'].forEach(closeModal);
    closeMonthPicker();
  });
}
function renderMonthPickerLabel() { setText('monthPickerLabel', monthFilter === 'all' ? t('allMonths', { year: currentYear }) : t('monthOnly', { month: MONTH_NAMES[monthFilter - 1], year: currentYear })); }
function renderMonthGrid() {
  const grid = $('mpGrid'); if (!grid) return;
  setText('mpYearLabel', pickerYear);
  grid.innerHTML = MONTH_NAMES.map((name, i) => `<button type="button" class="mp-month${pickerYear === currentYear && monthFilter === i + 1 ? ' active' : ''}" data-month="${i + 1}">${name.slice(0, 3)}</button>`).join('');
}
function closeMonthPicker() { $('monthPickerPop')?.classList.add('hidden'); $('monthPickerBtn')?.setAttribute('aria-expanded', 'false'); }
function applyMonthPick(monthOrAll) { currentYear = pickerYear; monthFilter = monthOrAll; closeMonthPicker(); renderMonthPickerLabel(); renderLeaveTable(); }

// ============ ONE-TIME HEAL ============
async function healLegacyReliefOverlaps() {
  if (!currentUser?.isAdmin) { notify(L('adminOnly', {}, 'Admin only.'), { type: 'warning' }); return; }
  let fixedShifts = 0, touchedLeaves = 0;
  const approved = Object.entries(leaves).filter(([_, l]) => l.status === 'approved' && l.reliefPlan);
  for (const [leaveId, l] of approved) {
    const plan = Array.isArray(l.reliefPlan) ? l.reliefPlan : Object.values(l.reliefPlan || {});
    let planChanged = false;
    for (const dayPlan of plan) {
      const relievers = Array.isArray(dayPlan?.relievers) ? dayPlan.relievers : Object.values(dayPlan?.relievers || {});
      for (const rel of relievers) {
        if (!rel?.relieverId || !rel?.newShift) continue;
        if (Array.isArray(rel.adjustments)) continue;
        const ns = rel.newShift;
        const sched = await getEmpScheduleForDate(rel.relieverId, dayPlan.date);
        const adjustments = [];
        (sched.shifts || []).forEach(s => {
          if ((s.type || 'work') !== 'work') return;
          if (s.start === ns.start && s.end === ns.end && (s._center || s.center) === ns.center) return;
          const parts = trimShiftAround(s, ns);
          if (parts.length === 1 && parts[0].start === s.start && parts[0].end === s.end) return;
          const center = s._center || s.center || ns.center;
          adjustments.push({ center, before: { type: 'work', start: s.start, end: s.end, center: s.center || center, otherDesc: s.otherDesc || '' }, after: parts.map(p => ({ type: 'work', start: p.start, end: p.end, center: s.center || center, otherDesc: s.otherDesc || '' })) });
        });
        const byCenter = {}; adjustments.forEach(a => { (byCenter[a.center] = byCenter[a.center] || []).push(a); });
        for (const [center, list] of Object.entries(byCenter)) {
          const snap = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`));
          const rec = snap.val() || { status: 'scheduled', shifts: [], notes: '' };
          let arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});
          if (!snap.exists()) { const dow = new Date(dayPlan.date + 'T00:00:00').getDay(); const tmpl = scheduleTemplates[rel.relieverId]?.[dow]; const tShifts = (tmpl && Array.isArray(tmpl.shifts)) ? tmpl.shifts : []; const empCenters = getEmpCenterIds(rel.relieverId); arr = tShifts.map(sh => ({ ...sh, center: sh.center || empCenters[0] || allCenterIds[0] })).filter(sh => sh.center === center); }
          let changed = false;
          list.forEach(a => { if (!arr.some(sh => (sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end)) return; arr = arr.filter(sh => !((sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end)); arr = arr.concat(a.after); changed = true; });
          if (changed) { await update(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`), { status: rec.status || 'scheduled', shifts: arr, notes: rec.notes || '', updatedBy: currentUser.uid, updatedAt: new Date().toISOString() }); fixedShifts++; }
        }
        rel.adjustments = adjustments; planChanged = true;
      }
    }
    if (planChanged) { await update(ref(db, `leaves/${leaveId}`), { reliefPlan: plan }); touchedLeaves++; }
  }
  notify(L('healDone', { shifts: fixedShifts, leaves: touchedLeaves }, 'Done. Fixed {{shifts}} overlapped shift(s) across {{leaves}} old leave record(s).'));
  refreshAll();
}

// ============================================================
// 🎁 EXTRA LEAVE CREDITS — FIFO per-credit ledger
// ============================================================
const EXTRA_EXPIRY_WARN_DAYS = 30;
function getExtraCreditsArray(emp) { const credits = emp?.leaveEntitlement?.extraCredits || {}; return Object.entries(credits).map(([id, c]) => ({ id, ...(c || {}) })); }
function creditDayValue(c) {
  if (c?.days !== undefined && c?.days !== null && c.days !== '') return Number(c.days || 0);
  const amt = Number(c?.amount || 0);
  return c?.unit === 'hours' ? round2(amt / 8) : amt;
}
function isCreditActive(c, refDate = todayStr()) { if (!c || c.revoked) return false; if (c.expiresAt && c.expiresAt < refDate) return false; return true; }
function getExtraLedger(emp, empId) {
  const today = todayStr();
  const credits = getExtraCreditsArray(emp).filter(c => !c.revoked)
    .map(c => ({ ...c, value: round2(creditDayValue(c)), remaining: round2(creditDayValue(c)), used: 0 }))
    .sort((a, b) => (a.expiresAt || '9999-12-31').localeCompare(b.expiresAt || '9999-12-31') || (a.grantedAt || '').localeCompare(b.grantedAt || ''));
  const usages = Object.values(leaves).filter(l => l.empId === empId && l.type === 'extra' && l.status === 'approved')
    .sort((a, b) => (a.dateFrom || '').localeCompare(b.dateFrom || '') || (a.appliedAt || '').localeCompare(b.appliedAt || ''))
    .map(l => round2(Number(l.deductDays || 0)));
  let usedTotal = 0;
  usages.forEach(amt => {
    usedTotal = round2(usedTotal + amt);
    let left = amt;
    for (const c of credits) { if (left <= 0) break; if (c.remaining <= 0) continue; const take = Math.min(c.remaining, left); c.remaining = round2(c.remaining - take); c.used = round2(c.used + take); left = round2(left - take); }
  });
  let entitled = 0, usedActive = 0; const expiringSoon = [];
  credits.forEach(c => {
    c.active = isCreditActive(c, today);
    if (!c.active) return;
    entitled = round2(entitled + c.value); usedActive = round2(usedActive + c.used);
    if (c.expiresAt) { const daysLeft = daysBetweenInclusive(today, c.expiresAt) - 1; if (daysLeft <= EXTRA_EXPIRY_WARN_DAYS && c.remaining > 0) expiringSoon.push({ id: c.id, amount: c.remaining, expiresAt: c.expiresAt, daysLeft }); }
  });
  return { credits, entitled, used: usedActive, usedTotal, balance: Math.max(0, round2(entitled - usedActive)), expiringSoon };
}
function getExtraBalance(emp, empId) { const led = getExtraLedger(emp, empId); return { entitled: led.entitled, used: led.used, balance: led.balance, expiringSoon: led.expiringSoon }; }
function extraReasonLabel(reason) { if (reason === 'sunday') return t('xcReasonSunday'); if (reason === 'noWeekOff') return t('xcReasonNoWeekOff'); return t('xcReasonOther'); }

let xcCurrentEmpId = null;
function injectExtraCreditModal() {
  if ($('extraCreditModal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="modal hidden" id="extraCreditModal"> <div class="modal-content wide"> <span class="close-btn" id="xcCloseBtn">×</span> <h3 id="xcModalTitle"></h3> <div class="modal-subtitle" id="xcEmpName"></div> <div class="xc-summary" id="xcSummary"></div> <h4 class="xc-section-title" id="xcHistoryTitle"></h4> <div class="xc-history" id="xcHistoryList"></div> <div class="xc-grant"> <h4 class="xc-section-title" id="xcGrantTitle"></h4> <div class="form-grid"> <div> <label id="xcAmountLabel" for="xcAmount"></label> <div class="xc-amount-row"> <input type="number" id="xcAmount" min="0.5" step="0.5" value="1" /> <select id="xcUnit"></select> </div> </div> <div> <label id="xcReasonLabel" for="xcReason"></label> <select id="xcReason"></select> </div> <div class="full-width"> <label id="xcNoteLabel" for="xcNote"></label> <input type="text" id="xcNote" /> </div> <div class="full-width"> <label id="xcExpiryLabel"></label> <div class="radio-group"> <label><input type="radio" name="xcExpiry" value="none" checked /><span id="xcExpNoneTxt"></span></label> <label><input type="radio" name="xcExpiry" value="set" /><span id="xcExpSetTxt"></span></label> </div> <input type="date" id="xcExpiryDate" class="hidden" /> </div> </div> <div class="modal-actions"> <button class="secondary" id="xcCancelBtn" type="button"></button> <button class="primary" id="xcGrantBtn" type="button"></button> </div> </div> </div>`;
  document.body.appendChild(wrap.firstElementChild);
  $('xcCloseBtn').addEventListener('click', () => closeModal('extraCreditModal'));
  $('xcCancelBtn').addEventListener('click', () => closeModal('extraCreditModal'));
  $('xcGrantBtn').addEventListener('click', grantExtraCredit);
  document.querySelectorAll('input[name="xcExpiry"]').forEach(r => r.addEventListener('change', () => { $('xcExpiryDate')?.classList.toggle('hidden', (document.querySelector('input[name="xcExpiry"]:checked')?.value || 'none') !== 'set'); }));
  $('xcHistoryList').addEventListener('click', e => { const btn = e.target.closest('button[data-xc-revoke]'); if (btn && xcCurrentEmpId) revokeExtraCredit(xcCurrentEmpId, btn.dataset.xcRevoke); });
  $('entitlementsTable')?.addEventListener('click', e => { const btn = e.target.closest('button[data-action="manage-credits"]'); if (btn) openExtraCreditModal(btn.dataset.id); });
}
function xcApplyI18n() {
  setText('xcModalTitle', t('xcModalTitle')); setText('xcHistoryTitle', t('xcHistoryTitle')); setText('xcGrantTitle', t('xcGrantTitle'));
  setText('xcAmountLabel', t('xcAmountLabel')); setText('xcReasonLabel', t('xcReasonLabel')); setText('xcNoteLabel', t('xcNoteLabel'));
  setText('xcExpiryLabel', t('xcExpiryLabel')); setText('xcExpNoneTxt', t('xcExpNone')); setText('xcExpSetTxt', t('xcExpSet'));
  setText('xcCancelBtn', t('cancel')); setText('xcGrantBtn', t('xcGrantBtn'));
  const unit = $('xcUnit'); if (unit) unit.innerHTML = `<option value="days">${escapeHtml(t('dayUnit'))}</option><option value="hours">${escapeHtml(t('hrUnit'))}</option>`;
  const reason = $('xcReason'); if (reason) reason.innerHTML = `<option value="sunday">${escapeHtml(t('xcReasonSunday'))}</option><option value="noWeekOff">${escapeHtml(t('xcReasonNoWeekOff'))}</option><option value="other">${escapeHtml(t('xcReasonOther'))}</option>`;
}
function openExtraCreditModal(empId) {
  const emp = employees[empId]; if (!emp) return;
  xcCurrentEmpId = empId; xcApplyI18n();
  setText('xcEmpName', `${emp.englishName || ''}${emp.chineseName ? ' (' + emp.chineseName + ')' : ''}`.trim());
  $('xcAmount').value = 1; $('xcUnit').value = 'days'; $('xcReason').value = 'sunday'; $('xcNote').value = '';
  const noneRadio = document.querySelector('input[name="xcExpiry"][value="none"]'); if (noneRadio) noneRadio.checked = true;
  const dateInput = $('xcExpiryDate'); if (dateInput) { dateInput.value = ''; dateInput.min = todayStr(); dateInput.classList.add('hidden'); }
  renderXcSummary(); renderXcHistory(); openModal('extraCreditModal');
}
function renderXcSummary() {
  const box = $('xcSummary'); if (!box || !xcCurrentEmpId) return;
  const b = getExtraBalance(employees[xcCurrentEmpId], xcCurrentEmpId);
  box.innerHTML = `<div class="xc-stat"><label>${escapeHtml(t('extraEntitledLabel'))}</label><span>${b.entitled}</span></div> <div class="xc-stat"><label>${escapeHtml(L('extraUsedLabel', {}, 'Used'))}</label><span>${b.used}</span></div> <div class="xc-stat"><label>${escapeHtml(t('balance'))}</label><span class="xc-bal">${b.balance}</span></div>`;
}
function renderXcHistory() {
  const list = $('xcHistoryList'); if (!list || !xcCurrentEmpId) return;
  const led = getExtraLedger(employees[xcCurrentEmpId], xcCurrentEmpId);
  const revoked = getExtraCreditsArray(employees[xcCurrentEmpId]).filter(c => c.revoked).map(c => ({ ...c, value: round2(creditDayValue(c)), remaining: 0, used: 0, active: false }));
  const credits = [...led.credits, ...revoked];
  if (!credits.length) { list.innerHTML = `<div class="xc-empty">${escapeHtml(t('xcNoCredits'))}</div>`; return; }
  const today = todayStr();
  const statusOf = c => c.revoked ? 'revoked' : (c.expiresAt && c.expiresAt < today ? 'expired' : 'active');
  credits.sort((a, b) => { const sa = statusOf(a) === 'active' ? 0 : 1, sb = statusOf(b) === 'active' ? 0 : 1; if (sa !== sb) return sa - sb; if (sa === 0) return (a.expiresAt || '9999').localeCompare(b.expiresAt || '9999'); return (b.grantedAt || '').localeCompare(a.grantedAt || ''); });
  list.innerHTML = credits.map(c => {
    const st = statusOf(c);
    const unitTxt = c.unit === 'hours' ? t('hrUnit') : t('dayUnit');
    let chip;
    if (st === 'revoked') chip = `<span class="xc-chip revoked">${escapeHtml(t('xcStatusRevoked'))}</span>`;
    else if (st === 'expired') chip = `<span class="xc-chip expired">${escapeHtml(t('xcStatusExpired'))}</span>`;
    else if (c.expiresAt) { const daysLeft = daysBetweenInclusive(today, c.expiresAt) - 1; chip = daysLeft <= EXTRA_EXPIRY_WARN_DAYS ? `<span class="xc-chip soon">⚠️ ${escapeHtml(t('xcExpiresIn', { days: daysLeft }))}</span>` : `<span class="xc-chip active">${escapeHtml(t('xcStatusActive'))}</span>`; }
    else chip = `<span class="xc-chip active">${escapeHtml(t('xcStatusActive'))}</span>`;
    const grantedDate = c.grantedAt ? new Date(c.grantedAt).toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '-';
    const expiryTxt = c.expiresAt ? t('xcExpires', { date: fmtDate(c.expiresAt) }) : t('xcExpNone');
    const revokedTxt = (c.revoked && c.revokedByName) ? ` · ${escapeHtml(t('xcRevokedBy', { date: c.revokedAt ? new Date(c.revokedAt).toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric', year: 'numeric' }) : '-', name: c.revokedByName }))}` : '';
    const revokeBtn = st === 'active' ? `<button class="icon-btn danger-ico" data-xc-revoke="${escapeHtml(c.id)}" type="button" title="${escapeHtml(t('xcRevokeBtn'))}">🗑</button>` : '';
    const pct = c.value > 0 ? Math.max(0, Math.min(100, (c.remaining / c.value) * 100)) : 0;
    const remainingTxt = st === 'active' ? `<div class="xc-credit-meta"><span>${escapeHtml(L('xcRemaining', {}, 'Remaining'))}: <strong>${c.remaining}</strong> / ${c.value} ${escapeHtml(unitTxt)}</span><span class="xc-credit-bar"><span style="width:${pct}%"></span></span></div>` : '';
    return `<div class="xc-item ${st}"><div class="xc-item-main"><strong>+${escapeHtml(String(c.amount))} ${escapeHtml(unitTxt)} · ${escapeHtml(extraReasonLabel(c.reason))}</strong>${c.note ? `<small>📝 ${escapeHtml(c.note)}</small>` : ''}<small>${escapeHtml(t('xcGrantedBy', { date: grantedDate, name: c.grantedByName || '-' }))} · ${escapeHtml(expiryTxt)}${revokedTxt}</small>${remainingTxt}</div>${chip}${revokeBtn}</div>`;
  }).join('');
}
async function grantExtraCredit() {
  const empId = xcCurrentEmpId; if (!empId) return;
  const amount = parseFloat($('xcAmount').value);
  if (!amount || amount <= 0) return notify(t('xcAmountAlert'), { type: 'warning' });
  const unit = $('xcUnit').value, reason = $('xcReason').value, note = $('xcNote').value.trim();
  if (reason === 'other' && !note) return notify(t('xcNoteRequiredAlert'), { type: 'warning' });
  const expiryMode = document.querySelector('input[name="xcExpiry"]:checked')?.value || 'none';
  let expiresAt = null;
  if (expiryMode === 'set') { expiresAt = $('xcExpiryDate').value; if (!expiresAt) return notify(t('xcExpiryDateAlert'), { type: 'warning' }); if (expiresAt < todayStr()) return notify(t('xcExpiryPastAlert'), { type: 'warning' }); }
  const btn = $('xcGrantBtn'); btn.disabled = true;
  try {
    await push(ref(db, `employees/${empId}/leaveEntitlement/extraCredits`), { amount: round2(amount), unit, days: unit === 'hours' ? round2(amount / 8) : round2(amount), reason, note, expiresAt, grantedAt: new Date().toISOString(), grantedBy: currentUser.uid, grantedByName: cxCurrentUserName() });
    $('xcNote').value = '';
    notify(t('xcGranted'));
    renderXcSummary(); renderXcHistory(); renderEntitlementsTab(); renderBalanceStrip();
    if ($('applyModal') && !$('applyModal').classList.contains('hidden')) populateTypeSelect();
  } catch (err) { console.error(err); notify(t('xcGrantFailed'), { type: 'error' }); }
  finally { btn.disabled = false; }
}
async function revokeExtraCredit(empId, creditId) {
  const ok = await askConfirm({ title: L('xcRevokeTitle', {}, 'Revoke this credit?'), message: t('xcRevokeConfirm'), confirmText: t('xcRevokeBtn'), danger: true });
  if (!ok) return;
  try {
    await update(ref(db, `employees/${empId}/leaveEntitlement/extraCredits/${creditId}`), { revoked: true, revokedAt: new Date().toISOString(), revokedBy: currentUser.uid, revokedByName: cxCurrentUserName() });
    notify(t('xcRevoked'));
    renderXcSummary(); renderXcHistory(); renderEntitlementsTab(); renderBalanceStrip();
    if ($('applyModal') && !$('applyModal').classList.contains('hidden')) populateTypeSelect();
  } catch (err) { console.error(err); notify(t('xcRevokeFailed'), { type: 'error' }); }
}
function injectExtraLegend() {
  const legend = document.querySelector('.legend');
  if (!legend || legend.querySelector('.lv-extra-legend')) return;
  const item = document.createElement('span'); item.className = 'legend-item lv-extra-legend';
  item.innerHTML = `<span class="chip lv lv-extra approved"></span>${escapeHtml(t('typeExtra'))}`;
  legend.appendChild(item);
}
injectExtraCreditModal();
injectExtraLegend();

// ============================================================
// 🚫 CANCEL REQUEST TAB
// ============================================================
let cxCurrentLeaveId = null, cxReviewLeaveId = null;
function cxT(key, vars = {}, fallback = key) { return L(`cx_${key}`, vars, fallback); }
function cxCurrentUserName() { if (currentUser?.empId && employees[currentUser.empId]?.englishName) return employees[currentUser.empId].englishName; return currentUser?.email || 'Admin'; }
function cxGetWorkingDays(l) {
  if (!l?.dateFrom) return [];
  if (l.durationType === 'hours') return [l.dateFrom];
  const skipped = new Set((l.restDaysExcluded || '').split(',').map(s => s.trim()).filter(Boolean));
  const days = []; eachDate(l.dateFrom, l.dateTo, d => { const ds = fmtISO(d); if (!skipped.has(ds)) days.push(ds); });
  return days;
}
function cxReliefPlanArray(l) { return l?.reliefPlan ? (Array.isArray(l.reliefPlan) ? l.reliefPlan : Object.values(l.reliefPlan)) : []; }
function cxReliefPlanByDate(l) {
  const map = {};
  cxReliefPlanArray(l).forEach(dp => {
    if (!dp?.date) return;
    const shifts = Array.isArray(dp.empAOrigSchedule?.shifts) ? dp.empAOrigSchedule.shifts : Object.values(dp.empAOrigSchedule?.shifts || {});
    if (!shifts.length) return;
    map[dp.date] = shifts.filter(s => (s.type || 'work') === 'work').map(s => `${getCenterAbbr(s._center || s.center)} ${s.start}–${s.end}`).join(', ');
  });
  return map;
}
function cxAffectedRelievers(l, dates) {
  const set = new Set(dates); const names = new Set();
  cxReliefPlanArray(l).forEach(dp => {
    if (!set.has(dp?.date)) return;
    const rels = Array.isArray(dp.relievers) ? dp.relievers : Object.values(dp.relievers || {});
    rels.forEach(r => { if (r?.relieverName) names.add(r.relieverName); else if (r?.relieverId && employees[r.relieverId]?.englishName) names.add(employees[r.relieverId].englishName); });
  });
  return [...names];
}
function cxLeaveHasFuture(l) { return (l.dateTo || l.dateFrom) >= todayStr(); }
function cxScopeText(l, req) { const total = cxGetWorkingDays(l).length; if (req.scope === 'full' || (req.dates || []).length >= total) return cxT('fullScopeShort', {}, 'ENTIRE leave'); return cxT('partialScopeShort', { n: (req.dates || []).length, total }, '{{n}} of {{total}} day(s)'); }
function renderCancelTab() {
  if (!currentUser) return;
  const admin = currentUser.isAdmin;
  const queueWrap = $('cxAdminQueueWrap');
  if (admin) { queueWrap?.classList.remove('hidden'); renderCxQueue(); } else queueWrap?.classList.add('hidden');
  const myWrap = $('cxMyLeavesWrap');
  if (!currentUser.isMaster && currentUser.empId && employees[currentUser.empId]) { myWrap?.classList.remove('hidden'); renderCxMyLeaves(); } else myWrap?.classList.add('hidden');
  renderCxHistory(admin); renderCxTabBadge();
}
function cxMaybeRender() { if (!currentUser) return; if ($('main-tab-cancelrequests')?.classList.contains('active')) renderCancelTab(); else renderCxTabBadge(); }
function renderCxTabBadge() {
  if (!currentUser) return;
  const btn = document.querySelector('[data-main-tab="cancelrequests"]'); if (!btn) return;
  const count = Object.values(leaves).filter(l => l.status === 'approved' && l.cancellationRequest?.status === 'pending' && (currentUser.isAdmin || l.empId === currentUser.empId)).length;
  let badge = btn.querySelector('.cx-badge');
  if (!count) { badge?.remove(); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'cx-badge'; btn.appendChild(badge); }
  badge.textContent = count;
}
function renderCxQueue() {
  const el = $('cxAdminQueue'); if (!el) return;
  const pending = Object.entries(leaves).map(([id, l]) => ({ id, ...l })).filter(l => l.status === 'approved' && l.cancellationRequest?.status === 'pending').sort((a, b) => (a.cancellationRequest.requestedAt || '').localeCompare(b.cancellationRequest.requestedAt || ''));
  setText('cxQueueTitle', `${cxT('queueTitle', {}, '⏳ Pending cancellation requests')} (${pending.length})`);
  if (!pending.length) { el.innerHTML = `<div class="cx-empty">${escapeHtml(cxT('noPending', {}, 'No pending cancellation requests. 🎉'))}</div>`; return; }
  el.innerHTML = pending.map(l => {
    const req = l.cancellationRequest; const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const relievers = cxAffectedRelievers(l, req.dates);
    return `<div class="cx-card pending"> <div class="cx-card-main"> <div class="cx-card-title"><span class="type-dot lv ${meta.cls} approved"></span><strong>${escapeHtml(l.empName || '-')}</strong> · ${escapeHtml(meta.label)}</div> <div class="cx-card-sub">${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}</div> <div class="cx-card-sub">🚫 <strong>${escapeHtml(cxScopeText(l, req))}</strong>${req.scope !== 'full' ? ': ' + (req.dates || []).map(fmtDateShort).join(', ') : ''}</div> <div class="cx-card-reason">💬 ${escapeHtml(req.reason || '')}</div> <div class="cx-card-meta">${escapeHtml(cxT('requestedBy', {}, 'Requested by'))} ${escapeHtml(req.requestedByName || '-')} · ${req.requestedAt ? new Date(req.requestedAt).toLocaleString() : ''}${relievers.length ? '<br>👥 ' + escapeHtml(cxT('relieversAffected', { names: relievers.join(', ') }, 'Reliever(s) affected: {{names}}')) : ''}</div> </div> <div class="cx-card-actions"><button class="primary" data-cx="review" data-id="${escapeHtml(l.id)}" type="button">👁 ${escapeHtml(cxT('review', {}, 'Review'))}</button></div> </div>`;
  }).join('');
}
function renderCxMyLeaves() {
  const el = $('cxMyLeaves'); if (!el) return;
  const mine = Object.entries(leaves).map(([id, l]) => ({ id, ...l })).filter(l => l.empId === currentUser.empId && l.status === 'approved' && cxLeaveHasFuture(l)).sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
  setText('cxMyTitle', cxT('myTitle', {}, '🗓️ My approved leaves'));
  if (!mine.length) { el.innerHTML = `<div class="cx-empty">${escapeHtml(cxT('noApproved', {}, 'No approved leaves available for cancellation.'))}</div>`; return; }
  el.innerHTML = mine.map(l => {
    const req = l.cancellationRequest; const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const pending = req?.status === 'pending';
    const cancellable = cxGetWorkingDays(l).filter(ds => ds >= todayStr());
    const timeNote = l.durationType === 'hours' && l.timeFrom && l.timeTo ? `(${l.timeFrom}–${l.timeTo})` : '';
    let action;
    if (pending) action = `<span class="cx-chip pending">⏳ ${escapeHtml(cxT('reqPending', {}, 'Cancellation pending'))} · ${escapeHtml(cxScopeText(l, req))}</span> <button class="secondary" data-cx="withdraw" data-id="${escapeHtml(l.id)}" type="button">${escapeHtml(cxT('withdraw', {}, 'Withdraw'))}</button>`;
    else if (!cancellable.length) action = `<span class="cx-chip muted">${escapeHtml(cxT('allPast', {}, 'All dates passed'))}</span>`;
    else action = `<button class="danger" data-cx="request" data-id="${escapeHtml(l.id)}" type="button">🚫 ${escapeHtml(cxT('requestBtn', {}, 'Request cancellation'))}</button>`;
    return `<div class="cx-card"> <div class="cx-card-main"> <div class="cx-card-title"><span class="type-dot lv ${meta.cls} approved"></span><strong>${escapeHtml(meta.label)}</strong></div> <div class="cx-card-sub">${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}${timeNote}${l.restDaysExcluded ? ' <small>' + escapeHtml(t('restExcluded')) + '</small>' : ''}</div> </div> <div class="cx-card-actions">${action}</div> </div>`;
  }).join('');
}
function renderCxHistory(admin) {
  const el = $('cxHistory'), wrap = $('cxHistoryWrap'); if (!el || !wrap) return;
  setText('cxHistoryTitle', cxT('historyTitle', {}, '🕓 Request history'));
  const items = Object.entries(leaves).map(([id, l]) => ({ id, ...l })).filter(l => l.cancellationRequest && ['approved', 'rejected', 'withdrawn'].includes(l.cancellationRequest.status)).filter(l => admin || l.empId === currentUser.empId)
    .sort((a, b) => (b.cancellationRequest.reviewedAt || b.cancellationRequest.withdrawnAt || '').localeCompare(a.cancellationRequest.reviewedAt || a.cancellationRequest.withdrawnAt || ''));
  if (!items.length) { wrap.classList.add('hidden'); el.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  el.innerHTML = items.slice(0, 30).map(l => {
    const req = l.cancellationRequest; const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const when = req.reviewedAt || req.withdrawnAt;
    const chipTxt = { approved: cxT('hApproved', {}, '✅ Cancelled'), rejected: cxT('hRejected', {}, '❌ Rejected'), withdrawn: cxT('hWithdrawn', {}, '↩️ Withdrawn') }[req.status] || req.status;
    return `<div class="cx-card h-${req.status}"> <div class="cx-card-main"> <div class="cx-card-title"><span class="type-dot lv ${meta.cls}"></span><strong>${escapeHtml(l.empName || '-')}</strong> · ${escapeHtml(meta.label)} · ${fmtDateShort(l.dateFrom)} → ${fmtDateShort(l.dateTo)}</div> <div class="cx-card-sub">🚫 ${escapeHtml(cxScopeText(l, req))} · 💬 ${escapeHtml(req.reason || '')}</div> <div class="cx-card-meta">${when ? new Date(when).toLocaleString() : ''}${req.reviewNote ? ' · 📝 ' + escapeHtml(req.reviewNote) : ''}${req.reviewedByName ? ' · ' + escapeHtml(req.reviewedByName) : ''}</div> </div> <div class="cx-card-actions"><span class="cx-chip ${req.status}">${escapeHtml(chipTxt)}</span></div> </div>`;
  }).join('');
}
async function openCxRequestModal(leaveId) {
  const l = leaves[leaveId]; if (!l || l.status !== 'approved') return;
  if (l.cancellationRequest?.status === 'pending') return notify(cxT('alreadyPending', {}, '⚠️ A cancellation request is already pending for this leave.'), { type: 'warning' });
  const futureDays = cxGetWorkingDays(l).filter(ds => ds >= todayStr());
  if (!futureDays.length) return notify(cxT('allPast', {}, 'All dates passed'), { type: 'warning' });
  cxCurrentLeaveId = leaveId;
  const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
  const timeNote = l.durationType === 'hours' && l.timeFrom && l.timeTo ? `(${l.timeFrom}–${l.timeTo})` : '';
  $('cxRequestSummary').innerHTML = `<span class="type-dot lv ${meta.cls} approved"></span><strong>${escapeHtml(meta.label)}</strong><br>${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}${timeNote}<br><em>${escapeHtml(l.reason || '')}</em>`;
  $('cxReason').value = '';
  renderCxDaysList(l); openModal('cxRequestModal'); cxUpdateDayUI();
}
function renderCxDaysList(l) {
  const wrap = $('cxDaysWrap'), list = $('cxDaysList');
  const allDays = cxGetWorkingDays(l);
  if (allDays.length <= 1) { wrap.classList.add('hidden'); list.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  const tStr = todayStr(); const plan = cxReliefPlanByDate(l);
  list.innerHTML = allDays.map(ds => { const past = ds < tStr; return `<label class="cx-day-row${past ? ' past' : ''}"> <input type="checkbox" class="cx-day-cb" value="${ds}" ${past ? 'disabled' : ''}> <span class="cx-day-date">${fmtDateWithDow(ds)}</span> ${plan[ds] ? `<span class="cx-day-shift">${escapeHtml(plan[ds])}</span>` : ''} ${past ? `<span class="cx-day-past">${escapeHtml(cxT('pastDay', {}, 'past'))}</span>` : ''} </label>`; }).join('');
  list.querySelectorAll('.cx-day-cb').forEach(cb => cb.addEventListener('change', cxUpdateDayUI));
}
function cxUpdateDayUI() {
  const l = leaves[cxCurrentLeaveId]; if (!l) return;
  const allDays = cxGetWorkingDays(l); const isSingle = allDays.length <= 1;
  const cbs = [...document.querySelectorAll('#cxDaysList .cx-day-cb')];
  const enabled = cbs.filter(c => !c.disabled); const selected = cbs.filter(c => c.checked);
  const selDates = isSingle ? allDays.filter(ds => ds >= todayStr()) : selected.map(c => c.value);
  const countEl = $('cxDayCount'); if (countEl) countEl.textContent = isSingle ? '' : cxT('selectedCount', { n: selected.length, total: enabled.length }, '{{n}} of {{total}} selectable day(s)');
  const sa = $('cxSelectAllDays'); if (sa) sa.checked = enabled.length > 0 && enabled.every(c => c.checked);
  renderCxImpact(l, selDates);
  const btn = $('cxSubmitRequestBtn'); if (btn) btn.disabled = !selDates.length;
}
function renderCxImpact(l, selDates) {
  const box = $('cxImpact'); if (!box) return;
  if (!l || !selDates.length) { box.innerHTML = ''; return; }
  const total = cxGetWorkingDays(l).length; const full = selDates.length === total;
  const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type };
  let refundText;
  if (l.type === 'unpaid') refundText = cxT('noBalanceUnpaid', {}, 'Unpaid leave — no balance will be restored.');
  else { const amt = l.durationType === 'hours' ? `${l.amount} ${cxT('hrs', {}, 'hr(s)')}` : `${selDates.length} ${cxT('daysUnit', {}, 'day(s)')}`; refundText = cxT('willRestore', { amt, label: meta.label }, '{{amt}} of {{label}} will be restored to the balance.'); }
  const relievers = cxAffectedRelievers(l, selDates);
  box.innerHTML = `<strong>${full ? escapeHtml(cxT('fullScope', {}, 'FULL cancellation')) : escapeHtml(cxT('partialScope', {}, 'PARTIAL cancellation'))}</strong> · ${escapeHtml(refundText)}${relievers.length ? '<br>👥 ' + escapeHtml(cxT('relieversAffected', { names: relievers.join(', ') }, 'Reliever(s) affected: {{names}}')) : ''}<br><span class="cx-impact-note">${escapeHtml(cxT('impactNote', {}, 'The request will be sent to your manager for approval. Schedules and balances revert only after approval.'))}</span>`;
}
async function submitCxRequest() {
  const l = leaves[cxCurrentLeaveId];
  if (!l || l.status !== 'approved') return notify(cxT('missingRecord', {}, '❌ Missing leave record. Please close and reopen.'), { type: 'error' });
  if (l.cancellationRequest?.status === 'pending') return notify(cxT('alreadyPending', {}, '⚠️ A cancellation request is already pending.'), { type: 'warning' });
  const reason = $('cxReason').value.trim();
  if (!reason) return notify(cxT('reasonReq', {}, '⚠️ A reason is required to cancel a leave.'), { type: 'warning' });
  const allDays = cxGetWorkingDays(l); const multi = allDays.length > 1;
  const selDates = multi ? [...document.querySelectorAll('#cxDaysList .cx-day-cb:checked')].map(c => c.value) : allDays.filter(ds => ds >= todayStr());
  if (!selDates.length) return notify(cxT('pickDay', {}, '⚠️ Please select at least one day to cancel.'), { type: 'warning' });
  const scope = selDates.length === allDays.length ? 'full' : 'partial';
  const btn = $('cxSubmitRequestBtn'); btn.disabled = true; btn.textContent = cxT('submitting', {}, 'Submitting...');
  try {
    const req = { status: 'pending', scope, dates: selDates.sort(), reason, requestedBy: currentUser.uid, requestedByName: cxCurrentUserName(), requestedAt: new Date().toISOString() };
    await update(ref(db, `leaves/${cxCurrentLeaveId}/cancellationRequest`), req);
    cxNotify(l, req, 'new'); closeModal('cxRequestModal');
    notify(cxT('submitted', {}, '✅ Cancellation request submitted. A manager will review it.'));
  } catch (err) { console.error(err); notify(cxT('submitFailed', { message: err.message }, '❌ Failed to submit request: {{message}}'), { type: 'error' }); }
  finally { btn.disabled = false; btn.textContent = cxT('submitBtn', {}, 'Submit request'); }
}
async function cxWithdraw(leaveId) {
  const l = leaves[leaveId]; if (!l || l.cancellationRequest?.status !== 'pending') return;
  const ok = await askConfirm({ title: cxT('withdraw', {}, 'Withdraw'), message: cxT('withdrawConfirm', {}, 'Withdraw your cancellation request?'), confirmText: cxT('withdraw', {}, 'Withdraw'), danger: true });
  if (!ok) return;
  try { const patch = { status: 'withdrawn', withdrawnBy: currentUser.uid, withdrawnAt: new Date().toISOString() }; await update(ref(db, `leaves/${leaveId}/cancellationRequest`), patch); cxNotify(l, { ...l.cancellationRequest, ...patch }, 'withdrawn'); }
  catch (e) { console.error(e); notify(cxT('withdrawFailed', {}, '❌ Failed to withdraw the request.'), { type: 'error' }); }
}
function openCxReviewModal(leaveId) {
  const l = leaves[leaveId]; const req = l?.cancellationRequest;
  if (!l || !req || req.status !== 'pending') return;
  cxReviewLeaveId = leaveId;
  const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type };
  const working = cxGetWorkingDays(l); const plan = cxReliefPlanByDate(l);
  const rows = (req.dates || []).map(ds => `<div class="cx-day-row static"><span class="cx-day-date">${fmtDateWithDow(ds)}</span>${plan[ds] ? `<span class="cx-day-shift">${escapeHtml(plan[ds])}</span>` : ''}</div>`).join('');
  const refund = l.type === 'unpaid' ? cxT('noBalanceUnpaid', {}, 'Unpaid leave — no balance restored.') : cxT('willRestore', { amt: l.durationType === 'hours' ? `${l.amount} ${cxT('hrs', {}, 'hr(s)')}` : `${req.dates.length} ${cxT('daysUnit', {}, 'day(s)')}`, label: meta.label }, '{{amt}} of {{label}} will be restored.');
  const relievers = cxAffectedRelievers(l, req.dates);
  $('cxReviewBody').innerHTML = `<div class="cx-review-grid"> <div><label>${escapeHtml(t('thEmployee'))}</label><strong>${escapeHtml(l.empName || '-')}</strong></div> <div><label>${escapeHtml(t('thLeaveType'))}</label><strong>${escapeHtml(meta.label)}</strong></div> <div><label>${escapeHtml(t('thFrom'))} → ${escapeHtml(t('thTo'))}</label>${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}</div> <div><label>${escapeHtml(cxT('requestedBy', {}, 'Requested by'))}</label>${escapeHtml(req.requestedByName || '-')} · ${req.requestedAt ? new Date(req.requestedAt).toLocaleString() : ''}</div> <div class="full"><label>${escapeHtml(t('thReason'))}</label>${escapeHtml(req.reason || '')}</div> </div> <div class="cx-impact"><strong>${req.scope === 'full' ? escapeHtml(cxT('fullScope', {}, 'FULL cancellation')) : escapeHtml(cxT('partialScope', {}, 'PARTIAL cancellation'))}</strong> — ${escapeHtml(cxScopeText(l, req))} (${(req.dates || []).length} of ${working.length})<br>${escapeHtml(refund)}${relievers.length ? '<br>👥 ' + escapeHtml(cxT('relieversAffected', { names: relievers.join(', ') }, 'Reliever(s) affected: {{names}}')) : ''}</div> <div class="cx-days-list" style="margin-top:0.75rem;">${rows}</div>`;
  $('cxReviewNote').value = '';
  $('cxApproveBtn').disabled = false; $('cxRejectBtn').disabled = false;
  $('cxApproveBtn').textContent = cxT('approveBtn', {}, '✅ Approve & cancel leave');
  openModal('cxReviewModal');
}
async function cxApprove() {
  const id = cxReviewLeaveId; const l = leaves[id]; const req = l?.cancellationRequest;
  if (!l || !req || req.status !== 'pending') return;
  const btn = $('cxApproveBtn'); btn.disabled = true; btn.textContent = cxT('processing', {}, 'Processing...');
  try {
    const working = cxGetWorkingDays(l);
    const cancelDates = (req.dates || []).filter(ds => working.includes(ds));
    const full = req.scope === 'full' || cancelDates.length >= working.length || !cancelDates.length;
    if (full) await cxExecuteFullCancellation(id, l, req); else await cxExecutePartialCancellation(id, l, req, cancelDates);
    closeModal('cxReviewModal');
    notify(cxT('cancelDone', {}, '✅ Cancellation approved — leave, schedules and balances updated.'));
  } catch (err) { console.error(err); notify(cxT('cancelFailed', { message: err.message }, '❌ Failed to process cancellation: {{message}}'), { type: 'error' }); }
  finally { btn.disabled = false; btn.textContent = cxT('approveBtn', {}, '✅ Approve & cancel leave'); }
}
async function cxReject() {
  const id = cxReviewLeaveId; const l = leaves[id]; const req = l?.cancellationRequest;
  if (!l || !req || req.status !== 'pending') return;
  const ok = await askConfirm({ title: cxT('hRejected', {}, 'Reject request'), message: cxT('rejectConfirm', {}, 'Reject this cancellation request? The leave stays approved.'), confirmText: cxT('hRejected', {}, 'Reject'), danger: true });
  if (!ok) return;
  const btn = $('cxRejectBtn'); btn.disabled = true;
  try { const patch = { status: 'rejected', reviewedBy: currentUser.uid, reviewedByName: cxCurrentUserName(), reviewedAt: new Date().toISOString(), reviewNote: $('cxReviewNote').value.trim() || '' }; await update(ref(db, `leaves/${id}/cancellationRequest`), patch); cxNotify(l, { ...req, ...patch }, 'rejected'); closeModal('cxReviewModal'); }
  catch (e) { console.error(e); notify(cxT('rejectFailed', {}, '❌ Failed to reject the request.'), { type: 'error' }); }
  finally { btn.disabled = false; }
}
function cxReviewPatch(req, extra = {}) { return { ...req, status: 'approved', reviewedBy: currentUser.uid, reviewedByName: cxCurrentUserName(), reviewedAt: new Date().toISOString(), reviewNote: $('cxReviewNote')?.value.trim() || '', ...extra }; }
async function cxExecuteFullCancellation(id, l, req) {
  let warn = false;
  try { await restoreSchedulesForLeave(l); } catch (e) { console.error('Schedule restore failed:', e); warn = true; }
  const newReq = cxReviewPatch(req);
  leaves[id] = { ...l, status: 'cancelled' };
  await update(ref(db, `leaves/${id}`), { status: 'cancelled', cancelledBy: currentUser.uid, cancelledAt: new Date().toISOString(), cancellationRequest: newReq });
  try { await recalcEntitlementUsed(l.empId); } catch (e) { console.warn('entitlement recalc failed:', e); }
  cxNotify({ ...l, status: 'cancelled' }, newReq, 'approved');
  if (warn) notify(cxT('restoreWarn', {}, '⚠️ Approved, but some schedule days could not be reverted. Check console.'), { type: 'warning' });
}
async function cxExecutePartialCancellation(id, l, req, cancelDates) {
  const cancelSet = new Set(cancelDates);
  await cxRestoreSchedulesForDates(l, cancelDates);
  const working = cxGetWorkingDays(l);
  const remainSet = new Set(working.filter(ds => !cancelSet.has(ds)));
  const segments = []; let cur = null;
  eachDate(l.dateFrom, l.dateTo, d => { const ds = fmtISO(d); if (cancelSet.has(ds)) { if (cur) { segments.push(cur); cur = null; } return; } if (!cur) cur = { cal: [], work: [] }; cur.cal.push(ds); if (remainSet.has(ds)) cur.work.push(ds); });
  if (cur) segments.push(cur);
  const nonEmpty = segments.filter(s => s.work.length);
  if (!nonEmpty.length) return cxExecuteFullCancellation(id, l, req);
  const planByDate = {}; cxReliefPlanArray(l).forEach(dp => { if (dp?.date) planByDate[dp.date] = dp; });
  const mkPayload = seg => {
    const dateFrom = seg.work[0], dateTo = seg.work[seg.work.length - 1];
    const skipped = seg.cal.filter(ds => !remainSet.has(ds));
    const daysPerYear = {}; seg.work.forEach(ds => { const y = parseInt(ds.slice(0, 4), 10); daysPerYear[y] = (daysPerYear[y] || 0) + 1; });
    return { dateFrom, dateTo, amount: seg.work.length, deductDays: seg.work.length, restDaysExcluded: skipped.join(', '), daysPerYear, year: parseInt(dateFrom.slice(0, 4), 10), reliefPlan: seg.work.map(ds => planByDate[ds]).filter(Boolean) };
  };
  const newReq = cxReviewPatch(req);
  await update(ref(db, `leaves/${id}`), { ...mkPayload(nonEmpty[0]), cancellationRequest: newReq });
  for (let i = 1; i < nonEmpty.length; i++) {
    const payload = { empId: l.empId, empName: l.empName || '', empChinese: l.empChinese || '', type: l.type, typeLabel: l.typeLabel || TYPE_META[l.type]?.label || l.type, durationType: 'days', status: 'approved', reason: l.reason || '', appliedBy: l.appliedBy || currentUser.uid, appliedByName: l.appliedByName || '', appliedAt: l.appliedAt || new Date().toISOString(), reviewedBy: l.reviewedBy || currentUser.uid, reviewedAt: l.reviewedAt || new Date().toISOString(), timeFrom: '', timeTo: '', attachment: null, splitFrom: id, splitNote: 'Auto-split after partial cancellation', ...mkPayload(nonEmpty[i]) };
    const r = await push(ref(db, 'leaves'), payload); if (r?.key) leaves[r.key] = payload;
  }
  const snap = await get(ref(db, `leaves/${id}`)); if (snap.exists()) leaves[id] = snap.val();
  try { await recalcEntitlementUsed(l.empId); } catch (e) { console.warn('entitlement recalc failed:', e); }
  cxNotify(l, newReq, 'approved');
}
async function cxRestoreSchedulesForDates(l, dates) {
  if (!allCenterIds.length) await loadCenterIds();
  const dateSet = new Set(dates);
  for (const dateStr of dates) {
    for (const cid of allCenterIds) {
      try {
        const snap = await get(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`)); if (!snap.exists()) continue;
        const rec = snap.val() || {}; if (rec.status !== 'leave') continue;
        const shiftsArr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});
        if (shiftsArr.some(s => s.start && s.end)) await update(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`), { status: 'scheduled', updatedBy: currentUser.uid, updatedAt: new Date().toISOString() });
        else await remove(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`));
      } catch (e) { console.warn('cx restore empA failed', e); }
    }
  }
  for (const dayPlan of cxReliefPlanArray(l)) {
    if (!dateSet.has(dayPlan?.date)) continue;
    try {
      const relievers = dayPlan.relievers ? (Array.isArray(dayPlan.relievers) ? dayPlan.relievers : Object.values(dayPlan.relievers)) : [];
      for (const rel of relievers) {
        if (!rel?.relieverId || !rel?.newShift) continue;
        const snap = await get(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`));
        const rec = snap.val();
        if (rec?.shifts) { const arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts); const filtered = arr.filter(s => !(s.start === rel.newShift.start && s.end === rel.newShift.end && (s.center || rel.newShift.center) === rel.newShift.center)); await update(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`), { ...rec, shifts: filtered }); }
        const adjustments = Array.isArray(rel.adjustments) ? rel.adjustments : [];
        if (!adjustments.length) continue;
        const adjByCenter = {}; adjustments.forEach(a => { (adjByCenter[a.center] = adjByCenter[a.center] || []).push(a); });
        for (const [center, list] of Object.entries(adjByCenter)) {
          const s2 = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`)); if (!s2.exists()) continue;
          const r2 = s2.val() || {};
          let arr2 = Array.isArray(r2.shifts) ? r2.shifts : Object.values(r2.shifts || {});
          list.forEach(a => { (a.after || []).forEach(p => { arr2 = arr2.filter(sh => !((sh.type || 'work') === 'work' && sh.start === p.start && sh.end === p.end)); }); if (!arr2.some(sh => (sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end)) arr2 = [...arr2, { ...a.before }]; });
          await update(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`), { ...r2, shifts: arr2, updatedBy: currentUser.uid, updatedAt: new Date().toISOString() });
        }
      }
    } catch (e) { console.warn('cx reliever restore failed:', e); }
  }
}
function cxNotify(leave, req, eventType) {
  if (!EMAIL_NOTIFICATIONS_ENABLED || !emailjsConfigured()) return;
  try {
    const tos = new Set(getManagerEmails());
    const empEmail = employees[leave.empId]?.email?.trim().toLowerCase(); if (empEmail) tos.add(empEmail);
    const uniqueTos = [...tos]; if (!uniqueTos.length) return;
    const subjects = { new: `🚫 Cancellation REQUEST — ${leave.empName} (${leave.typeLabel || leave.type})`, approved: `✅ Leave cancellation APPROVED — ${leave.empName}`, rejected: `❌ Cancellation request REJECTED — ${leave.empName}`, withdrawn: `↩️ Cancellation request withdrawn — ${leave.empName}` };
    const actions = { new: 'Cancellation requested (PENDING)', approved: 'Cancellation APPROVED', rejected: 'Cancellation request REJECTED', withdrawn: 'Cancellation request WITHDRAWN' };
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { to_email: uniqueTos.join(','), subject: subjects[eventType] || subjects.new, action: actions[eventType] || eventType, acted_by: cxCurrentUserName(), employee_name: leave.empName || '-', leave_type: leave.typeLabel || leave.type || '-', dates: `${leave.dateFrom} → ${leave.dateTo}`, duration: cxScopeText(leave, req), reason: req.reason || leave.reason || '-', applied_by: req.requestedByName || '-' }, { publicKey: EMAILJS_PUBLIC_KEY }).catch(err => console.warn('CX notification failed:', err?.text || err));
  } catch (err) { console.warn('CX notification failed:', err); }
}
function wireCxEvents() {
  $('main-tab-cancelrequests')?.addEventListener('click', e => { const btn = e.target.closest('button[data-cx]'); if (!btn) return; const { cx, id } = btn.dataset; if (cx === 'request') openCxRequestModal(id); else if (cx === 'review') openCxReviewModal(id); else if (cx === 'withdraw') cxWithdraw(id); });
  $('cxSubmitRequestBtn')?.addEventListener('click', submitCxRequest);
  $('cxCancelRequestBtn')?.addEventListener('click', () => closeModal('cxRequestModal'));
  $('cxCloseRequestBtn')?.addEventListener('click', () => closeModal('cxRequestModal'));
  $('cxSelectAllDays')?.addEventListener('change', e => { document.querySelectorAll('#cxDaysList .cx-day-cb:not(:disabled)').forEach(cb => { cb.checked = e.target.checked; }); cxUpdateDayUI(); });
  $('cxApproveBtn')?.addEventListener('click', cxApprove);
  $('cxRejectBtn')?.addEventListener('click', cxReject);
  $('cxCloseReviewBtn')?.addEventListener('click', () => closeModal('cxReviewModal'));
}
wireCxEvents();
window.healLegacyReliefOverlaps = healLegacyReliefOverlaps;
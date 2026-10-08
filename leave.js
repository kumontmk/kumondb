// ============================================================
// leave.js — Leave Module (Application + Overview) 
// ============================================================
import { db, logout } from './auth.js';
import { ref, get, update, onValue, push, runTransaction, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t, applyI18n, currentLanguage } from './leave-i18n.js';


const auth = getAuth();
const AUTHORIZED_EMAIL = 'kumonchamps@gmail.com';
const MAX_ATTACHMENT_BYTES = 100 * 1024;

// Wait for translations, then translate static HTML once
await i18nReady.catch(() => {});
document.documentElement.lang = currentLanguage;
applyI18n();

// Safe auto-translate observer (debounced, no infinite loop)
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

// Translated date constants
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
  pt:     { label: t('typePT'),     cls: 'lv-pt',     ledger: 'timeOffUsed' }
};
const ENTITLEMENT_FIELDS = { annualUsed: 'annual', sickUsed: 'sick', timeOffUsed: 'timeOff' };

// 🆕 Status-aware fill colors for same-day split cells (mirrors leave.css tokens)
const LV_COLORS = {
    'lv-annual': { solid: '#4682B4', faint: '#dbeafe' },
    'lv-sick':   { solid: '#eab308', faint: '#fef9c3' },
    'lv-unpaid': { solid: '#f97316', faint: '#ffedd5' },
    'lv-pt':     { solid: '#ec4899', faint: '#fce7f3' }
};
const LV_ABBR = { annual: 'AL', sick: 'SL', unpaid: 'UL', pt: 'PT' };
const LV_OVERLAY = {
    annual: 'rgba(70,130,180,0.28)', sick: 'rgba(234,179,8,0.30)',
    unpaid: 'rgba(249,115,22,0.30)', pt: 'rgba(236,72,153,0.28)'
};

let employees = {}, leaves = {}, currentUser = null;
let statusFilter = 'all', monthFilter = 'all';
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
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const isPartTime = emp => (emp?.terms || '').toLowerCase().includes('part');

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

// 🆕 AUTO-ADJUST RELIEVER SHIFTS
function trimShiftAround(existing, added) {
  const es = timeToMinutes(existing.start), ee = timeToMinutes(existing.end);
  const as = timeToMinutes(added.start),  ae = timeToMinutes(added.end);
  if (es == null || ee == null || as == null || ae == null) return [{ ...existing }];
  if (es >= ae || ee <= as) return [{ ...existing }];          // no overlap
  const parts = [];
  if (es < as) parts.push({ ...existing, end: added.start });  // keep part before
  if (ee > ae) parts.push({ ...existing, start: added.end });  // keep part after
  return parts;                                                // [] = fully covered
}
async function computeRelieverAdjustments(relieverId, dateStr, newShift) {
  const sched = await getEmpScheduleForDate(relieverId, dateStr);
  const adjustments = [];
  (sched.shifts || []).forEach(s => {
    if ((s.type || 'work') !== 'work') return;                 // never trim breaks
    const parts = trimShiftAround(s, newShift);
    if (parts.length === 1 && parts[0].start === s.start && parts[0].end === s.end) return;
    const center = s._center || s.center || newShift.center;
    adjustments.push({
      center,
      before: { type: 'work', start: s.start, end: s.end, center: s.center || center, otherDesc: s.otherDesc || '' },
      after:  parts.map(p => ({ type: 'work', start: p.start, end: p.end, center: s.center || center, otherDesc: s.otherDesc || '' }))
    });
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
// 🌐 Use the active UI language for all date formatting
const uiLocale = () => (currentLanguage === 'zh-TW' ? 'zh-TW' : 'en-US');
function fmtDate(s) {
  if (!s) return '-';
  return new Date(s + 'T00:00:00').toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateShort(s) {
  if (!s) return '-';
  return new Date(s + 'T00:00:00').toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' });
}

function getDowAbbr(date) {
  // Use browser/locale weekday for Traditional Chinese
  if (currentLanguage === 'zh-TW') {
    return date.toLocaleDateString('zh-TW', { weekday: 'short' });
  }

  // English abbreviations matching your example: Thurs / Tues
  const enDowAbbr = ['Sun', 'Mon', 'Tues', 'Wed', 'Thurs', 'Fri', 'Sat'];
  return enDowAbbr[date.getDay()];
}

function fmtDateWithDow(s) {
  if (!s) return '-';

  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return s;

  const dateText = d.toLocaleDateString(uiLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  return `${dateText} (${getDowAbbr(d)})`;
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

  // 👇 Hide Entitlements tab if user is not an Admin/Manager
  if (!currentUser.isAdmin) {
      const entTab = $('tabEntitlements');
      if (entTab) entTab.style.display = 'none';
  }

  // 👇 Weekly Reports is Master Admin ONLY
  if (!currentUser.isMaster) {
      const wrTab = $('tabWeeklyReports');
      if (wrTab) wrTab.style.display = 'none';
  }

  setText('entYearLabel', entYear);

  $('leaveTable').innerHTML = `<tbody><tr><td class="empty-state">${escapeHtml(t('loadingRecords'))}</td></tr></tbody>`;
  injectAdminControls();
  wireEvents();
  renderMonthPickerLabel();
  loadScheduleData();

  // 🚀 OPTIMIZATION: Use refreshAllSoon() to debounce the initial load
  // This prevents the UI from re-rendering 3-4 times in a split second
  onValue(ref(db, 'employees'), s => { employees = s.val() || {}; refreshAllSoon(); });
  onValue(ref(db, 'leaves'), s => { leaves = s.val() || {}; refreshAllSoon(); scheduleAutoSync(); });
}

function refreshAllSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshAll, 80); }

function refreshAll() { 
    if (!currentUser) return; 
    populateEmpFilter(); 
    renderBalanceStrip(); 
    renderLeaveTable(); 
    
    // 🚀 OPTIMIZATION: Only render heavy tabs if they are currently active
    // This prevents the heavy Overview calendar from rendering in the background
    if ($('main-tab-overview')?.classList.contains('active')) {
        renderOverview();
    }
    if ($('main-tab-entitlements')?.classList.contains('active')) {
        renderEntitlementsTab();
    }
    if ($('main-tab-weeklyreports')?.classList.contains('active')) {
    renderWeeklyReports();
    }
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
      allCenterIds.forEach(cid => { Object.entries(employeeScheduleByCenter?.[cid] || {}).forEach(([ds, rec]) => { if ((rec?.status || 'scheduled') === 'off') set.add(ds); }); });
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

// 🆕 Splits a day-range request into paid + unpaid records. A fractional paid
// balance (e.g. 0.25 day left) is converted into HOURLY leave on the next
// working day: the first N hours of that day's shift become paid leave and the
// remaining shift hours become hourly unpaid leave, so the day stays covered.
// Returns an array of complete leave payloads ready to push.
// Throws if the fractional day has no shift to anchor the hours to.
async function getSplitLeaveRanges(empId, from, to, availableDays, baseLeaveData, type) {
    const weeklyOffDays = getWeeklyOffDays(empId);
    const offDates = await getOffDates(empId);
    if (!Object.keys(centerCalendars).length) await loadCenterCalendars();

    const working = [], skipped = [];
    eachDate(from, to, d => {
        const ds = fmtISO(d);
        if (weeklyOffDays.has(d.getDay()) || offDates.has(ds) || isHoliday(empId, ds)) skipped.push(ds);
        else working.push(ds);
    });

    const daysPerYearOf = dates => {
        const o = {};
        dates.forEach(ds => { const y = parseInt(ds.slice(0, 4), 10); o[y] = (o[y] || 0) + 1; });
        return o;
    };
    const skippedWithin = (a, b) => skipped.filter(ds => ds >= a && ds <= b).join(', ');
    const toHM = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

    const records = [];
    const wholePaid = Math.floor(availableDays + 0.0001);
    const fraction = round2(availableDays - wholePaid);

    const paidFullDays = working.slice(0, wholePaid);
    const fracDay = fraction > 0 ? working[wholePaid] : null;
    const unpaidFullDays = working.slice(fraction > 0 ? wholePaid + 1 : wholePaid);

    // 1) Whole paid days (original leave type, day-based)
    if (paidFullDays.length) {
        const dFrom = paidFullDays[0], dTo = paidFullDays[paidFullDays.length - 1];
        records.push({
            ...baseLeaveData,
            type, typeLabel: TYPE_META[type].label,
            dateFrom: dFrom, dateTo: dTo,
            amount: paidFullDays.length, deductDays: paidFullDays.length,
            restDaysExcluded: skippedWithin(dFrom, dTo),
            daysPerYear: daysPerYearOf(paidFullDays),
            year: parseInt(dFrom.slice(0, 4), 10)
        });
    }

    // 2) Fractional balance → hourly paid slice on the next working day
    if (fracDay) {
        const sched = await getEmpScheduleForDate(empId, fracDay);
        const workShifts = (sched.shifts || [])
            .filter(s => (s.type || 'work') === 'work' && isValidTimeString(s.start) && isValidTimeString(s.end) && timeToMinutes(s.end) > timeToMinutes(s.start))
            .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
        if (!workShifts.length) {
            throw new Error(t('splitNoShiftAlert', { name: baseLeaveData.empName || '', date: fmtDate(fracDay) }));
        }

        const totalWorkHours = round1(workShifts.reduce((sum, s) => sum + (timeToMinutes(s.end) - timeToMinutes(s.start)), 0) / 60);
        const paidHours = Math.min(round1(fraction * 8), totalWorkHours); // never more hours than the shift has
        const startMin = timeToMinutes(workShifts[0].start);
        const paidFromTime = toHM(startMin);
        const paidToTime = toHM(startMin + Math.round(paidHours * 60));
        const yearNum = parseInt(fracDay.slice(0, 4), 10);

        records.push({
            ...baseLeaveData,
            type, typeLabel: TYPE_META[type].label,
            durationType: 'hours',
            dateFrom: fracDay, dateTo: fracDay,
            timeFrom: paidFromTime, timeTo: paidToTime,
            amount: paidHours, deductDays: round2(paidHours / 8),
            restDaysExcluded: '',
            daysPerYear: { [yearNum]: round2(paidHours / 8) },
            year: yearNum
        });

        // 2b) Remainder of that day's shift → hourly unpaid (keeps the day fully covered)
        const unpaidHours = round1(totalWorkHours - paidHours);
        if (unpaidHours > 0) {
            const dayEndMin = Math.max(...workShifts.map(s => timeToMinutes(s.end)));
            records.push({
                ...baseLeaveData,
                type: 'unpaid', typeLabel: TYPE_META.unpaid.label,
                durationType: 'hours',
                dateFrom: fracDay, dateTo: fracDay,
                timeFrom: paidToTime, timeTo: toHM(dayEndMin),
                amount: unpaidHours, deductDays: round2(unpaidHours / 8),
                restDaysExcluded: '',
                daysPerYear: { [yearNum]: round2(unpaidHours / 8) },
                year: yearNum
            });
        }
    }

    // 3) Remaining whole days → unpaid (day-based)
    if (unpaidFullDays.length) {
        const dFrom = unpaidFullDays[0], dTo = unpaidFullDays[unpaidFullDays.length - 1];
        records.push({
            ...baseLeaveData,
            type: 'unpaid', typeLabel: TYPE_META.unpaid.label,
            dateFrom: dFrom, dateTo: dTo,
            amount: unpaidFullDays.length, deductDays: unpaidFullDays.length,
            restDaysExcluded: skippedWithin(dFrom, dTo),
            daysPerYear: daysPerYearOf(unpaidFullDays),
            year: parseInt(dFrom.slice(0, 4), 10)
        });
    }

    return records;
}

async function getEmpScheduleForDate(empId, dateStr) {
    if (!allCenterIds.length) await loadCenterIds();
    let mergedShifts = [], originalStatus = 'scheduled', originalNotes = '';
    
    // First, try to get explicit schedule from all centers
    for (const cid of allCenterIds) {
        try {
            const snap = await get(ref(db, `schedules/${cid}/${empId}/${dateStr}`));
            if (snap.exists()) {
                const data = snap.val();
                if (data.status && data.status !== 'scheduled') originalStatus = data.status;
                if (data.notes) originalNotes = data.notes;
                if (data.shifts && Array.isArray(data.shifts)) data.shifts.forEach(s => mergedShifts.push({ ...s, _center: s.center || cid }));
            }
        } catch (e) { console.warn(`Failed to load schedule for ${empId} at ${cid} on ${dateStr}`, e); }
    }
    
    // 🆕 If no explicit shifts found, fall back to weekly pattern/template
    if (mergedShifts.length === 0 && originalStatus === 'scheduled') {
        const dow = new Date(dateStr + 'T00:00:00').getDay();
        const tmpl = scheduleTemplates[empId]?.[dow];
        if (tmpl) {
            if (tmpl.status && tmpl.status !== 'scheduled') originalStatus = tmpl.status;
            if (tmpl.notes) originalNotes = tmpl.notes;
            if (tmpl.shifts && Array.isArray(tmpl.shifts)) {
                const empCenters = getEmpCenterIds(empId);
                tmpl.shifts.forEach(s => {
                    // Use shift's center, or employee's first center, or first available center
                    const center = s.center || empCenters[0] || allCenterIds[0];
                    mergedShifts.push({ ...s, _center: center });
                });
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
// 🆕 FIX: Sum actual approved unpaid leave (days + hours) for a year,
// instead of just counting the number of leave records.
function getUnpaidTotalsForYear(empId, year) {
  let days = 0, hours = 0;
  Object.values(leaves).forEach(l => {
    if (l.empId !== empId || l.type !== 'unpaid' || l.status !== 'approved') return;
    if (l.durationType === 'hours') {
      if (leaveRecordYear(l) === year) hours = round2(hours + Number(l.amount || 0));
    } else {
      let d = 0;
      if (l.daysPerYear && l.daysPerYear[year] !== undefined) d = Number(l.daysPerYear[year] || 0);
      else if (leaveRecordYear(l) === year) d = Number(l.deductDays || l.amount || 0);
      days = round2(days + d);
    }
  });
  return { days, hours };
}
function formatUnpaidTotal(totals) {
  const parts = [];
  if (totals.days) parts.push(`${totals.days}d`);
  if (totals.hours) parts.push(`${totals.hours}h`);
  return parts.length ? parts.join(' ') : '0';
}
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
    timeOff: { entitled: timeOff, used: timeOffUsed, balance: round2(timeOff - timeOffUsed) }
  };
}
function getBalances(emp, empId = null) { return getBalancesForYear(emp, empId, new Date().getFullYear()); }
function selectedLeaveYear() { const d = $('dateFrom')?.value; const y = d ? parseInt(d.slice(0, 4), 10) : NaN; return Number.isInteger(y) ? y : new Date().getFullYear(); }
function buildTypeOptions(emp, empId, year) {
  const b = getBalancesForYear(emp, empId, year);
  const tag = year !== new Date().getFullYear() ? ` ${t('quotaTag', { year })}` : '';
  const opts = [];
  if (!isPartTime(emp)) {
    opts.push({ key: 'annual', text: t('optAnnual', { balance: b.annual.balance, tag }), disabled: b.annual.balance <= 0 });
    opts.push({ key: 'sick', text: t('optSick', { balance: b.sick.balance, tag }), disabled: b.sick.balance <= 0 });
  } else {
    opts.push({ key: 'pt', text: t('optPT', { balance: b.timeOff.balance, tag }), disabled: false });
  }

  const annualLeft = Math.max(0, b.annual.balance);
  const isMaster = currentUser?.isMaster;
  // Only disable unpaid leave if annual balance > 0 AND user is NOT master admin
  const disableUnpaid = annualLeft > 0 && !isMaster;

  opts.push({
      key: 'unpaid',
      text: annualLeft > 0 ? t('optUnpaidAvailable', { left: annualLeft, tag }) : t('optUnpaid', { tag }),
      disabled: disableUnpaid,
      showHint: annualLeft > 0 && !isMaster
  });

  return opts;
}
async function adjustEntitlementAtomic(leave, delta, { enforceBalance = true } = {}) {
  const ledgerField = TYPE_META[leave?.type]?.ledger;
  if (!ledgerField || !delta || !leave?.empId) return;
  const entitlementRef = ref(db, `employees/${leave.empId}/leaveEntitlement`);
  const result = await runTransaction(entitlementRef, le => {
    le = le || {};
    const entitledField = ENTITLEMENT_FIELDS[ledgerField];
    const entitled = Number(le[entitledField] || 0);
    const currentUsed = Number(le[ledgerField] || 0);
    const nextUsed = round2(currentUsed + delta);
    const requiresBalanceCheck = ledgerField === 'annualUsed' || ledgerField === 'sickUsed';
    if (enforceBalance && delta > 0 && requiresBalanceCheck && nextUsed > entitled + 0.001) return;
    le[ledgerField] = Math.max(0, nextUsed);
    return le;
  });
  if (!result.committed) throw new Error(t('insufficientBalance', { label: TYPE_META[leave?.type]?.label, year: leave.year }));
}
async function recalcEntitlementUsed(empId) {
  const emp = employees[empId]; if (!emp) return false;
  const le = emp.leaveEntitlement || {};
  const currentYear = new Date().getFullYear();
  let entYear = Number(le.lastResetYear) || currentYear;
  const extraUpdates = {};
  if (currentYear > entYear) { entYear = currentYear; extraUpdates.lastResetYear = currentYear; }
  let annual = 0, sick = 0, timeOff = 0;
  Object.values(leaves).forEach(l => {
    if (l.empId !== empId || l.status !== 'approved') return;
    let d = 0;
    if (l.daysPerYear && l.daysPerYear[entYear] !== undefined) d = Number(l.daysPerYear[entYear] || 0);
    else if (leaveRecordYear(l) === entYear) d = Number(l.deductDays || 0);
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
    do {
      autoSyncQueued = false; let changed = 0;
      for (const empId of Object.keys(employees)) { if (await recalcEntitlementUsed(empId)) changed++; }
      showSyncStatus(changed ? t('syncedCorrected', { count: changed }) : t('synced'), true);
    } while (autoSyncQueued);
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
  let list = scopedLeaves().filter(l => String(l.year || (l.dateFrom || '').slice(0, 4)) === String(currentYear));
  const range = monthRangeForFilter(); if (range) list = list.filter(l => l.dateFrom <= range.end && l.dateTo >= range.start);
  const empF = $('empFilter')?.value; if (currentUser.isAdmin && empF && empF !== 'all') list = list.filter(l => l.empId === empF);
  const q = $('searchLeave')?.value.trim().toLowerCase();
  if (q) list = list.filter(l => (l.reason || '').toLowerCase().includes(q) || (l.typeLabel || '').toLowerCase().includes(q) || (l.empName || '').toLowerCase().includes(q));
  list.sort((a, b) => (b.appliedAt || '').localeCompare(a.appliedAt || ''));
  return list;
}
function updatePillCounts() {
  const base = getFilteredLeaves(); const count = s => base.filter(l => l.status === s).length;
  setText('countAll', base.length); setText('countPending', count('pending')); setText('countApproved', count('approved')); setText('countRejected', count('rejected')); setText('countCancelled', count('cancelled'));
}
function durationText(l) { return l.durationType === 'hours' ? `${l.amount} ${t('hrUnit')}` : `${l.amount} ${t('dayUnit')}`; }
function renderLeaveTable() {
  updatePillCounts(); const table = $('leaveTable'); if (!table) return;
  let list = getFilteredLeaves(); if (statusFilter !== 'all') list = list.filter(l => l.status === statusFilter);
  const admin = currentUser.isAdmin; const cols = admin ? 9 : 8;
  const thead = `<thead><tr>${admin ? `<th>${escapeHtml(t('thEmployee'))}</th>` : ''}<th>${escapeHtml(t('thLeaveType'))}</th><th>${escapeHtml(t('thDuration'))}</th><th>${escapeHtml(t('thFrom'))}</th><th>${escapeHtml(t('thTo'))}</th><th>${escapeHtml(t('thReason'))}</th><th>📎</th><th>${escapeHtml(t('thStatus'))}</th><th>${escapeHtml(t('thActions'))}</th></tr></thead>`;
  if (list.length === 0) { table.innerHTML = thead + `<tbody><tr><td colspan="${cols}" class="empty-state">${escapeHtml(t('noLeaveRecords', { year: currentYear }))}</td></tr></tbody>`; return; }
  const rows = list.map(l => {
    const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const fromCell = l.durationType === 'hours'
  ? `${fmtDateWithDow(l.dateFrom)}${l.timeFrom ? ' · ' + l.timeFrom : ''}`
  : fmtDateWithDow(l.dateFrom);
    const toCell = l.durationType === 'hours'
    ? `${fmtDateWithDow(l.dateTo)}${l.timeTo ? ' · ' + l.timeTo : ''}`
    : fmtDateWithDow(l.dateTo);
    let actions = '';
    if (admin && l.status === 'pending') actions += `<button class="primary" data-action="approve" data-id="${escapeHtml(l.id)}" type="button">✅</button><button class="danger" data-action="reject" data-id="${escapeHtml(l.id)}" type="button">❌</button>`;
    const canCancel = (l.status === 'pending' && (admin || l.empId === currentUser.empId)) || (l.status === 'approved' && admin);
    if (canCancel) actions += `<button class="secondary" data-action="cancel" data-id="${escapeHtml(l.id)}" type="button">🚫</button>`;
    if (!actions) actions = `<span style="color:#cbd5e1;">—</span>`;
    const canDelAtt = l.attachment && (admin || (l.empId === currentUser.empId && l.status === 'pending'));
    const safeId = escapeHtml(l.id);
    return `<tr> ${admin ? `<td data-label="${escapeHtml(t('thEmployee'))}">${escapeHtml(l.empName || '-')}${l.empChinese ? `<small>(${escapeHtml(l.empChinese)})</small>` : ''}</td>` : ''} <td data-label="${escapeHtml(t('thLeaveType'))}"><span class="type-dot lv ${meta.cls} approved"></span>${escapeHtml(meta.label)}</td> <td data-label="${escapeHtml(t('thDuration'))}">${durationText(l)}${l.restDaysExcluded ? ` <small style="color:#94a3b8;">${escapeHtml(t('restExcluded'))}</small>` : ''}</td> <td data-label="${escapeHtml(t('thFrom'))}">${fromCell}</td><td data-label="${escapeHtml(t('thTo'))}">${toCell}</td> <td data-label="${escapeHtml(t('thReason'))}" class="reason-cell" title="${escapeHtml(l.reason)}">${escapeHtml(l.reason)}</td> <td data-label="File">${l.attachment ? `<button class="icon-btn" data-action="view-att" data-id="${safeId}" type="button">📎</button>` : '-'}${canDelAtt ? `<button class="icon-btn danger-ico" data-action="del-att" data-id="${safeId}" type="button">🗑</button>` : ''}</td> <td data-label="${escapeHtml(t('thStatus'))}"><span class="status-badge ${l.status}">${escapeHtml(statusLabel(l.status))}</span></td> <td data-label="${escapeHtml(t('thActions'))}"><div class="leave-table-actions">${actions}</div></td> </tr>`;
  }).join('');
  table.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

// ============ APPROVE MODAL & RELIEF ============
async function openApproveModal(id) {
  const l = leaves[id]; if (!l || l.status !== 'pending') return;
  currentApproveLeave = { id, ...l }; empASchedulesCache = {};
  $('approveLeaveDetails').innerHTML = `<strong>${escapeHtml(l.empName)}</strong> · ${escapeHtml(TYPE_META[l.type]?.label || l.type)}<br> ${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}<br> <em>${escapeHtml(t('thReason'))}: ${escapeHtml(l.reason)}</em>`;  $('confirmApproveBtn').disabled = true; $('confirmApproveBtn').textContent = t('loadingSchedules');
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
  const dates = Object.keys(schedulesByDate).sort();
  dates.forEach(dateStr => {
    const sched = schedulesByDate[dateStr];
    if (sched.isDayOff) { const tr = document.createElement('tr'); tr.innerHTML = `<td>${fmtDateWithDow(dateStr)}</td><td colspan="3" class="no-shift-msg">${escapeHtml(t('dayOffNoRelief'))}</td>`; tbody.appendChild(tr); return; }
    if (!sched.shifts || sched.shifts.length === 0) { const tr = document.createElement('tr'); tr.innerHTML = `<td>${fmtDateWithDow(dateStr)}</td><td colspan="3" class="no-shift-msg">${escapeHtml(t('noShiftNoRelief'))}</td>`; tbody.appendChild(tr); return; }
    sched.shifts.forEach((shift, shiftIdx) => {
      const tr = document.createElement('tr'); tr.dataset.date = dateStr; tr.dataset.shiftIdx = shiftIdx;
      const centerAbbr = getCenterAbbr(shift._center);
      tr.innerHTML = `<td>${fmtDateWithDow(dateStr)}</td><td><strong>${centerAbbr}</strong></td><td>${shift.start} - ${shift.end}</td><td class="relievers-cell" data-date="${dateStr}" data-center="${shift._center}" data-start="${shift.start}" data-end="${shift.end}"><div class="no-reliever-toggle"><label><input type="checkbox" class="no-reliever-cb"><span>${escapeHtml(t('noRelieverNeeded'))}</span></label></div><div class="relievers-container"></div><button type="button" class="add-reliever-btn">${escapeHtml(t('addReliever'))}</button></td>`;
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
  allCenters.forEach(c => { const sel = c.id === empACenter ? 'selected' : ''; centerOptions += `<option value="${c.id}" ${sel}>${escapeHtml(c.name)}</option>`; });
  
  // 🆕 PATCH 5.1: Added <div class="reliever-overlap-note"></div> container
  relieverDiv.innerHTML = `<div class="reliever-controls"><select class="reliever-select">${empOptions}</select><span class="orig-shift-display">${escapeHtml(t('origNone'))}</span><span class="arrow-indicator">→</span><select class="new-center-select">${centerOptions}</select><input type="time" class="new-start-time" value="${empAStart}"><input type="time" class="new-end-time" value="${empAEnd}"><button type="button" class="remove-reliever-btn">🗑</button></div><div class="reliever-overlap-note"></div>`;
  
  container.insertBefore(relieverDiv, container.querySelector('.add-reliever-btn'));
  const select = relieverDiv.querySelector('.reliever-select'), origDisplay = relieverDiv.querySelector('.orig-shift-display');
  
  // 🆕 PATCH 5.2: Trigger overlap note on selection change
  select.addEventListener('change', async () => {
      const rid = select.value; 
      if (!rid) { 
          origDisplay.textContent = t('origNone'); 
          refreshRelieverOverlapNote(relieverDiv);
          return; 
      }
      origDisplay.textContent = t('origLoading');
      const sched = await getEmpScheduleForDate(rid, dateStr);
      if (sched.shifts.length === 0 && sched.status === 'scheduled') {
          origDisplay.textContent = t('origNoShift');
      } else if (sched.status !== 'scheduled') {
          // Directly show the status text
          origDisplay.textContent = sched.status.toUpperCase();
      } else {
          // Directly show the shifts
          const shiftText = sched.shifts.map(s => `${getCenterAbbr(s._center || s.center)} ${s.start}-${s.end}`).join(', ');
          origDisplay.textContent = shiftText || t('origNoShift');
      }
      refreshRelieverOverlapNote(relieverDiv);
  });
  
  relieverDiv.querySelector('.remove-reliever-btn').addEventListener('click', () => relieverDiv.remove());
  relieverDiv.querySelector('.new-start-time').addEventListener('change', () => refreshRelieverOverlapNote(relieverDiv));
  relieverDiv.querySelector('.new-end-time').addEventListener('change', () => refreshRelieverOverlapNote(relieverDiv));
}

async function refreshRelieverOverlapNote(relieverDiv) {
  const note = relieverDiv.querySelector('.reliever-overlap-note');
  if (!note) return;
  const rid = relieverDiv.querySelector('.reliever-select').value;
  const start = relieverDiv.querySelector('.new-start-time').value;
  const end = relieverDiv.querySelector('.new-end-time').value;
  if (!rid || !isValidTimeString(start) || !isValidTimeString(end) || timeToMinutes(end) <= timeToMinutes(start)) { note.innerHTML = ''; return; }
  const sched = await getEmpScheduleForDate(rid, relieverDiv.closest('tr')?.dataset.date);
  const hits = (sched.shifts || []).filter(s => (s.type || 'work') === 'work' && timeRangesOverlap(start, end, s.start, s.end));
  note.innerHTML = hits.length ? '⚠️ ' + hits.map(s => {
    const parts = trimShiftAround(s, { start, end });
    return `${getCenterAbbr(s._center || s.center)} ${s.start}–${s.end} → ${parts.length ? parts.map(p => `${p.start}–${p.end}`).join(' + ') : 'removed'}`;
  }).join('<br>⚠️ ') : '';
}

async function confirmApproval() {
  const l = currentApproveLeave;
  if (!l || !l.id) { alert(t('missingRecord')); return; }
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

     // 🆕 pre-compute how each reliever's own shifts will be auto-trimmed (saved into reliefPlan for cancel/restore)
    for (const dayPlan of reliefPlan) {
      for (const rel of dayPlan.relievers) {
        if (rel.relieverId && rel.newShift) {
          rel.adjustments = await computeRelieverAdjustments(rel.relieverId, dayPlan.date, rel.newShift);
        }
      }
    }

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
    await update(ref(db, `leaves/${l.id}`), { status: 'approved', reviewedBy: currentUser.uid, reviewedAt: new Date().toISOString(), deductDays: deduct, amount, restDaysExcluded: skippedStr, reliefPlan: reliefPlan, daysPerYear: daysPerYear });
    leaves[l.id] = { ...l, status: 'approved', deductDays: deduct, amount, year: parseInt(l.dateFrom.slice(0, 4), 10), daysPerYear: daysPerYear };
    await recalcEntitlementUsed(l.empId);
    for (const dayPlan of reliefPlan) {
      const dateStr = dayPlan.date; const centersToUpdate = new Set();
      const origShifts = Array.isArray(dayPlan.empAOrigSchedule.shifts) ? dayPlan.empAOrigSchedule.shifts : Object.values(dayPlan.empAOrigSchedule.shifts || {});
      origShifts.forEach(s => centersToUpdate.add(s._center || s.center));
      if (centersToUpdate.size === 0) { 
        getEmpCenterIds(l.empId).forEach(c => centersToUpdate.add(c));
      }
      for (const cid of centersToUpdate) {
        await update(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`), {
          // 🆕 Hourly leave keeps the day "scheduled" (shifts intact);
          // the schedule page draws the proportional strip from the leave record.
          status: l.durationType === 'hours' ? 'scheduled' : 'leave',
          shifts: origShifts,
          notes: dayPlan.empAOrigSchedule.notes || '',
          updatedBy: currentUser.uid,
          updatedAt: new Date().toISOString()
        });
      }     
        const relievers = Array.isArray(dayPlan.relievers) ? dayPlan.relievers : [];
        for (const rel of relievers) {
          if (!rel.relieverId || !rel.newShift) continue;

          const changesByCenter = {};
          (rel.adjustments || []).forEach(a => { (changesByCenter[a.center] = changesByCenter[a.center] || []).push(a); });
          const touchedCenters = new Set(Object.keys(changesByCenter));
          touchedCenters.add(rel.newShift.center);

          for (const center of touchedCenters) {
            const snap = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dateStr}`));
            const rec = snap.val() || { status: 'scheduled', shifts: [], notes: '' };
            let arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});

            // No explicit record → seed from weekly pattern so other pattern shifts aren't lost
            if (!snap.exists()) {
              const dow = new Date(dateStr + 'T00:00:00').getDay();
              const tmpl = scheduleTemplates[rel.relieverId]?.[dow];
              const tShifts = (tmpl && Array.isArray(tmpl.shifts)) ? tmpl.shifts : [];
              const empCenters = getEmpCenterIds(rel.relieverId);
              arr = tShifts
                .map(sh => ({ ...sh, center: sh.center || empCenters[0] || allCenterIds[0] }))
                .filter(sh => sh.center === center);
            }

            // Apply trims: remove original shift, add surviving part(s)
            (changesByCenter[center] || []).forEach(a => {
              arr = arr.filter(sh => !((sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end));
              arr = arr.concat(a.after);
            });

            // Add the relieved shift on its own center
            if (center === rel.newShift.center) arr = [...arr, rel.newShift];

            await update(ref(db, `schedules/${center}/${rel.relieverId}/${dateStr}`), {
              status: rec.status || 'scheduled', shifts: arr, notes: rec.notes || '',
              updatedBy: currentUser.uid, updatedAt: new Date().toISOString()
            });
          }
        }
      }
    notifyLeaveEvent({ ...l, amount, deductDays: deduct }, 'approved');
    closeModal('approveModal'); alert(t('approved'));
  } catch (err) { console.error(err); alert(t('approveFailed', { message: err.message })); }
  finally { btn.disabled = false; btn.textContent = t('confirmApproval'); }
}

// ============ REJECT / CANCEL ============
async function rejectLeave(id) {
  const l = leaves[id]; if (!l || l.status !== 'pending') return;
  if (!confirm(t('rejectConfirm', { name: l.empName }))) return;
  try { await update(ref(db, `leaves/${id}`), { status: 'rejected', reviewedBy: currentUser.uid, reviewedAt: new Date().toISOString() }); notifyLeaveEvent(l, 'rejected'); }
  catch (err) { console.error(err); alert(t('rejectFailed')); }
}
async function cancelLeave(id) {
  const l = leaves[id]; if (!l) return;
  const wasApproved = l.status === 'approved';
  if (!confirm(wasApproved ? t('cancelApprovedConfirm') : t('cancelConfirm'))) return;
  if (wasApproved) { try { await restoreSchedulesForLeave(l); } catch (e) { console.error('Schedule restore failed:', e); alert(t('cancelScheduleWarn')); } }
  if (wasApproved) { try { leaves[id] = { ...l, status: 'cancelled' }; await recalcEntitlementUsed(l.empId); } catch (e) { console.warn('entitlement recalc failed:', e); } }
  try { await update(ref(db, `leaves/${id}`), { status: 'cancelled', cancelledBy: currentUser.uid, cancelledAt: new Date().toISOString() }); }
  catch (err) { console.error(err); alert(t('cancelFailed', { message: err.message })); }
}
async function restoreSchedulesForLeave(l) {
  if (!allCenterIds.length) await loadCenterIds();
  const dates = []; if (l.durationType === 'hours') dates.push(l.dateFrom); else eachDate(l.dateFrom, l.dateTo, d => dates.push(fmtISO(d)));

  // 1) Employee A: flip "leave" days back to scheduled (or remove empty records)
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

  // 2) Relievers: remove added relief shift + undo auto-trim adjustments
  if (l.reliefPlan) {
    const planArray = Array.isArray(l.reliefPlan) ? l.reliefPlan : Object.values(l.reliefPlan);
    for (const dayPlan of planArray) {
      try {
        const relievers = dayPlan?.relievers ? (Array.isArray(dayPlan.relievers) ? dayPlan.relievers : Object.values(dayPlan.relievers)) : [];
        for (const rel of relievers) {
          if (!rel?.relieverId || !rel?.newShift) continue;

          // 2a) Remove the relief shift that was appended on approval
          const snap = await get(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`));
          const rec = snap.val();
          if (rec?.shifts) {
            const arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts);
            const filtered = arr.filter(s => !(s.start === rel.newShift.start && s.end === rel.newShift.end && (s.center || rel.newShift.center) === rel.newShift.center));
            await update(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`), { ...rec, shifts: filtered });
          }

          // 2b) 🆕 Restore original shifts that were auto-trimmed on approval
          const adjustments = Array.isArray(rel.adjustments) ? rel.adjustments : [];
          if (!adjustments.length) continue;
          const adjByCenter = {};
          adjustments.forEach(a => { (adjByCenter[a.center] = adjByCenter[a.center] || []).push(a); });

          for (const [center, list] of Object.entries(adjByCenter)) {
            const s2 = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`));
            if (!s2.exists()) continue; // record gone → nothing to heal
            const r2 = s2.val() || {};
            let arr2 = Array.isArray(r2.shifts) ? r2.shifts : Object.values(r2.shifts || {});

            list.forEach(a => {
              // remove the trimmed surviving part(s) (e.g. 18:00-20:00 MK)
              (a.after || []).forEach(p => {
                arr2 = arr2.filter(sh => !((sh.type || 'work') === 'work' && sh.start === p.start && sh.end === p.end));
              });
              // re-add the original shift (e.g. 15:00-20:00 MK) if not present
              const hasOrig = arr2.some(sh => (sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end);
              if (!hasOrig) arr2 = [...arr2, { ...a.before }];
            });

            await update(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`), {
              ...r2,
              shifts: arr2,
              updatedBy: currentUser.uid,
              updatedAt: new Date().toISOString()
            });
          }
        }
      } catch (e) { console.warn('reliever restore failed:', e); }
    }
  }
}
async function deleteAttachment(id) {
  const l = leaves[id]; if (!l?.attachment) return;
  if (!confirm(t('deleteAttConfirm'))) return;
  try { await update(ref(db, `leaves/${id}`), { attachment: null }); closeModal('attachmentModal'); }
  catch (err) { console.error(err); alert(t('deleteAttFailed')); }
}
function openAttachmentViewer(id) {
  const l = leaves[id]; if (!l?.attachment?.dataUrl) return;
  if (!String(l.attachment.dataUrl).startsWith('data:image/')) { alert(t('attNotSupported')); return; }
  currentAttLeaveId = id; $('attachmentImg').src = l.attachment.dataUrl;
  setText('attachmentCaption', `${l.empName || ''} · ${fmtDate(l.dateFrom)} · ${l.attachment.sizeKB || '?'} KB`);
  const canDelete = currentUser.isAdmin || (l.empId === currentUser.empId && l.status === 'pending');
  $('deleteAttBtn').classList.toggle('hidden', !canDelete);
  openModal('attachmentModal');
}

// ============ EXCEL EXPORT ============
function exportLeaves() {
  if (typeof XLSX === 'undefined') return alert(t('excelNotLoaded'));
  let list = getFilteredLeaves(); if (statusFilter !== 'all') list = list.filter(l => l.status === statusFilter);
  if (!list.length) return alert(t('noExportRecords'));
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
      if (pub) html += `<td class="od-holiday ${extraCls}" title="🎌 ${escapeHtml(pub.name || t('publicHoliday'))}">🎌</td>`;
      else if (isOff) html += `<td class="od-off ${extraCls}" title="${escapeHtml(DOW_NAMES[dow])}">${escapeHtml(t('off'))}</td>`;
      else if (lv) {
          const meta = TYPE_META[lv.type] || { cls: '' };
          // 🆕 Tooltip lists ALL leaves covering this day, not just the first
          const titleText = covering.map(l => {
              const m = TYPE_META[l.type] || { label: l.typeLabel || l.type };
              const timePart = l.durationType === 'hours' && l.timeFrom && l.timeTo ? ` (${l.timeFrom}–${l.timeTo})` : '';
              return `${m.label || ''} (${statusLabel(l.status)}) ${fmtDate(l.dateFrom)} → ${fmtDate(l.dateTo)} · ${durationText(l)}${timePart}\n${escapeHtml(t('thReason'))}: ${l.reason || ''}`;
          }).join('\n──────────\n');
          const fullName = `${emp.englishName || ''}\n`;
          if (covering.length === 1) {
              html += `<td class="lv ${meta.cls} ${lv.status} ${extraCls}" title="${escapeHtml(fullName + titleText)}">${lv.durationType === 'hours' ? ` ${lv.amount}h ` : ''}</td>`;
          } else {
              // 🆕 Diagonal split cell: top-left = 1st leave (approved first), bottom-right = 2nd
              const a = covering[0], b = covering[1];
              const ca = LV_COLORS[(TYPE_META[a.type] || {}).cls] || LV_COLORS['lv-annual'];
              const cb = LV_COLORS[(TYPE_META[b.type] || {}).cls] || LV_COLORS['lv-annual'];
              const bgA = a.status === 'approved' ? ca.solid : ca.faint;
              const bgB = b.status === 'approved' ? cb.solid : cb.faint;
              const token = l => l.durationType === 'hours' ? `${l.amount}h` : (LV_ABBR[l.type] || (l.type || '').toUpperCase());
              const mixed = a.status !== b.status;
              const style = `background-image:linear-gradient(135deg, ${bgA} 0%, ${bgA} 49.5%, #ffffff 49.5%, #ffffff 50.5%, ${bgB} 50.5%, ${bgB} 100%);`
                  + (mixed ? `color:#1f2937;text-shadow:0 1px 2px rgba(255,255,255,0.7);` : '');
              html += `<td class="lv lv-split ${extraCls}" style="${style}" title="${escapeHtml(fullName + titleText)}">${escapeHtml(covering.map(token).join('+'))}</td>`;
          }
      } else html += `<td class="${extraCls}"></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody>`; 
  
  table.innerHTML = html;
  
  table.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', () => {
        tr.classList.toggle('row-highlighted');
      });
      // 🆕 Double-click to open monthly schedule modal
      tr.addEventListener('dblclick', () => {
          const empId = tr.dataset.empId;
          if (empId) openEmpScheduleModal(empId);
      });
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

// ============ 🆕 EMPLOYEE SCHEDULE MODAL (OVERVIEW DBL-CLICK) ============
async function openEmpScheduleModal(empId) {
    const emp = employees[empId];
    if (!emp) return;
    
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    const monthLabel = viewDate.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' });
    
    setText('empScheduleModalTitle', `${emp.englishName || emp.chineseName || 'Employee'} — ${monthLabel}`);
    
    const grid = $('empScheduleCalGrid');
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:2rem; color:var(--text-light);">Loading schedule...</div>';
    openModal('empScheduleModal');
    
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let html = '';
    
    // 1. Headers (Respects i18n)
    for (let i = 0; i < 7; i++) {
        const isWknd = i === 0 || i === 6;
        html += `<div class="emp-schedule-cal-header ${isWknd ? 'weekend' : ''}">${DOW[i]}</div>`;
    }
    
    // 2. Empty slots before 1st of month
    const firstDay = new Date(y, m, 1).getDay();
    for (let i = 0; i < firstDay; i++) {
        html += `<div class="emp-schedule-cal-cell empty-slot"></div>`;
    }
    
    // 3. Fetch schedules for all days in parallel (uses cache if admin)
    const todayStr = fmtISO(new Date());
    const schedulesByDate = {};
    const promises = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
        promises.push(
            getEmpScheduleForDate(empId, ds).then(sched => {
                schedulesByDate[ds] = sched;
            })
        );
    }
    await Promise.all(promises);
    // 🆕 Make sure holiday data is loaded (same source the Overview uses)
    if (!Object.keys(centerCalendars).length) await loadCenterCalendars();  
    
    // 4. Get leaves for this employee in this month
    const monthStart = `${y}-${pad(m + 1)}-01`;
    const monthEnd = `${y}-${pad(m + 1)}-${pad(daysInMonth)}`;
    const empLeaves = Object.values(leaves).filter(l => 
        l.empId === empId && 
        (l.status === 'approved' || l.status === 'pending') && 
        l.dateFrom <= monthEnd && l.dateTo >= monthStart
    );
    
    const typeAbbr = { annual: 'AL', sick: 'SL', unpaid: 'UL', pt: 'PT' };
    
    // 5. Render days
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(y, m, d);
        const ds = fmtISO(dt);
        const dow = dt.getDay();
        const isWknd = dow === 0 || dow === 6;
        const isToday = ds === todayStr;
        const holiday = getPublicHolidayForEmp(empId, ds); 
        
        let cellClasses = 'emp-schedule-cal-cell';
        if (isWknd) cellClasses += ' weekend';
        if (isToday) cellClasses += ' today';
        if (holiday) cellClasses += ' holiday';
        
        html += `<div class="${cellClasses}">`;
        html += `<div class="emp-schedule-day-num">${d}</div>`;
        html += `<div class="emp-schedule-cell-body">`;
        
        const sched = schedulesByDate[ds];
        if (sched && sched.shifts && sched.shifts.length > 0) {
            const sortedShifts = [...sched.shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
            sortedShifts.forEach(shift => {
                if (shift.type === 'break') {
                    html += `<div class="emp-schedule-shift" style="color:#999;font-style:italic;">☕ ${shift.start}-${shift.end}</div>`;
                } else {
                    const cId = shift._center || shift.center;
                    const abbr = getCenterAbbr(cId);
                    const cls = `c-${abbr}`;
                    html += `<div class="emp-schedule-shift">${shift.start}-${shift.end} <span class="emp-schedule-center ${cls}">${abbr}</span></div>`;
                }
            });
        } else if (sched && sched.status === 'off') {
            html += `<div style="color:#999;font-weight:600;font-size:0.75rem;">OFF</div>`;
        } else {
            html += `<div style="color:#ccc;">—</div>`;
        }
        
        // 🆕 Holiday chip (same behavior as the Overview calendar)
        if (holiday) {
            html += `<div class="emp-schedule-holiday">🎌 ${escapeHtml(holiday.name || t('publicHoliday'))}</div>`;
        }

        html += `</div>`; // end body
        
        // 6. Overlay Leaves (Semi-transparent)
        const dayLeaves = empLeaves.filter(l => l.dateFrom <= ds && l.dateTo >= ds);
        if (dayLeaves.length > 0) {
            // Prioritize approved over pending if both somehow exist on the same day
            dayLeaves.sort((a, b) => (a.status === 'approved' ? -1 : 1) - (b.status === 'approved' ? -1 : 1));
            const lv = dayLeaves[0];
            let overlayClass = 'leave-overlay ' + lv.status;
            let overlayText = typeAbbr[lv.type] || (lv.type || '').toUpperCase();
            let overlayStyle = '';
            if (dayLeaves.length > 1) {
                // 🆕 Combined overlay: diagonal split of both type colors + combined text
                const tok = l => `${l.durationType === 'hours' ? l.amount + 'h ' : ''}${typeAbbr[l.type] || (l.type || '').toUpperCase()}`;
                const cA = LV_OVERLAY[dayLeaves[0].type] || 'rgba(70,130,180,0.25)';
                const cB = LV_OVERLAY[dayLeaves[1].type] || 'rgba(70,130,180,0.25)';
                const stripes = lv.status === 'pending' ? 'repeating-linear-gradient(45deg, rgba(180,83,9,0.15) 0 4px, transparent 4px 8px), ' : '';
                overlayStyle = ` style="background:${stripes}linear-gradient(135deg, ${cA} 0 50%, ${cB} 50% 100%);font-size:0.72rem;"`;
                overlayText = dayLeaves.map(tok).join(' + ');
            } else if (lv.durationType === 'hours') {
                overlayClass += ' hourly';
                overlayText = `${lv.amount}h ${overlayText}`;
            }
            html += `<div class="${overlayClass}"${overlayStyle}>${overlayText}</div>`;
        }
        
        html += `</div>`; // end cell
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
  if (!empId || !employees[empId]) { sel.innerHTML = `<option value="">${currentUser.isAdmin ? escapeHtml(t('selectEmployeeFirst')) : '—'}</option>`; updateBalancePanel(); return; }
  const prevSelected = sel.value; const opts = buildTypeOptions(employees[empId], empId, year);
  sel.innerHTML = opts.map(o => `<option value="${o.key}" ${o.disabled ? 'disabled' : ''}>${escapeHtml(o.text)}</option>`).join('');
  const prevStillValid = prevSelected && opts.some(o => o.key === prevSelected && !o.disabled);
  const first = opts.find(o => !o.disabled);
  sel.value = prevStillValid ? prevSelected : (first ? first.key : '');
  if (opts.some(o => o.showHint) && hint) { hint.textContent = t('unpaidHint', { year }); hint.classList.remove('hidden'); }
  updateBalancePanel();
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
  if (!typeKey || !emp || !TYPE_META[typeKey]) { box.classList.add('hidden'); return; }
  if (typeKey === 'unpaid') { box.innerHTML = `<div class="balance-title">${escapeHtml(t('typeUnpaid'))}</div><div style="font-size:0.85rem;color:var(--text-light);">${escapeHtml(t('unpaidNotDeducted'))}</div>`; box.classList.remove('hidden'); return; }
  const b = getBalancesForYear(emp, empId, year); const map = { annual: b.annual, sick: b.sick, pt: b.timeOff }; const d = map[typeKey]; if (!d) { box.classList.add('hidden'); return; }
  const noBalanceNeeded = typeKey === 'pt'; let afterHtml = '';
  const draft = await computeRequestDraft();
  
  if (draft) {
    const deductInYear = (draft.daysPerYear && draft.daysPerYear[year] !== undefined) ? draft.daysPerYear[year] : draft.deductDays;
    const after = round2(d.balance - deductInYear);
    const skippedNote = draft.skipped?.length ? ` ${t('restDaysNote', { count: draft.skipped.length })}` : '';
    const splitNote = (draft.daysPerYear && Object.keys(draft.daysPerYear).length > 1) ? ` ${t('spansYearsNote')}` : '';
    const amountStr = draft.durationType === 'hours' ? `${draft.amount} ${t('hrUnit')}` : `${deductInYear} ${t('dayUnit')}`;
    afterHtml = `<div class="balance-after ${(after < 0 && !noBalanceNeeded) ? 'low' : ''}">${escapeHtml(t('balanceAfter', { year, amount: amountStr, skipped: skippedNote, split: splitNote }))}<strong>${after}</strong>${noBalanceNeeded ? ` <small>${escapeHtml(t('noBalanceNeededPT'))}</small>` : (after < 0 ? escapeHtml(t('exceedsBalance')) : '')}</div>`;

    // 🆕 Show toggle if balance is exceeded, user is full-time, and applying for days
    let excessToggleHtml = '';
    if (after < 0 && !isPartTime(emp) && draft.durationType === 'days') {
        const excessDays = round2(Math.abs(after));
        applyExcessAsUnpaid = false; // Reset state
        excessToggleHtml = `
            <div class="unpaid-excess-toggle">
                <label>
                    <input type="checkbox" id="applyExcessUnpaidCb">
                    ${t('applyExcessUnpaid', { days: excessDays })}
                </label>
            </div>
        `;
    } else {
        applyExcessAsUnpaid = false;
    }

    const yearNote = year !== new Date().getFullYear() ? `<div class="hint">${escapeHtml(t('yearNote', { year }))}</div>` : '';
    box.innerHTML = `
        <div class="balance-title">${escapeHtml(t('entitlementTitle', { label: TYPE_META[typeKey].label, year }))}</div>
        <div class="balance-grid">
            <div><label>${escapeHtml(t('entitledLabel'))}</label><span>${round2(d.entitled)}</span></div>
            <div><label>${escapeHtml(t('usedInYear', { year }))}</label><span>${round2(d.used)}</span></div>
            <div><label>${escapeHtml(t('balanceLabel'))}</label><span class="bal">${round2(d.balance)}</span></div>
        </div>
        ${yearNote}
        ${afterHtml}
        ${excessToggleHtml}
    `;
    box.classList.remove('hidden');

    // 🆕 Wire up the new checkbox
    const cb = $('applyExcessUnpaidCb');
    if (cb) {
        cb.addEventListener('change', (e) => {
            applyExcessAsUnpaid = e.target.checked;
        });
    }
  } else {
    // Fallback if no draft
    const yearNote = year !== new Date().getFullYear() ? `<div class="hint">${escapeHtml(t('yearNote', { year }))}</div>` : '';
    box.innerHTML = `<div class="balance-title">${escapeHtml(t('entitlementTitle', { label: TYPE_META[typeKey].label, year }))}</div><div class="balance-grid"><div><label>${escapeHtml(t('entitledLabel'))}</label><span>${round2(d.entitled)}</span></div><div><label>${escapeHtml(t('usedInYear', { year }))}</label><span>${round2(d.used)}</span></div><div><label>${escapeHtml(t('balanceLabel'))}</label><span class="bal">${round2(d.balance)}</span></div></div>${yearNote}`;
    box.classList.remove('hidden');
  }
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
  if (!file.type.startsWith('image/')) { alert(t('attachImage')); e.target.value = ''; return; }
  try {
    preview?.classList.remove('hidden'); if (preview) preview.innerHTML = `<span class="attachment-meta">${escapeHtml(t('compressing'))}</span>`;
    pendingAttachment = await compressImage(file);
    if (preview) preview.innerHTML = `<img src="${pendingAttachment.dataUrl}" alt="attachment preview"><div class="attachment-meta">${escapeHtml(pendingAttachment.name)}<br>≈ ${pendingAttachment.sizeKB} KB</div><button class="secondary" type="button" id="removeAttBtn">${escapeHtml(t('remove'))}</button>`;
    $('removeAttBtn')?.addEventListener('click', () => { pendingAttachment = null; if ($('attachment')) $('attachment').value = ''; preview?.classList.add('hidden'); });
  } catch (err) { console.error(err); pendingAttachment = null; preview?.classList.add('hidden'); alert(t('imageFailed')); }
}

// ============ EMAILJS ============
function getManagerEmails() {
    const tos = new Set([AUTHORIZED_EMAIL.toLowerCase()]);
    Object.values(employees).forEach(e => {
        if (e.isDisabled) return;
        const email = String(e.email || '').trim().toLowerCase();
        if (!email) return;
        const pos = getEmpPositions(e).map(p => String(p || '').trim().toLowerCase());
        if (pos.includes('manager') || pos.includes('master admin')) tos.add(email);
    });
    return [...tos];
}

function emailjsConfigured() { return typeof emailjs !== 'undefined' && !EMAILJS_SERVICE_ID.startsWith('YOUR_') && !EMAILJS_TEMPLATE_ID.startsWith('YOUR_') && !EMAILJS_PUBLIC_KEY.startsWith('YOUR_'); }

// 🆕 Renamed to notifyLeaveEvent to include the employee
async function notifyLeaveEvent(leave, eventType) {
    if (!EMAIL_NOTIFICATIONS_ENABLED || !emailjsConfigured()) return;
    try {
        // Use a Set to prevent duplicate emails
        const tos = new Set(getManagerEmails());
        
        // 🆕 Add the employee who applied for the leave to the recipients
        const empEmail = employees[leave.empId]?.email?.trim().toLowerCase();
        if (empEmail) {
            tos.add(empEmail);
        }
        
        const uniqueTos = [...tos];
        if (!uniqueTos.length) return;
        
        const subjects = {
            new: `🏖️ New Leave Request — ${leave.empName} (${leave.typeLabel})`,
            approved: `✅ Leave APPROVED — ${leave.empName} (${leave.typeLabel})`,
            rejected: `❌ Leave REJECTED — ${leave.empName} (${leave.typeLabel})`
        };
        const actionLabel = { new: 'New application (PENDING)', approved: 'APPROVED', rejected: 'REJECTED' }[eventType] || eventType;
        
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email: uniqueTos.join(','), // 🆕 Send to managers + employee
            subject: subjects[eventType] || subjects.new,
            action: actionLabel,
            acted_by: eventType === 'new' ? (leave.appliedByName || '-') : (currentUser?.email || '-'),
            employee_name: leave.empName || '-',
            leave_type: leave.typeLabel || leave.type || '-',
            dates: `${leave.dateFrom} → ${leave.dateTo}`,
            duration: leave.durationType === 'hours' ? `${leave.amount} hr(s) (${leave.timeFrom}–${leave.timeTo})` : `${leave.amount} day(s)`,
            reason: leave.reason || '-',
            applied_by: leave.appliedByName || '-'
        }, { publicKey: EMAILJS_PUBLIC_KEY });
    } catch (err) {
        console.warn('Leave notification failed:', err?.text || err);
    }
}

// ============ SUBMIT LEAVE ============
async function submitLeave() {
  const empId = selectedApplyEmpId(); if (!empId || !employees[empId]) return alert(t('selectEmployeeAlert'));
  const emp = employees[empId]; const type = $('leaveType')?.value; if (!type || !TYPE_META[type]) return alert(t('selectTypeAlert'));
  const dateFrom = $('dateFrom')?.value; let dateTo = $('dateTo')?.value || dateFrom; if (!dateFrom) return alert(t('selectDateFromAlert'));
  const durationType = document.querySelector('input[name="durationType"]:checked')?.value || 'days';
  let amount, deductDays, timeFrom = '', timeTo = '', skipped = []; let daysPerYear = null;
  if (durationType === 'hours') {
    dateTo = dateFrom; timeFrom = $('timeFrom')?.value || ''; timeTo = $('timeTo')?.value || '';
    if (!isValidTimeString(timeFrom) || !isValidTimeString(timeTo)) return alert(t('invalidTimesAlert'));
    const f = timeToMinutes(timeFrom), tv = timeToMinutes(timeTo);
    if (f === null || tv === null) return alert(t('enterTimesAlert')); if (tv <= f) return alert(t('toAfterFromAlert'));
    if (await isDayOff(empId, dateFrom)) return alert(t('restDayNotRequired', { date: fmtDate(dateFrom), name: emp.englishName }));
    amount = round1((tv - f) / 60); deductDays = round2(amount / 8); if (amount <= 0) return alert(t('hourZeroAlert'));
    daysPerYear = { [parseInt(dateFrom.slice(0, 4), 10)]: deductDays };
  } else {
    const count = await countLeaveDays(empId, dateFrom, dateTo); skipped = count.skipped;
    if (count.days <= 0) { const offDayNames = [...count.weeklyOffDays].sort().map(i => DOW_NAMES[i]).join(' / '); return alert(t('allRestDays', { name: emp.englishName, days: offDayNames })); }
    amount = count.days; deductDays = count.days; daysPerYear = count.daysPerYear;
  }
  const reason = $('reason')?.value.trim(); if (!reason) return alert(t('reasonRequired'));
  if (dateTo < dateFrom) return alert(t('dateToBeforeFromAlert'));
  const conflict = Object.values(leaves).find(l => l.empId === empId && (l.status === 'pending' || l.status === 'approved') && leaveDateRangeOverlaps(l, dateFrom, dateTo, durationType, timeFrom, timeTo));
  if (conflict) return alert(t('duplicateAlert', { name: emp.englishName, type: TYPE_META[conflict.type]?.label || conflict.type, status: statusLabel(conflict.status), from: fmtDate(conflict.dateFrom), to: fmtDate(conflict.dateTo) }));
  const ledgerField = TYPE_META[type].ledger;
  // 🆕 MODIFIED: Skip strict balance block ONLY if applying excess as unpaid AND it's a days request
  const canSkipBalanceCheck = applyExcessAsUnpaid && !isPartTime(emp) && durationType === 'days';
  
  if (!canSkipBalanceCheck && (ledgerField === 'annualUsed' || ledgerField === 'sickUsed')) {
        for (const [yr, daysInYr] of Object.entries(daysPerYear || {})) {
            const yearNum = parseInt(yr, 10); 
            const b = getBalancesForYear(emp, empId, yearNum); 
            const bal = ledgerField === 'annualUsed' ? b.annual : b.sick;
            if (daysInYr > bal.balance + 0.001) return alert(t('insufficientBalanceAlert', { label: TYPE_META[type].label, year: yearNum, balance: bal.balance, days: daysInYr }));
        }
    }
    const applicantName = currentUser.isAdmin ? `${employees[currentUser.empId]?.englishName || currentUser.email || 'Admin'} ${t('onBehalf')}` : (emp.englishName || '');

    // Base data template
    const baseLeaveData = {
        empId, empName: emp.englishName || '', empChinese: emp.chineseName || '',
        durationType, reason, attachment: pendingAttachment || null, status: 'pending',
        appliedBy: currentUser.uid, appliedByName: applicantName, appliedAt: new Date().toISOString()
    };

    let leaveRecordsToPush = [];

    // 🆕 SPLIT LOGIC: If excess unpaid is checked, split into two records
    if (applyExcessAsUnpaid && !isPartTime(emp) && durationType === 'days') {
        // Calculate total available balance across all involved years
        let totalAvailableBalance = 0;
        const yearsInvolved = Object.keys(daysPerYear || {});
        for (const yr of yearsInvolved) {
            const yBal = getBalancesForYear(emp, empId, parseInt(yr, 10));
            totalAvailableBalance += (ledgerField === 'annualUsed' ? yBal.annual : yBal.sick).balance;
        }
        
     const paidDays = Math.max(0, round2(totalAvailableBalance));
     const unpaidDays = round2(amount - paidDays);
     if (unpaidDays > 0 && paidDays > 0) {
         try {
             // Returns 2–4 records: whole paid days, hourly paid slice,
             // hourly unpaid slice (same day), remaining unpaid days
             leaveRecordsToPush = await getSplitLeaveRanges(empId, dateFrom, dateTo, paidDays, baseLeaveData, type);
         } catch (err) {
             // Fractional day has no shift → abort instead of silently dropping the paid slice
             return alert(err.message);
         }
     } else if (unpaidDays > 0 && paidDays === 0) {
            // Edge case: 0 balance, all days become unpaid
            leaveRecordsToPush.push({
                ...baseLeaveData,
                type: 'unpaid', typeLabel: TYPE_META.unpaid.label,
                dateFrom, dateTo, amount, deductDays,
                restDaysExcluded: skipped.join(', ') || '',
                daysPerYear, year: parseInt(dateFrom.slice(0, 4), 10)
            });
        } else {
            // Fallback
            leaveRecordsToPush.push({ ...baseLeaveData, type, typeLabel: TYPE_META[type].label, dateFrom, dateTo, amount, deductDays, restDaysExcluded: skipped.join(', ') || '', daysPerYear, year: parseInt(dateFrom.slice(0, 4), 10) });
        }
    } else {
        // Standard single record submission
        leaveRecordsToPush.push({
            ...baseLeaveData,
            type, typeLabel: TYPE_META[type].label,
            dateFrom, dateTo, timeFrom: timeFrom || '', timeTo: timeTo || '',
            amount, deductDays, restDaysExcluded: skipped.join(', ') || '',
            daysPerYear, year: parseInt(dateFrom.slice(0, 4), 10)
        });
    }

    const btn = $('submitLeaveBtn'); 
    if (btn) { btn.disabled = true; btn.textContent = t('submitting'); }

    try {
        for (const data of leaveRecordsToPush) {
            await push(ref(db, 'leaves'), data);
            notifyLeaveEvent(data, 'new');
        }
        
        closeModal('applyModal');
        
        // Custom success message if split
     if (leaveRecordsToPush.length > 1) {
         const parts = leaveRecordsToPush
             .map(r => `${r.amount} ${r.durationType === 'hours' ? t('hrUnit') : t('dayUnit')} ${r.typeLabel}`)
             .join(' + ');
         alert(t('splitLeaveSuccessParts', { parts }));
     } else {
            alert(t('submitted'));
        }
    } catch (err) {
        console.error(err);
        alert(t('submitFailed', { message: err.message }));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = t('submit'); }
    }
}


// ============ ENTITLEMENTS TAB ============
function populateEntEmpFilter() {
    const sel = $('entEmpFilter');
    if (!sel) return;
    const sorted = Object.entries(employees).filter(([_, e]) => !e.isDisabled).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
    sel.innerHTML = `<option value="all">${escapeHtml(t('allEmployees'))}</option>` + sorted.map(([id, e]) => `<option value="${id}">${escapeHtml(e.englishName || id)}</option>`).join('');
}

function renderEntitlementsTab() {
    const table = $('entitlementsTable');
    const tbody = table?.querySelector('tbody');
    if (!tbody) return;

    const searchInput = $('entEmpSearch');
    const query = searchInput?.value.trim().toLowerCase() || '';

    let empList = Object.entries(employees).filter(([id, e]) => !e.isDisabled);

    // Filter by search query (English name, Chinese name, or ID)
    if (query) {
        empList = empList.filter(([id, e]) => {
            const english = (e.englishName || '').toLowerCase();
            const chinese = (e.chineseName || '').toLowerCase();
            return english.includes(query) || chinese.includes(query) || id.toLowerCase().includes(query);
        });
    }

    empList.sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));

    if (empList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" class="empty-state">${escapeHtml(query ? 'No employees match your search.' : t('noEmployeesFound'))}</td></tr>`;
        return;
    }

    const year = entYear;
    let html = '';
    for (const [empId, emp] of empList) {
        const b = getBalancesForYear(emp, empId, year);
        // 🆕 FIX: show total approved unpaid days/hours for the selected year (e.g. "7d", "0.5h")
        const unpaidTotal = formatUnpaidTotal(getUnpaidTotalsForYear(empId, year));

        html += `
            <tr>
                <td data-label="${escapeHtml(t('thEmployee'))}">${escapeHtml(emp.englishName || '-')} ${emp.chineseName ? `<small>(${escapeHtml(emp.chineseName)})</small>` : ''}</td>
                <td data-label="Annual Ent">${b.annual.entitled}</td>
                <td data-label="Annual Used">${b.annual.used}</td>
                <td data-label="Annual Bal"><strong>${b.annual.balance}</strong></td>
                <td data-label="Sick Ent">${b.sick.entitled}</td>
                <td data-label="Sick Used">${b.sick.used}</td>
                <td data-label="Sick Bal"><strong>${b.sick.balance}</strong></td>
                <td data-label="PT Ent">${b.timeOff.entitled}</td>
                <td data-label="PT Used">${b.timeOff.used}</td>
                <td data-label="PT Bal"><strong>${b.timeOff.balance}</strong></td>
                <td data-label="${escapeHtml(t('thEntUnpaid'))}">${unpaidTotal}</td>
                <td data-label="${escapeHtml(t('thActions'))}">
                    <button class="icon-btn" data-action="edit-ent" data-id="${empId}" type="button">✏️ ${escapeHtml(t('editEntitlement'))}</button>
                </td>
            </tr>
        `;
    }
    tbody.innerHTML = html;
}

function openEditEntitlementModal(empId) {
    const emp = employees[empId];
    if (!emp) return;
    const le = emp.leaveEntitlement || {};
    $('editEntEmpName').textContent = `${emp.englishName || ''} ${emp.chineseName ? '(' + emp.chineseName + ')' : ''}`;
    $('entAnnual').value = le.annual || 0;
    $('entSick').value = le.sick || 0;
    $('entTimeOff').value = le.timeOff || 0;
    $('editEntitlementForm').dataset.empId = empId;
    openModal('editEntitlementModal');
}

async function saveEntitlement(e) {
    e.preventDefault();
    const empId = e.target.dataset.empId;
    if (!empId) return;

    const annual = parseFloat($('entAnnual').value) || 0;
    const sick = parseFloat($('entSick').value) || 0;
    const timeOff = parseFloat($('entTimeOff').value) || 0;

    try {
        await update(ref(db, `employees/${empId}/leaveEntitlement`), {
            annual, sick, timeOff,
            lastResetYear: new Date().getFullYear()
        });
        closeModal('editEntitlementModal');
        alert(t('entitlementUpdated'));
        renderEntitlementsTab();
        renderBalanceStrip();
    } catch (err) {
        console.error(err);
        alert(t('entitlementUpdateFailed'));
    }
}

function exportEntitlements() {
    if (typeof XLSX === 'undefined') return alert(t('excelNotLoaded')); // Reusing existing key
    const year = entYear;
    const empList = Object.entries(employees).filter(([_, e]) => !e.isDisabled).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));

    const rows = empList.map(([empId, emp]) => {
        const b = getBalancesForYear(emp, empId, year);
        const unpaid = getUnpaidTotalsForYear(empId, year); // 🆕 FIX: totals instead of record count
        return {
            'Employee': emp.englishName || '',
            'Chinese Name': emp.chineseName || '',
            'Annual Entitled': b.annual.entitled,
            'Annual Used': b.annual.used,
            'Annual Balance': b.annual.balance,
            'Sick Entitled': b.sick.entitled,
            'Sick Used': b.sick.used,
            'Sick Balance': b.sick.balance,
            'PT Entitled': b.timeOff.entitled,
            'PT Used': b.timeOff.used,
            'PT Balance': b.timeOff.balance,
            'Unpaid Leaves (Approved)': formatUnpaidTotal(unpaid)
        };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, `Entitlements ${year}`);
    XLSX.writeFile(wb, `Kumon_Entitlements_${year}.xlsx`);
}

// ============ 📋 WEEKLY REPORTS TAB (Master Admin only) ============
function getMondayOfWeek(d) {
    const dt = new Date(d);
    dt.setHours(0, 0, 0, 0);
    const dow = dt.getDay(); // 0 = Sunday
    dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow)); // rewind to Monday
    return dt;
}
let wrViewMonday = getMondayOfWeek(new Date());

function wrAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function wrFmtShort(d) { return d.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' }); }

function wrCenterCodes(empId) {
    const perms = employees[empId]?.permissions?.centers || {};
    return Object.keys(perms).filter(k => perms[k] === true).map(getCenterAbbr).join('/');
}

// Centers the employee is actually SCHEDULED at on a specific date
// (explicit schedule first → weekly pattern fallback)
function wrCentersForDate(empId, dateStr) {
    const centers = new Set();

    // 1) Explicit schedule for that exact date
    if (allSchedulesCache) {
        for (const cid of allCenterIds) {
            const rec = allSchedulesCache[cid]?.[empId]?.[dateStr];
            if (!rec) continue;
            const shifts = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});
            shifts.forEach(s => {
                if ((s.type || 'work') === 'work' && s.center && s.center !== 'other') centers.add(s.center);
            });
        }
    }

    // 2) Fall back to the weekly pattern (scheduleTemplates)
    if (!centers.size) {
        const dow = new Date(dateStr + 'T00:00:00').getDay();
        const tmpl = scheduleTemplates[empId]?.[dow];
        if (tmpl) {
            const shifts = Array.isArray(tmpl.shifts) ? tmpl.shifts : Object.values(tmpl.shifts || {});
            shifts.forEach(s => {
                if ((s.type || 'work') === 'work' && s.center && s.center !== 'other') centers.add(s.center);
            });
        }
    }
    return [...centers];
}

// Weekday label for a dow number (0=Sun ... 6=Sat), follows UI language
const WR_DOW_REF = new Date(2024, 0, 1); // a Monday
function wrDowLabel(dow) {
    const d = new Date(WR_DOW_REF);
    d.setDate(d.getDate() + ((dow + 6) % 7));
    return getDowAbbr(d);
}

// Compress a set of weekdays → "Tues-Fri", "Mon, Wed", "Sat-Sun"
function wrCompressDows(dows) {
    const ord = [...new Set(dows)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday-first
    const runs = [];
    let start = ord[0], prev = ord[0];
    for (let i = 1; i < ord.length; i++) {
        if (((ord[i] + 6) % 7) === ((prev + 6) % 7) + 1) prev = ord[i];
        else { runs.push([start, prev]); start = prev = ord[i]; }
    }
    runs.push([start, prev]);
    return runs.map(([a, b]) =>
        a === b ? wrDowLabel(a) : `${wrDowLabel(a)}-${wrDowLabel(b)}`
    ).join(', ');
}

// Full schedule-based center label for a leave record
function wrScheduleLabel(l) {
    const dates = [];
    if (l.durationType === 'hours') dates.push(l.dateFrom);
    else eachDate(l.dateFrom, l.dateTo, d => dates.push(fmtISO(d)));

    const dayCenters = {};
    dates.forEach(ds => {
        const cs = wrCentersForDate(l.empId, ds);
        if (cs.length) dayCenters[ds] = cs;
    });
    const covered = Object.keys(dayCenters);

    // Nothing scheduled anywhere in the range → keep old permission-based codes
    if (!covered.length) return wrCenterCodes(l.empId);

    // Single day → just the center(s), e.g. [MK] or [MK/PT]
    if (covered.length === 1) {
        return '[' + dayCenters[covered[0]].map(getCenterAbbr).join('/') + ']';
    }

    // Multi-day → group days by center: [MK(Tues-Fri) PT(Sat)]
    const byCenter = {};
    covered.forEach(ds => dayCenters[ds].forEach(c => (byCenter[c] = byCenter[c] || []).push(ds)));
    const parts = Object.entries(byCenter)
        .sort((a, b) => a[1][0].localeCompare(b[1][0])) // order by first day
        .map(([cid, ds]) =>
            `${getCenterAbbr(cid)}(${wrCompressDows(ds.map(d => new Date(d + 'T00:00:00').getDay()))})`);
    return '[' + parts.join(' ') + ']';
}

function wrEmpLabel(l) {
    const name = [l.empChinese, l.empName].filter(Boolean).join(' ');
    const c = wrScheduleLabel(l);   // 👈 was wrCenterCodes(l.empId)
    return c ? `${name} ${c}` : name;
}

function wrDatesText(l) {
    const dowA = getDowAbbr(new Date(l.dateFrom + 'T00:00:00'));
    if (l.durationType === 'hours') {
        const times = (l.timeFrom && l.timeTo) ? ` ${l.timeFrom}–${l.timeTo}` : '';
        return `${l.dateFrom} (${dowA})${times} · ${l.amount}h`;
    }
    if (l.dateFrom === l.dateTo) return `${l.dateFrom} (${dowA})`;
    const dowB = getDowAbbr(new Date(l.dateTo + 'T00:00:00'));
    return `${l.dateFrom} (${dowA}) to ${l.dateTo} (${dowB})`;
}

function getWeekLeaves(monday) {
    const ws = fmtISO(monday), we = fmtISO(wrAddDays(monday, 6));
    return Object.values(leaves)
        .filter(l => (l.status === 'approved' || l.status === 'pending') && l.dateFrom <= we && l.dateTo >= ws)
        .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || (a.empName || '').localeCompare(b.empName || ''));
}

function wrTitles(monday) {
    return {
        this: t('wrThisWeekTitle', { start: wrFmtShort(monday), end: wrFmtShort(wrAddDays(monday, 6)) }),
        next: t('wrNextWeekTitle', { start: wrFmtShort(wrAddDays(monday, 7)), end: wrFmtShort(wrAddDays(monday, 13)) })
    };
}

// Plain-text version (what gets copied)
function wrSectionText(title, monday) {
    const lines = getWeekLeaves(monday);
    let txt = title + '\n';
    txt += lines.length
        ? lines.map((l, i) => `${i + 1}. ${wrEmpLabel(l)} ${wrDatesText(l)}${l.status === 'pending' ? ' ' + t('wrPendingTag') : ''}`).join('\n')
        : t('wrNoLeaves');
    return txt;
}

function renderWeeklyReports() {
    if (!currentUser?.isMaster) return;
    const monday = wrViewMonday;
    const titles = wrTitles(monday);
    setText('wrWeekLabel', `${wrFmtShort(monday)} – ${wrFmtShort(wrAddDays(monday, 6))}, ${monday.getFullYear()}`);
    setText('wrThisWeekTitle', titles.this);
    setText('wrNextWeekTitle', titles.next);
    renderWrList('wrThisWeekList', getWeekLeaves(monday));
    renderWrList('wrNextWeekList', getWeekLeaves(wrAddDays(monday, 7)));
}

function renderWrList(elId, list) {
    const el = $(elId); if (!el) return;
    if (!list.length) {
        el.innerHTML = `<div class="wr-empty">${escapeHtml(t('wrNoLeaves'))}</div>`;
        return;
    }
    el.innerHTML = list.map((l, i) => {
        const badge = l.status === 'pending'
            ? `<span class="status-badge pending">${escapeHtml(statusLabel('pending'))}</span>` : '';
        return `<div class="wr-line${l.status === 'pending' ? ' pending' : ''}"><span class="wr-num">${i + 1}.</span><span class="wr-text"><strong>${escapeHtml(wrEmpLabel(l))}</strong> · ${escapeHtml(wrDatesText(l))}</span>${badge}</div>`;
    }).join('');
}

async function copyToClipboard(text, btn) {
    let ok = false;
    try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch (e) { /* fall through to legacy method */ }
    if (!ok) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            ta.remove();
        } catch (e) { ok = false; }
    }
    if (!ok) { alert(t('wrCopyFailed')); return; }
    if (btn) {
        const orig = btn.textContent;
        btn.textContent = t('wrCopied');
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }
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
  $('leaveType')?.addEventListener('change', updateBalancePanel);
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
    $('entEmpSearch')?.addEventListener('input', () => {
        clearTimeout(entSearchTimer);
        entSearchTimer = setTimeout(renderEntitlementsTab, 150);
    });

    // Year Pager for Entitlements
    $('entYearPrev')?.addEventListener('click', () => {
        entYear--;
        setText('entYearLabel', entYear);
        renderEntitlementsTab();
    });
    $('entYearNext')?.addEventListener('click', () => {
        entYear++;
        setText('entYearLabel', entYear);
        renderEntitlementsTab();
    });
  $('exportEntitlementsBtn')?.addEventListener('click', exportEntitlements);
  $('entitlementsTable')?.addEventListener('click', e => {
      const btn = e.target.closest('button[data-action="edit-ent"]');
      if (btn) openEditEntitlementModal(btn.dataset.id);
  });

  // 📋 Weekly Reports controls
  $('wrPrev')?.addEventListener('click', () => { wrViewMonday = wrAddDays(wrViewMonday, -7); renderWeeklyReports(); });
  $('wrNext')?.addEventListener('click', () => { wrViewMonday = wrAddDays(wrViewMonday, 7); renderWeeklyReports(); });
  $('wrThisWeekBtn')?.addEventListener('click', () => { wrViewMonday = getMondayOfWeek(new Date()); renderWeeklyReports(); });
  $('wrCopyThis')?.addEventListener('click', e => {
      const titles = wrTitles(wrViewMonday);
      copyToClipboard(wrSectionText(titles.this, wrViewMonday), e.currentTarget);
  });
  $('wrCopyNext')?.addEventListener('click', e => {
      const titles = wrTitles(wrViewMonday);
      copyToClipboard(wrSectionText(titles.next, wrAddDays(wrViewMonday, 7)), e.currentTarget);
  });
  $('wrCopyAll')?.addEventListener('click', e => {
      const titles = wrTitles(wrViewMonday);
      const txt = wrSectionText(titles.this, wrViewMonday) + '\n\n' + wrSectionText(titles.next, wrAddDays(wrViewMonday, 7));
      copyToClipboard(txt, e.currentTarget);
  });

  $('editEntitlementForm')?.addEventListener('submit', saveEntitlement);
  $('closeEditEntModal')?.addEventListener('click', () => closeModal('editEntitlementModal'));
  $('cancelEditEntBtn')?.addEventListener('click', () => closeModal('editEntitlementModal'));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal('applyModal');
      closeModal('attachmentModal');
      closeModal('approveModal');
      closeModal('editEntitlementModal');
      closeModal('empScheduleModal'); 
      closeMonthPicker();
    }
  });
}

function renderMonthPickerLabel() {
  setText('monthPickerLabel', monthFilter === 'all' ? t('allMonths', { year: currentYear }) : t('monthOnly', { month: MONTH_NAMES[monthFilter - 1], year: currentYear }));
}

function renderMonthGrid() {
  const grid = $('mpGrid');
  if (!grid) return;
  setText('mpYearLabel', pickerYear);
  grid.innerHTML = MONTH_NAMES.map((name, i) => {
    const m = i + 1;
    const active = (pickerYear === currentYear && monthFilter === m);
    return `<button type="button" class="mp-month${active ? ' active' : ''}" data-month="${m}">${name.slice(0, 3)}</button>`;
  }).join('');
}

function closeMonthPicker() {
  $('monthPickerPop')?.classList.add('hidden');
  $('monthPickerBtn')?.setAttribute('aria-expanded', 'false');
}

function applyMonthPick(monthOrAll) {
  currentYear = pickerYear;
  monthFilter = monthOrAll;
  closeMonthPicker();
  renderMonthPickerLabel();
  renderLeaveTable();
}

// ============================================================
// 🛠️ ONE-TIME HEAL — fixes leaves approved BEFORE the auto-trim fix
// ============================================================
async function healLegacyReliefOverlaps() {
  if (!currentUser?.isAdmin) { alert('Admin only.'); return; }
  let fixedShifts = 0, touchedLeaves = 0;
  const approved = Object.entries(leaves).filter(([_, l]) => l.status === 'approved' && l.reliefPlan);

  for (const [leaveId, l] of approved) {
    const plan = Array.isArray(l.reliefPlan) ? l.reliefPlan : Object.values(l.reliefPlan || {});
    let planChanged = false;

    for (const dayPlan of plan) {
      const relievers = Array.isArray(dayPlan?.relievers) ? dayPlan.relievers : Object.values(dayPlan?.relievers || {});
      for (const rel of relievers) {
        if (!rel?.relieverId || !rel?.newShift) continue;
        if (Array.isArray(rel.adjustments)) continue; // processed by new code already → skip

        const ns = rel.newShift;
        const sched = await getEmpScheduleForDate(rel.relieverId, dayPlan.date);

        const adjustments = [];
        (sched.shifts || []).forEach(s => {
          if ((s.type || 'work') !== 'work') return;
          if (s.start === ns.start && s.end === ns.end && (s._center || s.center) === ns.center) return; // skip the relief shift itself
          const parts = trimShiftAround(s, ns);
          if (parts.length === 1 && parts[0].start === s.start && parts[0].end === s.end) return;
          const center = s._center || s.center || ns.center;
          adjustments.push({
            center,
            before: { type: 'work', start: s.start, end: s.end, center: s.center || center, otherDesc: s.otherDesc || '' },
            after:  parts.map(p => ({ type: 'work', start: p.start, end: p.end, center: s.center || center, otherDesc: s.otherDesc || '' }))
          });
        });

        const byCenter = {};
        adjustments.forEach(a => { (byCenter[a.center] = byCenter[a.center] || []).push(a); });

        for (const [center, list] of Object.entries(byCenter)) {
          const snap = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`));
          const rec = snap.val() || { status: 'scheduled', shifts: [], notes: '' };
          let arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});

          if (!snap.exists()) {
            const dow = new Date(dayPlan.date + 'T00:00:00').getDay();
            const tmpl = scheduleTemplates[rel.relieverId]?.[dow];
            const tShifts = (tmpl && Array.isArray(tmpl.shifts)) ? tmpl.shifts : [];
            const empCenters = getEmpCenterIds(rel.relieverId);
            arr = tShifts
              .map(sh => ({ ...sh, center: sh.center || empCenters[0] || allCenterIds[0] }))
              .filter(sh => sh.center === center);
          }

          let changed = false;
          list.forEach(a => {
            const hasBefore = arr.some(sh => (sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end);
            if (!hasBefore) return; // already fixed by hand → don't touch
            arr = arr.filter(sh => !((sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end));
            arr = arr.concat(a.after);
            changed = true;
          });

          if (changed) {
            await update(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`), {
              status: rec.status || 'scheduled', shifts: arr, notes: rec.notes || '',
              updatedBy: currentUser.uid, updatedAt: new Date().toISOString()
            });
            fixedShifts++;
          }
        }

        rel.adjustments = adjustments; // backfill so CANCEL restores correctly later
        planChanged = true;
      }
    }

    if (planChanged) {
      await update(ref(db, `leaves/${leaveId}`), { reliefPlan: plan });
      touchedLeaves++;
    }
  }

  alert(`🛠️ Done. Fixed ${fixedShifts} overlapped shift(s) across ${touchedLeaves} old leave record(s).`);
  refreshAll();
}

// ============================================================
// 🚫 CANCEL REQUEST TAB — append-only module
// Requests live at leaves/{id}/cancellationRequest; the leave
// keeps status 'approved' until an admin approves the request.
// ============================================================
let cxCurrentLeaveId = null, cxReviewLeaveId = null;

/* ---------- i18n helper with safe English fallbacks ---------- */
function cxT(key, vars = {}, fallback = key) {
  let v = null;
  try { v = t(`cx_${key}`, vars); } catch (e) { /* key missing */ }
  if (typeof v === 'string' && v && v !== `cx_${key}`) return v;
  return String(fallback).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
}
function cxCurrentUserName() {
  if (currentUser?.empId && employees[currentUser.empId]?.englishName) return employees[currentUser.empId].englishName;
  return currentUser?.email || 'Admin';
}

/* ---------- helpers ---------- */
function cxGetWorkingDays(l) {
  if (!l?.dateFrom) return [];
  if (l.durationType === 'hours') return [l.dateFrom];
  const skipped = new Set((l.restDaysExcluded || '').split(',').map(s => s.trim()).filter(Boolean));
  const days = [];
  eachDate(l.dateFrom, l.dateTo, d => { const ds = fmtISO(d); if (!skipped.has(ds)) days.push(ds); });
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
    rels.forEach(r => {
      if (r?.relieverName) names.add(r.relieverName);
      else if (r?.relieverId && employees[r.relieverId]?.englishName) names.add(employees[r.relieverId].englishName);
    });
  });
  return [...names];
}
function cxLeaveHasFuture(l) { return (l.dateTo || l.dateFrom) >= todayStr(); }
function cxScopeText(l, req) {
  const total = cxGetWorkingDays(l).length;
  if (req.scope === 'full' || (req.dates || []).length >= total) return cxT('fullScopeShort', {}, 'ENTIRE leave');
  return cxT('partialScopeShort', { n: (req.dates || []).length, total }, '{{n}} of {{total}} day(s)');
}

/* ---------- rendering ---------- */
function renderCancelTab() {
  if (!currentUser) return;
  const admin = currentUser.isAdmin;
  const queueWrap = $('cxAdminQueueWrap');
  if (admin) { queueWrap?.classList.remove('hidden'); renderCxQueue(); } else queueWrap?.classList.add('hidden');
  const myWrap = $('cxMyLeavesWrap');
  // 🚫 Master Admin (kumonchamps) is not an employee → no personal list
  if (!currentUser.isMaster && currentUser.empId && employees[currentUser.empId]) { myWrap?.classList.remove('hidden'); renderCxMyLeaves(); }
  else myWrap?.classList.add('hidden');
  renderCxHistory(admin);
  renderCxTabBadge();
}
function cxMaybeRender() {
  if (!currentUser) return;
  if ($('main-tab-cancelrequests')?.classList.contains('active')) renderCancelTab();
  else renderCxTabBadge();
}
function renderCxTabBadge() {
  if (!currentUser) return;
  const btn = document.querySelector('[data-main-tab="cancelrequests"]');
  if (!btn) return;
  const count = Object.values(leaves).filter(l =>
    l.status === 'approved' && l.cancellationRequest?.status === 'pending' &&
    (currentUser.isAdmin || l.empId === currentUser.empId)
  ).length;
  let badge = btn.querySelector('.cx-badge');
  if (!count) { badge?.remove(); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'cx-badge'; btn.appendChild(badge); }
  badge.textContent = count;
}
function renderCxQueue() {
  const el = $('cxAdminQueue'); if (!el) return;
  const pending = Object.entries(leaves).map(([id, l]) => ({ id, ...l }))
    .filter(l => l.status === 'approved' && l.cancellationRequest?.status === 'pending')
    .sort((a, b) => (a.cancellationRequest.requestedAt || '').localeCompare(b.cancellationRequest.requestedAt || ''));
  setText('cxQueueTitle', `${cxT('queueTitle', {}, '⏳ Pending cancellation requests')} (${pending.length})`);
  if (!pending.length) { el.innerHTML = `<div class="cx-empty">${escapeHtml(cxT('noPending', {}, 'No pending cancellation requests. 🎉'))}</div>`; return; }
  el.innerHTML = pending.map(l => {
    const req = l.cancellationRequest; const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const relievers = cxAffectedRelievers(l, req.dates);
    return `<div class="cx-card pending">
      <div class="cx-card-main">
        <div class="cx-card-title"><span class="type-dot lv ${meta.cls} approved"></span><strong>${escapeHtml(l.empName || '-')}</strong> · ${escapeHtml(meta.label)}</div>
        <div class="cx-card-sub">${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}</div>
        <div class="cx-card-sub">🚫 <strong>${escapeHtml(cxScopeText(l, req))}</strong>${req.scope !== 'full' ? ': ' + (req.dates || []).map(fmtDateShort).join(', ') : ''}</div>
        <div class="cx-card-reason">💬 ${escapeHtml(req.reason || '')}</div>
        <div class="cx-card-meta">${escapeHtml(cxT('requestedBy', {}, 'Requested by'))} ${escapeHtml(req.requestedByName || '-')} · ${req.requestedAt ? new Date(req.requestedAt).toLocaleString() : ''}${relievers.length ? '<br>👥 ' + escapeHtml(cxT('relieversAffected', { names: relievers.join(', ') }, 'Reliever(s) affected: {{names}}')) : ''}</div>
      </div>
      <div class="cx-card-actions"><button class="primary" data-cx="review" data-id="${escapeHtml(l.id)}" type="button">👁 ${escapeHtml(cxT('review', {}, 'Review'))}</button></div>
    </div>`;
  }).join('');
}
function renderCxMyLeaves() {
  const el = $('cxMyLeaves'); if (!el) return;
  const mine = Object.entries(leaves).map(([id, l]) => ({ id, ...l }))
    .filter(l => l.empId === currentUser.empId && l.status === 'approved' && cxLeaveHasFuture(l))
    .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
  setText('cxMyTitle', cxT('myTitle', {}, '🗓️ My approved leaves'));
  if (!mine.length) { el.innerHTML = `<div class="cx-empty">${escapeHtml(cxT('noApproved', {}, 'No approved leaves available for cancellation.'))}</div>`; return; }
  el.innerHTML = mine.map(l => {
    const req = l.cancellationRequest; const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const pending = req?.status === 'pending';
    const cancellable = cxGetWorkingDays(l).filter(ds => ds >= todayStr());
    const timeNote = l.durationType === 'hours' && l.timeFrom && l.timeTo ? ` (${l.timeFrom}–${l.timeTo})` : '';
    let action;
    if (pending) {
      action = `<span class="cx-chip pending">⏳ ${escapeHtml(cxT('reqPending', {}, 'Cancellation pending'))} · ${escapeHtml(cxScopeText(l, req))}</span>
        <button class="secondary" data-cx="withdraw" data-id="${escapeHtml(l.id)}" type="button">${escapeHtml(cxT('withdraw', {}, 'Withdraw'))}</button>`;
    } else if (!cancellable.length) {
      action = `<span class="cx-chip muted">${escapeHtml(cxT('allPast', {}, 'All dates passed'))}</span>`;
    } else {
      action = `<button class="danger" data-cx="request" data-id="${escapeHtml(l.id)}" type="button">🚫 ${escapeHtml(cxT('requestBtn', {}, 'Request cancellation'))}</button>`;
    }
    return `<div class="cx-card">
      <div class="cx-card-main">
        <div class="cx-card-title"><span class="type-dot lv ${meta.cls} approved"></span><strong>${escapeHtml(meta.label)}</strong></div>
        <div class="cx-card-sub">${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}${timeNote}${l.restDaysExcluded ? ' <small>' + escapeHtml(t('restExcluded')) + '</small>' : ''}</div>
      </div>
      <div class="cx-card-actions">${action}</div>
    </div>`;
  }).join('');
}
function renderCxHistory(admin) {
  const el = $('cxHistory'), wrap = $('cxHistoryWrap'); if (!el || !wrap) return;
  setText('cxHistoryTitle', cxT('historyTitle', {}, '🕓 Request history'));
  const items = Object.entries(leaves).map(([id, l]) => ({ id, ...l }))
    .filter(l => l.cancellationRequest && ['approved', 'rejected', 'withdrawn'].includes(l.cancellationRequest.status))
    .filter(l => admin || l.empId === currentUser.empId)
    .sort((a, b) => {
      const ta = a.cancellationRequest.reviewedAt || a.cancellationRequest.withdrawnAt || '';
      const tb = b.cancellationRequest.reviewedAt || b.cancellationRequest.withdrawnAt || '';
      return tb.localeCompare(ta);
    });
  if (!items.length) { wrap.classList.add('hidden'); el.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  el.innerHTML = items.slice(0, 30).map(l => {
    const req = l.cancellationRequest; const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const when = req.reviewedAt || req.withdrawnAt;
    const chipCls = req.status;
    const chipTxt = { approved: cxT('hApproved', {}, '✅ Cancelled'), rejected: cxT('hRejected', {}, '❌ Rejected'), withdrawn: cxT('hWithdrawn', {}, '↩️ Withdrawn') }[req.status] || req.status;
    return `<div class="cx-card h-${req.status}">
      <div class="cx-card-main">
        <div class="cx-card-title"><span class="type-dot lv ${meta.cls}"></span><strong>${escapeHtml(l.empName || '-')}</strong> · ${escapeHtml(meta.label)} · ${fmtDateShort(l.dateFrom)} → ${fmtDateShort(l.dateTo)}</div>
        <div class="cx-card-sub">🚫 ${escapeHtml(cxScopeText(l, req))} · 💬 ${escapeHtml(req.reason || '')}</div>
        <div class="cx-card-meta">${when ? new Date(when).toLocaleString() : ''}${req.reviewNote ? ' · 📝 ' + escapeHtml(req.reviewNote) : ''}${req.reviewedByName ? ' · ' + escapeHtml(req.reviewedByName) : ''}</div>
      </div>
      <div class="cx-card-actions"><span class="cx-chip ${chipCls}">${escapeHtml(chipTxt)}</span></div>
    </div>`;
  }).join('');
}

/* ---------- request modal (employee) ---------- */
async function openCxRequestModal(leaveId) {
  const l = leaves[leaveId];
  if (!l || l.status !== 'approved') return;
  if (l.cancellationRequest?.status === 'pending') return alert(cxT('alreadyPending', {}, '⚠️ A cancellation request is already pending for this leave.'));
  const futureDays = cxGetWorkingDays(l).filter(ds => ds >= todayStr());
  if (!futureDays.length) return alert(cxT('allPast', {}, 'All dates passed'));
  cxCurrentLeaveId = leaveId;
  const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
  const timeNote = l.durationType === 'hours' && l.timeFrom && l.timeTo ? ` (${l.timeFrom}–${l.timeTo})` : '';
  $('cxRequestSummary').innerHTML = `<span class="type-dot lv ${meta.cls} approved"></span><strong>${escapeHtml(meta.label)}</strong><br>${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}${timeNote}<br><em>${escapeHtml(l.reason || '')}</em>`;
  $('cxReason').value = '';
  renderCxDaysList(l);
  openModal('cxRequestModal');
  cxUpdateDayUI();
}
function renderCxDaysList(l) {
  const wrap = $('cxDaysWrap'), list = $('cxDaysList');
  const allDays = cxGetWorkingDays(l);
  if (allDays.length <= 1) { wrap.classList.add('hidden'); list.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  const tStr = todayStr(); const plan = cxReliefPlanByDate(l);
  list.innerHTML = allDays.map(ds => {
    const past = ds < tStr;
    return `<label class="cx-day-row${past ? ' past' : ''}">
      <input type="checkbox" class="cx-day-cb" value="${ds}" ${past ? 'disabled' : ''}>
      <span class="cx-day-date">${fmtDateWithDow(ds)}</span>
      ${plan[ds] ? `<span class="cx-day-shift">${escapeHtml(plan[ds])}</span>` : ''}
      ${past ? `<span class="cx-day-past">${escapeHtml(cxT('pastDay', {}, 'past'))}</span>` : ''}
    </label>`;
  }).join('');
  list.querySelectorAll('.cx-day-cb').forEach(cb => cb.addEventListener('change', cxUpdateDayUI));
}
function cxUpdateDayUI() {
  const l = leaves[cxCurrentLeaveId]; if (!l) return;
  const allDays = cxGetWorkingDays(l);
  const isSingle = allDays.length <= 1;
  const cbs = [...document.querySelectorAll('#cxDaysList .cx-day-cb')];
  const enabled = cbs.filter(c => !c.disabled);
  const selected = cbs.filter(c => c.checked);
  const selDates = isSingle ? allDays.filter(ds => ds >= todayStr()) : selected.map(c => c.value);
  const countEl = $('cxDayCount');
  if (countEl) countEl.textContent = isSingle ? '' : cxT('selectedCount', { n: selected.length, total: enabled.length }, '{{n}} of {{total}} selectable day(s)');
  const sa = $('cxSelectAllDays');
  if (sa) sa.checked = enabled.length > 0 && enabled.every(c => c.checked);
  renderCxImpact(l, selDates);
  const btn = $('cxSubmitRequestBtn'); if (btn) btn.disabled = !selDates.length;
}
function renderCxImpact(l, selDates) {
  const box = $('cxImpact'); if (!box) return;
  if (!l || !selDates.length) { box.innerHTML = ''; return; }
  const total = cxGetWorkingDays(l).length;
  const full = selDates.length === total;
  const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type };
  let refundText;
  if (l.type === 'unpaid') refundText = cxT('noBalanceUnpaid', {}, 'Unpaid leave — no balance will be restored.');
  else {
    const amt = l.durationType === 'hours'
      ? `${l.amount} ${cxT('hrs', {}, 'hr(s)')}`
      : `${selDates.length} ${cxT('daysUnit', {}, 'day(s)')}`;
    refundText = cxT('willRestore', { amt, label: meta.label }, '{{amt}} of {{label}} will be restored to the balance.');
  }
  const relievers = cxAffectedRelievers(l, selDates);
  box.innerHTML = `<strong>${full ? escapeHtml(cxT('fullScope', {}, 'FULL cancellation')) : escapeHtml(cxT('partialScope', {}, 'PARTIAL cancellation'))}</strong> · ${escapeHtml(refundText)}${relievers.length ? '<br>👥 ' + escapeHtml(cxT('relieversAffected', { names: relievers.join(', ') }, 'Reliever(s) affected: {{names}}')) : ''}<br><span class="cx-impact-note">${escapeHtml(cxT('impactNote', {}, 'The request will be sent to your manager for approval. Schedules and balances revert only after approval.'))}</span>`;
}
async function submitCxRequest() {
  const l = leaves[cxCurrentLeaveId];
  if (!l || l.status !== 'approved') return alert(cxT('missingRecord', {}, '❌ Missing leave record. Please close and reopen.'));
  if (l.cancellationRequest?.status === 'pending') return alert(cxT('alreadyPending', {}, '⚠️ A cancellation request is already pending.'));
  const reason = $('cxReason').value.trim();
  if (!reason) return alert(cxT('reasonReq', {}, '⚠️ A reason is required to cancel a leave.'));
  const allDays = cxGetWorkingDays(l);
  const multi = allDays.length > 1;
  const selDates = multi
    ? [...document.querySelectorAll('#cxDaysList .cx-day-cb:checked')].map(c => c.value)
    : allDays.filter(ds => ds >= todayStr());
  if (!selDates.length) return alert(cxT('pickDay', {}, '⚠️ Please select at least one day to cancel.'));
  const scope = selDates.length === allDays.length ? 'full' : 'partial';
  const btn = $('cxSubmitRequestBtn'); btn.disabled = true; btn.textContent = cxT('submitting', {}, 'Submitting...');
  try {
    const req = {
      status: 'pending', scope, dates: selDates.sort(), reason,
      requestedBy: currentUser.uid, requestedByName: cxCurrentUserName(), requestedAt: new Date().toISOString()
    };
    await update(ref(db, `leaves/${cxCurrentLeaveId}/cancellationRequest`), req);
    cxNotify(l, req, 'new');
    closeModal('cxRequestModal');
    alert(cxT('submitted', {}, '✅ Cancellation request submitted. A manager will review it.'));
  } catch (err) { console.error(err); alert(cxT('submitFailed', { message: err.message }, '❌ Failed to submit request: {{message}}')); }
  finally { btn.disabled = false; btn.textContent = cxT('submitBtn', {}, 'Submit request'); }
}
async function cxWithdraw(leaveId) {
  const l = leaves[leaveId];
  if (!l || l.cancellationRequest?.status !== 'pending') return;
  if (!confirm(cxT('withdrawConfirm', {}, 'Withdraw your cancellation request?'))) return;
  try {
    const patch = { status: 'withdrawn', withdrawnBy: currentUser.uid, withdrawnAt: new Date().toISOString() };
    await update(ref(db, `leaves/${leaveId}/cancellationRequest`), patch);
    cxNotify(l, { ...l.cancellationRequest, ...patch }, 'withdrawn');
  } catch (e) { console.error(e); alert(cxT('withdrawFailed', {}, '❌ Failed to withdraw the request.')); }
}

/* ---------- review modal (admin) ---------- */
function openCxReviewModal(leaveId) {
  const l = leaves[leaveId]; const req = l?.cancellationRequest;
  if (!l || !req || req.status !== 'pending') return;
  cxReviewLeaveId = leaveId;
  const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type };
  const working = cxGetWorkingDays(l);
  const plan = cxReliefPlanByDate(l);
  const rows = (req.dates || []).map(ds => `<div class="cx-day-row static"><span class="cx-day-date">${fmtDateWithDow(ds)}</span>${plan[ds] ? `<span class="cx-day-shift">${escapeHtml(plan[ds])}</span>` : ''}</div>`).join('');
  const refund = l.type === 'unpaid'
    ? cxT('noBalanceUnpaid', {}, 'Unpaid leave — no balance restored.')
    : cxT('willRestore', { amt: l.durationType === 'hours' ? `${l.amount} ${cxT('hrs', {}, 'hr(s)')}` : `${req.dates.length} ${cxT('daysUnit', {}, 'day(s)')}`, label: meta.label }, '{{amt}} of {{label}} will be restored.');
  const relievers = cxAffectedRelievers(l, req.dates);
  $('cxReviewBody').innerHTML = `
    <div class="cx-review-grid">
      <div><label>${escapeHtml(t('thEmployee'))}</label><strong>${escapeHtml(l.empName || '-')}</strong></div>
      <div><label>${escapeHtml(t('thLeaveType'))}</label><strong>${escapeHtml(meta.label)}</strong></div>
      <div><label>${escapeHtml(t('thFrom'))} → ${escapeHtml(t('thTo'))}</label>${fmtDateWithDow(l.dateFrom)} → ${fmtDateWithDow(l.dateTo)} · ${durationText(l)}</div>
      <div><label>${escapeHtml(cxT('requestedBy', {}, 'Requested by'))}</label>${escapeHtml(req.requestedByName || '-')} · ${req.requestedAt ? new Date(req.requestedAt).toLocaleString() : ''}</div>
      <div class="full"><label>${escapeHtml(t('thReason'))}</label>${escapeHtml(req.reason || '')}</div>
    </div>
    <div class="cx-impact"><strong>${req.scope === 'full' ? escapeHtml(cxT('fullScope', {}, 'FULL cancellation')) : escapeHtml(cxT('partialScope', {}, 'PARTIAL cancellation'))}</strong> — ${escapeHtml(cxScopeText(l, req))} (${(req.dates || []).length} of ${working.length})<br>${escapeHtml(refund)}${relievers.length ? '<br>👥 ' + escapeHtml(cxT('relieversAffected', { names: relievers.join(', ') }, 'Reliever(s) affected: {{names}}')) : ''}</div>
    <div class="cx-days-list" style="margin-top:0.75rem;">${rows}</div>`;
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
    if (full) await cxExecuteFullCancellation(id, l, req);
    else await cxExecutePartialCancellation(id, l, req, cancelDates);
    closeModal('cxReviewModal');
    alert(cxT('cancelDone', {}, '✅ Cancellation approved — leave, schedules and balances updated.'));
  } catch (err) { console.error(err); alert(cxT('cancelFailed', { message: err.message }, '❌ Failed to process cancellation: {{message}}')); }
  finally { btn.disabled = false; btn.textContent = cxT('approveBtn', {}, '✅ Approve & cancel leave'); }
}
async function cxReject() {
  const id = cxReviewLeaveId; const l = leaves[id]; const req = l?.cancellationRequest;
  if (!l || !req || req.status !== 'pending') return;
  if (!confirm(cxT('rejectConfirm', {}, 'Reject this cancellation request? The leave stays approved.'))) return;
  const btn = $('cxRejectBtn'); btn.disabled = true;
  try {
    const patch = { status: 'rejected', reviewedBy: currentUser.uid, reviewedByName: cxCurrentUserName(), reviewedAt: new Date().toISOString(), reviewNote: $('cxReviewNote').value.trim() || '' };
    await update(ref(db, `leaves/${id}/cancellationRequest`), patch);
    cxNotify(l, { ...req, ...patch }, 'rejected');
    closeModal('cxReviewModal');
  } catch (e) { console.error(e); alert(cxT('rejectFailed', {}, '❌ Failed to reject the request.')); }
  finally { btn.disabled = false; }
}

/* ---------- execution ---------- */
function cxReviewPatch(req, extra = {}) {
  return { ...req, status: 'approved', reviewedBy: currentUser.uid, reviewedByName: cxCurrentUserName(), reviewedAt: new Date().toISOString(), reviewNote: $('cxReviewNote')?.value.trim() || '', ...extra };
}
async function cxExecuteFullCancellation(id, l, req) {
  let warn = false;
  try { await restoreSchedulesForLeave(l); } catch (e) { console.error('Schedule restore failed:', e); warn = true; }
  const newReq = cxReviewPatch(req);
  leaves[id] = { ...l, status: 'cancelled' };
  await update(ref(db, `leaves/${id}`), {
    status: 'cancelled', cancelledBy: currentUser.uid, cancelledAt: new Date().toISOString(),
    cancellationRequest: newReq
  });
  try { await recalcEntitlementUsed(l.empId); } catch (e) { console.warn('entitlement recalc failed:', e); }
  cxNotify({ ...l, status: 'cancelled' }, newReq, 'approved');
  if (warn) alert(cxT('restoreWarn', {}, '⚠️ Approved, but some schedule days could not be reverted. Check console.'));
}
async function cxExecutePartialCancellation(id, l, req, cancelDates) {
  const cancelSet = new Set(cancelDates);
  // 1) revert schedules for the cancelled dates only
  await cxRestoreSchedulesForDates(l, cancelDates);
  // 2) rebuild remaining days into contiguous segments
  const working = cxGetWorkingDays(l);
  const remainSet = new Set(working.filter(ds => !cancelSet.has(ds)));
  const segments = []; let cur = null;
  eachDate(l.dateFrom, l.dateTo, d => {
    const ds = fmtISO(d);
    if (cancelSet.has(ds)) { if (cur) { segments.push(cur); cur = null; } return; }
    if (!cur) cur = { cal: [], work: [] };
    cur.cal.push(ds); if (remainSet.has(ds)) cur.work.push(ds);
  });
  if (cur) segments.push(cur);
  const nonEmpty = segments.filter(s => s.work.length);
  if (!nonEmpty.length) return cxExecuteFullCancellation(id, l, req); // safety net
  const planByDate = {}; cxReliefPlanArray(l).forEach(dp => { if (dp?.date) planByDate[dp.date] = dp; });
  const mkPayload = seg => {
    const dateFrom = seg.work[0], dateTo = seg.work[seg.work.length - 1];
    const skipped = seg.cal.filter(ds => !remainSet.has(ds));
    const daysPerYear = {};
    seg.work.forEach(ds => { const y = parseInt(ds.slice(0, 4), 10); daysPerYear[y] = (daysPerYear[y] || 0) + 1; });
    return {
      dateFrom, dateTo, amount: seg.work.length, deductDays: seg.work.length,
      restDaysExcluded: skipped.join(', '), daysPerYear,
      year: parseInt(dateFrom.slice(0, 4), 10),
      reliefPlan: seg.work.map(ds => planByDate[ds]).filter(Boolean)
    };
  };
  const newReq = cxReviewPatch(req);
  // first segment keeps the original record id
  await update(ref(db, `leaves/${id}`), { ...mkPayload(nonEmpty[0]), cancellationRequest: newReq });
  // extra segments become new approved records (visible in all existing tabs/exports)
  for (let i = 1; i < nonEmpty.length; i++) {
    const payload = {
      empId: l.empId, empName: l.empName || '', empChinese: l.empChinese || '',
      type: l.type, typeLabel: l.typeLabel || TYPE_META[l.type]?.label || l.type,
      durationType: 'days', status: 'approved', reason: l.reason || '',
      appliedBy: l.appliedBy || currentUser.uid, appliedByName: l.appliedByName || '', appliedAt: l.appliedAt || new Date().toISOString(),
      reviewedBy: l.reviewedBy || currentUser.uid, reviewedAt: l.reviewedAt || new Date().toISOString(),
      timeFrom: '', timeTo: '', attachment: null,
      splitFrom: id, splitNote: 'Auto-split after partial cancellation',
      ...mkPayload(nonEmpty[i])
    };
    const r = await push(ref(db, 'leaves'), payload);
    if (r?.key) leaves[r.key] = payload; // keep local cache in sync for the recalc below
  }
  const snap = await get(ref(db, `leaves/${id}`)); if (snap.exists()) leaves[id] = snap.val();
  try { await recalcEntitlementUsed(l.empId); } catch (e) { console.warn('entitlement recalc failed:', e); }
  cxNotify(l, newReq, 'approved');
}
// Reverts Employee A + reliever schedules for SELECTED dates only
// (date-filtered mirror of the existing restoreSchedulesForLeave)
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
        if (rec?.shifts) {
          const arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts);
          const filtered = arr.filter(s => !(s.start === rel.newShift.start && s.end === rel.newShift.end && (s.center || rel.newShift.center) === rel.newShift.center));
          await update(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`), { ...rec, shifts: filtered });
        }
        const adjustments = Array.isArray(rel.adjustments) ? rel.adjustments : [];
        if (!adjustments.length) continue;
        const adjByCenter = {};
        adjustments.forEach(a => { (adjByCenter[a.center] = adjByCenter[a.center] || []).push(a); });
        for (const [center, list] of Object.entries(adjByCenter)) {
          const s2 = await get(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`));
          if (!s2.exists()) continue;
          const r2 = s2.val() || {};
          let arr2 = Array.isArray(r2.shifts) ? r2.shifts : Object.values(r2.shifts || {});
          list.forEach(a => {
            (a.after || []).forEach(p => { arr2 = arr2.filter(sh => !((sh.type || 'work') === 'work' && sh.start === p.start && sh.end === p.end)); });
            const hasOrig = arr2.some(sh => (sh.type || 'work') === 'work' && sh.start === a.before.start && sh.end === a.before.end);
            if (!hasOrig) arr2 = [...arr2, { ...a.before }];
          });
          await update(ref(db, `schedules/${center}/${rel.relieverId}/${dayPlan.date}`), { ...r2, shifts: arr2, updatedBy: currentUser.uid, updatedAt: new Date().toISOString() });
        }
      }
    } catch (e) { console.warn('cx reliever restore failed:', e); }
  }
}

/* ---------- EmailJS notifications ---------- */
function cxNotify(leave, req, eventType) {
  if (!EMAIL_NOTIFICATIONS_ENABLED || !emailjsConfigured()) return;
  try {
    const tos = new Set(getManagerEmails());
    const empEmail = employees[leave.empId]?.email?.trim().toLowerCase();
    if (empEmail) tos.add(empEmail);
    const uniqueTos = [...tos]; if (!uniqueTos.length) return;
    const subjects = {
      new: `🚫 Cancellation REQUEST — ${leave.empName} (${leave.typeLabel || leave.type})`,
      approved: `✅ Leave cancellation APPROVED — ${leave.empName}`,
      rejected: `❌ Cancellation request REJECTED — ${leave.empName}`,
      withdrawn: `↩️ Cancellation request withdrawn — ${leave.empName}`
    };
    const actions = {
      new: 'Cancellation requested (PENDING)', approved: 'Cancellation APPROVED',
      rejected: 'Cancellation request REJECTED', withdrawn: 'Cancellation request WITHDRAWN'
    };
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: uniqueTos.join(','),
      subject: subjects[eventType] || subjects.new,
      action: actions[eventType] || eventType,
      acted_by: cxCurrentUserName(),
      employee_name: leave.empName || '-',
      leave_type: leave.typeLabel || leave.type || '-',
      dates: `${leave.dateFrom} → ${leave.dateTo}`,
      duration: cxScopeText(leave, req),
      reason: req.reason || leave.reason || '-',
      applied_by: req.requestedByName || '-'
    }, { publicKey: EMAILJS_PUBLIC_KEY }).catch(err => console.warn('CX notification failed:', err?.text || err));
  } catch (err) { console.warn('CX notification failed:', err); }
}

/* ---------- wiring (runs once at module load) ---------- */
function wireCxEvents() {
  document.addEventListener('click', e => {
    if (e.target.closest('[data-main-tab="cancelrequests"]')) renderCancelTab();
  });
  onValue(ref(db, 'leaves'), () => cxMaybeRender());
  onValue(ref(db, 'employees'), () => cxMaybeRender());
  $('main-tab-cancelrequests')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-cx]'); if (!btn) return;
    const { cx, id } = btn.dataset;
    if (cx === 'request') openCxRequestModal(id);
    else if (cx === 'review') openCxReviewModal(id);
    else if (cx === 'withdraw') cxWithdraw(id);
  });
  $('cxSubmitRequestBtn')?.addEventListener('click', submitCxRequest);
  $('cxCancelRequestBtn')?.addEventListener('click', () => closeModal('cxRequestModal'));
  $('cxCloseRequestBtn')?.addEventListener('click', () => closeModal('cxRequestModal'));
  $('cxSelectAllDays')?.addEventListener('change', e => {
    document.querySelectorAll('#cxDaysList .cx-day-cb:not(:disabled)').forEach(cb => { cb.checked = e.target.checked; });
    cxUpdateDayUI();
  });
  $('cxApproveBtn')?.addEventListener('click', cxApprove);
  $('cxRejectBtn')?.addEventListener('click', cxReject);
  $('cxCloseReviewBtn')?.addEventListener('click', () => closeModal('cxReviewModal'));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal('cxRequestModal'); closeModal('cxReviewModal'); }
  });
}
wireCxEvents();

window.healLegacyReliefOverlaps = healLegacyReliefOverlaps;
// ============================================================
// leave.js — Leave Module (Application + Overview)
// v7: Integrated Relief Assignment & Schedule Rewriting
// ============================================================
import { db, logout } from './auth.js';
import { ref, get, update, onValue, push, runTransaction, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const auth = getAuth();
const AUTHORIZED_EMAIL = 'kumonchamps@gmail.com';
const MAX_ATTACHMENT_BYTES = 100 * 1024;

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const EMAILJS_SERVICE_ID = 'service_xiorqac';
const EMAILJS_TEMPLATE_ID = 'template_leave';
const EMAILJS_PUBLIC_KEY = 'h6ZUxpNW1GViOnq32';

const TYPE_META = {
  annual: { label: 'Annual Leave', cls: 'lv-annual', ledger: 'annualUsed' },
  sick:   { label: 'Sick Leave',   cls: 'lv-sick',   ledger: 'sickUsed' },
  unpaid: { label: 'Unpaid Leave', cls: 'lv-unpaid', ledger: null },
  pt:     { label: 'PT Time Off',  cls: 'lv-pt',     ledger: 'timeOffUsed' },
};

const ENTITLEMENT_FIELDS = {
  annualUsed: 'annual',
  sickUsed: 'sick',
  timeOffUsed: 'timeOff'
};

let employees = {};
let leaves = {};
let currentUser = null;

let statusFilter = 'all';
let monthFilter = 'all';
let currentYear = new Date().getFullYear();
let pickerYear = currentYear;
let viewDate = new Date();

let pendingAttachment = null;
let currentAttLeaveId = null;

let scheduleTemplates = {};
let offDatesCache = {};

let allCenterIds = [];
let allCenters = [];
let centerCalendars = {};

let allSchedulesCache = null;
let employeeScheduleByCenter = {};
let employeeScheduleLoadedCenters = new Set();

let scheduleUnsubscribers = [];
let initializedForUid = null;
let refreshTimer = null;
let searchTimer = null;

// 🆕 Approve Modal State
let currentApproveLeave = null;
let empASchedulesCache = {};

let lastTypeOptionsYear = null; // tracks which quota year the type dropdown was built for

// ---------- helpers ----------
const $ = id => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

const pad = n => String(n).padStart(2, '0');
const round2 = n => Math.round(n * 100) / 100;
const round1 = n => Math.round(n * 10) / 10;

const fmtISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtISO(new Date());

const escapeHtml = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

const isPartTime = emp => (emp?.terms || '').toLowerCase().includes('part');

function isValidTimeString(t) {
  if (!t) return false;
  if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(t)) return false;
  const [h, m] = t.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function timeToMinutes(t) {
  if (!isValidTimeString(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function timeRangesOverlap(aStart, aEnd, bStart, bEnd) {
  const a1 = timeToMinutes(aStart), a2 = timeToMinutes(aEnd);
  const b1 = timeToMinutes(bStart), b2 = timeToMinutes(bEnd);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return true;
  return a1 < b2 && b1 < a2;
}

function leaveDateRangeOverlaps(existing, dateFrom, dateTo, durationType, timeFrom, timeTo) {
  if (!existing?.dateFrom || !existing?.dateTo) return false;
  const dateOverlap = existing.dateFrom <= dateTo && existing.dateTo >= dateFrom;
  if (!dateOverlap) return false;
  if (durationType === 'hours' && existing.durationType === 'hours') {
    return timeRangesOverlap(timeFrom, timeTo, existing.timeFrom, existing.timeTo);
  }
  return true;
}

function daysBetweenInclusive(a, b) {
  if (!a || !b) return 0;
  const start = new Date(a + 'T00:00:00');
  const end = new Date(b + 'T00:00:00');
  return Math.round((end - start) / 86400000) + 1;
}

function eachDate(from, to, cb) {
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end) { cb(d); d.setDate(d.getDate() + 1); }
}

function fmtDate(s) {
  if (!s) return '-';
  return new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(s) {
  if (!s) return '-';
  return new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getEmpPositions(emp) {
  if (Array.isArray(emp?.positions)) return emp.positions;
  if (emp?.position) return [emp.position];
  return [];
}

function base64Bytes(dataUrl) {
  const b64 = (dataUrl || '').split(',')[1] || '';
  return Math.ceil(b64.length * 3 / 4);
}

function openModal(id) {
  const el = $(id);
  if (el) { el.classList.remove('hidden'); el.style.display = 'flex'; }
}

function closeModal(id) {
  const el = $(id);
  if (el) { el.classList.add('hidden'); el.style.display = 'none'; }
}

function getCenterAbbr(centerId) {
  if (!centerId) return '?';
  const c = allCenters.find(x => x.id === centerId);
  const n = (c ? c.name : centerId).toLowerCase();
  if (n.includes('mei keng')) return 'MK';
  if (n.includes('pac tat')) return 'PT';
  if (n.includes('tap siac')) return 'TS';
  if (n.includes('champs')) return 'C';
  if (n.includes('t11')) return 'T11';
  if (n.includes('ao')) return 'AO';
  if (n.includes('am')) return 'AM';
  return centerId.substring(0, 4).toUpperCase();
}

// ============================================================
// ACCESS CONTROL
// ============================================================
function grantAccess() { $('accessDenied')?.classList.add('hidden'); $('mainContent')?.classList.remove('hidden'); }

function showAccessDenied(title, msg) {
  $('mainContent')?.classList.add('hidden');
  const ad = $('accessDenied');
  if (!ad) return;
  ad.classList.remove('hidden');
  const c = ad.querySelector('.access-denied-content');
  if (c) {
    c.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(msg)}</p><button class="primary" type="button" onclick="location.href='centers.html'">← Back to Centers</button>`;
  }
}

async function resolveUser(user) {
  const email = user.email?.toLowerCase() || '';
  let isMaster = email === AUTHORIZED_EMAIL.toLowerCase();
  let empId = null; let positions = [];
  try {
    const snap = await get(ref(db, `employees/${user.uid}`));
    if (snap.exists()) { empId = user.uid; positions = getEmpPositions(snap.val()); }
    else {
      const all = await get(ref(db, 'employees'));
      const match = Object.entries(all.val() || {}).find(([_, e]) => e.email?.toLowerCase() === email);
      if (match) { empId = match[0]; positions = getEmpPositions(match[1]); }
    }
    if (!positions.length) {
      const uSnap = await get(ref(db, `users/${user.uid}`));
      positions = getEmpPositions(uSnap.val() || {});
    }
  } catch (err) { console.error('resolveUser error:', err); }

  const pos = positions.map(p => String(p || '').trim().toLowerCase());
  if (pos.includes('master admin')) isMaster = true;
  const isAdmin = isMaster || pos.includes('manager') || pos.includes('master admin');
  if (!empId && !isAdmin) return null;
  return { uid: user.uid, email, isMaster, isAdmin, empId };
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { showAccessDenied('🔐 Please log in first', 'No user session found.'); return; }
  currentUser = await resolveUser(user);
  if (!currentUser) { showAccessDenied('⛔ No Employee Profile', `${user.email} has no employee record.`); return; }
  grantAccess();
  initApp();
});

// ============================================================
// INIT + REALTIME
// ============================================================
function initApp() {
  if (initializedForUid && initializedForUid !== currentUser.uid) { location.reload(); return; }
  if (initializedForUid === currentUser.uid) { refreshAll(); return; }
  initializedForUid = currentUser.uid;

  $('leaveTable').innerHTML = `<tbody><tr><td class="empty-state">⏳ Loading leave records...</td></tr></tbody>`;
  injectAdminControls();
  wireEvents();
  renderMonthPickerLabel();
  loadScheduleData();

  onValue(ref(db, 'employees'), s => { employees = s.val() || {}; refreshAll(); });
    onValue(ref(db, 'leaves'), s => {
    leaves = s.val() || {};
    refreshAll();
    scheduleAutoSync();   // 🆕 auto-sync on load + on every leave change
    });
}

function refreshAllSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshAll, 80); }

function refreshAll() {
  if (!currentUser) return;
  populateEmpFilter();
  renderBalanceStrip();
  renderLeaveTable();
  renderOverview();
}

// ============================================================
// SCHEDULE + CALENDAR DATA
// ============================================================
async function loadCenterIds() {
  try {
    const cSnap = await get(ref(db, 'centers'));
    const data = cSnap.val() || {};
    allCenters = Object.entries(data).map(([id, d]) => ({ id, name: d.name || id }));
    allCenterIds = allCenters.map(c => c.id);
    ['t11', 'ao', 'am'].forEach(id => {
      if (!allCenterIds.includes(id)) {
        allCenterIds.push(id);
        allCenters.push({ id, name: id.toUpperCase() });
      }
    });
  } catch (e) { console.warn('loadCenterIds', e); }
}

async function loadCenterCalendars() {
  try {
    if (!allCenterIds.length) await loadCenterIds();
    await Promise.allSettled(allCenterIds.map(async cid => {
      const snap = await get(ref(db, `centers/${cid}/calendar`));
      centerCalendars[cid] = snap.val() || {};
    }));
  } catch (e) { console.warn('loadCenterCalendars', e); }
}

function clearScheduleListeners() {
  scheduleUnsubscribers.forEach(unsub => { try { unsub(); } catch (e) {} });
  scheduleUnsubscribers = [];
}

function subscribeScheduleChanges() {
  clearScheduleListeners();
  if (!allCenterIds.length) return;
  if (currentUser.isAdmin) {
    const unsub = onValue(ref(db, 'schedules'), s => {
      allSchedulesCache = s.val() || {};
      offDatesCache = {};
      refreshAllSoon();
    });
    scheduleUnsubscribers.push(unsub);
  } else if (currentUser.empId) {
    employeeScheduleByCenter = {};
    employeeScheduleLoadedCenters = new Set();
    allCenterIds.forEach(cid => {
      const unsub = onValue(ref(db, `schedules/${cid}/${currentUser.empId}`), s => {
        employeeScheduleByCenter[cid] = s.val() || {};
        employeeScheduleLoadedCenters.add(cid);
        delete offDatesCache[currentUser.empId];
        refreshAllSoon();
      });
      scheduleUnsubscribers.push(unsub);
    });
  }
}

async function loadScheduleData() {
  await loadCenterIds();
  await loadCenterCalendars();
  subscribeScheduleChanges();
  if (currentUser.isAdmin) {
    onValue(ref(db, 'scheduleTemplates'), s => { scheduleTemplates = s.val() || {}; refreshAllSoon(); });
  } else if (currentUser.empId) {
    onValue(ref(db, `scheduleTemplates/${currentUser.empId}`), s => { scheduleTemplates[currentUser.empId] = s.val() || {}; refreshAllSoon(); });
  }
}

function getWeeklyOffDays(empId) {
  const offs = new Set();
  const tmpl = scheduleTemplates[empId] || {};
  for (const [dow, t] of Object.entries(tmpl)) {
    if ((t?.status || 'scheduled') === 'off') {
      const n = Number(dow);
      if (Number.isInteger(n) && n >= 0 && n <= 6) offs.add(n);
    }
  }
  if (!offs.size) offs.add(0);
  return offs;
}

async function getOffDates(empId) {
  if (offDatesCache[empId]) return offDatesCache[empId];
  const set = new Set();
  try {
    if (!allCenterIds.length) await loadCenterIds();
    if (currentUser?.isAdmin && allSchedulesCache) {
      allCenterIds.forEach(cid => {
        Object.entries(allSchedulesCache?.[cid]?.[empId] || {}).forEach(([ds, rec]) => {
          if ((rec?.status || 'scheduled') === 'off') set.add(ds);
        });
      });
    } else if (!currentUser?.isAdmin && currentUser?.empId === empId && employeeScheduleLoadedCenters.size === allCenterIds.length) {
      allCenterIds.forEach(cid => {
        Object.entries(employeeScheduleByCenter?.[cid] || {}).forEach(([ds, rec]) => {
          if ((rec?.status || 'scheduled') === 'off') set.add(ds);
        });
      });
    } else {
      await Promise.allSettled(allCenterIds.map(async cid => {
        const snap = await get(ref(db, `schedules/${cid}/${empId}`));
        Object.entries(snap.val() || {}).forEach(([ds, rec]) => {
          if ((rec?.status || 'scheduled') === 'off') set.add(ds);
        });
      }));
    }
  } catch (e) { console.warn('getOffDates', e); }
  offDatesCache[empId] = set;
  return set;
}

function getEmpCenterIds(empId) {
  const perms = employees[empId]?.permissions?.centers || {};
  const ids = Object.keys(perms).filter(k => perms[k] === true);
  return ids.length ? ids : [...allCenterIds];
}

function isHoliday(empId, dateStr) {
  return getEmpCenterIds(empId).some(cid => {
    const ev = centerCalendars[cid]?.[dateStr];
    return !!(ev && ev.type === 'public' && !ev.muc);
  });
}

function getPublicHolidayForEmp(empId, dateStr) {
  for (const cid of getEmpCenterIds(empId)) {
    const ev = centerCalendars[cid]?.[dateStr];
    if (ev && ev.type === 'public' && !ev.muc) return ev;
  }
  return null;
}

async function isDayOff(empId, dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  if (getWeeklyOffDays(empId).has(dow)) return true;
  if ((await getOffDates(empId)).has(dateStr)) return true;
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  return isHoliday(empId, dateStr);
}

async function countLeaveDays(empId, from, to) {
  const weeklyOffDays = getWeeklyOffDays(empId);
  const offDates = await getOffDates(empId);
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  let days = 0; const skipped = [];
  const daysPerYear = {};
  eachDate(from, to, d => {
    const ds = fmtISO(d);
    if (weeklyOffDays.has(d.getDay()) || offDates.has(ds) || isHoliday(empId, ds)) { skipped.push(ds); return; }
    days++;
    const yr = d.getFullYear();
    daysPerYear[yr] = (daysPerYear[yr] || 0) + 1;
  });
  return { days, skipped, weeklyOffDays, daysPerYear };
}

// 🆕 Fetch Emp Schedule for a specific date across all centers
async function getEmpScheduleForDate(empId, dateStr) {
  if (!allCenterIds.length) await loadCenterIds();
  let mergedShifts = [];
  let originalStatus = 'scheduled';
  let originalNotes = '';
  
  for (const cid of allCenterIds) {
    try {
      const snap = await get(ref(db, `schedules/${cid}/${empId}/${dateStr}`));
      if (snap.exists()) {
        const data = snap.val();
        if (data.status && data.status !== 'scheduled') originalStatus = data.status;
        if (data.notes) originalNotes = data.notes;
        if (data.shifts && Array.isArray(data.shifts)) {
          data.shifts.forEach(s => { mergedShifts.push({ ...s, _center: s.center || cid }); });
        }
      }
    } catch (e) { console.warn(`Failed to load schedule for ${empId} at ${cid} on ${dateStr}`, e); }
  }
  return { status: originalStatus, notes: originalNotes, shifts: mergedShifts };
}

// ============================================================
// ADMIN-ONLY CONTROLS
// ============================================================
function injectAdminControls() {
  const slot = $('adminFilters');
  const empGroup = $('applyEmpGroup');
  if (!currentUser.isAdmin) { if (slot) slot.innerHTML = ''; if (empGroup) empGroup.innerHTML = ''; return; }

  if (slot) {
    slot.innerHTML = `
      <button class="secondary" id="exportLeavesBtn" type="button" title="Export current view to Excel">📊 Export Excel</button>
      <div class="filter-group"><label for="empFilter">Employee</label><select id="empFilter"></select></div>
      <input type="text" id="searchLeave" placeholder="🔎 Search reason, type, name..." />
    `;
    $('exportLeavesBtn').addEventListener('click', exportLeaves);
    $('empFilter').addEventListener('change', renderLeaveTable);
    $('searchLeave').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderLeaveTable, 200); });
  }

  if (empGroup) {
    empGroup.innerHTML = `<label for="applyEmp">Employee *</label><select id="applyEmp"></select>`;
    $('applyEmp').addEventListener('change', () => { offDatesCache = {}; populateTypeSelect(); });
  }
}

// ============================================================
// ENTITLEMENTS
// ============================================================
// ============================================================
// YEAR-AWARE ENTITLEMENTS
// Quota is per calendar year, keyed by the year of the leave's dateFrom.
// "Used" is computed from APPROVED leave records for that year, so
// next-year applications automatically draw on next year's quota.
// ============================================================
function leaveRecordYear(l) {
  return Number(l?.year) || parseInt((l?.dateFrom || '').slice(0, 4), 10) || new Date().getFullYear();
}

function getApprovedUsedForYear(empId, year, typeKey) {
  let used = 0;
  Object.values(leaves).forEach(l => {
    if (l.empId !== empId || l.status !== 'approved') return; 
    if (l.type !== typeKey) return;
    
    let d = 0;
    if (l.daysPerYear && l.daysPerYear[year] !== undefined) {
      d = Number(l.daysPerYear[year] || 0);
    } else {
      // Fallback for old records that don't have daysPerYear
      if (leaveRecordYear(l) === year) d = Number(l.deductDays || 0);
    }
    used += d;
  });
  return round2(used);
}

function getBalancesForYear(emp, empId, year) {
  const le = emp?.leaveEntitlement || {};
  const annual  = Number(le.annual || 0);
  const sick    = Number(le.sick || 0);
  const timeOff = Number(le.timeOff || 0);
  const annualUsed  = empId ? getApprovedUsedForYear(empId, year, 'annual') : Number(le.annualUsed || 0);
  const sickUsed    = empId ? getApprovedUsedForYear(empId, year, 'sick')   : Number(le.sickUsed || 0);
  const timeOffUsed = empId ? getApprovedUsedForYear(empId, year, 'pt')     : Number(le.timeOffUsed || 0);
  return {
    year,
    annual:  { entitled: annual,  used: annualUsed,  balance: round2(annual - annualUsed) },
    sick:    { entitled: sick,    used: sickUsed,    balance: round2(sick - sickUsed) },
    timeOff: { entitled: timeOff, used: timeOffUsed, balance: round2(timeOff - timeOffUsed) }
  };
}

// Current-year convenience wrapper (keeps old call sites working)
function getBalances(emp, empId = null) {
  return getBalancesForYear(emp, empId, new Date().getFullYear());
}

// The year targeted by the Apply modal (driven by Date From)
function selectedLeaveYear() {
  const dateFrom = $('dateFrom')?.value;
  const y = dateFrom ? parseInt(dateFrom.slice(0, 4), 10) : NaN;
  return Number.isInteger(y) ? y : new Date().getFullYear();
}

function buildTypeOptions(emp, empId, year) {
  const b = getBalancesForYear(emp, empId, year);
  const tag = year !== new Date().getFullYear() ? ` — ${year} quota` : '';
  const opts = [];
  if (!isPartTime(emp)) {
    opts.push({ key: 'annual', text: `Annual Leave — balance ${b.annual.balance} day(s)${tag}`, disabled: b.annual.balance <= 0 });
    opts.push({ key: 'sick',   text: `Sick Leave — balance ${b.sick.balance} day(s)${tag}`,   disabled: b.sick.balance <= 0 });
  } else {
    opts.push({ key: 'pt', text: `PT Time Off — ${b.timeOff.balance} credit(s) left${tag}`, disabled: false });
  }
  const annualLeft = Math.max(0, b.annual.balance);
  opts.push({
    key: 'unpaid',
    text: annualLeft > 0
      ? `Unpaid Leave — available after Annual credits used up (${annualLeft} left)${tag}`
      : `Unpaid Leave${tag}`,
    disabled: annualLeft > 0, showHint: annualLeft > 0
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
  if (!result.committed) throw new Error('Insufficient leave balance.');
}

// 🆕 SELF-HEALING: recompute "used" counters from APPROVED leaves only.
// Returns true only if it actually changed something.
async function recalcEntitlementUsed(empId) {
  const emp = employees[empId];
  if (!emp) return false;
  const le = emp.leaveEntitlement || {};
  const currentYear = new Date().getFullYear();
  let entYear = Number(le.lastResetYear) || currentYear;
  const extraUpdates = {};

  if (currentYear > entYear) {
    entYear = currentYear;
    extraUpdates.lastResetYear = currentYear;
  }

  let annual = 0, sick = 0, timeOff = 0;
  Object.values(leaves).forEach(l => {
    if (l.empId !== empId || l.status !== 'approved') return;
    
    let d = 0;
    if (l.daysPerYear && l.daysPerYear[entYear] !== undefined) {
      d = Number(l.daysPerYear[entYear] || 0);
    } else {
      if (leaveRecordYear(l) === entYear) d = Number(l.deductDays || 0);
    }
    
    if (d > 0) {
      if (l.type === 'annual') annual += d;
      else if (l.type === 'sick') sick += d;
      else if (l.type === 'pt') timeOff += d;
    }
  });
  annual = round2(annual); sick = round2(sick); timeOff = round2(timeOff);

  const unchanged = !extraUpdates.lastResetYear &&
    (le.annualUsed || 0) === annual &&
    (le.sickUsed || 0) === sick &&
    (le.timeOffUsed || 0) === timeOff;
  if (unchanged) return false;

  await update(ref(db, `employees/${empId}/leaveEntitlement`), {
    annualUsed: annual, sickUsed: sick, timeOffUsed: timeOff, ...extraUpdates
  });
  return true;
}

// ============================================================
// 🆕 AUTO-SYNC — balances recompute themselves, with a visible toast
// ============================================================
let autoSyncTimer = null;
let autoSyncRunning = false;
let autoSyncQueued = false;
let syncToastTimer = null;

function showSyncStatus(msg, done) {
  let el = $('syncToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'syncToast';
    el.className = 'sync-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  el.classList.toggle('done', !!done);
  clearTimeout(syncToastTimer);
  if (done) syncToastTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

function scheduleAutoSync() {
  if (!currentUser?.isAdmin) return;            // only admins write entitlements
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(runAutoSync, 500); // debounce bursts of changes
}

async function runAutoSync() {
  if (autoSyncRunning) { autoSyncQueued = true; return; }
  autoSyncRunning = true;
  showSyncStatus('🔄 Syncing balances…', false);
  try {
    do {
      autoSyncQueued = false;
      let changed = 0;
      for (const empId of Object.keys(employees)) {
        if (await recalcEntitlementUsed(empId)) changed++;
      }
      showSyncStatus(
        changed ? `✅ Balances synced — ${changed} corrected` : '✅ Balances synced',
        true
      );
    } while (autoSyncQueued);
  } catch (e) {
    console.warn('Auto-sync failed:', e);
    showSyncStatus('⚠️ Balance sync failed', true);
  } finally {
    autoSyncRunning = false;
  }
}

// ============================================================
// BALANCE STRIP
// ============================================================
function renderBalanceStrip() {
  const strip = $('balanceStrip'); if (!strip) return;
  let html = '';
  if (currentUser.isAdmin) {
    const pending = Object.values(leaves).filter(l => l.status === 'pending').length;
    if (pending > 0) html += `<button class="pending-chip" id="pendingChip" type="button">⏳ ${pending} pending approval${pending > 1 ? 's' : ''} — tap to view</button>`;
  }
  const emp = (!currentUser.isMaster && currentUser.empId) ? employees[currentUser.empId] : null;
  if (emp) {
        const b = getBalancesForYear(emp, currentUser.empId, new Date().getFullYear());    
        const cards = !isPartTime(emp)
      ? [{ cls: 'bc-annual', icon: '📅', title: 'Annual', d: b.annual }, { cls: 'bc-sick', icon: '🏥', title: 'Sick', d: b.sick }]
      : [{ cls: 'bc-pt', icon: '⏱️', title: 'PT Time Off', d: b.timeOff }];
    html += cards.map(c => `<div class="balance-card ${c.cls}"><div class="bc-title">${c.icon} ${escapeHtml(c.title)}</div><div class="bc-nums"><span>${round2(c.d.entitled)}<label>entitled</label></span><span>${round2(c.d.used)}<label>used</label></span><span class="bc-bal">${round2(c.d.balance)}<label>balance</label></span></div></div>`).join('');
  }
  strip.innerHTML = html;
  strip.classList.toggle('hidden', !html);
  $('pendingChip')?.addEventListener('click', () => {
    statusFilter = 'pending';
    document.querySelectorAll('.status-pills .pill').forEach(p => p.classList.toggle('active', p.dataset.status === 'pending'));
    renderLeaveTable();
  });
}

// ============================================================
// APPLICATION TAB
// ============================================================
function scopedLeaves() {
  let list = Object.entries(leaves).map(([id, l]) => ({ id, ...l }));
  if (!currentUser.isAdmin) list = list.filter(l => l.empId === currentUser.empId);
  return list;
}

function populateEmpFilter() {
  const sel = $('empFilter'); if (!sel || !currentUser?.isAdmin) return;
  const prev = sel.value || 'all';
  const sorted = Object.entries(employees).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  sel.innerHTML = `<option value="all">All Employees</option>` + sorted.map(([id, e]) => `<option value="${escapeHtml(id)}">${escapeHtml(e.englishName || id)}</option>`).join('');
  sel.value = prev;
}

function monthRangeForFilter() {
  if (monthFilter === 'all') return null;
  const m = parseInt(monthFilter, 10);
  if (!m || m < 1 || m > 12) return null;
  const lastDay = new Date(currentYear, m, 0).getDate();
  return { start: `${currentYear}-${pad(m)}-01`, end: `${currentYear}-${pad(m)}-${pad(lastDay)}` };
}

function getFilteredLeaves() {
  let list = scopedLeaves().filter(l => String(l.year || (l.dateFrom || '').slice(0, 4)) === String(currentYear));
  const range = monthRangeForFilter();
  if (range) list = list.filter(l => l.dateFrom <= range.end && l.dateTo >= range.start);
  const empF = $('empFilter')?.value;
  if (currentUser.isAdmin && empF && empF !== 'all') list = list.filter(l => l.empId === empF);
  const q = $('searchLeave')?.value.trim().toLowerCase();
  if (q) list = list.filter(l => (l.reason || '').toLowerCase().includes(q) || (l.typeLabel || '').toLowerCase().includes(q) || (l.empName || '').toLowerCase().includes(q));
  list.sort((a, b) => (b.appliedAt || '').localeCompare(a.appliedAt || ''));
  return list;
}

function updatePillCounts() {
  const base = getFilteredLeaves();
  const count = s => base.filter(l => l.status === s).length;
  setText('countAll', base.length); setText('countPending', count('pending'));
  setText('countApproved', count('approved')); setText('countRejected', count('rejected'));
  setText('countCancelled', count('cancelled'));
}

function durationText(l) { return l.durationType === 'hours' ? `${l.amount} hr(s)` : `${l.amount} day(s)`; }

function renderLeaveTable() {
  updatePillCounts();
  const table = $('leaveTable'); if (!table) return;
  let list = getFilteredLeaves();
  if (statusFilter !== 'all') list = list.filter(l => l.status === statusFilter);
  const admin = currentUser.isAdmin;
  const cols = admin ? 9 : 8;
  const thead = `<thead><tr>${admin ? '<th>Employee</th>' : ''}<th>Leave Type</th><th>Duration</th><th>From</th><th>To</th><th>Reason</th><th>📎</th><th>Status</th><th>Actions</th></tr></thead>`;
  if (list.length === 0) { table.innerHTML = thead + `<tbody><tr><td colspan="${cols}" class="empty-state">No leave records for ${currentYear}.</td></tr></tbody>`; return; }
  
  const rows = list.map(l => {
    const meta = TYPE_META[l.type] || { label: l.typeLabel || l.type, cls: '' };
    const fromCell = l.durationType === 'hours' ? `${fmtDate(l.dateFrom)}${l.timeFrom ? ' · ' + l.timeFrom : ''}` : fmtDate(l.dateFrom);
    const toCell = l.durationType === 'hours' ? `${fmtDate(l.dateTo)}${l.timeTo ? ' · ' + l.timeTo : ''}` : fmtDate(l.dateTo);
    let actions = '';
    if (admin && l.status === 'pending') {
      actions += `<button class="primary" data-action="approve" data-id="${escapeHtml(l.id)}" type="button" aria-label="Approve leave">✅</button><button class="danger" data-action="reject" data-id="${escapeHtml(l.id)}" type="button" aria-label="Reject leave">❌</button>`;
    }
    const canCancel = (l.status === 'pending' && (admin || l.empId === currentUser.empId)) || (l.status === 'approved' && admin);
    if (canCancel) actions += `<button class="secondary" data-action="cancel" data-id="${escapeHtml(l.id)}" type="button" aria-label="Cancel leave">🚫</button>`;
    if (!actions) actions = `<span style="color:#cbd5e1;">—</span>`;
    const canDelAtt = l.attachment && (admin || (l.empId === currentUser.empId && l.status === 'pending'));
    const safeId = escapeHtml(l.id);
    return `<tr>
      ${admin ? `<td data-label="Employee">${escapeHtml(l.empName || '-')}${l.empChinese ? `<small>(${escapeHtml(l.empChinese)})</small>` : ''}</td>` : ''}
      <td data-label="Type"><span class="type-dot lv ${meta.cls} approved"></span>${escapeHtml(meta.label)}</td>
      <td data-label="Duration">${durationText(l)}${l.restDaysExcluded ? `<small style="color:#94a3b8;">(rest days & holidays excl.)</small>` : ''}</td>
      <td data-label="From">${fromCell}</td><td data-label="To">${toCell}</td>
      <td data-label="Reason" class="reason-cell" title="${escapeHtml(l.reason)}">${escapeHtml(l.reason)}</td>
      <td data-label="File">${l.attachment ? `<button class="icon-btn" data-action="view-att" data-id="${safeId}" type="button" aria-label="View attachment">📎</button>` : '-'}${canDelAtt ? `<button class="icon-btn danger-ico" data-action="del-att" data-id="${safeId}" type="button" aria-label="Delete attachment">🗑</button>` : ''}</td>
      <td data-label="Status"><span class="status-badge ${l.status}">${(l.status || '').toUpperCase()}</span></td>
      <td data-label="Actions"><div class="leave-table-actions">${actions}</div></td>
    </tr>`;
  }).join('');
  table.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

// ============================================================
// 🆕 APPROVE MODAL & RELIEF ASSIGNMENT LOGIC
// ============================================================
async function openApproveModal(id) {
  const l = leaves[id];
  if (!l || l.status !== 'pending') return;
  
  currentApproveLeave = { id, ...l };
  empASchedulesCache = {};
  
  $('approveLeaveDetails').innerHTML = `
    <strong>${escapeHtml(l.empName)}</strong> · ${escapeHtml(TYPE_META[l.type]?.label || l.type)}<br>
    ${fmtDate(l.dateFrom)} → ${fmtDate(l.dateTo)} · ${durationText(l)}<br>
    <em>Reason: ${escapeHtml(l.reason)}</em>
  `;
  
  $('confirmApproveBtn').disabled = true;
  $('confirmApproveBtn').textContent = 'Loading Schedules...';
  openModal('approveModal');
  
  const dates = [];
  if (l.durationType === 'hours') {
    dates.push(l.dateFrom);
  } else {
    let d = new Date(l.dateFrom + 'T00:00:00');
    const end = new Date(l.dateTo + 'T00:00:00');
    while (d <= end) { dates.push(fmtISO(d)); d.setDate(d.getDate() + 1); }
  }
  
  for (const dateStr of dates) {
    const isOff = await isDayOff(l.empId, dateStr);
    if (isOff) {
      empASchedulesCache[dateStr] = { isDayOff: true, shifts: [], status: 'scheduled', notes: '' };
    } else {
      const sched = await getEmpScheduleForDate(l.empId, dateStr);
      empASchedulesCache[dateStr] = sched;
    }
  }
  
  renderApproveTable(l, empASchedulesCache);
  $('confirmApproveBtn').disabled = false;
  $('confirmApproveBtn').textContent = 'Confirm Approval';
}

function renderApproveTable(leave, schedulesByDate) {
  const tbody = $('approveReliefBody');
  tbody.innerHTML = '';
  
  const dates = Object.keys(schedulesByDate).sort();
  
  dates.forEach(dateStr => {
    const sched = schedulesByDate[dateStr];
    
    if (sched.isDayOff) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${fmtDate(dateStr)}</td><td colspan="3" class="no-shift-msg">Day off / Holiday - No relief needed</td>`;
      tbody.appendChild(tr);
      return;
    }
    
    if (!sched.shifts || sched.shifts.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${fmtDate(dateStr)}</td><td colspan="3" class="no-shift-msg">No shift scheduled - Reliever not needed</td>`;
      tbody.appendChild(tr);
      return;
    }
    
    sched.shifts.forEach((shift, shiftIdx) => {
      const tr = document.createElement('tr');
      tr.dataset.date = dateStr;
      tr.dataset.shiftIdx = shiftIdx;
      const centerAbbr = getCenterAbbr(shift._center);
      
      tr.innerHTML = `
        <td>${fmtDate(dateStr)}</td>
        <td><strong>${centerAbbr}</strong></td>
        <td>${shift.start} - ${shift.end}</td>
        <td class="relievers-cell" data-date="${dateStr}" data-center="${shift._center}" data-start="${shift.start}" data-end="${shift.end}">
          <div class="no-reliever-toggle">
            <label>
              <input type="checkbox" class="no-reliever-cb"> 
              <span>No reliever needed for this shift</span>
            </label>
          </div>
          <div class="relievers-container"></div>
          <button type="button" class="add-reliever-btn">+ Add Reliever</button>
        </td>
      `;
      tbody.appendChild(tr);
      
      const addBtn = tr.querySelector('.add-reliever-btn');
      const noRelieverCb = tr.querySelector('.no-reliever-cb');
      const relieversContainer = tr.querySelector('.relievers-container');
      
      noRelieverCb.addEventListener('change', () => {
        const isNoReliever = noRelieverCb.checked;
        addBtn.style.display = isNoReliever ? 'none' : '';
        relieversContainer.style.display = isNoReliever ? 'none' : '';
        if (isNoReliever) relieversContainer.innerHTML = ''; // Clear if toggled on
      });
      
      addBtn.addEventListener('click', () => addRelieverRow(relieversContainer, dateStr, shift._center, shift.start, shift.end));
    });
  });
}

function addRelieverRow(container, dateStr, empACenter, empAStart, empAEnd) {
  const rowId = `rel_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const relieverDiv = document.createElement('div');
  relieverDiv.className = 'reliever-row';
  relieverDiv.dataset.rowId = rowId;
  
  let empOptions = `<option value="">-- Select Reliever --</option>`;
  Object.entries(employees).forEach(([uid, e]) => {
    if (e.isDisabled || uid === currentApproveLeave.empId) return;
    empOptions += `<option value="${uid}">${escapeHtml(e.englishName || uid)}</option>`;
  });
  
  let centerOptions = `<option value="">-- None --</option>`;
  allCenters.forEach(c => {
    const selected = c.id === empACenter ? 'selected' : '';
    centerOptions += `<option value="${c.id}" ${selected}>${escapeHtml(c.name)}</option>`;
  });
  
  relieverDiv.innerHTML = `
    <div class="reliever-controls">
      <select class="reliever-select">${empOptions}</select>
      <span class="orig-shift-display">Orig: -</span>
      <span class="arrow-indicator">→</span>
      <select class="new-center-select">${centerOptions}</select>
      <input type="time" class="new-start-time" value="${empAStart}">
      <input type="time" class="new-end-time" value="${empAEnd}">
      <button type="button" class="remove-reliever-btn">🗑</button>
    </div>
  `;
  
  container.insertBefore(relieverDiv, container.querySelector('.add-reliever-btn'));
  
  const select = relieverDiv.querySelector('.reliever-select');
  const origDisplay = relieverDiv.querySelector('.orig-shift-display');
  
  select.addEventListener('change', async () => {
    const rid = select.value;
    if (!rid) { origDisplay.textContent = 'Orig: -'; return; }
    origDisplay.textContent = 'Orig: Loading...';
    const sched = await getEmpScheduleForDate(rid, dateStr);
    if (sched.shifts.length === 0 && sched.status === 'scheduled') {
      origDisplay.textContent = 'Orig: No shift';
    } else if (sched.status !== 'scheduled') {
      origDisplay.textContent = `Orig: ${sched.status}`;
    } else {
      const txt = sched.shifts.map(s => `${getCenterAbbr(s._center || s.center)} ${s.start}-${s.end}`).join(', ');
      origDisplay.textContent = `Orig: ${txt}`;
    }
  });
  
  relieverDiv.querySelector('.remove-reliever-btn').addEventListener('click', () => relieverDiv.remove());
}

async function confirmApproval() {
  // ✅ Define `l` FIRST so the safety check can read it
  const l = currentApproveLeave;

  // ✅ Safety guard: never write to leaves/undefined again
  if (!l || !l.id) {
    alert('❌ Missing leave record. Please close and reopen the approval window.');
    return;
  }

  const btn = $('confirmApproveBtn');
  btn.disabled = true; btn.textContent = 'Processing...';
  
  try {
    const reliefPlan = [];
    const dates = Object.keys(empASchedulesCache).sort();
    
    for (const dateStr of dates) {
      const sched = empASchedulesCache[dateStr];
      if (!sched || sched.isDayOff || sched.shifts.length === 0) continue;
      
      const dayPlan = {
        date: dateStr,
        empAOrigSchedule: { status: sched.status, shifts: sched.shifts, notes: sched.notes },
        relievers: []
      };
      
      const rows = document.querySelectorAll(`#approveReliefBody tr[data-date="${dateStr}"]`);
      rows.forEach(tr => {
        // 🆕 Skip if "No reliever needed" is checked
        const noRelieverCb = tr.querySelector('.no-reliever-cb');
        if (noRelieverCb && noRelieverCb.checked) return;

        const relieverRows = tr.querySelectorAll('.reliever-row');
        relieverRows.forEach(rr => {
          const rid = rr.querySelector('.reliever-select').value;
          const newCenter = rr.querySelector('.new-center-select').value;
          const newStart = rr.querySelector('.new-start-time').value;
          const newEnd = rr.querySelector('.new-end-time').value;
          
          if (rid && newCenter && newStart && newEnd) {
            dayPlan.reliefers.push({
              relieverId: rid,
              relieverName: employees[rid]?.englishName || '',
              newShift: { type: 'work', start: newStart, end: newEnd, center: newCenter }
            });
          }
        });
      });
      reliefPlan.push(dayPlan);
    }
    
    let deduct = +(l.deductDays || 0), amount = l.amount, skippedStr = l.restDaysExcluded || '';
    let daysPerYear = l.daysPerYear || null;
    if (l.durationType !== 'hours') {
      const c = await countLeaveDays(l.empId, l.dateFrom, l.dateTo);
      deduct = c.days; amount = c.days; skippedStr = c.skipped.join(', ') || '';
      daysPerYear = c.daysPerYear;
    } else {
      if (!daysPerYear) daysPerYear = { [parseInt(l.dateFrom.slice(0,4), 10)]: deduct };
    }
    
    // 🆕 balance guard against ALL years the leave spans
    const ledgerField = TYPE_META[l.type]?.ledger;
    if (ledgerField === 'annualUsed' || ledgerField === 'sickUsed') {
      for (const [yr, daysInYr] of Object.entries(daysPerYear || {})) {
        const yearNum = parseInt(yr, 10);
        const b = getBalancesForYear(employees[l.empId], l.empId, yearNum);
        const bal = ledgerField === 'annualUsed' ? b.annual : b.sick;
        if (daysInYr > bal.balance + 0.001) throw new Error(`Insufficient ${TYPE_META[l.type].label} balance for ${yearNum}.`);
      }
    }
    
    await update(ref(db, `leaves/${l.id}`), {
      status: 'approved', reviewedBy: currentUser.uid, reviewedAt: new Date().toISOString(),
      deductDays: deduct, amount, restDaysExcluded: skippedStr, reliefPlan: reliefPlan,
      daysPerYear: daysPerYear
    });
    
    // 🆕 update local cache, then recompute Used from approved leaves
    leaves[l.id] = { ...l, status: 'approved', deductDays: deduct, amount, year: parseInt(l.dateFrom.slice(0,4), 10), daysPerYear: daysPerYear };
    await recalcEntitlementUsed(l.empId);

    // Schedule & Reliever Updates
    for (const dayPlan of reliefPlan) {
      const dateStr = dayPlan.date;
      const centersToUpdate = new Set();
      
      // 🛡️ Safe iteration for shifts
      const origShifts = Array.isArray(dayPlan.empAOrigSchedule.shifts) ? dayPlan.empAOrigSchedule.shifts : Object.values(dayPlan.empAOrigSchedule.shifts || {});
      origShifts.forEach(s => centersToUpdate.add(s._center || s.center));
      
      if (centersToUpdate.size === 0) {
         const perms = employees[l.empId]?.permissions?.centers || {};
         Object.keys(perms).forEach(c => { if(perms[c]) centersToUpdate.add(c); });
      }
      
      for (const cid of centersToUpdate) {
        await update(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`), {
          status: 'leave', shifts: origShifts, notes: dayPlan.empAOrigSchedule.notes || '',
          updatedBy: currentUser.uid, updatedAt: new Date().toISOString()
        });
      }
      
      // 🛡️ Safe iteration for reliefers
      const relievers = Array.isArray(dayPlan.reliefers) ? dayPlan.reliefers : [];
      for (const rel of relievers) {
        if (!rel.relieverId || !rel.newShift) continue;
        const snap = await get(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dateStr}`));
        let currentSched = snap.val() || { status: 'scheduled', shifts: [], notes: '' };
        
        let currentShiftsArray = Array.isArray(currentSched.shifts) ? currentSched.shifts : Object.values(currentSched.shifts || {});
        const newShifts = [...currentShiftsArray, rel.newShift];
        
        await update(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dateStr}`), {
          status: currentSched.status || 'scheduled', shifts: newShifts, notes: currentSched.notes || '',
          updatedBy: currentUser.uid, updatedAt: new Date().toISOString()
        });
      }
    }
    
    notifyManagersLeaveEvent({ ...l, amount, deductDays: deduct }, 'approved');
    
    closeModal('approveModal');
    alert('✅ Leave approved and schedules updated!');
  } catch (err) {
    console.error(err);
    alert('❌ Failed to approve leave: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm Approval';
  }
}

// ============================================================
// REJECT / CANCEL (With Schedule Restoration)
// ============================================================
async function rejectLeave(id) {
  const l = leaves[id]; if (!l || l.status !== 'pending') return;
  if (!confirm(`Reject ${l.empName}'s leave application?`)) return;
  try {
    await update(ref(db, `leaves/${id}`), { status: 'rejected', reviewedBy: currentUser.uid, reviewedAt: new Date().toISOString() });
    notifyManagersLeaveEvent(l, 'rejected');
  } catch (err) { console.error(err); alert('❌ Failed to reject leave.'); }
}

async function cancelLeave(id) {
  const l = leaves[id]; if (!l) return;
  const wasApproved = l.status === 'approved';
  if (!confirm(wasApproved
    ? 'Cancel this APPROVED leave? The entitlement balance will be restored, and schedules will revert.'
    : 'Cancel this leave application?')) return;

  // 1️⃣ REVERT SCHEDULES FIRST — the part users see. Nothing may block it.
  if (wasApproved) {
    try {
      await restoreSchedulesForLeave(l);
    } catch (e) {
      console.error('❌ Schedule restore failed:', e);
      alert('⚠️ Leave will be cancelled, but some schedule days could not be reverted. Check console.');
    }
  }

  // 2️⃣ Entitlements — isolated; if it fails, auto-sync heals it on next load.
  if (wasApproved) {
    try {
      leaves[id] = { ...l, status: 'cancelled' };
      await recalcEntitlementUsed(l.empId);
    } catch (e) { console.warn('entitlement recalc failed (auto-sync will heal):', e); }
  }

  // 3️⃣ Leave status LAST for the flow, but it can no longer break the schedule revert.
  try {
    await update(ref(db, `leaves/${id}`), {
      status: 'cancelled', cancelledBy: currentUser.uid, cancelledAt: new Date().toISOString()
    });
  } catch (err) {
    console.error(err);
    alert('❌ Failed to cancel leave: ' + err.message);
  }
}

// 🆕 Reverts schedules without relying on reliefPlan.
// Each day is wrapped in try/catch so one bad day can never abort the rest.
async function restoreSchedulesForLeave(l) {
  if (!allCenterIds.length) await loadCenterIds();

  const dates = [];
  if (l.durationType === 'hours') dates.push(l.dateFrom);
  else eachDate(l.dateFrom, l.dateTo, d => dates.push(fmtISO(d)));

  for (const dateStr of dates) {
    // 🛡️ per-day retry: one flaky read can never leave a day stuck
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        for (const cid of allCenterIds) {
          const snap = await get(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`));
          if (!snap.exists()) continue;
          const rec = snap.val() || {};
          if (rec.status !== 'leave') continue;

          const shiftsArr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts || {});
          const hasShifts = shiftsArr.some(s => s.start && s.end);

          if (hasShifts) {
            await update(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`), {
              status: 'scheduled',
              updatedBy: currentUser.uid, updatedAt: new Date().toISOString()
            });
            console.log(`↩️ Restored ${dateStr} @ ${cid}`);
          } else {
            await remove(ref(db, `schedules/${cid}/${l.empId}/${dateStr}`));
            console.log(`🗑 Cleared empty leave record ${dateStr} @ ${cid}`);
          }
        }
        break; // day done → exit retry loop
      } catch (e) {
        console.warn(`restore attempt ${attempt} failed for ${dateStr}:`, e);
        if (attempt === 2) throw e;
      }
    }
  }

  // Remove reliever shifts (if a reliefPlan exists)
  if (l.reliefPlan) {
    const planArray = Array.isArray(l.reliefPlan) ? l.reliefPlan : Object.values(l.reliefPlan);
    for (const dayPlan of planArray) {
      try {
        const relievers = dayPlan?.reliefers
          ? (Array.isArray(dayPlan.reliefers) ? dayPlan.reliefers : Object.values(dayPlan.reliefers))
          : [];
        for (const rel of relievers) {
          if (!rel?.relieverId || !rel?.newShift) continue;
          const snap = await get(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`));
          const rec = snap.val();
          if (rec?.shifts) {
            const arr = Array.isArray(rec.shifts) ? rec.shifts : Object.values(rec.shifts);
            const filtered = arr.filter(s =>
              !(s.start === rel.newShift.start && s.end === rel.newShift.end &&
                (s.center || rel.newShift.center) === rel.newShift.center)
            );
            await update(ref(db, `schedules/${rel.newShift.center}/${rel.relieverId}/${dayPlan.date}`), {
              ...rec, shifts: filtered
            });
          }
        }
      } catch (e) { console.warn('reliever restore failed:', e); }
    }
  }
}

async function deleteAttachment(id) {
  const l = leaves[id]; if (!l?.attachment) return;
  if (!confirm('Delete this attachment permanently?')) return;
  try { await update(ref(db, `leaves/${id}`), { attachment: null }); closeModal('attachmentModal'); }
  catch (err) { console.error(err); alert('❌ Failed to delete attachment.'); }
}

function openAttachmentViewer(id) {
  const l = leaves[id]; if (!l?.attachment?.dataUrl) return;
  if (!String(l.attachment.dataUrl).startsWith('data:image/')) { alert('⚠️ Attachment format is not supported.'); return; }
  currentAttLeaveId = id;
  $('attachmentImg').src = l.attachment.dataUrl;
  setText('attachmentCaption', `${l.empName || ''} · ${fmtDate(l.dateFrom)} · ${l.attachment.sizeKB || '?'} KB`);
  const canDelete = currentUser.isAdmin || (l.empId === currentUser.empId && l.status === 'pending');
  $('deleteAttBtn').classList.toggle('hidden', !canDelete);
  openModal('attachmentModal');
}

// ============================================================
// EXCEL EXPORT
// ============================================================
function exportLeaves() {
  if (typeof XLSX === 'undefined') return alert('❌ Excel library not loaded.');
  let list = getFilteredLeaves();
  if (statusFilter !== 'all') list = list.filter(l => l.status === statusFilter);
  if (!list.length) return alert('⚠️ No leave records to export for the current filters.');
  const rows = list.map(l => ({
    'Employee': l.empName || '', 'Chinese Name': l.empChinese || '',
    'Leave Type': TYPE_META[l.type]?.label || l.type || '', 'Duration': durationText(l),
    'From': l.dateFrom + (l.timeFrom ? ' ' + l.timeFrom : ''), 'To': l.dateTo + (l.timeTo ? ' ' + l.timeTo : ''),
    'Rest Days/Holidays Excluded': l.restDaysExcluded || '', 'Reason': l.reason || '',
    'Status': (l.status || '').toUpperCase(), 'Applied By': l.appliedByName || '',
    'Applied At': l.appliedAt ? new Date(l.appliedAt).toLocaleString() : '',
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 40 }, { wch: 11 }, { wch: 22 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws, `Leaves ${currentYear}`);
  XLSX.writeFile(wb, `Kumon_Leaves_${currentYear}.xlsx`);
}

// ============================================================
// OVERVIEW TAB
// ============================================================
async function renderOverview() {
  const table = $('overviewTable'); const listEl = $('overviewList');
  if (!table) return;
  const y = viewDate.getFullYear(), m = viewDate.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const tStr = todayStr();
  const monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  setText('monthLabel', monthLabel);
  const monthStart = `${y}-${pad(m + 1)}-01`, monthEnd = `${y}-${pad(m + 1)}-${pad(daysInMonth)}`;
  const visible = Object.values(leaves).filter(l => (l.status === 'approved' || l.status === 'pending') && l.dateFrom <= monthEnd && l.dateTo >= monthStart);
  const activeEmpIds = new Set(visible.map(l => l.empId));
  const empRows = Object.entries(employees).filter(([id, e]) => !e.isDisabled && activeEmpIds.has(id)).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  if (!Object.keys(centerCalendars).length) await loadCenterCalendars();
  const offDatesByEmp = {};
  await Promise.all(empRows.map(async ([empId]) => { offDatesByEmp[empId] = await getOffDates(empId); }));
  
  let html = '<thead><tr><th class="name-col">Employee</th>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m, d).getDay();
    const cls = [(dow === 0 || dow === 6) ? 'weekend' : '', `${y}-${pad(m + 1)}-${pad(d)}` === tStr ? 'today-col' : ''].join(' ');
    html += `<th class="${cls}">${d}<small>${DOW[dow]}</small></th>`;
  }
  html += '</tr></thead><tbody>';
  if (empRows.length === 0) html += `<tr><td colspan="${daysInMonth + 1}" class="empty-state">🎉 No one is on leave in ${monthLabel}.</td></tr>`;
  
  for (const [empId, emp] of empRows) {
    const weeklyOffDays = getWeeklyOffDays(empId);
    const offDates = offDatesByEmp[empId] || new Set();
    html += `<tr><td class="name-col">${escapeHtml(emp.englishName || '-')}</td>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
      const dow = new Date(y, m, d).getDay();
      const extraCls = [(dow === 0 || dow === 6) ? 'weekend-col' : '', ds === tStr ? 'today-col' : ''].join(' ');
      const pub = getPublicHolidayForEmp(empId, ds);
      const isOff = weeklyOffDays.has(dow) || offDates.has(ds);
      const covering = visible.filter(l => l.empId === empId && l.dateFrom <= ds && l.dateTo >= ds);
      covering.sort((a, b) => (a.status === 'approved' ? -1 : 1) - (b.status === 'approved' ? -1 : 1));
      const lv = covering[0];
      if (pub) {
        html += `<td class="od-holiday ${extraCls}" title="🎌 ${escapeHtml(pub.name || 'Public Holiday')}">🎌</td>`;
      } else if (isOff) {
        html += `<td class="od-off ${extraCls}" title="Day off (${DOW_NAMES[dow]})">OFF</td>`;
      } else if (lv) {
        const meta = TYPE_META[lv.type] || { cls: '' };
        const titleText = `${emp.englishName || ''} — ${meta.label || ''} (${(lv.status || '').toUpperCase()})\n${fmtDate(lv.dateFrom)} → ${fmtDate(lv.dateTo)} · ${durationText(lv)}\nReason: ${lv.reason || ''}`;
        html += `<td class="lv ${meta.cls} ${lv.status} ${extraCls}" title="${escapeHtml(titleText)}">${lv.durationType === 'hours' ? `${lv.amount}h` : ''}</td>`;
      } else {
        html += `<td class="${extraCls}"></td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;
  
  if (listEl) {
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="ov-item" style="justify-content:center;color:var(--text-light);">🎉 No one is on leave in ${monthLabel}.</div>`;
    } else {
      const sorted = [...visible].sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || (a.empName || '').localeCompare(b.empName || ''));
      listEl.innerHTML = sorted.map(l => {
        const meta = TYPE_META[l.type] || { cls: '', label: l.typeLabel || l.type };
        const range = l.dateFrom === l.dateTo ? fmtDateShort(l.dateFrom) : `${fmtDateShort(l.dateFrom)} – ${fmtDateShort(l.dateTo)}`;
        const timeNote = l.durationType === 'hours' && l.timeFrom && l.timeTo ? `(${l.timeFrom}–${l.timeTo})` : '';
        return `<div class="ov-item ${l.status}"><span class="ov-dot lv ${meta.cls} ${l.status}"></span><div class="ov-info"><strong>${escapeHtml(l.empName || '-')}</strong><small>${escapeHtml(meta.label)} · ${durationText(l)}${timeNote}</small></div><div class="ov-when"><span>${range}</span><span class="status-badge ${l.status}">${(l.status || '').toUpperCase()}</span></div></div>`;
      }).join('');
    }
  }
}

// ============================================================
// APPLY MODAL
// ============================================================
function selectedApplyEmpId() { return currentUser.isAdmin ? $('applyEmp')?.value : currentUser.empId; }

function populateApplyEmployees() {
  const sel = $('applyEmp'); if (!sel || !currentUser.isAdmin) return;
  const sorted = Object.entries(employees).filter(([_, e]) => !e.isDisabled).sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  sel.innerHTML = `<option value="">— Select employee —</option>` + sorted.map(([id, e]) => `<option value="${escapeHtml(id)}">${escapeHtml(e.englishName || id)} (${escapeHtml(getEmpPositions(e).join(', ') || '-')})</option>`).join('');
}

function populateTypeSelect() {
  const empId = selectedApplyEmpId();
  const sel = $('leaveType'); const hint = $('unpaidHint');
  if (!sel) return;
  if (hint) hint.classList.add('hidden');

  const year = selectedLeaveYear();
  lastTypeOptionsYear = year;

  if (!empId || !employees[empId]) {
    sel.innerHTML = `<option value="">${currentUser.isAdmin ? '— select employee first —' : '—'}</option>`;
    updateBalancePanel(); return;
  }
  const prevSelected = sel.value;
  const opts = buildTypeOptions(employees[empId], empId, year);
  sel.innerHTML = opts.map(o => `<option value="${o.key}" ${o.disabled ? 'disabled' : ''}>${escapeHtml(o.text)}</option>`).join('');
  const prevStillValid = prevSelected && opts.some(o => o.key === prevSelected && !o.disabled);
  const first = opts.find(o => !o.disabled);
  sel.value = prevStillValid ? prevSelected : (first ? first.key : '');
  if (opts.some(o => o.showHint) && hint) {
    hint.textContent = `⚠️ Unpaid leave can only be applied once ${year} Annual leave credits are used up.`;
    hint.classList.remove('hidden');
  }
  updateBalancePanel();
}

async function computeRequestDraft() {
  const empId = selectedApplyEmpId();
  const durationType = document.querySelector('input[name="durationType"]:checked')?.value || 'days';
  if (durationType === 'hours') {
    const f = timeToMinutes($('timeFrom')?.value), t = timeToMinutes($('timeTo')?.value);
    if (f == null || t == null || t <= f) return null;
    const deductDays = round2((t - f) / 60 / 8);
    return { durationType, amount: round1((t - f) / 60), deductDays, skipped: [], daysPerYear: { [parseInt(($('dateFrom')?.value || '').slice(0,4), 10)]: deductDays } };
  }
  const from = $('dateFrom')?.value; if (!from) return null;
  const to = $('dateTo')?.value || from; if (to < from) return null;
  if (empId && employees[empId]) {
    const { days, skipped, daysPerYear } = await countLeaveDays(empId, from, to);
    return { durationType, amount: days, deductDays: days, skipped, daysPerYear };
  }
  const days = daysBetweenInclusive(from, to);
  return { durationType, amount: days, deductDays: days, skipped: [] };
}

async function updateBalancePanel() {
  const box = $('balanceBox'); if (!box) return;
  const typeKey = $('leaveType')?.value;
  const empId = selectedApplyEmpId();
  const emp = employees[empId];
  const year = selectedLeaveYear();
  if (!typeKey || !emp || !TYPE_META[typeKey]) { box.classList.add('hidden'); return; }

  if (typeKey === 'unpaid') {
    box.innerHTML = `<div class="balance-title">Unpaid Leave</div><div style="font-size:0.85rem;color:var(--text-light);">Not deducted from leave entitlement.</div>`;
    box.classList.remove('hidden'); return;
  }

  const b = getBalancesForYear(emp, empId, year);
  const map = { annual: b.annual, sick: b.sick, pt: b.timeOff };
  const d = map[typeKey]; if (!d) { box.classList.add('hidden'); return; }
  const noBalanceNeeded = typeKey === 'pt';

  let afterHtml = '';
  const draft = await computeRequestDraft();
  if (draft) {
    // Deduct only the portion that falls in the currently viewed year
    const deductInYear = (draft.daysPerYear && draft.daysPerYear[year] !== undefined) ? draft.daysPerYear[year] : draft.deductDays;
    const after = round2(d.balance - deductInYear);
    const skippedNote = draft.skipped?.length ? ` · ${draft.skipped.length} rest day(s)/holiday(s) excluded` : '';
    const splitNote = (draft.daysPerYear && Object.keys(draft.daysPerYear).length > 1) ? ` · spans multiple years` : '';
    afterHtml = `<div class="balance-after ${(after < 0 && !noBalanceNeeded) ? 'low' : ''}">Balance after this leave in ${year} (${draft.durationType === 'hours' ? draft.amount + ' hr(s)' : deductInYear + ' day(s)'}${skippedNote}${splitNote}):<strong>${after}</strong>${noBalanceNeeded ? ' <small>(balance not required for PT)</small>' : (after < 0 ? ' — ⚠️ exceeds balance' : '')}</div>`;
  }

  const yearNote = year !== new Date().getFullYear()
    ? `<div class="hint">ℹ️ This leave falls in <strong>${year}</strong> — it will be deducted from the <strong>${year}</strong> quota (resets on 1 Jan ${year}), not from this year's balance.</div>`
    : '';

  box.innerHTML = `<div class="balance-title">${TYPE_META[typeKey].label} — ${year} Entitlement</div><div class="balance-grid"><div><label>Entitled</label><span>${round2(d.entitled)}</span></div><div><label>Used in ${year}</label><span>${round2(d.used)}</span></div><div><label>Balance</label><span class="bal">${round2(d.balance)}</span></div></div>${yearNote}${afterHtml}`;
  box.classList.remove('hidden');
}

function toggleHoursFields() {
  const isHours = document.querySelector('input[name="durationType"]:checked')?.value === 'hours';
  document.querySelectorAll('.hours-fields').forEach(el => el.classList.toggle('hidden', !isHours));
  const dateTo = $('dateTo'); const dateFrom = $('dateFrom');
  if (!dateTo || !dateFrom) return;
  if (isHours) { dateTo.value = dateFrom.value; dateTo.disabled = true; } else { dateTo.disabled = false; }
}

function openApplyModal() {
  offDatesCache = {};
  loadCenterCalendars();
  setText('applyModalTitle', 'Apply for Leave');
  if (currentUser.isAdmin) {
    populateApplyEmployees();
    if ($('applyEmp')) $('applyEmp').value = '';
    setText('applyEmpInfo', 'Admin — applying on behalf of an employee');
  } else {
    const emp = employees[currentUser.empId];
    setText('applyEmpInfo', emp ? `${emp.englishName || ''} · ${getEmpPositions(emp).join(', ') || '-'} · ${emp.terms || ''}` : '');
  }
  
  // Reset dates FIRST so the type options are built for the correct quota year
  const daysRadio = document.querySelector('input[name="durationType"][value="days"]');
  if (daysRadio) daysRadio.checked = true;
  toggleHoursFields();
  if ($('dateFrom')) $('dateFrom').value = todayStr();
  if ($('dateTo')) $('dateTo').value = todayStr();
  if ($('timeFrom')) $('timeFrom').value = '';
  if ($('timeTo')) $('timeTo').value = '';
  if ($('reason')) $('reason').value = '';
  if ($('attachment')) $('attachment').value = '';
  pendingAttachment = null;
  $('attachmentPreview')?.classList.add('hidden');

  const leaveType = $('leaveType'); if (leaveType) leaveType.innerHTML = '';
  populateTypeSelect(); // now uses the year of dateFrom
  openModal('applyModal');
}

function readFileAsDataURL(file) { return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); }); }
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }

async function compressImage(file) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);
  let scale = 1, quality = 0.85, out = dataUrl;
  for (let i = 0; i < 10; i++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL('image/jpeg', quality);
    if (base64Bytes(out) <= MAX_ATTACHMENT_BYTES) break;
    if (quality > 0.45) quality -= 0.15; else scale *= 0.7;
  }
  if (base64Bytes(out) > MAX_ATTACHMENT_BYTES) throw new Error('Image could not be compressed below 100 KB.');
  return { name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', dataUrl: out, sizeKB: Math.max(1, Math.round(base64Bytes(out) / 1024)) };
}

async function onAttachmentChange(e) {
  const file = e.target.files[0]; const preview = $('attachmentPreview');
  if (!file) { pendingAttachment = null; preview?.classList.add('hidden'); return; }
  if (!file.type.startsWith('image/')) { alert('⚠️ Please attach an image.'); e.target.value = ''; return; }
  try {
    preview?.classList.remove('hidden');
    if (preview) preview.innerHTML = `<span class="attachment-meta">⏳ Compressing to ≤ 100 KB...</span>`;
    pendingAttachment = await compressImage(file);
    if (preview) {
      preview.innerHTML = `<img src="${pendingAttachment.dataUrl}" alt="attachment preview"><div class="attachment-meta">${escapeHtml(pendingAttachment.name)}<br>≈ ${pendingAttachment.sizeKB} KB</div><button class="secondary" type="button" id="removeAttBtn">Remove</button>`;
    }
    $('removeAttBtn')?.addEventListener('click', () => { pendingAttachment = null; if ($('attachment')) $('attachment').value = ''; preview?.classList.add('hidden'); });
  } catch (err) { console.error(err); pendingAttachment = null; preview?.classList.add('hidden'); alert('❌ Could not process the image.'); }
}

// ============================================================
// EMAILJS
// ============================================================
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

function emailjsConfigured() {
  return typeof emailjs !== 'undefined' && !EMAILJS_SERVICE_ID.startsWith('YOUR_') && !EMAILJS_TEMPLATE_ID.startsWith('YOUR_') && !EMAILJS_PUBLIC_KEY.startsWith('YOUR_');
}

async function notifyManagersLeaveEvent(leave, eventType) {
    return;
  if (!emailjsConfigured()) { 
    console.info('📧 EmailJS not configured — skipping notification.'); 
    return; }
  try {
    const tos = getManagerEmails(); if (!tos.length) return;
    const subjects = { new: `🏖️ New Leave Request — ${leave.empName} (${leave.typeLabel})`, approved: `✅ Leave APPROVED — ${leave.empName} (${leave.typeLabel})`, rejected: `❌ Leave REJECTED — ${leave.empName} (${leave.typeLabel})` };
    const actionLabel = { new: 'New application (PENDING)', approved: 'APPROVED', rejected: 'REJECTED' }[eventType] || eventType;
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: tos.join(','), subject: subjects[eventType] || subjects.new, action: actionLabel,
      acted_by: eventType === 'new' ? (leave.appliedByName || '-') : (currentUser?.email || '-'),
      employee_name: leave.empName || '-', leave_type: leave.typeLabel || leave.type || '-',
      dates: `${leave.dateFrom} → ${leave.dateTo}`,
      duration: leave.durationType === 'hours' ? `${leave.amount} hr(s) (${leave.timeFrom}–${leave.timeTo})` : `${leave.amount} day(s)`,
      reason: leave.reason || '-', applied_by: leave.appliedByName || '-',
    }, { publicKey: EMAILJS_PUBLIC_KEY });
    console.info(`📧 Managers notified (${eventType}).`);
  } catch (err) { console.warn('📧 Manager notification failed:', err?.text || err); }
}

// ============================================================
// SUBMIT LEAVE
// ============================================================
async function submitLeave() {
  const empId = selectedApplyEmpId();
  if (!empId || !employees[empId]) return alert('⚠️ Please select an employee.');
  const emp = employees[empId];
  const type = $('leaveType')?.value;
  if (!type || !TYPE_META[type]) return alert('⚠️ Please select a leave type.');
  const dateFrom = $('dateFrom')?.value;
  let dateTo = $('dateTo')?.value || dateFrom;
  if (!dateFrom) return alert('⚠️ Please select the Date From.');
  const durationType = document.querySelector('input[name="durationType"]:checked')?.value || 'days';
    let amount, deductDays, timeFrom = '', timeTo = '', skipped = [];
  let daysPerYear = null;
  
  if (durationType === 'hours') {
    dateTo = dateFrom;
    timeFrom = $('timeFrom')?.value || ''; timeTo = $('timeTo')?.value || '';
    if (!isValidTimeString(timeFrom) || !isValidTimeString(timeTo)) return alert('⚠️ Please enter valid From and To times in HH:MM format.');
    const f = timeToMinutes(timeFrom), t = timeToMinutes(timeTo);
    if (f === null || t === null) return alert('⚠️ Please enter the From and To times.');
    if (t <= f) return alert('⚠️ To-time must be after From-time.');
    if (await isDayOff(empId, dateFrom)) return alert(`⚠️ ${fmtDate(dateFrom)} is a rest day or holiday for ${emp.englishName}. Leave is not required.`);
    amount = round1((t - f) / 60); deductDays = round2(amount / 8);
    if (amount <= 0) return alert('⚠️ Hour duration must be greater than zero.');
    daysPerYear = { [parseInt(dateFrom.slice(0, 4), 10)]: deductDays };
  } else {
    const count = await countLeaveDays(empId, dateFrom, dateTo);
    skipped = count.skipped;
    if (count.days <= 0) {
      const offDayNames = [...count.weeklyOffDays].sort().map(i => DOW_NAMES[i]).join(' / ');
      return alert(`⚠️ All selected dates fall on ${emp.englishName}'s rest day(s) or holiday(s) (${offDayNames} / scheduled off / center holiday). No leave is needed.`);
    }
    amount = count.days; deductDays = count.days;
    daysPerYear = count.daysPerYear;
  }
  
  const reason = $('reason')?.value.trim();
  if (!reason) return alert('⚠️ Reason is required.');
  if (dateTo < dateFrom) return alert('⚠️ Date To cannot be before Date From.');
  
  const conflict = Object.values(leaves).find(l => l.empId === empId && (l.status === 'pending' || l.status === 'approved') && leaveDateRangeOverlaps(l, dateFrom, dateTo, durationType, timeFrom, timeTo));
  if (conflict) return alert(`⚠️ Duplicate request!\n\n${emp.englishName} already has ${TYPE_META[conflict.type]?.label || conflict.type} (${(conflict.status || '').toUpperCase()}) covering ${fmtDate(conflict.dateFrom)} – ${fmtDate(conflict.dateTo)}.`);
  
  const ledgerField = TYPE_META[type].ledger;
  if (ledgerField === 'annualUsed' || ledgerField === 'sickUsed') {
    // 🆕 Validate balance for EACH year the leave spans
    for (const [yr, daysInYr] of Object.entries(daysPerYear || {})) {
      const yearNum = parseInt(yr, 10);
      const b = getBalancesForYear(emp, empId, yearNum);
      const bal = ledgerField === 'annualUsed' ? b.annual : b.sick;
      if (daysInYr > bal.balance + 0.001) {
        return alert(`⚠️ Insufficient balance. Remaining ${TYPE_META[type].label} balance for ${yearNum} is ${bal.balance} day(s), but this request needs ${daysInYr} day(s) in ${yearNum}.`);
      }
    }
  }
  
  const applicantName = currentUser.isAdmin ? `${employees[currentUser.empId]?.englishName || currentUser.email || 'Admin'} (on behalf)` : (emp.englishName || '');
  const leaveData = {
    empId, empName: emp.englishName || '', empChinese: emp.chineseName || '',
    type, typeLabel: TYPE_META[type].label, durationType,
    dateFrom, dateTo, timeFrom: timeFrom || '', timeTo: timeTo || '',
    amount, deductDays, restDaysExcluded: skipped.join(', ') || '',
    reason, attachment: pendingAttachment || null,
    status: 'pending', appliedBy: currentUser.uid, appliedByName: applicantName,
    appliedAt: new Date().toISOString(), year: parseInt(dateFrom.slice(0, 4), 10),
    daysPerYear: daysPerYear // 🆕 Saved to DB
  };
  
  const btn = $('submitLeaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }
  try {
    await push(ref(db, 'leaves'), leaveData);
    notifyManagersLeaveEvent(leaveData, 'new');
    closeModal('applyModal');
    alert('✅ Leave application submitted! Status: PENDING.');
  } catch (err) { console.error(err); alert('❌ Failed to submit leave: ' + err.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Submit'; } }
}

// ============================================================
// EVENTS
// ============================================================
function wireEvents() {
  document.querySelectorAll('[data-main-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-main-tab]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('[id^="main-tab-"]').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      $(`main-tab-${btn.dataset.mainTab}`)?.classList.add('active');
      if (btn.dataset.mainTab === 'overview') renderOverview();
    });
  });

  $('applyBtn')?.addEventListener('click', openApplyModal);

  // Month-Year Picker
  $('monthPickerBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    const pop = $('monthPickerPop');
    const willOpen = pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !willOpen);
    $('monthPickerBtn').setAttribute('aria-expanded', String(willOpen));
    if (willOpen) { pickerYear = currentYear; renderMonthGrid(); }
  });
  $('mpYearPrev')?.addEventListener('click', e => { e.stopPropagation(); pickerYear--; renderMonthGrid(); });
  $('mpYearNext')?.addEventListener('click', e => { e.stopPropagation(); pickerYear++; renderMonthGrid(); });
  $('mpGrid')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-month]'); if (!btn) return;
    applyMonthPick(parseInt(btn.dataset.month, 10));
  });
  $('mpAllBtn')?.addEventListener('click', () => applyMonthPick('all'));
  $('mpCloseBtn')?.addEventListener('click', closeMonthPicker);
  document.addEventListener('click', e => {
    const wrap = $('monthPicker'); if (wrap && !wrap.contains(e.target)) closeMonthPicker();
  });

  document.querySelectorAll('.status-pills .pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('.status-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active'); statusFilter = p.dataset.status; renderLeaveTable();
    });
  });

  $('leaveTable')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]'); if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'approve') openApproveModal(id); // 🆕 Opens Relief Modal
    else if (action === 'reject') rejectLeave(id);
    else if (action === 'cancel') cancelLeave(id);
    else if (action === 'view-att') openAttachmentViewer(id);
    else if (action === 'del-att') deleteAttachment(id);
  });

  $('prevMonth')?.addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1); renderOverview(); });
  $('nextMonth')?.addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1); renderOverview(); });
  $('todayBtn')?.addEventListener('click', () => { viewDate = new Date(); renderOverview(); });

  $('leaveType')?.addEventListener('change', updateBalancePanel);
  document.querySelectorAll('input[name="durationType"]').forEach(r => r.addEventListener('change', () => { toggleHoursFields(); updateBalancePanel(); }));
  
    $('dateFrom')?.addEventListener('change', () => {
    const isHours = document.querySelector('input[name="durationType"]:checked')?.value === 'hours';
    const dateTo = $('dateTo'); const dateFrom = $('dateFrom');
    if (!dateTo || !dateFrom) return;
    if (isHours) { dateTo.value = dateFrom.value; }
    else if (!dateTo.value || dateTo.value < dateFrom.value) { dateTo.value = dateFrom.value; }
    // If the date moved into another quota year, rebuild the leave-type options
    if (selectedLeaveYear() !== lastTypeOptionsYear) populateTypeSelect();
    else updateBalancePanel();
    });
  
  ['dateTo', 'timeFrom', 'timeTo'].forEach(id => $(id)?.addEventListener('change', updateBalancePanel));
  ['timeFrom', 'timeTo'].forEach(id => $(id)?.addEventListener('input', updateBalancePanel));
  $('attachment')?.addEventListener('change', onAttachmentChange);
  $('submitLeaveBtn')?.addEventListener('click', submitLeave);
  
  $('cancelApplyBtn')?.addEventListener('click', () => closeModal('applyModal'));
  $('closeApplyBtn')?.addEventListener('click', () => closeModal('applyModal'));
  $('closeAttachmentBtn')?.addEventListener('click', () => closeModal('attachmentModal'));
  
  // 🆕 Approve Modal Events
  $('cancelApproveBtn')?.addEventListener('click', () => closeModal('approveModal'));
  $('closeApproveBtn')?.addEventListener('click', () => closeModal('approveModal'));
  $('confirmApproveBtn')?.addEventListener('click', confirmApproval);

  $('downloadAttBtn')?.addEventListener('click', () => {
    const l = leaves[currentAttLeaveId]; if (!l?.attachment?.dataUrl) return;
    const a = document.createElement('a'); a.href = l.attachment.dataUrl; a.download = l.attachment.name || 'attachment.jpg'; a.click();
  });
  $('deleteAttBtn')?.addEventListener('click', () => deleteAttachment(currentAttLeaveId));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal('applyModal'); closeModal('attachmentModal'); closeModal('approveModal'); closeMonthPicker(); }
  });
}

function renderMonthPickerLabel() {
  setText('monthPickerLabel', monthFilter === 'all' ? `All months · ${currentYear}` : `${MONTH_NAMES[monthFilter - 1]} ${currentYear}`);
}

function renderMonthGrid() {
  const grid = $('mpGrid'); if (!grid) return;
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
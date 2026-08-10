import { db, logout, requireAuth } from './auth.js';
import { ref, get, set, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t } from './employee-schedule-i18n.js';

// ============================================
// CONSTANTS
// ============================================
const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const auth = getAuth();
const ROLE_ORDER = ['Master Admin', 'Manager', 'Admin', 'English Teacher', 'Math Teacher', 'Chinese Teacher', 'Tutorial Teacher', 'Custodian'];

// ✅ Translated day/month names (refreshed once i18n is ready)
let DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function refreshDateNames() {
  DAY_NAMES = t('schedule.daysLong', { returnObjects: true });
  DAY_SHORT = t('schedule.daysShort', { returnObjects: true });
  MONTH_NAMES = t('schedule.months', { returnObjects: true });
}
i18nReady.then(refreshDateNames).catch(() => {});

// ✅ Translate group labels (English Teachers, Admins, ...)
const LABEL_KEYS = {
  'English Teachers': 'schedule.labelEnglishTeachers',
  'Math Teachers': 'schedule.labelMathTeachers',
  'Chinese Teachers': 'schedule.labelChineseTeachers',
  'Tutorial Teachers': 'schedule.labelTutorialTeachers',
  'Admins': 'schedule.labelAdmins'
};
function trLabel(label) { return LABEL_KEYS[label] ? t(LABEL_KEYS[label]) : label; }

// ✅ Center closed days (0=Sun, 6=Sat). Added T11 and AO.
const CENTER_CLOSED_DAYS = {
  'mei keng': [0],
  'pac tat': [0, 6],
  'champs': [0],
  'tap siac': [2],
  't11': [],
  'ao': [],
  'am': []
};
const SUBJECT_CONFIG = {
  'English Teacher': { label: 'English Teachers', icon: '📖', cls: 'english-divider', color: '#e67e22' },
  'Math Teacher': { label: 'Math Teachers', icon: '🔢', cls: 'math-divider', color: '#1abc9c' },
  'Chinese Teacher': { label: 'Chinese Teachers', icon: '🀄', cls: 'chinese-divider', color: '#7cb342' },
  'Tutorial Teacher': { label: 'Tutorial Teachers', icon: '📚', cls: 'tutorial-divider', color: '#8e44ad' },
  'Admins': { label: 'Admins', icon: '👤', cls: 'admin-divider', color: '#2c3e50' },
};

function getEmpPositions(emp) {
  if (Array.isArray(emp.positions)) return emp.positions;
  if (emp.position) return [emp.position];
  return [];
}

// ✅ FIX: Patterns must NEVER apply to past dates
function isPastDate(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseDate(dateStr) < today;
}
function getTemplateForDate(empId, dateStr) {
  const dow = parseDate(dateStr).getDay();
  const tmpl = templates[empId]?.[dow];
  if (!tmpl) return null;
  if (isPastDate(dateStr)) return null;
  return tmpl;
}

// ============================================
// GLOBAL STATE
// ============================================
let currentUser = null;
let isAdminOrManager = false;
let employees = {};
let allCenters = [];
let calendarEvents = {};
let mergedSchedules = {};
let rawSchedulesByCenter = {};
let templates = {};
let viewStartDate = getMonday(new Date());
let empViewStartDate = getMonday(new Date());
let editingEmpId = null;
let editingDate = null;
let editingSourceCenter = null;
let shiftCounter = 0;
let centerViewDate = getMonday(new Date());
let selectedCenterForView = '';
let subjectViewDate = getMonday(new Date());
let selectedSubjectFilter = 'all';
let centerGroupBySubject = false;
let isSaving = false;
let selectedPatternDates = new Set();
let calendarViewDate = new Date();
let isInitialized = false;
let adminMobileCurrentEmpId = null;
let adminMobileCalDate = new Date();

document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, async (user) => {
    if (isInitialized) return;
    if (!user) {
      alert(t('schedule.loginFirst'));
      window.location.href = 'centers.html';
      return;
    }
    isInitialized = true;
  });
});

// ============================================
// INITIALIZATION (OPTIMIZED)
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      alert(t('schedule.loginFirst'));
      window.location.href = 'centers.html';
      return;
    }
    await i18nReady.catch(() => {});
    refreshDateNames();
    currentUser = user;
    await checkPermissions(user);
    await loadAllCenters();
    if (isAdminOrManager) {
      await Promise.all([
        loadAllCalendarEvents(),
        loadEmployees(),
        loadAllSchedules(),
        loadAllTemplates()
      ]);
      setupTabs();
      setupAdminNav();
      setupEmployeeNav();
      setupCenterNav();
      setupSubjectNav();
      setupModal();
      applyPermissionUI();
      renderAdminView();
      renderEmployeeView();
      renderCenterView();
      renderSubjectView();
    } else {
      await Promise.all([
        loadEmployeeOnly(user.uid),
        loadEmployeeSchedulesOnly(user.uid),
        loadEmployeeTemplateOnly(user.uid),
        loadCalendarEventsForEmployee()
      ]);
      setupTabs();
      setupEmployeeNav();
      applyPermissionUI();
      renderEmployeeView();
    }
    document.getElementById('page-loader').classList.add('hidden');
    document.getElementById('page-loader').classList.add('hidden');
    document.querySelector('.schedule-dashboard').classList.add('loaded');
  });
});

// ============================================
// PERMISSIONS
// ============================================
async function checkPermissions(user) {
  isAdminOrManager = false;
  if (user.email && user.email.toLowerCase() === AUTHORIZED_EMAIL) {
    isAdminOrManager = true;
    return;
  }
  try {
    const snap = await get(ref(db, `employees/${user.uid}`));
    if (snap.exists()) {
      const emp = snap.val();
      const positions = getEmpPositions(emp).map(p => (p || '').toLowerCase());
      if (positions.includes('manager') || positions.includes('admin') || positions.includes('master admin')) {
        isAdminOrManager = true;
      }
    }
  } catch (e) {
    console.error('Permission check error:', e);
  }
}

function applyPermissionUI() {
  const adminTabBtn = document.querySelector('.schedule-tabs .tab-btn[data-tab="admin"]');
  const centerTabBtn = document.querySelector('.schedule-tabs .tab-btn[data-tab="center"]');
  const subjectTabBtn = document.querySelector('.schedule-tabs .tab-btn[data-tab="subject"]');
  if (!isAdminOrManager) {
    if (adminTabBtn) adminTabBtn.remove();
    if (centerTabBtn) centerTabBtn.remove();
    if (subjectTabBtn) subjectTabBtn.remove();
    document.getElementById('tab-admin')?.remove();
    document.getElementById('tab-center')?.remove();
    document.getElementById('tab-subject')?.remove();
    document.querySelectorAll('.schedule-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.schedule-tabs .tab-btn[data-tab="employee"]').classList.add('active');
    document.getElementById('tab-employee').classList.add('active');
  }
}

// ============================================
// DATA LOADING
// ============================================
async function loadAllCenters() {
  const snap = await get(ref(db, 'centers'));
  if (snap.exists()) {
    allCenters = Object.entries(snap.val()).map(([id, d]) => ({
      id, name: d.name || d.centerName || id
    }));
  }
  const existingIds = allCenters.map(c => c.id.toLowerCase());
  if (!existingIds.includes('t11')) allCenters.push({ id: 't11', name: 'T11' });
  if (!existingIds.includes('ao')) allCenters.push({ id: 'ao', name: 'AO' });
  if (!existingIds.includes('am')) allCenters.push({ id: 'am', name: 'AM' });
}

async function loadAllCalendarEvents() {
  calendarEvents = {};
  for (const center of allCenters) {
    try {
      const snap = await get(ref(db, `centers/${center.id}/calendar`));
      if (snap.exists()) calendarEvents[center.id] = snap.val();
    } catch (e) {
      console.warn(`Failed to load calendar for ${center.id}:`, e);
    }
  }
}

async function loadEmployees() {
  const snap = await get(ref(db, 'employees'));
  if (!snap.exists()) return;
  const allEmps = snap.val();
  Object.entries(allEmps).forEach(([uid, emp]) => {
    if (emp.isDisabled) return;
    if (isAdminOrManager) {
      employees[uid] = emp;
    } else {
      if (uid === currentUser.uid) employees[uid] = emp;
    }
  });
}

async function loadAllSchedules() {
  mergedSchedules = {};
  rawSchedulesByCenter = {};
  for (const center of allCenters) {
    try {
      const snap = await get(ref(db, `schedules/${center.id}`));
      if (snap.exists()) {
        const centerData = snap.val();
        rawSchedulesByCenter[center.id] = centerData;
        Object.entries(centerData).forEach(([empId, empSchedules]) => {
          if (!mergedSchedules[empId]) mergedSchedules[empId] = {};
          Object.entries(empSchedules).forEach(([dateStr, schedData]) => {
            const tagged = { ...schedData, _sourceCenter: center.id };
            if (!mergedSchedules[empId][dateStr]) {
              mergedSchedules[empId][dateStr] = tagged;
            } else {
              mergedSchedules[empId][dateStr] = mergeScheduleRecords(
                mergedSchedules[empId][dateStr], tagged
              );
            }
          });
        });
      }
    } catch (e) {
      console.warn(`Failed to load schedules for ${center.id}:`, e);
    }
  }
}

async function loadEmployeeOnly(uid) {
  try {
    const snap = await get(ref(db, `employees/${uid}`));
    if (snap.exists()) employees[uid] = snap.val();
  } catch (e) {
    console.error('Failed to load employee record:', e);
  }
}

async function loadEmployeeSchedulesOnly(uid) {
  mergedSchedules = {};
  rawSchedulesByCenter = {};
  mergedSchedules[uid] = {};
  const promises = allCenters.map(async (center) => {
    try {
      const snap = await get(ref(db, `schedules/${center.id}/${uid}`));
      if (snap.exists()) {
        const empSchedules = snap.val();
        rawSchedulesByCenter[center.id] = { [uid]: empSchedules };
        Object.entries(empSchedules).forEach(([dateStr, schedData]) => {
          const tagged = { ...schedData, _sourceCenter: center.id };
          if (!mergedSchedules[uid][dateStr]) {
            mergedSchedules[uid][dateStr] = tagged;
          } else {
            mergedSchedules[uid][dateStr] = mergeScheduleRecords(
              mergedSchedules[uid][dateStr], tagged
            );
          }
        });
      }
    } catch (e) {
      console.warn(`Failed to load schedules for ${center.id}:`, e);
    }
  });
  await Promise.all(promises);
}

async function loadEmployeeTemplateOnly(uid) {
  try {
    const snap = await get(ref(db, `scheduleTemplates/${uid}`));
    if (snap.exists()) templates[uid] = snap.val();
  } catch (e) {
    console.warn('Failed to load template:', e);
  }
}

async function loadCalendarEventsForEmployee() {
  calendarEvents = {};
  const promises = allCenters.map(async (center) => {
    try {
      const snap = await get(ref(db, `centers/${center.id}/calendar`));
      if (snap.exists()) calendarEvents[center.id] = snap.val();
    } catch (e) { /* silently skip */ }
  });
  await Promise.all(promises);
}

function mergeScheduleRecords(existing, incoming) {
  const merged = { ...existing };
  merged._sourceCenters = merged._sourceCenters || [merged._sourceCenter];
  if (!merged._sourceCenters.includes(incoming._sourceCenter)) {
    merged._sourceCenters.push(incoming._sourceCenter);
  }
  if (!merged._shifts) merged._shifts = extractShifts(merged);
  const incomingShifts = extractShifts(incoming);
  merged._shifts = [...merged._shifts, ...incomingShifts];
  if (incoming.notes && !merged.notes) merged.notes = incoming.notes;
  if (incoming.status && incoming.status !== 'scheduled') merged.status = incoming.status;
  return merged;
}

function extractShifts(sched) {
  const shifts = [];
  if (sched.shifts && Array.isArray(sched.shifts)) {
    sched.shifts.forEach(s => {
      shifts.push({
        type: s.type || 'work',
        start: s.start,
        end: s.end,
        center: s.center || sched._sourceCenter,
        otherDesc: s.otherDesc || '' 
      });
    });
  } else {
    if (sched.morningStart && sched.morningEnd) {
      shifts.push({ type: 'work', start: sched.morningStart, end: sched.morningEnd, center: sched.morningCenter || sched._sourceCenter });
    }
    if (sched.lunchStart && sched.lunchEnd) {
      shifts.push({ type: 'break', start: sched.lunchStart, end: sched.lunchEnd, center: null });
    }
    if (sched.afternoonStart && sched.afternoonEnd) {
      shifts.push({ type: 'work', start: sched.afternoonStart, end: sched.afternoonEnd, center: sched.afternoonCenter || sched._sourceCenter });
    }
  }
  return shifts;
}

async function loadAllTemplates() {
  templates = {};
  const snap = await get(ref(db, 'scheduleTemplates'));
  if (snap.exists()) {
    const allTemplates = snap.val();
    Object.entries(allTemplates).forEach(([empId, empTemplates]) => {
      templates[empId] = empTemplates;
    });
  }
}

// ============================================
// TAB SWITCHING & NAVIGATION
// ============================================
function setupTabs() {
  document.querySelectorAll('.schedule-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.schedule-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

function setupAdminNav() {
  document.getElementById('prevWeekBtn')?.addEventListener('click', () => {
    viewStartDate = addDays(viewStartDate, -7);
    renderAdminView();
  });
  document.getElementById('nextWeekBtn')?.addEventListener('click', () => {
    viewStartDate = addDays(viewStartDate, 7);
    renderAdminView();
  });
  document.getElementById('todayBtn')?.addEventListener('click', () => {
    viewStartDate = getMonday(new Date());
    renderAdminView();
  });
  document.getElementById('applyPatternBtn')?.addEventListener('click', applyPatternsToMonth);
  document.getElementById('adminSearchInput')?.addEventListener('input', () => {
    renderAdminView();
  });
  document.getElementById('adminMobileBackBtn')?.addEventListener('click', closeAdminMobileDetail);
  document.getElementById('adminMobileCalPrev')?.addEventListener('click', () => {
      adminMobileCalDate.setMonth(adminMobileCalDate.getMonth() - 1);
      renderAdminMobileCalendar();
  });
  document.getElementById('adminMobileCalNext')?.addEventListener('click', () => {
      adminMobileCalDate.setMonth(adminMobileCalDate.getMonth() + 1);
      renderAdminMobileCalendar();
  });
}

function setupEmployeeNav() {
  document.getElementById('empPrevWeekBtn')?.addEventListener('click', () => {
    empViewStartDate = addDays(empViewStartDate, -7);
    renderEmployeeView();
  });
  document.getElementById('empNextWeekBtn')?.addEventListener('click', () => {
    empViewStartDate = addDays(empViewStartDate, 7);
    renderEmployeeView();
  });
  document.getElementById('empTodayBtn')?.addEventListener('click', () => {
    empViewStartDate = getMonday(new Date());
    renderEmployeeView();
  });
  document.getElementById('employeeDropdown')?.addEventListener('change', () => {
    renderEmployeeView();
  });
}

function setupSubjectNav() {
  const dropdown = document.getElementById('subjectDropdown');
  if (!dropdown) return;
  dropdown.addEventListener('change', () => {
    selectedSubjectFilter = dropdown.value;
    renderSubjectView();
  });
  document.getElementById('subjectPrevBtn')?.addEventListener('click', () => {
    subjectViewDate = addDays(subjectViewDate, -7);
    renderSubjectView();
  });
  document.getElementById('subjectNextBtn')?.addEventListener('click', () => {
    subjectViewDate = addDays(subjectViewDate, 7);
    renderSubjectView();
  });
  document.getElementById('subjectTodayBtn')?.addEventListener('click', () => {
    subjectViewDate = getMonday(new Date());
    renderSubjectView();
  });
  document.getElementById('printSubjectBtn')?.addEventListener('click', printSubjectSchedule);
}

// ============================================
// SORTING
// ============================================
function getSortedEmployees() {
  const empList = Object.entries(employees).map(([uid, e]) => ({ uid, ...e }));
  empList.sort((a, b) => {
    const termsA = a.terms === 'Full-time' ? 0 : 1;
    const termsB = b.terms === 'Full-time' ? 0 : 1;
    if (termsA !== termsB) return termsA - termsB;
    const getHighestRoleIndex = (emp) => {
      const positions = getEmpPositions(emp);
      let minIndex = 99;
      positions.forEach(p => {
        const idx = ROLE_ORDER.indexOf(p);
        if (idx !== -1 && idx < minIndex) minIndex = idx;
      });
      return minIndex;
    };
    const rA = getHighestRoleIndex(a);
    const rB = getHighestRoleIndex(b);
    if (rA !== rB) return rA - rB;
    return (a.englishName || '').localeCompare(b.englishName || '');
  });
  return empList;
}

// ============================================
// ADMIN VIEW
// ============================================
function renderAdminView() {
    const dates = get21Days(viewStartDate);
    updateWeekRange('weekRangeDisplay', dates);
    renderAdminHeader(dates);
    renderAdminBody(dates);
    renderAdminMobileView(); // 🆕 Render mobile list/calendar
}

function renderAdminHeader(dates) {
  const row = document.getElementById('adminHeaderRow');
  if (!row) return;
  row.innerHTML = '<th class="employee-header">' + t('schedule.printEmployee') + '</th>';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  dates.forEach(d => {
    const dateObj = parseDate(d);
    const dow = dateObj.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = dateObj.getTime() === today.getTime();
    const holidayInfo = getHolidayForDate(d);
    const isHoliday = holidayInfo && !holidayInfo.muc;
    let cls = 'day-header';
    if (isHoliday) cls += ' holiday-col';
    else if (isToday) cls += ' today-col';
    else if (isWeekend) cls += ' weekend';
    let title = `${DAY_SHORT[dow]} ${d}`;
    if (isHoliday) title += `— ${holidayInfo.name || t('schedule.holiday')}`;
    row.innerHTML += `<th class="${cls}" title="${title}">${DAY_SHORT[dow]}<br>${dateObj.getDate()}</th>`;
  });
}

function renderAdminBody(dates) {
  const tbody = document.getElementById('adminBody');
  const emptyState = document.getElementById('adminEmptyState');
  const tableWrapper = document.querySelector('#tab-admin .table-wrapper');
  if (!tbody) return;
  const sorted = getSortedEmployees();
  const searchInput = document.getElementById('adminSearchInput');
  const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const filtered = sorted.filter(emp => {
    if (!searchTerm) return true;
    const name = (emp.englishName || '').toLowerCase();
    const roles = getEmpPositions(emp).join(' ').toLowerCase();
    return name.includes(searchTerm) || roles.includes(searchTerm);
  });
  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('hidden');
    if (tableWrapper) tableWrapper.style.display = 'none';
    return;
  }
  emptyState.classList.add('hidden');
  if (tableWrapper) tableWrapper.style.display = '';
  tbody.innerHTML = '';
  let lastTerms = null;
  filtered.forEach(emp => {
    if (lastTerms !== null && emp.terms !== lastTerms) {
      const divRow = document.createElement('tr');
      divRow.className = 'section-divider';
      divRow.innerHTML = `<td colspan="${dates.length + 1}">${t('schedule.partTimeDivider')}</td>`;
      tbody.appendChild(divRow);
    }
    lastTerms = emp.terms;
    const tr = document.createElement('tr');
    const termsClass = emp.terms === 'Full-time' ? 'terms-full' : 'terms-part';
    const termsLabel = emp.terms === 'Full-time' ? 'FT' : 'PT';
    tr.innerHTML = `<td class="employee-name-cell">
        ${emp.englishName || 'Unknown'}
        <span class="emp-terms ${termsClass}">${termsLabel}</span>
        <span class="emp-role">${getEmpPositions(emp).join(', ') || ''}</span>
    </td>`;
    dates.forEach(dateStr => {
      const td = document.createElement('td');
      td.className = 'schedule-cell';
      const sched = mergedSchedules[emp.uid]?.[dateStr];
      const tmpl = getTemplateForDate(emp.uid, dateStr);
      if (sched) {
        renderMergedScheduleCell(td, sched, emp.uid, dateStr);
      } else if (tmpl) {
        td.classList.add('has-schedule');
        td.style.opacity = '0.5';
        renderMergedScheduleCell(td, tmpl, emp.uid, dateStr);
        td.title = t('schedule.recurringPattern');
      } else {
        td.classList.add('empty-cell');
        td.innerHTML = '<div class="cell-content">—</div>';
      }
      td.addEventListener('click', () => openEditModal(emp.uid, dateStr));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function hasValidShifts(shifts) {
  if (!shifts || shifts.length === 0) return false;
  return shifts.some(s => s.start && s.end && s.start !== '--:--' && s.end !== '--:--');
}

function renderMergedScheduleCell(td, sched, empId, dateStr) {
  const status = sched.status || 'scheduled';
  if (status !== 'scheduled') {
    const statusMap = {
      'other-center': { cls: 'status-other', label: t('schedule.otherCenter') },
      'leave': { cls: 'status-leave', label: t('schedule.leave') },
      'sick': { cls: 'status-sick', label: t('schedule.sick') },
      'off': { cls: 'status-off', label: t('schedule.off') }
    };
    const s = statusMap[status] || { cls: '', label: status };
    td.classList.add(s.cls);
    let html = `<div class="cell-content"><span class="status-label">${s.label}</span>`;
    if (sched.notes) html += `<div class="notes-indicator">📝 ${sched.notes}</div>`;
    html += '</div>';
    td.innerHTML = html;
    return;
  }
  const shifts = sched._shifts || extractShifts(sched);
  if (!hasValidShifts(shifts)) {
    td.classList.add('empty-cell');
    td.innerHTML = '<div class="cell-content">—</div>';
    return;
  }
  td.classList.add('has-schedule');
  let html = '<div class="cell-content">';
  const sortedShifts = [...shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  sortedShifts.forEach(shift => {
    if (shift.type === 'break') {
      html += `<div class="shift-line break-line">☕ ${shift.start}-${shift.end}</div>`;
    } else {
      const badge = getShiftBadgeInfo(shift);
      html += `<div class="shift-line">
        <span class="shift-time">${shift.start}-${shift.end}</span>
        <span class="shift-center ${badge.cls}" title="${badge.title}">${badge.label}</span>
      </div>`;
    }
  });
  const holidayInfo = getHolidayForDate(dateStr);
  if (holidayInfo && !holidayInfo.muc) {
    html += `<div class="holiday-indicator">🎌 ${holidayInfo.name || t('schedule.holiday')}</div>`;
  }
  if (sched.notes) html += `<div class="notes-indicator">📝</div>`;
  html += '</div>';
  td.innerHTML = html;
}


// ============================================
// 🆕 "OTHER" ASSIGNMENT HELPERS
// ============================================
function escapeHtml(str) {
  return (str == null ? '' : String(str))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Badge info for a shift line (center abbr OR "Other" description) */
function getShiftBadgeInfo(shift) {
  if (shift.center === 'other') {
    const desc = (shift.otherDesc || '').trim();
    const label = desc
      ? (desc.length > 12 ? desc.slice(0, 12).trim() + '…' : desc)
      : t('schedule.centerOther');
    return { label: escapeHtml(label), cls: 'c-OTHER', title: escapeHtml(desc || label) };
  }
  const c = allCenters.find(x => x.id === shift.center);
  return {
    label: escapeHtml(getCenterAbbr(shift.center)),
    cls: getCenterClass(shift.center),
    title: escapeHtml(c ? c.name : (shift.center || ''))
  };
}

/** Show/hide the hidden description field when center = Other */
function toggleOtherDescField(selectEl) {
  const shiftDiv = selectEl.closest('.shift-item');
  if (!shiftDiv) return;
  const otherField = shiftDiv.querySelector('.other-field');
  if (otherField) otherField.style.display = (selectEl.value === 'other') ? '' : 'none';
}

function getCenterAbbr(centerId) {
  if (!centerId) return '?';
  const c = allCenters.find(x => x.id === centerId);
  if (!c) return centerId.substring(0, 4).toUpperCase();
  const n = c.name.toLowerCase();
  if (n.includes('mei keng')) return 'MK';
  if (n.includes('pac tat')) return 'PT';
  if (n.includes('tap siac')) return 'TS';
  if (n.includes('champs')) return 'C';
  if (n.includes('t11')) return 'T11';
  if (n.includes('ao')) return 'AO';
  if (n.includes('am')) return 'AM';
  return c.name.substring(0, 4).toUpperCase();
}
function getCenterClass(centerId) {
  const abbr = getCenterAbbr(centerId);
  return `c-${abbr}`;
}
function getHolidayForDate(dateStr) {
  for (const centerId in calendarEvents) {
    const events = calendarEvents[centerId];
    if (events && events[dateStr] && !events[dateStr].muc) {
      return events[dateStr];
    }
  }
  return null;
}
function isCenterClosedOnDay(centerId, dayOfWeek) {
  if (!centerId) return false;
  const center = allCenters.find(c => c.id === centerId);
  if (!center) return false;
  const name = center.name.toLowerCase();
  let closedDays = [0];
  if (name.includes('mei keng')) closedDays = CENTER_CLOSED_DAYS['mei keng'];
  else if (name.includes('pac tat')) closedDays = CENTER_CLOSED_DAYS['pac tat'];
  else if (name.includes('champs')) closedDays = CENTER_CLOSED_DAYS['champs'];
  else if (name.includes('tap siac')) closedDays = CENTER_CLOSED_DAYS['tap siac'];
  else if (name.includes('t11')) closedDays = CENTER_CLOSED_DAYS['t11'];
  else if (name.includes('ao')) closedDays = CENTER_CLOSED_DAYS['ao'];
  else if (name.includes('am')) closedDays = CENTER_CLOSED_DAYS['am'];
  return closedDays.includes(dayOfWeek);
}
function getClosedDaysForCenter(name) {
  const lowerName = (name || '').toLowerCase();
  if (lowerName.includes('mei keng')) return CENTER_CLOSED_DAYS['mei keng'];
  if (lowerName.includes('pac tat')) return CENTER_CLOSED_DAYS['pac tat'];
  if (lowerName.includes('champs')) return CENTER_CLOSED_DAYS['champs'];
  if (lowerName.includes('tap siac')) return CENTER_CLOSED_DAYS['tap siac'];
  if (lowerName.includes('t11')) return CENTER_CLOSED_DAYS['t11'];
  if (lowerName.includes('ao')) return CENTER_CLOSED_DAYS['ao'];
  if (lowerName.includes('am')) return CENTER_CLOSED_DAYS['am'];
  return [0];
}

// ============================================
// EMPLOYEE VIEW
// ============================================
function renderEmployeeView() {
  const selectorWrap = document.getElementById('employeeSelectorWrap');
  const dropdown = document.getElementById('employeeDropdown');
  if (isAdminOrManager) {
    selectorWrap.classList.remove('hidden');
    const sorted = getSortedEmployees();
    const currentVal = dropdown.value;
    dropdown.innerHTML = '';
    sorted.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp.uid;
      opt.textContent = `${emp.englishName} (${getEmpPositions(emp).join(', ')})`;
      dropdown.appendChild(opt);
    });
    if (!currentVal && employees[currentUser.uid]) {
      dropdown.value = currentUser.uid;
    } else if (currentVal && employees[currentVal]) {
      dropdown.value = currentVal;
    } else if (sorted.length > 0) {
      dropdown.value = sorted[0].uid;
    }
  } else {
    selectorWrap.classList.add('hidden');
  }
  const empId = isAdminOrManager ? dropdown.value : currentUser.uid;
  if (!empId) {
    const tbody = document.getElementById('empBody');
    if (tbody) tbody.innerHTML = '';
    const emptyState = document.getElementById('empEmptyState');
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }
  const dates = get21Days(empViewStartDate);
  updateWeekRange('empWeekRangeDisplay', dates);
  renderEmployeeHeader(dates);
  renderEmployeeBody(dates, empId);
}

function renderEmployeeHeader(dates) {
  const row = document.getElementById('empHeaderRow');
  if (!row) return;
  row.innerHTML = `<th class="employee-header">${t('pending.date')}</th>`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  dates.forEach(d => {
    const dateObj = parseDate(d);
    const dow = dateObj.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = dateObj.getTime() === today.getTime();
    const holidayInfo = getHolidayForDate(d);
    const isHoliday = holidayInfo && !holidayInfo.muc;
    let cls = 'day-header';
    if (isHoliday) cls += ' holiday-col';
    else if (isToday) cls += ' today-col';
    else if (isWeekend) cls += ' weekend';
    row.innerHTML += `<th class="${cls}"> ${DAY_NAMES[dow]}<br>${dateObj.getDate()} ${MONTH_NAMES[dateObj.getMonth()].substring(0, 3)} </th>`;
  });
}

function renderEmployeeBody(dates, empId) {
  const tbody = document.getElementById('empBody');
  const mobileList = document.getElementById('employeeMobileList');
  const emptyState = document.getElementById('empEmptyState');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (mobileList) mobileList.innerHTML = '';
  let hasAnySchedule = false;
  const tr = document.createElement('tr');
  const emp = employees[empId];
  const empLabel = emp ? `${emp.englishName} — ${getEmpPositions(emp).join(', ')}` : t('schedule.scheduleFallback');
  tr.innerHTML = `<td class="employee-name-cell">${empLabel}</td>`;
  dates.forEach(dateStr => {
    const td = document.createElement('td');
    td.className = 'schedule-cell';
    const sched = mergedSchedules[empId]?.[dateStr];
    const tmpl = getTemplateForDate(empId, dateStr);
    if (sched) {
      hasAnySchedule = true;
      renderMergedScheduleCell(td, sched, empId, dateStr);
    } else if (tmpl) {
      hasAnySchedule = true;
      td.classList.add('has-schedule');
      renderMergedScheduleCell(td, tmpl, empId, dateStr);
    } else {
      td.classList.add('empty-cell');
      td.innerHTML = `<div class="cell-content">${t('schedule.noSchedule')}</div>`;
    }
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
  // Mobile list view
  if (mobileList && emp) {
    const mobileCard = document.createElement('div');
    mobileCard.className = 'employee-mobile-card';
    mobileCard.innerHTML = `
        <div class="employee-mobile-header">
            ${emp.englishName || 'Unknown'}
            <span class="emp-role">${getEmpPositions(emp).join(', ')}</span>
        </div>
        <div class="employee-mobile-schedule" id="mobile-sched-${empId}"></div>
    `;
    const scheduleContainer = mobileCard.querySelector(`#mobile-sched-${empId}`);
    dates.forEach(dateStr => {
      const dateObj = parseDate(dateStr);
      const dow = dateObj.getDay();
      const sched = mergedSchedules[empId]?.[dateStr];
      const tmpl = getTemplateForDate(empId, dateStr);
      const item = document.createElement('div');
      item.className = 'mobile-schedule-item';
      let detailsHTML = '';
      if (sched || tmpl) {
        hasAnySchedule = true;
        const data = sched || tmpl;
        const status = data.status || 'scheduled';
        if (status !== 'scheduled') {
          const statusLabels = {
            'other-center': t('schedule.otherCenter'),
            'leave': t('schedule.leave'),
            'sick': t('schedule.sick'),
            'off': t('schedule.off')
          };
          const statusClass = status === 'leave' ? 'leave' :
                             status === 'sick' ? 'sick' :
                             status === 'off' ? 'off' : 'other';
          detailsHTML = `<span class="mobile-status ${statusClass}">${statusLabels[status] || status}</span>`;
        } else {
          const shifts = data._shifts || extractShifts(data);
          if (hasValidShifts(shifts)) {
            const sortedShifts = [...shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
            sortedShifts.forEach(shift => {
              if (shift.type === 'break') {
                detailsHTML += `<div class="mobile-shift break">☕ ${shift.start} - ${shift.end}</div>`;
                } else {
                  const badge = getShiftBadgeInfo(shift);
                  detailsHTML += `
                    <div class="mobile-shift">
                      ${shift.start} - ${shift.end}
                      <span class="mobile-center-badge ${badge.cls}">${badge.label}</span>
                    </div>
                  `;
                }
            });
          }
        }
        if (data.notes) {
          detailsHTML += `<div style="font-size: 0.75rem; color: #999; margin-top: 0.25rem;">📝 ${data.notes}</div>`;
        }
      }
      if (!detailsHTML) {
        detailsHTML = `<span class="mobile-empty">${t('schedule.noSchedule')}</span>`;
      }
      const dayName = DAY_NAMES[dow];
      const dateDisplay = `${dateObj.getDate()} ${MONTH_NAMES[dateObj.getMonth()].substring(0, 3)}`;
      item.innerHTML = `
          <div class="mobile-date">
              ${dayName}
              <span class="day-name">${dateDisplay}</span>
          </div>
          <div class="mobile-schedule-details">
              ${detailsHTML}
          </div>
      `;
      scheduleContainer.appendChild(item);
    });
    mobileList.appendChild(mobileCard);
  }
  if (!hasAnySchedule) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
  }
}

// ============================================
// PER SUBJECT VIEW
// ============================================
function renderSubjectView() {
  const dates = get21Days(subjectViewDate);
  updateWeekRange('subjectWeekRangeDisplay', dates);
  renderSubjectHeader(dates);
  renderSubjectBody(dates);
}

function renderSubjectHeader(dates) {
  const row = document.getElementById('subjectHeaderRow');
  if (!row) return;
  row.innerHTML = `<th class="employee-header">${t('schedule.printTeacher')}</th>`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  dates.forEach(d => {
    const dateObj = parseDate(d);
    const dow = dateObj.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = dateObj.getTime() === today.getTime();
    const holidayInfo = getHolidayForDate(d);
    const isHoliday = holidayInfo && !holidayInfo.muc;
    let cls = 'day-header';
    if (isHoliday) cls += ' holiday-col';
    else if (isToday) cls += ' today-col';
    else if (isWeekend) cls += ' weekend';
    let title = `${DAY_SHORT[dow]} ${d}`;
    if (isHoliday) title += `— ${holidayInfo.name || t('schedule.holiday')}`;
    row.innerHTML += `<th class="${cls}" title="${title}">${DAY_SHORT[dow]}<br>${dateObj.getDate()}</th>`;
  });
}

function buildSubjectGroups(sorted) {
  const subjectGroups = {};
  const subjectOrder = ['English Teacher', 'Math Teacher', 'Chinese Teacher', 'Tutorial Teacher'];
  const adminRoles = ['Admin'];
  const otherTeachers = [];
  const addedEmpIds = new Set();
  sorted.forEach(emp => {
    const positions = getEmpPositions(emp);
    let matchedSubject = false;
    for (const subj of subjectOrder) {
      if (positions.includes(subj)) {
        if (!subjectGroups[subj]) subjectGroups[subj] = [];
        subjectGroups[subj].push(emp);
        matchedSubject = true;
        addedEmpIds.add(emp.uid);
      }
    }
    if (!matchedSubject && !addedEmpIds.has(emp.uid)) {
      const hasAdminRole = positions.some(p => adminRoles.includes(p));
      if (!hasAdminRole) {
        otherTeachers.push(emp);
        addedEmpIds.add(emp.uid);
      }
    }
  });
  return { subjectGroups, subjectOrder, otherTeachers };
}

function getGroupsToShow() {
  const sorted = getSortedEmployees();
  const { subjectGroups, subjectOrder, otherTeachers } = buildSubjectGroups(sorted);
  let groupsToShow = [];
  if (selectedSubjectFilter === 'all') {
    subjectOrder.forEach(subj => {
      if (subjectGroups[subj] && subjectGroups[subj].length > 0) {
        groupsToShow.push({ subject: subj, teachers: subjectGroups[subj] });
      }
    });
    if (otherTeachers.length > 0) {
      groupsToShow.push({ subject: 'Other', teachers: otherTeachers });
    }
  } else {
    if (subjectGroups[selectedSubjectFilter] && subjectGroups[selectedSubjectFilter].length > 0) {
      groupsToShow.push({ subject: selectedSubjectFilter, teachers: subjectGroups[selectedSubjectFilter] });
    }
  }
  return groupsToShow;
}

function renderSubjectBody(dates) {
  const tbody = document.getElementById('subjectBody');
  const emptyState = document.getElementById('subjectEmptyState');
  const tableWrapper = document.getElementById('subjectTableWrapper');
  if (!tbody) return;
  const groupsToShow = getGroupsToShow();
  const totalTeachers = groupsToShow.reduce((sum, g) => sum + g.teachers.length, 0);
  if (totalTeachers === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('hidden');
    if (tableWrapper) tableWrapper.style.display = 'none';
    return;
  }
  emptyState.classList.add('hidden');
  if (tableWrapper) tableWrapper.style.display = '';
  tbody.innerHTML = '';
  const dailyCounts = {};
  dates.forEach(d => dailyCounts[d] = 0);
  const countedEmpIdsByDate = {};
  dates.forEach(d => countedEmpIdsByDate[d] = new Set());
  groupsToShow.forEach(group => {
    const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, icon: '👤', cls: 'other-divider', color: '#8e44ad' };
    const divRow = document.createElement('tr');
    divRow.className = `subject-divider ${config.cls}`;
    const countLabel = group.teachers.length !== 1 ? t('schedule.teacherPlural') : t('schedule.teacherSingular');
    divRow.innerHTML = `<td colspan="${dates.length + 1}">
        <span class="subject-icon">${config.icon}</span> ${trLabel(config.label)}
        <span class="subject-count">${group.teachers.length} ${countLabel}</span>
    </td>`;
    tbody.appendChild(divRow);
    group.teachers.forEach(emp => {
      const tr = document.createElement('tr');
      const termsClass = emp.terms === 'Full-time' ? 'terms-full' : 'terms-part';
      const termsLabel = emp.terms === 'Full-time' ? 'FT' : 'PT';
      tr.innerHTML = `<td class="employee-name-cell">
          ${emp.englishName || 'Unknown'}
          <span class="emp-terms ${termsClass}">${termsLabel}</span>
          <span class="emp-role">${getEmpPositions(emp).join(', ') || ''}</span>
      </td>`;
      dates.forEach(dateStr => {
        const td = document.createElement('td');
        td.className = 'schedule-cell';
        const sched = mergedSchedules[emp.uid]?.[dateStr];
        const tmpl = getTemplateForDate(emp.uid, dateStr);
        if (sched) {
          renderMergedScheduleCell(td, sched, emp.uid, dateStr);
          const shifts = sched._shifts || extractShifts(sched);
          if (hasValidShifts(shifts) && (sched.status || 'scheduled') === 'scheduled') {
            if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
              countedEmpIdsByDate[dateStr].add(emp.uid);
              dailyCounts[dateStr]++;
            }
          }
        } else if (tmpl) {
          td.classList.add('has-schedule');
          td.style.opacity = '0.5';
          renderMergedScheduleCell(td, tmpl, emp.uid, dateStr);
          td.title = t('schedule.recurringPattern');
          const tmplShifts = tmpl._shifts || extractShifts(tmpl);
          if (hasValidShifts(tmplShifts) && (tmpl.status || 'scheduled') === 'scheduled') {
            if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
              countedEmpIdsByDate[dateStr].add(emp.uid);
              dailyCounts[dateStr]++;
            }
          }
        } else {
          td.classList.add('empty-cell');
          td.innerHTML = '<div class="cell-content">—</div>';
        }
        td.addEventListener('click', () => openEditModal(emp.uid, dateStr));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  });
  const summaryRow = document.createElement('tr');
  summaryRow.className = 'subject-summary-row';
  summaryRow.innerHTML = `<td style="font-weight:700;">${t('schedule.teachersOnDuty')}</td>`;
  dates.forEach(d => {
    summaryRow.innerHTML += `<td style="text-align:center;">${dailyCounts[d]}</td>`;
  });
  tbody.appendChild(summaryRow);
}

// ============================================
// PER SUBJECT PRINT
// ============================================
function printSubjectSchedule() {
  const dates = get21Days(subjectViewDate);
  const firstDate = parseDate(dates[0]);
  const lastDate = parseDate(dates[dates.length - 1]);
  const dateRangeStr = `${firstDate.getDate()} ${MONTH_NAMES[firstDate.getMonth()]} — ${lastDate.getDate()} ${MONTH_NAMES[lastDate.getMonth()]} ${lastDate.getFullYear()}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const groupsToShow = getGroupsToShow();
  const filterLabel = selectedSubjectFilter === 'all'
    ? t('schedule.allSubjects')
    : (SUBJECT_CONFIG[selectedSubjectFilter] ? trLabel(SUBJECT_CONFIG[selectedSubjectFilter].label) : selectedSubjectFilter);

  let html = `
  <div class="print-header">
      <h1>${t('schedule.printTeacherSchedule', { label: filterLabel })}</h1>
      <p class="print-subtitle">${t('schedule.printSubtitle')}</p>
      <p class="print-date-range">${dateRangeStr}</p>
  </div>
  <div class="print-table-wrapper">
      <table class="print-subject-table">
          <thead>
              <tr>
                  <th class="employee-col">${t('schedule.printTeacher')}</th>`;
  dates.forEach(d => {
    const dateObj = parseDate(d);
    const dow = dateObj.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = dateObj.getTime() === today.getTime();
    const holidayInfo = getHolidayForDate(d);
    const isHoliday = holidayInfo && !holidayInfo.muc;
    let cls = '';
    if (isHoliday) cls = 'style="background:#e74c3c !important;color:white !important;"';
    else if (isToday) cls = 'class="today-col"';
    else if (isWeekend) cls = 'class="weekend-col"';
    html += `<th ${cls}>${DAY_SHORT[dow]}<br>${dateObj.getDate()}</th>`;
  });
  html += `</tr></thead><tbody>`;

  const dailyCounts = {};
  dates.forEach(d => dailyCounts[d] = 0);
  const countedEmpIdsByDate = {};
  dates.forEach(d => countedEmpIdsByDate[d] = new Set());

  groupsToShow.forEach(group => {
    const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, icon: '👤', color: '#8e44ad' };
    const dividerCls = getPrintDividerClass(group.subject);
    const dividerBg = config.color || '#8e44ad';
    html += `<tr class="print-subject-divider ${dividerCls}">
        <td colspan="${dates.length + 1}"
            style="background:${dividerBg} !important; color:#ffffff !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important;">
            ${config.icon} ${trLabel(config.label)} (${group.teachers.length})
        </td>
    </tr>`;
    group.teachers.forEach(emp => {
      const termsCls = emp.terms === 'Full-time' ? 'ft' : 'pt';
      const termsLbl = emp.terms === 'Full-time' ? 'FT' : 'PT';
      html += `<tr>
          <td class="employee-col">
              ${emp.englishName || 'Unknown'}
              <span class="terms-tag ${termsCls}">${termsLbl}</span>
              <span class="role-tag">${getEmpPositions(emp).join(', ') || ''}</span>
          </td>`;
      dates.forEach(dateStr => {
        const sched = mergedSchedules[emp.uid]?.[dateStr];
        const tmpl = getTemplateForDate(emp.uid, dateStr);
        let shifts = [];
        let status = 'scheduled';
        let notes = '';
        let isTemplate = false;
        if (sched) {
          shifts = sched._shifts || extractShifts(sched);
          status = sched.status || 'scheduled';
          notes = sched.notes || '';
        } else if (tmpl) {
          shifts = tmpl._shifts || extractShifts(tmpl);
          status = tmpl.status || 'scheduled';
          notes = tmpl.notes || '';
          isTemplate = true;
        }
        let cellContent = '';
        if (hasValidShifts(shifts) || status !== 'scheduled') {
          if (status !== 'scheduled') {
            const statusLabels = {
              'other-center': t('schedule.otherCenter'),
              'leave': t('schedule.leave'),
              'sick': t('schedule.sick'),
              'off': t('schedule.off')
            };
            const statusCls = status === 'leave' ? 'leave' : status === 'sick' ? 'sick' : status === 'off' ? 'off' : 'other';
            cellContent = `<span class="print-status ${statusCls}">${statusLabels[status] || status}</span>`;
          } else {
            if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
              countedEmpIdsByDate[dateStr].add(emp.uid);
              dailyCounts[dateStr]++;
            }
            const sortedShifts = [...shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
            sortedShifts.forEach(s => {
              if (s.type === 'break') {
                cellContent += `<div class="print-shift break-shift">☕ ${s.start}-${s.end}</div>`;
                } else {
                  const badge = getShiftBadgeInfo(s);
                  cellContent += `<div class="print-shift"><span class="time">${s.start}-${s.end}</span> <span style="font-weight:700;font-size:5.5pt;">${badge.label}</span></div>`;
                }
            });
            if (isTemplate) {
              cellContent += `<div style="font-size:5pt;color:#888;font-style:italic;">${t('schedule.printPattern')}</div>`;
            }
          }
        } else {
          cellContent = '—';
        }
        html += `<td>${cellContent}</td>`;
      });
      html += '</tr>';
    });
  });
  html += `<tr class="summary-row"><td>${t('schedule.printOnDuty')}</td>`;
  dates.forEach(d => { html += `<td>${dailyCounts[d]}</td>`; });
  html += '</tr></tbody></table></div>';
  html += `
  <div class="print-legend">
      <div class="print-legend-item"><span class="print-legend-color" style="background:#3498db;"></span> MK</div>
      <div class="print-legend-item"><span class="print-legend-color" style="background:#9b59b6;"></span> PT</div>
      <div class="print-legend-item"><span class="print-legend-color" style="background:#e67e22;"></span> TS</div>
      <div class="print-legend-item"><span class="print-legend-color" style="background:#27ae60;"></span> C</div>
      <div class="print-legend-item"><span class="print-legend-color" style="background:#16a085;"></span> T11</div>
      <div class="print-legend-item"><span class="print-legend-color" style="background:#d35400;"></span> AO</div>
      <div class="print-legend-item"><span class="print-legend-color" style="background:#34495e;"></span> AM</div>
      <div class="print-legend-item"><span class="print-legend-color" style="background:#e74c3c;"></span> ${t('schedule.holiday')}</div>
  </div>
  <div class="print-footer">
      ${t('schedule.printFooterSubject', { time: new Date().toLocaleString() })}
  </div>`;
  const printArea = document.getElementById('printArea');
  if (printArea) printArea.innerHTML = html;
  window.print();
  setTimeout(() => { if (printArea) printArea.innerHTML = ''; }, 1000);
}

// ============================================
// MODAL — DYNAMIC SHIFTS
// ============================================
function setupModal() {
  document.getElementById('modalCloseBtn')?.addEventListener('click', closeModal);
  document.getElementById('cancelModalBtn')?.addEventListener('click', closeModal);
  document.getElementById('saveScheduleBtn')?.addEventListener('click', saveSchedule);
  document.getElementById('clearDayBtn')?.addEventListener('click', clearDay);
  document.getElementById('addShiftBtn')?.addEventListener('click', addShiftRow);
  document.getElementById('scheduleModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'scheduleModal') closeModal();
  });
  document.getElementById('patternCalPrevBtn')?.addEventListener('click', () => {
    calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
    renderPatternCalendar();
  });
  document.getElementById('patternCalNextBtn')?.addEventListener('click', () => {
    calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
    renderPatternCalendar();
  });
  document.getElementById('patternCalendarGrid')?.addEventListener('change', (e) => {
    if (e.target.classList.contains('pattern-date-cb')) {
      const dateStr = e.target.value;
      const dayCell = e.target.closest('.calendar-day');
      if (e.target.checked) {
        selectedPatternDates.add(dateStr);
        dayCell.classList.add('checked');
      } else {
        selectedPatternDates.delete(dateStr);
        dayCell.classList.remove('checked');
      }
    }
  });
}

function renderPatternCalendar() {
  const container = document.getElementById('patternCalendarGrid');
  const monthLabel = document.getElementById('patternCalendarMonth');
  if (!container || !monthLabel) return;
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  monthLabel.textContent = `${MONTH_NAMES[month]} ${year}`;
  container.innerHTML = '';
  DAY_SHORT.forEach(day => {
    const header = document.createElement('div');
    header.className = 'calendar-day-header';
    header.textContent = day;
    container.appendChild(header);
  });
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < firstDayOfMonth; i++) {
    const empty = document.createElement('div');
    empty.className = 'calendar-day empty';
    container.appendChild(empty);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateStr = formatDateStr(dateObj);
    const dow = dateObj.getDay();
    const cell = document.createElement('label');
    cell.className = 'calendar-day';
    if (selectedPatternDates.has(dateStr)) cell.classList.add('checked');
    if (dateObj < today) cell.classList.add('disabled');
    const holidayInfo = getHolidayForDate(dateStr);
    if (holidayInfo && !holidayInfo.muc) {
      cell.classList.add('holiday');
      cell.title = holidayInfo.name || t('schedule.holiday');
    }
    const shiftCenters = Array.from(document.querySelectorAll('.shift-center')).map(s => s.value).filter(v => v);
    let isClosed = false;
    if (shiftCenters.length > 0) {
      isClosed = shiftCenters.some(c => isCenterClosedOnDay(c, dow));
    } else if (editingSourceCenter) {
      isClosed = isCenterClosedOnDay(editingSourceCenter, dow);
    }
    if (isClosed) {
      cell.classList.add('closed');
      cell.title = t('schedule.closed');
    }
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'pattern-date-cb';
    checkbox.value = dateStr;
    checkbox.checked = selectedPatternDates.has(dateStr);
    if (cell.classList.contains('disabled')) checkbox.disabled = true;
    cell.appendChild(checkbox);
    cell.appendChild(document.createTextNode(day));
    container.appendChild(cell);
  }
}

function populateCenterDropdown(selectEl, selectedValue = '') {
  selectEl.innerHTML = '<option value="">-- None --</option>';
  allCenters.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.id === selectedValue) opt.selected = true;
    selectEl.appendChild(opt);
  });
  // 🆕 "Other" option
  const otherOpt = document.createElement('option');
  otherOpt.value = 'other';
  otherOpt.textContent = t('schedule.centerOther');
  if (selectedValue === 'other') otherOpt.selected = true;
  selectEl.appendChild(otherOpt);
}

function addShiftRow(shiftData = null) {
  shiftCounter++;
  const container = document.getElementById('shiftsContainer');
  const shiftDiv = document.createElement('div');
  shiftDiv.className = 'shift-item';
  shiftDiv.dataset.shiftId = shiftCounter;
  const isBreak = shiftData?.type === 'break';
  if (isBreak) shiftDiv.classList.add('break-shift');
  const typeOptions = `<option value="work" ${!isBreak ? 'selected' : ''}>${t('schedule.work')}</option> <option value="break" ${isBreak ? 'selected' : ''}>${t('schedule.break')}</option>`;
  shiftDiv.innerHTML = `<div class="shift-field"> <label>${t('schedule.shiftType')}</label> <select class="shift-type" onchange="toggleShiftType(this)"> ${typeOptions} </select> </div> <div class="shift-field"> <label>${t('schedule.shiftStart')}</label> <input type="time" class="shift-start" value="${shiftData?.start || ''}"> </div> <div class="shift-field"> <label>${t('schedule.shiftEnd')}</label> <input type="time" class="shift-end" value="${shiftData?.end || ''}"> </div> <div class="shift-field center-field" style="${isBreak ? 'display:none' : ''}"> <label>${t('schedule.shiftCenter')}</label> <select class="shift-center"></select> </div> <div class="shift-field other-field" style="display:none"> <label>${t('schedule.otherDescLabel')}</label> <input type="text" class="shift-other-desc" maxlength="60" placeholder="${t('schedule.otherDescPlaceholder')}" value="${escapeHtml(shiftData?.otherDesc || '')}"> </div> <button type="button" class="remove-shift-btn" onclick="removeShiftRow(this)" title="Remove shift"> <i class="fas fa-times"></i> </button>`;
  container.appendChild(shiftDiv);
  const centerSelect = shiftDiv.querySelector('.shift-center');
  populateCenterDropdown(centerSelect, shiftData?.center || '');
  // 🆕 toggle hidden desc field
  centerSelect.addEventListener('change', () => toggleOtherDescField(centerSelect));
  toggleOtherDescField(centerSelect);
}

window.toggleShiftType = function (selectEl) {
  const shiftDiv = selectEl.closest('.shift-item');
  const centerField = shiftDiv.querySelector('.center-field');
  const otherField = shiftDiv.querySelector('.other-field');
  if (selectEl.value === 'break') {
    shiftDiv.classList.add('break-shift');
    centerField.style.display = 'none';
    if (otherField) otherField.style.display = 'none';
  } else {
    shiftDiv.classList.remove('break-shift');
    centerField.style.display = '';
    const centerSelect = shiftDiv.querySelector('.shift-center');
    if (centerSelect) toggleOtherDescField(centerSelect);
  }
};

window.removeShiftRow = function (btn) {
  const shiftDiv = btn.closest('.shift-item');
  shiftDiv.remove();
};

function openEditModal(empId, dateStr) {
  if (!isAdminOrManager) {
    alert(t('schedule.noPermissionEdit'));
    return;
  }
  editingEmpId = empId;
  editingDate = dateStr;
  const emp = employees[empId];
  const dateObj = parseDate(dateStr);
  const dow = dateObj.getDay();
  document.getElementById('modalTitle').textContent = t('schedule.modalTitle');
  document.getElementById('modalDateInfo').innerHTML = `
      <strong>${emp?.englishName || 'Unknown'}</strong> — 
      ${DAY_NAMES[dow]}, ${dateObj.getDate()} ${MONTH_NAMES[dateObj.getMonth()]} ${dateObj.getFullYear()}
  `;
  document.getElementById('shiftsContainer').innerHTML = '';
  shiftCounter = 0;
  const sched = mergedSchedules[empId]?.[dateStr];
  editingSourceCenter = sched?._sourceCenter || null;
  if (sched) {
    const shifts = sched._shifts || extractShifts(sched);
    if (shifts.length > 0) shifts.forEach(s => addShiftRow(s));
    else addShiftRow();
    document.getElementById('scheduleStatus').value = sched.status || 'scheduled';
    document.getElementById('scheduleNotes').value = sched.notes || '';
  } else {
    const tmpl = getTemplateForDate(empId, dateStr);
    if (tmpl) {
      const tmplShifts = tmpl._shifts || extractShifts(tmpl);
      if (tmplShifts.length > 0) tmplShifts.forEach(s => addShiftRow(s));
      else addShiftRow();
      document.getElementById('scheduleStatus').value = tmpl.status || 'scheduled';
      document.getElementById('scheduleNotes').value = tmpl.notes || '';
    } else {
      addShiftRow();
      document.getElementById('scheduleStatus').value = 'scheduled';
      document.getElementById('scheduleNotes').value = '';
    }
  }
  calendarViewDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
  selectedPatternDates = new Set();
  const patternCb = document.getElementById('saveAsPatternCb');
  if (patternCb) patternCb.checked = false;
  renderPatternCalendar();
  checkModalWarnings(empId, dateStr);
  document.getElementById('scheduleModal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('scheduleModal').classList.add('hidden');
    editingEmpId = null;
    editingDate = null;
    editingSourceCenter = null;
    renderAdminMobileView(); // 🆕 Refreshes mobile calendar if active
}

function checkModalWarnings(empId, dateStr) {
  const warningsDiv = document.getElementById('modalWarnings');
  if (!warningsDiv) return;
  warningsDiv.innerHTML = '';
  const dateObj = parseDate(dateStr);
  const dow = dateObj.getDay();
  const holidayInfo = getHolidayForDate(dateStr);
  if (holidayInfo && !holidayInfo.muc) {
    const type = holidayInfo.type === 'public' ? t('schedule.publicHoliday') : t('schedule.centerHoliday');
    warningsDiv.innerHTML += `<div class="warning-box">${t('schedule.warnHoliday', { type, name: holidayInfo.name || '' })}</div>`;
  }
  const shiftItems = document.querySelectorAll('#shiftsContainer .shift-item');
  shiftItems.forEach(item => {
    const centerSelect = item.querySelector('.shift-center');
    if (centerSelect && centerSelect.value) {
      if (isCenterClosedOnDay(centerSelect.value, dow)) {
        const centerName = allCenters.find(c => c.id === centerSelect.value)?.name || centerSelect.value;
        warningsDiv.innerHTML += `<div class="error-box">${t('schedule.errClosedOn', { centerName, day: DAY_NAMES[dow] })}</div>`;
      }
    }
  });
}

document.addEventListener('change', (e) => {
  if (e.target.classList.contains('shift-center') && editingEmpId && editingDate) {
    checkModalWarnings(editingEmpId, editingDate);
  }
});

function updateModalLoadingState(loading) {
  const saveBtn = document.getElementById('saveScheduleBtn');
  const clearBtn = document.getElementById('clearDayBtn');
  const cancelBtn = document.getElementById('cancelModalBtn');
  const modalFooter = document.querySelector('.modal-footer-right');
  if (loading) {
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = `<span class="spinner-small"></span> ${t('schedule.saving')}`; }
    if (clearBtn) clearBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (modalFooter) modalFooter.style.opacity = '0.7';
  } else {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = t('schedule.save'); }
    if (clearBtn) clearBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (modalFooter) modalFooter.style.opacity = '1';
  }
}

async function saveSchedule() {
  if (isSaving || !editingEmpId || !editingDate) return;
  isSaving = true;
  updateModalLoadingState(true);
  try {
    const status = document.getElementById('scheduleStatus').value;
    const notes = document.getElementById('scheduleNotes').value.trim();
    const shiftItems = document.querySelectorAll('#shiftsContainer .shift-item');
    const shifts = [];
    shiftItems.forEach(item => {
      const type = item.querySelector('.shift-type').value;
      const start = item.querySelector('.shift-start').value;
      const end = item.querySelector('.shift-end').value;
      const center = type === 'work' ? item.querySelector('.shift-center').value : null;
      const otherDesc = center === 'other'
        ? (item.querySelector('.shift-other-desc')?.value || '').trim()
        : '';
      if (start && end) shifts.push({ type, start, end, center, otherDesc });
    });

    const data = { status, shifts, notes, updatedAt: new Date().toISOString(), updatedBy: currentUser.uid };
    const errors = validateSchedule(data, editingDate);
    if (errors.length > 0) {
      document.getElementById('modalWarnings').innerHTML = errors.map(e => `<div class="error-box">❌ ${e}</div>`).join('');
      isSaving = false;
      updateModalLoadingState(false);
      return;
    }
    let localRecord = null;
    const localCopies = [];
    if (shifts.length === 0 && status === 'scheduled') {
      data.cleared = true;
      for (const center of allCenters) {
        await set(ref(db, `schedules/${center.id}/${editingEmpId}/${editingDate}`), data);
      }
      localRecord = { ...data, _sourceCenter: allCenters[0]?.id || null };
      } else {
      let targetCenter = null;
      const workShifts = shifts.filter(s => s.type === 'work' && s.center && s.center !== 'other');
      
      if (workShifts.length > 0) targetCenter = workShifts[0].center;
      if (!targetCenter) targetCenter = editingSourceCenter;
      if (!targetCenter) {
        if (allCenters.length > 0) targetCenter = allCenters[0].id;
        else {
          alert(t('schedule.noCentersSave'));
          isSaving = false;
          updateModalLoadingState(false);
          return;
        }
      }
      const skipCenters = [targetCenter];
      if (editingSourceCenter && editingSourceCenter !== targetCenter) skipCenters.push(editingSourceCenter);
      const overlapError = await checkOverlaps(editingEmpId, editingDate, data, skipCenters);
      if (overlapError) {
        document.getElementById('modalWarnings').innerHTML = `<div class="error-box">❌ ${overlapError}</div>`;
        isSaving = false;
        updateModalLoadingState(false);
        return;
      }
      const existingSched = mergedSchedules[editingEmpId]?.[editingDate];
      const sourceCenters = new Set();
      if (existingSched) {
        (existingSched._sourceCenters || []).forEach(c => sourceCenters.add(c));
        if (existingSched._sourceCenter) sourceCenters.add(existingSched._sourceCenter);
      }
      for (const c of sourceCenters) {
        if (c !== targetCenter) await remove(ref(db, `schedules/${c}/${editingEmpId}/${editingDate}`));
      }
      await set(ref(db, `schedules/${targetCenter}/${editingEmpId}/${editingDate}`), data);
      localRecord = { ...data, _sourceCenter: targetCenter };
    }
      const checkedDates = Array.from(selectedPatternDates).filter(d => d !== editingDate);
      if (checkedDates.length > 0) {
        const hasContent = shifts.length > 0 || status !== 'scheduled';
        let copyCenter = null;
        
        // ✅ ADD: && s.center !== 'other'
        const copyWorkShifts = shifts.filter(s => s.type === 'work' && s.center && s.center !== 'other');
        
        if (copyWorkShifts.length > 0) copyCenter = copyWorkShifts[0].center;
        if (!copyCenter) copyCenter = editingSourceCenter || (allCenters.length > 0 ? allCenters[0].id : null);
        
        for (const dateStr of checkedDates) {
        if (hasContent && copyCenter) {
          const copyData = { status, shifts, notes, isFromPattern: true, updatedAt: new Date().toISOString(), updatedBy: currentUser.uid };
          await set(ref(db, `schedules/${copyCenter}/${editingEmpId}/${dateStr}`), copyData);
          localCopies.push({ dateStr, record: { ...copyData, _sourceCenter: copyCenter } });
        } else {
          const emptyCopy = { status: 'scheduled', shifts: [], notes: '', cleared: true, updatedAt: new Date().toISOString(), updatedBy: currentUser.uid };
          for (const center of allCenters) {
            await set(ref(db, `schedules/${center.id}/${editingEmpId}/${dateStr}`), emptyCopy);
          }
          localCopies.push({ dateStr, record: { ...emptyCopy, _sourceCenter: allCenters[0]?.id || null } });
        }
      }
    }
    let savedPattern = null;
    if (document.getElementById('saveAsPatternCb')?.checked === true) {
      const dow = parseDate(editingDate).getDay();
      const hasContent = shifts.length > 0 || status !== 'scheduled';
      if (hasContent) {
        const patternData = { status, shifts, notes };
        await set(ref(db, `scheduleTemplates/${editingEmpId}/${dow}`), patternData);
        savedPattern = { dow, data: patternData };
      } else {
        await remove(ref(db, `scheduleTemplates/${editingEmpId}/${dow}`));
        savedPattern = { dow, delete: true };
      }
    }
    try { await loadAllSchedules(); } catch (e) { console.warn('Reload schedules failed, using local data:', e); }
    try { await loadAllTemplates(); } catch (e) { console.warn('Reload templates failed, using local data:', e); }
    if (!mergedSchedules[editingEmpId]) mergedSchedules[editingEmpId] = {};
    mergedSchedules[editingEmpId][editingDate] = localRecord;
    localCopies.forEach(({ dateStr, record }) => { mergedSchedules[editingEmpId][dateStr] = record; });
    if (savedPattern) {
      if (!templates[editingEmpId]) templates[editingEmpId] = {};
      if (savedPattern.delete) delete templates[editingEmpId][savedPattern.dow];
      else templates[editingEmpId][savedPattern.dow] = savedPattern.data;
    }
    closeModal();
    renderAdminView();
    renderEmployeeView();
    renderCenterView();
    renderSubjectView();
  } catch (err) {
    console.error('Save error:', err);
    alert(t('schedule.failedSave'));
  } finally {
    isSaving = false;
    updateModalLoadingState(false);
  }
}

async function clearDay() {
  if (isSaving || !editingEmpId || !editingDate) return;
  if (!confirm(t('schedule.confirmClearDay'))) return;
  isSaving = true;
  updateModalLoadingState(true);
  try {
    const datesToClear = [editingDate, ...Array.from(selectedPatternDates)]
      .filter((d, i, arr) => arr.indexOf(d) === i)
      .filter(d => d === editingDate || !isPastDate(d));
    for (const dateStr of datesToClear) {
      const emptyData = { status: 'scheduled', shifts: [], notes: '', cleared: true, updatedAt: new Date().toISOString(), updatedBy: currentUser.uid };
      for (const center of allCenters) {
        await set(ref(db, `schedules/${center.id}/${editingEmpId}/${dateStr}`), emptyData);
      }
    }
    await loadAllSchedules();
    await loadAllTemplates();
    closeModal();
    renderAdminView();
    renderEmployeeView();
    renderCenterView();
    renderSubjectView();
  } catch (err) {
    console.error('Clear error:', err);
    alert(t('schedule.failedClear'));
  } finally {
    isSaving = false;
    updateModalLoadingState(false);
  }
}

// ============================================
// VALIDATION
// ============================================
function validateSchedule(data, dateStr) {
  const errors = [];
  if (data.status !== 'scheduled') return errors;
  const dateObj = parseDate(dateStr);
  const dow = dateObj.getDay();
  data.shifts.forEach((shift, idx) => {
    const start = timeToMin(shift.start);
    const end = timeToMin(shift.end);
    if (start !== null && end !== null && start >= end) {
      errors.push(t('schedule.errShiftOrder', { n: idx + 1 }));
    }
    if (shift.type === 'work' && shift.center) {
      if (isCenterClosedOnDay(shift.center, dow)) {
        const centerName = allCenters.find(c => c.id === shift.center)?.name || shift.center;
        errors.push(t('schedule.errShiftClosed', { n: idx + 1, centerName, day: DAY_NAMES[dow] }));
      }
    }
  });
  const workShifts = data.shifts.filter(s => s.type === 'work');
  for (let i = 0; i < workShifts.length; i++) {
    for (let j = i + 1; j < workShifts.length; j++) {
      const s1Start = timeToMin(workShifts[i].start);
      const s1End = timeToMin(workShifts[i].end);
      const s2Start = timeToMin(workShifts[j].start);
      const s2End = timeToMin(workShifts[j].end);
      if (s1Start !== null && s1End !== null && s2Start !== null && s2End !== null) {
        if (s1Start < s2End && s1End > s2Start) {
          errors.push(t('schedule.errShiftOverlap', { a: i + 1, b: j + 1 }));
        }
      }
    }
  }
  return errors;
}

async function checkOverlaps(empId, dateStr, newData, skipCenters = []) {
  if (newData.status !== 'scheduled') return null;
  const newShifts = newData.shifts
    .filter(s => s.type === 'work')
    .map(s => ({ start: timeToMin(s.start), end: timeToMin(s.end) }))
    .filter(s => s.start !== null && s.end !== null);
  if (newShifts.length === 0) return null;
  for (const center of allCenters) {
    if (skipCenters.includes(center.id)) continue;
    const schedSnap = await get(ref(db, `schedules/${center.id}/${empId}/${dateStr}`));
    if (!schedSnap.exists()) continue;
    const existingData = schedSnap.val();
    if (existingData.status !== 'scheduled') continue;
    const existingShifts = extractShifts({ ...existingData, _sourceCenter: center.id })
      .filter(s => s.type === 'work')
      .map(s => ({ start: timeToMin(s.start), end: timeToMin(s.end) }))
      .filter(s => s.start !== null && s.end !== null);
    for (const ns of newShifts) {
      for (const es of existingShifts) {
        if (ns.start < es.end && ns.end > es.start) {
          return t('schedule.errTimeOverlap', {
            center: center.name,
            new: `${formatMin(ns.start)}-${formatMin(ns.end)}`,
            existing: `${formatMin(es.start)}-${formatMin(es.end)}`
          });
        }
      }
    }
  }
  return null;
}

// ============================================
// APPLY PATTERNS TO MONTH
// ============================================
async function applyPatternsToMonth() {
  if (!isAdminOrManager) return;
  const btn = document.getElementById('applyPatternBtn');
  const originalText = t('schedule.applyPatterns');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner-small"></span> ${t('schedule.applying')}`; }
  const midDate = addDays(viewStartDate, 10);
  const year = midDate.getFullYear();
  const month = midDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = `${MONTH_NAMES[month]} ${year}`;
  if (!confirm(t('schedule.confirmApplyPatterns', { month: monthName }))) {
    if (btn) { btn.disabled = false; btn.innerHTML = originalText; }
    return;
  }
  let count = 0;
  let skipped = 0;
  try {
    for (const [empId, empTemplates] of Object.entries(templates)) {
      for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dateObj = new Date(year, month, day);
        if (isPastDate(dateStr)) continue;
        const dow = dateObj.getDay();
        const existingSched = mergedSchedules[empId]?.[dateStr];
        if (existingSched) {
          if (existingSched.cleared) { skipped++; continue; }
          const existingShifts = existingSched._shifts || extractShifts(existingSched);
          const hasValidExistingShifts = hasValidShifts(existingShifts);
          const hasSpecialStatus = existingSched.status && existingSched.status !== 'scheduled';
          if (hasValidExistingShifts || hasSpecialStatus) { skipped++; continue; }
        }
        if (!empTemplates[dow]) continue;
        const tmpl = empTemplates[dow];
        const schedData = { status: tmpl.status || 'scheduled', shifts: tmpl.shifts || [], notes: tmpl.notes || '', isFromPattern: true, updatedAt: new Date().toISOString(), updatedBy: currentUser.uid };
        let targetCenter = null;
        const workShifts = schedData.shifts.filter(s => s.type === 'work' && s.center);
        if (workShifts.length > 0) targetCenter = workShifts[0].center;
        if (!targetCenter && allCenters.length > 0) targetCenter = allCenters[0].id;
        if (targetCenter) {
          await set(ref(db, `schedules/${targetCenter}/${empId}/${dateStr}`), schedData);
          count++;
        }
      }
    }
    await loadAllSchedules();
    alert(t('schedule.appliedPatterns', { count, skipped }));
    renderAdminView();
    renderEmployeeView();
    renderCenterView();
    renderSubjectView();
  } catch (err) {
    console.error('Apply pattern error:', err);
    alert(t('schedule.errorApplying'));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalText; }
  }
}

// ============================================
// PER CENTER VIEW
// ============================================
function setupCenterNav() {
  const dropdown = document.getElementById('centerDropdown');
  if (!dropdown) return;
  dropdown.innerHTML = '';
  allCenters.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    dropdown.appendChild(opt);
  });
  if (dropdown.options.length > 0) selectedCenterForView = dropdown.value;
  dropdown.addEventListener('change', () => {
    selectedCenterForView = dropdown.value;
    renderCenterView();
  });
  document.getElementById('centerPrevBtn')?.addEventListener('click', () => { centerViewDate = addDays(centerViewDate, -14); renderCenterView(); });
  document.getElementById('centerNextBtn')?.addEventListener('click', () => { centerViewDate = addDays(centerViewDate, 14); renderCenterView(); });
  document.getElementById('centerTodayBtn')?.addEventListener('click', () => { centerViewDate = getMonday(new Date()); renderCenterView(); });
  document.getElementById('printCenterBtn')?.addEventListener('click', printCenterSchedule);
  document.getElementById('exportJpegBtn')?.addEventListener('click', exportCenterAsJpeg);
  document.getElementById('centerGroupBySubject')?.addEventListener('change', (e) => { centerGroupBySubject = e.target.checked; renderCenterView(); });
}

function get14Days(start) {
  const dates = [];
  for (let i = 0; i < 14; i++) dates.push(formatDateStr(addDays(start, i)));
  return dates;
}

function renderCenterView() {
  if (!selectedCenterForView) return;
  const dates = get14Days(centerViewDate);
  updateWeekRange14('centerWeekRangeDisplay', dates);
  renderCenterHeader(dates);
  renderCenterBody(dates);
}

function updateWeekRange14(elementId, dates) {
  const first = parseDate(dates[0]);
  const last = parseDate(dates[dates.length - 1]);
  const str = `${first.getDate()} ${MONTH_NAMES[first.getMonth()].substring(0, 3)} — ${last.getDate()} ${MONTH_NAMES[last.getMonth()].substring(0, 3)} ${last.getFullYear()}`;
  const el = document.getElementById(elementId);
  if (el) el.textContent = str;
}

function renderCenterHeader(dates) {
  const row = document.getElementById('centerHeaderRow');
  if (!row) return;
  row.innerHTML = `<th class="employee-header">${t('schedule.printEmployee')}</th>`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const centerCalEvents = calendarEvents[selectedCenterForView] || {};
  const centerObj = allCenters.find(c => c.id === selectedCenterForView);
  const closedDays = getClosedDaysForCenter(centerObj?.name || '');
  dates.forEach((d, idx) => {
    const dateObj = parseDate(d);
    const dow = dateObj.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = dateObj.getTime() === today.getTime();
    const event = centerCalEvents[d];
    const isHoliday = event && !event.muc;
    const isClosed = closedDays.includes(dow) && !event;
    const isWeek2Start = idx === 7;
    let cls = 'day-header';
    if (isHoliday) cls += ' holiday-col';
    else if (isToday) cls += ' today-col';
    else if (isWeekend) cls += ' weekend';
    if (isWeek2Start) cls += ' week-separator';
    let title = `${DAY_SHORT[dow]} ${d}`;
    if (isHoliday) title += `— ${event.name || t('schedule.holiday')}`;
    if (isClosed) title += ` — ${t('schedule.closed')}`;
    row.innerHTML += `<th class="${cls}" title="${title}">${DAY_SHORT[dow]}<br>${dateObj.getDate()}</th>`;
  });
}

function isMainKumonCenter(centerId) {
  const center = allCenters.find(c => c.id === centerId);
  const name = (center?.name || centerId || '').toLowerCase();
  return name.includes('mei keng') || name.includes('tap siac') || name.includes('pac tat') || name.includes('champs');
}

function groupEmployeesBySubject(empList, centerId = selectedCenterForView) {
  const subjectGroups = {};
  const subjectOrder = ['English Teacher', 'Math Teacher', 'Chinese Teacher'];
  const adminRoles = ['Admin'];
  const otherTeachers = [];
  const addedEmpIds = new Set();
  const hideTutorialTeachers = isMainKumonCenter(centerId);
  empList.forEach(emp => {
    const positions = getEmpPositions(emp).map(p => (p || '').trim()).filter(Boolean);
    const hasMainSubject = subjectOrder.some(subj => positions.includes(subj));
    const hasAdminRole = positions.some(p => adminRoles.includes(p));
    const hasTutorialTeacher = positions.includes('Tutorial Teacher');
    if (hideTutorialTeachers && hasTutorialTeacher && !hasMainSubject && !hasAdminRole) {
      addedEmpIds.add(emp.uid);
      return;
    }
    let matchedSubject = false;
    for (const subj of subjectOrder) {
      if (positions.includes(subj)) {
        if (!subjectGroups[subj]) subjectGroups[subj] = [];
        subjectGroups[subj].push(emp);
        addedEmpIds.add(emp.uid);
        matchedSubject = true;
      }
    }
    if (hasAdminRole) {
      if (!subjectGroups['Admins']) subjectGroups['Admins'] = [];
      subjectGroups['Admins'].push(emp);
      addedEmpIds.add(emp.uid);
      matchedSubject = true;
    }
    if (!matchedSubject && !addedEmpIds.has(emp.uid)) {
      const shouldHideTutorial = hideTutorialTeachers && hasTutorialTeacher && !hasMainSubject && !hasAdminRole;
      if (!shouldHideTutorial) { otherTeachers.push(emp); addedEmpIds.add(emp.uid); }
    }
  });
  const groupsToShow = [];
  subjectOrder.forEach(subj => {
    if (subjectGroups[subj] && subjectGroups[subj].length > 0) groupsToShow.push({ subject: subj, teachers: subjectGroups[subj] });
  });
  if (subjectGroups['Admins'] && subjectGroups['Admins'].length > 0) groupsToShow.push({ subject: 'Admins', teachers: subjectGroups['Admins'] });
  if (otherTeachers.length > 0) groupsToShow.push({ subject: 'Other', teachers: otherTeachers });
  return groupsToShow;
}

function renderCenterEmployeeRow(emp, dates, tbody, dailyCounts, centerCalEvents, closedDays, today, countedEmpIdsByDate) {
  const tr = document.createElement('tr');
  const termsClass = emp.terms === 'Full-time' ? 'terms-full' : 'terms-part';
  const termsLabel = emp.terms === 'Full-time' ? 'FT' : 'PT';
  tr.innerHTML = `<td class="employee-name-cell"> ${emp.englishName || 'Unknown'} <span class="emp-terms ${termsClass}">${termsLabel}</span> <span class="emp-role">${getEmpPositions(emp).join(', ') || ''}</span> </td>`;
  dates.forEach((dateStr, idx) => {
    const td = document.createElement('td');
    td.className = 'schedule-cell';
    if (idx === 7) td.classList.add('week-separator');
    const dateObj = parseDate(dateStr);
    const dow = dateObj.getDay();
    const event = centerCalEvents[dateStr];
    const isHoliday = event && !event.muc;
    const isClosed = closedDays.includes(dow) && !event;
    const isToday = dateObj.getTime() === today.getTime();
    if (isToday) td.style.outline = '2px solid #27ae60';
    const sched = mergedSchedules[emp.uid]?.[dateStr];
    const tmpl = getTemplateForDate(emp.uid, dateStr);
    let shifts = [];
    let status = 'scheduled';
    let notes = '';
    let isTemplate = false;
    if (sched) {
      shifts = sched._shifts || extractShifts(sched);
      status = sched.status || 'scheduled';
      notes = sched.notes || '';
    } else if (tmpl) {
      shifts = tmpl._shifts || extractShifts(tmpl);
      status = tmpl.status || 'scheduled';
      notes = tmpl.notes || '';
      isTemplate = true;
    }
    let hasShiftToday = false;
    if (hasValidShifts(shifts) || status !== 'scheduled') {
      const centerShifts = shifts.filter(s => s.center === selectedCenterForView);
      if (status !== 'scheduled') {
        renderStatusCell(td, status, notes);
        if (isTemplate) td.style.opacity = '0.5';
      } else if (centerShifts.length > 0 && hasValidShifts(centerShifts)) {
        hasShiftToday = true;
        renderCenterShiftCell(td, centerShifts, isHoliday, event);
        if (isTemplate) td.style.opacity = '0.5';
      } else if (isClosed) {
        td.classList.add('is-closed');
        td.innerHTML = `<div class="cell-content"><span class="status-label">${t('schedule.closed')}</span></div>`;
      } else if (isHoliday) {
        td.classList.add('is-holiday');
        td.innerHTML = `<div class="cell-content"><span class="status-label">${event.name || t('schedule.holiday')}</span></div>`;
      } else {
        td.classList.add('empty-cell');
        td.innerHTML = `<div class="cell-content">—</div>`;
      }
    } else {
      if (isClosed) {
        td.classList.add('is-closed');
        td.innerHTML = `<div class="cell-content"><span class="status-label">${t('schedule.closed')}</span></div>`;
      } else if (isHoliday) {
        td.classList.add('is-holiday');
        td.innerHTML = `<div class="cell-content"><span class="status-label">🎌 ${event.name || t('schedule.holiday')}</span></div>`;
      } else {
        td.classList.add('empty-cell');
        td.innerHTML = `<div class="cell-content">—</div>`;
      }
    }
    if (hasShiftToday) {
      if (!countedEmpIdsByDate[dateStr]) countedEmpIdsByDate[dateStr] = new Set();
      if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
        countedEmpIdsByDate[dateStr].add(emp.uid);
        dailyCounts[dateStr]++;
      }
    }
    td.addEventListener('click', () => openEditModal(emp.uid, dateStr));
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}

function getCenterPrintRowHtml(emp, dates, selectedCenterId, centerCalEvents, closedDays, today, dailyCounts, countedEmpIdsByDate) {
  let html = '';
  const termsCls = emp.terms === 'Full-time' ? 'ft' : 'pt';
  const termsLbl = emp.terms === 'Full-time' ? 'FT' : 'PT';
  html += `<tr> <td class="employee-col"> ${emp.englishName || 'Unknown'} <span class="terms-tag ${termsCls}">${termsLbl}</span> <span class="role-tag">${getEmpPositions(emp).join(', ') || ''}</span> </td>`;
  dates.forEach((dateStr, idx) => {
    const dateObj = parseDate(dateStr);
    const dow = dateObj.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = dateObj.getTime() === today.getTime();
    const event = centerCalEvents[dateStr];
    const isHoliday = event && !event.muc;
    const isClosed = closedDays.includes(dow) && !event;
    const isWeek2 = idx === 7;
    let cellCls = '';
    if (isWeek2) cellCls += ' week-sep';
    if (isToday) cellCls += ' today-cell';
    else if (isWeekend) cellCls += ' weekend-cell';
    const sched = mergedSchedules[emp.uid]?.[dateStr];
    const tmpl = getTemplateForDate(emp.uid, dateStr);
    let shifts = [];
    let status = 'scheduled';
    let notes = '';
    let isTemplate = false;
    if (sched) {
      shifts = sched._shifts || extractShifts(sched);
      status = sched.status || 'scheduled';
      notes = sched.notes || '';
    } else if (tmpl) {
      shifts = tmpl._shifts || extractShifts(tmpl);
      status = tmpl.status || 'scheduled';
      notes = tmpl.notes || '';
      isTemplate = true;
    }
    let cellContent = '';
    if (hasValidShifts(shifts) || status !== 'scheduled') {
      const centerShifts = shifts.filter(s => s.center === selectedCenterId);
      if (status !== 'scheduled') {
        const statusLabels = {
          'other-center': t('schedule.otherCenter'),
          'leave': t('schedule.leave'),
          'sick': t('schedule.sick'),
          'off': t('schedule.off')
        };
        const statusCls = status === 'leave' ? 'leave' : status === 'sick' ? 'sick' : status === 'off' ? 'off' : 'other';
        cellContent = `<span class="print-status ${statusCls}">${statusLabels[status] || status}</span>`;
      } else if (centerShifts.length > 0 && hasValidShifts(centerShifts)) {
        if (!countedEmpIdsByDate[dateStr]) countedEmpIdsByDate[dateStr] = new Set();
        if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
          countedEmpIdsByDate[dateStr].add(emp.uid);
          dailyCounts[dateStr]++;
        }
        const sortedShifts = [...centerShifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
        sortedShifts.forEach(s => {
          if (s.type === 'break') cellContent += `<div class="print-shift break-shift">☕ ${s.start}-${s.end}</div>`;
          else cellContent += `<div class="print-shift"><span class="time">${s.start}-${s.end}</span></div>`;
        });
        if (isTemplate) cellContent += `<div style="font-size:5pt;color:#888;font-style:italic;">${t('schedule.printPattern')}</div>`;
      } else if (isClosed) {
        cellContent = `<span style="color:#999;font-size:6pt;">${t('schedule.closed')}</span>`;
      } else if (isHoliday) {
        cellContent = `<span style="color:#e74c3c;font-size:6pt;">🎌 ${event.name || ''}</span>`;
      } else {
        cellCls += ' empty-cell';
        cellContent = '—';
      }
    } else {
      if (isClosed) cellContent = `<span style="color:#999;font-size:6pt;">${t('schedule.closed')}</span>`;
      else if (isHoliday) cellContent = `<span style="color:#e74c3c;font-size:6pt;">🎌 ${event.name || ''}</span>`;
      else { cellCls += ' empty-cell'; cellContent = '—'; }
    }
    html += `<td class="${cellCls}">${cellContent}</td>`;
  });
  html += '</tr>';
  return html;
}

function renderCenterBody(dates) {
  const tbody = document.getElementById('centerBody');
  const emptyState = document.getElementById('centerEmptyState');
  const tableWrapper = document.getElementById('centerTableWrapper');
  if (!tbody) return;
  const sorted = getSortedEmployees();
  const employeesWithShifts = [];
  sorted.forEach(emp => {
    let hasShiftHere = false;
    for (const dateStr of dates) {
      const dateObj = parseDate(dateStr);
      const dow = dateObj.getDay();
      const sched = mergedSchedules[emp.uid]?.[dateStr];
      const tmpl = getTemplateForDate(emp.uid, dateStr);
      let currentShifts = [];
      let currentStatus = 'scheduled';
      let sourceCenter = null;
      if (sched) {
        currentShifts = sched._shifts || extractShifts(sched);
        currentStatus = sched.status || 'scheduled';
        sourceCenter = sched._sourceCenter;
      } else if (tmpl) {
        currentShifts = tmpl._shifts || extractShifts(tmpl);
        currentStatus = tmpl.status || 'scheduled';
      }
      const hasCenterShift = currentShifts.some(s => s.center === selectedCenterForView && hasValidShifts([s]));
      const isStatusHere = currentStatus !== 'scheduled' && sourceCenter === selectedCenterForView;
      if (hasCenterShift || isStatusHere) { hasShiftHere = true; break; }
    }
    if (hasShiftHere) employeesWithShifts.push(emp);
  });
  if (employeesWithShifts.length === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('hidden');
    if (tableWrapper) tableWrapper.style.display = 'none';
    return;
  }
  emptyState.classList.add('hidden');
  if (tableWrapper) tableWrapper.style.display = '';
  tbody.innerHTML = '';
  const centerCalEvents = calendarEvents[selectedCenterForView] || {};
  const centerObj = allCenters.find(c => c.id === selectedCenterForView);
  const closedDays = getClosedDaysForCenter(centerObj?.name || '');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dailyCounts = {};
  dates.forEach(d => dailyCounts[d] = 0);
  const countedEmpIdsByDate = {};
  dates.forEach(d => countedEmpIdsByDate[d] = new Set());
  if (centerGroupBySubject) {
    const groups = groupEmployeesBySubject(employeesWithShifts, selectedCenterForView);
    groups.forEach(group => {
      const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, icon: '👤', cls: 'other-divider', color: '#8e44ad' };
      const divRow = document.createElement('tr');
      divRow.className = `subject-divider ${config.cls}`;
      const countLabel = group.teachers.length !== 1 ? t('schedule.teacherPlural') : t('schedule.teacherSingular');
      divRow.innerHTML = `<td colspan="${dates.length + 1}">
          <span class="subject-icon">${config.icon}</span> ${trLabel(config.label)}
          <span class="subject-count">${group.teachers.length} ${countLabel}</span>
      </td>`;
      tbody.appendChild(divRow);
      group.teachers.forEach(emp => {
        renderCenterEmployeeRow(emp, dates, tbody, dailyCounts, centerCalEvents, closedDays, today, countedEmpIdsByDate);
      });
    });
  } else {
    let lastTerms = null;
    employeesWithShifts.forEach(emp => {
      if (lastTerms !== null && emp.terms !== lastTerms) {
        const divRow = document.createElement('tr');
        divRow.className = 'section-divider';
        divRow.innerHTML = `<td colspan="${dates.length + 1}">${t('schedule.partTimeDivider')}</td>`;
        tbody.appendChild(divRow);
      }
      lastTerms = emp.terms;
      renderCenterEmployeeRow(emp, dates, tbody, dailyCounts, centerCalEvents, closedDays, today, countedEmpIdsByDate);
    });
  }
  const summaryRow = document.createElement('tr');
  summaryRow.className = 'section-divider summary-row';
  summaryRow.innerHTML = `<td style="font-weight:700;">${t('schedule.staffCount')}</td>`;
  dates.forEach((d, idx) => {
    const cls = idx === 7 ? 'week-separator' : '';
    summaryRow.innerHTML += `<td class="${cls}" style="text-align:center;">${dailyCounts[d]}</td>`;
  });
  tbody.appendChild(summaryRow);
}

function renderStatusCell(td, status, notes) {
  const statusMap = {
    'other-center': { cls: 'status-other', label: t('schedule.otherCenter') },
    'leave': { cls: 'status-leave', label: t('schedule.leave') },
    'sick': { cls: 'status-sick', label: t('schedule.sick') },
    'off': { cls: 'status-off', label: t('schedule.off') }
  };
  const s = statusMap[status] || { cls: '', label: status };
  td.classList.add(s.cls);
  let html = `<div class="cell-content"><span class="status-label">${s.label}</span>`;
  if (notes) html += `<div class="notes-indicator"></div>`;
  html += '</div>';
  td.innerHTML = html;
}

function renderCenterShiftCell(td, shifts, isHoliday, event) {
  if (!hasValidShifts(shifts)) {
    td.classList.add('empty-cell');
    td.innerHTML = '<div class="cell-content">—</div>';
    return;
  }
  td.classList.add('has-schedule');
  if (isHoliday) td.classList.add('has-warning');
  let html = '<div class="cell-content">';
  const sorted = [...shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  sorted.forEach(shift => {
    if (shift.type === 'break') html += `<div class="shift-line break-line">☕ ${shift.start}-${shift.end}</div>`;
    else html += `<div class="shift-line"><span class="shift-time">${shift.start}-${shift.end}</span></div>`;
  });
  if (isHoliday && event && !event.muc) html += `<div class="holiday-indicator">🎌 ${event.name || t('schedule.holiday')}</div>`;
  html += '</div>';
  td.innerHTML = html;
}

function generateCenterPrintHTML() {
  if (!selectedCenterForView) return '';
  const centerObj = allCenters.find(c => c.id === selectedCenterForView);
  const centerNamePrint = centerObj ? centerObj.name : 'Center';
  const dates = get14Days(centerViewDate);
  const firstDate = parseDate(dates[0]);
  const lastDate = parseDate(dates[dates.length - 1]);
  const dateRangeStr = `${firstDate.getDate()} ${MONTH_NAMES[firstDate.getMonth()]} — ${lastDate.getDate()} ${MONTH_NAMES[lastDate.getMonth()]} ${lastDate.getFullYear()}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const centerCalEvents = calendarEvents[selectedCenterForView] || {};
  const closedDays = getClosedDaysForCenter(centerNamePrint);
  const sorted = getSortedEmployees();
  const employeesWithShifts = [];
  sorted.forEach(emp => {
    let hasShift = false;
    for (const dateStr of dates) {
      const sched = mergedSchedules[emp.uid]?.[dateStr];
      const tmpl = getTemplateForDate(emp.uid, dateStr);
      let currentShifts = [];
      let currentStatus = 'scheduled';
      let sourceCenter = null;
      if (sched) {
        currentShifts = sched._shifts || extractShifts(sched);
        currentStatus = sched.status || 'scheduled';
        sourceCenter = sched._sourceCenter;
      } else if (tmpl) {
        currentShifts = tmpl._shifts || extractShifts(tmpl);
        currentStatus = tmpl.status || 'scheduled';
      }
      const hasCenterShift = currentShifts.some(s => s.center === selectedCenterForView && hasValidShifts([s]));
      const isStatusHere = currentStatus !== 'scheduled' && sourceCenter === selectedCenterForView;
      if (hasCenterShift || isStatusHere) { hasShift = true; break; }
    }
    if (hasShift) employeesWithShifts.push(emp);
  });
  let html = `<div class="print-header"> <h1>${t('schedule.printCenterSchedule', { center: centerNamePrint })}</h1> <p class="print-subtitle">${t('schedule.printSubtitle')}</p> <p class="print-date-range">${dateRangeStr}</p> </div> <div class="print-table-wrapper"> <table class="print-schedule-table"> <thead> <tr> <th class="employee-col">${t('schedule.printEmployee')}</th>`;
  dates.forEach((d, idx) => {
    const dateObj = parseDate(d);
    const dow = dateObj.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = dateObj.getTime() === today.getTime();
    const event = centerCalEvents[d];
    const isHoliday = event && !event.muc;
    const isWeek2 = idx === 7;
    let cls = '';
    if (isHoliday) cls = 'style="background:#e74c3c !important;"';
    else if (isToday) cls = 'class="today-col"';
    else if (isWeekend) cls = 'class="weekend-col"';
    const sep = isWeek2 ? ' week-sep' : '';
    html += `<th class="${sep}" ${cls}>${DAY_SHORT[dow]}<br>${dateObj.getDate()}</th>`;
  });
  html += `</tr></thead><tbody>`;
  const dailyCounts = {};
  dates.forEach(d => dailyCounts[d] = 0);
  const countedEmpIdsByDate = {};
  dates.forEach(d => countedEmpIdsByDate[d] = new Set());
  if (centerGroupBySubject) {
    const groups = groupEmployeesBySubject(employeesWithShifts, selectedCenterForView);
    groups.forEach(group => {
      const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, icon: '👤', color: '#8e44ad' };
      const dividerCls = getPrintDividerClass(group.subject);
      const dividerBg = config.color || '#8e44ad';
      html += `<tr class="print-subject-divider ${dividerCls}">
          <td colspan="${dates.length + 1}"
              style="background:${dividerBg} !important; color:#ffffff !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important;">
              ${config.icon} ${trLabel(config.label)} (${group.teachers.length})
          </td>
      </tr>`;
      group.teachers.forEach(emp => {
        html += getCenterPrintRowHtml(emp, dates, selectedCenterForView, centerCalEvents, closedDays, today, dailyCounts, countedEmpIdsByDate);
      });
    });
  } else {
    let lastTerms = null;
    employeesWithShifts.forEach(emp => {
      if (lastTerms !== null && emp.terms !== lastTerms) {
        html += `<tr class="section-row"><td colspan="${dates.length + 1}">${t('schedule.partTimeDivider')}</td></tr>`;
      }
      lastTerms = emp.terms;
      html += getCenterPrintRowHtml(emp, dates, selectedCenterForView, centerCalEvents, closedDays, today, dailyCounts, countedEmpIdsByDate);
    });
  }
  html += `<tr class="summary-row"><td>${t('schedule.staffCount')}</td>`;
  dates.forEach((d, idx) => {
    const sep = idx === 7 ? ' week-sep' : '';
    html += `<td class="${sep}">${dailyCounts[d]}</td>`;
  });
  html += '</tr></tbody></table></div>';
  html += `
  <div class="print-footer">
      ${t('schedule.printFooterCenter', { time: new Date().toLocaleString() })}
  </div>`;
  return html;
}

async function exportCenterAsJpeg() {
  if (!selectedCenterForView) { alert(t('schedule.selectCenterFirst')); return; }
  if (typeof html2canvas === 'undefined') { alert(t('schedule.exportLibNotLoaded')); return; }
  const btn = document.getElementById('exportJpegBtn');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-small"></span> ${t('schedule.generating')}`;
  try {
    const html = generateCenterPrintHTML();
    const printArea = document.getElementById('printArea');
    if (!printArea) throw new Error('Print area element not found');
    printArea.innerHTML = html;
    printArea.style.setProperty('display', 'block', 'important');
    printArea.style.setProperty('position', 'absolute', 'important');
    printArea.style.setProperty('left', '0', 'important');
    printArea.style.setProperty('top', '0', 'important');
    printArea.style.setProperty('width', '1400px', 'important');
    printArea.style.setProperty('background', '#ffffff', 'important');
    printArea.style.setProperty('z-index', '99999', 'important');
    printArea.style.setProperty('padding', '20px', 'important');
    printArea.style.setProperty('visibility', 'visible', 'important');
    printArea.style.setProperty('opacity', '1', 'important');
    const tempStyle = document.createElement('style');
    tempStyle.id = 'temp-export-styles';
    tempStyle.innerHTML = `
        #printArea * { visibility: visible !important; opacity: 1 !important; }
        #printArea .print-schedule-table, #printArea .print-subject-table { width: 100%; border-collapse: collapse; font-size: 10pt; font-family: Arial, sans-serif; }
        #printArea .print-schedule-table th, #printArea .print-subject-table th { background: #1a5276 !important; color: white !important; padding: 4px; text-align: center; font-size: 9pt; font-weight: 700; border: 1px solid #ccc; }
        #printArea .print-schedule-table th.employee-col { width: 15%; text-align: left; padding-left: 8px; background: #154360 !important; }
        #printArea .print-schedule-table td, #printArea .print-subject-table td { padding: 4px; border: 1px solid #ccc; vertical-align: top; text-align: left; height: 45px; font-size: 9pt; }
        #printArea .print-schedule-table td.employee-col { background: #f8f9fa !important; font-weight: 700; border-right: 2px solid #1a5276; }
        #printArea .print-shift { font-size: 10pt; line-height: 1.4; }
        #printArea .print-shift .time { font-size: 11pt; font-weight: 700; }
        #printArea .print-status { font-weight: 700; font-size: 9pt; }
        #printArea tr.print-subject-divider td { font-weight: 700; font-size: 10pt; color: #ffffff !important; padding: 6px; background: #8e44ad !important; }
        #printArea tr.print-subject-divider.english td { background: #e67e22 !important; }
        #printArea tr.print-subject-divider.math td { background: #1abc9c !important; }
        #printArea tr.print-subject-divider.chinese td { background: #7cb342 !important; }
        #printArea tr.print-subject-divider.tutorial td { background: #8e44ad !important; }
        #printArea tr.print-subject-divider.admin td { background: #2c3e50 !important; }
        #printArea tr.print-subject-divider.other td { background: #8e44ad !important; }
        #printArea tr.summary-row td { background: #eaf2f8 !important; font-weight: 700; text-align: center; }
        #printArea .print-header h1 { font-size: 18pt; color: #1a5276; margin: 0 0 5px 0; font-family: Arial, sans-serif; }
        #printArea .print-header .print-subtitle { font-size: 11pt; color: #555; margin: 0; }
        #printArea .print-header .print-date-range { font-size: 12pt; color: #333; font-weight: 700; margin: 5px 0 0 0; }
        #printArea .terms-tag.ft { background: #d4edda !important; color: #155724 !important; padding: 0 3px; border-radius: 2px; font-size: 7pt; }
        #printArea .terms-tag.pt { background: #fff3cd !important; color: #856404 !important; padding: 0 3px; border-radius: 2px; font-size: 7pt; }
        #printArea .role-tag { font-size: 8pt; color: #777; display: block; }
    `;
    document.head.appendChild(tempStyle);
    await new Promise(resolve => setTimeout(resolve, 300));
    const canvas = await html2canvas(printArea, {
      scale: 3, useCORS: true, allowTaint: true, backgroundColor: '#ffffff',
      width: 1400, windowWidth: 1400, windowHeight: printArea.scrollHeight
    });
    document.head.removeChild(tempStyle);
    printArea.innerHTML = '';
    ['display', 'position', 'left', 'top', 'width', 'background', 'z-index', 'padding', 'visibility', 'opacity']
      .forEach(p => printArea.style.removeProperty(p));
    if (canvas.width === 0 || canvas.height === 0) throw new Error('Canvas is empty - capture failed');
    canvas.toBlob((blob) => {
      if (!blob) { alert(t('schedule.failedGenerate')); return; }
      if (blob.size === 0) { alert(t('schedule.emptyImage')); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const centerName = allCenters.find(c => c.id === selectedCenterForView)?.name || 'Center';
      const timestamp = new Date().toISOString().slice(0, 10);
      link.download = `${centerName.replace(/\s+/g, '_')}_Schedule_${timestamp}.jpeg`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 'image/jpeg', 0.95);
  } catch (err) {
    console.error('Export error:', err);
    alert(t('schedule.failedExportJpeg', { message: err.message }));
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

function printCenterSchedule() {
  if (!selectedCenterForView) { alert(t('schedule.selectCenterFirst')); return; }
  const html = generateCenterPrintHTML();
  const printArea = document.getElementById('printArea');
  if (printArea) printArea.innerHTML = html;
  window.print();
  setTimeout(() => { if (printArea) printArea.innerHTML = ''; }, 1000);
}

// ============================================
// 📱 ADMIN MOBILE VIEW LOGIC
// ============================================
function renderAdminMobileView() {
    const listView = document.getElementById('adminMobileList');
    const detailView = document.getElementById('adminMobileDetail');
    if (!listView || !detailView) return;

    // ✅ Use the state variable (not class checks) to decide what's active
    if (adminMobileCurrentEmpId) {
        renderAdminMobileCalendar();
        return;
    }

    // ✅ Force correct visibility: list shown, detail hidden
    listView.classList.remove('hidden');
    listView.style.display = '';
    detailView.classList.add('hidden');
    detailView.style.display = 'none';

    listView.innerHTML = '';
    const sorted = getSortedEmployees();
    const searchInput = document.getElementById('adminSearchInput');
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

    const filtered = sorted.filter(emp => {
        if (!searchTerm) return true;
        const name = (emp.englishName || '').toLowerCase();
        const roles = getEmpPositions(emp).join(' ').toLowerCase();
        return name.includes(searchTerm) || roles.includes(searchTerm);
    });

    if (filtered.length === 0) {
        listView.innerHTML = `<div class="admin-mobile-empty">No employees found.</div>`;
        return;
    }

    filtered.forEach(emp => {
        const card = document.createElement('div');
        card.className = 'admin-mobile-emp-card';
        const termsClass = emp.terms === 'Full-time' ? 'terms-full' : 'terms-part';
        const termsLabel = emp.terms === 'Full-time' ? 'FT' : 'PT';
        card.innerHTML = `
            <div class="admin-mobile-card-main">
                <div class="admin-mobile-card-name">${emp.englishName || 'Unknown'}</div>
                <div class="admin-mobile-card-role">${getEmpPositions(emp).join(', ') || ''}</div>
            </div>
            <span class="emp-terms ${termsClass}">${termsLabel}</span>
        `;
        card.addEventListener('click', () => openAdminMobileDetail(emp.uid));
        listView.appendChild(card);
    });
}

function openAdminMobileDetail(empId) {
    adminMobileCurrentEmpId = empId;
    adminMobileCalDate = new Date();

    const listView = document.getElementById('adminMobileList');
    const detailView = document.getElementById('adminMobileDetail');
    const emp = employees[empId];
    if (!listView || !detailView || !emp) return;

    // ✅ Toggle BOTH class and inline style so neither can keep it hidden
    listView.classList.add('hidden');
    listView.style.display = 'none';
    detailView.classList.remove('hidden');   
    detailView.style.display = '';

    detailView.querySelector('.admin-mobile-emp-name').textContent = emp.englishName || 'Unknown';
    detailView.querySelector('.admin-mobile-emp-role').textContent = getEmpPositions(emp).join(', ');

    renderAdminMobileCalendar();
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function closeAdminMobileDetail() {
    adminMobileCurrentEmpId = null;
    const listView = document.getElementById('adminMobileList');
    const detailView = document.getElementById('adminMobileDetail');
    if (listView) {
        listView.classList.remove('hidden');
        listView.style.display = '';
    }
    if (detailView) {
        detailView.classList.add('hidden');
        detailView.style.display = 'none';
    }
}

function renderAdminMobileCalendar() {
    const grid = document.getElementById('adminMobileCalendarGrid');
    const monthLabel = document.getElementById('adminMobileCalMonth');
    if (!grid || !adminMobileCurrentEmpId) return;
    
    const year = adminMobileCalDate.getFullYear();
    const month = adminMobileCalDate.getMonth();
    monthLabel.textContent = `${MONTH_NAMES[month]} ${year}`;
    
    grid.innerHTML = '';
    
    // Day headers (Sun, Mon, etc.)
    DAY_SHORT.forEach(d => {
        const h = document.createElement('div');
        h.className = 'admin-mobile-cal-header';
        h.textContent = d;
        grid.appendChild(h);
    });
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Empty cells before 1st of month
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'admin-mobile-cal-cell empty';
        grid.appendChild(empty);
    }
    
    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
        const dateObj = new Date(year, month, day);
        const dateStr = formatDateStr(dateObj);
        const dow = dateObj.getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = dateObj.getTime() === today.getTime();
        
        const cell = document.createElement('div');
        cell.className = 'admin-mobile-cal-cell';
        if (isWeekend) cell.classList.add('weekend');
        if (isToday) cell.classList.add('today');
        
        const dayNum = document.createElement('div');
        dayNum.className = 'admin-mobile-cal-day-num';
        dayNum.textContent = day;
        cell.appendChild(dayNum);
        
        const sched = mergedSchedules[adminMobileCurrentEmpId]?.[dateStr];
        const tmpl = getTemplateForDate(adminMobileCurrentEmpId, dateStr);
        const data = sched || tmpl;
        
        const contentWrap = document.createElement('div');
        contentWrap.className = 'admin-mobile-cal-content';
        
        if (data) {
            const status = data.status || 'scheduled';
            if (status !== 'scheduled') {
                const statusMap = {
                    'other-center': { cls: 'status-other', label: t('schedule.otherCenter') },
                    'leave': { cls: 'status-leave', label: t('schedule.leave') },
                    'sick': { cls: 'status-sick', label: t('schedule.sick') },
                    'off': { cls: 'status-off', label: t('schedule.off') }
                };
                const s = statusMap[status] || { cls: '', label: status };
                contentWrap.innerHTML = `<span class="mini-status ${s.cls}">${s.label}</span>`;
            } else {
                const shifts = data._shifts || extractShifts(data);
                if (hasValidShifts(shifts)) {
                    const sortedShifts = [...shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
                    let html = '';
                    sortedShifts.forEach(shift => {
                        if (shift.type === 'break') {
                            html += `<div class="mini-shift break">☕ ${shift.start}-${shift.end}</div>`;
                        } else {
                            const badge = getShiftBadgeInfo(shift); // Automatically handles "Other" descriptions!
                            html += `<div class="mini-shift">
                                <span class="shift-center ${badge.cls}">${badge.label}</span>
                                <span class="mini-time">${shift.start}-${shift.end}</span>
                            </div>`;
                        }
                    });
                    contentWrap.innerHTML = html;
                }
            }
        }
        
        cell.appendChild(contentWrap);
        cell.addEventListener('click', () => openEditModal(adminMobileCurrentEmpId, dateStr));
        grid.appendChild(cell);
    }
}

// ============================================
// UTILITIES
// ============================================
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}
function get21Days(start) {
  const dates = [];
  for (let i = 0; i < 21; i++) dates.push(formatDateStr(addDays(start, i)));
  return dates;
}
function formatDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function updateWeekRange(elementId, dates) {
  const first = parseDate(dates[0]);
  const last = parseDate(dates[dates.length - 1]);
  const str = `${first.getDate()} ${MONTH_NAMES[first.getMonth()].substring(0, 3)} — ${last.getDate()} ${MONTH_NAMES[last.getMonth()].substring(0, 3)} ${last.getFullYear()}`;
  const el = document.getElementById(elementId);
  if (el) el.textContent = str;
}
function timeToMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function formatMin(m) {
  if (m === null) return '';
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
function getPrintDividerClass(subject) {
  const map = {
    'English Teacher': 'english',
    'Math Teacher': 'math',
    'Chinese Teacher': 'chinese',
    'Tutorial Teacher': 'tutorial',
    'Admins': 'admin',
    'Other': 'other'
  };
  return map[subject] || 'other';
}

document.getElementById('logoutBtn')?.addEventListener('click', logout);
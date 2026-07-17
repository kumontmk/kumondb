import { db, logout, requireAuth } from './auth.js';
import { ref, get, set, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// ============================================
// CONSTANTS
// ============================================
const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const auth = getAuth();
const ROLE_ORDER = ['Master Admin', 'Manager', 'Admin', 'English Teacher', 'Math Teacher', 'Chinese Teacher', 'Tutorial Teacher', 'Custodian'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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
    'English Teacher': { label: 'English Teachers', icon: '📖', cls: 'english-divider', color: '#2980b9' },
    'Math Teacher':    { label: 'Math Teachers',    icon: '🔢', cls: 'math-divider',    color: '#27ae60' },
    'Chinese Teacher': { label: 'Chinese Teachers',  icon: '🀄', cls: 'chinese-divider', color: '#e67e22' },
    'Tutorial Teacher': { label: 'Tutorial Teachers', icon: '📚', cls: 'tutorial-divider', color: '#8e44ad' },
    'Admins': { label: 'Admins', icon: '👑', cls: 'admin-divider', color: '#2c3e50' },
};

// 🆕 Helper to handle both new (array) and old (string) position data
function getEmpPositions(emp) {
    if (Array.isArray(emp.positions)) return emp.positions;
    if (emp.position) return [emp.position];
    return [];
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
let isSaving = false; // ✅ Added to prevent double-clicks

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            alert('Please log in first.');
            window.location.href = 'centers.html';
            return;
        }

        currentUser = user;
        await checkPermissions(user);
        await loadAllCenters();
        await loadAllCalendarEvents();
        await loadEmployees();
        await loadAllSchedules();
        await loadAllTemplates();

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

        document.getElementById('page-loader').classList.add('hidden');
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
            // 🆕 Check if any of their positions grant admin/manager access
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
        if (adminTabBtn) adminTabBtn.style.display = 'none';
        if (centerTabBtn) centerTabBtn.style.display = 'none';
        if (subjectTabBtn) subjectTabBtn.style.display = 'none';

        document.querySelectorAll('.schedule-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.schedule-tabs .tab-btn[data-tab="employee"]').classList.add('active');
        document.getElementById('tab-employee').classList.add('active');
    } else {
        if (adminTabBtn) adminTabBtn.style.display = '';
        if (centerTabBtn) centerTabBtn.style.display = '';
        if (subjectTabBtn) subjectTabBtn.style.display = '';
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
    if (!existingIds.includes('t11')) {
        allCenters.push({ id: 't11', name: 'T11' }); 
    }
    if (!existingIds.includes('ao')) {
        allCenters.push({ id: 'ao', name: 'AO' }); 
    }
    if (!existingIds.includes('am')) {
        allCenters.push({ id: 'am', name: 'AM' }); 
    }
}

async function loadAllCalendarEvents() {
    calendarEvents = {};
    for (const center of allCenters) {
        try {
            const snap = await get(ref(db, `centers/${center.id}/calendar`));
            if (snap.exists()) {
                calendarEvents[center.id] = snap.val();
            }
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
            if (uid === currentUser.uid) {
                employees[uid] = emp;
            }
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

function mergeScheduleRecords(existing, incoming) {
    const merged = { ...existing };
    merged._sourceCenters = merged._sourceCenters || [merged._sourceCenter];
    if (!merged._sourceCenters.includes(incoming._sourceCenter)) {
        merged._sourceCenters.push(incoming._sourceCenter);
    }
    if (!merged._shifts) {
        merged._shifts = extractShifts(merged);
    }
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
                center: s.center || sched._sourceCenter
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
    
    // 🆕 Search input event listener for real-time filtering
    document.getElementById('adminSearchInput')?.addEventListener('input', () => {
        renderAdminView();
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
        
        // 🆕 Find the highest priority role for sorting
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
}

function renderAdminHeader(dates) {
    const row = document.getElementById('adminHeaderRow');
    if (!row) return;
    row.innerHTML = '<th class="employee-header">Employee</th>';
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
        if (isHoliday) title += ` — ${holidayInfo.name || 'Holiday'}`;
        row.innerHTML += `<th class="${cls}" title="${title}">${DAY_SHORT[dow]}<br>${dateObj.getDate()}</th>`;
    });
}

function renderAdminBody(dates) {
    const tbody = document.getElementById('adminBody');
    const emptyState = document.getElementById('adminEmptyState');
    const tableWrapper = document.querySelector('#tab-admin .table-wrapper');
    if (!tbody) return;
    
    const sorted = getSortedEmployees();
    
    // 🆕 Filter employees based on search input
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
    // 🔄 Changed from sorted.forEach to filtered.forEach
    filtered.forEach(emp => {
        if (lastTerms !== null && emp.terms !== lastTerms) {
            const divRow = document.createElement('tr');
            divRow.className = 'section-divider';
            divRow.innerHTML = `<td colspan="${dates.length + 1}">— Part-Time Employees —</td>`;
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
            const tmpl = templates[emp.uid]?.[parseDate(dateStr).getDay()];
            if (sched) {
                renderMergedScheduleCell(td, sched, emp.uid, dateStr);
            } else if (tmpl) {
                td.classList.add('has-schedule');
                td.style.opacity = '0.5';
                renderMergedScheduleCell(td, tmpl, emp.uid, dateStr);
                td.title = 'Recurring pattern (click to override)';
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

// ✅ Added helper to check if shifts have valid times
function hasValidShifts(shifts) {
    if (!shifts || shifts.length === 0) return false;
    return shifts.some(s => s.start && s.end && s.start !== '--:--' && s.end !== '--:--');
}

function renderMergedScheduleCell(td, sched, empId, dateStr) {
    const status = sched.status || 'scheduled';
    if (status !== 'scheduled') {
        const statusMap = {
            'other-center': { cls: 'status-other', label: '📍 Other Center' },
            'leave': { cls: 'status-leave', label: '🏖 Leave' },
            'sick': { cls: 'status-sick', label: '🤒 Sick' },
            'off': { cls: 'status-off', label: '😴 Off' }
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
    
    // ✅ FIX: Check if shifts are valid before marking as has-schedule (prevents empty green cells)
    if (!hasValidShifts(shifts)) {
        td.classList.add('empty-cell');
        td.innerHTML = '<div class="cell-content">—</div>';
        return;
    }
    
    td.classList.add('has-schedule');
    const centersUsed = [...new Set(shifts.filter(s => s.center).map(s => s.center))];
    const isMultiCenter = centersUsed.length > 1;
    if (isMultiCenter) {
        td.classList.add('has-warning');
    }
    let html = '<div class="cell-content">';
    const sortedShifts = [...shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    sortedShifts.forEach(shift => {
        if (shift.type === 'break') {
            html += `<div class="shift-line break-line">☕ ${shift.start}-${shift.end}</div>`;
        } else {
            const cAbbr = getCenterAbbr(shift.center);
            const cClass = getCenterClass(shift.center);
            html += `<div class="shift-line">
                <span class="shift-time">${shift.start}-${shift.end}</span>
                <span class="shift-center ${cClass}">${cAbbr}</span>
            </div>`;
        }
    });
    const holidayInfo = getHolidayForDate(dateStr);
    if (holidayInfo && !holidayInfo.muc) {
        html += `<div class="holiday-indicator">🎌 ${holidayInfo.name || 'Holiday'}</div>`;
    }
    if (sched.notes) {
        html += `<div class="notes-indicator">📝</div>`;
    }
    if (isMultiCenter) {
        html += `<div class="multi-center-indicator">⚡ Multi-center</div>`;
    }
    html += '</div>';
    td.innerHTML = html;
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
    row.innerHTML = '<th class="employee-header">Date</th>';
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
        row.innerHTML += `<th class="${cls}">
            ${DAY_NAMES[dow]}<br>${dateObj.getDate()} ${MONTH_NAMES[dateObj.getMonth()].substring(0, 3)}
        </th>`;
    });
}

function renderEmployeeBody(dates, empId) {
    const tbody = document.getElementById('empBody');
    const mobileList = document.getElementById('employeeMobileList');
    const emptyState = document.getElementById('empEmptyState');
    
    if (!tbody) return;
    
    tbody.innerHTML = '';
    mobileList.innerHTML = '';
    
    let hasAnySchedule = false;
    
    // Desktop table view
    const tr = document.createElement('tr');
    const emp = employees[empId];
    const empLabel = emp ? `${emp.englishName} — ${getEmpPositions(emp).join(', ')}` : 'Schedule';
    tr.innerHTML = `<td class="employee-name-cell">${empLabel}</td>`;
    
    dates.forEach(dateStr => {
        const td = document.createElement('td');
        td.className = 'schedule-cell';
        const sched = mergedSchedules[empId]?.[dateStr];
        const tmpl = templates[empId]?.[parseDate(dateStr).getDay()];
        
        if (sched) {
            hasAnySchedule = true;
            renderMergedScheduleCell(td, sched, empId, dateStr);
        } else if (tmpl) {
            hasAnySchedule = true;
            td.classList.add('has-schedule');
            renderMergedScheduleCell(td, tmpl, empId, dateStr);
        } else {
            td.classList.add('empty-cell');
            td.innerHTML = '<div class="cell-content">No schedule</div>';
        }
        tr.appendChild(td);
    });
    
    tbody.appendChild(tr);
    
    // Mobile list view
    if (emp) {
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
            const tmpl = templates[empId]?.[dow];
            
            const item = document.createElement('div');
            item.className = 'mobile-schedule-item';
            
            let detailsHTML = '';
            
            if (sched || tmpl) {
                hasAnySchedule = true;
                const data = sched || tmpl;
                const status = data.status || 'scheduled';
                
                if (status !== 'scheduled') {
                    const statusLabels = {
                        'other-center': '📍 Other Center',
                        'leave': '🏖 On Leave',
                        'sick': '🤒 Sick',
                        'off': '😴 Off'
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
                                const centerAbbr = getCenterAbbr(shift.center);
                                detailsHTML += `
                                    <div class="mobile-shift">
                                        ${shift.start} - ${shift.end}
                                        <span class="mobile-center-badge">${centerAbbr}</span>
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
                detailsHTML = '<span class="mobile-empty">No schedule</span>';
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
    row.innerHTML = '<th class="employee-header">Teacher</th>';
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
        if (isHoliday) title += ` — ${holidayInfo.name || 'Holiday'}`;
        row.innerHTML += `<th class="${cls}" title="${title}">${DAY_SHORT[dow]}<br>${dateObj.getDate()}</th>`;
    });
}

function renderSubjectBody(dates) {
    const tbody = document.getElementById('subjectBody');
    const emptyState = document.getElementById('subjectEmptyState');
    const tableWrapper = document.getElementById('subjectTableWrapper');
    if (!tbody) return;

    const sorted = getSortedEmployees();
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
    
    // ✅ FIX: Initialize tracker to prevent double-counting
    const countedEmpIdsByDate = {};
    dates.forEach(d => countedEmpIdsByDate[d] = new Set());

    groupsToShow.forEach(group => {
        const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, icon: '👤', cls: 'other-divider', color: '#8e44ad' };
        const divRow = document.createElement('tr');
        divRow.className = `subject-divider ${config.cls}`;
        divRow.innerHTML = `<td colspan="${dates.length + 1}">
            <span class="subject-icon">${config.icon}</span> ${config.label}
            <span class="subject-count">${group.teachers.length} teacher${group.teachers.length !== 1 ? 's' : ''}</span>
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
                const tmpl = templates[emp.uid]?.[parseDate(dateStr).getDay()];
                
                if (sched) {
                    renderMergedScheduleCell(td, sched, emp.uid, dateStr);
                    const shifts = sched._shifts || extractShifts(sched);
                    if (hasValidShifts(shifts) && (sched.status || 'scheduled') === 'scheduled') {
                        // ✅ FIX: Check Set before counting
                        if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
                            countedEmpIdsByDate[dateStr].add(emp.uid);
                            dailyCounts[dateStr]++;
                        }
                    }
                } else if (tmpl) {
                    td.classList.add('has-schedule');
                    td.style.opacity = '0.5';
                    renderMergedScheduleCell(td, tmpl, emp.uid, dateStr);
                    td.title = 'Recurring pattern (click to override)';
                    const tmplShifts = tmpl._shifts || extractShifts(tmpl);
                    if (hasValidShifts(tmplShifts) && (tmpl.status || 'scheduled') === 'scheduled') {
                        // ✅ FIX: Check Set before counting
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
    summaryRow.innerHTML = `<td style="font-weight:700;">Teachers on Duty</td>`;
    dates.forEach(d => {
        summaryRow.innerHTML += `<td style="text-align:center;">${dailyCounts[d]}</td>`;
    });
    tbody.appendChild(summaryRow);
}

function printSubjectSchedule() {
    const dates = get21Days(subjectViewDate);
    const firstDate = parseDate(dates[0]);
    const lastDate = parseDate(dates[dates.length - 1]);
    const dateRangeStr = `${firstDate.getDate()} ${MONTH_NAMES[firstDate.getMonth()]} — ${lastDate.getDate()} ${MONTH_NAMES[lastDate.getMonth()]} ${lastDate.getFullYear()}`;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sorted = getSortedEmployees();
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
        if (subjectGroups[selectedSubjectFilter]) {
            groupsToShow.push({ subject: selectedSubjectFilter, teachers: subjectGroups[selectedSubjectFilter] });
        }
    }

    const filterLabel = selectedSubjectFilter === 'all' ? 'All Subjects' :
        (SUBJECT_CONFIG[selectedSubjectFilter]?.label || selectedSubjectFilter);

    let html = `
    <div class="print-header">
        <h1>Teacher Schedule — ${filterLabel}</h1>
        <p class="print-subtitle">Kumon Learning Center</p>
        <p class="print-date-range">${dateRangeStr}</p>
    </div>
    <div class="print-table-wrapper">
        <table class="print-subject-table">
            <thead>
                <tr>
                    <th class="employee-col">Teacher</th>`;

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

    // ✅ FIX: Initialize tracker to prevent double-counting in print view
    const countedEmpIdsByDate = {};
    dates.forEach(d => countedEmpIdsByDate[d] = new Set());

    groupsToShow.forEach(group => {
        const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, cls: 'other', icon: '' };
        const dividerCls = SUBJECT_CONFIG[group.subject]?.cls || 'other';
        html += `<tr class="print-subject-divider ${dividerCls}">
            <td colspan="${dates.length + 1}">${config.icon} ${config.label} (${group.teachers.length})</td>
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
                const tmpl = templates[emp.uid]?.[parseDate(dateStr).getDay()];
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
                        const statusLabels = { 'other-center': '📍 Other', 'leave': '🏖 Leave', 'sick': '🤒 Sick', 'off': '😴 Off' };
                        const statusCls = status === 'leave' ? 'leave' : status === 'sick' ? 'sick' : status === 'off' ? 'off' : 'other';
                        cellContent = `<span class="print-status ${statusCls}">${statusLabels[status] || status}</span>`;
                    } else {
                        // ✅ FIX: Check Set before counting
                        if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
                            countedEmpIdsByDate[dateStr].add(emp.uid);
                            dailyCounts[dateStr]++;
                        }
                        const sortedShifts = [...shifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
                        sortedShifts.forEach(s => {
                            if (s.type === 'break') {
                                cellContent += `<div class="print-shift break-shift">☕ ${s.start}-${s.end}</div>`;
                            } else {
                                const cAbbr = getCenterAbbr(s.center);
                                cellContent += `<div class="print-shift"><span class="time">${s.start}-${s.end}</span> <span style="font-weight:700;font-size:5.5pt;">${cAbbr}</span></div>`;
                            }
                        });
                        if (isTemplate) {
                            cellContent += `<div style="font-size:5pt;color:#888;font-style:italic;">(Pattern)</div>`;
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

    html += `<tr class="summary-row"><td>On Duty</td>`;
    dates.forEach(d => {
        html += `<td>${dailyCounts[d]}</td>`;
    });
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
        <div class="print-legend-item"><span class="print-legend-color" style="background:#e74c3c;"></span> Holiday</div>
    </div>
    <div class="print-footer">
        Printed: ${new Date().toLocaleString()} | Kumon DB — Per Subject Schedule
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
}

function addShiftRow(shiftData = null) {
    shiftCounter++;
    const container = document.getElementById('shiftsContainer');
    const shiftDiv = document.createElement('div');
    shiftDiv.className = 'shift-item';
    shiftDiv.dataset.shiftId = shiftCounter;
    const isBreak = shiftData?.type === 'break';
    if (isBreak) shiftDiv.classList.add('break-shift');
    const typeOptions = `
        <option value="work" ${!isBreak ? 'selected' : ''}>Work</option>
        <option value="break" ${isBreak ? 'selected' : ''}>Break</option>
    `;
    shiftDiv.innerHTML = `
        <div class="shift-field">
            <label>Type</label>
            <select class="shift-type" onchange="toggleShiftType(this)">
                ${typeOptions}
            </select>
        </div>
        <div class="shift-field">
            <label>Start</label>
            <input type="time" class="shift-start" value="${shiftData?.start || ''}">
        </div>
        <div class="shift-field">
            <label>End</label>
            <input type="time" class="shift-end" value="${shiftData?.end || ''}">
        </div>
        <div class="shift-field center-field" style="${isBreak ? 'display:none' : ''}">
            <label>Center</label>
            <select class="shift-center"></select>
        </div>
        <button type="button" class="remove-shift-btn" onclick="removeShiftRow(this)" title="Remove shift">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(shiftDiv);
    const centerSelect = shiftDiv.querySelector('.shift-center');
    populateCenterDropdown(centerSelect, shiftData?.center || '');
}

window.toggleShiftType = function (selectEl) {
    const shiftDiv = selectEl.closest('.shift-item');
    const centerField = shiftDiv.querySelector('.center-field');
    if (selectEl.value === 'break') {
        shiftDiv.classList.add('break-shift');
        centerField.style.display = 'none';
    } else {
        shiftDiv.classList.remove('break-shift');
        centerField.style.display = '';
    }
};

window.removeShiftRow = function (btn) {
    const shiftDiv = btn.closest('.shift-item');
    shiftDiv.remove();
};

function openEditModal(empId, dateStr) {
    if (!isAdminOrManager) {
        alert('You do not have permission to edit schedules.');
        return;
    }
    editingEmpId = empId;
    editingDate = dateStr;
    const emp = employees[empId];
    const dateObj = parseDate(dateStr);
    const dow = dateObj.getDay();
    document.getElementById('modalTitle').textContent = `Edit Schedule`;
    document.getElementById('modalDateInfo').innerHTML = `
        <strong>${emp?.englishName || 'Unknown'}</strong> — 
        ${DAY_NAMES[dow]}, ${dateObj.getDate()} ${MONTH_NAMES[dateObj.getMonth()]} ${dateObj.getFullYear()}
    `;
    document.getElementById('patternDayName').textContent = DAY_NAMES[dow];
    document.getElementById('shiftsContainer').innerHTML = '';
    shiftCounter = 0;
    const sched = mergedSchedules[empId]?.[dateStr];
    editingSourceCenter = sched?._sourceCenter || null;
    if (sched) {
        const shifts = sched._shifts || extractShifts(sched);
        if (shifts.length > 0) {
            shifts.forEach(s => addShiftRow(s));
        } else {
            addShiftRow();
        }
        document.getElementById('scheduleStatus').value = sched.status || 'scheduled';
        document.getElementById('scheduleNotes').value = sched.notes || '';
    } else {
        const tmpl = templates[empId]?.[dow];
        if (tmpl) {
            const tmplShifts = tmpl._shifts || extractShifts(tmpl);
            if (tmplShifts.length > 0) {
                tmplShifts.forEach(s => addShiftRow(s));
            } else {
                addShiftRow();
            }
            document.getElementById('scheduleStatus').value = tmpl.status || 'scheduled';
            document.getElementById('scheduleNotes').value = tmpl.notes || '';
        } else {
            addShiftRow();
            document.getElementById('scheduleStatus').value = 'scheduled';
            document.getElementById('scheduleNotes').value = '';
        }
    }
    document.getElementById('saveAsPattern').checked = false;
    checkModalWarnings(empId, dateStr);
    document.getElementById('scheduleModal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('scheduleModal').classList.add('hidden');
    editingEmpId = null;
    editingDate = null;
    editingSourceCenter = null;
}

function checkModalWarnings(empId, dateStr) {
    const warningsDiv = document.getElementById('modalWarnings');
    if (!warningsDiv) return;
    warningsDiv.innerHTML = '';
    const dateObj = parseDate(dateStr);
    const dow = dateObj.getDay();
    const holidayInfo = getHolidayForDate(dateStr);
    if (holidayInfo && !holidayInfo.muc) {
        warningsDiv.innerHTML += `<div class="warning-box">
            ⚠️ ${holidayInfo.type === 'public' ? 'Public Holiday' : 'Center Holiday'}: ${holidayInfo.name || ''}. 
            You can still save, but it will be flagged.
        </div>`;
    }
    const shiftItems = document.querySelectorAll('#shiftsContainer .shift-item');
    shiftItems.forEach(item => {
        const centerSelect = item.querySelector('.shift-center');
        if (centerSelect && centerSelect.value) {
            if (isCenterClosedOnDay(centerSelect.value, dow)) {
                const centerName = allCenters.find(c => c.id === centerSelect.value)?.name || centerSelect.value;
                warningsDiv.innerHTML += `<div class="error-box">
                    ❌ ${centerName} is closed on ${DAY_NAMES[dow]}s. Please choose a different center or day.
                </div>`;
            }
        }
    });
}

document.addEventListener('change', (e) => {
    if (e.target.classList.contains('shift-center') && editingEmpId && editingDate) {
        checkModalWarnings(editingEmpId, editingDate);
    }
});

// ✅ Added helper to update modal loading state
function updateModalLoadingState(loading) {
    const saveBtn = document.getElementById('saveScheduleBtn');
    const clearBtn = document.getElementById('clearDayBtn');
    const cancelBtn = document.getElementById('cancelModalBtn');
    const modalFooter = document.querySelector('.modal-footer-right');
    
    if (loading) {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<span class="spinner-small"></span> Saving...';
        }
        if (clearBtn) clearBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (modalFooter) modalFooter.style.opacity = '0.7';
    } else {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Save';
        }
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

        // ✅ Only collect shifts that have valid start and end times
        shiftItems.forEach(item => {
            const type = item.querySelector('.shift-type').value;
            const start = item.querySelector('.shift-start').value;
            const end = item.querySelector('.shift-end').value;
            const center = type === 'work' ? item.querySelector('.shift-center').value : null;
            if (start && end && start !== '' && end !== '') {
                shifts.push({ type, start, end, center });
            }
        });

        const data = {
            status,
            shifts,
            notes,
            updatedAt: new Date().toISOString(),
            updatedBy: currentUser.uid
        };

        const errors = validateSchedule(data, editingDate);
        if (errors.length > 0) {
            document.getElementById('modalWarnings').innerHTML =
                errors.map(e => `<div class="error-box">❌ ${e}</div>`).join('');
            isSaving = false;
            updateModalLoadingState(false);
            return;
        }

        // ✅ FIX 1: If saving an empty schedule (no valid shifts), clear it from ALL centers 
        // to prevent the merge bug where old shifts from other centers persist.
        if (shifts.length === 0 && status === 'scheduled') {
            for (const center of allCenters) {
                await set(ref(db, `schedules/${center.id}/${editingEmpId}/${editingDate}`), data);
            }
        } else {
            let targetCenter = null;
            const workShifts = shifts.filter(s => s.type === 'work' && s.center);
            if (workShifts.length > 0) {
                targetCenter = workShifts[0].center;
            }
            if (!targetCenter) {
                targetCenter = editingSourceCenter;
            }
            if (!targetCenter) {
                if (allCenters.length > 0) {
                    targetCenter = allCenters[0].id;
                } else {
                    alert('❌ No centers available to save schedule.');
                    isSaving = false;
                    updateModalLoadingState(false);
                    return;
                }
            }

            const overlapError = await checkOverlaps(editingEmpId, editingDate, data, targetCenter);
            if (overlapError) {
                document.getElementById('modalWarnings').innerHTML =
                    `<div class="error-box">❌ ${overlapError}</div>`;
                isSaving = false;
                updateModalLoadingState(false);
                return;
            }

            // Remove old schedule first if source center is different
            if (editingSourceCenter && editingSourceCenter !== targetCenter) {
                await remove(ref(db, `schedules/${editingSourceCenter}/${editingEmpId}/${editingDate}`));
            }
            await set(ref(db, `schedules/${targetCenter}/${editingEmpId}/${editingDate}`), data);
        }

        // Handle recurring pattern
        if (document.getElementById('saveAsPattern').checked) {
            const dateObj = parseDate(editingDate);
            const dow = dateObj.getDay();
            const templateData = { status, shifts, notes };
            if (shifts.length > 0 || status !== 'scheduled') {
                await set(ref(db, `scheduleTemplates/${editingEmpId}/${dow}`), templateData);
            } else {
                await remove(ref(db, `scheduleTemplates/${editingEmpId}/${dow}`));
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
        console.error('Save error:', err);
        alert('Failed to save schedule. Check console.');
    } finally {
        isSaving = false;
        updateModalLoadingState(false);
    }
}


async function clearDay() {
    if (isSaving || !editingEmpId || !editingDate) return;
    if (!confirm('Clear the schedule for this day across ALL centers?')) return;
    
    isSaving = true;
    updateModalLoadingState(true);
    
    try {
        const emptyData = {
            status: 'scheduled',
            shifts: [],
            notes: '',
            updatedAt: new Date().toISOString(),
            updatedBy: currentUser.uid
        };
        
        // ✅ FIX: Save an empty schedule to all centers to override any templates
        for (const center of allCenters) {
            await set(ref(db, `schedules/${center.id}/${editingEmpId}/${editingDate}`), emptyData);
        }
        
        // ✅ FIX: Also clear the template for this day of week if "Save as Pattern" is checked
        if (document.getElementById('saveAsPattern').checked) {
            const dateObj = parseDate(editingDate);
            const dow = dateObj.getDay();
            await remove(ref(db, `scheduleTemplates/${editingEmpId}/${dow}`));
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
        alert('Failed to clear.');
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
            errors.push(`Shift ${idx + 1}: start must be before end.`);
        }
        if (shift.type === 'work' && shift.center) {
            if (isCenterClosedOnDay(shift.center, dow)) {
                const centerName = allCenters.find(c => c.id === shift.center)?.name || shift.center;
                errors.push(`Shift ${idx + 1}: ${centerName} is closed on ${DAY_NAMES[dow]}s.`);
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
                    errors.push(`Shift ${i + 1} overlaps with shift ${j + 1}.`);
                }
            }
        }
    }
    return errors;
}

async function checkOverlaps(empId, dateStr, newData, currentCenter) {
    if (newData.status !== 'scheduled') return null;
    const newShifts = newData.shifts
        .filter(s => s.type === 'work')
        .map(s => ({ start: timeToMin(s.start), end: timeToMin(s.end) }))
        .filter(s => s.start !== null && s.end !== null);
    if (newShifts.length === 0) return null;
    for (const center of allCenters) {
        if (center.id === currentCenter) continue;
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
                    return `Time overlap at ${center.name}: ${formatMin(ns.start)}-${formatMin(ns.end)} overlaps with ${formatMin(es.start)}-${formatMin(es.end)}`;
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
    const originalText = 'Apply Patterns to Month';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-small"></span> Applying...';
    }

    const midDate = addDays(viewStartDate, 10);
    const year = midDate.getFullYear();
    const month = midDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = `${MONTH_NAMES[month]} ${year}`;

    if (!confirm(`Apply recurring patterns to all of ${monthName}?\n\nThis will fill in schedules for days that don't have overrides or are currently empty.`)) {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
        return;
    }

    let count = 0;
    let skipped = 0;
    try {
        for (const [empId, empTemplates] of Object.entries(templates)) {
            for (let day = 1; day <= daysInMonth; day++) {
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const dateObj = new Date(year, month, day);
                const dow = dateObj.getDay();

                const existingSched = mergedSchedules[empId]?.[dateStr];
                
                // ✅ FIX 2: Check if the existing schedule is ACTUALLY empty before skipping it.
                // This allows the pattern to overwrite days that were previously cleared.
                if (existingSched) {
                    const existingShifts = existingSched._shifts || extractShifts(existingSched);
                    const hasValidExistingShifts = hasValidShifts(existingShifts);
                    const hasSpecialStatus = existingSched.status && existingSched.status !== 'scheduled';
                    
                    if (hasValidExistingShifts || hasSpecialStatus) {
                        skipped++;
                        continue; // Skip days that have real shifts or special statuses (Leave, Sick, etc.)
                    }
                }

                if (!empTemplates[dow]) continue;

                const tmpl = empTemplates[dow];
                const schedData = {
                    status: tmpl.status || 'scheduled',
                    shifts: tmpl.shifts || [],
                    notes: tmpl.notes || '',
                    isFromPattern: true,
                    updatedAt: new Date().toISOString(),
                    updatedBy: currentUser.uid
                };

                let targetCenter = null;
                const workShifts = schedData.shifts.filter(s => s.type === 'work' && s.center);
                if (workShifts.length > 0) {
                    targetCenter = workShifts[0].center;
                }
                if (!targetCenter) {
                    if (allCenters.length > 0) targetCenter = allCenters[0].id;
                }

                if (targetCenter) {
                    await set(ref(db, `schedules/${targetCenter}/${empId}/${dateStr}`), schedData);
                    count++;
                }
            }
        }

        await loadAllSchedules();
        alert(`✅ Applied patterns: ${count} entries created/updated, ${skipped} skipped.`);
        renderAdminView();
        renderEmployeeView();
        renderCenterView();
        renderSubjectView();
    } catch (err) {
        console.error('Apply pattern error:', err);
        alert('❌ Error applying patterns.');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
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
    if (dropdown.options.length > 0) {
        selectedCenterForView = dropdown.value;
    }
    dropdown.addEventListener('change', () => {
        selectedCenterForView = dropdown.value;
        renderCenterView();
    });
    document.getElementById('centerPrevBtn')?.addEventListener('click', () => {
        centerViewDate = addDays(centerViewDate, -14);
        renderCenterView();
    });
    document.getElementById('centerNextBtn')?.addEventListener('click', () => {
        centerViewDate = addDays(centerViewDate, 14);
        renderCenterView();
    });
    document.getElementById('centerTodayBtn')?.addEventListener('click', () => {
        centerViewDate = getMonday(new Date());
        renderCenterView();
    });
    document.getElementById('printCenterBtn')?.addEventListener('click', printCenterSchedule);

    document.getElementById('exportJpegBtn')?.addEventListener('click', exportCenterAsJpeg);

    document.getElementById('centerGroupBySubject')?.addEventListener('change', (e) => {
        centerGroupBySubject = e.target.checked;
        renderCenterView();
    });
}

function get14Days(start) {
    const dates = [];
    for (let i = 0; i < 14; i++) {
        dates.push(formatDateStr(addDays(start, i)));
    }
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
    row.innerHTML = '<th class="employee-header">Employee</th>';
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
        if (isHoliday) title += ` — ${event.name || 'Holiday'}`;
        if (isClosed) title += ' — Closed';
        row.innerHTML += `<th class="${cls}" title="${title}">
            ${DAY_SHORT[dow]}<br>${dateObj.getDate()}
        </th>`;
    });
}

function groupEmployeesBySubject(empList) {
    const subjectGroups = {};
    const subjectOrder = ['English Teacher', 'Math Teacher', 'Chinese Teacher'];
    const adminRoles = ['Admin'];
    const otherTeachers = [];
    const addedEmpIds = new Set();
    
    empList.forEach(emp => {
        const positions = getEmpPositions(emp);
        let matchedSubject = false;
        
        // 1. Check for Admin roles FIRST
        const hasAdminRole = positions.some(p => adminRoles.includes(p));
        if (hasAdminRole) {
            if (!subjectGroups['Admins']) subjectGroups['Admins'] = [];
            subjectGroups['Admins'].push(emp);
            addedEmpIds.add(emp.uid);
            matchedSubject = true;
        }
        
        // 2. Check for teaching subjects
        if (!matchedSubject) {
            for (const subj of subjectOrder) {
                if (positions.includes(subj)) {
                    if (!subjectGroups[subj]) subjectGroups[subj] = [];
                    subjectGroups[subj].push(emp);
                    matchedSubject = true;
                    addedEmpIds.add(emp.uid);
                    
                    // ✅ FIX: Removed the 'break;' statement here!
                    // Now the loop will continue checking the rest of the subjects,
                    // allowing an employee to be added to multiple subject groups.
                }
            }
        }
        
        // 3. If not admin and not a main subject, put in 'Other' (This catches Tutorial Teachers now)
        if (!matchedSubject && !addedEmpIds.has(emp.uid)) {
            otherTeachers.push(emp);
            addedEmpIds.add(emp.uid);
        }
    });

    const groupsToShow = [];
    
    // Add standard subjects
    subjectOrder.forEach(subj => {
        if (subjectGroups[subj] && subjectGroups[subj].length > 0) {
            groupsToShow.push({ subject: subj, teachers: subjectGroups[subj] });
        }
    });
    
    // Add Admins group
    if (subjectGroups['Admins'] && subjectGroups['Admins'].length > 0) {
        groupsToShow.push({ subject: 'Admins', teachers: subjectGroups['Admins'] });
    }
    
    // Add Other group
    if (otherTeachers.length > 0) {
        groupsToShow.push({ subject: 'Other', teachers: otherTeachers });
    }
    
    return groupsToShow;
}

// ✅ UPDATED: Added countedEmpIdsByDate to prevent double-counting
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
        const tmpl = templates[emp.uid]?.[dow];
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
                td.innerHTML = `<div class="cell-content"><span class="status-label">Closed</span></div>`;
            } else if (isHoliday) {
                td.classList.add('is-holiday');
                td.innerHTML = `<div class="cell-content"><span class="status-label">${event.name || 'Holiday'}</span></div>`;
            } else {
                td.classList.add('empty-cell');
                td.innerHTML = `<div class="cell-content">—</div>`;
            }
        } else {
            if (isClosed) {
                td.classList.add('is-closed');
                td.innerHTML = `<div class="cell-content"><span class="status-label">Closed</span></div>`;
            } else if (isHoliday) {
                td.classList.add('is-holiday');
                td.innerHTML = `<div class="cell-content"><span class="status-label">🎌 ${event.name || 'Holiday'}</span></div>`;
            } else {
                td.classList.add('empty-cell');
                td.innerHTML = `<div class="cell-content">—</div>`;
            }
        }
        
        // ✅ FIX: Only count if we haven't already counted this emp for this date
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

// ✅ UPDATED: Added countedEmpIdsByDate parameter
function getCenterPrintRowHtml(emp, dates, selectedCenterForView, centerCalEvents, closedDays, today, dailyCounts, countedEmpIdsByDate) {
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
        const tmpl = templates[emp.uid]?.[dow];
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
            const centerShifts = shifts.filter(s => s.center === selectedCenterForView);
            if (status !== 'scheduled') {
                const statusLabels = { 'other-center': '📍 Other', 'leave': '🏖 Leave', 'sick': '🤒 Sick', 'off': '😴 Off' };
                const statusCls = status === 'leave' ? 'leave' : status === 'sick' ? 'sick' : status === 'off' ? 'off' : 'other';
                cellContent = `<span class="print-status ${statusCls}">${statusLabels[status] || status}</span>`;
            } else if (centerShifts.length > 0 && hasValidShifts(centerShifts)) {
                // ✅ FIX: Check Set before counting
                if (!countedEmpIdsByDate[dateStr]) countedEmpIdsByDate[dateStr] = new Set();
                if (!countedEmpIdsByDate[dateStr].has(emp.uid)) {
                    countedEmpIdsByDate[dateStr].add(emp.uid);
                    dailyCounts[dateStr]++;
                }
                
                const sortedShifts = [...centerShifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
                sortedShifts.forEach(s => {
                    if (s.type === 'break') {
                        cellContent += `<div class="print-shift break-shift">☕ ${s.start}-${s.end}</div>`;
                    } else {
                        cellContent += `<div class="print-shift"><span class="time">${s.start}-${s.end}</span></div>`;
                    }
                });
                if (isTemplate) {
                    cellContent += `<div style="font-size:5pt;color:#888;font-style:italic;">(Pattern)</div>`;
                }
            } else if (isClosed) {
                cellContent = `<span style="color:#999;font-size:6pt;">Closed</span>`;
            } else if (isHoliday) {
                cellContent = `<span style="color:#e74c3c;font-size:6pt;">🎌 ${event.name || ''}</span>`;
            } else {
                cellCls += ' empty-cell';
                cellContent = '—';
            }
        } else {
            if (isClosed) cellContent = `<span style="color:#999;font-size:6pt;">Closed</span>`;
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
            const tmpl = templates[emp.uid]?.[dow];
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
            if (hasCenterShift || isStatusHere) {
                hasShiftHere = true;
                break;
            }
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
    
    // ✅ FIX: Initialize tracker to prevent double-counting
    const countedEmpIdsByDate = {};
    dates.forEach(d => countedEmpIdsByDate[d] = new Set());

    if (centerGroupBySubject) {
        const groups = groupEmployeesBySubject(employeesWithShifts);
        groups.forEach(group => {
            const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, icon: '👤', cls: 'other-divider', color: '#8e44ad' };
            const divRow = document.createElement('tr');
            divRow.className = `subject-divider ${config.cls}`;
            divRow.innerHTML = `<td colspan="${dates.length + 1}">
                <span class="subject-icon">${config.icon}</span> ${config.label}
                <span class="subject-count">${group.teachers.length} teacher${group.teachers.length !== 1 ? 's' : ''}</span>
            </td>`;
            tbody.appendChild(divRow);
            group.teachers.forEach(emp => {
                // ✅ UPDATED: Pass countedEmpIdsByDate
                renderCenterEmployeeRow(emp, dates, tbody, dailyCounts, centerCalEvents, closedDays, today, countedEmpIdsByDate);
            });
        });
    } else {
        let lastTerms = null;
        employeesWithShifts.forEach(emp => {
            if (lastTerms !== null && emp.terms !== lastTerms) {
                const divRow = document.createElement('tr');
                divRow.className = 'section-divider';
                divRow.innerHTML = `<td colspan="${dates.length + 1}">— Part-Time Employees —</td>`;
                tbody.appendChild(divRow);
            }
            lastTerms = emp.terms;
            // ✅ UPDATED: Pass countedEmpIdsByDate
            renderCenterEmployeeRow(emp, dates, tbody, dailyCounts, centerCalEvents, closedDays, today, countedEmpIdsByDate);
        });
    }

    const summaryRow = document.createElement('tr');
    summaryRow.className = 'section-divider summary-row';
    summaryRow.innerHTML = `<td style="font-weight:700;">Staff Count</td>`;
    dates.forEach((d, idx) => {
        const cls = idx === 7 ? 'week-separator' : '';
        summaryRow.innerHTML += `<td class="${cls}" style="text-align:center;">${dailyCounts[d]}</td>`;
    });
    tbody.appendChild(summaryRow);
}

function renderStatusCell(td, status, notes) {
    const statusMap = {
        'other-center': { cls: 'status-other', label: '📍 Other' },
        'leave': { cls: 'status-leave', label: ' Leave' },
        'sick': { cls: 'status-sick', label: ' Sick' },
        'off': { cls: 'status-off', label: '😴 Off' }
    };
    const s = statusMap[status] || { cls: '', label: status };
    td.classList.add(s.cls);
    let html = `<div class="cell-content"><span class="status-label">${s.label}</span>`;
    if (notes) html += `<div class="notes-indicator"></div>`;
    html += '</div>';
    td.innerHTML = html;
}

function renderCenterShiftCell(td, shifts, isHoliday, event) {
    // ✅ FIX: Check if shifts are valid
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
        if (shift.type === 'break') {
            html += `<div class="shift-line break-line">☕ ${shift.start}-${shift.end}</div>`;
        } else {
            html += `<div class="shift-line">
                <span class="shift-time">${shift.start}-${shift.end}</span>
            </div>`;
        }
    });
    if (isHoliday && event && !event.muc) {
        html += `<div class="holiday-indicator">🎌 ${event.name || 'Holiday'}</div>`;
    }
    html += '</div>';
    td.innerHTML = html;
}

// ✅ NEW: Generates the HTML string for the Center Printout (Legends Removed)
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
            const dateObj = parseDate(dateStr);
            const dow = dateObj.getDay();
            const sched = mergedSchedules[emp.uid]?.[dateStr];
            const tmpl = templates[emp.uid]?.[dow];
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
            if (hasCenterShift || isStatusHere) {
                hasShift = true;
                break;
            }
        }
        if (hasShift) employeesWithShifts.push(emp);
    });

    let html = `<div class="print-header"> <h1>${centerNamePrint} — Employee Schedule</h1> <p class="print-subtitle">Kumon Learning Center</p> <p class="print-date-range">${dateRangeStr}</p> </div> <div class="print-table-wrapper"> <table class="print-schedule-table"> <thead> <tr> <th class="employee-col">Employee</th>`;
    
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

    // ✅ FIX: Initialize tracker to prevent double-counting in print view
    const countedEmpIdsByDate = {};
    dates.forEach(d => countedEmpIdsByDate[d] = new Set());

    if (centerGroupBySubject) {
        const groups = groupEmployeesBySubject(employeesWithShifts);
        groups.forEach(group => {
            const config = SUBJECT_CONFIG[group.subject] || { label: group.subject, cls: 'other', icon: '' };
            const dividerCls = SUBJECT_CONFIG[group.subject]?.cls || 'other';
            html += `<tr class="print-subject-divider ${dividerCls}">
                <td colspan="${dates.length + 1}">${config.icon} ${config.label} (${group.teachers.length})</td>
            </tr>`;
            group.teachers.forEach(emp => {
                html += getCenterPrintRowHtml(emp, dates, selectedCenterForView, centerCalEvents, closedDays, today, dailyCounts, countedEmpIdsByDate);
            });
        });
    } else {
        let lastTerms = null;
        employeesWithShifts.forEach(emp => {
            if (lastTerms !== null && emp.terms !== lastTerms) {
                html += `<tr class="section-row"><td colspan="${dates.length + 1}">— Part-Time Employees —</td></tr>`;
            }
            lastTerms = emp.terms;
            html += getCenterPrintRowHtml(emp, dates, selectedCenterForView, centerCalEvents, closedDays, today, dailyCounts, countedEmpIdsByDate);
        });
    }

    html += `<tr class="summary-row"><td>Staff Count</td>`;
    dates.forEach((d, idx) => {
        const sep = idx === 7 ? ' week-sep' : '';
        html += `<td class="${sep}">${dailyCounts[d]}</td>`;
    });
    html += '</tr></tbody></table></div>';

    // ✅ LEGENDS REMOVED AS REQUESTED
    html += `
    <div class="print-footer">
        Printed: ${new Date().toLocaleString()} | Kumon DB Employee Schedule System
    </div>`;
    
    return html;
}

// ✅ IMPROVED: High-Quality JPEG Export with !important override
async function exportCenterAsJpeg() {
    if (!selectedCenterForView) {
        alert('Please select a center first.');
        return;
    }
    
    if (typeof html2canvas === 'undefined') {
        alert('❌ Export library not loaded. Please refresh the page and try again.');
        return;
    }
    
    const btn = document.getElementById('exportJpegBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-small"></span> Generating...';

    try {
        const html = generateCenterPrintHTML();
        const printArea = document.getElementById('printArea');
        
        if (!printArea) {
            throw new Error('Print area element not found');
        }
        
        // 1. Inject HTML
        printArea.innerHTML = html;
        
        // 2. Force visibility using setProperty with 'important' to override CSS !important
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

        // 3. Inject temporary CSS to force print styles on screen
        const tempStyle = document.createElement('style');
        tempStyle.id = 'temp-export-styles';
        tempStyle.innerHTML = `
            #printArea * { 
                visibility: visible !important; 
                opacity: 1 !important;
            }
            #printArea .print-schedule-table, #printArea .print-subject-table {
                width: 100%; border-collapse: collapse; font-size: 10pt; font-family: Arial, sans-serif;
            }
            #printArea .print-schedule-table th, #printArea .print-subject-table th {
                background: #1a5276 !important; color: white !important; padding: 4px; text-align: center; font-size: 9pt; font-weight: 700; border: 1px solid #ccc;
            }
            #printArea .print-schedule-table th.employee-col { width: 15%; text-align: left; padding-left: 8px; background: #154360 !important; }
            #printArea .print-schedule-table td, #printArea .print-subject-table td {
                padding: 4px; border: 1px solid #ccc; vertical-align: top; text-align: left; height: 45px; font-size: 9pt;
            }
            #printArea .print-schedule-table td.employee-col { background: #f8f9fa !important; font-weight: 700; border-right: 2px solid #1a5276; }
            #printArea .print-shift { font-size: 10pt; line-height: 1.4; }
            #printArea .print-shift .time { font-size: 11pt; font-weight: 700; }
            #printArea .print-status { font-weight: 700; font-size: 9pt; }
            #printArea tr.print-subject-divider td { font-weight: 700; font-size: 10pt; color: white; padding: 6px; }
            #printArea tr.print-subject-divider.english td { background: #2980b9 !important; }
            #printArea tr.print-subject-divider.math td { background: #27ae60 !important; }
            #printArea tr.print-subject-divider.chinese td { background: #e67e22 !important; }
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

        // Wait for DOM to update and render
        await new Promise(resolve => setTimeout(resolve, 300));

        console.log('Starting html2canvas capture...');
        const canvas = await html2canvas(printArea, {
            scale: 3,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: true,
            width: 1400,
            windowWidth: 1400,
            windowHeight: printArea.scrollHeight,
            onclone: (clonedDoc) => {
                console.log('Clone completed');
            }
        });

        console.log('Canvas created:', canvas.width, 'x', canvas.height);

        // 4. Cleanup DOM and Styles (removeProperty reverts to the original CSS !important rule)
        document.head.removeChild(tempStyle);
        printArea.innerHTML = '';
        printArea.style.removeProperty('display');
        printArea.style.removeProperty('position');
        printArea.style.removeProperty('left');
        printArea.style.removeProperty('top');
        printArea.style.removeProperty('width');
        printArea.style.removeProperty('background');
        printArea.style.removeProperty('z-index');
        printArea.style.removeProperty('padding');
        printArea.style.removeProperty('visibility');
        printArea.style.removeProperty('opacity');

        if (canvas.width === 0 || canvas.height === 0) {
            throw new Error('Canvas is empty - capture failed');
        }

        // 5. Convert to blob and download
        canvas.toBlob((blob) => {
            if (!blob) {
                alert('❌ Failed to generate image. Please try again.');
                return;
            }
            
            console.log('Blob created:', blob.size, 'bytes');
            
            if (blob.size === 0) {
                alert('❌ Generated image is empty. Please check console for errors.');
                return;
            }
            
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const centerName = allCenters.find(c => c.id === selectedCenterForView)?.name || 'Center';
            const timestamp = new Date().toISOString().slice(0,10);
            link.download = `${centerName.replace(/\s+/g, '_')}_Schedule_${timestamp}.jpeg`;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            
            console.log('Download initiated');
        }, 'image/jpeg', 0.95);

    } catch (err) {
        console.error('Export error:', err);
        alert(`❌ Failed to export JPEG: ${err.message}\n\nCheck console for details.`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// ✅ UPDATED: Now uses the extracted HTML generator
function printCenterSchedule() {
    if (!selectedCenterForView) {
        alert('Please select a center first.');
        return;
    }
    const html = generateCenterPrintHTML();
    const printArea = document.getElementById('printArea');
    if (printArea) {
        printArea.innerHTML = html;
    }
    window.print();
    setTimeout(() => {
        if (printArea) printArea.innerHTML = '';
    }, 1000);
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
    for (let i = 0; i < 21; i++) {
        dates.push(formatDateStr(addDays(start, i)));
    }
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

document.getElementById('logoutBtn')?.addEventListener('click', logout);
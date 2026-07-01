import { db, logout, requireAuth } from './auth.js';
import { ref, get, set, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// ============================================
// CONSTANTS
// ============================================
const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const auth = getAuth();

const ROLE_ORDER = ['English Teacher', 'Math Teacher', 'Chinese Teacher', 'Admin', 'Manager'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// ✅ Center closed days (0=Sun, 6=Sat)
const CENTER_CLOSED_DAYS = {
    'mei keng': [0],
    'pac tat': [0, 6],
    'champs': [0],
    'tap siac': [2]
};

// ============================================
// GLOBAL STATE
// ============================================
let currentUser = null;
let isAdminOrManager = false;

let employees = {};
let allCenters = [];
let calendarEvents = {};     // { centerId: { 'YYYY-MM-DD': { type, name, muc } } }
let mergedSchedules = {};    // { empId: { 'YYYY-MM-DD': scheduleData } }
let rawSchedulesByCenter = {};
let templates = {};          // { empId: { dayOfWeek: templateData } } — now global

let viewStartDate = getMonday(new Date());
let empViewStartDate = getMonday(new Date());

let editingEmpId = null;
let editingDate = null;
let editingSourceCenter = null;
let shiftCounter = 0; // For unique IDs

// ✅ NEW: Per-center view state
let centerViewDate = getMonday(new Date());
let selectedCenterForView = '';

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
        setupModal();
        applyPermissionUI();

        renderAdminView();
        renderEmployeeView();
        
        // ✅ NEW: Setup and render per-center view
        setupCenterNav();
        renderCenterView();

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
            const pos = (snap.val().position || '').toLowerCase();
            if (pos === 'manager' || pos === 'admin') {
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
    
    if (!isAdminOrManager) {
        if (adminTabBtn) adminTabBtn.style.display = 'none';
        // ✅ NEW: Hide center tab for non-admins
        if (centerTabBtn) centerTabBtn.style.display = 'none';
        
        document.querySelectorAll('.schedule-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.schedule-tabs .tab-btn[data-tab="employee"]').classList.add('active');
        document.getElementById('tab-employee').classList.add('active');
    } else {
        if (adminTabBtn) adminTabBtn.style.display = '';
        // ✅ NEW: Show center tab for admins
        if (centerTabBtn) centerTabBtn.style.display = '';
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
    if (!allCenters.find(c => c.id === '__other__')) {
        allCenters.push({ id: '__other__', name: 'Other Centers' });
    }
}

async function loadAllCalendarEvents() {
    calendarEvents = {};
    for (const center of allCenters) {
        if (center.id === '__other__') continue;
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
        if (center.id === '__other__') continue;
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
    // Support new format: shifts array
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
        // Legacy format
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
        // Structure: { empId: { dayOfWeek: templateData } }
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

// ============================================
// SORTING
// ============================================
function getSortedEmployees() {
    const empList = Object.entries(employees).map(([uid, e]) => ({ uid, ...e }));
    empList.sort((a, b) => {
        const termsA = a.terms === 'Full-time' ? 0 : 1;
        const termsB = b.terms === 'Full-time' ? 0 : 1;
        if (termsA !== termsB) return termsA - termsB;
        const roleA = ROLE_ORDER.indexOf(a.position);
        const roleB = ROLE_ORDER.indexOf(b.position);
        const rA = roleA === -1 ? 99 : roleA;
        const rB = roleB === -1 ? 99 : roleB;
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
    today.setHours(0,0,0,0);

    dates.forEach(d => {
        const dateObj = parseDate(d);
        const dow = dateObj.getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = dateObj.getTime() === today.getTime();

        // Check if any center has holiday on this date
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
    if (sorted.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    emptyState.classList.add('hidden');
    if (tableWrapper) tableWrapper.style.display = '';
    tbody.innerHTML = '';

    let lastTerms = null;
    sorted.forEach(emp => {
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
            <span class="emp-role">${emp.position || ''}</span>
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

    td.classList.add('has-schedule');

    const shifts = sched._shifts || extractShifts(sched);
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

    // ✅ Show holiday indicator
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
    if (centerId === '__other__') return 'OTHER';
    const c = allCenters.find(x => x.id === centerId);
    if (!c) return centerId.substring(0, 4).toUpperCase();
    const n = c.name.toLowerCase();
    if (n.includes('mei keng')) return 'MK';
    if (n.includes('pac tat')) return 'PT';
    if (n.includes('tap siac')) return 'TS';
    if (n.includes('champs')) return 'C';
    return c.name.substring(0, 4).toUpperCase();
}

function getCenterClass(centerId) {
    const abbr = getCenterAbbr(centerId);
    return `c-${abbr}`;
}

// ✅ Get holiday info for a date across all centers
function getHolidayForDate(dateStr) {
    for (const centerId in calendarEvents) {
        const events = calendarEvents[centerId];
        if (events && events[dateStr] && !events[dateStr].muc) {
            return events[dateStr];
        }
    }
    return null;
}

// ✅ Check if a center is closed on a specific day of week
function isCenterClosedOnDay(centerId, dayOfWeek) {
    if (!centerId || centerId === '__other__') return false;
    const center = allCenters.find(c => c.id === centerId);
    if (!center) return false;
    
    const name = center.name.toLowerCase();
    let closedDays = [0]; // default Sunday
    
    if (name.includes('mei keng')) closedDays = CENTER_CLOSED_DAYS['mei keng'];
    else if (name.includes('pac tat')) closedDays = CENTER_CLOSED_DAYS['pac tat'];
    else if (name.includes('champs')) closedDays = CENTER_CLOSED_DAYS['champs'];
    else if (name.includes('tap siac')) closedDays = CENTER_CLOSED_DAYS['tap siac'];
    
    return closedDays.includes(dayOfWeek);
}

// ✅ NEW: Get closed days array for a center name
function getClosedDaysForCenter(name) {
    const lowerName = (name || '').toLowerCase();
    if (lowerName.includes('mei keng')) return CENTER_CLOSED_DAYS['mei keng'];
    if (lowerName.includes('pac tat')) return CENTER_CLOSED_DAYS['pac tat'];
    if (lowerName.includes('champs')) return CENTER_CLOSED_DAYS['champs'];
    if (lowerName.includes('tap siac')) return CENTER_CLOSED_DAYS['tap siac'];
    return [0]; // Default fallback
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
            opt.textContent = `${emp.englishName} (${emp.position})`;
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
    today.setHours(0,0,0,0);

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
            ${DAY_NAMES[dow]}<br>${dateObj.getDate()} ${MONTH_NAMES[dateObj.getMonth()].substring(0,3)}
        </th>`;
    });
}

function renderEmployeeBody(dates, empId) {
    const tbody = document.getElementById('empBody');
    const emptyState = document.getElementById('empEmptyState');
    if (!tbody) return;
    tbody.innerHTML = '';

    let hasAnySchedule = false;
    const tr = document.createElement('tr');
    const emp = employees[empId];
    const empLabel = emp ? `${emp.englishName} — ${emp.position}` : 'Schedule';
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
    if (!hasAnySchedule) emptyState.classList.remove('hidden');
    else emptyState.classList.add('hidden');
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

    // Populate center dropdown
    const centerSelect = shiftDiv.querySelector('.shift-center');
    populateCenterDropdown(centerSelect, shiftData?.center || '');
}

window.toggleShiftType = function(selectEl) {
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

window.removeShiftRow = function(btn) {
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

    // Clear shifts container
    document.getElementById('shiftsContainer').innerHTML = '';
    shiftCounter = 0;

    const sched = mergedSchedules[empId]?.[dateStr];
    editingSourceCenter = sched?._sourceCenter || null;

    if (sched) {
        const shifts = sched._shifts || extractShifts(sched);
        if (shifts.length > 0) {
            shifts.forEach(s => addShiftRow(s));
        } else {
            addShiftRow(); // Add empty shift
        }
        document.getElementById('scheduleStatus').value = sched.status || 'scheduled';
        document.getElementById('scheduleNotes').value = sched.notes || '';
    } else {
        // Check if there's a template for this day
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
            addShiftRow(); // Add one empty shift
            document.getElementById('scheduleStatus').value = 'scheduled';
            document.getElementById('scheduleNotes').value = '';
        }
    }

    document.getElementById('saveAsPattern').checked = false;
    
    // ✅ Check for warnings (closed days, holidays)
    checkModalWarnings(empId, dateStr);

    document.getElementById('scheduleModal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('scheduleModal').classList.add('hidden');
    editingEmpId = null;
    editingDate = null;
    editingSourceCenter = null;
}

// ✅ Check for closed days and holidays
function checkModalWarnings(empId, dateStr) {
    const warningsDiv = document.getElementById('modalWarnings');
    if (!warningsDiv) return;
    warningsDiv.innerHTML = '';

    const dateObj = parseDate(dateStr);
    const dow = dateObj.getDay();

    // Check holidays across all centers
    const holidayInfo = getHolidayForDate(dateStr);
    if (holidayInfo && !holidayInfo.muc) {
        warningsDiv.innerHTML += `<div class="warning-box">
            ⚠️ ${holidayInfo.type === 'public' ? 'Public Holiday' : 'Center Holiday'}: ${holidayInfo.name || ''}. 
            You can still save, but it will be flagged.
        </div>`;
    }

    // Check if any selected center is closed on this day
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

// ✅ Re-check warnings when center changes
document.addEventListener('change', (e) => {
    if (e.target.classList.contains('shift-center') && editingEmpId && editingDate) {
        checkModalWarnings(editingEmpId, editingDate);
    }
});

async function saveSchedule() {
    if (!editingEmpId || !editingDate) return;

    const status = document.getElementById('scheduleStatus').value;
    const notes = document.getElementById('scheduleNotes').value.trim();

    // Collect all shifts
    const shiftItems = document.querySelectorAll('#shiftsContainer .shift-item');
    const shifts = [];
    
    shiftItems.forEach(item => {
        const type = item.querySelector('.shift-type').value;
        const start = item.querySelector('.shift-start').value;
        const end = item.querySelector('.shift-end').value;
        const center = type === 'work' ? item.querySelector('.shift-center').value : null;
        
        if (start && end) {
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

    // ✅ Validate
    const errors = validateSchedule(data, editingDate);
    if (errors.length > 0) {
        document.getElementById('modalWarnings').innerHTML = 
            errors.map(e => `<div class="error-box">❌ ${e}</div>`).join('');
        return;
    }

    // ✅ Determine target center (first work shift's center)
    let targetCenter = null;
    const workShifts = shifts.filter(s => s.type === 'work' && s.center);
    if (workShifts.length > 0) {
        targetCenter = workShifts[0].center;
    }
    
    if (!targetCenter || targetCenter === '__other__') {
        targetCenter = editingSourceCenter;
    }
    
    if (!targetCenter) {
        const realCenters = allCenters.filter(c => c.id !== '__other__');
        if (realCenters.length > 0) {
            targetCenter = realCenters[0].id;
        } else {
            alert('❌ No centers available to save schedule.');
            return;
        }
    }

    // Check overlaps
    const overlapError = await checkOverlaps(editingEmpId, editingDate, data, targetCenter);
    if (overlapError) {
        document.getElementById('modalWarnings').innerHTML = 
            `<div class="error-box">❌ ${overlapError}</div>`;
        return;
    }

    try {
        // Delete old record if center changed
        if (editingSourceCenter && editingSourceCenter !== targetCenter) {
            await remove(ref(db, `schedules/${editingSourceCenter}/${editingEmpId}/${editingDate}`));
        }

        // Save to target center
        await set(ref(db, `schedules/${targetCenter}/${editingEmpId}/${editingDate}`), data);

        // ✅ Save as pattern if checked
        if (document.getElementById('saveAsPattern').checked) {
            const dateObj = parseDate(editingDate);
            const dow = dateObj.getDay();
            const templateData = { 
                status, 
                shifts, 
                notes
            };
            await set(ref(db, `scheduleTemplates/${editingEmpId}/${dow}`), templateData);
        }

        // Reload data
        await loadAllSchedules();
        if (document.getElementById('saveAsPattern').checked) {
            await loadAllTemplates();
        }

        closeModal();
        renderAdminView();
        renderEmployeeView();
    } catch (err) {
        console.error('Save error:', err);
        alert('Failed to save schedule. Check console.');
    }
}

async function clearDay() {
    if (!editingEmpId || !editingDate) return;
    if (!confirm('Clear the schedule for this day across ALL centers?')) return;

    try {
        for (const center of allCenters) {
            if (center.id === '__other__') continue;
            await remove(ref(db, `schedules/${center.id}/${editingEmpId}/${editingDate}`));
        }

        await loadAllSchedules();
        closeModal();
        renderAdminView();
        renderEmployeeView();
    } catch (err) {
        console.error('Clear error:', err);
        alert('Failed to clear.');
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

    // Validate each shift
    data.shifts.forEach((shift, idx) => {
        const start = timeToMin(shift.start);
        const end = timeToMin(shift.end);

        if (start !== null && end !== null && start >= end) {
            errors.push(`Shift ${idx + 1}: start must be before end.`);
        }

        // ✅ Check if center is closed on this day
        if (shift.type === 'work' && shift.center) {
            if (isCenterClosedOnDay(shift.center, dow)) {
                const centerName = allCenters.find(c => c.id === shift.center)?.name || shift.center;
                errors.push(`Shift ${idx + 1}: ${centerName} is closed on ${DAY_NAMES[dow]}s.`);
            }
        }
    });

    // Check for overlapping shifts
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
        if (center.id === '__other__' || center.id === currentCenter) continue;

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

    const midDate = addDays(viewStartDate, 10);
    const year = midDate.getFullYear();
    const month = midDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = `${MONTH_NAMES[month]} ${year}`;

    if (!confirm(`Apply recurring patterns to all of ${monthName}?\n\nThis will fill in schedules for days that don't have overrides.`)) {
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

                if (mergedSchedules[empId]?.[dateStr]) {
                    skipped++;
                    continue;
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

                // Determine target center from first work shift
                let targetCenter = null;
                const workShifts = schedData.shifts.filter(s => s.type === 'work' && s.center);
                if (workShifts.length > 0) {
                    targetCenter = workShifts[0].center;
                }

                if (!targetCenter || targetCenter === '__other__') {
                    const realCenters = allCenters.filter(c => c.id !== '__other__');
                    if (realCenters.length > 0) targetCenter = realCenters[0].id;
                }

                if (targetCenter) {
                    await set(ref(db, `schedules/${targetCenter}/${empId}/${dateStr}`), schedData);
                    count++;
                }
            }
        }

        await loadAllSchedules();
        alert(`✅ Applied patterns: ${count} entries created, ${skipped} skipped.`);
        renderAdminView();
        renderEmployeeView();
    } catch (err) {
        console.error('Apply pattern error:', err);
        alert('❌ Error applying patterns.');
    }
}

// ============================================
// ✅ NEW: PER CENTER VIEW
// ============================================
function setupCenterNav() {
    // Populate center dropdown (exclude "Other Centers")
    const dropdown = document.getElementById('centerDropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';
    allCenters.filter(c => c.id !== '__other__').forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        dropdown.appendChild(opt);
    });
    // Default to first center
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
    const str = `${first.getDate()} ${MONTH_NAMES[first.getMonth()].substring(0,3)} — ${last.getDate()} ${MONTH_NAMES[last.getMonth()].substring(0,3)} ${last.getFullYear()}`;
    const el = document.getElementById(elementId);
    if (el) el.textContent = str;
}

function renderCenterHeader(dates) {
    const row = document.getElementById('centerHeaderRow');
    if (!row) return;
    row.innerHTML = '<th class="employee-header">Employee</th>';

    const today = new Date();
    today.setHours(0,0,0,0);
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

function renderCenterBody(dates) {
    const tbody = document.getElementById('centerBody');
    const emptyState = document.getElementById('centerEmptyState');
    const tableWrapper = document.getElementById('centerTableWrapper');
    if (!tbody) return;

    const sorted = getSortedEmployees();
    const employeesWithShifts = [];

    // Filter employees who have at least one shift at this center in this period
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

            const hasCenterShift = currentShifts.some(s => s.center === selectedCenterForView);
            const isStatusHere = currentStatus !== 'scheduled' && sourceCenter === selectedCenterForView;
            
            if (hasCenterShift || isStatusHere) {
                hasShiftHere = true;
                break;
            }
        }
        if (hasShiftHere) {
            employeesWithShifts.push(emp);
        }
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
    today.setHours(0,0,0,0);

    let lastTerms = null;
    const dailyCounts = {};
    dates.forEach(d => dailyCounts[d] = 0);

    employeesWithShifts.forEach(emp => {
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
            <span class="emp-role">${emp.position || ''}</span>
        </td>`;

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

            if (shifts.length > 0 || status !== 'scheduled') {
                const centerShifts = shifts.filter(s => s.center === selectedCenterForView);
                
                if (status !== 'scheduled') {
                    renderStatusCell(td, status, notes);
                    if (isTemplate) td.style.opacity = '0.5';
                } else if (centerShifts.length > 0) {
                    hasShiftToday = true;
                    renderCenterShiftCell(td, centerShifts, isHoliday, event);
                    if (isTemplate) td.style.opacity = '0.5';
                } else if (isClosed) {
                    td.classList.add('is-closed');
                    td.innerHTML = `<div class="cell-content"><span class="status-label">Closed</span></div>`;
                } else if (isHoliday) {
                    td.classList.add('is-holiday');
                    td.innerHTML = `<div class="cell-content"><span class="status-label"> ${event.name || 'Holiday'}</span></div>`;
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

            if (hasShiftToday) dailyCounts[dateStr]++;

            td.addEventListener('click', () => openEditModal(emp.uid, dateStr));
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    // Summary row
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
        'leave': { cls: 'status-leave', label: '🏖 Leave' },
        'sick': { cls: 'status-sick', label: '🤒 Sick' },
        'off': { cls: 'status-off', label: '😴 Off' }
    };
    const s = statusMap[status] || { cls: '', label: status };
    td.classList.add(s.cls);
    let html = `<div class="cell-content"><span class="status-label">${s.label}</span>`;
    if (notes) html += `<div class="notes-indicator">📝</div>`;
    html += '</div>';
    td.innerHTML = html;
}

function renderCenterShiftCell(td, shifts, isHoliday, event) {
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

    // ✅ UPDATED: Show holiday indicator with same formatting as Admin/Employee view
    if (isHoliday && event && !event.muc) {
        html += `<div class="holiday-indicator">🎌 ${event.name || 'Holiday'}</div>`;
    }

    html += '</div>';
    td.innerHTML = html;
}
// ============================================
// ✅ NEW: PRINT FUNCTIONALITY
// ============================================
function printCenterSchedule() {
    if (!selectedCenterForView) {
        alert('Please select a center first.');
        return;
    }
    const centerObj = allCenters.find(c => c.id === selectedCenterForView);
    const centerNamePrint = centerObj ? centerObj.name : 'Center';
    const dates = get14Days(centerViewDate);
    const firstDate = parseDate(dates[0]);
    const lastDate = parseDate(dates[dates.length - 1]);
    const dateRangeStr = `${firstDate.getDate()} ${MONTH_NAMES[firstDate.getMonth()]} — ${lastDate.getDate()} ${MONTH_NAMES[lastDate.getMonth()]} ${lastDate.getFullYear()}`;

    const today = new Date();
    today.setHours(0,0,0,0);
    const centerCalEvents = calendarEvents[selectedCenterForView] || {};
    const closedDays = getClosedDaysForCenter(centerNamePrint);

    // ✅ FIX: Get employees with shifts at this center (including templates)
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

            const hasCenterShift = currentShifts.some(s => s.center === selectedCenterForView);
            const isStatusHere = currentStatus !== 'scheduled' && sourceCenter === selectedCenterForView;
            
            if (hasCenterShift || isStatusHere) {
                hasShift = true;
                break;
            }
        }
        if (hasShift) employeesWithShifts.push(emp);
    });

    // Build print HTML
    let html = `
    <div class="print-header">
        <h1>${centerNamePrint} — Employee Schedule</h1>
        <p class="print-subtitle">Kumon Learning Center</p>
        <p class="print-date-range">${dateRangeStr}</p>
    </div>

    <div class="print-table-wrapper">
        <table class="print-schedule-table">
            <thead>
                <tr>
                    <th class="employee-col">Employee</th>`;

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

    let lastTerms = null;
    const dailyCounts = {};
    dates.forEach(d => dailyCounts[d] = 0);

    employeesWithShifts.forEach(emp => {
        if (lastTerms !== null && emp.terms !== lastTerms) {
            html += `<tr class="section-row"><td colspan="${dates.length + 1}">— Part-Time Employees —</td></tr>`;
        }
        lastTerms = emp.terms;

        const termsCls = emp.terms === 'Full-time' ? 'ft' : 'pt';
        const termsLbl = emp.terms === 'Full-time' ? 'FT' : 'PT';

        html += `<tr>
            <td class="employee-col">
                ${emp.englishName || 'Unknown'}
                <span class="terms-tag ${termsCls}">${termsLbl}</span>
                <span class="role-tag">${emp.position || ''}</span>
            </td>`;

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

            // ✅ FIX: Check both schedules and templates for print
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

            if (shifts.length > 0 || status !== 'scheduled') {
                const centerShifts = shifts.filter(s => s.center === selectedCenterForView);
                
                if (status !== 'scheduled') {
                    const statusLabels = { 'other-center': '📍 Other', 'leave': '🏖 Leave', 'sick': '🤒 Sick', 'off': '😴 Off' };
                    const statusCls = status === 'leave' ? 'leave' : status === 'sick' ? 'sick' : status === 'off' ? 'off' : 'other';
                    cellContent = `<span class="print-status ${statusCls}">${statusLabels[status] || status}</span>`;
                } else if (centerShifts.length > 0) {
                    dailyCounts[dateStr]++;
                    const sortedShifts = [...centerShifts].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
                    sortedShifts.forEach(s => {
                        if (s.type === 'break') {
                            cellContent += `<div class="print-shift break-shift">☕ ${s.start}-${s.end}</div>`;
                        } else {
                            cellContent += `<div class="print-shift"><span class="time">${s.start}-${s.end}</span></div>`;
                        }
                    });
                    // Optional: indicate it's a pattern in print
                    if (isTemplate) {
                        cellContent += `<div style="font-size:5pt;color:#888;font-style:italic;">(Pattern)</div>`;
                    }
                } else if (isClosed) {
                    cellContent = '<span style="color:#999;font-size:6pt;">Closed</span>';
                } else if (isHoliday) {
                    cellContent = `<span style="color:#e74c3c;font-size:6pt;">🎌 ${event.name || ''}</span>`;
                } else {
                    cellCls += ' empty-cell';
                    cellContent = '—';
                }
            } else {
                if (isClosed) cellContent = '<span style="color:#999;font-size:6pt;">Closed</span>';
                else if (isHoliday) cellContent = `<span style="color:#e74c3c;font-size:6pt;">🎌 ${event.name || ''}</span>`;
                else { cellCls += ' empty-cell'; cellContent = '—'; }
            }

            html += `<td class="${cellCls}">${cellContent}</td>`;
        });
        html += '</tr>';
    });

    html += `<tr class="summary-row"><td>Staff Count</td>`;
    dates.forEach((d, idx) => {
        const sep = idx === 7 ? ' week-sep' : '';
        html += `<td class="${sep}">${dailyCounts[d]}</td>`;
    });
    html += '</tr></tbody></table></div>';

    html += `
        <div class="print-legend">
            <div class="print-legend-item"><span class="print-legend-color" style="background:#3498db;"></span> MK</div>
            <div class="print-legend-item"><span class="print-legend-color" style="background:#9b59b6;"></span> PT</div>
            <div class="print-legend-item"><span class="print-legend-color" style="background:#e67e22;"></span> TS</div>
            <div class="print-legend-item"><span class="print-legend-color" style="background:#27ae60;"></span> C</div>
            <div class="print-legend-item"><span class="print-legend-color" style="background:#e74c3c;"></span> Holiday</div>
            <div class="print-legend-item"><span class="print-legend-color" style="background:#f3f4f6;"></span> Closed</div>
        </div>
        <div class="print-footer">
            Printed: ${new Date().toLocaleString()} | Kumon DB Employee Schedule System
        </div>`;

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
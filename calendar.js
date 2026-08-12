// calendar.js
import { auth, requireAuth, logout, db } from './auth.js';
import {
  ref,
  get,
  set,
  update,
  remove,
  onValue
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t } from './calendar-i18n.js';

// Wait for i18n before first render
await i18nReady.catch(() => {});

// ============================================
// GLOBAL STATE
// ============================================
let currentCenterId = sessionStorage.getItem('selectedCenter') || '';
let centerName = "";
let calendarEventsMap = {};
let currentCalendarYear = new Date().getFullYear();
let currentScheduleYear = new Date().getFullYear();
let currentHolidayYear = new Date().getFullYear();
let canEditHolidays = false;
let accessibleCenters = [];
let calendarListener = null;
let pendingHoliday = null;
let deleteState = null;
let bootstrapped = false;

const centerClosedDays = {
  'mei keng': [0],
  'pac tat': [0, 6],
  'champs': [0],
  'tap siac': [2]
};

// ✅ Translated date names (read live so language switches apply)
function getMonthNames() { return t('calendar.months', { returnObjects: true }); }
function getDayNamesShort() { return t('calendar.daysShort', { returnObjects: true }); }
function getDayNamesLong() { return t('calendar.daysLong', { returnObjects: true }); }

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  const loader = document.getElementById('page-loader');
  const logoutBtn = document.getElementById('logoutBtn');

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        logoutBtn.disabled = true;
        logoutBtn.textContent = t('calendar.loggingOut');
        await logout();
        window.location.href = 'index.html';
      } catch (err) {
        console.error('Logout error:', err);
        window.location.href = 'index.html';
      }
    });
  }

  const isAuth = requireAuth();
  if (!isAuth) {
    loader?.classList.add('hidden');
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'index.html';
      return;
    }
    if (bootstrapped) return;
    bootstrapped = true;

    try {
      await initCalendar(user);
    } catch (error) {
      console.error('Error initializing calendar management:', error);
      alert(t('calendar.failedLoad'));
    } finally {
      loader?.classList.add('hidden');
    }
  });
});

async function initCalendar(user) {
  await initializeCalendarAccess(user);

  if (!canEditHolidays) {
    alert(t('calendar.onlyManagers'));
    window.location.href = 'centers.html';
    return;
  }

  if (accessibleCenters.length === 0) {
    alert(t('calendar.noActiveCenters'));
    window.location.href = 'centers.html';
    return;
  }

  if (!currentCenterId || !accessibleCenters.some(c => c.id === currentCenterId)) {
    currentCenterId = accessibleCenters[0].id;
  }

  sessionStorage.setItem('selectedCenter', currentCenterId);

  populateCenterSelect();
  setupCenterSelect();
  setupTabs();
  setupHolidayForm();
  setupHolidayYearControls();
  setupYearControls();
  setupPrintButtons();
  setupHolidayDeleteListener();
  setupConflictModal();
  setupDeleteModal();
  await loadCenterDetails();
  renderHolidayCenterTargets();

  document.getElementById('calendarYearDisplay').textContent = currentCalendarYear;
  document.getElementById('scheduleYearDisplay').textContent = currentScheduleYear;
  document.getElementById('holidayYearDisplay').textContent = currentHolidayYear;

  subscribeCalendar();
}

// ============================================
// ACCESS / PERMISSIONS
// ============================================
async function initializeCalendarAccess(user) {
  const email = user.email?.toLowerCase() || '';
  const userSnap = await get(ref(db, `users/${user.uid}`));
  const userData = userSnap.exists() ? userSnap.val() : {};
  const employeeData = await getEmployeeData(user, email);

  const isKumonChamps = email === 'kumonchamps@gmail.com';
  const positions = [
    ...getEmpPositions(userData),
    ...getEmpPositions(employeeData)
  ].map(normalizeText);

  const hasAdminPosition =
    positions.includes('admin') ||
    positions.includes('administrator') ||
    positions.includes('master admin');
  const hasManagerPosition = positions.includes('manager');

  canEditHolidays = isKumonChamps || hasAdminPosition || hasManagerPosition;
  if (!canEditHolidays) return;

  const centersSnap = await get(ref(db, 'centers'));
  const allCenters = centersSnap.exists() ? centersSnap.val() : {};

  const activeCenters = Object.entries(allCenters)
    .filter(([centerId, centerData]) => isCenterActive(centerData))
    .map(([centerId, centerData]) => ({
      id: centerId,
      name: centerData.name || centerData.centerName || centerId
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // KumonChamps / Admins see all active centers
  if (isKumonChamps || hasAdminPosition) {
    accessibleCenters = activeCenters;
    return;
  }

  // Managers see centers listed in their employee/profile assignment
  const assignedCenterValues = extractAssignedCenterIds(employeeData, userData);
  const assignedNormalized = new Set(
    [...assignedCenterValues].map(value => normalizeText(value))
  );

  accessibleCenters = activeCenters.filter(center => {
    return (
      assignedCenterValues.has(center.id) ||
      assignedNormalized.has(normalizeText(center.name))
    );
  });

  // Optional fallback:
  // If employee profile field is missing/empty, use users/{uid}/permissions/centers
  if (accessibleCenters.length === 0) {
    const permissionCenters = userData?.permissions?.centers || {};
    accessibleCenters = activeCenters.filter(center => permissionCenters[center.id] === true);
  }
}

async function getEmployeeData(user, email) {
  try {
    const employeeSnap = await get(ref(db, `employees/${user.uid}`));
    if (employeeSnap.exists()) {
      return employeeSnap.val();
    }
    if (email) {
      const allEmployeesSnap = await get(ref(db, 'employees'));
      if (allEmployeesSnap.exists()) {
        const allEmployees = allEmployeesSnap.val();
        const matchingEmp = Object.values(allEmployees).find(emp => {
          return normalizeText(emp?.email) === email;
        });
        if (matchingEmp) {
          return matchingEmp;
        }
      }
    }
  } catch (err) {
    console.error('Error loading employee profile:', err);
  }
  return null;
}

function getEmpPositions(obj) {
  if (!obj) return [];
  if (Array.isArray(obj.positions)) {
    return obj.positions.filter(Boolean);
  }
  if (typeof obj.positions === 'string' && obj.positions.trim()) {
    return [obj.positions];
  }
  if (obj.position) {
    return [obj.position];
  }
  return [];
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isCenterActive(centerData = {}) {
  if (
    centerData.active === false ||
    centerData.isActive === false ||
    centerData.inactive === true ||
    centerData.isInactive === true ||
    centerData.disabled === true
  ) {
    return false;
  }
  const status = normalizeText(centerData.status || '');
  if (
    status === 'inactive' ||
    status === 'closed' ||
    status === 'disabled'
  ) {
    return false;
  }
  return true;
}

function extractAssignedCenterIds(employeeData, userData) {
  const assigned = new Set();
  const sources = [
    employeeData,
    userData?.profile,
    userData
  ];
  const fields = [
    'assignedCenters',
    'centers',
    'managedCenters',
    'centerIds',
    'assignedCenterIds',
    'centerAssignments',
    'centerAccess',
    'centerPermissions'
  ];

  sources.forEach(source => {
    if (!source || typeof source !== 'object') return;
    fields.forEach(field => {
      if (source[field]) {
        collectCenterIds(source[field], assigned, true);
      }
    });
    // Also support existing permission structure as fallback
    if (source.permissions?.centers) {
      collectCenterIds(source.permissions.centers, assigned, true);
    }
  });

  [...assigned].forEach(value => {
    if (!value || !String(value).trim()) {
      assigned.delete(value);
    }
  });

  return assigned;
}

function collectCenterIds(value, set, treatObjectKeysAsIds = false) {
  if (value === null || value === undefined) return;

  if (typeof value === 'string' || typeof value === 'number') {
    set.add(String(value).trim());
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectCenterIds(item, set, true));
    return;
  }

  if (typeof value === 'object') {
    if (treatObjectKeysAsIds) {
      Object.entries(value).forEach(([key, val]) => {
        if (val === false || val === null || val === undefined) return;
        set.add(key);
        if (typeof val === 'string' || typeof val === 'number') {
          set.add(String(val).trim());
        } else if (typeof val === 'object') {
          collectCenterIds(val, set, false);
        }
      });
    }
    const idFields = [
      'centerId',
      'center_id',
      'id',
      'center',
      'centerID'
    ];
    idFields.forEach(field => {
      if (value[field]) {
        collectCenterIds(value[field], set, false);
      }
    });
  }
}

// ============================================
// CENTER DROPDOWN
// ============================================
function populateCenterSelect() {
  const select = document.getElementById('centerSelect');
  if (!select) return;
  select.innerHTML = '';
  accessibleCenters.forEach(center => {
    const option = document.createElement('option');
    option.value = center.id;
    option.textContent = center.name;
    select.appendChild(option);
  });
  select.value = currentCenterId;
}

function setupCenterSelect() {
  const select = document.getElementById('centerSelect');
  if (!select) return;
  select.addEventListener('change', async (e) => {
    currentCenterId = e.target.value;
    sessionStorage.setItem('selectedCenter', currentCenterId);
    await loadCenterDetails();
    renderHolidayCenterTargets();
    subscribeCalendar();
  });
}

async function loadCenterDetails() {
  const snap = await get(ref(db, `centers/${currentCenterId}`));
  if (snap.exists()) {
    const data = snap.val();
    centerName = data.name || data.centerName || "Center";
    const titleEl = document.getElementById('calendar-center-name');
    if (titleEl) {
      titleEl.textContent = `${centerName} Calendar`;
    }
  }
}

// ============================================
// FIREBASE LISTENER
// ============================================
function subscribeCalendar() {
  if (calendarListener) {
    calendarListener();
  }
  calendarEventsMap = {};
  renderAllCalendarViews();

  calendarListener = onValue(
    ref(db, `centers/${currentCenterId}/calendar`),
    snapshot => {
      calendarEventsMap = snapshot.exists() ? snapshot.val() : {};
      renderAllCalendarViews();
    }
  );
}

function renderAllCalendarViews() {
  renderYearCalendar(currentCalendarYear);
  renderClassSchedule(currentScheduleYear);
  renderHolidaysTable();
}

// ============================================
// TAB SWITCHING
// ============================================
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(`tab-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });
}

// ============================================
// HOLIDAYS CRUD
// ============================================
function setupHolidayForm() {
  const form = document.getElementById('holidayForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!canEditHolidays) {
      alert(t('calendar.noPermissionAdd'));
      return;
    }

    const date = document.getElementById('holidayDate').value;
    const type = document.getElementById('holidayType').value;
    const name = document.getElementById('holidayName').value.trim();
    const muc = document.getElementById('holidayMUC').value === 'true';

    if (!date || !name) {
      alert(t('calendar.enterDateAndName'));
      return;
    }

    const targetCenterIds = getSelectedHolidayCenterIds();
    if (targetCenterIds.length === 0) {
      alert(t('calendar.selectAtLeastOne'));
      return;
    }

    const holidayData = {
      date,
      type,
      name,
      muc
    };

    const conflicts = await checkHolidayConflicts(targetCenterIds, date);
    if (conflicts.length > 0) {
      openConflictModal(conflicts, targetCenterIds, holidayData);
    } else {
      await writeHolidaysToCenters(targetCenterIds, holidayData);
    }
  });

  const dateInput = document.getElementById('holidayDate');
  if (dateInput) {
    dateInput.valueAsDate = new Date();
  }
}

function getSelectedHolidayCenterIds() {
  const container = document.getElementById('holidayCenterTargets');
  if (!container) return [currentCenterId];

  const checked = Array.from(
    container.querySelectorAll('input[type="checkbox"]:checked')
  ).map(cb => cb.value);

  if (!checked.includes(currentCenterId)) {
    checked.unshift(currentCenterId);
  }

  return [...new Set(checked)];
}

function renderHolidayCenterTargets() {
  const container = document.getElementById('holidayCenterTargets');
  if (!container) return;
  container.innerHTML = '';

  if (accessibleCenters.length <= 1) {
    container.innerHTML = `<p style="margin:0; color:#666;">${t('calendar.currentCenterOnly')}</p>`;
    return;
  }

  accessibleCenters.forEach(center => {
    const label = document.createElement('label');
    label.className = 'center-target-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = center.id;
    if (center.id === currentCenterId) {
      checkbox.checked = true;
      checkbox.disabled = true;
    }

    const text = document.createElement('span');
    text.textContent = center.id === currentCenterId
      ? t('calendar.currentSelection', { name: center.name })
      : center.name;

    label.appendChild(checkbox);
    label.appendChild(text);
    container.appendChild(label);
  });
}

async function checkHolidayConflicts(centerIds, date) {
  const results = await Promise.all(
    centerIds.map(async centerId => {
      const snap = await get(ref(db, `centers/${centerId}/calendar/${date}`));
      if (!snap.exists()) return null;
      const existing = snap.val();
      if (existing && existing.type && existing.type !== 'none') {
        const center = accessibleCenters.find(c => c.id === centerId);
        return {
          centerId,
          centerName: center?.name || centerId,
          existing
        };
      }
      return null;
    })
  );
  return results.filter(Boolean);
}

function setupConflictModal() {
  const modal = document.getElementById('holidayConflictModal');
  if (!modal) return;

  const cancelBtn = document.getElementById('cancelHolidayConflictBtn');
  const confirmBtn = document.getElementById('confirmHolidayConflictBtn');

  cancelBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
    pendingHoliday = null;
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      pendingHoliday = null;
    }
  });

  confirmBtn?.addEventListener('click', async () => {
    if (!pendingHoliday) return;

    const overwriteIds = [];
    pendingHoliday.conflicts.forEach((conflict, index) => {
      const selected = document.querySelector(
        `input[name="conflictAction-${index}"]:checked`
      );
      if (selected?.value === 'overwrite') {
        overwriteIds.push(conflict.centerId);
      }
    });

    const skipIds = pendingHoliday.conflicts
      .map(conflict => conflict.centerId)
      .filter(centerId => !overwriteIds.includes(centerId));

    const finalTargetIds = pendingHoliday.targetIds.filter(
      centerId => !skipIds.includes(centerId)
    );

    await writeHolidaysToCenters(finalTargetIds, pendingHoliday.holidayData);
    modal.classList.add('hidden');
    pendingHoliday = null;
  });
}

function openConflictModal(conflicts, targetIds, holidayData) {
  pendingHoliday = {
    conflicts,
    targetIds,
    holidayData
  };

  const modal = document.getElementById('holidayConflictModal');
  const summary = document.getElementById('holidayConflictSummary');
  const list = document.getElementById('holidayConflictList');
  if (!modal || !summary || !list) return;

  const nonConflictCount = targetIds.length - conflicts.length;
  summary.textContent = t('calendar.conflictSummary', {
    conflicts: conflicts.length,
    date: holidayData.date,
    noConflict: nonConflictCount
  });

  list.innerHTML = '';
  conflicts.forEach((conflict, index) => {
    const item = document.createElement('div');
    item.className = 'conflict-item';

    const existingType = conflict.existing.type === 'public'
      ? t('calendar.publicHoliday')
      : t('calendar.centerHoliday');

    item.innerHTML = `
      <div class="conflict-title">${escapeHtml(conflict.centerName)}</div>
      <div class="conflict-existing">
        ${t('calendar.existing')}: ${escapeHtml(conflict.existing.name || t('calendar.holiday'))}
        (${existingType})
      </div>
      <label>
        <input
          type="radio"
          name="conflictAction-${index}"
          value="skip"
          checked
        >
        ${t('calendar.skipThisCenter')}
      </label>
      <label>
        <input
          type="radio"
          name="conflictAction-${index}"
          value="overwrite"
        >
        ${t('calendar.overwriteExisting')}
      </label>
    `;
    list.appendChild(item);
  });

  modal.classList.remove('hidden');
}

async function writeHolidaysToCenters(centerIds, holidayData) {
  if (!centerIds.length) {
    alert(t('calendar.noCentersUpdated'));
    return false;
  }

  try {
    const sharedHolidayId =
      crypto?.randomUUID?.() ||
      `holiday-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timestamp = new Date().toISOString();

    const updates = {};
    centerIds.forEach(centerId => {
      updates[`centers/${centerId}/calendar/${holidayData.date}`] = {
        type: holidayData.type,
        name: holidayData.name,
        muc: !!holidayData.muc,
        sharedHolidayId,
        updatedAt: timestamp
      };
    });

    await update(ref(db), updates);

    // Jump the holiday list to the year of the holiday just added
    currentHolidayYear = parseInt(holidayData.date.slice(0, 4), 10);
    const holidayYearEl = document.getElementById('holidayYearDisplay');
    if (holidayYearEl) holidayYearEl.textContent = currentHolidayYear;

    const form = document.getElementById('holidayForm');
    if (form) {
      form.reset();
    }
    const dateInput = document.getElementById('holidayDate');
    if (dateInput) {
      dateInput.valueAsDate = new Date();
    }

    renderHolidayCenterTargets();
    alert(t('calendar.holidaySaved', { count: centerIds.length }));
    return true;
  } catch (error) {
    console.error('Error saving holiday:', error);
    alert(t('calendar.failedSave'));
    return false;
  }
}

function renderHolidaysTable() {
  const tbody = document.getElementById('holidayTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const events = Object.entries(calendarEventsMap)
    .map(([key, val]) => {
      const isDateKey = /^\d{4}-\d{2}-\d{2}$/.test(key);
      return {
        id: key,
        ...val,
        date: isDateKey ? key : val?.date
      };
    })
    .filter(event => event.date && event.type && event.type !== 'none')
    .filter(event => event.date.startsWith(String(currentHolidayYear)))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (events.length === 0) {
    tbody.innerHTML = `<tr>
      <td colspan="5" style="text-align:center; color:#666;">
        ${t('calendar.noHolidays', { year: currentHolidayYear })}
      </td>
    </tr>`;
    return;
  }

  events.forEach(event => {
    const tr = document.createElement('tr');

    const mucDisplay = event.muc
      ? `<span class="muc-yes">${t('calendar.yes')}</span>`
      : `<span class="muc-no">${t('calendar.no')}</span>`;

    const typeDisplay = event.type === 'public'
      ? t('calendar.publicHoliday')
      : t('calendar.centerHoliday');

    const actionCell = canEditHolidays
      ? `
        <button
          class="btn-danger delete-holiday-btn"
          data-date="${escapeHtml(event.date)}"
          data-shared="${escapeHtml(event.sharedHolidayId || '')}"
          type="button"
        >
          <i class="fas fa-trash"></i> ${t('calendar.delete')}
        </button>
      `
      : `<span style="color:#999; font-size:0.85rem;">${t('calendar.restricted')}</span>`;

    tr.innerHTML = `
      <td>${escapeHtml(event.date)}</td>
      <td>${typeDisplay}</td>
      <td>${escapeHtml(event.name || '-')}</td>
      <td>${mucDisplay}</td>
      <td class="action-cell">${actionCell}</td>
    `;
    tbody.appendChild(tr);
  });
}

function setupHolidayDeleteListener() {
  const tbody = document.getElementById('holidayTableBody');
  if (!tbody) return;

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.delete-holiday-btn');
    if (!btn) return;
    await openDeleteHolidayModal(btn.dataset.date, btn.dataset.shared);
  });
}

function setupDeleteModal() {
  const modal = document.getElementById('deleteHolidayModal');
  if (!modal) return;

  const cancelBtn = document.getElementById('cancelDeleteHolidayBtn');
  const confirmBtn = document.getElementById('confirmDeleteHolidayBtn');

  cancelBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
    deleteState = null;
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      deleteState = null;
    }
  });

  confirmBtn?.addEventListener('click', async () => {
    if (!deleteState) return;

    const mode = document.querySelector(
      'input[name="deleteHolidayMode"]:checked'
    )?.value || 'current';

    confirmBtn.disabled = true;
    confirmBtn.textContent = t('calendar.deleting');

    try {
      if (mode === 'current') {
        await remove(
          ref(db, `centers/${currentCenterId}/calendar/${deleteState.date}`)
        );
        alert(t('calendar.deletedCurrent'));
      } else {
        const deletedCount = await deleteHolidayFromAllCenters(deleteState);
        alert(t('calendar.deletedCount', { count: deletedCount }));
      }

      modal.classList.add('hidden');
      deleteState = null;
    } catch (error) {
      console.error('Error deleting holiday:', error);
      alert(t('calendar.failedDelete'));
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = t('calendar.delete');
    }
  });
}

async function openDeleteHolidayModal(date, sharedId) {
  const modal = document.getElementById('deleteHolidayModal');
  if (!modal) return;

  let event = calendarEventsMap[date];
  if (!event) {
    const snap = await get(
      ref(db, `centers/${currentCenterId}/calendar/${date}`)
    );
    event = snap.exists() ? snap.val() : null;
  }

  deleteState = {
    date,
    sharedId: sharedId || event?.sharedHolidayId || '',
    event
  };

  document.getElementById('deleteHolidayDate').textContent = date;
  document.getElementById('deleteHolidayName').textContent =
    event?.name || t('calendar.holiday');

  const currentRadio = document.getElementById('deleteCurrentCenter');
  if (currentRadio) {
    currentRadio.checked = true;
  }

  modal.classList.remove('hidden');
}

async function deleteHolidayFromAllCenters({ date, sharedId, event }) {
  const updates = {};
  const centerIds = accessibleCenters.map(center => center.id);

  await Promise.all(
    centerIds.map(async centerId => {
      const snap = await get(
        ref(db, `centers/${centerId}/calendar/${date}`)
      );
      if (!snap.exists()) return;

      const targetEvent = snap.val() || {};
      let shouldDelete = false;

      if (sharedId && targetEvent.sharedHolidayId === sharedId) {
        shouldDelete = true;
      }
      if (
        !sharedId &&
        event &&
        targetEvent.name === event.name &&
        targetEvent.type === event.type
      ) {
        shouldDelete = true;
      }

      if (shouldDelete) {
        updates[`centers/${centerId}/calendar/${date}`] = null;
      }
    })
  );

  const deletedCount = Object.keys(updates).length;
  if (deletedCount > 0) {
    await update(ref(db), updates);
  }
  return deletedCount;
}

// ============================================
// YEAR CONTROLS
// ============================================
function setupYearControls() {
  document.getElementById('prevYearBtn')?.addEventListener('click', () => {
    currentCalendarYear--;
    document.getElementById('calendarYearDisplay').textContent = currentCalendarYear;
    renderYearCalendar(currentCalendarYear);
  });

  document.getElementById('nextYearBtn')?.addEventListener('click', () => {
    currentCalendarYear++;
    document.getElementById('calendarYearDisplay').textContent = currentCalendarYear;
    renderYearCalendar(currentCalendarYear);
  });

  document.getElementById('schedulePrevYearBtn')?.addEventListener('click', () => {
    currentScheduleYear--;
    document.getElementById('scheduleYearDisplay').textContent = currentScheduleYear;
    renderClassSchedule(currentScheduleYear);
  });

  document.getElementById('scheduleNextYearBtn')?.addEventListener('click', () => {
    currentScheduleYear++;
    document.getElementById('scheduleYearDisplay').textContent = currentScheduleYear;
    renderClassSchedule(currentScheduleYear);
  });
}

// ============================================
// HOLIDAY LIST YEAR PAGINATION
// ============================================
function setupHolidayYearControls() {
  document.getElementById('holidayPrevYearBtn')?.addEventListener('click', () => {
    currentHolidayYear--;
    document.getElementById('holidayYearDisplay').textContent = currentHolidayYear;
    renderHolidaysTable();
  });

  document.getElementById('holidayNextYearBtn')?.addEventListener('click', () => {
    currentHolidayYear++;
    document.getElementById('holidayYearDisplay').textContent = currentHolidayYear;
    renderHolidaysTable();
  });
}

// ============================================
// ANNUAL CALENDAR
// ============================================
function renderYearCalendar(year) {
  const container = document.getElementById('yearCalendarGrid');
  if (!container) return;
  container.innerHTML = '';

  const monthNames = getMonthNames();
  const dayNames = getDayNamesShort();
  const closedDays = getClosedDaysForCenter(centerName);
  const today = new Date();

  monthNames.forEach((monthName, monthIndex) => {
    const monthDiv = document.createElement('div');
    monthDiv.className = 'month-calendar';

    let gridHtml = `
      <h4>${monthName} ${year}</h4>
      <div class="mini-calendar-grid">
    `;

    dayNames.forEach(day => {
      gridHtml += `<div class="day-header">${day}</div>`;
    });

    const firstDay = new Date(year, monthIndex, 1).getDay();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
      gridHtml += `<div class="day-cell empty"></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayOfWeek = new Date(year, monthIndex, day).getDay();

      let classes = ['day-cell'];
      let tooltip = '';

      if (
        year === today.getFullYear() &&
        monthIndex === today.getMonth() &&
        day === today.getDate()
      ) {
        classes.push('today');
      }

      const isClosed = closedDays.includes(dayOfWeek);
      const event = calendarEventsMap[dateStr];

      if (event && event.type && event.type !== 'none' && !event.muc) {
        if (event.type === 'public') {
          classes.push('has-public');
          tooltip = `${t('calendar.publicHoliday')}: ${event.name || ''}`;
        } else if (event.type === 'center') {
          classes.push('has-center');
          tooltip = `${t('calendar.centerHoliday')}: ${event.name || ''}`;
        }
      }

      if (isClosed && !event) {
        classes.push('closed');
      }

      gridHtml += `<div class="${classes.join(' ')}" title="${escapeHtml(tooltip)}">${day}</div>`;
    }

    gridHtml += `</div>`;
    monthDiv.innerHTML = gridHtml;
    container.appendChild(monthDiv);
  });
}

// ============================================
// CLASS SCHEDULE
// ============================================
function renderClassSchedule(year) {
  const container = document.getElementById('classScheduleContainer');
  if (!container) return;
  container.innerHTML = '';

  const monthNames = getMonthNames();
  const dayNames = getDayNamesLong();
  const closedDays = getClosedDaysForCenter(centerName);
  const openDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !closedDays.includes(d));

  monthNames.forEach((monthName, monthIndex) => {
    const monthDiv = document.createElement('div');
    monthDiv.className = 'schedule-month';

    let bodyHtml = `
      <div class="schedule-month-header">${monthName} ${year}</div>
      <div class="schedule-month-body">
    `;

    let hasClasses = false;

    openDays.forEach(dayOfWeek => {
      const datesInMonth = [];
      const firstDayOfMonth = new Date(year, monthIndex, 1).getDay();
      const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

      let firstDate = 1 + (dayOfWeek - firstDayOfMonth + 7) % 7;
      for (let d = firstDate; d <= daysInMonth; d += 7) {
        datesInMonth.push(d);
      }

      if (datesInMonth.length > 0) {
        hasClasses = true;
        const validDates = datesInMonth.map(d => {
          const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const event = calendarEventsMap[dateStr];
          if (event && event.type && event.type !== 'none' && !event.muc) {
            return null;
          }
          return event && event.muc ? `${d}*` : `${d}`;
        }).filter(d => d !== null);

        if (validDates.length > 0) {
          bodyHtml += `
            <div class="schedule-day-group">
              <h5>${dayNames[dayOfWeek]}</h5>
              <div class="schedule-dates">
                ${validDates
                  .map(d => d.includes('*')
                    ? `<span class="muc-date">${d}</span>`
                    : d
                  )
                  .join(', ')
                }
              </div>
            </div>
          `;
        }
      }
    });

    bodyHtml += `</div>`;

    if (hasClasses) {
      monthDiv.innerHTML = bodyHtml;
      container.appendChild(monthDiv);
    }
  });

  if (container.innerHTML === '') {
    container.innerHTML = `<p style="text-align:center; color:#666; padding: 2rem;">
      ${t('calendar.noClassDays')}
    </p>`;
  }
}

// ============================================
// HELPERS
// ============================================
function getClosedDaysForCenter(name) {
  const lowerName = String(name || '').toLowerCase();
  if (lowerName.includes('mei keng')) return centerClosedDays['mei keng'];
  if (lowerName.includes('pac tat')) return centerClosedDays['pac tat'];
  if (lowerName.includes('champs')) return centerClosedDays['champs'];
  if (lowerName.includes('tap siac')) return centerClosedDays['tap siac'];
  return [0];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// PRINT FUNCTIONALITY
// ============================================
function setupPrintButtons() {
  const printHolidaysBtn = document.getElementById('printHolidaysBtn');
  if (printHolidaysBtn) {
    printHolidaysBtn.addEventListener('click', () => {
      switchTabAndPrint('holidays', t('calendar.printDocHolidayList'));
    });
  }

  const printCalendarBtn = document.getElementById('printCalendarBtn');
  if (printCalendarBtn) {
    printCalendarBtn.addEventListener('click', () => {
      switchTabAndPrint('calendar', t('calendar.printDocCalendar', { year: currentCalendarYear }));
    });
  }

  const printScheduleBtn = document.getElementById('printScheduleBtn');
  if (printScheduleBtn) {
    printScheduleBtn.addEventListener('click', () => {
      switchTabAndPrint('schedule', t('calendar.printDocSchedule', { year: currentScheduleYear }));
    });
  }
}

function switchTabAndPrint(tabId, docTitle) {
  // Step 1: Activate the correct tab
  const tabs = document.querySelectorAll('.tab-btn');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(t => t.classList.remove('active'));
  contents.forEach(c => c.classList.remove('active'));

  const targetTab = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  const targetContent = document.getElementById(`tab-${tabId}`);

  if (targetTab) targetTab.classList.add('active');
  if (targetContent) targetContent.classList.add('active');

  // Step 2: Update print header
  const printCenterName = document.getElementById('printCenterName');
  const printDocTitle = document.getElementById('printDocTitle');

  // IMPORTANT: use the GLOBAL year states here.
  // Do NOT redeclare currentHolidayYear inside this function,
  // otherwise printing ignores the ‹ › pagination year.
  let year = currentCalendarYear;
  if (tabId === 'schedule') {
    year = currentScheduleYear;
  }
  if (tabId === 'holidays') {
    year = currentHolidayYear;
  }

  // Format: "Kumon Taipa Mei Keng 2025 Calendar"
  const headerText = t('calendar.printHeaderTitle', {
    center: centerName || 'Kumon Center',
    year
  });

  if (printCenterName) {
    printCenterName.textContent = headerText;
  }

  // Hide the secondary title to keep the header clean and single-line
  if (printDocTitle) {
    printDocTitle.textContent = docTitle;
    printDocTitle.style.display = 'none';
  }

  // Step 3: Small delay to let DOM update, then trigger print
  setTimeout(() => {
    window.print();
  }, 300);
}
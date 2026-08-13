// employee-activity-log.js
import { db, logout } from './auth.js';
import {
  ref,
  get,
  query,
  orderByChild,
  limitToLast
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const auth = getAuth();

const userEmailEl = document.getElementById('userEmail');
const logoutBtn = document.getElementById('logoutBtn');
const tbody = document.getElementById('activityTableBody');
const resultCount = document.getElementById('resultCount');

const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const centerFilter = document.getElementById('centerFilter');
const employeeFilter = document.getElementById('employeeFilter');
const actionFilter = document.getElementById('actionFilter');
const searchInput = document.getElementById('searchInput');

const applyFiltersBtn = document.getElementById('applyFiltersBtn');
const clearFiltersBtn = document.getElementById('clearFiltersBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const pageLoader = document.getElementById('page-loader');

const state = {
  allLogs: [],
  filteredLogs: []
};

/* =========================================
HELPERS
========================================= */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (s) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function getStoredUserName() {
  try {
    const storedUser = sessionStorage.getItem('kumonUser');
    if (storedUser) {
      return JSON.parse(storedUser)?.name || '';
    }
  } catch (err) {
    console.error('Error parsing kumonUser from sessionStorage:', err);
  }
  return '';
}

function getEmpPositions(obj) {
  if (!obj) return [];

  if (Array.isArray(obj.positions)) {
    return obj.positions.filter(Boolean);
  }

  if (obj.position) {
    return [obj.position];
  }

  return [];
}

function hasManagementPosition(positions) {
  return (
    positions.includes('manager') ||
    positions.includes('master admin') ||
    positions.includes('admin') ||
    positions.includes('administrator')
  );
}

function formatDetails(details) {
  if (!details || typeof details !== 'object') return '';

  return Object.entries(details)
    .map(([key, value]) => {
      return `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`;
    })
    .join('; ');
}

function csvEscape(value) {
  const text = String(value ?? '');

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function getEmployeeKey(log) {
  const uid = String(log.uid || '').trim();
  const email = String(log.userEmail || '').trim();
  const name = String(log.userName || '').trim();

  // Use uid > email > name as a stable unique identifier
  return uid || email || name;
}

function getEmployeeLabel(log) {
  const uid = String(log.uid || '').trim();
  const email = String(log.userEmail || '').trim();
  const name = String(log.userName || '').trim();

  // Format as "Name (Email)" if both exist and are different
  if (name && email && name.toLowerCase() !== email.toLowerCase()) {
    return `${name} (${email})`;
  }

  return name || email || uid || 'Unknown';
}

/* =========================================
ACCESS CONTROL
========================================= */

function requireManagerAccess() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) {
          window.location.replace('index.html');
          reject(new Error('Not authenticated'));
          return;
        }

        if (userEmailEl) {
          userEmailEl.textContent = getStoredUserName() || user.email;
          userEmailEl.title = user.email || '';
        }

        logoutBtn?.addEventListener('click', logout);

        const userSnap = await get(ref(db, `users/${user.uid}`));

        if (!userSnap.exists()) {
          window.location.replace('index.html');
          reject(new Error('User profile not found'));
          return;
        }

        const userData = userSnap.val();

        const displayName =
          userData?.name ||
          userData?.englishName ||
          getStoredUserName() ||
          user.email;

        if (userEmailEl) {
          userEmailEl.textContent = displayName;
          userEmailEl.title = user.email || '';
        }

        const isMasterAdmin =
          user.email?.toLowerCase() === 'kumonchamps@gmail.com';

        const positions = getEmpPositions(userData)
          .map((p) => String(p).trim().toLowerCase());

        const isManagerOrAdmin =
          isMasterAdmin || hasManagementPosition(positions);

        if (!isManagerOrAdmin) {
          window.location.replace('centers.html');
          reject(new Error('Not authorized'));
          return;
        }

        resolve(user);
      } catch (err) {
        console.error('Error checking activity log access:', err);
        reject(err);
      }
    });
  });
}

/* =========================================
LOAD LOGS
========================================= */

async function loadActivityLogs() {
  try {
    pageLoader?.classList.remove('hidden');

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="message-row">
          Loading activity logs...
        </td>
      </tr>
    `;

    const logsRef = ref(db, 'activityLogs');

    // For larger data, consider date-sharding or pagination.
    const logsQuery = query(
      logsRef,
      orderByChild('timestamp'),
      limitToLast(2000)
    );

    const snapshot = await get(logsQuery);

    if (!snapshot.exists()) {
      state.allLogs = [];
      state.filteredLogs = [];
      populateFilters();
      renderTable();
      return;
    }

    const logs = [];

    snapshot.forEach((child) => {
      logs.push({
        id: child.key,
        ...child.val()
      });
    });

    // Latest first.
    logs.sort((a, b) => {
      return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
    });

    state.allLogs = logs;
    state.filteredLogs = logs;

    populateFilters();
    renderTable();
  } catch (err) {
    console.error('Error loading activity logs:', err);

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="message-row" style="color:#dc3545;">
          Error loading activity logs. Check Firebase rules and console.
        </td>
      </tr>
    `;
  } finally {
    pageLoader?.classList.add('hidden');
  }
}

/* =========================================
FILTER OPTIONS
========================================= */

function populateFilters() {
  const centers = new Map();
  const employees = new Map();
  const actions = new Set();

  state.allLogs.forEach((log) => {
    const centerValue = log.centerId || log.centerName || '';
    const centerLabel = log.centerName || log.centerId || '';

    if (centerValue && !centers.has(centerValue)) {
      centers.set(centerValue, centerLabel);
    }

    const employeeValue = getEmployeeKey(log);

    if (employeeValue && !employees.has(employeeValue)) {
      employees.set(employeeValue, getEmployeeLabel(log));
    }

    if (log.action) {
      actions.add(log.action);
    }
  });

  centerFilter.innerHTML = '<option value="">All Centers</option>';

  Array.from(centers.entries())
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      centerFilter.appendChild(option);
    });

  employeeFilter.innerHTML = '<option value="">All Employees</option>';

  Array.from(employees.entries())
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      employeeFilter.appendChild(option);
    });

  actionFilter.innerHTML = '<option value="">All Actions</option>';

  Array.from(actions)
    .sort((a, b) => a.localeCompare(b))
    .forEach((action) => {
      const option = document.createElement('option');
      option.value = action;
      option.textContent = action;
      actionFilter.appendChild(option);
    });
}

/* =========================================
APPLY FILTERS
========================================= */

function applyFilters() {
  const fromDate = dateFrom.value;
  const toDate = dateTo.value;
  const selectedCenter = centerFilter.value;
  const selectedEmployee = employeeFilter.value;
  const selectedAction = actionFilter.value;
  const searchTerm = searchInput.value.trim().toLowerCase();

  state.filteredLogs = state.allLogs.filter((log) => {
    if (fromDate && (!log.date || String(log.date) < fromDate)) {
      return false;
    }

    if (toDate && (!log.date || String(log.date) > toDate)) {
      return false;
    }

    if (selectedCenter) {
      const logCenterId = String(log.centerId || '');
      const logCenterName = String(log.centerName || '');

      const matchesCenter =
        logCenterId === selectedCenter ||
        logCenterName === selectedCenter;

      if (!matchesCenter) {
        return false;
      }
    }

    if (selectedEmployee) {
      const employeeKey = getEmployeeKey(log);

      const matchesEmployee =
        employeeKey === selectedEmployee ||
        String(log.uid || '') === selectedEmployee ||
        String(log.userName || '') === selectedEmployee ||
        String(log.userEmail || '') === selectedEmployee;

      if (!matchesEmployee) {
        return false;
      }
    }

    if (selectedAction && log.action !== selectedAction) {
      return false;
    }

    if (searchTerm) {
      const haystack = [
        log.userName,
        log.userEmail,
        log.centerName,
        log.centerId,
        log.page,
        log.path,
        log.action,
        formatDetails(log.details)
      ]
        .join(' ')
        .toLowerCase();

      if (!haystack.includes(searchTerm)) {
        return false;
      }
    }

    return true;
  });

  renderTable();
}

/* =========================================
RENDER TABLE
========================================= */

function renderTable() {
  tbody.innerHTML = '';

  if (!state.filteredLogs.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="message-row">
          No activity records found.
        </td>
      </tr>
    `;

    resultCount.textContent = '';
    return;
  }

  resultCount.textContent = `(${state.filteredLogs.length})`;

  state.filteredLogs.forEach((log) => {
    const tr = document.createElement('tr');

    const employeeName =
      log.userName ||
      log.userEmail ||
      log.uid ||
      '-';

    const detailsText = formatDetails(log.details) || '-';

    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(employeeName)}</strong><br />
        <small>${escapeHtml(log.userEmail || '')}</small>
      </td>

      <td>${escapeHtml(log.date || '-')}</td>

      <td>${escapeHtml(log.time || '-')}</td>

      <td>${escapeHtml(log.centerName || log.centerId || '-')}</td>

      <td>
        ${escapeHtml(log.page || '-')}<br />
        <small>${escapeHtml(log.path || '')}</small>
      </td>

      <td>${escapeHtml(log.action || '-')}</td>

      <td class="details-cell">${escapeHtml(detailsText)}</td>
    `;

    tbody.appendChild(tr);
  });
}

/* =========================================
CSV EXPORT
========================================= */

function exportCsv() {
  const headers = [
    'Employee Name',
    'Email',
    'Date',
    'Time',
    'Center',
    'Page',
    'Path',
    'Action',
    'Details'
  ];

  const rows = state.filteredLogs.map((log) => {
    return [
      log.userName || '',
      log.userEmail || '',
      log.date || '',
      log.time || '',
      log.centerName || log.centerId || '',
      log.page || '',
      log.path || '',
      log.action || '',
      formatDetails(log.details)
    ];
  });

  const csvContent = [
    headers,
    ...rows
  ]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n');

  const blob = new Blob(['\ufeff' + csvContent], {
    type: 'text/csv;charset=utf-8;'
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `employee-activity-log-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

/* =========================================
EVENT LISTENERS
========================================= */

applyFiltersBtn?.addEventListener('click', applyFilters);

clearFiltersBtn?.addEventListener('click', () => {
  dateFrom.value = '';
  dateTo.value = '';
  centerFilter.value = '';
  employeeFilter.value = '';
  actionFilter.value = '';
  searchInput.value = '';

  state.filteredLogs = [...state.allLogs];
  renderTable();
});

exportCsvBtn?.addEventListener('click', exportCsv);

/* =========================================
START
========================================= */

requireManagerAccess()
  .then(() => {
    loadActivityLogs();
  })
  .catch((err) => {
    console.error('Activity log page access error:', err);
    pageLoader?.classList.add('hidden');
  });
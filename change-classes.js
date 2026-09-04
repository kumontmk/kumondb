import { auth, db, requireAuth } from './auth.js';
import { ref, get, push, update, remove, onValue, off, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js"; 
import { applyI18n, t, i18nReady } from './change-classes-i18n.js';

// ============================================
// STATE
// ============================================
const centerId = sessionStorage.getItem('selectedCenter');
let classChangesCache = [];
let allStudents = [];
let allStudentsMap = new Map();
let ccUnsub = null;
let currentFilter = {
  status: 'all',
  type: 'all',
  subject: 'all',
  search: '',
  dateFrom: '',
  dateTo: ''
};
let selectedIds = new Set();
let editingId = null;
let selectedStudent = null;
let currentDetailId = null;

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  await i18nReady.catch(() => {});
  applyI18n();

  // 👇 Use onAuthStateChanged to wait for Firebase Auth to resolve
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'index.html';
      return;
    }

    if (!centerId) {
      window.location.href = 'centers.html';
      return;
    }

    // Permission check
    try {
      // 👇 Safely use `user.uid` instead of `auth.currentUser.uid`
      const userSnap = await get(ref(db, `users/${user.uid}`));
      if (!userSnap.exists()) {
        window.location.href = 'index.html';
        return;
      }
      const userData = userSnap.val();
      const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
      const hasAccess = isAdmin || userData.permissions?.dashboardCards?.changeClasses === true;

      if (!hasAccess) {
        document.getElementById('accessDenied').classList.remove('hidden');
        document.getElementById('page-loader').classList.add('hidden');
        document.getElementById('backToDashboardBtn')?.addEventListener('click', () => {
          window.location.href = 'dashboard.html';
        });
        return;
      }
    } catch (err) {
      console.error('Permission check failed:', err);
      window.location.href = 'index.html';
      return;
    }

    // Show main UI
    document.getElementById('mainContent').classList.remove('hidden');
    document.getElementById('mainContainer').classList.remove('hidden');

    // User info
    const storedUser = sessionStorage.getItem('kumonUser');
    if (storedUser) {
      try {
        const u = JSON.parse(storedUser);
        document.getElementById('userInfo').textContent = u.name || '';
      } catch {}
    }

    // Load students & data
    await loadAllStudents();
    startRealtimeSync();

    // Wire UI
    wireFilters();
    wireAddEditModal();
    wireDetailModal();
    wireConfirmModal();
    wireBulkActions();
    wireExport();
    wireSelectAll();

    document.getElementById('page-loader').classList.add('hidden');
  });
});

// ============================================
// STUDENTS
// ============================================
async function loadAllStudents() {
  try {
    const snap = await get(ref(db, `centers/${centerId}/students`));
    allStudents = [];
    allStudentsMap = new Map();
    if (snap.exists()) {
      snap.forEach(child => {
        const s = { ...child.val(), id: child.key };
        allStudents.push(s);
        allStudentsMap.set(child.key, s);
      });
    }
    allStudents.sort((a, b) => {
      const nameA = (a.namePinyin || a.nameCn || '').toLowerCase();
      const nameB = (b.namePinyin || b.nameCn || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  } catch (err) {
    console.error('Failed to load students:', err);
  }
}

// ============================================
// REALTIME SYNC
// ============================================
function startRealtimeSync() {
  if (ccUnsub) return;
  const ccRef = ref(db, `centers/${centerId}/classChanges`);
  ccUnsub = onValue(ccRef, (snap) => {
    classChangesCache = [];
    if (snap.exists()) {
      snap.forEach(child => {
        classChangesCache.push({ ...child.val(), id: child.key });
      });
    }
    renderAll();
  }, (err) => {
    console.error('Realtime sync error:', err);
  });
}

window.addEventListener('beforeunload', () => {
  if (ccUnsub) {
    const ccRef = ref(db, `centers/${centerId}/classChanges`);
    off(ccRef);
  }
});

// ============================================
// RENDER
// ============================================
function renderAll() {
  renderStats();
  renderTable();
  renderCards();
  updateBulkBar();
}

function getFilteredRecords() {
  return classChangesCache.filter(r => {
    if (currentFilter.status !== 'all' && r.replacementStatus !== currentFilter.status) return false;
    if (currentFilter.type !== 'all' && r.type !== currentFilter.type) return false;
    if (currentFilter.subject !== 'all') {
      const sub = (r.subject || '').toLowerCase();
      if (!sub.includes(currentFilter.subject.toLowerCase())) return false;
    }
    if (currentFilter.search) {
      const q = currentFilter.search.toLowerCase();
      const haystack = [
        r.nameCn, r.nameEn, r.nickname, r.pinyin,
        r.studentNumber, r.subject, r.grade, r.school
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (currentFilter.dateFrom) {
      const d = r.absenceDate || r.replacementDate || '';
      if (d < currentFilter.dateFrom) return false;
    }
    if (currentFilter.dateTo) {
      const d = r.absenceDate || r.replacementDate || '';
      if (d > currentFilter.dateTo) return false;
    }
    return true;
  }).sort((a, b) => {
    // Sort: scheduled first, then by absenceDate desc
    const statusOrder = { scheduled: 0, completed: 1, missed: 2, cancelled: 3, none: 4 };
    const sa = statusOrder[a.replacementStatus] ?? 5;
    const sb = statusOrder[b.replacementStatus] ?? 5;
    if (sa !== sb) return sa - sb;
    const da = a.absenceDate || '';
    const db2 = b.absenceDate || '';
    return db2.localeCompare(da);
  });
}

function renderStats() {
  const total = classChangesCache.length;
  const scheduled = classChangesCache.filter(r => r.replacementStatus === 'scheduled').length;
  const completed = classChangesCache.filter(r => r.replacementStatus === 'completed').length;
  const missed = classChangesCache.filter(r => r.replacementStatus === 'missed').length;
  const cancelled = classChangesCache.filter(r => r.replacementStatus === 'cancelled').length;
  const pu = classChangesCache.filter(r => r.homeworkPickedUp).length;

  document.getElementById('statTotal').textContent = total;
  document.getElementById('statScheduled').textContent = scheduled;
  document.getElementById('statCompleted').textContent = completed;
  document.getElementById('statMissed').textContent = missed;
  document.getElementById('statCancelled').textContent = cancelled;
  document.getElementById('statPU').textContent = pu;
}

function renderTable() {
  const tbody = document.getElementById('ccTableBody');
  const empty = document.getElementById('emptyState');
  const records = getFilteredRecords();

  tbody.innerHTML = '';
  if (records.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  records.forEach(r => {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    if (selectedIds.has(r.id)) tr.classList.add('selected');

    const statusClass = `row-${r.replacementStatus || 'none'}`;
    tr.classList.add(statusClass);

    const student = allStudentsMap.get(r.studentId);
    const isVisiting = student && student.homeCenterId && student.homeCenterId !== centerId;

    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" data-id="${r.id}" ${selectedIds.has(r.id) ? 'checked' : ''} /></td>
      <td>
        <div class="student-cell">
          <span class="student-name">
            ${isVisiting ? '<span class="visiting-dot" title="Visiting"></span>' : ''}
            ${escapeHtml(r.nameCn || r.nameEn || 'Unknown')}
            ${r.nickname ? `<span style="color:var(--text-light);font-weight:400;">(${escapeHtml(r.nickname)})</span>` : ''}
          </span>
          <span class="student-meta">
            ${r.pinyin ? escapeHtml(r.pinyin) : ''}
            ${r.grade ? ` • G${escapeHtml(r.grade)}` : ''}
            ${r.studentNumber ? ` • #${escapeHtml(r.studentNumber)}` : ''}
          </span>
        </div>
      </td>
      <td>${escapeHtml(r.subject || '-')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</td>
      <td><span class="type-badge ${getTypeClass(r.type)}">${escapeHtml(formatType(r.type))}</span></td>
      <td>${formatDate(r.absenceDate)} ${r.originalTime ? `<br><small style="color:var(--text-light);">${escapeHtml(r.originalTime)}</small>` : ''}</td>
      <td>${formatReplacementCell(r)}</td>
      <td><span class="status-badge status-${r.replacementStatus || 'none'}">${formatStatus(r.replacementStatus)}</span></td>
      <td><span class="pu-badge ${r.homeworkPickedUp ? 'pu-yes' : 'pu-no'}">${r.homeworkPickedUp ? '✓' : '—'}</span></td>
      <td>
        <div class="action-btn-group">
          <button class="action-btn action-view" data-action="view" data-id="${r.id}" title="View">👁</button>
          <button class="action-btn action-edit" data-action="edit" data-id="${r.id}" title="Edit">✏️</button>
          ${r.replacementStatus === 'scheduled' ? `<button class="action-btn action-complete" data-action="complete" data-id="${r.id}" title="Mark Complete">✅</button>` : ''}
          ${r.replacementStatus !== 'cancelled' ? `<button class="action-btn action-cancel" data-action="cancel" data-id="${r.id}" title="Cancel">🚫</button>` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Wire row actions
  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      handleRowAction(action, id);
    });
  });

  // Wire row clicks -> detail
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      openDetail(tr.dataset.id);
    });
  });

  // Wire checkboxes
  tbody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      tr.classList.toggle('selected', e.target.checked);
      updateBulkBar();
      updateSelectAllCheck();
    });
  });
}

function renderCards() {
  const container = document.getElementById('cardsContainer');
  const records = getFilteredRecords();
  container.innerHTML = '';

  if (records.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>${t('cc.emptyState')}</p></div>`;
    return;
  }

  records.forEach(r => {
    const student = allStudentsMap.get(r.studentId);
    const isVisiting = student && student.homeCenterId && student.homeCenterId !== centerId;
    const typeClass = r.type && r.type.startsWith('CC') ? 'cc-type-cc' : 'cc-type-mc';
    const statusClass = `cc-${r.replacementStatus || 'none'}`;

    const card = document.createElement('div');
    card.className = `cc-card ${typeClass} ${statusClass}`;
    card.dataset.id = r.id;

    card.innerHTML = `
      <div class="cc-card-top">
        <div>
          <div class="cc-card-name">
            ${isVisiting ? '<span class="visiting-dot"></span>' : ''}
            ${escapeHtml(r.nameCn || r.nameEn || 'Unknown')}
            ${r.nickname ? `<span style="color:var(--text-light);font-weight:400;">(${escapeHtml(r.nickname)})</span>` : ''}
          </div>
          <div class="cc-card-subject">${escapeHtml(r.subject || '')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</div>
        </div>
        <div class="cc-card-badges">
          <span class="type-badge ${getTypeClass(r.type)}">${escapeHtml(formatType(r.type))}</span>
          <span class="status-badge status-${r.replacementStatus || 'none'}">${formatStatus(r.replacementStatus)}</span>
          ${r.homeworkPickedUp ? '<span class="pu-badge pu-yes" style="margin-left:2px;">📚</span>' : ''}
        </div>
      </div>
      <div class="cc-card-dates">
        <div class="cc-card-date-item">
          <strong>${t('cc.absenceDate')}</strong>
          <span>${formatDate(r.absenceDate)} ${r.originalTime || ''}</span>
        </div>
        <div class="cc-card-date-item">
          <strong>${t('cc.replacementDate')}</strong>
          <span>${r.replacementDate ? formatDate(r.replacementDate) + ' ' + (r.replacementTime || '') : '—'}</span>
        </div>
      </div>
      ${r.note ? `<div style="font-size:0.82rem;color:var(--text-light);background:#f8fafc;padding:0.5rem;border-radius:6px;margin-top:0.3rem;">📝 ${escapeHtml(r.note)}</div>` : ''}
      <div class="cc-card-actions">
        <button class="action-btn action-view" data-action="view" data-id="${r.id}">👁 ${t('cc.view')}</button>
        <button class="action-btn action-edit" data-action="edit" data-id="${r.id}">✏️ ${t('cc.edit')}</button>
        ${r.replacementStatus === 'scheduled' ? `<button class="action-btn action-complete" data-action="complete" data-id="${r.id}">✅ ${t('cc.markComplete')}</button>` : ''}
        ${r.replacementStatus !== 'cancelled' ? `<button class="action-btn action-cancel" data-action="cancel" data-id="${r.id}">🚫 ${t('cc.cancel')}</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleRowAction(btn.dataset.action, btn.dataset.id);
    });
  });
  container.querySelectorAll('.cc-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      openDetail(card.dataset.id);
    });
  });
}

// ============================================
// HELPERS
// ============================================
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeSubjects(student) {
  const raw = student.subjects;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

function getCurrentSubjects(student) {
  return normalizeSubjects(student).filter(s => s && s.status === 'current' && s.name);
}

function hasCurrentSubjects(student) {
  return getCurrentSubjects(student).length > 0;
}

function formatDate(d) {
  if (!d) return '—';
  return d;
}
function formatType(t) {
  return {
    'CC_PU': 'CC PU',
    'CC_NO_PU': 'CC No PU',
    'MC': 'MC',
    'MC_PU': 'MC PU'
  }[t] || t || '-';
}
function getTypeClass(t) {
  return t && t.startsWith('CC') ? 'type-cc' : 'type-mc';
}
function formatStatus(s) {
  return {
    'scheduled': t('cc.statusScheduled'),
    'completed': t('cc.statusCompleted'),
    'missed': t('cc.statusMissed'),
    'cancelled': t('cc.statusCancelled'),
    'none': '—'
  }[s] || s || '—';
}
function formatReplacementCell(r) {
  if (!r.replacementDate && !r.replacementTime) return '—';
  return `${formatDate(r.replacementDate)} ${r.replacementTime || ''}`;
}

// ============================================
// FILTERS
// ============================================
function wireFilters() {
  // Status segments
  document.querySelectorAll('#statusSegmented .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#statusSegmented .segment').forEach(s => s.classList.remove('active'));
      seg.classList.add('active');
      currentFilter.status = seg.dataset.status;
      renderAll();
    });
  });

  // Search
  document.getElementById('searchInput').addEventListener('input', (e) => {
    currentFilter.search = e.target.value.trim();
    renderAll();
  });

  // Date range
  document.getElementById('dateFrom').addEventListener('change', (e) => {
    currentFilter.dateFrom = e.target.value;
    renderAll();
  });
  document.getElementById('dateTo').addEventListener('change', (e) => {
    currentFilter.dateTo = e.target.value;
    renderAll();
  });
  document.getElementById('clearDatesBtn').addEventListener('click', () => {
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    currentFilter.dateFrom = '';
    currentFilter.dateTo = '';
    renderAll();
  });

  // Type filter
  document.getElementById('typeFilter').addEventListener('change', (e) => {
    currentFilter.type = e.target.value;
    renderAll();
  });

  // Subject filter
  document.getElementById('subjectFilter').addEventListener('change', (e) => {
    currentFilter.subject = e.target.value;
    renderAll();
  });
}

// ============================================
// SELECT ALL / BULK
// ============================================
function wireSelectAll() {
  document.getElementById('selectAllCheck').addEventListener('change', (e) => {
    const records = getFilteredRecords();
    if (e.target.checked) {
      records.forEach(r => selectedIds.add(r.id));
    } else {
      selectedIds.clear();
    }
    renderTable();
    updateBulkBar();
  });
}

function updateSelectAllCheck() {
  const records = getFilteredRecords();
  const allCheck = document.getElementById('selectAllCheck');
  if (records.length === 0) {
    allCheck.checked = false;
    allCheck.indeterminate = false;
    return;
  }
  const selectedCount = records.filter(r => selectedIds.has(r.id)).length;
  allCheck.checked = selectedCount === records.length;
  allCheck.indeterminate = selectedCount > 0 && selectedCount < records.length;
}

function wireBulkActions() {
  document.getElementById('bulkCompleteBtn').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const ok = await showConfirm(
      t('cc.bulkCompleteTitle'),
      t('cc.bulkCompleteMsg', { count: selectedIds.size })
    );
    if (!ok) return;
    await bulkUpdateStatus('completed');
  });

  document.getElementById('bulkCancelBtn').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const ok = await showConfirm(
      t('cc.bulkCancelTitle'),
      t('cc.bulkCancelMsg', { count: selectedIds.size })
    );
    if (!ok) return;
    await bulkUpdateStatus('cancelled');
  });

  document.getElementById('bulkClearBtn').addEventListener('click', () => {
    selectedIds.clear();
    renderTable();
    updateBulkBar();
    updateSelectAllCheck();
  });
}

function updateBulkBar() {
  const bar = document.getElementById('bulkActions');
  const count = selectedIds.size;
  if (count > 0) {
    bar.classList.remove('hidden');
    document.getElementById('bulkCount').textContent = t('cc.selectedCount', { count });
  } else {
    bar.classList.add('hidden');
  }
}

async function bulkUpdateStatus(status) {
  const updates = {};
  const now = new Date().toISOString();
  selectedIds.forEach(id => {
    updates[`${id}/replacementStatus`] = status;
    updates[`${id}/updatedAt`] = now;
    if (status === 'completed') {
      updates[`${id}/completedAt`] = now;
    }
  });
  try {
    await update(ref(db, `centers/${centerId}/classChanges`), updates);
    showToast(t('cc.bulkSuccess', { count: selectedIds.size }), 'success');
    selectedIds.clear();
    updateBulkBar();
    updateSelectAllCheck();
  } catch (err) {
    console.error('Bulk update failed:', err);
    showToast(t('cc.bulkFailed'), 'error');
  }
}

// ============================================
// ROW ACTIONS
// ============================================
async function handleRowAction(action, id) {
  const record = classChangesCache.find(r => r.id === id);
  if (!record) return;

  switch (action) {
    case 'view':
      openDetail(id);
      break;
    case 'edit':
      openAddEditModal(id);
      break;
    case 'complete': {
      const ok = await showConfirm(
        t('cc.completeTitle'),
        t('cc.completeMsg', { name: record.nameCn || record.nameEn })
      );
      if (!ok) return;
      await updateRecord(id, {
        replacementStatus: 'completed',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      showToast(t('cc.completedSuccess'), 'success');
      break;
    }
    case 'cancel': {
      const ok = await showConfirm(
        t('cc.cancelTitle'),
        t('cc.cancelMsg', { name: record.nameCn || record.nameEn })
      );
      if (!ok) return;
      await updateRecord(id, {
        replacementStatus: 'cancelled',
        updatedAt: new Date().toISOString()
      });
      showToast(t('cc.cancelledSuccess'), 'success');
      break;
    }
  }
}

async function updateRecord(id, updates) {
  try {
    await update(ref(db, `centers/${centerId}/classChanges/${id}`), updates);
  } catch (err) {
    console.error('Update failed:', err);
    showToast(t('cc.updateFailed'), 'error');
  }
}

// ============================================
// ADD / EDIT MODAL
// ============================================
function wireAddEditModal() {
  document.getElementById('addRequestBtn').addEventListener('click', () => openAddEditModal(null));
  document.getElementById('closeCcModal').addEventListener('click', closeAddEditModal);
  document.getElementById('cancelCcBtn').addEventListener('click', closeAddEditModal);
  document.getElementById('ccModal').addEventListener('click', (e) => {
    if (e.target.id === 'ccModal') closeAddEditModal();
  });

  // Student search
  const searchInput = document.getElementById('studentSearch');
  const resultsDiv = document.getElementById('studentResults');
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { resultsDiv.classList.add('hidden'); return; }
    const matches = allStudents.filter(s => {
    // ✅ Only students with at least one CURRENT subject
    if (!hasCurrentSubjects(s)) return false;
        const hay = [s.nameCn, s.namePinyin, s.nickname, s.studentNumber, s.grade, s.school]
            .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
    }).slice(0, 15);
    renderStudentResults(matches);
  });
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim()) {
      searchInput.dispatchEvent(new Event('input'));
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      resultsDiv.classList.add('hidden');
    }
  });

  // Change student button
  document.getElementById('changeStudentBtn').addEventListener('click', () => {
    selectedStudent = null;
    document.getElementById('selectedStudentId').value = '';
    document.getElementById('selectedStudentInfo').classList.add('hidden');
    searchInput.value = '';
    searchInput.focus();
    populateSubjects(null);
  });

  // Type change — toggle replacement fields
  document.getElementById('typeSelect').addEventListener('change', (e) => {
    const isCC = e.target.value.startsWith('CC');
    document.getElementById('ccForm').classList.toggle('hide-replacement', !isCC);
    document.getElementById('replacementDate').required = isCC;
    document.getElementById('replacementTime').required = isCC;
    // Auto-toggle homework PU
    if (e.target.value === 'CC_PU' || e.target.value === 'MC_PU') {
      document.getElementById('homeworkPU').checked = true;
    }
  });

  // Form submit
  document.getElementById('ccForm').addEventListener('submit', handleFormSubmit);
}

function renderStudentResults(matches) {
  const div = document.getElementById('studentResults');
  div.innerHTML = '';
  if (matches.length === 0) {
    div.innerHTML = `<div class="search-result-item" style="color:#94a3b8;cursor:default;">${t('cc.noStudentsFound')}</div>`;
    div.classList.remove('hidden');
    return;
  }
  matches.forEach(s => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.innerHTML = `
      <div class="search-result-name">${escapeHtml(s.nameCn || s.nameEn || 'Unknown')} ${s.nickname ? `(${escapeHtml(s.nickname)})` : ''}</div>
      <div class="search-result-meta">${s.pinyin || ''} ${s.grade ? `• G${s.grade}` : ''} ${s.studentNumber ? `• #${s.studentNumber}` : ''}</div>
    `;
    item.addEventListener('click', () => selectStudentForForm(s));
    div.appendChild(item);
  });
  div.classList.remove('hidden');
}

function selectStudentForForm(s) {
  selectedStudent = s;
  document.getElementById('selectedStudentId').value = s.id;
  document.getElementById('studentSearch').value = '';
  document.getElementById('studentResults').classList.add('hidden');
  document.getElementById('selectedStudentName').textContent = `${s.nameCn || s.nameEn || 'Unknown'} ${s.nickname ? `(${s.nickname})` : ''}`;
  document.getElementById('selectedStudentMeta').textContent = [s.pinyin, s.grade ? `Grade ${s.grade}` : '', s.studentNumber ? `#${s.studentNumber}` : '', s.school].filter(Boolean).join(' • ');
  document.getElementById('selectedStudentInfo').classList.remove('hidden');
  populateSubjects(s);
}

function populateSubjects(student) {
  const select = document.getElementById('subjectSelect');
  select.innerHTML = `<option value="">${t('cc.selectSubject')}</option>`;
  if (!student) return;

  // ✅ Only CURRENT subjects — dropped/paused/inquiry never shown
  getCurrentSubjects(student).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.name} (${s.currentLevel || s.startLevel || '-'})`;
    opt.dataset.level = s.currentLevel || s.startLevel || '';
    select.appendChild(opt);
  });
}

function openAddEditModal(id) {
  editingId = id;
  const form = document.getElementById('ccForm');
  form.reset();
  form.classList.remove('hide-replacement');
  document.getElementById('studentResults').classList.add('hidden');
  selectedStudent = null;
  document.getElementById('selectedStudentInfo').classList.add('hidden');
  document.getElementById('selectedStudentId').value = '';
  document.getElementById('subjectSelect').innerHTML = `<option value="">${t('cc.selectSubject')}</option>`;

  if (id) {
    // EDIT mode
    const r = classChangesCache.find(x => x.id === id);
    if (!r) return;
    document.getElementById('ccModalTitle').textContent = t('cc.editTitle');
    document.getElementById('absenceDate').value = r.absenceDate || '';
    document.getElementById('originalTime').value = r.originalTime || '';
    document.getElementById('replacementDate').value = r.replacementDate || '';
    document.getElementById('replacementTime').value = r.replacementTime || '';
    document.getElementById('typeSelect').value = r.type || 'CC_PU';
    document.getElementById('statusSelect').value = r.replacementStatus || 'scheduled';
    document.getElementById('homeworkPU').checked = !!r.homeworkPickedUp;
    document.getElementById('noteInput').value = r.note || '';

    // Pre-select student
    const s = allStudentsMap.get(r.studentId);
    if (s) selectStudentForForm(s);
    // Pre-select subject
    setTimeout(() => {
    const select = document.getElementById('subjectSelect');
    // If the saved subject is no longer current (e.g. dropped since), re-add it
    // so the existing record can still be viewed/edited
    if (r.subject && !Array.from(select.options).some(o => o.value === r.subject)) {
        const opt = document.createElement('option');
        opt.value = r.subject;
        opt.textContent = `${r.subject} (${r.subjectLevel || '-'})`;
        opt.dataset.level = r.subjectLevel || '';
        select.appendChild(opt);
    }
    select.value = r.subject || '';
    }, 50);

    const isCC = (r.type || '').startsWith('CC');
    form.classList.toggle('hide-replacement', !isCC);
  } else {
    document.getElementById('ccModalTitle').textContent = t('cc.addTitle');
    document.getElementById('statusSelect').value = 'scheduled';
  }
  document.getElementById('ccModal').classList.remove('hidden');
}

function closeAddEditModal() {
  document.getElementById('ccModal').classList.add('hidden');
  editingId = null;
  selectedStudent = null;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const studentId = document.getElementById('selectedStudentId').value;
  if (!studentId) {
    showToast(t('cc.selectStudentFirst'), 'error');
    return;
  }
  const student = allStudentsMap.get(studentId);
  if (!student) return;

  const subjectSelect = document.getElementById('subjectSelect');
  const subject = subjectSelect.value;
  const subjectLevel = subjectSelect.selectedOptions[0]?.dataset?.level || '';
  if (!subject) {
    showToast(t('cc.selectSubjectFirst'), 'error');
    return;
  }

  const type = document.getElementById('typeSelect').value;
  const isCC = type.startsWith('CC');
  const absenceDate = document.getElementById('absenceDate').value;
  const originalTime = document.getElementById('originalTime').value;
  const replacementDate = isCC ? document.getElementById('replacementDate').value : '';
  const replacementTime = isCC ? document.getElementById('replacementTime').value : '';
  const status = document.getElementById('statusSelect').value;
  const homeworkPU = document.getElementById('homeworkPU').checked;
  const note = document.getElementById('noteInput').value.trim();

  if (!absenceDate) {
    showToast(t('cc.selectAbsenceDate'), 'error');
    return;
  }
  if (isCC && (!replacementDate || !replacementTime)) {
    showToast(t('cc.selectReplacement'), 'error');
    return;
  }

  const saveBtn = document.getElementById('saveCcBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = t('common.saving');

  try {
    const now = new Date().toISOString();
    const payload = {
      studentId,
      studentNumber: student.studentNumber || '',
      nameCn: student.nameCn || '',
      nameEn: student.nameEn || student.name || '',
      nickname: student.nickname || '',
      grade: student.grade || '',
      school: student.school || '',
      pinyin: student.namePinyin || student.pinyin || '',
      subject,
      subjectLevel,
      type,
      absenceDate,
      originalTime,
      replacementDate,
      replacementTime,
      replacementStatus: status,
      homeworkPickedUp: homeworkPU,
      note,
      homeCenterId: student.homeCenterId || centerId,
      homeCenterName: student.homeCenterName || '',
      isVisiting: student.homeCenterId && student.homeCenterId !== centerId,
      updatedAt: now
    };

    if (editingId) {
      const existing = classChangesCache.find(r => r.id === editingId);
      const history = Array.isArray(existing?.history) ? [...existing.history] : [];
      history.push({
        at: now,
        by: auth.currentUser?.email || '',
        action: 'edited',
        changes: {
          absenceDate, replacementDate, replacementTime, type, status
        }
      });
      payload.history = history;
      payload.createdAt = existing?.createdAt || now;
      payload.createdBy = existing?.createdBy || auth.currentUser?.uid;
      await update(ref(db, `centers/${centerId}/classChanges/${editingId}`), payload);
      showToast(t('cc.editSuccess'), 'success');
    } else {
      payload.createdAt = now;
      payload.createdBy = auth.currentUser?.uid || '';
      payload.history = [{ at: now, by: auth.currentUser?.email || '', action: 'created' }];
      await push(ref(db, `centers/${centerId}/classChanges`), payload);
      showToast(t('cc.addSuccess'), 'success');
    }

    closeAddEditModal();
  } catch (err) {
    console.error('Save failed:', err);
    showToast(t('cc.saveFailed'), 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = t('cc.save');
  }
}

// ============================================
// DETAIL MODAL
// ============================================
function wireDetailModal() {
  document.getElementById('closeDetailModal').addEventListener('click', closeDetailModal);
  document.getElementById('closeDetailBtn').addEventListener('click', closeDetailModal);
  document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target.id === 'detailModal') closeDetailModal();
  });
  document.getElementById('editDetailBtn').addEventListener('click', () => {
    if (!currentDetailId) return;
    closeDetailModal();
    setTimeout(() => openAddEditModal(currentDetailId), 150);
  });
  document.getElementById('deleteDetailBtn').addEventListener('click', async () => {
    if (!currentDetailId) return;
    const ok = await showConfirm(t('cc.deleteTitle'), t('cc.deleteMsg'));
    if (!ok) return;
    try {
      await remove(ref(db, `centers/${centerId}/classChanges/${currentDetailId}`));
      showToast(t('cc.deleteSuccess'), 'success');
      closeDetailModal();
    } catch (err) {
      console.error('Delete failed:', err);
      showToast(t('cc.deleteFailed'), 'error');
    }
  });
}

function openDetail(id) {
  const r = classChangesCache.find(x => x.id === id);
  if (!r) return;
  currentDetailId = id;
  const student = allStudentsMap.get(r.studentId);

  const history = Array.isArray(r.history) ? r.history : [];
  const historyHtml = history.length > 0
    ? `<div class="history-timeline">${history.slice().reverse().map(h => `
        <div class="history-item">
          <div class="history-date">${new Date(h.at).toLocaleString()} — ${escapeHtml(h.action || '')}</div>
          <div class="history-reason">${escapeHtml(h.by || '')} ${h.reason ? `• ${escapeHtml(h.reason)}` : ''}</div>
        </div>
      `).join('')}</div>`
    : `<div class="history-empty">${t('cc.noHistory')}</div>`;

  document.getElementById('detailContent').innerHTML = `
    <div class="detail-section">
      <h4>👤 ${t('cc.detailStudent')}</h4>
      <div class="detail-grid">
        <div class="detail-item"><strong>${t('cc.name')}</strong><span>${escapeHtml(r.nameCn || r.nameEn || 'Unknown')} ${r.nickname ? `(${escapeHtml(r.nickname)})` : ''}</span></div>
        <div class="detail-item"><strong>${t('cc.pinyin')}</strong><span>${escapeHtml(r.pinyin || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.grade')}</strong><span>${escapeHtml(r.grade || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.studentNumber')}</strong><span>${escapeHtml(r.studentNumber || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.school')}</strong><span>${escapeHtml(r.school || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.homeCenter')}</strong><span>${escapeHtml(r.homeCenterName || '-')} ${r.isVisiting ? '🏫' : ''}</span></div>
      </div>
    </div>

    <div class="detail-section">
      <h4>📋 ${t('cc.detailChangeClass')}</h4>
      <div class="detail-grid">
        <div class="detail-item"><strong>${t('cc.subject')}</strong><span>${escapeHtml(r.subject || '-')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</span></div>
        <div class="detail-item"><strong>${t('cc.type')}</strong><span><span class="type-badge ${getTypeClass(r.type)}">${escapeHtml(formatType(r.type))}</span></span></div>
        <div class="detail-item"><strong>${t('cc.status')}</strong><span><span class="status-badge status-${r.replacementStatus || 'none'}">${formatStatus(r.replacementStatus)}</span></span></div>
        <div class="detail-item"><strong>${t('cc.homeworkPU')}</strong><span>${r.homeworkPickedUp ? '✓ ' + t('common.yes') : '—'}</span></div>
        <div class="detail-item"><strong>${t('cc.absenceDate')}</strong><span>${formatDate(r.absenceDate)} ${r.originalTime || ''}</span></div>
        <div class="detail-item"><strong>${t('cc.replacementDate')}</strong><span>${r.replacementDate ? formatDate(r.replacementDate) + ' ' + (r.replacementTime || '') : '—'}</span></div>
        ${r.note ? `<div class="detail-item full-width"><strong>${t('cc.note')}</strong><span>${escapeHtml(r.note)}</span></div>` : ''}
      </div>
    </div>

    <div class="detail-section">
      <h4>📜 ${t('cc.historyTimeline')}</h4>
      ${historyHtml}
    </div>
  `;
  document.getElementById('detailModal').classList.remove('hidden');
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.add('hidden');
  currentDetailId = null;
}

// ============================================
// EXPORT
// ============================================
function wireExport() {
  document.getElementById('exportBtn').addEventListener('click', exportToExcel);
}

function exportToExcel() {
  const records = getFilteredRecords();
  if (records.length === 0) {
    showToast(t('cc.nothingToExport'), 'error');
    return;
  }

  const rows = records.map(r => ({
    'Student': r.nameCn || r.nameEn || '',
    'Nickname': r.nickname || '',
    'Pinyin': r.pinyin || '',
    'Grade': r.grade || '',
    'Student #': r.studentNumber || '',
    'Subject': r.subject || '',
    'Level': r.subjectLevel || '',
    'Type': formatType(r.type),
    'Absence Date': r.absenceDate || '',
    'Original Time': r.originalTime || '',
    'Replacement Date': r.replacementDate || '',
    'Replacement Time': r.replacementTime || '',
    'Status': formatStatus(r.replacementStatus),
    'PU': r.homeworkPickedUp ? 'Yes' : 'No',
    'Note': r.note || '',
    'Home Center': r.homeCenterName || '',
    'Visiting': r.isVisiting ? 'Yes' : 'No'
  }));

  const tableHtml = buildExcelTable(rows);
  const css = `<style>
    table { border-collapse: collapse; font-family: Arial; font-size: 10pt; }
    th { background: #4682B4 !important; color: #fff !important; padding: 6px 8px; border: 1px solid #333; }
    td { padding: 4px 6px; border: 1px solid #ccc; }
    .status-scheduled { background: #e0f2fe; }
    .status-completed { background: #dcfce7; }
    .status-missed { background: #fee2e2; }
    .status-cancelled { background: #f1f5f9; text-decoration: line-through; }
  </style>`;

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="UTF-8">${css}</head>
    <body>${tableHtml}</body></html>`;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `Change_Classes_${dateStr}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(t('cc.exportSuccess'), 'success');
}

function buildExcelTable(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  let html = '<table><thead><tr>';
  headers.forEach(h => { html += `<th>${escapeHtml(h)}</th>`; });
  html += '</tr></thead><tbody>';
  rows.forEach(r => {
    const status = r['Status'];
    const statusClass = `status-${status.toLowerCase()}`;
    html += `<tr class="${statusClass}">`;
    headers.forEach(h => { html += `<td>${escapeHtml(r[h] || '')}</td>`; });
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

// ============================================
// CONFIRM MODAL
// ============================================
let confirmResolver = null;
function wireConfirmModal() {
  document.getElementById('confirmCancelBtn').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.add('hidden');
    if (confirmResolver) confirmResolver(false);
  });
  document.getElementById('confirmOkBtn').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.add('hidden');
    if (confirmResolver) confirmResolver(true);
  });
}

function showConfirm(title, message) {
  return new Promise(resolve => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmModal').classList.remove('hidden');
    confirmResolver = resolve;
  });
}

// ============================================
// TOAST
// ============================================
let toastTimer = null;
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}
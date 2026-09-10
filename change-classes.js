import { auth, db } from './auth.js';
import { ref, get, push, set, update, remove, onValue, off } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
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
let currentFilter = { status: 'all', type: 'all', subject: 'all', search: '', dateFrom: '', dateTo: '' };
let selectedIds = new Set();
let editingId = null;
let selectedStudent = null;
let currentDetailId = null;

// 🔗 Links / ⏳ Pending state
let allCentersData = {};        // centerId -> { name, students, studentSiblingLinks }
let familiesCache = [];         // [{ key, members: [{centerId, studentId, data}] }]
let portalsCache = {};          // token -> { meta, students, requests }
let portalsUnsub = null;
let linksFilter = { seg: 'all', search: '' };
let pendingFilter = { seg: 'pending' };
let currentCardFamilyKey = null;
let currentRejectReq = null;
let knownPendingIds = null;
let pendingPrimed = false;
const BASE_TITLE = document.title;
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SNAPSHOT_VERSION = 2; // bump whenever snapshot shape changes

// ============================================
// PERMISSION NORMALIZATION HELPERS
// ============================================
const DASHBOARD_PERMISSION_ALIASES = {
  changeclasses: 'changeClasses',
  changeclass: 'changeClasses',
  changeClasses: 'changeClasses'
};

function normalizePermissionKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasChangeClassesPermission(userData, employeeData, userEmail) {
  // Admin override
  if (String(userEmail || '').toLowerCase() === 'kumonchamps@gmail.com') return true;

  const checkPerms = (perms) => {
    if (!perms || !perms.dashboardCards) return false;
    const dashCards = perms.dashboardCards;
    
    // 1. Check exact match
    if (dashCards.changeClasses === true) return true;
    
    // 2. Check normalized aliases (e.g. 'changeclasses' -> 'changeClasses')
    for (const [key, value] of Object.entries(dashCards)) {
      if (value === true) {
        const normKey = normalizePermissionKey(key);
        if (DASHBOARD_PERMISSION_ALIASES[normKey] === 'changeClasses') return true;
      }
    }
    return false;
  };

  // Check both user and employee records
  if (checkPerms(userData?.permissions)) return true;
  if (checkPerms(employeeData?.permissions)) return true;

  return false;
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  await i18nReady.catch(() => {});
  applyI18n();

  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    if (!centerId) { window.location.href = 'centers.html'; return; }

    try {
      let userData = null;
      let employeeData = null;
      let uid = user.uid;

      // 1. Load user record by UID
      if (uid) {
        const userSnap = await get(ref(db, `users/${uid}`));
        if (userSnap.exists()) userData = userSnap.val();
      }

      // 2. Fallback: find user by email if UID didn't match
      if (!userData && user.email) {
        const usersSnap = await get(ref(db, 'users'));
        const users = usersSnap.val() || {};
        const matchingUid = Object.keys(users).find(u =>
          String(users[u].email || '').toLowerCase() === user.email.toLowerCase()
        );
        if (matchingUid) {
          uid = matchingUid;
          userData = users[matchingUid];
        }
      }

      // 3. Load employee record by UID
      if (uid) {
        const empSnap = await get(ref(db, `employees/${uid}`));
        if (empSnap.exists()) employeeData = empSnap.val();
      }

      // 4. Fallback: find employee by email
      if (!employeeData && user.email) {
        const empSnap = await get(ref(db, 'employees'));
        const emps = empSnap.val() || {};
        employeeData = Object.values(emps).find(e =>
          String(e.email || '').toLowerCase() === user.email.toLowerCase()
        ) || null;
      }

      if (!userData && !employeeData) {
        window.location.href = 'index.html'; 
        return;
      }

      // 5. Check robust permissions
      const hasAccess = hasChangeClassesPermission(userData, employeeData, user.email);
      
      if (!hasAccess) {
        document.getElementById('accessDenied').classList.remove('hidden');
        document.getElementById('page-loader').classList.add('hidden');
        document.getElementById('backToDashboardBtn')?.addEventListener('click', () => { window.location.href = 'dashboard.html'; });
        return;
      }
    } catch (err) {
      console.error('Permission check failed:', err);
      window.location.href = 'index.html';
      return;
    }

    document.getElementById('mainContent').classList.remove('hidden');
    document.getElementById('mainContainer').classList.remove('hidden');

    const storedUser = sessionStorage.getItem('kumonUser');
    if (storedUser) {
      try { document.getElementById('userInfo').textContent = JSON.parse(storedUser).name || ''; } catch {}
    }

    await loadAllStudents();
    await loadAllCentersData();
    buildFamilies();
    startRealtimeSync();
    startPortalsSync();

    wirePageTabs();
    wireFilters();
    wireAddEditModal();
    wireDetailModal();
    wireConfirmModal();
    wireBulkActions();
    wireExport();
    wireSelectAll();
    wireLinks();
    wirePending();

    document.getElementById('page-loader').classList.add('hidden');
  });
});

// ============================================
// STUDENTS & CENTERS
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
    allStudents.sort((a, b) => (a.namePinyin || a.nameCn || '').toLowerCase().localeCompare((b.namePinyin || b.nameCn || '').toLowerCase()));
  } catch (err) { console.error('Failed to load students:', err); }
}

async function loadAllCentersData() {
  try {
    const snap = await get(ref(db, 'centers'));
    allCentersData = {};
    if (snap.exists()) {
      snap.forEach(c => {
        const v = c.val() || {};
        allCentersData[c.key] = {
          name: v.name || c.key,
          students: v.students || {},
          studentSiblingLinks: v.studentSiblingLinks || {}
        };
      });
    }
  } catch (err) { console.error('Failed to load centers:', err); }
}

function normalizeSubjects(student) {
  const raw = student?.subjects;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}
function getCurrentSubjects(student) {
  return normalizeSubjects(student).filter(s => s && s.status === 'current' && s.name);
}
function hasCurrentSubjects(student) { return getCurrentSubjects(student).length > 0; }

function computeStudentStatus(subjects) {
  const list = Array.isArray(subjects) ? subjects : Object.values(subjects || {});
  if (!list.length) return 'Drop';
  const statuses = list.map(s => s?.status || '');
  if (statuses.includes('current')) return 'Current';
  if (statuses.includes('inquiry')) return 'Inquiry';
  if (statuses.every(s => s === 'drop')) return 'Drop';
  if (statuses.every(s => ['drop', 'completer'].includes(s)) && statuses.includes('completer')) return 'Completer';
  return 'Pause';
}

// ============================================
// 👨‍👩‍👧 FAMILY GROUPING (siblings, cross-center included)
// ============================================
function buildFamilies() {
  const adj = {};
  Object.entries(allCentersData).forEach(([cid, c]) => {
    Object.entries(c.studentSiblingLinks || {}).forEach(([sid, sibs]) => {
      Object.entries(sibs || {}).forEach(([sibId, v]) => {
        const sc = (v && v.siblingCenterId) || cid;
        const a = `${cid}/${sid}`, b = `${sc}/${sibId}`;
        (adj[a] = adj[a] || new Set()).add(b);
        (adj[b] = adj[b] || new Set()).add(a);
      });
    });
  });

  const seen = new Set();
  familiesCache = [];
  const curStudents = allCentersData[centerId]?.students || {};

  Object.keys(curStudents).forEach(sid => {
    const node = `${centerId}/${sid}`;
    if (seen.has(node)) return;
    const comp = []; const q = [node]; seen.add(node);
    while (q.length) {
      const n = q.shift(); comp.push(n);
      (adj[n] || []).forEach(m => { if (!seen.has(m)) { seen.add(m); q.push(m); } });
    }
    const members = comp.map(key => {
      const [cid, studentId] = key.split('/');
      return { centerId: cid, studentId, data: allCentersData[cid]?.students?.[studentId] || null };
    }).filter(m => m.data);
    // Hide families where everyone is Drop/Completer
    const anyActive = members.some(m => !['Drop', 'Completer'].includes(computeStudentStatus(m.data.subjects)));
    if (!anyActive) return;
    // Same-center members first
    members.sort((a, b) => {
      const ac = a.centerId === centerId ? 0 : 1, bc = b.centerId === centerId ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return (a.data.namePinyin || '').localeCompare(b.data.namePinyin || '');
    });
    const key = members.map(m => `${m.centerId}|${m.studentId}`).sort().join('|');
    familiesCache.push({ key, members });
  });

  familiesCache.sort((a, b) => familyDisplayName(a).localeCompare(familyDisplayName(b)));
}

function familyDisplayName(fam) {
  return fam.members.map(m => m.data.nameCn || m.data.namePinyin || '?').join('、');
}
// ✅ members are stored NESTED: { centerId: { studentId: true } }
//    because RTDB keys cannot contain "/", "#", "$", ".", "[", "]"
function buildMembersMap(fam) {
  const members = {};
  fam.members.forEach(m => {
    if (!members[m.centerId]) members[m.centerId] = {};
    members[m.centerId][m.studentId] = true;
  });
  return members;
}
function membersToKeyList(membersMap) {
  const out = [];
  Object.entries(membersMap || {}).forEach(([cid, sids]) => {
    Object.keys(sids || {}).forEach(sid => out.push(`${cid}|${sid}`));
  });
  return out.sort();
}
function familyKeyOfMembers(membersMap) {
  return membersToKeyList(membersMap).join('|');
}
function portalForFamily(fam) {
  return Object.entries(portalsCache).find(([_, p]) => familyKeyOfMembers(p.meta?.members) === fam.key)?.[1] || null;
}

// ============================================
// 🔗 PORTALS REALTIME
// ============================================
function startPortalsSync() {
  if (portalsUnsub) return;
  const pRef = ref(db, `publicFamilyLinks/${centerId}`);
  portalsUnsub = onValue(pRef, (snap) => {
    portalsCache = {};
    if (snap.exists()) {
      snap.forEach(child => {
        const v = child.val() || {};
        portalsCache[child.key] = { token: child.key, meta: v.meta || {}, students: v.students || {}, requests: v.requests || {} };
      });
    }
    renderLinks();
    renderPending();
    sweepExpiredRequests();
    updatePendingNotifications();
    autoHealSnapshots();
  }, (err) => console.error('Portals sync error:', err));
}

window.addEventListener('beforeunload', () => {
  if (ccUnsub) off(ref(db, `centers/${centerId}/classChanges`));
  if (portalsUnsub) off(ref(db, `publicFamilyLinks/${centerId}`));
});

// ============================================
// 🗂 PAGE TABS
// ============================================
function wirePageTabs() {
  document.querySelectorAll('.page-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.page-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['cc', 'links', 'pending'].forEach(id => {
        document.getElementById(`ptab-${id}`).classList.toggle('hidden', id !== btn.dataset.ptab);
      });
      if (btn.dataset.ptab === 'links') renderLinks();
      if (btn.dataset.ptab === 'pending') renderPending();
    });
  });
}

// ============================================
// 🔄 CHANGE CLASSES (original logic, stats removed)
// ============================================
function startRealtimeSync() {
  if (ccUnsub) return;
  const ccRef = ref(db, `centers/${centerId}/classChanges`);
  ccUnsub = onValue(ccRef, (snap) => {
    classChangesCache = [];
    if (snap.exists()) snap.forEach(child => classChangesCache.push({ ...child.val(), id: child.key }));
    renderAll();
  }, (err) => console.error('Realtime sync error:', err));
}

function renderAll() { renderTable(); renderCards(); updateBulkBar(); }

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
      const haystack = [r.nameCn, r.nameEn, r.nickname, r.pinyin, r.studentNumber, r.subject, r.grade, r.school].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (currentFilter.dateFrom) { const d = r.absenceDate || r.replacementDate || ''; if (d < currentFilter.dateFrom) return false; }
    if (currentFilter.dateTo) { const d = r.absenceDate || r.replacementDate || ''; if (d > currentFilter.dateTo) return false; }
    return true;
  }).sort((a, b) => {
    const order = { scheduled: 0, completed: 1, missed: 2, cancelled: 3 };
    const sa = order[a.replacementStatus] ?? 4, sb = order[b.replacementStatus] ?? 4;
    if (sa !== sb) return sa - sb;
    return (b.absenceDate || '').localeCompare(a.absenceDate || '');
  });
}

function renderTable() {
  const tbody = document.getElementById('ccTableBody');
  const empty = document.getElementById('emptyState');
  const records = getFilteredRecords();
  tbody.innerHTML = '';
  if (records.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  records.forEach(r => {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    if (selectedIds.has(r.id)) tr.classList.add('selected');
    tr.classList.add(`row-${r.replacementStatus || 'none'}`);
    const student = allStudentsMap.get(r.studentId);
    const isVisiting = student && student.homeCenterId && student.homeCenterId !== centerId;
    const parentBadge = r.source === 'parent' ? `<span class="parent-src" title="${t('cc.parentBadgeTitle')}">📲</span>` : '';
    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" data-id="${r.id}" ${selectedIds.has(r.id) ? 'checked' : ''}></td>
      <td>
        <div class="student-cell">
          <span class="student-name">
            ${isVisiting ? '<span class="visiting-dot" title="Visiting"></span>' : ''}
            ${escapeHtml(r.nameCn || r.nameEn || 'Unknown')}
            ${r.nickname ? `<span style="color:var(--text-light);font-weight:400;">(${escapeHtml(r.nickname)})</span>` : ''}
            ${parentBadge}
          </span>
          <span class="student-meta">${r.pinyin ? escapeHtml(r.pinyin) : ''} ${r.grade ? `• G${escapeHtml(r.grade)}` : ''} ${r.studentNumber ? `• #${escapeHtml(r.studentNumber)}` : ''}</span>
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
          <button class="action-btn action-view" data-action="view" data-id="${r.id}">👁</button>
          <button class="action-btn action-edit" data-action="edit" data-id="${r.id}">✏️</button>
          ${r.replacementStatus === 'scheduled' ? `<button class="action-btn action-complete" data-action="complete" data-id="${r.id}">✅</button>` : ''}
          ${r.replacementStatus !== 'cancelled' ? `<button class="action-btn action-cancel" data-action="cancel" data-id="${r.id}">🚫</button>` : ''}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); handleRowAction(btn.dataset.action, btn.dataset.id); });
  });
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return; openDetail(tr.dataset.id); });
  });
  tbody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
      e.target.closest('tr').classList.toggle('selected', e.target.checked);
      updateBulkBar(); updateSelectAllCheck();
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
    const parentBadge = r.source === 'parent' ? `<span class="parent-src" title="${t('cc.parentBadgeTitle')}">📲</span>` : '';
    const card = document.createElement('div');
    card.className = `cc-card ${typeClass} cc-${r.replacementStatus || 'none'}`;
    card.dataset.id = r.id;
    card.innerHTML = `
      <div class="cc-card-top">
        <div>
          <div class="cc-card-name">
            ${isVisiting ? '<span class="visiting-dot"></span>' : ''}
            ${escapeHtml(r.nameCn || r.nameEn || 'Unknown')}
            ${r.nickname ? `<span style="color:var(--text-light);font-weight:400;">(${escapeHtml(r.nickname)})</span>` : ''}
            ${parentBadge}
          </div>
          <div class="cc-card-subject">${escapeHtml(r.subject || '')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</div>
        </div>
        <div class="cc-card-badges">
          <span class="type-badge ${getTypeClass(r.type)}">${escapeHtml(formatType(r.type))}</span>
          <span class="status-badge status-${r.replacementStatus || 'none'}">${formatStatus(r.replacementStatus)}</span>
        </div>
      </div>
      <div class="cc-card-dates">
        <div class="cc-card-date-item"><strong>${t('cc.absenceDate')}</strong><span>${formatDate(r.absenceDate)} ${r.originalTime || ''}</span></div>
        <div class="cc-card-date-item"><strong>${t('cc.replacementDate')}</strong><span>${r.replacementDate ? formatDate(r.replacementDate) + ' ' + (r.replacementTime || '') : '—'}</span></div>
      </div>
      ${r.note ? `<div style="font-size:0.82rem;color:var(--text-light);background:#f8fafc;padding:0.5rem;border-radius:6px;margin-top:0.3rem;">📝 ${escapeHtml(r.note)}</div>` : ''}
      <div class="cc-card-actions">
        <button class="action-btn action-view" data-action="view" data-id="${r.id}">👁 ${t('cc.view')}</button>
        <button class="action-btn action-edit" data-action="edit" data-id="${r.id}">✏️ ${t('cc.edit')}</button>
        ${r.replacementStatus === 'scheduled' ? `<button class="action-btn action-complete" data-action="complete" data-id="${r.id}">✅ ${t('cc.markComplete')}</button>` : ''}
        ${r.replacementStatus !== 'cancelled' ? `<button class="action-btn action-cancel" data-action="cancel" data-id="${r.id}">🚫 ${t('cc.cancel')}</button>` : ''}
      </div>`;
    container.appendChild(card);
  });
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); handleRowAction(btn.dataset.action, btn.dataset.id); });
  });
  container.querySelectorAll('.cc-card').forEach(card => {
    card.addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') return; openDetail(card.dataset.id); });
  });
}

// ============================================
// HELPERS
// ============================================
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatDate(d) { return d || '—'; }
function formatType(tp) { return { 'CC_PU': 'CC PU', 'CC_NO_PU': 'CC No PU', 'MC': 'MC', 'MC_PU': 'MC PU' }[tp] || tp || '-'; }
function getTypeClass(tp) { return tp && tp.startsWith('CC') ? 'type-cc' : 'type-mc'; }
function formatStatus(s) {
  return { 'scheduled': t('cc.statusScheduled'), 'completed': t('cc.statusCompleted'), 'missed': t('cc.statusMissed'), 'cancelled': t('cc.statusCancelled') }[s] || s || '—';
}
function formatReplacementCell(r) {
  if (!r.replacementDate && !r.replacementTime) return '—';
  return `${formatDate(r.replacementDate)} ${r.replacementTime || ''}`;
}
function randomToken(len = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const a = new Uint8Array(len); crypto.getRandomValues(a);
  return [...a].map(x => chars[x % chars.length]).join('');
}
function randomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(4); crypto.getRandomValues(a);
  return [...a].map(x => chars[x % chars.length]).join('');
}
function parentPageUrl(token) {
  const dir = location.pathname.substring(0, location.pathname.lastIndexOf('/') + 1);
  return `${location.origin}${dir}parent-request.html?c=${encodeURIComponent(centerId)}&t=${encodeURIComponent(token)}`;
}

// ============================================
// FILTERS / BULK / ROW ACTIONS (unchanged logic)
// ============================================
function wireFilters() {
  document.querySelectorAll('#statusSegmented .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#statusSegmented .segment').forEach(s => s.classList.remove('active'));
      seg.classList.add('active');
      currentFilter.status = seg.dataset.status;
      renderAll();
    });
  });
  document.getElementById('searchInput').addEventListener('input', (e) => { currentFilter.search = e.target.value.trim(); renderAll(); });
  document.getElementById('dateFrom').addEventListener('change', (e) => { currentFilter.dateFrom = e.target.value; renderAll(); });
  document.getElementById('dateTo').addEventListener('change', (e) => { currentFilter.dateTo = e.target.value; renderAll(); });
  document.getElementById('clearDatesBtn').addEventListener('click', () => {
    document.getElementById('dateFrom').value = ''; document.getElementById('dateTo').value = '';
    currentFilter.dateFrom = ''; currentFilter.dateTo = ''; renderAll();
  });
  document.getElementById('typeFilter').addEventListener('change', (e) => { currentFilter.type = e.target.value; renderAll(); });
  document.getElementById('subjectFilter').addEventListener('change', (e) => { currentFilter.subject = e.target.value; renderAll(); });
}

function wireSelectAll() {
  document.getElementById('selectAllCheck').addEventListener('change', (e) => {
    const records = getFilteredRecords();
    if (e.target.checked) records.forEach(r => selectedIds.add(r.id)); else selectedIds.clear();
    renderTable(); updateBulkBar();
  });
}
function updateSelectAllCheck() {
  const records = getFilteredRecords();
  const allCheck = document.getElementById('selectAllCheck');
  if (records.length === 0) { allCheck.checked = false; allCheck.indeterminate = false; return; }
  const cnt = records.filter(r => selectedIds.has(r.id)).length;
  allCheck.checked = cnt === records.length;
  allCheck.indeterminate = cnt > 0 && cnt < records.length;
}
function wireBulkActions() {
  document.getElementById('bulkCompleteBtn').addEventListener('click', async () => {
    if (!selectedIds.size) return;
    if (!await showConfirm(t('cc.bulkCompleteTitle'), t('cc.bulkCompleteMsg', { count: selectedIds.size }))) return;
    await bulkUpdateStatus('completed');
  });
  document.getElementById('bulkCancelBtn').addEventListener('click', async () => {
    if (!selectedIds.size) return;
    if (!await showConfirm(t('cc.bulkCancelTitle'), t('cc.bulkCancelMsg', { count: selectedIds.size }))) return;
    await bulkUpdateStatus('cancelled');
  });
  document.getElementById('bulkClearBtn').addEventListener('click', () => {
    selectedIds.clear(); renderTable(); updateBulkBar(); updateSelectAllCheck();
  });
}
function updateBulkBar() {
  const bar = document.getElementById('bulkActions');
  if (selectedIds.size > 0) {
    bar.classList.remove('hidden');
    document.getElementById('bulkCount').textContent = t('cc.selectedCount', { count: selectedIds.size });
  } else bar.classList.add('hidden');
}
async function bulkUpdateStatus(status) {
  const updates = {}; const now = new Date().toISOString();
  selectedIds.forEach(id => {
    updates[`${id}/replacementStatus`] = status;
    updates[`${id}/updatedAt`] = now;
    if (status === 'completed') updates[`${id}/completedAt`] = now;
  });
  try {
    await update(ref(db, `centers/${centerId}/classChanges`), updates);
    showToast(t('cc.bulkSuccess', { count: selectedIds.size }), 'success');
    selectedIds.clear(); updateBulkBar(); updateSelectAllCheck();
  } catch (err) { console.error('Bulk update failed:', err); showToast(t('cc.bulkFailed'), 'error'); }
}

async function handleRowAction(action, id) {
  const record = classChangesCache.find(r => r.id === id);
  if (!record) return;
  switch (action) {
    case 'view': openDetail(id); break;
    case 'edit': openAddEditModal(id); break;
    case 'complete': {
      if (!await showConfirm(t('cc.completeTitle'), t('cc.completeMsg', { name: record.nameCn || record.nameEn }))) return;
      await updateRecord(id, { replacementStatus: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      showToast(t('cc.completedSuccess'), 'success');
      break;
    }
    case 'cancel': {
      if (!await showConfirm(t('cc.cancelTitle'), t('cc.cancelMsg', { name: record.nameCn || record.nameEn }))) return;
      await updateRecord(id, { replacementStatus: 'cancelled', updatedAt: new Date().toISOString() });
      showToast(t('cc.cancelledSuccess'), 'success');
      break;
    }
  }
}
async function updateRecord(id, updates) {
  try { await update(ref(db, `centers/${centerId}/classChanges/${id}`), updates); }
  catch (err) { console.error('Update failed:', err); showToast(t('cc.updateFailed'), 'error'); }
}

// ============================================
// ADD / EDIT MODAL (unchanged)
// ============================================
function wireAddEditModal() {
  document.getElementById('addRequestBtn').addEventListener('click', () => openAddEditModal(null));
  document.getElementById('closeCcModal').addEventListener('click', closeAddEditModal);
  document.getElementById('cancelCcBtn').addEventListener('click', closeAddEditModal);
  document.getElementById('ccModal').addEventListener('click', (e) => { if (e.target.id === 'ccModal') closeAddEditModal(); });

  const searchInput = document.getElementById('studentSearch');
  const resultsDiv = document.getElementById('studentResults');
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { resultsDiv.classList.add('hidden'); return; }
    const matches = allStudents.filter(s => {
      if (!hasCurrentSubjects(s)) return false;
      const hay = [s.nameCn, s.namePinyin, s.nickname, s.studentNumber, s.grade, s.school].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    }).slice(0, 15);
    renderStudentResults(matches);
  });
  searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) searchInput.dispatchEvent(new Event('input')); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrapper')) resultsDiv.classList.add('hidden'); });

  document.getElementById('changeStudentBtn').addEventListener('click', () => {
    selectedStudent = null;
    document.getElementById('selectedStudentId').value = '';
    document.getElementById('selectedStudentInfo').classList.add('hidden');
    searchInput.value = ''; searchInput.focus();
    populateSubjects(null);
  });

  document.getElementById('typeSelect').addEventListener('change', (e) => {
    const isCC = e.target.value.startsWith('CC');
    document.getElementById('ccForm').classList.toggle('hide-replacement', !isCC);
    document.getElementById('replacementDate').required = isCC;
    document.getElementById('replacementTime').required = isCC;
    if (e.target.value === 'CC_PU' || e.target.value === 'MC_PU') document.getElementById('homeworkPU').checked = true;
  });

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
    item.innerHTML = `<div class="search-result-name">${escapeHtml(s.nameCn || 'Unknown')} ${s.nickname ? `(${escapeHtml(s.nickname)})` : ''}</div>
      <div class="search-result-meta">${s.namePinyin || ''} ${s.grade ? `• G${s.grade}` : ''} ${s.studentNumber ? `• #${s.studentNumber}` : ''}</div>`;
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
  document.getElementById('selectedStudentName').textContent = `${s.nameCn || 'Unknown'} ${s.nickname ? `(${s.nickname})` : ''}`;
  document.getElementById('selectedStudentMeta').textContent = [s.namePinyin, s.grade ? `Grade ${s.grade}` : '', s.studentNumber ? `#${s.studentNumber}` : '', s.school].filter(Boolean).join(' • ');
  document.getElementById('selectedStudentInfo').classList.remove('hidden');
  populateSubjects(s);
}
function populateSubjects(student) {
  const select = document.getElementById('subjectSelect');
  select.innerHTML = `<option value="">${t('cc.selectSubject')}</option>`;
  if (!student) return;
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
    const r = classChangesCache.find(x => x.id === id);
    if (!r) return;
    document.getElementById('ccModalTitle').textContent = t('cc.editTitle');
    document.getElementById('absenceDate').value = r.absenceDate || '';
    document.getElementById('originalTime').value = r.originalTime || '';
    document.getElementById('replacementDate').value = r.replacementDate || '';
    document.getElementById('replacementTime').value = r.replacementTime || '';
    document.getElementById('typeSelect').value = r.type || 'CC_NO_PU';
    document.getElementById('statusSelect').value = r.replacementStatus || 'scheduled';
    document.getElementById('homeworkPU').checked = !!r.homeworkPickedUp;
    document.getElementById('noteInput').value = r.note || '';
    const s = allStudentsMap.get(r.studentId);
    if (s) selectStudentForForm(s);
    setTimeout(() => {
      const select = document.getElementById('subjectSelect');
      if (r.subject && !Array.from(select.options).some(o => o.value === r.subject)) {
        const opt = document.createElement('option');
        opt.value = r.subject; opt.textContent = `${r.subject} (${r.subjectLevel || '-'})`; opt.dataset.level = r.subjectLevel || '';
        select.appendChild(opt);
      }
      select.value = r.subject || '';
    }, 50);
    form.classList.toggle('hide-replacement', !(r.type || '').startsWith('CC'));
  } else {
    document.getElementById('ccModalTitle').textContent = t('cc.addTitle');
    document.getElementById('statusSelect').value = 'scheduled';
  }
  document.getElementById('ccModal').classList.remove('hidden');
}
function closeAddEditModal() {
  document.getElementById('ccModal').classList.add('hidden');
  editingId = null; selectedStudent = null;
}
async function handleFormSubmit(e) {
  e.preventDefault();
  const studentId = document.getElementById('selectedStudentId').value;
  if (!studentId) return showToast(t('cc.selectStudentFirst'), 'error');
  const student = allStudentsMap.get(studentId);
  if (!student) return;
  const subjectSelect = document.getElementById('subjectSelect');
  const subject = subjectSelect.value;
  const subjectLevel = subjectSelect.selectedOptions[0]?.dataset?.level || '';
  if (!subject) return showToast(t('cc.selectSubjectFirst'), 'error');
  const type = document.getElementById('typeSelect').value;
  const isCC = type.startsWith('CC');
  const absenceDate = document.getElementById('absenceDate').value;
  const originalTime = document.getElementById('originalTime').value;
  const replacementDate = isCC ? document.getElementById('replacementDate').value : '';
  const replacementTime = isCC ? document.getElementById('replacementTime').value : '';
  if (!absenceDate) return showToast(t('cc.selectAbsenceDate'), 'error');
  if (isCC && (!replacementDate || !replacementTime)) return showToast(t('cc.selectReplacement'), 'error');

  const saveBtn = document.getElementById('saveCcBtn');
  saveBtn.disabled = true; saveBtn.textContent = t('common.saving');
  try {
    const now = new Date().toISOString();
    const payload = {
      studentId,
      studentNumber: student.studentNumber || '',
      nameCn: student.nameCn || '',
      nameEn: student.namePinyin || '',
      nickname: student.nickname || '',
      grade: student.grade || '',
      school: student.school || '',
      pinyin: student.namePinyin || '',
      subject, subjectLevel, type, absenceDate, originalTime,
      replacementDate, replacementTime,
      replacementStatus: document.getElementById('statusSelect').value,
      homeworkPickedUp: document.getElementById('homeworkPU').checked,
      note: document.getElementById('noteInput').value.trim(),
      homeCenterId: student.homeCenterId || centerId,
      homeCenterName: student.homeCenterName || '',
      isVisiting: !!(student.homeCenterId && student.homeCenterId !== centerId),
      updatedAt: now
    };
    if (editingId) {
      const existing = classChangesCache.find(r => r.id === editingId);
      const history = Array.isArray(existing?.history) ? [...existing.history] : [];
      history.push({ at: now, by: auth.currentUser?.email || '', action: 'edited' });
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
    saveBtn.disabled = false; saveBtn.textContent = t('cc.save');
  }
}

// ============================================
// DETAIL MODAL (unchanged)
// ============================================
function wireDetailModal() {
  document.getElementById('closeDetailModal').addEventListener('click', closeDetailModal);
  document.getElementById('closeDetailBtn').addEventListener('click', closeDetailModal);
  document.getElementById('detailModal').addEventListener('click', (e) => { if (e.target.id === 'detailModal') closeDetailModal(); });
  document.getElementById('editDetailBtn').addEventListener('click', () => {
    if (!currentDetailId) return;
    closeDetailModal();
    setTimeout(() => openAddEditModal(currentDetailId), 150);
  });
  document.getElementById('deleteDetailBtn').addEventListener('click', async () => {
    if (!currentDetailId) return;
    if (!await showConfirm(t('cc.deleteTitle'), t('cc.deleteMsg'))) return;
    try {
      await remove(ref(db, `centers/${centerId}/classChanges/${currentDetailId}`));
      showToast(t('cc.deleteSuccess'), 'success');
      closeDetailModal();
    } catch (err) { console.error('Delete failed:', err); showToast(t('cc.deleteFailed'), 'error'); }
  });
}
function openDetail(id) {
  const r = classChangesCache.find(x => x.id === id);
  if (!r) return;
  currentDetailId = id;
  const history = Array.isArray(r.history) ? r.history : [];
  const historyHtml = history.length > 0
    ? `<div class="history-timeline">${history.slice().reverse().map(h => `
        <div class="history-item">
          <div class="history-date">${new Date(h.at).toLocaleString()} — ${escapeHtml(h.action || '')}</div>
          <div class="history-reason">${escapeHtml(h.by || '')}</div>
        </div>`).join('')}</div>`
    : `<div class="history-empty">${t('cc.noHistory')}</div>`;
  const parentLine = r.source === 'parent' ? `<div class="detail-item full-width"><strong>${t('cc.parentBadgeTitle')}</strong><span>📲 ${escapeHtml(r.parentRequestId || '')}</span></div>` : '';
  document.getElementById('detailContent').innerHTML = `
    <div class="detail-section"><h4>👤 ${t('cc.detailStudent')}</h4>
      <div class="detail-grid">
        <div class="detail-item"><strong>${t('cc.name')}</strong><span>${escapeHtml(r.nameCn || r.nameEn || 'Unknown')} ${r.nickname ? `(${escapeHtml(r.nickname)})` : ''}</span></div>
        <div class="detail-item"><strong>${t('cc.pinyin')}</strong><span>${escapeHtml(r.pinyin || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.grade')}</strong><span>${escapeHtml(r.grade || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.studentNumber')}</strong><span>${escapeHtml(r.studentNumber || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.school')}</strong><span>${escapeHtml(r.school || '-')}</span></div>
        <div class="detail-item"><strong>${t('cc.homeCenter')}</strong><span>${escapeHtml(r.homeCenterName || '-')}</span></div>
      </div>
    </div>
    <div class="detail-section"><h4>📋 ${t('cc.detailChangeClass')}</h4>
      <div class="detail-grid">
        <div class="detail-item"><strong>${t('cc.subject')}</strong><span>${escapeHtml(r.subject || '-')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</span></div>
        <div class="detail-item"><strong>${t('cc.type')}</strong><span><span class="type-badge ${getTypeClass(r.type)}">${escapeHtml(formatType(r.type))}</span></span></div>
        <div class="detail-item"><strong>${t('cc.status')}</strong><span><span class="status-badge status-${r.replacementStatus || 'none'}">${formatStatus(r.replacementStatus)}</span></span></div>
        <div class="detail-item"><strong>${t('cc.homeworkPU')}</strong><span>${r.homeworkPickedUp ? '✓' : '—'}</span></div>
        <div class="detail-item"><strong>${t('cc.absenceDate')}</strong><span>${formatDate(r.absenceDate)} ${r.originalTime || ''}</span></div>
        <div class="detail-item"><strong>${t('cc.replacementDate')}</strong><span>${r.replacementDate ? formatDate(r.replacementDate) + ' ' + (r.replacementTime || '') : '—'}</span></div>
        ${r.note ? `<div class="detail-item full-width"><strong>${t('cc.note')}</strong><span>${escapeHtml(r.note)}</span></div>` : ''}
        ${parentLine}
      </div>
    </div>
    <div class="detail-section"><h4>📜 ${t('cc.historyTimeline')}</h4>${historyHtml}</div>`;
  document.getElementById('detailModal').classList.remove('hidden');
}
function closeDetailModal() {
  document.getElementById('detailModal').classList.add('hidden');
  currentDetailId = null;
}

// ============================================
// EXPORT (CC)
// ============================================
function wireExport() { document.getElementById('exportBtn').addEventListener('click', exportToExcel); }
function exportToExcel() {
  const records = getFilteredRecords();
  if (records.length === 0) return showToast(t('cc.nothingToExport'), 'error');
  const rows = records.map(r => ({
    'Student': r.nameCn || r.nameEn || '', 'Nickname': r.nickname || '', 'Pinyin': r.pinyin || '',
    'Grade': r.grade || '', 'Student #': r.studentNumber || '', 'Subject': r.subject || '',
    'Level': r.subjectLevel || '', 'Type': formatType(r.type), 'Absence Date': r.absenceDate || '',
    'Original Time': r.originalTime || '', 'Replacement Date': r.replacementDate || '',
    'Replacement Time': r.replacementTime || '', 'Status': formatStatus(r.replacementStatus),
    'PU': r.homeworkPickedUp ? 'Yes' : 'No', 'Note': r.note || '',
    'Source': r.source === 'parent' ? '📲 Parent' : 'Staff'
  }));
  downloadExcel(rows, `Change_Classes_${new Date().toISOString().slice(0, 10)}.xls`);
  showToast(t('cc.exportSuccess'), 'success');
}
function downloadExcel(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  let html = '<table><thead><tr>';
  headers.forEach(h => html += `<th>${escapeHtml(h)}</th>`);
  html += '</tr></thead><tbody>';
  rows.forEach(r => {
    html += '<tr>';
    headers.forEach(h => html += `<td>${escapeHtml(r[h] || '')}</td>`);
    html += '</tr>';
  });
  html += '</tbody></table>';
  const css = `<style>table{border-collapse:collapse;font-family:Arial;font-size:10pt;}th{background:#4682B4!important;color:#fff!important;padding:6px 8px;border:1px solid #333;}td{padding:4px 6px;border:1px solid #ccc;}</style>`;
  const doc = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8">${css}</head><body>${html}</body></html>`;
  const blob = new Blob([doc], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ============================================
// 🔗 LINKS TAB
// ============================================
function wireLinks() {
  document.querySelectorAll('#linksSegmented .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#linksSegmented .segment').forEach(s => s.classList.remove('active'));
      seg.classList.add('active');
      linksFilter.seg = seg.dataset.lseg;
      renderLinks();
    });
  });
  document.getElementById('linksSearch').addEventListener('input', (e) => { linksFilter.search = e.target.value.trim(); renderLinks(); });

  document.getElementById('closeLinkCard').addEventListener('click', () => document.getElementById('linkCardModal').classList.add('hidden'));
  document.getElementById('linkCardModal').addEventListener('click', (e) => { if (e.target.id === 'linkCardModal') e.target.classList.add('hidden'); });
  document.getElementById('closePhoneModal').addEventListener('click', () => document.getElementById('phoneModal').classList.add('hidden'));
}

function getVisibleFamilies() {
  return familiesCache.filter(fam => {
    const portal = portalForFamily(fam);
    if (linksFilter.seg === 'hasLink' && (!portal || portal.meta.active === false)) return false;
    if (linksFilter.seg === 'noLink' && portal) return false;
    if (linksFilter.seg === 'disabled' && (!portal || portal.meta.active !== false)) return false;
    if (linksFilter.search) {
      const q = linksFilter.search.toLowerCase();
      const hay = fam.members.flatMap(m => [m.data.nameCn, m.data.namePinyin, m.data.studentNumber, m.data.nickname]).filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderLinks() {
  const tbody = document.getElementById('linksTableBody');
  const cards = document.getElementById('linksCards');
  const empty = document.getElementById('linksEmpty');
  const fams = getVisibleFamilies();
  tbody.innerHTML = ''; cards.innerHTML = '';

  if (fams.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  fams.forEach(fam => {
    const portal = portalForFamily(fam);
    const tr = document.createElement('tr');
    if (!portal) tr.classList.add('no-link');
    tr.innerHTML = `
      <td><div class="family-cell">
        <span class="family-name">${escapeHtml(familyDisplayName(fam))}</span>
        <span class="family-sub">${fam.members.map(m => escapeHtml(m.data.namePinyin || '')).filter(Boolean).join(', ')}</span>
      </div></td>
      <td>${fam.members.length}</td>
      <td>${portal
        ? (portal.meta.active === false
          ? `<span class="link-status-badge ls-disabled">${t('links.statusDisabled')}</span>`
          : `<span class="link-status-badge ls-active">${t('links.statusActive')}</span>`)
        : `<span class="link-status-badge ls-none">${t('links.statusNoLink')}</span>`}</td>
      <td>${portal ? `<span class="code-chip">${escapeHtml(portal.meta.code || '')}</span>` : '—'}</td>
      <td>${portal?.meta.createdAt ? new Date(portal.meta.createdAt).toLocaleDateString() : '—'}</td>
      <td><div class="link-actions">
        ${portal ? `<button class="lc-btn" data-la="card" data-fam="${fam.key}">📇 ${t('links.openCard')}</button>` : ''}
        <button class="lc-btn ${portal ? 'warn' : 'gen'}" data-la="gen" data-fam="${fam.key}">${portal ? `♻️ ${t('links.regenerate')}` : `✨ ${t('links.generate')}`}</button>
        ${portal ? `<button class="lc-btn warn" data-la="toggle" data-fam="${fam.key}">${portal.meta.active === false ? `▶️ ${t('links.enable')}` : `⏸ ${t('links.disable')}`}</button>` : ''}
      </div></td>`;
    tbody.appendChild(tr);

    const card = document.createElement('div');
    card.className = `link-card ${portal ? '' : 'no-link'}`;
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:flex-start;">
        <div>
          <div class="cc-card-name">${escapeHtml(familyDisplayName(fam))}</div>
          <div class="family-sub">${fam.members.map(m => `${escapeHtml(m.data.namePinyin || m.data.nameCn || '')}${m.centerId !== centerId ? ' 🏫' : ''}`).join(' • ')}</div>
        </div>
        ${portal
          ? (portal.meta.active === false ? `<span class="link-status-badge ls-disabled">${t('links.statusDisabled')}</span>` : `<span class="link-status-badge ls-active">${t('links.statusActive')}</span>`)
          : `<span class="link-status-badge ls-none">${t('links.statusNoLink')}</span>`}
      </div>
      ${portal ? `<div style="margin:0.4rem 0;"><span class="code-chip">${escapeHtml(portal.meta.code || '')}</span></div>` : ''}
      <div class="link-actions" style="margin-top:0.5rem;">
        ${portal ? `<button class="lc-btn" data-la="card" data-fam="${fam.key}">📇 ${t('links.openCard')}</button>` : ''}
        <button class="lc-btn ${portal ? 'warn' : 'gen'}" data-la="gen" data-fam="${fam.key}">${portal ? `♻️ ${t('links.regenerate')}` : `✨ ${t('links.generate')}`}</button>
        ${portal ? `<button class="lc-btn warn" data-la="toggle" data-fam="${fam.key}">${portal.meta.active === false ? `▶️ ${t('links.enable')}` : `⏸ ${t('links.disable')}`}</button>` : ''}
      </div>`;
    cards.appendChild(card);
  });

  document.querySelectorAll('[data-la]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const fam = familiesCache.find(f => f.key === btn.dataset.fam);
      if (!fam) return;
      const action = btn.dataset.la;
      if (action === 'card') openLinkCardModal(fam);
      if (action === 'gen') await generateOrRegenerate(fam);
      if (action === 'toggle') await togglePortal(fam);
    });
  });
}

function buildSnapshot(fam) {
  const students = {};
  fam.members.forEach(m => {
    const s = m.data;
    students[m.studentId] = {
      v: SNAPSHOT_VERSION,
      centerId: m.centerId,
      centerName: allCentersData[m.centerId]?.name || '',
      nameCn: s.nameCn || '', namePinyin: s.namePinyin || '', nickname: s.nickname || '',
      grade: s.grade || '', school: s.school || '', studentNumber: s.studentNumber || '',
      subjects: getCurrentSubjects(s).map(sub => ({
        name: sub.name,
        level: sub.currentLevel || sub.startLevel || '',
        timeslots: (sub.timeslots || []).map(ts => ({
          center: ts.center || '',
          centerName: allCentersData[ts.center]?.name || '',
          day: ts.day || '',
          time: ts.time || ''
        }))
      }))
    };
  });
  return students;
}

// 🩺 Auto-repair stale snapshots (e.g. links created before center info existed)
async function autoHealSnapshots() {
  try {
    for (const [token, p] of Object.entries(portalsCache)) {
      const stale = Object.values(p.students || {}).some(s => (s.v || 1) < SNAPSHOT_VERSION);
      if (!stale) continue;
      const fam = familiesCache.find(f => familyKeyOfMembers(p.meta?.members) === f.key);
      if (!fam) continue;
      await set(ref(db, `publicFamilyLinks/${centerId}/${token}/students`), buildSnapshot(fam));
      await update(ref(db, `publicFamilyLinks/${centerId}/${token}/meta`), { lastSyncedAt: new Date().toISOString() });
      console.log(`🩺 Auto-healed stale snapshot for family link ${token}`);
    }
  } catch (err) { console.error('Auto-heal snapshots failed:', err); }
}

async function generateOrRegenerate(fam) {
  const existing = portalForFamily(fam);
  const now = new Date().toISOString();
  const uid = auth.currentUser?.uid || '';
  const membersMap = buildMembersMap(fam);

  if (existing) {
    if (!await showConfirm(t('links.regenerate'), t('links.regenerateConfirm'))) return;
    const newToken = randomToken();
    const base = `publicFamilyLinks/${centerId}`;
    const updates = {};
    updates[`${base}/${newToken}/meta`] = {
      ...existing.meta, code: randomCode(), active: true,
      createdAt: now, createdBy: uid, familyKey: fam.key, members: membersMap,
      centerName: allCentersData[centerId]?.name || ''
    };
    updates[`${base}/${newToken}/students`] = buildSnapshot(fam);
    Object.entries(existing.requests || {}).forEach(([rid, r]) => { updates[`${base}/${newToken}/requests/${rid}`] = r; });
    updates[`${base}/${existing.token}`] = null;
    try {
      await update(ref(db), updates);
      showToast(t('links.regenerated'), 'success');
    } catch (err) { console.error(err); showToast(t('cc.saveFailed'), 'error'); }
  } else {
    const token = randomToken();
    const payload = {
      meta: {
        familyId: 'fam_' + randomToken(8), code: randomCode(), active: true,
        createdAt: now, createdBy: uid, familyKey: fam.key, members: membersMap,
        centerName: allCentersData[centerId]?.name || ''
      },
      students: buildSnapshot(fam)
    };
    try {
      await set(ref(db, `publicFamilyLinks/${centerId}/${token}`), payload);
      showToast(t('links.generated'), 'success');
      setTimeout(() => {
        const fam2 = familiesCache.find(f => f.key === fam.key);
        if (fam2) openLinkCardModal(fam2);
      }, 600);
    } catch (err) { console.error(err); showToast(t('cc.saveFailed'), 'error'); }
  }
}

async function togglePortal(fam) {
  const portal = portalForFamily(fam);
  if (!portal) return;
  const disabling = portal.meta.active !== false;
  if (!await showConfirm(disabling ? t('links.disable') : t('links.enable'), disabling ? t('links.disableConfirm') : t('links.enableConfirm'))) return;
  try {
    await update(ref(db, `publicFamilyLinks/${centerId}/${portal.token}/meta`), { active: !disabling });
  } catch (err) { console.error(err); showToast(t('cc.saveFailed'), 'error'); }
}

// — Link card modal —
function openLinkCardModal(fam) {
  const portal = portalForFamily(fam);
  if (!portal) return;
  currentCardFamilyKey = fam.key;
  const modal = document.getElementById('linkCardModal');
  document.getElementById('lcFamilyName').textContent = familyDisplayName(fam);
  document.getElementById('lcStatusRow').innerHTML = portal.meta.active === false
    ? `<span class="link-status-badge ls-disabled">${t('links.statusDisabled')}</span>`
    : `<span class="link-status-badge ls-active">${t('links.statusActive')}</span>`;
  const url = parentPageUrl(portal.token);
  document.getElementById('lcLink').value = url;
  document.getElementById('lcCode').value = portal.meta.code || '';

  const qrDiv = document.getElementById('lcQr');
  qrDiv.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrDiv, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
  }

  document.getElementById('lcToggleActive').innerHTML = portal.meta.active === false
    ? `▶️ ${t('links.enable')}` : `⏸ ${t('links.disable')}`;

  document.getElementById('lcCopyLink').onclick = () => copyText(url, t('links.copied'));
  document.getElementById('lcCopyCode').onclick = () => copyText(portal.meta.code, t('links.copied'));
  document.getElementById('lcWhatsapp').onclick = () => sendViaPhone(fam, 'wa');
  document.getElementById('lcSms').onclick = () => sendViaPhone(fam, 'sms');
  document.getElementById('lcEmail').onclick = () => sendViaEmail(fam);
  document.getElementById('lcShare').onclick = async () => {
    const msg = buildShareMessage(fam, portal);
    if (navigator.share) {
      try { await navigator.share({ title: t('links.shareMsgTitle'), text: msg, url }); } catch {}
    } else copyText(msg, t('links.copied'));
  };
  document.getElementById('lcPrint').onclick = () => printLinkCard(fam, portal);
  document.getElementById('lcSync').onclick = async () => {
    await loadAllCentersData(); buildFamilies();
    const fam2 = familiesCache.find(f => f.key === fam.key) || fam;
    const p2 = portalForFamily(fam2);
    if (p2) {
      try {
        await set(ref(db, `publicFamilyLinks/${centerId}/${p2.token}/students`), buildSnapshot(fam2));
        await update(ref(db, `publicFamilyLinks/${centerId}/${p2.token}/meta`), { lastSyncedAt: new Date().toISOString() });
        showToast(t('links.syncDone'), 'success');
      } catch (err) { console.error(err); showToast(t('cc.saveFailed'), 'error'); }
    }
  };
  document.getElementById('lcToggleActive').onclick = async () => { await togglePortal(fam); const f2 = familiesCache.find(f => f.key === fam.key); if (f2) openLinkCardModal(f2); };
  document.getElementById('lcRegenerate').onclick = async () => {
    await generateOrRegenerate(fam);
    modal.classList.add('hidden');
  };
  modal.classList.remove('hidden');
}

function buildShareMessage(fam, portal) {
  const names = familyDisplayName(fam);
  const url = parentPageUrl(portal.token);
  return `📎 Kumon 調堂申請連結 / Change-Class Request Link\n👨‍👩‍👧 ${names}\n🔗 ${url}\n🔑 Code 密碼: ${portal.meta.code}\n請妥善保管，請勿外傳 / Please keep this link private.`;
}
function collectFamilyPhones(fam) {
  const out = [];
  fam.members.forEach(m => {
    const p = m.data.phone || {};
    [['mom', 'Mom 媽媽'], ['dad', 'Dad 爸爸'], ['own', 'Student 學生']].forEach(([k, label]) => {
      const raw = String(p[k] || '').trim();
      if (!raw) return;
      let digits = raw.replace(/\D/g, '');
      if (!digits) return;
      if (digits.length === 8) digits = '853' + digits;       // ✅ Macau prefix
      const num = '+' + digits;
      if (!out.some(x => x.num === num)) out.push({ num, label: `${m.data.nameCn || m.data.namePinyin || ''} — ${label}` });
    });
  });
  return out;
}
function sendViaPhone(fam, mode) {
  const portal = portalForFamily(fam);
  if (!portal) return;
  const phones = collectFamilyPhones(fam);
  if (phones.length === 0) return showToast(t('links.noPhone'), 'error');
  const msg = buildShareMessage(fam, portal);
  const open = (num) => {
    const enc = encodeURIComponent(msg);
    window.open(mode === 'wa' ? `https://wa.me/${num.replace('+', '')}?text=${enc}` : `sms:${num}?&body=${enc}`, '_blank');
  };
  if (phones.length === 1) return open(phones[0].num);
  const list = document.getElementById('phoneList');
  list.innerHTML = '';
  phones.forEach(p => {
    const btn = document.createElement('div');
    btn.className = 'phone-option';
    btn.innerHTML = `<span>${escapeHtml(p.num)}</span><small>${escapeHtml(p.label)}</small>`;
    btn.addEventListener('click', () => { document.getElementById('phoneModal').classList.add('hidden'); open(p.num); });
    list.appendChild(btn);
  });
  document.getElementById('phoneModal').classList.remove('hidden');
}
function sendViaEmail(fam) {
  const portal = portalForFamily(fam);
  if (!portal) return;
  const emails = [...new Set(fam.members.map(m => (m.data.email || '').trim()).filter(Boolean))];
  if (emails.length === 0) return showToast(t('links.noEmail'), 'error');
  const msg = buildShareMessage(fam, portal);
  window.open(`mailto:${emails[0]}?subject=${encodeURIComponent(t('links.shareMsgTitle'))}&body=${encodeURIComponent(msg)}`, '_self');
}
function printLinkCard(fam, portal) {
  const url = parentPageUrl(portal.token);
  const area = document.getElementById('printArea');
  area.innerHTML = `<div class="print-card">
    <h2>Kumon</h2>
    <div class="pc-names">${escapeHtml(familyDisplayName(fam))}</div>
    <div class="pc-qr" id="printQr"></div>
    <div>🔑 Code 密碼</div>
    <div class="pc-code">${escapeHtml(portal.meta.code || '')}</div>
    <div class="pc-link">${escapeHtml(url)}</div>
    <div class="pc-note">🔒 ${escapeHtml(t('links.printNote'))}</div>
  </div>`;
  if (typeof QRCode !== 'undefined') {
    new QRCode(document.getElementById('printQr'), { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
  }
  setTimeout(() => window.print(), 250);
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); showToast(okMsg, 'success'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast(okMsg, 'success'); } catch {}
    ta.remove();
  }
}

// ============================================
// ⏳ PENDING TAB
// ============================================
function wirePending() {
  document.querySelectorAll('#pendingSegmented .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#pendingSegmented .segment').forEach(s => s.classList.remove('active'));
      seg.classList.add('active');
      pendingFilter.seg = seg.dataset.pseg;
      renderPending();
    });
  });
  document.getElementById('pendingExportBtn').addEventListener('click', exportPending);
  const notifyBtn = document.getElementById('notifyBtn');
  if (localStorage.getItem('cc_notify') === 'on' && 'Notification' in window && Notification.permission === 'granted') {
    notifyBtn.classList.add('on');
    notifyBtn.innerHTML = `🔔 <span>${t('pending.notifyOn')}</span>`;
  }
  notifyBtn.addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      localStorage.setItem('cc_notify', 'on');
      notifyBtn.classList.add('on');
      notifyBtn.innerHTML = `🔔 <span>${t('pending.notifyOn')}</span>`;
    }
  });
  document.getElementById('closeRejectModal').addEventListener('click', () => document.getElementById('rejectModal').classList.add('hidden'));
  document.getElementById('cancelRejectBtn').addEventListener('click', () => document.getElementById('rejectModal').classList.add('hidden'));
  document.getElementById('confirmRejectBtn').addEventListener('click', confirmReject);
  document.getElementById('closeReqDetail').addEventListener('click', () => document.getElementById('reqDetailModal').classList.add('hidden'));
  document.getElementById('closeReqDetailBtn').addEventListener('click', () => document.getElementById('reqDetailModal').classList.add('hidden'));
}

function allRequests() {
  const out = [];
  Object.entries(portalsCache).forEach(([token, p]) => {
    Object.entries(p.requests || {}).forEach(([id, r]) => {
      out.push({ id, token, portal: p, ...r });
    });
  });
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function renderPending() {
  const tbody = document.getElementById('pendingTableBody');
  const cards = document.getElementById('pendingCards');
  const empty = document.getElementById('pendingEmpty');
  let reqs = allRequests();
  if (pendingFilter.seg !== 'all') reqs = reqs.filter(r => r.status === pendingFilter.seg);
  tbody.innerHTML = ''; cards.innerHTML = '';
  if (reqs.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  reqs.forEach(r => {
    const otherCenter = r.studentCenterId && r.studentCenterId !== centerId;
    const cBadge = otherCenter ? `<span class="center-visit-badge" title="${escapeHtml(r.studentCenterName || '')}">🏫 ${escapeHtml(getCenterAbbr(r.studentCenterName || ''))}</span>` : '';
    const statusPill = `<span class="req-status rq-${r.status || 'pending'}">${reqStatusLabel(r.status)}</span>`;
    const actions = r.status === 'pending'
      ? `<button class="action-btn action-complete" data-pa="approve" data-rid="${r.id}">✅ ${t('pending.approve')}</button>
         <button class="action-btn action-cancel" data-pa="reject" data-rid="${r.id}">🚫 ${t('pending.reject')}</button>`
      : `<button class="action-btn action-view" data-pa="view" data-rid="${r.id}">👁 ${t('pending.view')}</button>`;

    const tr = document.createElement('tr');
    tr.className = `pr-${r.status || 'pending'}`;
    tr.innerHTML = `
      <td>${new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${r.parentEditedAt ? `<span title="${escapeHtml(t('pending.editedByParent'))}"> ✏️</span>` : ''}</td>
      <td><strong>${escapeHtml(cleanName(r.studentName) || cleanName(r.studentNameEn) || 'Unknown')}</strong>${cBadge}<br><small style="color:var(--text-light);">${escapeHtml(r.studentNameEn || '')}</small></td>
      <td>${escapeHtml(r.subject || '')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</td>
      <td>${formatDate(r.absenceDate)}<br><small style="color:var(--text-light);">${escapeHtml(r.originalTime || '')}</small></td>
      <td>${formatDate(r.preferredDate)}<br><small style="color:var(--text-light);">${escapeHtml(r.preferredTime || '')}${r.preferredCenterName ? ` @ ${escapeHtml(r.preferredCenterName)}` : ''}</small></td>
      <td class="reason-cell">${escapeHtml(r.reason || '—')}</td>
      <td>${statusPill}</td>
      <td><div class="action-btn-group">${actions}</div></td>`;
    tbody.appendChild(tr);

    const card = document.createElement('div');
    card.className = `pending-card pc-${r.status || 'pending'}`;
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:0.5rem;">
        <div>
          <div class="cc-card-name">${escapeHtml(cleanName(r.studentName) || cleanName(r.studentNameEn) || 'Unknown')} ${cBadge}</div>
          <div class="cc-card-subject">${escapeHtml(r.subject || '')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</div>
        </div>
        ${statusPill}
      </div>
      <div class="cc-card-dates">
        <div class="cc-card-date-item"><strong>${t('pending.colAbsence')}</strong><span>${formatDate(r.absenceDate)} ${r.originalTime || ''}</span></div>
        <div class="cc-card-date-item"><strong>${t('pending.colPreferred')}</strong><span>${formatDate(r.preferredDate)} ${r.preferredTime || ''}</span></div>
      </div>
      ${r.reason ? `<div class="reason-cell" style="background:#f8fafc;padding:0.4rem;border-radius:6px;">💬 ${escapeHtml(r.reason)}</div>` : ''}
      ${r.status === 'rejected' && rejectReasonText(r) ? `<div class="reason-cell" style="color:#b91c1c;">↩️ ${escapeHtml(rejectReasonText(r))}</div>` : ''}
      <div class="cc-card-actions">${actions}</div>`;
    cards.appendChild(card);
  });

  document.querySelectorAll('[data-pa]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = allRequests().find(x => x.id === btn.dataset.rid);
      if (!r) return;
      if (btn.dataset.pa === 'approve') approveRequest(r);
      if (btn.dataset.pa === 'reject') openRejectModal(r);
      if (btn.dataset.pa === 'view') openReqDetail(r);
    });
  });
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const btn = tr.querySelector('[data-pa]');
      const r = allRequests().find(x => x.id === btn?.dataset.rid);
      if (r) openReqDetail(r);
    });
  });
}

function reqStatusLabel(s) {
  return { pending: t('pending.statusPending'), approved: t('pending.statusApproved'), rejected: t('pending.statusRejected'), expired: t('pending.statusExpired'), cancelled: t('pending.statusCancelled') }[s] || s || '—';
}
function rejectReasonText(r) {
  if (r.rejectReasonKey && r.rejectReasonKey !== 'other') return t(`pending.tpl${r.rejectReasonKey.charAt(0).toUpperCase()}${r.rejectReasonKey.slice(1)}`);
  return r.rejectReason || '';
}
function getCenterAbbr(name) {
  if (!name) return '?';
  const lower = name.toLowerCase();
  const rules = [['pac tat', 'PT'], ['mei keng', 'MK'], ['tap siac', 'TS'], ['champs', 'C']];
  for (const [m, a] of rules) if (lower.includes(m)) return a;
  return (name.replace(/^kumon[\s.-]*/i, '').trim() || name).substring(0, 2).toUpperCase();
}
function cleanName(n) { return (n && n !== '-') ? n : ''; }
function centerKeyAbbr(key) {
  return { 'mei keng': 'MK', 'pac tat': 'PT', 'champs': 'C', 'tap siac': 'TS' }[key] || (key || '').substring(0, 2).toUpperCase();
}

async function approveRequest(r) {
  const msg = `${r.studentName || ''} — ${r.subject || ''}\n${t('cc.absenceDate')}: ${r.absenceDate} ${r.originalTime || ''}\n${t('cc.replacementDate')}: ${r.preferredDate} ${r.preferredTime || ''}`;
  // Duplicate check in the STUDENT's center
  let dup = false;
  try {
    const snap = await get(ref(db, `centers/${r.studentCenterId || centerId}/classChanges`));
    if (snap.exists()) {
      snap.forEach(c => {
        const v = c.val() || {};
        if (v.studentId === r.studentId && v.absenceDate === r.absenceDate && v.replacementStatus !== 'cancelled') dup = true;
      });
    }
  } catch {}
  const warn = dup ? `${t('pending.duplicateWarn')}\n\n` : '';
  if (!await showConfirm(t('pending.approveTitle'), warn + msg)) return;

  try {
    const now = new Date().toISOString();
    const email = auth.currentUser?.email || '';
    const targetCenter = r.studentCenterId || centerId;
    const stu = r.portal.students?.[r.studentId] || {};
    const ccPayload = {
      studentId: r.studentId,
      studentNumber: stu.studentNumber || '',
      nameCn: stu.nameCn || '', nameEn: stu.namePinyin || '', nickname: stu.nickname || '',
      grade: stu.grade || '', school: stu.school || '', pinyin: stu.namePinyin || '',
      subject: r.subject || '', subjectLevel: r.subjectLevel || '',
      type: 'CC_NO_PU',
      absenceDate: r.absenceDate || '', originalTime: r.originalTime || '',
      replacementDate: r.preferredDate || '', replacementTime: r.preferredTime || '',
      replacementStatus: 'scheduled', homeworkPickedUp: false,
      note: r.reason ? `📲 ${r.reason}` : '',
      source: 'parent', parentRequestId: r.id, familyToken: r.token,
      homeCenterId: targetCenter, homeCenterName: stu.centerName || '', isVisiting: false,
      createdAt: now, createdBy: auth.currentUser?.uid || '',
      history: [{ at: now, by: email, action: 'created from parent request' }]
    };
    const newRef = push(ref(db, `centers/${targetCenter}/classChanges`));
    await set(newRef, ccPayload);
    await update(ref(db, `publicFamilyLinks/${centerId}/${r.token}/requests/${r.id}`), {
      status: 'approved', reviewedAt: now, reviewedBy: email, classChangeId: newRef.key
    });
    showToast(t('pending.approvedMsg'), 'success');
  } catch (err) { console.error(err); showToast(t('cc.saveFailed'), 'error'); }
}

function openRejectModal(r) {
  currentRejectReq = r;
  document.getElementById('rejectTemplateSel').value = 'slotFull';
  document.getElementById('rejectCustom').value = '';
  document.getElementById('rejectModal').classList.remove('hidden');
}
async function confirmReject() {
  if (!currentRejectReq) return;
  const key = document.getElementById('rejectTemplateSel').value;
  const custom = document.getElementById('rejectCustom').value.trim();
  if (key === 'other' && !custom) return showToast(t('pending.rejectReasonPh'), 'error');
  try {
    await update(ref(db, `publicFamilyLinks/${centerId}/${currentRejectReq.token}/requests/${currentRejectReq.id}`), {
      status: 'rejected',
      rejectReasonKey: key,
      rejectReason: key === 'other' ? custom : '',
      reviewedAt: new Date().toISOString(),
      reviewedBy: auth.currentUser?.email || ''
    });
    document.getElementById('rejectModal').classList.add('hidden');
    showToast(t('pending.rejectedMsg'), 'success');
  } catch (err) { console.error(err); showToast(t('cc.saveFailed'), 'error'); }
}

function openReqDetail(r) {
  const rejectLine = r.status === 'rejected' ? `<div class="detail-item full-width"><strong>${t('pending.rejectTitle')}</strong><span style="color:#b91c1c;">${escapeHtml(rejectReasonText(r))}</span></div>` : '';
  const timeline = [];
  timeline.push({ at: r.createdAt, label: `📨 ${t('pending.timelineSubmitted')}`, by: '' });
  if (r.status === 'approved') timeline.push({ at: r.reviewedAt, label: `✅ ${t('pending.timelineApproved')}`, by: r.reviewedBy });
  if (r.status === 'rejected') timeline.push({ at: r.reviewedAt, label: `🚫 ${t('pending.timelineRejected')}`, by: r.reviewedBy });
  if (r.status === 'expired') timeline.push({ at: r.expiredAt || r.reviewedAt, label: `⌛ ${t('pending.timelineExpired')}`, by: '' });
  if (r.parentEditedAt) timeline.push({ at: r.parentEditedAt, label: `✏️ ${t('pending.timelineEdited')}`, by: '' });
  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));  document.getElementById('reqDetailContent').innerHTML = `
    <div class="detail-section"><h4>📋 ${t('pending.detailTitle')}</h4>
      <div class="detail-grid">
        <div class="detail-item"><strong>${t('pending.colStudent')}</strong><span>${escapeHtml(r.studentName || '')} ${escapeHtml(r.studentNameEn || '')}</span></div>
        <div class="detail-item"><strong>${t('pending.colSubject')}</strong><span>${escapeHtml(r.subject || '')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</span></div>
        <div class="detail-item"><strong>${t('pending.colAbsence')}</strong><span>${formatDate(r.absenceDate)} ${r.originalTime || ''} (${escapeHtml(r.originalDay || '')})</span></div>
        <div class="detail-item"><strong>${t('pending.colPreferred')}</strong><span>${formatDate(r.preferredDate)} ${r.preferredTime || ''}${r.preferredCenterName ? ` @ ${escapeHtml(r.preferredCenterName)}` : ''}</span></div>
        <div class="detail-item full-width"><strong>${t('pending.colReason')}</strong><span>${escapeHtml(r.reason || '—')}</span></div>
        <div class="detail-item"><strong>${t('pending.colStatus')}</strong><span><span class="req-status rq-${r.status}">${reqStatusLabel(r.status)}</span></span></div>
        ${rejectLine}
      </div>
    </div>
    <div class="detail-section"><h4>📜 ${t('cc.historyTimeline')}</h4>
      <div class="history-timeline">
        ${timeline.filter(x => x.at).map(x => `<div class="history-item"><div class="history-date">${new Date(x.at).toLocaleString()} — ${x.label}</div><div class="history-reason">${escapeHtml(x.by || '')}</div></div>`).join('')}
      </div>
    </div>`;
  document.getElementById('reqDetailModal').classList.remove('hidden');
}

function exportPending() {
  const reqs = allRequests();
  if (reqs.length === 0) return showToast(t('pending.nothingToExport'), 'error');
  const rows = reqs.map(r => ({
    'Received': r.createdAt || '', 'Student': r.studentName || '', 'Pinyin': r.studentNameEn || '',
    'Subject': r.subject || '', 'Level': r.subjectLevel || '',
    'Absence Date': r.absenceDate || '', 'Original Time': r.originalTime || '',
    'Preferred Date': r.preferredDate || '', 'Preferred Time': r.preferredTime || '', 'Preferred Center': r.preferredCenterName || '',
    'Reason': r.reason || '', 'Status': reqStatusLabel(r.status),
    'Reject Reason': rejectReasonText(r), 'Edited By Parent': r.parentEditedAt || '', 'Reviewed By': r.reviewedBy || '',
    'Student Center': r.studentCenterName || ''
  }));
  downloadExcel(rows, `Parent_Requests_${new Date().toISOString().slice(0, 10)}.xls`);
  showToast(t('pending.exportSuccess'), 'success');
}

async function sweepExpiredRequests() {
  const cutoff = Date.now() - EXPIRE_MS;
  const updates = {};
  const now = new Date().toISOString();
  allRequests().forEach(r => {
    if (r.status === 'pending' && r.createdAt && new Date(r.createdAt).getTime() < cutoff) {
      const base = `publicFamilyLinks/${centerId}/${r.token}/requests/${r.id}`;
      updates[`${base}/status`] = 'expired';
      updates[`${base}/expiredAt`] = now;
    }
  });
  if (Object.keys(updates).length) {
    try { await update(ref(db), updates); } catch (err) { console.error('Sweep failed:', err); }
  }
}

function updatePendingNotifications() {
  const pendings = allRequests().filter(r => r.status === 'pending');
  const badge = document.getElementById('pendingBadge');
  if (pendings.length > 0) { badge.textContent = pendings.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
  document.title = pendings.length > 0 ? `(${pendings.length}) ${BASE_TITLE}` : BASE_TITLE;

  if (pendingPrimed && knownPendingIds) {
    pendings.filter(r => !knownPendingIds.has(r.id)).forEach(r => {
      showToast(t('pending.newRequest', { name: r.studentName || '' }), 'success');
      if (localStorage.getItem('cc_notify') === 'on' && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('📲 ' + t('pending.tabTitle'), { body: `${r.studentName || ''} — ${r.subject || ''} ${r.absenceDate || ''}` }); } catch {}
      }
    });
  }
  knownPendingIds = new Set(pendings.map(r => r.id));
  pendingPrimed = true;
}

// ============================================
// CONFIRM MODAL & TOAST
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
let toastTimer = null;
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}
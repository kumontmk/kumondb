import { auth, db } from './auth.js';
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t } from './new-student-list-i18n.js';

await i18nReady.catch(() => {});

const REQUIRED_PERMISSION = 'newStudentList';
const centerId = sessionStorage.getItem('selectedCenter');

const DEFAULT_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
let MONTH_NAMES = [...DEFAULT_MONTHS];

function L(key, def, vars) {
  let s;
  try { s = t(key, { ...(vars || {}), defaultValue: def }); } catch { s = def; }
  if (typeof s !== 'string' || s === key) s = def;
  if (vars) s = s.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s.trim();
}
function refreshMonthNames() {
  let arr;
  try { arr = t('nsl.months', { returnObjects: true }); } catch { arr = null; }
  MONTH_NAMES = (Array.isArray(arr) && arr.length === 12) ? arr.map(m => String(m).trim()) : [...DEFAULT_MONTHS];
}
refreshMonthNames();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const keyOf = (sid, subkey, field) => `${sid}|${subkey}|${field}`;
const selFor = (sid, subkey, field) => `.inline-save[data-sid="${CSS.escape(sid)}"][data-subkey="${CSS.escape(subkey)}"][data-field="${CSS.escape(field)}"]`;
const COMPACT_FIELDS = ['bag', 'admFee', 'refCode'];

let allStudentsData = [];
let viewMode = 'year';
let activeTabMonth = null;
let activeTabYear = null;
let currentDtContext = null;
let currentDts = [];
let pendingDt = null;
let dtSaving = false;
let dirtyChanges = new Map();
let isSaving = false;
let hideSaveBarTimer = null;
const expandedCards = new Set();

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  try {
    const userSnap = await get(ref(db, `users/${user.uid}`));
    if (!userSnap.exists()) { window.location.href = 'index.html'; return; }
    const userData = userSnap.val();
    const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
    const dashPerms = userData.permissions?.dashboardCards || {};
    const hasAccess = isAdmin || dashPerms[REQUIRED_PERMISSION] === true || dashPerms['editStudent'] === true;
    if (hasAccess) {
      document.getElementById('accessDenied')?.classList.add('hidden');
      document.getElementById('mainContent')?.classList.remove('hidden');
      initApp();
    } else {
      document.getElementById('accessDenied')?.classList.remove('hidden');
      document.getElementById('mainContent')?.classList.add('hidden');
      document.getElementById('page-loader')?.classList.add('hidden');
      document.getElementById('backToDashboardBtn')?.addEventListener('click', () => window.location.href = 'dashboard.html');
    }
  } catch (err) {
    console.error('Permission check error:', err);
    window.location.href = 'index.html';
  }
});

function initApp() {
  const filterMonth = document.getElementById('filterMonth');
  const filterYear = document.getElementById('filterYear');
  const viewModeSelect = document.getElementById('viewMode');
  const singleMonthControls = document.getElementById('singleMonthControls');
  const rangeControls = document.getElementById('rangeControls');
  const rangeStartMonthSel = document.getElementById('rangeStartMonth');
  const rangeStartYearSel = document.getElementById('rangeStartYear');
  const rangeEndLabel = document.getElementById('rangeEndLabel');
  const monthTabs = document.getElementById('monthTabs');
  const tbody = document.getElementById('newStudentBody');
  const cardList = document.getElementById('cardList');
  const resultCount = document.getElementById('resultCount');
  const saveActionBar = document.getElementById('saveActionBar');
  const saveChangesBtn = document.getElementById('saveChangesBtn');
  const discardChangesBtn = document.getElementById('discardChangesBtn');
  const saveStatusText = document.getElementById('saveStatusText');
  const dtModal = document.getElementById('dtModal');
  const dtModalBody = document.getElementById('dtModalBody');
  const dtModalStatus = document.getElementById('dtModalStatus');
  const confirmDtBtn = document.getElementById('confirmDtBtn');
  const cancelDtBtn = document.getElementById('cancelDtBtn');
  const cdPopover = document.getElementById('cdPopover');
  const cdPopoverTitle = document.getElementById('cdPopoverTitle');
  const cdPopoverCd1 = document.getElementById('cdPopoverCd1');
  const cdPopoverCd2 = document.getElementById('cdPopoverCd2');
  const tableWrapper = document.getElementById('tableWrapper');
  const hScrollBar = document.getElementById('hScrollBar');
  const hScrollThumb = document.getElementById('hScrollThumb');
  const edgeLeft = document.getElementById('edgeLeft');
  const edgeRight = document.getElementById('edgeRight');
  let cdAnchor = null;
  let hDrag = null;

  function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      if (!el.dataset.i18nDefault) el.dataset.i18nDefault = el.textContent.trim();
      el.textContent = L(el.dataset.i18n, el.dataset.i18nDefault);
    });
  }
  applyStaticI18n();

  /* ---------- Filters & tabs ---------- */
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 2; y <= currentYear + 1; y++) {
    filterYear.innerHTML += `<option value="${y}">${y}</option>`;
    rangeStartYearSel.innerHTML += `<option value="${y}">${y}</option>`;
  }
  MONTH_NAMES.forEach((m, i) => {
    const monthVal = String(i + 1).padStart(2, '0');
    filterMonth.innerHTML += `<option value="${monthVal}">${esc(m)}</option>`;
    rangeStartMonthSel.innerHTML += `<option value="${monthVal}">${esc(m)}</option>`;
  });
  const now = new Date();
  filterMonth.value = String(now.getMonth() + 1).padStart(2, '0');
  filterYear.value = currentYear;
  rangeStartMonthSel.value = String(now.getMonth() + 1).padStart(2, '0');
  rangeStartYearSel.value = currentYear;
  viewModeSelect.value = 'year';

  function updateRangeEndLabel() {
    const startMonth = parseInt(rangeStartMonthSel.value);
    const startYear = parseInt(rangeStartYearSel.value);
    let endMonth = startMonth + 11;
    let endYear = startYear;
    if (endMonth > 12) { endMonth -= 12; endYear += 1; }
    rangeEndLabel.textContent = L('nsl.rangeEnd', '→ {{month}} {{year}}', { month: MONTH_NAMES[endMonth - 1], year: endYear });
  }

  function generateMonthTabs() {
    monthTabs.innerHTML = '';
    const startMonth = parseInt(rangeStartMonthSel.value);
    const startYear = parseInt(rangeStartYearSel.value);
    for (let i = 0; i < 12; i++) {
      let month = startMonth + i;
      let year = startYear;
      if (month > 12) { month -= 12; year += 1; }
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab-btn';
      tab.setAttribute('role', 'tab');
      tab.textContent = `${MONTH_NAMES[month - 1]} ${year}`;
      tab.dataset.month = String(month).padStart(2, '0');
      tab.dataset.year = year;
      tab.addEventListener('click', () => {
        monthTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        tab.classList.add('active');
        activeTabMonth = tab.dataset.month;
        activeTabYear = tab.dataset.year;
        renderTable();
      });
      monthTabs.appendChild(tab);
    }
    const firstTab = monthTabs.querySelector('.tab-btn');
    if (firstTab) firstTab.click();
  }

  viewModeSelect.addEventListener('change', () => {
    viewMode = viewModeSelect.value;
    if (viewMode === 'single') {
      singleMonthControls.classList.remove('hidden');
      rangeControls.classList.add('hidden');
      monthTabs.innerHTML = '';
      activeTabMonth = filterMonth.value;
      activeTabYear = filterYear.value;
    } else {
      singleMonthControls.classList.add('hidden');
      rangeControls.classList.remove('hidden');
      updateRangeEndLabel();
      generateMonthTabs();
    }
    renderTable();
  });
  [rangeStartMonthSel, rangeStartYearSel].forEach(el => el.addEventListener('change', () => {
    updateRangeEndLabel();
    generateMonthTabs();
    renderTable();
  }));
  [filterMonth, filterYear].forEach(el => el.addEventListener('change', () => {
    if (viewMode === 'single') {
      activeTabMonth = filterMonth.value;
      activeTabYear = filterYear.value;
    }
    renderTable();
  }));

  /* ---------- Data ---------- */
  async function loadData() {
    if (!centerId) {
      document.getElementById('page-loader')?.classList.add('hidden');
      tbody.innerHTML = `<tr><td colspan="21" style="text-align:center; padding:2rem; color:#e11d48;">${esc(L('nsl.noCenterSelected', 'No center selected. Please go back to the Dashboard and select a center.'))}</td></tr>`;
      if (cardList) cardList.innerHTML = `<div class="empty-state" style="color:#e11d48;">${esc(L('nsl.noCenterSelected', 'No center selected.'))}</div>`;
      requestAnimationFrame(syncHScroll);
      return;
    }
    try {
      const snap = await get(ref(db, `centers/${centerId}/students`));
      if (snap.exists()) {
        allStudentsData = Object.entries(snap.val()).map(([id, data]) => ({ id, ...data }));
        renderTable();
      } else {
        tbody.innerHTML = `<tr><td colspan="21" style="text-align:center; padding:2rem;">${esc(L('nsl.noStudentsFound', 'No students found.'))}</td></tr>`;
        if (cardList) cardList.innerHTML = `<div class="empty-state">${esc(L('nsl.noStudentsFound', 'No students found.'))}</div>`;
        requestAnimationFrame(syncHScroll);
      }
    } catch (err) {
      console.error('Error loading students:', err);
    } finally {
      document.getElementById('page-loader')?.classList.add('hidden');
    }
  }

  function getSubjectEntries(student) {
    const subjects = student?.subjects;
    if (!subjects) return [];
    if (Array.isArray(subjects)) return subjects.map((value, key) => ({ key: String(key), value: value || {} }));
    return Object.entries(subjects).map(([key, value]) => ({ key: String(key), value: value || {} }));
  }
  function findStudentEntry(sid, subkey) {
    const student = allStudentsData.find(s => s.id === sid);
    if (!student) return null;
    const entry = getSubjectEntries(student).find(e => e.key === subkey);
    if (!entry) return null;
    return { student, entry };
  }
  function assignSubject(student, subkey, value) {
    if (Array.isArray(student.subjects)) {
      const idx = Number(subkey);
      if (Number.isInteger(idx)) student.subjects[idx] = value;
    } else if (student.subjects && typeof student.subjects === 'object') {
      student.subjects[subkey] = value;
    } else {
      student.subjects = { [subkey]: value };
    }
  }
  function baselineValue(sid, subkey, field) {
    const found = findStudentEntry(sid, subkey);
    if (!found) return '';
    let v = found.entry.value[field];
    if (field === 'startDate' && (v === undefined || v === null || v === '')) v = found.entry.value.enrolDate;
    return (v === undefined || v === null) ? '' : String(v);
  }
  function effectiveValue(sid, subkey, field) {
    const c = dirtyChanges.get(keyOf(sid, subkey, field));
    return c ? c.value : baselineValue(sid, subkey, field);
  }
  function normalizeValue(field, value) {
    if (value === '') return null;
    if (field === 'payment1' || field === 'payment2') {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return value;
  }

  function getFilteredEntries() {
    const entries = [];
    allStudentsData.forEach(student => {
      getSubjectEntries(student).forEach(({ key, value: sub }) => {
        if (!sub.enrolDate) return;
        const date = new Date(sub.enrolDate);
        if (isNaN(date.getTime())) return;
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear().toString();
        let match = false;
        if (viewMode === 'single') {
          match = (month === filterMonth.value && year === filterYear.value);
        } else {
          const startMonth = parseInt(rangeStartMonthSel.value);
          const startYear = parseInt(rangeStartYearSel.value);
          const entryDate = new Date(parseInt(year), parseInt(month) - 1);
          const startDate = new Date(startYear, startMonth - 1);
          const endDate = new Date(startDate);
          endDate.setMonth(endDate.getMonth() + 11);
          if (entryDate >= startDate && entryDate <= endDate) {
            if (!activeTabMonth || (month === activeTabMonth && year === activeTabYear)) match = true;
          }
        }
        if (match) entries.push({ student, subject: sub, subjectKey: key });
      });
    });
    return entries;
  }

  function formatSchedule(timeslots) {
    if (!timeslots || timeslots.length === 0) return '-';
    return timeslots.map(ts => `${(ts.day || '').substring(0, 3)} ${ts.time || ''}`.trim()).join(', ');
  }
  function getPhone(student) { const p = student.phone || {}; return p.mom || p.dad || p.own || '-'; }
  function getPoComment(student) {
    if (student.parentOrientation === 'Yes') return student.poDate || '-';
    if (student.parentOrientation === 'No') return student.poReason || '-';
    return '-';
  }
  function getDisplayName(student) {
    const cn = student.nameCn?.trim();
    if (cn && cn !== '-') return cn;
    const pinyin = student.namePinyin?.trim();
    if (pinyin && pinyin !== '-') return pinyin;
    const nick = student.nickname?.trim();
    if (nick && nick !== '-') return nick;
    return '-';
  }

  /* ---------- Compact value visuals (Ref / Adm Fee / Bag) ---------- */
  function compactClass(field, value) {
    const v = String(value ?? '');
    if (field === 'refCode') return v === 'IT' ? 'val-it' : v === 'EO' ? 'val-eo' : 'val-empty';
    return v === 'Y' ? 'val-y' : v === 'N' ? 'val-n' : 'val-empty';
  }
  function updateCompactVisual(sid, subkey, field, value) {
    document.querySelectorAll(selFor(sid, subkey, field)).forEach(o => {
      o.classList.remove('val-y', 'val-n', 'val-it', 'val-eo', 'val-empty');
      o.classList.add(compactClass(field, value));
    });
  }

  /* ---------- Dirty tracking ---------- */
  function markDirty(el) {
    const { sid, subkey, field } = el.dataset;
    if (!sid || !subkey || !field) return;
    const key = keyOf(sid, subkey, field);
    const value = el.value;
    if (value === baselineValue(sid, subkey, field)) {
      dirtyChanges.delete(key);
    } else {
      dirtyChanges.set(key, { sid, subkey, field, value });
    }
    const isDirty = dirtyChanges.has(key);
    document.querySelectorAll(selFor(sid, subkey, field)).forEach(other => {
      if (other !== el) other.value = value;
      other.classList.toggle('dirty', isDirty);
    });
    if (field === 'enrolled') updateEnrolledVisual(sid, subkey);
    if (COMPACT_FIELDS.includes(field)) updateCompactVisual(sid, subkey, field, value);
    if (field === 'cd1' || field === 'cd2') refreshCdSummary(sid, subkey);
    updateSaveBar();
  }

  function restoreDirtyValues() {
    dirtyChanges.forEach(change => {
      document.querySelectorAll(selFor(change.sid, change.subkey, change.field)).forEach(el => {
        el.value = change.value;
        el.classList.add('dirty');
      });
      if (change.field === 'enrolled') updateEnrolledVisual(change.sid, change.subkey);
      if (COMPACT_FIELDS.includes(change.field)) updateCompactVisual(change.sid, change.subkey, change.field, change.value);
    });
    refreshAllCdSummaries();
  }

  function updateEnrolledVisual(sid, subkey) {
    const yes = (effectiveValue(sid, subkey, 'enrolled') || 'No') === 'Yes';
    document.querySelectorAll(selFor(sid, subkey, 'enrolled')).forEach(el => {
      el.classList.toggle('enrolled-yes', yes);
      el.classList.toggle('enrolled-no', !yes);
      const row = el.closest('tr');
      if (row) {
        row.classList.toggle('row-enrolled-yes', yes);
        row.classList.toggle('row-enrolled-no', !yes);
      }
      const card = el.closest('.student-card');
      if (card) {
        card.classList.toggle('card-enrolled-yes', yes);
        card.classList.toggle('card-enrolled-no', !yes);
      }
    });
  }

  function handleDirtyFieldEdit(e) {
    const el = e.target.closest('.inline-save');
    if (!el) return;
    markDirty(el);
  }
  document.addEventListener('input', handleDirtyFieldEdit);
  document.addEventListener('change', handleDirtyFieldEdit);

  /* ---------- Save bar ---------- */
  function refreshSaveControls() {
    if (!saveChangesBtn || !discardChangesBtn) return;
    saveChangesBtn.disabled = isSaving || dirtyChanges.size === 0;
    discardChangesBtn.disabled = isSaving || dirtyChanges.size === 0;
  }
  function showSaveBar(message) {
    if (!saveActionBar || !saveStatusText) return;
    clearTimeout(hideSaveBarTimer);
    saveStatusText.textContent = message;
    saveActionBar.classList.remove('hidden');
  }
  function updateSaveBar() {
    refreshSaveControls();
    if (isSaving) { showSaveBar(L('nsl.saving', 'Saving…')); return; }
    const count = dirtyChanges.size;
    if (count > 0) {
      showSaveBar(L('nsl.unsavedChanges', '{{count}} unsaved change{{plural}}', { count, plural: count === 1 ? '' : 's' }));
    } else {
      saveActionBar?.classList.add('hidden');
    }
  }
  function flashSaved(change) {
    document.querySelectorAll(selFor(change.sid, change.subkey, change.field)).forEach(el => {
      el.classList.remove('dirty');
      el.classList.add('saved-flash');
      setTimeout(() => el.classList.remove('saved-flash'), 750);
    });
  }
  function updateLocalFromChange(change, timestamp) {
    const found = findStudentEntry(change.sid, change.subkey);
    if (!found) return;
    const normalized = normalizeValue(change.field, change.value);
    if (normalized === null) delete found.entry.value[change.field];
    else found.entry.value[change.field] = normalized;
    found.entry.value.updatedAt = timestamp;
    assignSubject(found.student, change.subkey, found.entry.value);
  }

  /* ---------- Save (snapshot queue: edits made during a save are never lost) ---------- */
  async function saveAllChanges() {
    if (isSaving) return;
    if (!centerId) { showSaveBar(L('nsl.noCenterShort', 'No center selected')); return; }
    if (document.activeElement?.classList?.contains('inline-save')) markDirty(document.activeElement);
    const snapshot = Array.from(dirtyChanges.entries());
    if (snapshot.length === 0) return;

    isSaving = true;
    updateSaveBar();
    const timestamp = new Date().toISOString();
    const updates = {};
    snapshot.forEach(([, c]) => {
      updates[`${c.sid}/subjects/${c.subkey}/${c.field}`] = normalizeValue(c.field, c.value);
      updates[`${c.sid}/subjects/${c.subkey}/updatedAt`] = timestamp;
      updates[`${c.sid}/updatedAt`] = timestamp;
    });

    try {
      await update(ref(db, `centers/${centerId}/students`), updates);
      snapshot.forEach(([key, c]) => {
        updateLocalFromChange(c, timestamp);
        const current = dirtyChanges.get(key);
        if (current && current.value === c.value) {
          dirtyChanges.delete(key);
          flashSaved(c);
        }
      });
      refreshAllCdSummaries();
      isSaving = false;
      if (dirtyChanges.size === 0) {
        refreshSaveControls();
        showSaveBar(L('nsl.allSaved', 'All changes saved'));
        clearTimeout(hideSaveBarTimer);
        hideSaveBarTimer = setTimeout(() => {
          if (dirtyChanges.size === 0 && !isSaving) saveActionBar?.classList.add('hidden');
        }, 2500);
      } else {
        updateSaveBar();
      }
    } catch (err) {
      console.error('Save all error:', err);
      isSaving = false;
      refreshSaveControls();
      showSaveBar(L('nsl.failedSave', 'Failed to save: {{message}}', { message: err.message }));
    }
  }

  function discardAllChanges() {
    if (isSaving || dirtyChanges.size === 0) return;
    if (!confirm(L('nsl.discardConfirm', 'Discard unsaved changes?'))) return;
    dirtyChanges.clear();
    closeCdPopover();
    renderTable();
    updateSaveBar();
  }

  saveChangesBtn?.addEventListener('click', saveAllChanges);
  discardChangesBtn?.addEventListener('click', discardAllChanges);
  window.addEventListener('beforeunload', (e) => {
    if (dirtyChanges.size > 0 && !isSaving) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- Cell builders ---------- */
  function selectHtml(field, sid, subkey, options, current, extraClass = '') {
    const cur = String(current ?? '');
    if (COMPACT_FIELDS.includes(field)) extraClass += ` compact-select ${compactClass(field, cur)}`;
    return `<select class="inline-save ${extraClass}" data-field="${field}" data-sid="${esc(sid)}" data-subkey="${esc(subkey)}">` +
      options.map(([v, label]) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(label)}</option>`).join('') +
      `</select>`;
  }
  function inputHtml(type, field, sid, subkey, value, extraAttrs = '') {
    return `<input type="${type}" class="inline-save" data-field="${field}" data-sid="${esc(sid)}" data-subkey="${esc(subkey)}" value="${esc(value ?? '')}" ${extraAttrs}>`;
  }
  const refOptions = () => [['', '—'], ['IT', 'IT'], ['EO', 'EO']];
  const enrolledOptions = () => [['No', L('nsl.enrolledNo', 'No')], ['Yes', L('nsl.enrolledYes', 'Yes')]];
  const paymentOptions = () => [['', '-'], ['Whole', L('nsl.paymentWhole', 'Whole Month')], ['Half', L('nsl.paymentHalf', 'Half Month')]];
  const ynOptions = () => [['', '—'], ['Y', 'Y'], ['N', 'N']];

  function dtButtonHtml(sid, sub, subkey) {
    const dt = sub.selectedDT;
    if (dt) {
      return `<button type="button" class="dt-cell-btn has-dt" data-student="${esc(sid)}" data-subkey="${esc(subkey)}" title="${esc(`${sub.name || ''} · ${dt.date || ''} · ${dt.test || ''}`)}">
        <span>✓ ${esc(dt.date || '-')}</span><small>${esc(dt.test || '')}</small>
      </button>`;
    }
    return `<button type="button" class="dt-cell-btn" data-student="${esc(sid)}" data-subkey="${esc(subkey)}" title="${esc(sub.name || '')}">
      <span>＋ DT</span><small>${esc(L('nsl.selectDT', 'Select DT'))}</small>
    </button>`;
  }

  function cdSummaryInner(sid, subkey) {
    const v1 = effectiveValue(sid, subkey, 'cd1');
    const v2 = effectiveValue(sid, subkey, 'cd2');
    if (!v1 && !v2) return `<span class="cd-empty">–</span>`;
    return `<span class="cd-mini"><i>1</i>${esc(v1 || '–')}</span><span class="cd-mini"><i>2</i>${esc(v2 || '–')}</span>`;
  }
  function cdButtonHtml(sid, subkey) {
    const dirty = dirtyChanges.has(keyOf(sid, subkey, 'cd1')) || dirtyChanges.has(keyOf(sid, subkey, 'cd2'));
    return `<button type="button" class="cd-cell-btn${dirty ? ' dirty' : ''}" data-sid="${esc(sid)}" data-subkey="${esc(subkey)}" title="${esc(L('nsl.cdTitle', 'CD 1 / CD 2'))}">${cdSummaryInner(sid, subkey)}</button>`;
  }
  function refreshCdSummary(sid, subkey) {
    const dirty = dirtyChanges.has(keyOf(sid, subkey, 'cd1')) || dirtyChanges.has(keyOf(sid, subkey, 'cd2'));
    document.querySelectorAll(`.cd-cell-btn[data-sid="${CSS.escape(sid)}"][data-subkey="${CSS.escape(subkey)}"]`).forEach(btn => {
      btn.innerHTML = cdSummaryInner(sid, subkey);
      btn.classList.toggle('dirty', dirty);
    });
  }
  function refreshAllCdSummaries() {
    document.querySelectorAll('.cd-cell-btn').forEach(btn => refreshCdSummary(btn.dataset.sid, btn.dataset.subkey));
  }
  function refreshDtButtons(sid, subkey) {
    const found = findStudentEntry(sid, subkey);
    if (!found) return;
    const html = dtButtonHtml(sid, found.entry.value, subkey);
    document.querySelectorAll(`.dt-cell-btn[data-student="${CSS.escape(sid)}"][data-subkey="${CSS.escape(subkey)}"]`).forEach(btn => { btn.outerHTML = html; });
  }

  /* ---------- CD popover ---------- */
  function openCdPopover(btn) {
    const sid = btn.dataset.sid;
    const subkey = btn.dataset.subkey;
    const found = findStudentEntry(sid, subkey);
    if (!found) return;
    cdAnchor = btn;
    cdPopoverTitle.textContent = `${getDisplayName(found.student)} · ${found.entry.value.name || ''}`;
    [[cdPopoverCd1, 'cd1'], [cdPopoverCd2, 'cd2']].forEach(([input, field]) => {
      input.dataset.sid = sid;
      input.dataset.subkey = subkey;
      input.value = effectiveValue(sid, subkey, field);
      input.classList.toggle('dirty', dirtyChanges.has(keyOf(sid, subkey, field)));
    });
    cdPopover.classList.remove('hidden');
    positionCdPopover();
    cdPopoverCd1.focus({ preventScroll: true });
  }
  function positionCdPopover() {
    if (cdPopover.classList.contains('hidden') || !cdAnchor) return;
    const rect = cdAnchor.getBoundingClientRect();
    const pw = cdPopover.offsetWidth;
    const ph = cdPopover.offsetHeight;
    let left = Math.min(Math.max(8, rect.left), window.innerWidth - pw - 8);
    let top = rect.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 6);
    cdPopover.style.left = `${left}px`;
    cdPopover.style.top = `${top}px`;
  }
  function closeCdPopover() {
    cdPopover.classList.add('hidden');
    cdAnchor = null;
  }
  document.getElementById('cdPopoverClose')?.addEventListener('click', closeCdPopover);
  window.addEventListener('scroll', () => { if (!cdPopover.classList.contains('hidden')) positionCdPopover(); }, true);
  window.addEventListener('resize', () => { if (!cdPopover.classList.contains('hidden')) positionCdPopover(); });

  /* ---------- Persistent horizontal scrollbar ---------- */
  function hMetrics() {
    const max = Math.max(0, tableWrapper.scrollWidth - tableWrapper.clientWidth);
    const trackW = hScrollBar.clientWidth;
    const thumbW = Math.max(48, Math.min(trackW, trackW * (tableWrapper.clientWidth / Math.max(1, tableWrapper.scrollWidth))));
    return { max, trackW, thumbW, travel: Math.max(1, trackW - thumbW) };
  }
  function syncHScroll() {
    if (!hScrollBar || hScrollBar.offsetParent === null) return;
    const { max, thumbW, travel } = hMetrics();
    const pos = max > 0 ? (tableWrapper.scrollLeft / max) * travel : 0;
    hScrollThumb.style.width = `${thumbW}px`;
    hScrollThumb.style.transform = `translateX(${pos}px)`;
    hScrollBar.setAttribute('aria-valuenow', String(max > 0 ? Math.round((tableWrapper.scrollLeft / max) * 100) : 0));
    hScrollBar.classList.toggle('no-overflow', max <= 0);
    edgeLeft?.classList.toggle('show', tableWrapper.scrollLeft > 4);
    edgeRight?.classList.toggle('show', max > 4 && tableWrapper.scrollLeft < max - 4);
  }
  tableWrapper.addEventListener('scroll', () => {
    syncHScroll();
    if (!cdPopover.classList.contains('hidden')) positionCdPopover();
  }, { passive: true });
  hScrollThumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hDrag = { x: e.clientX, left: tableWrapper.scrollLeft };
    hScrollThumb.setPointerCapture(e.pointerId);
    hScrollThumb.classList.add('dragging');
  });
  hScrollThumb.addEventListener('pointermove', (e) => {
    if (!hDrag) return;
    const { max, travel } = hMetrics();
    tableWrapper.scrollLeft = hDrag.left + ((e.clientX - hDrag.x) / travel) * max;
  });
  const endHDrag = () => { hDrag = null; hScrollThumb.classList.remove('dragging'); };
  hScrollThumb.addEventListener('pointerup', endHDrag);
  hScrollThumb.addEventListener('pointercancel', endHDrag);
  hScrollBar.addEventListener('pointerdown', (e) => {
    if (e.target === hScrollThumb) return;
    const rect = hScrollBar.getBoundingClientRect();
    const { max, thumbW, travel } = hMetrics();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left - thumbW / 2) / travel));
    tableWrapper.scrollLeft = ratio * max;
  });
  hScrollBar.addEventListener('keydown', (e) => {
    const step = 120;
    if (e.key === 'ArrowRight') { tableWrapper.scrollLeft += step; e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { tableWrapper.scrollLeft -= step; e.preventDefault(); }
    else if (e.key === 'Home') { tableWrapper.scrollLeft = 0; e.preventDefault(); }
    else if (e.key === 'End') { tableWrapper.scrollLeft = tableWrapper.scrollWidth; e.preventDefault(); }
  });
  window.addEventListener('resize', syncHScroll);

  /* ---------- Render: desktop table ---------- */
  function buildRow(entry, idx) {
    const { student, subject: sub, subjectKey } = entry;
    const sid = student.id;
    const enrolledVal = sub.enrolled || 'No';
    const yes = enrolledVal === 'Yes';
    const rowClass = yes ? 'row-enrolled-yes' : 'row-enrolled-no';
    return `<tr class="${rowClass}">
      <td class="sticky-col col-index">${idx + 1}</td>
      <td class="sticky-col col-name"><span class="cell-name" title="${esc(getDisplayName(student))}">${esc(getDisplayName(student))}</span></td>
      <td><span class="subject-badge">${esc(sub.name || '-')}</span></td>
      <td>${selectHtml('enrolled', sid, subjectKey, enrolledOptions(), enrolledVal, `enrolled-pill ${yes ? 'enrolled-yes' : 'enrolled-no'}`)}</td>
      <td>${inputHtml('date', 'startDate', sid, subjectKey, sub.startDate || sub.enrolDate || '')}</td>
      <td>${dtButtonHtml(sid, sub, subjectKey)}</td>
      <td>${selectHtml('paymentType', sid, subjectKey, paymentOptions(), sub.paymentType)}</td>
      <td>${cdButtonHtml(sid, subjectKey)}</td>
      <td>${inputHtml('number', 'payment1', sid, subjectKey, sub.payment1 ?? '', 'inputmode="decimal" step="any"')}</td>
      <td>${inputHtml('number', 'payment2', sid, subjectKey, sub.payment2 ?? '', 'inputmode="decimal" step="any"')}</td>
      <td>${selectHtml('admFee', sid, subjectKey, ynOptions(), sub.admFee)}</td>
      <td>${selectHtml('bag', sid, subjectKey, ynOptions(), sub.bag)}</td>
      <td>${selectHtml('refCode', sid, subjectKey, refOptions(), sub.refCode)}</td>
      <td>${esc(sub.enrolDate || '-')}</td>
      <td>${esc(formatSchedule(sub.timeslots))}</td>
      <td>${esc(getPhone(student))}</td>
      <td>${esc(student.school || '-')}</td>
      <td>${esc(student.grade || '-')}</td>
      <td>${esc(student.birthday || '-')}</td>
      <td>${esc(student.parentOrientation || '-')}</td>
      <td>${esc(getPoComment(student))}</td>
    </tr>`;
  }

  function renderTable() {
    closeCdPopover();
    const entries = getFilteredEntries();
    if (resultCount) resultCount.textContent = L('nsl.recordCount', '{{count}} records', { count: entries.length });
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="21" style="text-align:center; padding:2rem;">${esc(L('nsl.noNewStudents', 'No new students found for the selected period.'))}</td></tr>`;
    } else {
      tbody.innerHTML = entries.map(buildRow).join('');
    }
    renderCards(entries);
    restoreDirtyValues();
    requestAnimationFrame(syncHScroll);
  }

  /* ---------- Render: mobile cards ---------- */
  function buildCard(entry, idx) {
    const { student, subject: sub, subjectKey } = entry;
    const sid = student.id;
    const cardKey = `${sid}|${subjectKey}`;
    const enrolledVal = sub.enrolled || 'No';
    const yes = enrolledVal === 'Yes';
    const expanded = expandedCards.has(cardKey);
    return `
    <article class="student-card ${yes ? 'card-enrolled-yes' : 'card-enrolled-no'}${expanded ? ' expanded' : ''}" data-key="${esc(cardKey)}">
      <div class="card-top">
        <div class="card-title">
          <span class="card-index">${idx + 1}</span>
          <div class="card-name-wrap">
            <h3 class="card-name">${esc(getDisplayName(student))}</h3>
            <div class="card-sub">
              <span class="subject-badge">${esc(sub.name || '-')}</span>
              <span class="muted">${esc(formatSchedule(sub.timeslots))}</span>
            </div>
          </div>
        </div>
        ${selectHtml('enrolled', sid, subjectKey, enrolledOptions(), enrolledVal, `enrolled-pill ${yes ? 'enrolled-yes' : 'enrolled-no'}`)}
      </div>
      <div class="card-quick">
        <label class="field"><span class="lbl">${esc(L('nsl.cardStartDate', 'Start Date'))}</span>
          ${inputHtml('date', 'startDate', sid, subjectKey, sub.startDate || sub.enrolDate || '')}
        </label>
        <label class="field"><span class="lbl">${esc(L('nsl.cardPayment', 'Payment'))}</span>
          ${selectHtml('paymentType', sid, subjectKey, paymentOptions(), sub.paymentType)}
        </label>
        <div class="field field-dt"><span class="lbl">${esc(L('nsl.cardDt', 'DT'))}</span>${dtButtonHtml(sid, sub, subjectKey)}</div>
      </div>
      <div class="card-meta">
        <div><span class="lbl">${esc(L('nsl.cardPhone', 'Phone'))}</span><span>${esc(getPhone(student))}</span></div>
        <div><span class="lbl">${esc(L('nsl.cardSchool', 'School'))}</span><span>${esc(student.school || '-')}</span></div>
        <div><span class="lbl">${esc(L('nsl.cardGrade', 'Grade'))}</span><span>${esc(student.grade || '-')}</span></div>
        <div><span class="lbl">${esc(L('nsl.cardDob', 'DOB'))}</span><span>${esc(student.birthday || '-')}</span></div>
        <div><span class="lbl">${esc(L('nsl.cardPo', 'PO'))}</span><span>${esc(student.parentOrientation || '-')}</span></div>
        <div><span class="lbl">${esc(L('nsl.cardPoComment', 'PO Comment'))}</span><span>${esc(getPoComment(student))}</span></div>
      </div>
      <button type="button" class="card-toggle" aria-expanded="${expanded}">
        <span>${esc(L('nsl.cardDetails', 'Enrollment & Payment'))}</span><span class="chevron">▾</span>
      </button>
      <div class="card-details"><div class="details-inner">
        <div class="field-grid">
          <label class="field"><span class="lbl">${esc(L('nsl.cardRef', 'Ref'))}</span>
            ${selectHtml('refCode', sid, subjectKey, refOptions(), sub.refCode)}
          </label>
          <div class="field"><span class="lbl">${esc(L('nsl.cardEnrolledDate', 'Enrolled Date'))}</span>
            <span class="readonly-value">${esc(sub.enrolDate || '-')}</span>
          </div>
          <div class="field"><span class="lbl">${esc(L('nsl.thCd', 'CD'))}</span>${cdButtonHtml(sid, subjectKey)}</div>
          <label class="field"><span class="lbl">${esc(L('nsl.cardAdmFee', 'Adm Fee'))}</span>
            ${selectHtml('admFee', sid, subjectKey, ynOptions(), sub.admFee)}
          </label>
          <label class="field"><span class="lbl">${esc(L('nsl.cardPay1', '1st Pay'))}</span>
            ${inputHtml('number', 'payment1', sid, subjectKey, sub.payment1 ?? '', 'inputmode="decimal" step="any"')}
          </label>
          <label class="field"><span class="lbl">${esc(L('nsl.cardPay2', '2nd Pay'))}</span>
            ${inputHtml('number', 'payment2', sid, subjectKey, sub.payment2 ?? '', 'inputmode="decimal" step="any"')}
          </label>
          <label class="field"><span class="lbl">${esc(L('nsl.cardBag', 'Bag'))}</span>
            ${selectHtml('bag', sid, subjectKey, ynOptions(), sub.bag)}
          </label>
        </div>
      </div></div>
    </article>`;
  }
  function renderCards(entries) {
    if (!cardList) return;
    if (entries.length === 0) {
      cardList.innerHTML = `<div class="empty-state">${esc(L('nsl.noNewStudents', 'No new students found for the selected period.'))}</div>`;
      return;
    }
    cardList.innerHTML = entries.map(buildCard).join('');
  }

  /* ---------- Global click delegation ---------- */
  document.addEventListener('click', (e) => {
    const cdBtn = e.target.closest('.cd-cell-btn');
    if (cdBtn) {
      if (cdAnchor === cdBtn && !cdPopover.classList.contains('hidden')) closeCdPopover();
      else openCdPopover(cdBtn);
      return;
    }
    if (!cdPopover.classList.contains('hidden') && !cdPopover.contains(e.target)) closeCdPopover();

    const toggle = e.target.closest('.card-toggle');
    if (toggle) {
      const card = toggle.closest('.student-card');
      const expanded = card.classList.toggle('expanded');
      toggle.setAttribute('aria-expanded', expanded);
      if (expanded) expandedCards.add(card.dataset.key);
      else expandedCards.delete(card.dataset.key);
      return;
    }
    const dtBtn = e.target.closest('.dt-cell-btn');
    if (dtBtn) {
      closeCdPopover();
      currentDtContext = { studentId: dtBtn.dataset.student, subjectKey: dtBtn.dataset.subkey };
      openDtModal();
      return;
    }
    const link = e.target.closest('a');
    if (link && dirtyChanges.size > 0 && !isSaving) {
      if (!confirm(L('nsl.leaveConfirm', 'You have unsaved changes. Leave anyway?'))) e.preventDefault();
    }
  });

  /* ---------- DT modal: pick row, then Confirm; Cancel reverts ---------- */
  function setDtStatus(msg, isError = false) {
    if (!dtModalStatus) return;
    dtModalStatus.textContent = msg;
    dtModalStatus.classList.toggle('error', isError);
  }
  function pickDtRow(index) {
    pendingDt = currentDts[index] || null;
    dtModalBody.querySelectorAll('tr[data-idx]').forEach(tr => {
      tr.classList.toggle('selected', Number(tr.dataset.idx) === index);
    });
    if (pendingDt) {
      confirmDtBtn.disabled = false;
      setDtStatus(L('nsl.dtSelectedStatus', 'Selected: {{test}} · {{date}}', { test: pendingDt.test || '-', date: pendingDt.date || '-' }));
    }
  }
  function openDtModal() {
    const found = findStudentEntry(currentDtContext.studentId, currentDtContext.subjectKey);
    if (!found) return;
    const { student, entry } = found;
    const sub = entry.value;
    document.getElementById('dtModalTitle').textContent = L('nsl.selectDTFor', 'Select DT for: {{subject}}', { subject: sub.name || '-' });
    document.getElementById('dtModalHint').textContent = L('nsl.studentHint', 'Student: {{name}} | Click a row to assign it.', { name: getDisplayName(student) });
    const raw = student.diagnosticTests;
    currentDts = Array.isArray(raw) ? raw.filter(Boolean) : (raw && typeof raw === 'object' ? Object.values(raw).filter(Boolean) : []);
    pendingDt = null;
    dtSaving = false;
    confirmDtBtn.disabled = true;
    cancelDtBtn.disabled = false;
    setDtStatus(L('nsl.dtPickRow', 'Pick a row, then tap Confirm.'));
    dtModalBody.innerHTML = '';
    if (currentDts.length === 0) {
      dtModalBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:1rem;">${esc(L('nsl.noDTRecorded', 'No Diagnostic Tests recorded for this student.'))}</td></tr>`;
    } else {
      const current = sub.selectedDT;
      currentDts.forEach((dt, i) => {
        const tr = document.createElement('tr');
        tr.dataset.idx = i;
        tr.tabIndex = 0;
        tr.innerHTML = `
          <td>${esc(dt.date || '-')}</td>
          <td>${esc(dt.test || '-')}</td>
          <td>${esc(dt.subject || '-')}</td>
          <td>${esc(dt.time || '-')}</td>
          <td>${esc(dt.score ?? '-')}</td>
          <td>${esc(dt.suggestedStart || dt.actualStart || '-')}</td>`;
        dtModalBody.appendChild(tr);
        if (current && current.date === dt.date && current.test === dt.test) pickDtRow(i);
      });
    }
    dtModal.classList.remove('hidden');
  }
  dtModalBody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-idx]');
    if (tr && !dtSaving) pickDtRow(Number(tr.dataset.idx));
  });
  dtModalBody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr[data-idx]');
    if (tr && !dtSaving) { e.preventDefault(); pickDtRow(Number(tr.dataset.idx)); }
  });

  async function confirmDtSelection() {
    if (!pendingDt || dtSaving || !currentDtContext) return;
    const { studentId, subjectKey } = currentDtContext;
    if (!centerId || !studentId || !subjectKey) return;
    dtSaving = true;
    confirmDtBtn.disabled = true;
    cancelDtBtn.disabled = true;
    setDtStatus(L('nsl.dtSaving', 'Saving…'));
    const timestamp = new Date().toISOString();
    const selectedDT = {
      date: pendingDt.date ?? null,
      test: pendingDt.test ?? null,
      time: pendingDt.time ?? null,
      score: pendingDt.score ?? null,
      startLvl: pendingDt.suggestedStart ?? pendingDt.actualStart ?? null
    };
    try {
      await update(ref(db, `centers/${centerId}/students/${studentId}`), {
        [`subjects/${subjectKey}/selectedDT`]: selectedDT,
        [`subjects/${subjectKey}/updatedAt`]: timestamp,
        updatedAt: timestamp
      });
      const found = findStudentEntry(studentId, subjectKey);
      if (found) {
        found.entry.value.selectedDT = selectedDT;
        found.entry.value.updatedAt = timestamp;
        assignSubject(found.student, subjectKey, found.entry.value);
      }
      closeDtModal();
      refreshDtButtons(studentId, subjectKey);
    } catch (err) {
      console.error('DT Save error:', err);
      dtSaving = false;
      confirmDtBtn.disabled = false;
      cancelDtBtn.disabled = false;
      setDtStatus(L('nsl.failedSaveDT', 'Failed to save DT: {{message}}', { message: err.message }), true);
    }
  }
  function closeDtModal() {
    dtModal.classList.add('hidden');
    currentDtContext = null;
    currentDts = [];
    pendingDt = null;
    dtSaving = false;
    if (confirmDtBtn) confirmDtBtn.disabled = true;
    if (cancelDtBtn) cancelDtBtn.disabled = false;
    setDtStatus('');
  }
  confirmDtBtn?.addEventListener('click', confirmDtSelection);
  cancelDtBtn?.addEventListener('click', closeDtModal);
  document.getElementById('closeDtModal')?.addEventListener('click', closeDtModal);
  dtModal?.addEventListener('click', (e) => { if (e.target === dtModal && !dtSaving) closeDtModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!cdPopover.classList.contains('hidden')) { closeCdPopover(); return; }
    if (!dtModal.classList.contains('hidden') && !dtSaving) closeDtModal();
  });

  /* ---------- Keep views in sync across the breakpoint ---------- */
  const mobileQuery = window.matchMedia('(max-width: 900px)');
  let wasMobile = mobileQuery.matches;
  const onBreakpoint = () => {
    const isMobile = mobileQuery.matches;
    if (isMobile !== wasMobile) { wasMobile = isMobile; renderTable(); }
    requestAnimationFrame(syncHScroll);
  };
  if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', onBreakpoint);
  else window.addEventListener('resize', onBreakpoint);

  /* ---------- Initialize ---------- */
  viewMode = 'year';
  singleMonthControls.classList.add('hidden');
  rangeControls.classList.remove('hidden');
  updateRangeEndLabel();
  generateMonthTabs();
  loadData();
  requestAnimationFrame(syncHScroll);
}
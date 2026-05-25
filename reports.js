// reports.js
import { requireAuth, db } from './auth.js';
import { ref, get, onValue, off, update } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}
const centerId = sessionStorage.getItem('selectedCenter');
if (!centerId) { window.location.href = 'centers.html'; }
const studentsRef = ref(db, `centers/${centerId}/students`);

let cachedStudents = [];
let isDataLoaded = false;

const reportMonthInput = document.getElementById('reportMonth');
const reportSubjectInput = document.getElementById('reportSubject');
const generateBtn = document.getElementById('generateReport');
const saveBtn = document.getElementById('saveReportBtn');
const reportBody = document.getElementById('reportBody');
const monthlyReportContainer = document.getElementById('monthlyReport');

function showLoader() { document.getElementById('page-loader')?.classList.remove('hidden'); }
function hideLoader() { document.getElementById('page-loader')?.classList.add('hidden'); }

// 📅 STRICT MONTH RESTRICTION
const now = new Date();
const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
if (reportMonthInput) {
  reportMonthInput.max = currentMonthStr;
  reportMonthInput.value = currentMonthStr;
  const blockFuture = (e) => { if (e.target.value > currentMonthStr) e.target.value = currentMonthStr; };
  reportMonthInput.addEventListener('change', (e) => { blockFuture(e); buildReport(); });
  reportMonthInput.addEventListener('input', blockFuture);
}

async function loadStudents(forceRefresh = false) {
  if (isDataLoaded && !forceRefresh) return;
  showLoader();
  cachedStudents = [];
  try {
    const snap = await get(studentsRef);
    if (snap.exists()) {
      snap.forEach(child => {
        const data = child.val();
        if (data?.subjects) {
          if (!Array.isArray(data.subjects)) data.subjects = Object.values(data.subjects);
        } else { data.subjects = []; }
        cachedStudents.push({ id: child.key, data });
      });
    }
    isDataLoaded = true;
  } catch (err) {
    console.error('❌ Load failed:', err);
    alert('Failed to load student data.');
  }
  hideLoader();
}

function buildReport() {
  if (!isDataLoaded) return;
  const subject = (reportSubjectInput?.value || 'all').trim();
  const month = reportMonthInput?.value;
  
  if (!month) {
    reportBody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:1.5rem; color:#666;">📅 Please select a month.</td></tr>`;
    monthlyReportContainer?.classList.remove('hidden');
    return;
  }
  
  reportBody.innerHTML = '';
  monthlyReportContainer?.classList.add('hidden');
  if (saveBtn) { saveBtn.style.display = 'none'; saveBtn.disabled = false; saveBtn.textContent = '💾 Save Changes'; }
  
  let rowCount = 0;
  cachedStudents.forEach(({ id, data: s }) => {
    if (!s) return;
    let subjects = s.subjects || [];
    if (!Array.isArray(subjects)) subjects = Object.values(subjects);
    if (subjects.length === 0) return;

    subjects.forEach(sub => {
      if (!sub) return;
      if (subject !== 'all' && (sub.name || '').trim() !== subject) return;
      if (sub?.status === 'drop') return;

      let progress = sub.progress || [];
      if (!Array.isArray(progress)) progress = progress ? Object.values(progress) : [];
      const prog = progress.find(p => p?.month === month);
      const sorted = [...progress].sort((a, b) => (a?.month || '').localeCompare(b?.month || ''));
      const prev = sorted.filter(p => p?.month && p.month < month).pop();

      const prevLevel = prev?.currLevel || sub.startLevel || '';
      const prevWS = prev?.currWS ?? sub.startWS ?? 0;
      const currLevel = prog?.currLevel || sub.currentLevel || '';
      const currWS = prog?.currWS ?? sub.currentWS ?? 0;
      const test = prog?.test || {};

      const row = document.createElement('tr');
      row.dataset.studentId = id;
      row.dataset.subjectName = sub.name;

      const inp = (val, cls, readonly = false, type = 'text') => 
        `<input type="${type}" value="${val ?? ''}" class="report-input ${cls}" ${readonly ? 'readonly' : ''} autocomplete="off">`;

      row.innerHTML = `
        <td>${s.studentNumber || '-'}</td>
        <td>${s.nameCn || '-'}</td>
        <td>${s.namePinyin || s.nickname || '-'}</td>
        <td>${s.grade || '-'}</td>
        <td>${inp(prevLevel, 'prev-level', true)}</td>
        <td>${inp(prevWS, 'prev-ws', true, 'number')}</td>
        <td>${inp(currLevel, 'curr-level')}</td>
        <td>${inp(currWS, 'curr-ws', false, 'number')}</td>
        <td>${inp(test.level || '', 'test-level', true)}</td>
        <td>${inp(test.score || '', 'test-score', true)}</td>
        <td>${inp(test.time || '', 'test-time', true, 'number')}</td>
        <td>${inp(test.group || '', 'test-group', true)}</td>
      `;

      reportBody.appendChild(row);
      rowCount++;

      const currInput = row.querySelector('.curr-level');
      const testInputs = row.querySelectorAll('.test-level, .test-score, .test-time, .test-group');

      const toggleTests = () => {
        const curr = (currInput?.value || '').trim();
        const prev = (row.querySelector('.prev-level')?.value || '').trim();
        const changed = curr !== '' && prev !== '' && curr !== prev;
        testInputs.forEach(input => {
          input.readOnly = !changed;
          input.style.background = changed ? '#fff' : '#f8f9fa';
          input.style.color = changed ? 'inherit' : '#999';
          input.style.cursor = changed ? 'text' : 'not-allowed';
          if (!changed && input.value) input.value = '';
        });
      };

      currInput?.addEventListener('input', toggleTests);
      toggleTests();
    });
  });

  if (rowCount > 0) {
    monthlyReportContainer?.classList.remove('hidden');
    if (saveBtn) saveBtn.style.display = 'inline-flex';
  } else {
    reportBody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:1.5rem; color:#666;">📭 No matching active students for ${month}</td></tr>`;
    monthlyReportContainer?.classList.remove('hidden');
  }
}

if (reportSubjectInput) reportSubjectInput.addEventListener('change', buildReport);
if (generateBtn) generateBtn.addEventListener('click', buildReport);

if (saveBtn) {
  saveBtn.addEventListener('click', async () => {
    const rows = reportBody?.querySelectorAll('tr[data-student-id]') || [];
    if (rows.length === 0) return alert('No data to save.');
    if (!confirm('💾 Save changes?\n\nPartial saves are supported. Empty fields will be skipped.')) return;
    
    showLoader();
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Saving...';
    const batchUpdates = {};
    const month = reportMonthInput?.value;

    try {
      for (const row of rows) {
        const studentId = row.dataset.studentId;
        const subjectName = row.dataset.subjectName;
        if (!studentId || !subjectName) continue;

        const getVal = (cls) => row.querySelector(`.${cls}`)?.value?.trim() || '';
        const currLevel = getVal('curr-level');
        const currWS = parseInt(getVal('curr-ws')) || 0;

        const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
        if (!snap.exists()) continue;
        const student = snap.val();

        let subjects = student.subjects || {};
        let subjectKey = null;
        let subjectData = null;

        if (Array.isArray(subjects)) {
          subjectKey = subjects.findIndex(s => (s.name || '').trim() === subjectName);
          subjectData = subjectKey !== -1 ? subjects[subjectKey] : null;
        } else {
          for (const key in subjects) {
            if ((subjects[key]?.name || '').trim() === subjectName) { subjectKey = key; subjectData = subjects[key]; break; }
          }
        }
        if (!subjectData) continue;

        if (currLevel) { subjectData.currentLevel = currLevel; subjectData.currentWS = currWS; }

        let progArr = subjectData.progress || [];
        if (!Array.isArray(progArr)) progArr = Object.values(progArr);

        const entry = { month };
        const pL = getVal('prev-level'); if (pL) entry.prevLevel = pL;
        const pW = getVal('prev-ws'); if (pW) entry.prevWS = parseInt(pW);
        if (currLevel) entry.currLevel = currLevel;
        entry.currWS = currWS;

        const tL = getVal('test-level');
        if (tL) {
          entry.test = { level: tL, score: getVal('test-score') || '', time: parseInt(getVal('test-time')) || 0, group: getVal('test-group') || '' };
        }

        const idx = progArr.findIndex(p => p?.month === month);
        if (idx >= 0) progArr[idx] = { ...progArr[idx], ...entry };
        else progArr.push(entry);

        subjectData.progress = progArr;
        batchUpdates[`centers/${centerId}/students/${studentId}/subjects/${subjectKey}`] = subjectData;
      }

      if (Object.keys(batchUpdates).length > 0) {
        await update(ref(db), batchUpdates);
        alert('✅ Saved successfully! You can continue later.');
        isDataLoaded = false;
        await loadStudents(true);
        setTimeout(buildReport, 300);
      } else {
        alert('ℹ️ No changes detected.');
      }
    } catch (err) {
      console.error('Save error:', err);
      alert('❌ Save failed: ' + err.message);
    } finally {
      hideLoader();
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Changes';
    }
  });
}

document.getElementById('printReport')?.addEventListener('click', () => window.print());
window.addEventListener('DOMContentLoaded', () => loadStudents(true).then(() => buildReport()));
// student-form.js
import { requireAuth, db } from './auth.js';
import { ref, push, set, get, remove } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";
if (!requireAuth()) {}

const SUBJECTS = ['Math', 'Chinese (Trad)', 'Chinese (Simp)', 'English ERP', 'English EFL'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SUBJECT_COLORS = {
  'Math': 'subj-Math',
  'Chinese (Trad)': 'subj-Chinese',
  'Chinese (Simp)': 'subj-Chinese',
  'English ERP': 'subj-ERP',
  'English EFL': 'subj-EFL'
};
let subjectCount = 0;
let html5QrCode = null;
let scannerActive = false;
let originalFormData = null;
const centerId = sessionStorage.getItem('selectedCenter');
const urlParams = new URLSearchParams(window.location.search);
const studentId = urlParams.get('id');
const isEdit = !!studentId;
document.getElementById('formTitle').textContent = isEdit ? '✏️ Edit Student' : '➕ Add Student';

// ✅ MODAL ERROR HANDLER (Req 4)
function showError(msg) {
  const modal = document.getElementById('errorModal');
  if (modal) {
    document.getElementById('errorMessage').textContent = msg;
    modal.classList.remove('hidden');
  } else {
    alert(msg);
  }
}
if (document.getElementById('closeErrorModal')) {
  document.getElementById('closeErrorModal').addEventListener('click', () => {
    document.getElementById('errorModal').classList.add('hidden');
  });
}
if (document.getElementById('errorModal')) {
  document.getElementById('errorModal').addEventListener('click', (e) => {
    if (e.target.id === 'errorModal') document.getElementById('errorModal').classList.add('hidden');
  });
}

function hideLoader() {
  const loader = document.getElementById('page-loader');
  if (loader) setTimeout(() => loader.classList.add('hidden'), 300);
}
function showLoader() {
  document.getElementById('page-loader')?.classList.remove('hidden');
}

// ✅ REQ 1: WS DROPDOWN GENERATOR (FIXED STRING COMPARISON FOR SAVING)
function getWSDropdownOptions(currentValue = '') {
  let opts = '<option value="">Select WS *</option>';
  // Normalize to string to ensure "1" matches number 1 from database
  const currentStr = String(currentValue); 
  for (let i = 1; i <= 191; i += 10) {
    const val = i.toString();
    opts += `<option value="${val}" ${val === currentStr ? 'selected' : ''}>${val}</option>`;
  }
  return opts;
}

function initOtherInputs() {
  const fields = ['grade', 'school', 'nationality'];
  fields.forEach(fieldId => {
    const select = document.getElementById(fieldId);
    const otherInput = document.getElementById(fieldId + 'Other');
    if(select && otherInput) {
      if(select.value === 'Other') {
        otherInput.classList.add('visible');
        otherInput.required = true;
        select.required = false;
      } else {
        otherInput.classList.remove('visible');
        otherInput.required = false;
        select.required = true;
      }
      select.addEventListener('change', () => {
        if(select.value === 'Other') {
          otherInput.classList.add('visible');
          otherInput.focus();
          otherInput.required = true;
          select.required = false;
        } else {
          otherInput.classList.remove('visible');
          otherInput.required = false;
          select.required = true;
        }
      });
    }
  });
}

function updateAgeDisplay() {
  const bday = document.getElementById('birthday').value;
  const ageEl = document.getElementById('ageDisplay');
  if (!ageEl) return;
  if (!bday) { ageEl.value = ''; return; }
  const today = new Date();
  const birth = new Date(bday);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  ageEl.value = age >= 0 ? `${age} yr` : '';
}
document.getElementById('birthday')?.addEventListener('input', updateAgeDisplay);
setInterval(updateAgeDisplay, 60000);

function updateOverallStatus() {
    const statuses = Array.from(document.querySelectorAll('.status')).map(s => s.value);
    const overall = document.getElementById('overallStatus');
    if (!overall) return;
    
    if (statuses.length === 0) { 
        // ✅ Defaults to Drop if no subjects, matching import logic
        overall.value = 'Drop'; 
        return; 
    }
    const allDrop = statuses.every(s => s === 'drop');
    const hasCurrent = statuses.some(s => s === 'current');
    overall.value = allDrop ? 'Drop' : (hasCurrent ? 'Current' : 'Pause');
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const targetId = `tab-${btn.dataset.tab}`;
    document.getElementById(targetId)?.classList.add('active');
    if (btn.dataset.tab === 'schedule') renderSchedule();
  });
});

function renderSchedule() {
  const thead = document.getElementById('scheduleHeader');
  const tbody = document.getElementById('scheduleBody');
  if (!thead || !tbody) return;
  thead.innerHTML = '';
  DAYS.forEach(day => {
    const th = document.createElement('th');
    th.textContent = day.substring(0, 3);
    thead.appendChild(th);
  });
  tbody.innerHTML = '';
  const schedule = DAYS.reduce((acc, d) => ({...acc, [d]: []}), {});
  document.querySelectorAll('.subject-entry').forEach(entry => {
    const name = entry.querySelector('.subject-name').value;
    const status = entry.querySelector('.status').value;
    if (!name || status === 'drop') return;
    entry.querySelectorAll('.timeslot-row').forEach(row => {
      const day = row.querySelector('.ts-day').value;
      const h = row.querySelector('.ts-hour').value;
      const m = row.querySelector('.ts-min').value;
      if (day && h && m) schedule[day].push({ name, time: `${h}:${m}`, color: SUBJECT_COLORS[name] });
    });
  });
  const tr = document.createElement('tr');
  DAYS.forEach(day => {
    const td = document.createElement('td');
    schedule[day].sort((a,b) => a.time.localeCompare(b.time)).forEach(slot => {
      const pill = document.createElement('span');
      pill.className = `slot-pill ${slot.color}`;
      pill.textContent = `${slot.name.substring(0,3)} ${slot.time}`;
      td.appendChild(pill);
    });
    if (schedule[day].length === 0) td.innerHTML = '<span style="color:#999;">-</span>';
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}

const scanBtn = document.getElementById('startScannerBtn');
const qrReader = document.getElementById('qr-reader');
const qrStatus = document.getElementById('qr-status');
const qrInput = document.getElementById('qrCodeInput');
if (scanBtn) {
  scanBtn.addEventListener('click', async () => {
    if (scannerActive) {
      if (html5QrCode) await html5QrCode.stop();
      qrReader.style.display = 'none';
      scanBtn.textContent = '📷 Scan QR';
      scannerActive = false;
      return;
    }
    qrReader.style.display = 'block';
    scanBtn.textContent = '⏹ Stop';
    scannerActive = true;
    qrStatus.textContent = 'Point camera at QR code...';
    html5QrCode = new Html5Qrcode("qr-reader");
    try {
      await html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          qrInput.value = decodedText;
          qrStatus.textContent = `✅ Scanned: ${decodedText}`;
          html5QrCode.stop();
          qrReader.style.display = 'none';
          scanBtn.textContent = '📷 Scan QR';
          scannerActive = false;
        }, () => {}
      );
    } catch (err) {
      qrStatus.textContent = '❌ Camera access denied or not available.';
      qrReader.style.display = 'none';
      scanBtn.textContent = '📷 Scan QR';
      scannerActive = false;
    }
  });
}
window.addEventListener('beforeunload', () => {
  if (html5QrCode && scannerActive) html5QrCode.stop();
});

function getLevelOptions(subject, currentValue = '') {
  let levels = [];
  if (subject === 'Math') {
    for (let i = 6; i >= 2; i--) levels.push(`${i}A`);
    levels = levels.concat(['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O']);
  } else if (subject.includes('Chinese') || subject === 'English ERP') {
    for (let i = 7; i >= 2; i--) levels.push(`${i}A`);
    ['A','B','C','D','E','F','G','H'].forEach(l => { levels.push(`${l}I`); levels.push(`${l}II`); });
    levels.push('II', 'III', 'J', 'K', 'L');
  } else if (subject === 'English EFL') {
    for (let i = 7; i >= 2; i--) levels.push(`${i}A`);
    levels = levels.concat(['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O']);
  }
  let optionsHTML = '<option value="">Select Level</option>';
  levels.forEach(lvl => {
    optionsHTML += `<option value="${lvl}" ${lvl === currentValue ? 'selected' : ''}>${lvl}</option>`;
  });
  return optionsHTML;
}

function collectFormData() {
  const subjects = [];
  for (const entry of document.querySelectorAll('.subject-entry')) {
    const timeslots = [];
    entry.querySelectorAll('.timeslots-list .timeslot-row').forEach(row => {
      timeslots.push({
        day: row.querySelector('.ts-day').value,
        time: `${row.querySelector('.ts-hour').value}:${row.querySelector('.ts-min').value}`
      });
    });

    // ✅ REQ 3: Capture Pencil Skill Data
    const pencilEntry = entry.querySelector('.pencil-skill-entry');
    const pencilVisible = pencilEntry && pencilEntry.style.display !== 'none';
    let pencilData = null;
    if (pencilVisible) {
      pencilData = {
        level: entry.querySelector('.pencil-level').value,
        ws: entry.querySelector('.pencil-ws').value
      };
    }

    subjects.push({
      name: entry.querySelector('.subject-name').value,
      startLevel: entry.querySelector('.start-level').value,
      startWS: parseInt(entry.querySelector('.start-ws').value) || 0,
      diagTest: entry.querySelector('.diag-test')?.value.trim() || '',
      diagScore: entry.querySelector('.diag-score')?.value.trim() || '',
      diagTime: entry.querySelector('.diag-time')?.value ? parseInt(entry.querySelector('.diag-time').value) : '',
      currentLevel: entry.querySelector('.current-level').value || '',
      currentWS: parseInt(entry.querySelector('.current-ws').value) || 0,
      enrolDate: entry.querySelector('.enrol-date').value,
      status: entry.querySelector('.status').value,
      timeslots, 
      progress: [],
      pencilSkill: pencilData // ✅ Added
    });
  }
  const getVal = (id) => {
    const select = document.getElementById(id);
    const other = document.getElementById(id + 'Other');
    if (select.value === 'Other' && other) return other.value.trim();
    return select.value;
  };
  return {
    studentNumber: document.getElementById('studentNumber').value.trim() || '',
    nickname: document.getElementById('nickname').value.trim() || '',
    namePinyin: document.getElementById('namePinyin').value.trim() || '',
    nameCn: document.getElementById('nameCn').value.trim() || '',
    grade: getVal('grade'),
    school: getVal('school'),
    address: document.getElementById('address').value.trim() || '',
    nationality: getVal('nationality'),
    email: document.getElementById('email').value.trim() || '',
    birthday: document.getElementById('birthday').value || '',
    phone: {
      mom: document.getElementById('phoneMom').value.trim() || '',
      dad: document.getElementById('phoneDad').value.trim() || '',
      own: document.getElementById('phoneOwn').value.trim() || ''
    },
    qrCode: document.getElementById('qrCodeInput').value.trim() || '',
    subjects
  };
}

function getUsedSubjects(excludeEntry = null) {
  const used = new Set();
  document.querySelectorAll('.subject-entry').forEach(entry => {
    if (entry === excludeEntry) return;
    const subjectSelect = entry.querySelector('.subject-name');
    const statusSelect = entry.querySelector('.status');
    const subject = subjectSelect?.value;
    const status = statusSelect?.value;
    if (subject && status !== 'drop') used.add(subject);
  });
  return used;
}

function refreshSubjectOptions(subjectSelect) {
  const currentValue = subjectSelect.value;
  const entry = subjectSelect.closest('.subject-entry');
  const usedSubjects = getUsedSubjects(entry);
  let optionsHTML = '<option value="">Select Subject *</option>';
  SUBJECTS.forEach(s => {
    const isSelected = s === currentValue;
    const isUsed = usedSubjects.has(s) && !isSelected;
    const disabled = isUsed ? 'disabled' : '';
    const hint = isUsed ? ' (Added)' : '';
    optionsHTML += `<option value="${s}" ${isSelected ? 'selected' : ''} ${disabled}>${s}${hint}</option>`;
  });
  subjectSelect.innerHTML = optionsHTML;
}

function updateSubjectEntry(entry) {
  const subjectSelect = entry.querySelector('.subject-name');
  const statusSelect = entry.querySelector('.status');
  const subject = subjectSelect?.value;
  const status = statusSelect?.value;
  entry.classList.remove('subj-Math', 'subj-Chinese', 'subj-ERP', 'subj-EFL');
  if (subject && SUBJECT_COLORS[subject]) entry.classList.add(SUBJECT_COLORS[subject]);
  
  if (status === 'drop') {
    entry.style.opacity = '0.65';
    entry.style.filter = 'grayscale(0.4)';
  } else {
    entry.style.opacity = '1';
    entry.style.filter = 'none';
  }
}

function addSubjectField(data = {}) {
  if (subjectCount >= 3) return showError('Maximum 3 subjects allowed');
  const container = document.getElementById('subjectsContainer');
  const div = document.createElement('div');
  div.className = 'subject-entry';
  const isPreExistingSubject = isEdit && !!data.name;

  // ✅ REQ 2: Remove lock restriction on Start Level/WS
  const lockStart = false; 
  const lockStartHint = '';
  const lockDiagnostic = isPreExistingSubject;
  const lockDiagHint = lockDiagnostic ? '<span style="color:#999;font-weight:400;font-size:0.8rem">(Locked)</span>' : '';

  const usedSubjects = getUsedSubjects(div);
  const initialSubject = data.name || 'Math';
  const levelOptionsHTML = getLevelOptions(initialSubject, data.startLevel);

  div.innerHTML = `
<div class="form-grid"> 
  <div><label>Select Subject *</label><select class="subject-name" required>
    <option value="">Select Subject *</option>
    ${SUBJECTS.map(s => { const isSelected = data.name === s; const isUsed = usedSubjects.has(s) && !isSelected; return `<option value="${s}" ${isSelected ? 'selected' : ''} ${isUsed ? 'disabled' : ''}>${s}${isUsed ? ' (Added)' : ''}</option>`; }).join('')}
  </select></div>
  <div><label>Start Level * ${lockStartHint}</label><select class="start-level subject-level-select" required>${levelOptionsHTML}</select></div>
  <div><label>Start WS # *</label><select class="start-ws" required>${getWSDropdownOptions(data.startWS)}</select></div>
  <div><label>Diagnostic Test ${lockDiagHint}</label><input type="text" class="diag-test" placeholder="e.g. K1/K2/P1" value="${data.diagTest || ''}" ${lockDiagnostic ? 'readonly' : ''}></div>
  <div><label>Diagnostic Score ${lockDiagHint}</label><input type="text" class="diag-score" placeholder="e.g. 85/100" value="${data.diagScore || ''}" ${lockDiagnostic ? 'readonly' : ''}></div>
  <div><label>Time (mins) ${lockDiagHint}</label><input type="number" class="diag-time" placeholder="e.g. 30" value="${data.diagTime || ''}" ${lockDiagnostic ? 'readonly' : ''}></div>
  <div><label>Current Level</label><input type="text" class="current-level" value="${data.currentLevel || ''}" readonly></div>
  <div><label>Current WS #</label><input type="number" class="current-ws" value="${data.currentWS || 0}" readonly></div>
  <div><label>Enrol Date *</label><input type="date" class="enrol-date" value="${data.enrolDate || ''}" required></div>
  <div><label>Status</label><select class="status">
    <option value="new" ${data.status === 'new' ? 'selected' : ''}>New</option>
    <option value="current" ${data.status === 'current' ? 'selected' : ''} selected>Current</option>
    <option value="pause" ${data.status === 'pause' ? 'selected' : ''}>Pause</option>
    <option value="drop" ${data.status === 'drop' ? 'selected' : ''}>Drop</option>
  </select></div>
</div>

<button type="button" class="add-pencil-btn secondary" style="margin:0.25rem 0 0.75rem; padding:0.3rem 0.7rem; font-size:0.85rem; width:auto; background:#e8f0fe; color:#667eea; border:1px solid #667eea;">➕ Add Pencil Skill</button>

<div class="pencil-skill-entry" style="display:none; margin-top:0.5rem; margin-bottom:1rem; padding:0.75rem; background:#e8f0fe; border-radius:8px; border-left:4px solid #667eea;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
    <h4 style="font-size:0.9rem; margin:0; color:#333;">Pencil Skill</h4>
    <button type="button" class="remove-pencil-btn" style="background:none; border:none; cursor:pointer; color:#dc3545; font-size:1.2rem; padding:0; line-height:1;">×</button>
  </div>
  <div class="form-grid">
    <div><label>Pencil Level</label><select class="pencil-level"><option value="">Select Level</option>
      ${['ZI','ZII'].map(l => `<option value="${l}" ${data.pencilSkill?.level === l ? 'selected' : ''}>${l}</option>`).join('')}
    </select></div>
    <div><label>Pencil Start WS</label><select class="pencil-ws">${getWSDropdownOptions(data.pencilSkill?.ws)}</select></div>
  </div>
</div>

<div class="timeslots-container"> 
  <h4 style="font-size:0.9rem; margin:0 0 0.5rem;">Timeslots (Max 6)</h4> 
  <div class="timeslots-list"></div> 
  <button type="button" class="add-timeslot-btn secondary" style="margin-top:0.5rem; padding:0.4rem 0.8rem; font-size:0.9rem;">+ Add Timeslot</button> 
</div> 
<button type="button" class="remove-subject" style="background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; margin-top:0.5rem;">Remove Subject</button>`;

  const timeslotsList = div.querySelector('.timeslots-list');
  if (data.timeslots?.length) data.timeslots.forEach(ts => addTimeslotField(timeslotsList, ts));
  else addTimeslotField(timeslotsList);

  // ✅ REQ 3: Pencil Button Logic
  const addPencilBtn = div.querySelector('.add-pencil-btn');
  const pencilEntry = div.querySelector('.pencil-skill-entry');

  if (data.pencilSkill) {
    pencilEntry.style.display = 'block';
    addPencilBtn.style.display = 'none';
    pencilEntry.querySelector('.pencil-level').required = true;
    pencilEntry.querySelector('.pencil-ws').required = true;
  }

  // Fixed: Only errors if a visible pencil skill actually exists
  addPencilBtn.onclick = () => {
    const anyVisible = Array.from(document.querySelectorAll('.pencil-skill-entry')).some(el => el.style.display !== 'none');
    if (anyVisible) {
      showError('⚠️ Only one Pencil Skill can be added per student. Please remove the existing one first.');
      return;
    }
    pencilEntry.style.display = 'block';
    addPencilBtn.style.display = 'none';
    pencilEntry.querySelector('.pencil-level').required = true;
    pencilEntry.querySelector('.pencil-ws').required = true;
  };

  div.querySelector('.remove-pencil-btn').onclick = () => {
    pencilEntry.style.display = 'none';
    addPencilBtn.style.display = 'inline-block';
    pencilEntry.querySelector('.pencil-level').value = '';
    pencilEntry.querySelector('.pencil-ws').value = '';
    pencilEntry.querySelector('.pencil-level').required = false;
    pencilEntry.querySelector('.pencil-ws').required = false;
  };

  if (data.name || data.status) updateSubjectEntry(div);
  div.querySelector('.add-timeslot-btn').onclick = () => addTimeslotField(timeslotsList);
  div.querySelector('.remove-subject').onclick = () => {
    div.remove();
    subjectCount--;
    updateOverallStatus();
    renderSchedule();
    document.querySelectorAll('.subject-entry').forEach(entry => {
      const select = entry.querySelector('.subject-name');
      if (select) refreshSubjectOptions(select);
    });
  };
  const subjectSelect = div.querySelector('.subject-name');
  const startLevelSelect = div.querySelector('.start-level');
  subjectSelect.addEventListener('change', (e) => {
    startLevelSelect.innerHTML = getLevelOptions(e.target.value, '');
    validateConflict(e.target);
    renderSchedule();
    updateSubjectEntry(div);
    document.querySelectorAll('.subject-entry').forEach(entry => {
      const select = entry.querySelector('.subject-name');
      if (select && select !== e.target) refreshSubjectOptions(select);
    });
  });
  div.querySelector('.status').addEventListener('change', () => {
    updateOverallStatus();
    renderSchedule();
    updateSubjectEntry(div);
    document.querySelectorAll('.subject-entry').forEach(entry => {
      const select = entry.querySelector('.subject-name');
      if (select) refreshSubjectOptions(select);
    });
  });
  container.appendChild(div);
  subjectCount++;
}

function validateConflict(currentSelect) {
  const selected = currentSelect.value;
  if (!selected) return;
  const entry = currentSelect.closest('.subject-entry');
  const currentStatus = entry.querySelector('.status').value;
  const others = Array.from(document.querySelectorAll('.subject-name')).filter(s => s !== currentSelect);
  for (const s of others) {
    const otherEntry = s.closest('.subject-entry');
    const otherStatus = otherEntry.querySelector('.status').value;
    if (s.value === selected && otherStatus !== 'drop' && currentStatus !== 'drop') {
      showError(`⚠️ ${selected} is already added. Please choose a different subject or drop the existing one.`);
      currentSelect.value = ''; return;
    }
    if (['English ERP', 'English EFL'].includes(selected) && ['English ERP', 'English EFL'].includes(s.value)) {
      if (otherStatus !== 'drop' && currentStatus !== 'drop') {
        showError('English ERP & EFL cannot be together unless one is Dropped.');
        currentSelect.value = ''; return;
      }
    }
    if (selected.includes('Chinese') && s.value.includes('Chinese')) {
      if (otherStatus !== 'drop' && currentStatus !== 'drop') {
        showError('Please select only one type of Chinese (Traditional or Simplified).');
        currentSelect.value = ''; return;
      }
    }
  }
}

function getHourOptions(selectedHour, day = 'Monday') {
  const isWeekend = ['Saturday', 'Sunday'].includes(day);
  let opts = '';
  for (let i = isWeekend ? 9 : 10; i <= (isWeekend ? 18 : 21); i++) {
    const val = String(i).padStart(2, '0');
    opts += `<option value="${val}" ${val === selectedHour ? 'selected' : ''}>${val}</option>`;
  }
  return opts;
}
function getMinuteOptions(selectedMin) {
  let opts = '';
  for (let i = 0; i < 60; i++) {
    const val = String(i).padStart(2, '0');
    opts += `<option value="${val}" ${val === selectedMin ? 'selected' : ''}>${val}</option>`;
  }
  return opts;
}

function isTimeslotGloballyUsed(day, hour, min, excludeRow = null) {
  for (const row of document.querySelectorAll('.timeslot-row')) {
    if (row === excludeRow) continue;
    const subjectEntry = row.closest('.subject-entry');
    if (subjectEntry?.querySelector('.status')?.value === 'drop') continue;
    if (row.querySelector('.ts-day')?.value === day && row.querySelector('.ts-hour')?.value === hour && row.querySelector('.ts-min')?.value === min) {
      return subjectEntry?.querySelector('.subject-name')?.value || 'another subject';
    }
  }
  return false;
}

function addTimeslotField(timeslotsList, data = {}) {
  if (!timeslotsList || timeslotsList.children.length >= 6) return showError('Maximum 6 timeslots per subject');
  let h = '01', m = '00', day = data.day || 'Monday';
  if (data.time) { const p = data.time.split(':'); if(p.length===2) { h=p[0]; m=p[1]; } }
  
  const row = document.createElement('div');
  row.className = 'timeslot-row';
  row.innerHTML = `<div><label>Day</label><select class="ts-day" required>${DAYS.map(d => `<option value="${d}" ${data.day === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
  <div><label>Time (24h)</label><div class="time-input-group"><select class="ts-hour" required>${getHourOptions(h, day)}</select><span class="time-separator">:</span><select class="ts-min" required>${getMinuteOptions(m)}</select></div></div>
  <div class="remove-timeslot-wrapper"><button type="button" class="remove-ts-btn" title="Remove">×</button></div>`;
  
  const daySel = row.querySelector('.ts-day'), hourSel = row.querySelector('.ts-hour'), minSel = row.querySelector('.ts-min');
  const checkConflict = () => {
    if (!daySel.value || !hourSel.value || !minSel.value) return;
    const conflict = isTimeslotGloballyUsed(daySel.value, hourSel.value, minSel.value, row);
    if (conflict) showError(`⚠️ Timeslot conflict: ${daySel.value} ${hourSel.value}:${minSel.value} booked for ${conflict}.`);
  };
  daySel.addEventListener('change', e => { hourSel.innerHTML = getHourOptions(hourSel.value, e.target.value); checkConflict(); renderSchedule(); });
  hourSel.addEventListener('change', () => { checkConflict(); renderSchedule(); });
  minSel.addEventListener('change', () => { checkConflict(); renderSchedule(); });
  row.querySelector('.remove-ts-btn').onclick = () => { row.remove(); renderSchedule(); };
  timeslotsList.appendChild(row);
}
document.getElementById('addSubjectBtn').onclick = () => addSubjectField();

async function loadStudentData() {
  try {
    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
    if (snap.exists()) {
      const s = snap.val();
      const setFieldWithOther = (id, value) => {
        const select = document.getElementById(id), otherInput = document.getElementById(id + 'Other');
        let found = false;
        for(let i=0; i<select.options.length; i++) if(select.options[i].value === value) { found = true; break; }
        if(found) { select.value = value; otherInput?.classList.remove('visible'); }
        else { select.value = 'Other'; if(otherInput) { otherInput.value = value; otherInput.classList.add('visible'); } }
      };
      ['studentNumber','nickname','namePinyin','nameCn','email','address'].forEach(id => { const el = document.getElementById(id); if(el) el.value = s[id] || ''; });
      if(s.grade) setFieldWithOther('grade', s.grade);
      if(s.school) setFieldWithOther('school', s.school);
      if(s.nationality) setFieldWithOther('nationality', s.nationality);
      document.getElementById('birthday').value = s.birthday || '';
      if (s.qrCode) qrInput.value = s.qrCode;
      if (s.phone) ['mom','dad','own'].forEach(k => { const el = document.getElementById(`phone${k.charAt(0).toUpperCase()+k.slice(1)}`); if(el) el.value = s.phone[k] || ''; });
      if (s.subjects) s.subjects.forEach(sub => { addSubjectField(sub); const entries = document.querySelectorAll('.subject-entry'); if (entries.length) updateSubjectEntry(entries[entries.length - 1]); });
      else addSubjectField();
      updateAgeDisplay(); updateOverallStatus(); originalFormData = collectFormData();
    }
  } catch (err) { showError('Error loading student: ' + err.message); } finally { hideLoader(); }
}

const deleteBtn = document.getElementById('deleteBtn');
if(isEdit && deleteBtn) {
  deleteBtn.style.display = '';
  deleteBtn.onclick = async () => {
    if(confirm('Permanently delete this student?')) {
      try { showLoader(); await remove(ref(db, `centers/${centerId}/students/${studentId}`)); alert('Deleted!'); window.location.href='students.html'; }
      catch(err) { showError('Error: '+err.message); } finally { hideLoader(); }
    }
  };
}
const transferBtn = document.getElementById('transferBtn');
const transferModal = document.getElementById('transferModal');
const targetCenterSelect = document.getElementById('targetCenterSelect');
if(isEdit && transferBtn) {
  transferBtn.style.display = '';
  transferBtn.onclick = async () => {
    transferModal.classList.remove('hidden');
    targetCenterSelect.innerHTML = '<option value="">Loading centers...</option>';
    try {
      const snap = await get(ref(db, 'centers'));
      if (snap.exists()) {
        let opts = '';
        Object.keys(snap.val()).forEach(k => { if(k !== centerId) opts += `<option value="${k}">${snap.val()[k].name || k}</option>`; });
        targetCenterSelect.innerHTML = opts || '<option value="">No centers available</option>';
      }
    } catch { targetCenterSelect.innerHTML = '<option value="">Error loading</option>'; }
  };
}
document.getElementById('closeTransferModal').onclick = () => transferModal.classList.add('hidden');
document.getElementById('confirmTransferBtn').onclick = async () => {
  const targetId = targetCenterSelect.value;
  if (!targetId || targetId === centerId) return showError('Please select a valid target center.');
  if (!confirm(`Transfer student to ${targetId.replace(/kumon-/g,'').replace(/-/g,' ').toUpperCase()}?`)) return;
  transferModal.classList.add('hidden'); showLoader();
  try {
    const sourceRef = ref(db, `centers/${centerId}/students/${studentId}`);
    const snap = await get(sourceRef);
    if(!snap.exists()) throw new Error('Student not found.');
    const data = snap.val(); data.transferredFrom = centerId; data.transferredAt = new Date().toISOString();
    await push(ref(db, `centers/${targetId}/students`), data);
    await remove(sourceRef);
    alert('✅ Transferred!'); window.location.href = 'students.html';
  } catch(err) { showError('Transfer failed: ' + err.message); } finally { hideLoader(); }
};

document.getElementById('studentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!centerId) return showError('Error: No center selected.');
  if (html5QrCode && scannerActive) await html5QrCode.stop();

  // ✅ REQ 3: Validate only 1 Pencil Skill allowed
  const pencilCount = Array.from(document.querySelectorAll('.pencil-skill-entry')).filter(el => el.style.display !== 'none').length;
  if (pencilCount > 1) return showError('⚠️ Only one Pencil Skill can be added per student.');

  const globalTimeslots = new Map();
  let hasConflict = false;
  for (const entry of document.querySelectorAll('.subject-entry')) {
    if (entry.querySelector('.status')?.value === 'drop') continue;
    const subjectName = entry.querySelector('.subject-name').value || 'Unknown';
    entry.querySelectorAll('.timeslots-list .timeslot-row').forEach(row => {
      const day = row.querySelector('.ts-day')?.value, hour = row.querySelector('.ts-hour')?.value, min = row.querySelector('.ts-min')?.value;
      if (day && hour && min) {
        const key = `${day}-${hour}:${min}`;
        if (globalTimeslots.has(key)) { showError(`⚠️ Timeslot conflict: ${subjectName} & ${globalTimeslots.get(key)} on ${day} at ${hour}:${min}`); hasConflict = true; }
        else globalTimeslots.set(key, subjectName);
      }
    });
    if (hasConflict) return; 
  }

  const currentFormData = collectFormData();
  if (isEdit && JSON.stringify(currentFormData) === JSON.stringify(originalFormData)) return showError('ℹ️ No changes made.');
  for (const sub of currentFormData.subjects) {
    if (!sub.name) return showError('Please select a subject.');
    if (!sub.timeslots.length) return showError(`Add at least one timeslot for ${sub.name}`);
    if (sub.pencilSkill && !sub.pencilSkill.ws) return showError('Please select a Pencil Start WS.');
  }
  if (currentFormData.subjects.length === 0) return showError('Add at least one subject.');

  const studentData = { ...currentFormData, updatedAt: new Date().toISOString() };
  if (!isEdit) studentData.createdAt = new Date().toISOString();
  try {
    showLoader();
    if (isEdit) await set(ref(db, `centers/${centerId}/students/${studentId}`), studentData);
    else await push(ref(db, `centers/${centerId}/students`), studentData);
    alert(isEdit ? '✅ Updated!' : '✅ Added!');
    window.location.href = 'students.html';
  } catch (err) { showError('Error saving: ' + err.message); } finally { hideLoader(); }
});

document.getElementById('cancelBtn')?.addEventListener('click', () => {
  if (confirm('Discard changes?')) window.location.href = 'students.html';
});

initOtherInputs();
if (isEdit) loadStudentData();
else { addSubjectField(); hideLoader(); }
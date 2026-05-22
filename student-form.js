// student-form.js
import { requireAuth, db } from './auth.js';
import { ref, push, set, get, remove } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}

const SUBJECTS = ['Math', 'Chinese', 'English ERP', 'English EFL'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SUBJECT_COLORS = { 'Math': 'subj-Math', 'Chinese': 'subj-Chinese', 'English ERP': 'subj-ERP', 'English EFL': 'subj-EFL' };

let subjectCount = 0;
let html5QrCode = null;
let scannerActive = false;
let originalFormData = null;

const centerId = sessionStorage.getItem('selectedCenter');
const urlParams = new URLSearchParams(window.location.search);
const studentId = urlParams.get('id');
const isEdit = !!studentId;

document.getElementById('formTitle').textContent = isEdit ? 'Edit Student' : 'Add Student';

// ✅ Loader Helpers
function hideLoader() {
  const loader = document.getElementById('page-loader');
  if (loader) setTimeout(() => loader.classList.add('hidden'), 300);
}
function showLoader() {
  document.getElementById('page-loader')?.classList.remove('hidden');
}

// ✅ REAL-TIME AGE CALCULATION
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

// ✅ OVERALL STATUS CALCULATION
function updateOverallStatus() {
  const statuses = Array.from(document.querySelectorAll('.status')).map(s => s.value);
  const overall = document.getElementById('overallStatus');
  if (!overall) return;
  if (statuses.length === 0) { overall.value = 'Current'; return; }
  const allDrop = statuses.every(s => s === 'drop');
  const hasCurrent = statuses.some(s => s === 'current');
  overall.value = allDrop ? 'Drop' : (hasCurrent ? 'Current' : 'Pause');
}

// ✅ TAB SWITCHING
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const targetId = `tab-${btn.dataset.tab}`;
    document.getElementById(targetId)?.classList.add('active');
    if (btn.dataset.tab === 'schedule') renderSchedule();
  });
});

// ✅ SCHEDULE RENDERER
function renderSchedule() {
  const tbody = document.getElementById('scheduleBody');
  if (!tbody) return;
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

// ✅ QR SCANNER
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

// ✅ COLLECT FORM DATA
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
    subjects.push({
      name: entry.querySelector('.subject-name').value,
      startLevel: entry.querySelector('.start-level').value,
      startWS: parseInt(entry.querySelector('.start-ws').value) || 0,
      currentLevel: entry.querySelector('.current-level').value || '',
      currentWS: parseInt(entry.querySelector('.current-ws').value) || 0,
      enrolDate: entry.querySelector('.enrol-date').value,
      status: entry.querySelector('.status').value,
      timeslots, progress: []
    });
  }

  return {
    studentNumber: document.getElementById('studentNumber').value.trim() || '',
    nickname: document.getElementById('nickname').value.trim() || '',
    namePinyin: document.getElementById('namePinyin').value.trim() || '',
    nameCn: document.getElementById('nameCn').value.trim() || '',
    grade: document.getElementById('grade').value.trim() || '',
    school: document.getElementById('school').value.trim() || '',
    address: document.getElementById('address').value.trim() || '',
    nationality: document.getElementById('nationality').value.trim() || '',
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

// ✅ SUBJECT MANAGEMENT
function addSubjectField(data = {}) {
  if (subjectCount >= 3) return alert('Maximum 3 subjects allowed');
  const container = document.getElementById('subjectsContainer');
  const div = document.createElement('div');
  div.className = 'subject-entry';
  const lockStart = isEdit && !!data.name;

  div.innerHTML = `
    <div class="form-grid">
      <div><label>Select Subject *</label><select class="subject-name" required>
        <option value="">Select Subject *</option>
        ${SUBJECTS.map(s => `<option value="${s}" ${data.name === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></div>
      <div><label>Start Level *</label><input type="text" class="start-level" placeholder="e.g. 7A" value="${data.startLevel || ''}" required ${lockStart ? 'readonly' : ''}></div>
      <div><label>Start WS # *</label><input type="number" class="start-ws" placeholder="e.g. 10" value="${data.startWS || 0}" required ${lockStart ? 'readonly' : ''}></div>
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
    <div class="timeslots-container">
      <h4 style="font-size:0.9rem; margin:0 0 0.5rem;">Timeslots (Max 6)</h4>
      <div class="timeslots-list"></div>
      <button type="button" class="add-timeslot-btn secondary" style="margin-top:0.5rem; padding:0.4rem 0.8rem; font-size:0.9rem;">+ Add Timeslot</button>
    </div>
    <button type="button" class="remove-subject" style="background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; margin-top:0.5rem;">Remove Subject</button>
  `;

  const timeslotsList = div.querySelector('.timeslots-list');
  if (data.timeslots?.length) data.timeslots.forEach(ts => addTimeslotField(timeslotsList, ts));
  else addTimeslotField(timeslotsList);

  div.querySelector('.add-timeslot-btn').onclick = () => addTimeslotField(timeslotsList);
  div.querySelector('.remove-subject').onclick = () => { div.remove(); subjectCount--; updateOverallStatus(); renderSchedule(); };
  div.querySelector('.subject-name').addEventListener('change', (e) => { validateConflict(e.target); renderSchedule(); });
  div.querySelector('.status').addEventListener('change', () => { updateOverallStatus(); renderSchedule(); });

  container.appendChild(div);
  subjectCount++;
}

function validateConflict(currentSelect) {
  const selected = currentSelect.value;
  if (!['English ERP', 'English EFL'].includes(selected)) return;
  const entry = currentSelect.closest('.subject-entry');
  const currentStatus = entry.querySelector('.status').value;
  const others = Array.from(document.querySelectorAll('.subject-name')).filter(s => s !== currentSelect);
  for (const s of others) {
    if (['English ERP', 'English EFL'].includes(s.value)) {
      const otherStatus = s.closest('.subject-entry').querySelector('.status').value;
      if (otherStatus !== 'drop' && currentStatus !== 'drop') {
        alert('English ERP & EFL cannot be together unless one is Dropped.');
        currentSelect.value = ''; return;
      }
    }
  }
}

function getHourOptions(selectedHour) {
  let opts = '';
  for (let i = 1; i <= 24; i++) {
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

function addTimeslotField(timeslotsList, data = {}) {
  if (!timeslotsList || timeslotsList.children.length >= 6) return alert('Maximum 6 timeslots per subject');
  let h = '01', m = '00';
  if (data.time) {
    const parts = data.time.split(':');
    if (parts.length === 2) { h = parts[0]; m = parts[1]; }
  }
  const row = document.createElement('div');
  row.className = 'timeslot-row';
  const dayOptions = DAYS.map(d => `<option value="${d}" ${data.day === d ? 'selected' : ''}>${d}</option>`).join('');
  
  row.innerHTML = `
    <div><label>Day</label><select class="ts-day" required>${dayOptions}</select></div>
    <div><label>Time (1-24h)</label>
      <div style="display:flex; gap:0.5rem;">
        <select class="ts-hour" required>${getHourOptions(h)}</select>
        <span style="align-self:center; font-weight:bold;">:</span>
        <select class="ts-min" required>${getMinuteOptions(m)}</select>
      </div>
    </div>
    <button type="button" class="remove-ts-btn">×</button>
  `;
  row.querySelector('.remove-ts-btn').onclick = () => { row.remove(); renderSchedule(); };
  ['ts-day','ts-hour','ts-min'].forEach(cls => row.querySelector(`.${cls}`).addEventListener('input', renderSchedule));
  timeslotsList.appendChild(row);
}

document.getElementById('addSubjectBtn').onclick = () => addSubjectField();

// ✅ LOAD STUDENT DATA
async function loadStudentData() {
  try {
    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
    if (snap.exists()) {
      const s = snap.val();
      ['studentNumber','nickname','namePinyin','nameCn','grade','school','nationality','email','address'].forEach(id => {
        const el = document.getElementById(id); if(el) el.value = s[id] || '';
      });
      document.getElementById('birthday').value = s.birthday || '';
      if (s.qrCode) qrInput.value = s.qrCode;
      if (s.phone) {
        ['mom','dad','own'].forEach(k => {
          const el = document.getElementById(`phone${k.charAt(0).toUpperCase()+k.slice(1)}`);
          if(el) el.value = s.phone[k] || '';
        });
      }
      if (s.subjects) s.subjects.forEach(sub => addSubjectField(sub));
      else addSubjectField();
      updateAgeDisplay();
      updateOverallStatus();
      originalFormData = collectFormData();
    }
  } catch (err) { alert('Error loading student: ' + err.message); } finally { hideLoader(); }
}

// ✅ DELETE LOGIC
const deleteBtn = document.getElementById('deleteBtn');
if(isEdit && deleteBtn) {
  deleteBtn.style.display = '';
  deleteBtn.onclick = async () => {
    if(confirm('Permanently delete this student?')) {
      try { showLoader(); await remove(ref(db, `centers/${centerId}/students/${studentId}`)); alert('Deleted!'); window.location.href='students.html'; } 
      catch(err) { alert('Error: '+err.message); } finally { hideLoader(); }
    }
  };
}

// ✅ TRANSFER LOGIC
const transferBtn = document.getElementById('transferBtn');
const transferModal = document.getElementById('transferModal');
const closeTransferModal = document.getElementById('closeTransferModal');
const confirmTransferBtn = document.getElementById('confirmTransferBtn');
const targetCenterSelect = document.getElementById('targetCenterSelect');

if(isEdit && transferBtn) {
  transferBtn.style.display = '';
  transferBtn.onclick = async () => {
    transferModal.classList.remove('hidden');
    targetCenterSelect.innerHTML = '<option value="">Loading centers...</option>';
    try {
      const snap = await get(ref(db, 'centers'));
      if (snap.exists()) {
        const centers = snap.val();
        let options = '';
        Object.keys(centers).forEach(key => {
          if (key !== centerId) options += `<option value="${key}">${centers[key].name || key}</option>`;
        });
        targetCenterSelect.innerHTML = options || '<option value="">No other centers available</option>';
      }
    } catch(err) {
      targetCenterSelect.innerHTML = '<option value="">Error loading centers</option>';
    }
  };
}
if(closeTransferModal) closeTransferModal.onclick = () => transferModal.classList.add('hidden');
if(confirmTransferBtn) {
  confirmTransferBtn.onclick = async () => {
    const targetId = targetCenterSelect.value;
    if (!targetId || targetId === centerId) return alert('Please select a valid target center.');
    if (!confirm(`Transfer this student to ${targetId.replace(/kumon-/g,'').replace(/-/g,' ').toUpperCase()}?`)) return;
    
    transferModal.classList.add('hidden');
    showLoader();
    try {
      const sourceRef = ref(db, `centers/${centerId}/students/${studentId}`);
      const snap = await get(sourceRef);
      if(!snap.exists()) throw new Error('Student data not found.');
      const data = snap.val();
      data.transferredFrom = centerId;
      data.transferredAt = new Date().toISOString();

      // Create in target center
      await push(ref(db, `centers/${targetId}/students`), data);
      // Remove from source
      await remove(sourceRef);
      
      alert('✅ Student transferred successfully!');
      window.location.href = 'students.html';
    } catch(err) {
      alert('Transfer failed: ' + err.message);
    } finally { hideLoader(); }
  };
}

// ✅ SUBMIT HANDLER
document.getElementById('studentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!centerId) return alert('Error: No center selected.');
  if (html5QrCode && scannerActive) await html5QrCode.stop();

  const currentFormData = collectFormData();
  if (isEdit && JSON.stringify(currentFormData) === JSON.stringify(originalFormData)) {
    return alert('ℹ️ No changes have been made.');
  }

  for (const sub of currentFormData.subjects) {
    if (!sub.name) return alert('Please select a subject.');
    if (!sub.timeslots.length) return alert(`Please add at least one timeslot for ${sub.name}`);
  }
  if (currentFormData.subjects.length === 0) return alert('Please add at least one subject.');

  const studentData = { ...currentFormData, updatedAt: new Date().toISOString() };
  if (!isEdit) studentData.createdAt = new Date().toISOString();

  try {
    showLoader();
    if (isEdit) {
      await set(ref(db, `centers/${centerId}/students/${studentId}`), studentData);
      alert('Student updated successfully!');
    } else {
      await push(ref(db, `centers/${centerId}/students`), studentData);
      alert('Student added successfully!');
    }
    window.location.href = 'students.html';
  } catch (err) {
    alert('Error saving student: ' + err.message);
  } finally { hideLoader(); }
});

// Initialize
if (isEdit) loadStudentData();
else { addSubjectField(); hideLoader(); }
// student-form.js
import { requireAuth, db } from './auth.js';
import { ref, push, set, get, remove } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}

const SUBJECTS = ['Math', 'Chinese', 'English ERP', 'English EFL'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
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

// ✅ SCHEDULE RENDERER - Dynamic header + body
function renderSchedule() {
  const thead = document.getElementById('scheduleHeader');
  const tbody = document.getElementById('scheduleBody');
  if (!thead || !tbody) return;
  
  // Render header row with 3-letter abbreviations for compactness
  thead.innerHTML = '';
  DAYS.forEach(day => {
    const th = document.createElement('th');
    th.textContent = day.substring(0, 3); // "Mon", "Tue", ..., "Sun"
    thead.appendChild(th);
  });
  
  // Render body row
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

// ✅ HELPER: Get list of subjects already added (excluding dropped ones)
function getUsedSubjects(excludeEntry = null) {
  const used = new Set();
  document.querySelectorAll('.subject-entry').forEach(entry => {
    if (entry === excludeEntry) return;
    const subjectSelect = entry.querySelector('.subject-name');
    const statusSelect = entry.querySelector('.status');
    const subject = subjectSelect?.value;
    const status = statusSelect?.value;
    if (subject && status !== 'drop') {
      used.add(subject);
    }
  });
  return used;
}

// ✅ HELPER: Refresh subject dropdown to show/hide used subjects
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

// ✅ HELPER: Update subject entry background color + fade effect for 'drop' status
function updateSubjectEntry(entry) {
  const subjectSelect = entry.querySelector('.subject-name');
  const statusSelect = entry.querySelector('.status');
  const subject = subjectSelect?.value;
  const status = statusSelect?.value;
  
  // Remove all subject color classes first
  entry.classList.remove('subj-Math', 'subj-Chinese', 'subj-ERP', 'subj-EFL');
  
  // Add the matching class if a subject is selected
  if (subject && SUBJECT_COLORS[subject]) {
    entry.classList.add(SUBJECT_COLORS[subject]);
  }
  
  // ✅ Fade out effect when status is 'drop'
  if (status === 'drop') {
    entry.style.opacity = '0.65';
    entry.style.filter = 'grayscale(0.4)';
  } else {
    entry.style.opacity = '1';
    entry.style.filter = 'none';
  }
}

// ✅ SUBJECT MANAGEMENT - Prevent duplicates + visual hints + dynamic dropdowns + color coding + fade on drop
function addSubjectField(data = {}) {
  if (subjectCount >= 3) return alert('Maximum 3 subjects allowed');
  const container = document.getElementById('subjectsContainer');
  const div = document.createElement('div');
  div.className = 'subject-entry';
  
  const isPreExistingSubject = isEdit && !!data.name;
  const lockStart = isPreExistingSubject;
  const lockHint = lockStart ? '<span style="color:#999;font-weight:400;font-size:0.8rem">(Locked)</span>' : '';
  
  // ✅ Get subjects already in use to disable them in dropdown
  const usedSubjects = getUsedSubjects(div);
  
  div.innerHTML = `
    <div class="form-grid">
      <div>
        <label>Select Subject *</label>
        <select class="subject-name" required>
          <option value="">Select Subject *</option>
          ${SUBJECTS.map(s => {
            const isSelected = data.name === s;
            const isUsed = usedSubjects.has(s) && !isSelected;
            const disabled = isUsed ? 'disabled' : '';
            const hint = isUsed ? ' (Added)' : '';
            return `<option value="${s}" ${isSelected ? 'selected' : ''} ${disabled}>${s}${hint}</option>`;
          }).join('')}
        </select>
      </div>
      <div>
        <label>Start Level * ${lockHint}</label>
        <input type="text" class="start-level" placeholder="e.g. 7A" value="${data.startLevel || ''}" required ${lockStart ? 'readonly' : ''}>
      </div>
      <div>
        <label>Start WS # * ${lockHint}</label>
        <input type="number" class="start-ws" placeholder="e.g. 10" value="${data.startWS || 0}" required ${lockStart ? 'readonly' : ''}>
      </div>
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

  // ✅ Set initial color + fade effect if loading existing data
  if (data.name || data.status) updateSubjectEntry(div);

  div.querySelector('.add-timeslot-btn').onclick = () => addTimeslotField(timeslotsList);
  div.querySelector('.remove-subject').onclick = () => { 
    div.remove(); 
    subjectCount--; 
    updateOverallStatus(); 
    renderSchedule();
    // ✅ Re-enable subject options in other dropdowns after removal
    document.querySelectorAll('.subject-entry').forEach(entry => {
      const select = entry.querySelector('.subject-name');
      if (select) refreshSubjectOptions(select);
    });
  };
  
  // ✅ Refresh other dropdowns + update color/fade when subject changes
  div.querySelector('.subject-name').addEventListener('change', (e) => { 
    validateConflict(e.target); 
    renderSchedule();
    updateSubjectEntry(div); // ✅ Update background color
    // Update all other subject dropdowns
    document.querySelectorAll('.subject-entry').forEach(entry => {
      const select = entry.querySelector('.subject-name');
      if (select && select !== e.target) refreshSubjectOptions(select);
    });
  });
  
  // ✅ Update color/fade when status changes
  div.querySelector('.status').addEventListener('change', () => { 
    updateOverallStatus(); 
    renderSchedule();
    updateSubjectEntry(div); // ✅ Update fade effect based on status
    // If status changed to/from 'drop', refresh subject options everywhere
    document.querySelectorAll('.subject-entry').forEach(entry => {
      const select = entry.querySelector('.subject-name');
      if (select) refreshSubjectOptions(select);
    });
  });

  container.appendChild(div);
  subjectCount++;
}

// ✅ Enhanced conflict validation: duplicates + ERP/EFL
function validateConflict(currentSelect) {
  const selected = currentSelect.value;
  if (!selected) return;
  
  const entry = currentSelect.closest('.subject-entry');
  const currentStatus = entry.querySelector('.status').value;
  const others = Array.from(document.querySelectorAll('.subject-name')).filter(s => s !== currentSelect);
  
  for (const s of others) {
    const otherEntry = s.closest('.subject-entry');
    const otherStatus = otherEntry.querySelector('.status').value;
    
    // ✅ Exact duplicate subject check (excluding dropped)
    if (s.value === selected && otherStatus !== 'drop' && currentStatus !== 'drop') {
      alert(`⚠️ ${selected} is already added to this student. Please choose a different subject or drop the existing one first.`);
      currentSelect.value = '';
      return;
    }
    
    // ✅ ERP/EFL conflict check (existing logic)
    if (!['English ERP', 'English EFL'].includes(selected)) continue;
    if (['English ERP', 'English EFL'].includes(s.value)) {
      if (otherStatus !== 'drop' && currentStatus !== 'drop') {
        alert('English ERP & EFL cannot be together unless one is Dropped.');
        currentSelect.value = ''; 
        return;
      }
    }
  }
}

// ✅ UPDATED: Dynamic hour ranges based on day type
function getHourOptions(selectedHour, day = 'Monday') {
  const isWeekend = ['Saturday', 'Sunday'].includes(day);
  const startHour = isWeekend ? 9 : 10;
  const endHour = isWeekend ? 18 : 21;
  
  let opts = '';
  for (let i = startHour; i <= endHour; i++) {
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

// ✅ HELPER: Check if a day is already used in this subject (excluding current row)
function isDayAlreadyUsed(subjectEntry, day, excludeRow = null) {
  const rows = subjectEntry.querySelectorAll('.timeslots-list .timeslot-row');
  for (const row of rows) {
    if (row === excludeRow) continue;
    const daySelect = row.querySelector('.ts-day');
    if (daySelect && daySelect.value === day) return true;
  }
  return false;
}

// ✅ UPDATED: Timeslot field with dynamic hours + day validation
function addTimeslotField(timeslotsList, data = {}) {
  if (!timeslotsList || timeslotsList.children.length >= 6) return alert('Maximum 6 timeslots per subject');
  
  // If loading preset data with a day, check for conflict first
  if (data.day) {
    const subjectEntry = timeslotsList.closest('.subject-entry');
    if (subjectEntry && isDayAlreadyUsed(subjectEntry, data.day)) {
      return alert(`⚠️ ${data.day} already has a timeslot for this subject. Only one timeslot per day allowed.`);
    }
  }
  
  let h = '01', m = '00';
  const day = data.day || 'Monday'; // Default to Monday for hour generation
  if (data.time) {
    const parts = data.time.split(':');
    if (parts.length === 2) { h = parts[0]; m = parts[1]; }
  }
  const row = document.createElement('div');
  row.className = 'timeslot-row';
  const dayOptions = DAYS.map(d => `<option value="${d}" ${data.day === d ? 'selected' : ''}>${d}</option>`).join('');
  
  row.innerHTML = `
    <div>
      <label>Day</label>
      <select class="ts-day" required>${dayOptions}</select>
    </div>
    <div>
      <label>Time (24h)</label>
      <div class="time-input-group">
        <select class="ts-hour" required>${getHourOptions(h, day)}</select>
        <span class="time-separator">:</span>
        <select class="ts-min" required>${getMinuteOptions(m)}</select>
      </div>
    </div>
    <div class="remove-timeslot-wrapper">
      <button type="button" class="remove-ts-btn" title="Remove Timeslot">×</button>
    </div>
  `;
  
  // ✅ Re-render hour options when day changes + validate uniqueness
  const daySelect = row.querySelector('.ts-day');
  const hourSelect = row.querySelector('.ts-hour');
  
  daySelect.addEventListener('change', (e) => {
    const selectedDay = e.target.value;
    const currentHour = hourSelect.value;
    // Update hour dropdown with new range for selected day
    hourSelect.innerHTML = getHourOptions(currentHour, selectedDay);
    
    // Validate day uniqueness within subject
    const subjectEntry = row.closest('.subject-entry');
    if (subjectEntry && isDayAlreadyUsed(subjectEntry, selectedDay, row)) {
      alert(`⚠️ ${selectedDay} already has a timeslot for this subject. Please choose a different day.`);
      e.target.value = '';
      return;
    }
    renderSchedule();
  });
  
  row.querySelector('.remove-ts-btn').onclick = () => { row.remove(); renderSchedule(); };
  ['ts-hour','ts-min'].forEach(cls => 
    row.querySelector(`.${cls}`).addEventListener('input', renderSchedule)
  );
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
      if (s.subjects) {
        s.subjects.forEach(sub => {
          addSubjectField(sub);
          // ✅ Apply color + fade effect to loaded subjects
          const entries = document.querySelectorAll('.subject-entry');
          if (entries.length > 0) {
            updateSubjectEntry(entries[entries.length - 1]);
          }
        });
      } else {
        addSubjectField();
      }
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

  // ✅ Final validation: no duplicate days per subject
  for (const entry of document.querySelectorAll('.subject-entry')) {
    const days = new Set();
    const subjectName = entry.querySelector('.subject-name').value || 'This subject';
    let hasConflict = false;
    
    entry.querySelectorAll('.timeslots-list .timeslot-row').forEach(row => {
      const day = row.querySelector('.ts-day')?.value;
      if (day) {
        if (days.has(day)) {
          alert(`⚠️ ${subjectName} has duplicate timeslots on ${day}. Please fix before saving.`);
          hasConflict = true;
        }
        days.add(day);
      }
    });
    if (hasConflict) return; // Stop submission
  }

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